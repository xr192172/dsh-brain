/**
 * capability-bridge —— 把「能力库」暴露给模型（P2-b）
 *
 * 为什么需要它：
 *   `ctx.subagents` 的 provider 注册表本身是权威的，但它**只对宿主可见** ——
 *   模型不知道「我现在有哪些能力」。设计文档把这条列为失败模式⑤：
 *   「子脑自进化后顶层认知过期」（"工具少 25 个且一天无人发现"就是它的预演）。
 *   本包给模型两个**只读**查询口：能力清单 + 单个能力档案。
 *
 * 为什么**不做** `capability_signal`（让模型自报"我被用了/我被复用了"）：
 *   §5.5.2 已经论证：**行为信号之所以最强，正因为它不可伪造**（选错要付代价）。
 *   让被评价者自己上报，恰好把它降级成 cheap talk。
 *   ⇒ 信号应当从会话日志**自动提取**（P3），不经过模型的嘴。
 *
 * 为什么只有两个工具、不再细分：
 *   §6 方案 C —— 长尾能力走**固定的** `list_capabilities`，能力清单本身**不进 tools 段**，
 *   于是「注册/淘汰一个能力」不会改写 prompt 前缀。工具越少，前缀越稳。
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { CapChange, FoldState } from './notice.js'
import { foldNotices, initialFoldState } from './notice.js'

export const name = 'capability-bridge'
export const inject: string[] = []

/**
 * 能力变更事件类型 —— **非 surface**（不在 `SurfaceEventType` 的
 * `'user/message' | 'assistant/message' | 'tool/result'` 三元联合里）
 * ⇒ **只在日志里、不进模型上下文** ⇒ 0 token、0 前缀影响。
 *
 * `KNOWN_SESSION_EVENT_TYPES` 是**共享可变 Set**（persistence 与 dsh-session 同实例），
 * 必须在 boot 注册，否则读这份日志时会抛 `SessionFormatUnsupportedError`。
 * 幂等：`add` 重复无害。（照抄 `packages/tool-evolution` 对 `tool/review` 的做法。）
 *
 * ⚠️ 这处是**进程级全局 mutation，插件卸载不会撤销** —— 属于"卸不干净"的一个已知例外，
 * 但它是**必需**的：不注册，旧会话的日志就再也读不了。
 */
export const CAP_CHANGE_EVENT = 'capability/change'
if (!KNOWN_SESSION_EVENT_TYPES.has(CAP_CHANGE_EVENT)) {
  ;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(CAP_CHANGE_EVENT)
  console.log(`[capability-bridge] registered custom session event type: ${CAP_CHANGE_EVENT}`)
}

export interface Config {
  /** 能力库文件路径；留空 = <DSH_HOME|~/.dsh>/capabilities/registry.json */
  registryPath: string
  /** list_capabilities 单次最多列几条 */
  maxRows: number
}
/**
 * ★ 容错包装（2026-09-15）：缺 `config:` 块时 loader 传 `undefined`，
 * 裸 `z.object({...})` 会抛 `ValidationError: expected object, received undefined`
 * ⇒ **整棵插件树装配失败、gen 启动即 EXIT code=1**（2026-09-14 gen-3083 实事故）。
 *
 * 为什么不能只靠字段的 `.default()`：那些默认值只在"对象存在但缺键"时生效，
 * 对"对象本身是 undefined"不生效。也**不要**用 `.default({})` —— 它看似修好，
 * 实则短路内层解析、返回字面量 `{}`，让所有字段变成 `undefined`（更隐蔽的坏）。
 *
 * `preprocess` 归一化：`undefined`/`null` → `{}` → 内层默认值照常生效；
 * 而**类型错误仍然报错**（不是无脑吞掉配置）。
 */
function tolerantConfig<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return z.preprocess((v) => v ?? {}, schema)
}

export const Config = tolerantConfig(
  z.object({
    registryPath: z.string().default(''),
    maxRows: z.number().int().min(1).default(50),
  }),
)

function resolveRegistry(config: Config): string {
  if (config.registryPath && config.registryPath.trim()) return config.registryPath.trim()
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'capabilities', 'registry.json')
}

