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

export const name = 'capability-bridge'
export const inject: string[] = []

export interface Config {
  /** 能力库文件路径；留空 = <DSH_HOME|~/.dsh>/capabilities/registry.json */
  registryPath: string
  /** list_capabilities 单次最多列几条 */
  maxRows: number
}
export const Config = z.object({
  registryPath: z.string().default(''),
  maxRows: z.number().int().min(1).default(50),
})

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
  version?: string
  status?: string
  source?: { package?: string; path?: string; provider?: string; tool?: string; seat?: string }
  acceptance?: { kind?: string; ref?: string; status?: string; ranAt?: string }
  holdoutHash?: string | null
  supersededBy?: string | null
  retiredReason?: string | null
  signals?: { invoked?: number; reused?: number; succeeded?: number; failed?: number; lastUsedAt?: string | null }
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
    : c.acceptance?.kind === 'none' || !c.acceptance?.ref
      ? 'MISSING'
      : String(c.acceptance.status ?? '?')
  const warn = (s.invoked ?? 0) >= 3 && (s.reused ?? 0) === 0
    ? '   ⚠ 高选用低复用（疑似描述过度承诺）'
    : ''
  return [
    `- ${c.id}  [${c.status ?? '?'}]  v${c.version ?? '?'}${warn}`,
    `    tool=${c.source?.tool ?? '-'}  provider=${c.source?.provider ?? '-'}  pkg=${c.source?.package ?? '-'}`,
    `    信号: 选用${s.invoked ?? 0} 复用${s.reused ?? 0} 成功${s.succeeded ?? 0} 失败${s.failed ?? 0}  复用率=${reuseRatio(s)}`,
    `    判据: ${acc}${c.acceptance?.ref ? '  ← ' + c.acceptance.ref : ''}`,
  ].join('\n')
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

  console.log('[capability-bridge] apply running; registry=' + file)
}
