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
import { join } from 'node:path'
import { startAdminServer } from './admin.js'
import { newDrain, evaluateStatic } from './drain.js'
import { computeCaughtUpSeq } from './preseed.js'
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

export const Config = z.object({
  adminPort: z.number().int().min(0).default(0),
  gen: z.string().default(''),
  leaseToken: z.string().default(''),
  mode: z.enum(['staging', 'active', 'demoted']).default('staging'),
  genDir: z.string().default(''),
  guardP2: z.boolean().default(true),
  resumeOnPromote: z.boolean().default(true),
})

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
interface AgentShim {
  get(id: string): unknown
  resume(o: { resumeSessionId: string; agentOptions?: unknown }): Promise<unknown>
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
        const msg = { role: 'user', content: [{ type: 'text', text } as { type: string; text: string }] }
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

  // ── 延迟切换：挂一个"回合结束"信号，供 prepareSwitch 等待当前回合收尾 ──
  let lastTurnEndAt = 0
  let pendingPrepare: { resolve: (r: PrepareReply) => void; timer: ReturnType<typeof setTimeout> | undefined; base: number; foundAgent: boolean } | null = null
  ;(ctx as unknown as { on?: (ev: string, fn: (p: unknown) => void) => void }).on?.('turn/end', () => {
    const now = Date.now()
    lastTurnEndAt = now
    if (pendingPrepare && now > pendingPrepare.base) {
      const p = pendingPrepare
      pendingPrepare = null
      clearTimeout(p.timer)
      p.resolve({ ok: true, foundAgent: p.foundAgent, waitedForTurnEnd: true })
    }
  })

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

  // 冷读暖机 + 持续追平
  const warm = async (): Promise<void> => {
    state.caughtUpSeq = await computeCaughtUpSeq(ctx)
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
      const r = await evaluateStatic(ctx, state.drain)
      // 上报本代"主活跃会话"：优先用事件流跟踪到的 lastActiveSessionId（agent 会话事件，最可靠）。
      // 兜底再从 workspace 会话注册表取每个工作区最近 attach 的会话。
      // 全部 try/catch——冷代/无会话时优雅上报空，不得击穿 freeze。
      let live: Array<{ id: string; seq: number }> = []
      try {
        if (state.lastActiveSessionId) {
          live = [{ id: state.lastActiveSessionId, seq: 1 }]
        } else {
          const reg = (ctx as unknown as { workspaceRegistry?: { list(): Array<{ sessionIds?: readonly string[] }> } }).workspaceRegistry
          const workspaces = typeof reg?.list === 'function' ? reg.list() : []
          for (const w of workspaces) {
            const sid = w?.sessionIds?.[0]
            if (sid) {
              live = [{ id: sid, seq: 0 }]
              break
            }
          }
        }
      } catch {
        live = []
      }
      if (live.length > 0) resumeTrace(cfg.genDir, { phase: 'detect', genId: cfg.gen, sessionId: live[0].id })
      else resumeTrace(cfg.genDir, { phase: 'detect', genId: cfg.gen, sessionId: null, note: 'no active session detected' })
      return { static: r.static, lastSeq: r.lastSeq, sessions: live }
    },
    promote: async (req: PromoteRequest): Promise<{ ok: boolean }> => {
      if (req.gen && req.gen !== cfg.gen) return { ok: false }
      if (cfg.leaseToken && req.writerToken !== cfg.leaseToken) return { ok: false }
      state.mode = 'active'
      ;(ctx as unknown as { emit?: (n: string) => void }).emit?.('handover/promote')
      console.log(`[switchboard:agent] promote resumeSessionId=${req.resumeSessionId ?? 'none'}`)
      // 方案B 接续：携带上一代主活跃会话 → resume + 注入"环境已更新，请继续"
      // patch 运行时不带 schema default，故默认开：仅当显式 false 才关闭
      if ((patch.resumeOnPromote !== false) && req.resumeSessionId) {
        // 同步落 trace：无论 resume 异步成败，这里都先确证"调度已发生 + ctx.agents 是否就绪"。
        resumeTrace(cfg.genDir, {
          phase: 'resume',
          sessionId: req.resumeSessionId,
          ok: true,
          note: 'scheduled',
          agents: !!agentsRef.current,
        })
        scheduleResume(
          agentsRef,
          req.resumeSessionId,
          [
            '【自动续跑】上一轮正在处理的任务因环境热切换被中断，已完成步骤与进行中的工作都在本会话里。请在**无需用户再次确认**的前提下，把该任务自主续跑并执行到完成为止：已跑完的部分不要重做，直接推进剩余步骤；需要的地方照常调用工具；全部完成后一次性汇报结果。本次续跑视为用户已预先批准，不要再停下来征询用户或等待确认。',
          ],
          4,
          cfg.genDir,
        )
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
        const agent = (state.lastActiveSessionId ? agents?.get?.(state.lastActiveSessionId) : undefined) as
          | { steer?: (m: unknown) => void }
          | undefined
        const foundAgent = !!agent
        // 注入挂起提示：让大脑把当前任务收尾、把话说完，交接由控制面在后台完成。
        try {
          agent?.steer?.({
            role: 'user',
            content:
              '【系统通知】环境即将热重载。请把当前任务收尾：完成手头步骤、把结论说清楚后自然结束本轮；交接由控制面在后台执行，完成后会自动唤醒你继续之前未完成的工作，无需你重复说明。',
          })
        } catch {
          /* steer 失败也要继续等待 turn/end（兜底走 grace） */
        }
        // 等待一个"新的"回合结束（晚于本次调用发起点），或 grace 兜底。
        return await new Promise<PrepareReply>((resolve) => {
          const p = { resolve, timer: undefined as ReturnType<typeof setTimeout> | undefined, base: lastTurnEndAt, foundAgent }
          if (pendingPrepare) {
            // 并发/重复调用：旧的让位（superseded），用新的请求点与 grace。
            clearTimeout(pendingPrepare.timer)
            pendingPrepare.resolve({ ok: false, foundAgent: pendingPrepare.foundAgent, waitedForTurnEnd: false, reason: 'superseded' })
          }
          p.timer = setTimeout(() => {
            if (pendingPrepare === p) {
              pendingPrepare = null
              resolve({ ok: true, foundAgent, waitedForTurnEnd: false, reason: 'grace' })
            }
          }, graceMs > 0 ? graceMs : 20_000)
          pendingPrepare = p
        })
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