function loadRegistry(file: string): { ok: true; db: TDb } | { ok: false; text: string } {
  if (!fs.existsSync(file)) {
    return { ok: false, text: `能力库文件不存在：${file}\n（先运行： node scripts/capability-registry.mjs init）` }
  }
  try {
    return { ok: true, db: JSON.parse(fs.readFileSync(file, 'utf8')) as TDb }
  } catch (e) {
    return { ok: false, text: `能力库解析失败：${(e as Error).message}` }
  }
}

interface TCaps {
  id: string
  kind?: string
  label?: string
  version?: string
  status?: string
  source?: { package?: string; path?: string; provider?: string; tool?: string; seat?: string; transport?: string; entry?: string }
  acceptance?: { kind?: string; ref?: string; status?: string; ranAt?: string }
  holdoutHash?: string | null
  supersededBy?: string | null
  retiredReason?: string | null
  signals?: { invoked?: number; reused?: number; succeeded?: number; failed?: number; lastUsedAt?: string | null }
  /** 仅工具层能力源（MCP server 等）有：工具面快照 */
  tooling?: {
    toolCount?: number
    laneCount?: number
    lanes?: string[]
    laneToolCount?: number
    directCount?: number
    drift?: { registeredNotInLanes?: string[]; inLanesNotRegistered?: string[]; exempt?: string[] }
  }
}

interface TDb {
  schema?: string
  updatedAt?: string
  capabilities?: TCaps[]
}

const reuseRatio = (s?: TCaps['signals']) =>
  s && s.invoked ? (Number(s.reused ?? 0) / s.invoked).toFixed(2) : 'n/a'

