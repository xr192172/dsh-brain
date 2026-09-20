/**
 * @module @dsh-brain/switchboard (plugin entry)
 *
 * 本文件 = 打进每个 dsh gen 的插件入口（与 main.ts 的控制面进程入口同属一个合并模块）。
 * 职责（合并自 handover-agent + three-brain）：
 *  - 读取 env（HANDOVER_GEN/ADMIN_PORT/LEASE_TOKEN/MODE/GEN_DIR）或 patch config；
 *  - 维护本代"写模式"（staging→promote→active / demoted），供写入令牌 gating；
 *  - 冷读暖机，持续把 caughtUpSeq 提升到当前已落盘 seq；
 *  - 起 loopback admin，响应控制面的 health/freeze/promote/probe/retire；
 *  - 持有方案③ 快照提供者 seam（首版 none）；
 *  - P2 宿主护栏 + P1 tool_apply（安全自进化闭环）；
 *  - 两脑（left/right）装载探针（sandbox 已由蓝绿 staging 代取代，砍掉）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { startAdminServer } from './admin.js'

/**
 * 构造一条**带身份**的注入消息（switchboard 往会话里插话时用）。
 *
 * ★★ 为什么必须带 `id` 与 `source`（2026-09-15 实事故，本函数即其修复）
 *
 * `dsh-session` 的 `assertMessageEventShape`（`lib/index.js:1246-1258`）对 surface 事件
 * 要求：`id` 是非空字符串、`role` 正确、`source.kind` 是非空字符串、`content` 是数组。
 * **缺 `id` 或 `source` 的任一项** ⇒ 该会话日志被判
 * `SessionPersistenceCorruptionError: session event at seq N lacks an identified message`
 * ⇒ **整份历史永久读不出来**（实测已废掉一个会话：`session-b79a6e91` 的 seq 5342）。
 *
 * 旧代码是 `{ role: 'user', content: [...] }` —— 两个字段都缺，而注释当时**已经写明**
 * "agent-loop 会把它 append 落盘"，却没给它身份。凡往会话里写消息，一律走本函数。
 *
 * `source` 用 `{kind:'plugin', plugin:'switchboard'}`：这是上游注入上下文用的既有形态
 * （`dsh-agent-loop` / `dsh-time-context` / `dsh-compaction` 同款），
 * 且**不会**被 `agent-loop` 的 `isOwned()` 误认成 system-prompt 的 runtime-context
 * —— 它比对的是 `plugin === '@deepseek-ai/dsh-system-prompt'`。
 */
export function injectedUserMessage(text: string) {
  return {
    role: 'user' as const,
    id: randomUUID(),
    source: { kind: 'plugin', plugin: 'switchboard' },
    content: [{ type: 'text', text }],
  }
}
import { newDrain, drainForHandover, agentPhase, type DrainAgent } from './drain.js'
import { liveMaxSeq, type SessionsShim } from './preseed.js'
import { noSnapshot, type SnapshotProvider } from './snapshot.js'
import { registerHostGuard } from './guard.js'
import { registerApplyTool } from './deploy.js'
import { BRAINS } from './brains.js'
import type { FreezeReply, HealthReply, HandoverConfig, HandoverMode, PrepareReply, ProbeReply, PromoteRequest } from './protocol.js'

export const name = 'switchboard'
// 顶层不 declare 要等的服务：preseed/admin 走运行时可选服务，装配缺省也不崩。
export const inject: string[] = []

export interface Config {
  adminPort: number
  gen: string
  leaseToken: string
  mode: 'staging' | 'active' | 'demoted'
  genDir: string
  /** P2 宿主护栏开关（默认开）。 */
  guardP2: boolean
  /** promote 后是否 resume 上一代的主活跃会话并注入"请继续"（方案B 接续）。 */
  resumeOnPromote: boolean
}

/**
 * ★ 容错包装（2026-09-15）：缺 `config:` 块时 loader 传 `undefined`，裸 `z.object({...})`
 * 抛 `ValidationError: expected object, received undefined` ⇒ 插件树装配失败、gen 起不来。
 * 详见 `scripts/check-config-tolerance.mjs` 的说明与实测表。
 * 不要改用 `.default({})` —— 它短路内层解析、返回字面量 `{}`，使所有字段变 `undefined`。
 */