function renderRow(c: TCaps): string {
  const s = c.signals ?? {}
  const acc = c.acceptance?.status === 'passed'
    ? 'pass'
    : (!c.acceptance?.ref || c.acceptance?.kind === 'none') ? 'MISSING' : String(c.acceptance.status ?? '?')
  const warn = (s.invoked ?? 0) >= 3 && (s.reused ?? 0) === 0
    ? '   [!] 高选用低复用（疑似描述过度承诺）'
    : ''
  const lines = [
    `- ${c.id}  [${c.kind ?? '?'} / ${c.status ?? '?'}]  v${c.version ?? '?'}${warn}`,
  ]

  if (c.kind === 'mcp-server') {
    const t = c.tooling
    lines.push(`    能力源: ${c.label ?? c.source?.path ?? '-'}`)
    lines.push(`    工具面: ${t
      ? `${t.toolCount ?? '?'} 个工具 / ${t.laneCount ?? '?'} 条能力线（${(t.lanes ?? []).join(', ')}）`
      : '(未扫描)'}    导航工具=${c.source?.tool ?? '-'}`)
    const missed = (t?.drift?.registeredNotInLanes ?? []).filter((x) => x !== c.source?.tool)
    if (missed.length) {
      lines.push(`    [!] ${missed.length} 个工具未进能力线（靠导航看不见它们）: ${missed.join(', ')}`)
    }
  } else {
    lines.push(`    tool=${c.source?.tool ?? '-'}  provider=${c.source?.provider ?? '-'}  pkg=${c.source?.package ?? '-'}`)
  }

  lines.push(`    信号: 选用${s.invoked ?? 0} 复用${s.reused ?? 0} 成功${s.succeeded ?? 0} 失败${s.failed ?? 0}  复用率=${reuseRatio(s)}`)
  lines.push(`    判据: ${acc}${c.acceptance?.ref ? '  <- ' + c.acceptance.ref : ''}`)
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// P4：能力变更通知（设计依据 `docs/capability-registry-evolution.md` §6.1–§6.4）
//
// 目标：**能力增删不再改写 prompt 前缀**。
//   · 观察：能力库变了 ⇒ 往会话日志写一条**非 surface** 事件（0 token、0 前缀影响）
//   · 折叠：在**工具结果写入前**（`tools/post-execute` waterfall）把「完整当前集合快照」
//     搭车到 `additionalContexts` —— 走的是上游**给插件注入上下文**的既有通道
//     （`dsh-agent-loop` 会 `acceptContext`；先例 `dsh-repeat-tool-reminder`）。
//   · 为什么不用 `surfaceOp: replace` 事后改：那是**事后改写** ⇒ 必击穿前缀
//     （我们正是因此关掉了 `dsh-compaction-tool-result-pruner`）。
// ─────────────────────────────────────────────────────────────────────────────

/** 当前**实际可用**的能力 id（权威来源：能力库里 `status === 'active'` 的项）。 */
export function activeIds(db: TDb): string[] {
  return (db.capabilities ?? []).filter((c) => c.status === 'active').map((c) => c.id)
}

/**
 * 把折叠行包装成模型可见的 **context 条目**。
 *
 * ★ `source` 标注是**必需**的，不是装饰 —— 上游注释明说：
 *   「the label is load-bearing (an unlabeled context would render as a **user prompt**
 *     in derived history)」。漏了它，派生历史里会出现一条"用户说的"假消息。
 * ★ `form: 'notice'` 是上游给"通知"用的既有形态。
 */
export function noticeContext(text: string, summary: string) {
  return {
    content: [{ type: 'text' as const, text }],
    source: { kind: 'plugin' as const, plugin: name, form: 'notice' as const, summary },
  }
}

/**
 * 装上通知链路。
 *
 * 全部包在 try/catch 里：**通知失败绝不影响工具结果，更不能影响 boot**。
 * （P4 的收益是"省缓存"，而 boot 是命脉 —— 代价不对等，所以全部降级为 no-op。）
 */
function installNoticeWiring(ctx: Context, file: string): void {
  ctx.inject(['sessions'], (sctx: any) => {
    const foldStates = new Map<string, FoldState>()
    const changeLogs = new Map<string, CapChange[]>()
    /** sessionId → 上次见到的 registry.updatedAt（用来判断"能力库是否变过"） */
    const stamps = new Map<string, string>()

    const foldStateOf = (id: string): FoldState => {
      let s = foldStates.get(id)
      if (!s) { s = { ...initialFoldState }; foldStates.set(id, s) }
      return s
    }
    const changeLogOf = (id: string): CapChange[] => {
      let c = changeLogs.get(id)
      if (!c) { c = []; changeLogs.set(id, c) }
      return c
    }

    /** 当前能力库快照。读不到 ⇒ `null`（**不猜、也不写** —— 缺证据时不说话）。 */
    const liveSnapshot = (): { ids: string[]; stamp: string } | null => {
      const r = loadRegistry(file)
      if (!r.ok) return null
      return { ids: activeIds(r.db), stamp: String(r.db.updatedAt ?? '') }
    }

    // ① 观察：只记账。能力库变了 ⇒ 往日志写一条非 surface 事件（0 token）。
    sctx.on('session/event', (session: any, event: any) => {
      try {
        const id = session?.id
        if (!id) return
        const snap = liveSnapshot()
        if (!snap) return
        const prev = stamps.get(id)
        // ★ 首次见到该会话 ⇒ 只记基线、**不记为变更** ——
        //   否则每个新会话都会平白多出一条通知（噪音 + 一次额外上下文行）。
        if (prev === undefined) { stamps.set(id, snap.stamp); return }
        if (prev === snap.stamp) return
        stamps.set(id, snap.stamp)
        changeLogOf(id).push({
          seq: Number(event?.seq ?? 0),
          at: new Date().toISOString(),
          action: 'gated',
          id: '__registry__',
          detail: snap.stamp,
        })
        // 写进会话日志（非 surface；写失败不影响会话）
        try {
          session.append?.(CAP_CHANGE_EVENT, {
            at: new Date().toISOString(),
            registryUpdatedAt: snap.stamp,
            activeCount: snap.ids.length,
          })
        } catch { /* 日志写失败不阻断会话 */ }
      } catch { /* 观察侧绝不影响主流程 */ }
    })

    // ② 折叠：在工具结果**写入前**搭车（`prepend: true` ⇒ 我们先跑，再 `await next()`）
    sctx.on(
      'tools/post-execute',
      async (exec: any, _result: any, next: any) => {
        const downstream = await next()
        try {
          const sid = exec?.agent?.session?.header?.id
          if (!sid) return downstream
          const snap = liveSnapshot()
          if (!snap) return downstream
          const out = foldNotices(changeLogOf(sid), foldStateOf(sid), snap.ids)
          if (out.kind === 'no-pending') return downstream
          // 集合与上次写出去的一致 ⇒ 整段 delta 可丢（但仍推进水位，别永远留在 pending）
          foldStates.set(sid, out.next)
          if (out.kind === 'dropped') return downstream
          const item = noticeContext(out.text, `能力集合 ${snap.ids.length} 项`)
          // 搭在本就已存在的 append 上 ⇒ 前缀一字未动，只多这几行
          return { ...downstream, additionalContexts: [item, ...(downstream?.additionalContexts ?? [])] }
        } catch {
          return downstream // 通知失败绝不影响工具结果
        }
      },
      { prepend: true },
    )
  })
}

export function apply(ctx: Context, config: Config): void {
  const file = resolveRegistry(config)

  ctx.inject(['tools'], (tctx) => {
    // ── 工具 1：能力清单 ──────────────────────────────────────────────────
    tctx.tools.register(
      defineTool({
        name: 'list_capabilities',
        description:
          '列出当前**能力库**（本 harness 可用的子代理能力注册表）。用来回答：我现在有哪些能力可用？某个能力还活着吗？它真的被用过吗（选用/复用）？它的验收状态是什么？' +
          '**不要凭记忆猜能力清单，以本工具返回为准** —— 能力会被注册、升级、合并、淘汰，你的记忆会过期。',
        parameters: {
          status: { type: 'string', description: '可选：只看某个状态（active / superseded / merged / retired）。' },
          all: { type: 'boolean', description: '可选：true = 不过滤状态，列出全部。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              count: { type: 'integer', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String((value as { text: string }).text) }],
        },
        async execute(args: Record<string, unknown>) {
          const r = loadRegistry(file)
          if (!r.ok) return { count: 0, text: r.text }
          const all: TCaps[] = Array.isArray(r.db.capabilities) ? r.db.capabilities : []
          const st = args.status ? String(args.status) : args.all === true ? null : 'active'
          let caps = st ? all.filter((c) => c.status === st) : all
          caps = caps.slice(0, config.maxRows)
          const head = `能力库：共 ${all.length} 条，下列 ${caps.length} 条` +
            `${st ? `（状态=${st}）` : ''}　更新于 ${r.db.updatedAt ?? '?'}`
          const body = caps.length ? caps.map(renderRow).join('\n') : '　（没有符合条件的条目）'
          const tail = '\n提示：单个能力的完整档案用 capability_report；' +
            '「判据: MISSING」表示它还没接验收标准 —— 那正是注册门（P3）要拒的形态。'
          return { count: caps.length, text: `${head}\n${body}\n${tail}` }
        },
        presentCall: (args) => ({
          card: 'generic',
          title: 'List capabilities',
          kind: 'other',
          rawInput: JSON.stringify(args).slice(0, 200),
        }),
      }),
    )

    // ── 工具 2：单个能力档案 ──────────────────────────────────────────────
    tctx.tools.register(
      defineTool({
        name: 'capability_report',
        description:
          '查一个能力的完整档案：来源包/路径/版本、它注册的 provider 与模型看到的工具名、验收标准引用、' +
          '隐藏 holdout 哈希、被谁取代、以及 lineage（注册/升级/合并/淘汰的历史）。' +
          '用于回答「这个能力是哪来的、什么时候换的、上一版为什么被换掉」。',
        parameters: {
          id: { type: 'string', required: true, description: '能力 id，例如 council-architect' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              found: { type: 'boolean', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String((value as { text: string }).text) }],
        },
        async execute(args: Record<string, unknown>) {
          const r = loadRegistry(file)
          if (!r.ok) return { found: false, text: r.text }
          const caps: TCaps[] = Array.isArray(r.db.capabilities) ? r.db.capabilities : []
          const id = String(args.id ?? '')
          const c = caps.find((x) => x.id === id)
          if (!c) {
            return { found: false, text: `未找到能力「${id}」。现有：${caps.map((x) => x.id).join(', ') || '(空)'}` }
          }
          return { found: true, text: JSON.stringify(c, null, 2) }
        },
        presentCall: (args) => ({
          card: 'generic',
          title: 'Capability report',
          kind: 'other',
          rawInput: String(args.id ?? ''),
        }),
      }),
    )
  })

  // P4：能力变更通知链路。装不上也不影响本插件与 boot（内部已 try/catch，
  // 这里再兜一层 —— 通知的收益是"省缓存"，boot 是命脉，代价不对等）。
  try {
    installNoticeWiring(ctx, file)
  } catch (e) {
    console.warn('[capability-bridge] 通知链路未装上（不影响其它功能）：' + (e as Error).message)
  }

  console.log('[capability-bridge] apply running; registry=' + file)
}