function tolerantConfig<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return z.preprocess((v) => v ?? {}, schema)
}

export const Config = tolerantConfig(
  z.object({
    adminPort: z.number().int().min(0).default(0),
    gen: z.string().default(''),
    leaseToken: z.string().default(''),
    mode: z.enum(['staging', 'active', 'demoted']).default('staging'),
    genDir: z.string().default(''),
    guardP2: z.boolean().default(true),
    resumeOnPromote: z.boolean().default(true),
  }),
)

function envStr(k: string, d: string): string {
  return process.env[k] || d
}
function envInt(k: string, d: number): number {
  const v = process.env[k]
  return v && /^\d+$/.test(v) ? Number(v) : d
}

/**
 * 代际身份提示（前/后/已切换完成/失败自检）：随 state.mode 动态渲染。
 * staging → 明文告诉它"你是被拉起的待更换代，勿应答实时请求，专注追平自检"；
 * active  → 告之"切换完成，当前为正式活跃代"；
 * demoted → 告之"你已被退役，本代关闭中"。
 */
function identityPrompt(cfg: HandoverConfig, state: { mode: HandoverMode; caughtUpSeq: number }): string {
  const role =
    state.mode === 'staging'
      ? '你是刚被控制面拉起的【待更换代】(staging)，不是正式服务代。交接期内：不要应答用户实时对话、不要发起写操作、不要自行 claim 写权——你要做的是冷读追平(把 caughtUpSeq 追到旧代序列)并等待控制面 promote。'
      : state.mode === 'active'
        ? '【切换已完成】控制面已成功将你 promote 为 active，旧代已退役/待退役——你此刻是正式活跃代，恢复一切正常服务。'
        : '【你已被退役】(demoted) 控制面已把你换下，本代即将关闭，请结束手头工作、勿再承接新请求。'
  const selfCheck =
    state.mode === 'staging'
      ? '若超过等待期仍未被 promote，说明你的自检/追平未达标，控制面将终止你。终止信号=失去 admin 连通：届时把失败原因写进 genDir 的自检产物，供下一代读取避错。'
      : ''
  return [
    '【代际身份】gen=' + (cfg.gen || '(未知)') + ' · mode=' + state.mode + ' · caughtUpSeq=' + state.caughtUpSeq,
    role,
    selfCheck,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * resume 生命周期结构化 trace：写到 `<genDir>/resume.jsonl`，把"检测到哪条会话 →
 * 是否尝试 resume → 成败原因 → 是否注入 steer"串起来，方便监测整个交接周期的上下文去向。
 */
function resumeTrace(genDir: string | undefined, rec: Record<string, unknown>): void {
  if (!genDir) return
  try {
    mkdirSync(genDir, { recursive: true })
    appendFileSync(join(genDir, 'resume.jsonl'), JSON.stringify({ t: Date.now(), ...rec }) + '\n', 'utf8')
  } catch {
    /* trace 写入失败不得影响交接 */
  }
}

/**
 * 方案B 接续：promote 后把上一代的主活跃会话 resume 进本代，并注入一条"请继续"。
 * 全防御式：ctx.agents 缺失/会话已在本代 live/任何异常都静默降级，绝不影响交接本身。
 * @param ctx gen 插件上下文。
 * @param sessionId 上一代传入的 resumeSessionId。
 * @param steers 注入的"请继续"消息序列。
 * @param attempts 剩余重试次数（agent-loop / sessionPersistence 可能尚未就绪）。
 * @param traceDir 写 resume.jsonl 的目录（= genDir）。
 */
/**
 * 本代 agent 注册表在交接期需要的能力。
 *
 * ★ `list()` / `phase` / `cancel()` / `whenIdle()` 是 2026-09-15 事故修复的关键：
 * 判断"有没有活在跑"必须看 **agent 的真实 phase**，而不是听一个跨插件事件
 * （我们原先监听的 `turn/start` 从未触发过 ⇒ `turnInFlight` 恒 false ⇒ defer 形同虚设）。
 */
interface AgentShim {
  get(id: string): unknown
  resume(o: { resumeSessionId: string; agentOptions?: unknown }): Promise<unknown>
  list?(): unknown[]
}

/** 把注册表里的 agent 代理归一成 drain 需要的形状（字段全可选，缺了就保守当"在跑"）。 */
function toDrainAgents(agents: AgentShim | undefined): DrainAgent[] {
  const raw = (() => {
    try {
      return agents?.list?.() ?? []
    } catch {
      return []
    }
  })()
  return raw.map((a, i) => {
    const o = a as {
      id?: string
      status?: string
      phase?: { kind?: string }
      session?: { id?: string }
      cancel?: (c: { kind: string; reason?: string }, o?: { keepInbox?: boolean }) => void
      whenIdle?: () => Promise<void>
    }
    const status = typeof o?.status === 'string' ? o.status : undefined
    const kindOf = (): 'idle' | 'running' | 'maintenance' | undefined => {
      const k = o?.phase?.kind
      return k === 'idle' || k === 'running' || k === 'maintenance' ? k : undefined
    }
    return {
      id: String(o?.id ?? `#${i}`),
      sessionId: o?.session?.id,
      // ★ 实时读（不拍快照）：见 DrainAgent.readPhase 的注释（真机验收暴露的假红）。
      readPhase: kindOf,
      ...(status ? { status } : {}),
      cancel: typeof o?.cancel === 'function' ? o.cancel.bind(o) : undefined,
      whenIdle: typeof o?.whenIdle === 'function' ? o.whenIdle.bind(o) : undefined,
    } satisfies DrainAgent
  })
}

function scheduleResume(agentsRef: { current: AgentShim | undefined }, sessionId: string, steers: string[], attempts: number, traceDir?: string): void {
  const agents = agentsRef.current
  if (!agents) {
    resumeTrace(traceDir, { phase: 'resume', sessionId, ok: false, reason: 'ctx.agents unavailable (not injected)' })
    return
  }
  const run = async (): Promise<void> => {
    try {
      let agent: { steer?: (m: unknown) => void } | undefined = agents.get(sessionId) as { steer?: (m: unknown) => void } | undefined
      if (!agent) {
        agent = (await agents.resume({ resumeSessionId: sessionId, agentOptions: {} })) as { steer?: (m: unknown) => void }
        resumeTrace(traceDir, { phase: 'resume', sessionId, ok: true, note: 'resumed persisted session' })
      } else {
        resumeTrace(traceDir, { phase: 'resume', sessionId, ok: true, note: 'already-live' })
      }
      for (const text of steers) {
        // 真正把一条 user-role 消息追加进会话（同浏览器 session.prompt 经由
        // agent-loop `session.append("user/message", …, {surfaceOp:'append'})` 落盘），
        // 再 steer 唤醒 driver 消费它——而不是只投 steering 信号、却不进用户消息流。
        // ★ 消息必须带 id/source，否则落盘后会让整份历史读不出来（见 injectedUserMessage）。
        const msg = injectedUserMessage(text)
        try {
          ;(agent as unknown as { session?: { append?: (t: string, m: unknown, o?: unknown) => unknown } }).session?.append?.('user/message', msg, { surfaceOp: 'append' })
        } catch {
          /* 追加失败也不影响履行：仍走 steer 唤醒 */
        }
        ;(agent as unknown as { steer?: (m: unknown) => void }).steer?.(msg)
        resumeTrace(traceDir, { phase: 'steer', sessionId, ok: true })
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      if (attempts > 0) {
        setTimeout(() => void run(), 2000)
      } else {
        resumeTrace(traceDir, { phase: 'resume', sessionId, ok: false, reason })
        console.error(`[switchboard:agent] resume failed for ${sessionId} (degraded, handover intact): ${reason}`)
      }
    }
  }
  setTimeout(() => void run(), 1200)
}

export function apply(ctx: Context, patch: Config): void {
  // cfg = patch 优先，env 兜底（spawner 主要走 env 注入）
  const cfg: HandoverConfig = {
    port: envInt('HANDOVER_ADMIN_PORT', patch.adminPort),
    gen: envStr('HANDOVER_GEN', patch.gen),
    leaseToken: envStr('HANDOVER_LEASE_TOKEN', patch.leaseToken),
    mode: (envStr('HANDOVER_MODE', patch.mode) as HandoverConfig['mode']) || 'staging',
    genDir: envStr('HANDOVER_GEN_DIR', patch.genDir),
  }

  const state = {
    mode: cfg.mode,
    caughtUpSeq: -1,
    drain: newDrain(),
    lastActiveSessionId: '',
  } as { mode: HandoverConfig['mode']; caughtUpSeq: number; drain: ReturnType<typeof newDrain>; lastActiveSessionId: string }

  // ── 延迟切换（defer）的"有没有活在跑"判据 ────────────────────────────────
  // ★ 2026-09-15 事故修复：这里原先挂 `ctx.on('turn/start'|'turn/end')` 维护一个
  // `turnInFlight` 布尔。实测 **204 次 defer、0 次** `waitedTurnEnd=true`，且 22:30 那次
  // 明明有一轮在跑却报 `reason=idle` ⇒ **那两个监听从未触发过**（事件不在本插件的 ctx 上发）。
  // 后果：defer 的"先请活跃代收尾本轮"从来没用过，换代永远在别人正写着的时候发生。
  // 现在改为**直读 agent 的真实阶段**（`agent.phase.kind`，见 drain.ts 的 phaseOf 兜底），
  // 不再依赖任何跨插件事件。

  // 方案③ seam：快照提供者默认 none
  const snapshot: SnapshotProvider = noSnapshot

  // 事件流跟踪"最近活跃会话"：agent 被创建/启动即记下其 session.id。
  // 这比 agents.list()（turn 间隔空）和 workspaceRegistry（对话未必挂工作区）都可靠，
  // 且与 conveyor-context 同一套会话事件机制。读到即暂存，供 freeze 上报 resume 用。
  ;(ctx as unknown as { on?: (ev: string, fn: (p: unknown) => void) => void }).on?.('agent/created', (p) => {
    const sid = (p as { agent?: { session?: { id?: string } } })?.agent?.session?.id
    if (sid) state.lastActiveSessionId = sid
  })
  ;(ctx as unknown as { on?: (ev: string, fn: (p: unknown) => void) => void }).on?.('agent/session-start', (p) => {
    const sid = (p as { agent?: { session?: { id?: string } } })?.agent?.session?.id
    if (sid) state.lastActiveSessionId = sid
  })

  // 安全取 agents 服务：直接 `ctx.agents` 会抛 "cannot get property agents without inject"，
  // 所以经 ctx.inject(['agents']) 把宿主提供的 agent 注册表接进来；宿主未提供则保持 undefined（优雅降级）。
  const agentsRef: { current: AgentShim | undefined } = { current: undefined }
  ;(ctx as unknown as { inject?: (svc: string[], fn: (c: unknown) => void) => void }).inject?.(['agents'], (aCtx) => {
    agentsRef.current = (aCtx as { agents?: AgentShim }).agents
  })

  // ★ 同理取 sessions 服务。**不能**直接读 `ctx.sessions`：未声明服务依赖时它在真机上是 `undefined`
  //   ⇒ `sessions.list()` 返回空、`flush` 一次都不执行、`lastSeq` 恒 -1（2026-09-20 真机验收当场抓到，
  //   而且空闲场景还会因此报 `quiesced=true` —— 假绿）。现在与 agents 同款：经 inject 拿。
  const sessionsRef: { current: SessionsShim | undefined } = { current: undefined }
  ;(ctx as unknown as { inject?: (svc: string[], fn: (c: unknown) => void) => void }).inject?.(['sessions'], (sCtx) => {
    sessionsRef.current = (sCtx as { sessions?: SessionsShim }).sessions
  })

  // 进度读数：**本进程 live 会话已落盘到哪**（不是"暖机到共享投影"）
  // ★ 2026-09-20 换掉旧实现：它依赖 `sessionPersistence.listSessions()`（上游**没有**这个方法）
  //   ⇒ 恒返回 0，171 条 freeze 里的 lastSeq 全是 0，门槛从未量过任何东西（假绿）。
  //   现在报的是真数：持有会话 ⇒ 真进度；刚拉起还没加载会话 ⇒ 0（诚实）。
  const warm = async (): Promise<void> => {
    state.caughtUpSeq = await liveMaxSeq(sessionsRef.current)
  }
  void warm()
  const warmTimer = setInterval(() => void warm(), 5000)

  // P2 宿主护栏：拦截安全层就地改/自残（三层方案：P0 自由 / P1 走控制面 / P2 只换不就地）
  if (patch.guardP2) registerHostGuard(ctx)
  // P1 激活工具：把安全自进化触发放成固定工具（tool_apply）
  registerApplyTool(ctx)

  // 三层边界指导：告诉脑"如何安全自进化"
  const layersRules =
    '【安全自进化边界】你运行在可代际替换的控制面上。' +
    '· P0 内容（settings/模型/provider、插件数据、技能、记忆、工具行为）：可自由修改——这是你的生长基质。' +
    '· P1 激活：改完 P0 后，直接调用工具 tool_apply 触发蓝绿交付上线（控制面 spawn 新代→追平→验证→翻转→失败回滚）；不要就地换血。' +
    '· P2 安全层（switchboard 源码/协调租约/profile 注册表/杀宿主 PID/绑端口）：禁止就地修改，进化只允许经整体替换（新 switchboard 代）实现。'
  ;(ctx as unknown as { inject?: (svc: string[], fn: (c: unknown) => void) => void }).inject?.(['systemPrompt'], (spCtx) => {
    try {
      ;(spCtx as { systemPrompt: { context: (o: { name: string; order: number; text: () => string }) => void } }).systemPrompt.context({
        name: 'safety:layers',
        order: 9_900,
        text: () => layersRules,
      })
    } catch {
      /* degrade */
    }
  })

  ;(ctx as unknown as { inject?: (svc: string[], fn: (c: unknown) => void) => void }).inject?.(['systemPrompt'], (spCtx) => {
    try {
      ;(spCtx as { systemPrompt: { context: (o: { name: string; order: number; text: () => string }) => void } }).systemPrompt.context({
        name: 'switchboard:identity',
        order: 9_500, // 靠后，尾端 append；随 mode 变化动态渲染"前/后/已切换完成/失败自检"
        text: () => identityPrompt(cfg, state),
      })
    } catch {
      /* degrade */
    }
  })

  const handlers = {
    getGen: () => cfg.gen,
    getMode: () => state.mode,
    getCaughtUpSeq: () => state.caughtUpSeq,
    holdingLease: () => state.mode === 'active',
    freeze: async (): Promise<FreezeReply> => {
      state.drain.armed = true
      ;(ctx as unknown as { emit?: (n: string) => void }).emit?.('handover/freeze')
      // ★★ 真静止点（2026-09-15 事故修复）：旧实现只"通知 + flush + 睡 400ms"，
      // 既没排在跑的回合，也没等任何落盘确认 ⇒ 旧代照写、新代照接，同一个会话被两代追加。
      // 现在由 drain.ts 负责：cancel 在跑的回合 → 等维护结束 → 官方 flush 逐会话落盘 →
      // 报出**真实 lastSeq**；返回的 `quiesced` 只有"确实不会再写"才为真。
      //
      // ★ 2026-09-20 真机验收抓到的第二个 bug：这里原先读 `ctx.sessions`（**未声明服务依赖**
      // ⇒ 真机上是 undefined）⇒ `sessions=0` / `lastSeq=-1` / **flush 一次都没跑过** ——
      // 会话那一半全是空转（空闲场景还会因此报 `quiesced=true`，是假绿）。
      // 现在统一走 `sessionsRef`（`ctx.inject(['sessions'])` 取得，与 agents 同款）。
      const sess = sessionsRef.current
      const sessionsObservable = !!sess && typeof sess.list === 'function' && typeof sess.flush === 'function'
      const live = (() => {
        try {
          return (sessionsObservable ? (sess!.list!() as Array<{ id?: string; seq?: number }>) : []) ?? []
        } catch {
          return []
        }
      })()
      const outcome = await drainForHandover({
        // ★ "看不到 agent" ≠ "没有 agent 在跑"：拿不到注册表（或它没有 list）时必须报"未停写"，
        //   否则控制面会留着可能仍在写的旧代（假绿）。见 drain.ts 的 DrainDeps.agentsObservable。
        agentsObservable: !!agentsRef.current && typeof agentsRef.current.list === 'function',
        // ★ 同理：看不到会话服务 ⇒ 落盘无法确认 ⇒ 不许报"停写"。
        sessionsObservable,
        agents: toDrainAgents(agentsRef.current),
        sessions: live,
        flush: async (s) => {
          // 官方 flush：会 await 持久化回调（write-behind 200ms 批），比 emit + sleep 可靠。
          if (!sessionsObservable) throw new Error('sessions service unavailable (ctx.inject([sessions]) 没拿到)')
          await sess!.flush!(s)
        },
        lastActiveSessionId: state.lastActiveSessionId,
      })
      state.drain.lastStaticSeq = outcome.lastSeq
      resumeTrace(cfg.genDir, {
        phase: 'drain',
        quiesced: outcome.quiesced,
        agentsObservable: outcome.agentsObservable,
        lastSeq: outcome.lastSeq,
        runningAtEntry: outcome.runningAtEntry,
        cancelled: outcome.cancelled,
        stillBusy: outcome.stillBusy,
        maintenanceAtEntry: outcome.maintenanceAtEntry,
        maintenanceTimedOut: outcome.maintenanceTimedOut,
        flushFailed: outcome.flushFailed,
        primarySessionId: outcome.primarySessionId,
        waitedMs: outcome.waitedMs,
      })
      console.log(
        `[switchboard:agent] drain quiesced=${outcome.quiesced} lastSeq=${outcome.lastSeq} ` +
          `canSeeAgents=${outcome.agentsObservable} canSeeSessions=${outcome.sessionsObservable} running=${outcome.runningAtEntry}→cancelled=${outcome.cancelled} ` +
          `stillBusy=[${outcome.stillBusy.join(',')}] flushFailed=[${outcome.flushFailed.join(',')}] ` +
          `sessions=${outcome.sessions.length} (${outcome.waitedMs}ms)`,
      )
      return {
        static: outcome.quiesced,
        lastSeq: outcome.lastSeq,
        sessions: outcome.sessions,
        quiesced: outcome.quiesced,
        primarySessionId: outcome.primarySessionId,
        drain: {
          runningAtEntry: outcome.runningAtEntry,
          cancelled: outcome.cancelled,
          stillBusy: outcome.stillBusy,
          agentsObservable: outcome.agentsObservable,
          sessionsObservable: outcome.sessionsObservable,
          maintenanceAtEntry: outcome.maintenanceAtEntry,
          maintenanceTimedOut: outcome.maintenanceTimedOut,
          flushFailed: outcome.flushFailed,
          waitedMs: outcome.waitedMs,
        },
      }
    },
    promote: async (req: PromoteRequest): Promise<{ ok: boolean }> => {
      if (req.gen && req.gen !== cfg.gen) return { ok: false }
      if (cfg.leaseToken && req.writerToken !== cfg.leaseToken) return { ok: false }
      state.mode = 'active'
      ;(ctx as unknown as { emit?: (n: string) => void }).emit?.('handover/promote')
      console.log(`[switchboard:agent] promote resumeSessionId=${req.resumeSessionId ?? 'none'}`)
      // 方案B 接续：携带上一代主活跃会话 → **只 attach（resume），不注入任何提示**。
      //
      // （2026-09-14 改）原先此处注入一条「【自动续跑】…」的提示，两个问题：
      //   ① 与 control plane 的 reissue 重复 —— 一次换代给会话注入两条 prompt；
      //   ② 那条提示声明"本次续跑**预先批准**"等于**替用户放权**，
      //      与「人批不得降级为事后知情」直接冲突。
      // 现在职责重新划分：
      //   · 本处**只负责把会话 resume 起来（attach）** —— 否则控制面的 reissue 会 session-not-found；
      //   · 续跑文本的注入**统一由 control plane 在 flip+verify 之后决定**（语义更准：确认新代健康才续接）；
      //   · 且**仅当活跃代当时确有未收尾的回合**才注入（依据 `PrepareReply.waitedForTurnEnd`），
      //     空闲/卡在等人类输入的会话一律**不注入**。
      // patch 运行时不带 schema default，故默认开：仅当显式 false 才关闭
      if ((patch.resumeOnPromote !== false) && req.resumeSessionId) {
        // 同步落 trace：无论 resume 异步成败，这里都先确证"调度已发生 + ctx.agents 是否就绪"。
        resumeTrace(cfg.genDir, {
          phase: 'resume',
          sessionId: req.resumeSessionId,
          ok: true,
          note: 'scheduled (attach-only; no steer text)',
          agents: !!agentsRef.current,
        })
        scheduleResume(agentsRef, req.resumeSessionId, [], 4, cfg.genDir)
      }
      return { ok: true }
    },
    probe: async (): Promise<ProbeReply> => ({ ok: true, gen: cfg.gen }),
    /**
     * 延迟切换：控制面在本代真正被换之前，先请其收尾当前回合。
     * 给 live 会话代理注入"即将热重载，请收尾"提示，然后等下一个 turn/end（或 grace 兜底）。
     */
    prepareSwitch: async (graceMs: number): Promise<PrepareReply> => {
      if (state.mode !== 'active') {
        return { ok: false, foundAgent: false, waitedForTurnEnd: false, reason: 'not-active' }
      }
      // 经 agentsRef 安全取 live 代理（避免 `ctx.agents` 无 inject 直接抛错），全程 try/catch 优雅降级。
      try {
        const agents = agentsRef.current
        // ★ "有没有活在跑" = 直读注册表里 agent 的真实阶段（不再听跨插件事件，见上面的说明）。
        const drainAgents = toDrainAgents(agents)
        const busy = drainAgents.filter((a) => agentPhase(a) === 'running')
        // 挑一个能 steer 的代理：优先**正在跑回合**那个 agent 的会话，其次事件流记的 lastActive。
        const steerTarget = busy[0]?.sessionId || state.lastActiveSessionId
        const agent = (steerTarget ? agents?.get?.(steerTarget) : undefined) as { steer?: (m: unknown) => void } | undefined
        const foundAgent = !!agent
        // 两个字段的分工（沿用既有语义）：
        //   turnInFlight     = 调用时是否有未收尾的回合（"有没有活"）
        //   waitedForTurnEnd = 是否等到了它收尾（"活干完了没"）
        // 控制面只认第二个为真的情形才注入续跑 —— 即"确有活、且已干净收尾"。
        if (busy.length === 0) {
          // 空闲即返回：没有未收尾的回合 → 无事可"收尾"，不注入噪声、也不白等 grace。
          return { ok: true, foundAgent, waitedForTurnEnd: false, reason: 'idle', turnInFlight: false }
        }
        // 注入挂起提示：让大脑把当前任务收尾、把话说完，交接由控制面在后台完成。
        try {
          // ★ 同样走带身份的工厂：若 steer 路径也把它持久化，缺 id/source 会污染会话日志。
          agent?.steer?.(
            injectedUserMessage(
              '【系统通知】环境即将热重载。请把当前任务收尾：完成手头步骤、把结论说清楚后自然结束本轮；交接由控制面在后台执行，完成后会自动唤醒你继续之前未完成的工作，无需你重复说明。',
            ),
          )
        } catch {
          /* steer 失败也要继续等（兜底走 grace；届时 drain 会 cancel 它） */
        }
        // 轮询等它真的结束（有界 = grace）。用**状态**而不是事件：事件路径实测从未触发过一次。
        const deadline = Date.now() + (graceMs > 0 ? graceMs : 20_000)
        for (;;) {
          if (toDrainAgents(agentsRef.current).every((a) => agentPhase(a) !== 'running')) {
            return { ok: true, foundAgent, waitedForTurnEnd: true, turnInFlight: true }
          }
          if (Date.now() >= deadline) {
            // grace 超时：有活但没收尾（常见于"卡在等人类输入"，如 ask_user_question）
            // → 控制面据此**不注入续跑**；随后的 freeze 会 cancel 它，让新代干净接手。
            return { ok: true, foundAgent, waitedForTurnEnd: false, reason: 'grace', turnInFlight: true }
          }
          await new Promise((res) => setTimeout(res, 250))
        }
      } catch (e) {
        return { ok: false, foundAgent: false, waitedForTurnEnd: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
    retire: async (): Promise<void> => {
      state.mode = 'demoted'
      clearInterval(warmTimer)
    },
  }

  const server = startAdminServer(cfg.port, handlers)
  console.log(`[switchboard:agent] apply; gen=${cfg.gen || '?'} admin=${cfg.port} mode=${state.mode} brains=${BRAINS.map((b) => b.kind).join('/')}`)
  // 卸载回收
  const dispose = (): void => {
    server.close()
    clearInterval(warmTimer)
  }
  ;(ctx as unknown as { on?: (ev: string, fn: () => void) => void }).on?.('dispose', dispose)
}

export type { SnapshotProvider }