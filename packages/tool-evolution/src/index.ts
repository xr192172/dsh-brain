/**
 * tool-evolution — 工具自进化插件（思路 #3）。
 *
 * slice A 落地两条不变量：
 *  - I3.2 适应度采集：从会话事件 tool/call + tool/result（含 error）折叠出每个工具的
 *    调用数 / 失败数 / 错误模式（sessionProjections 纯同步 fold，wire 可见）。
 *    token 归因与平均耗时留待 slice B（tool/result 事件不直接携工具名/callId）。
 *  - I3.1 打分来源：注册 `tool_score` 模型工具，LLM 用后自评，经 exec.agent.session
 *    append `tool/review` 会话事件，投影归入该工具（适应度 = 成功率 + token/耗时）。
 *
 * I3.3 失败即变异 / I3.4 描述锚定实现 留待 slice B（需 skill store + 验证 gate）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolStat, ToolEvolState, ToolEvolView } from './spec.js'
export type { ToolStat, ToolEvolState, ToolEvolView } from './spec.js'

export const name = 'tool-evolution'
export const inject: string[] = []

// 本插件往会话里写自定义事件 `tool/review`（tool_score 打分落盘）。DSH 的会话
// 读取路径只接受 KNOWN_SESSION_EVENT_TYPES ∪ 带 `ignorable` 标记的事件；而
// session.append 不暴露 ignorable 槽位。该 Set 是共享可变引用（persistence 也 import
// 同一实例），在 boot 注册即可让旧/新会话都正常读取，不再抛 SessionFormatUnsupportedError。
// 幂等：Set.add 重复无害。
if (!KNOWN_SESSION_EVENT_TYPES.has('tool/review')) {
  // 运行时是可变 Set（persistence 与 dsh-session 共享同一实例）；类型声明为
  // ReadonlySet，此处按运行时真实形态加成员。
  ;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add('tool/review')
  console.log('[tool-evolution] registered custom session event type: tool/review')
}

export interface Config {
  /** 每个工具保留的 LLM 评语条数上限。 */
  maxReviews: number
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
  z.object({ maxReviews: z.number().int().min(1).default(8) }),
)

const empty = (): ToolEvolState => ({ tools: {}, seq: -1 })

/** 从 ToolResultMessage 尽量取工具名（event.data 不直接含 name）。 */
function toolNameOf(message: unknown): string {
  if (message && typeof message === 'object') {
    const m = message as { name?: unknown; toolName?: unknown; callId?: unknown }
    if (typeof m.name === 'string' && m.name) return m.name
    if (typeof m.toolName === 'string' && m.toolName) return m.toolName
    if (typeof m.callId === 'string' && m.callId) return m.callId
  }
  return ''
}

export function apply(ctx: Context, config: Config): void {
  // ---------- 投影：适应度采集（I3.2） ----------
  ctx.inject(['sessionProjections'], (sctx) => {
    sctx.sessionProjections.register<'tool_evol', ToolEvolState>({
      key: 'tool_evol',
      stateSchema: z.object({ tools: z.record(z.string(), z.any()), seq: z.number() }),
      init: empty,
      apply(state: ToolEvolState, event: SessionEvent): ToolEvolState {
        if (event.type === 'tool/call') {
          const name = event.data.name
          if (!name) return state
          return ensure(state, name, (s) => ({ ...s, calls: s.calls + 1 }))
        }
        if (event.type === 'tool/review') {
          const d = event.data
          if (!d.tool) return state
          return ensure(state, d.tool, (s) => ({
            ...s,
            scores: [...s.scores, d.score].slice(-16),
            reviews: [...s.reviews, d.rationale].slice(-config.maxReviews),
          }))
        }
        if (event.type === 'tool/result') {
          const d = event.data
          if (!d.error) return state
          const name = toolNameOf(d.message)
          if (!name) return state
          const err = d.error.name || d.error.code || 'error'
          return ensure(state, name, (s) => ({
            ...s,
            failures: s.failures + 1,
            errors: (s.errors.includes(err) ? s.errors : [...s.errors, err]).slice(-12),
          }))
        }
        return state
      },
      wire: {
        viewSchema: z.object({ tools: z.record(z.string(), z.any()) }),
        view(state: ToolEvolState): ToolEvolView {
          return { tools: state.tools }
        },
      },
      stateVersion: 1,
    })
  })

  // ---------- 打分来源（I3.1）：tool_score 模型工具 ----------
  ctx.inject(['tools'], (tctx) => {
    tctx.tools.register(
      defineTool({
        name: 'tool_score',
        description:
          '给刚用过的工具打分（1-10）并给出评分依据 + 可选改进建议。这是工具自进化的反馈来源：分数越高说明该工具对当前类任务越有效，系统按成功率与耗时累积适应度，失败/漂移可据此触发改进。',
        parameters: {
          tool: { type: 'string', required: true, description: '被评价的工具名' },
          score: { type: 'integer', required: true, description: '1-10 分' },
          rationale: { type: 'string', required: true, description: '评分依据（尽量具体）' },
          suggested: { type: 'string', description: '可选：改进建议/PR 描述' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              tool: { type: 'string', required: true },
              score: { type: 'integer', required: true },
              saved: { type: 'boolean', required: true },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: `tool_score: ${String(value.tool)} = ${value.score}/10` + (value.saved ? ' (persisted)' : ''),
          }],
        },
        async execute(args, exec) {
          const name = String(args.tool)
          let saved = false
          const agent = exec.agent
          const session: Session | undefined = agent?.session as Session | undefined
          if (session && typeof (session as unknown as { append?: unknown }).append === 'function') {
            try {
              ;(session as unknown as { append: (t: string, d: unknown) => void }).append('tool/review', {
                caller: 'model',
                tool: name,
                score: args.score as number,
                rationale: String(args.rationale),
                suggested: args.suggested != null ? String(args.suggested) : undefined,
              })
              saved = true
            } catch {
              /* 落盘失败不影响自评返回 */
            }
          }
          return { tool: name, score: args.score as number, saved }
        },
        presentCall: (args) => ({ card: 'generic', title: 'Score tool', kind: 'other', rawInput: args.tool }),
      }),
    )
  })

  console.log('[tool-evolution] apply running; maxReviews=' + config.maxReviews)
}

/** 折叠辅助：确保某工具档案存在，并对它应用变更。若引用未变则返回原 state。 */
function ensure(state: ToolEvolState, tool: string, mutate: (s: ToolStat) => ToolStat): ToolEvolState {
  if (!tool || tool === '?') return state
  const cur =
    state.tools[tool] ??
    ({ calls: 0, failures: 0, errors: [], totalLatencyMs: 0, latencyN: 0, avgLatencyMs: 0, scores: [], reviews: [] } as ToolStat)
  const next = mutate(cur)
  if (Object.is(next, cur)) return state
  return { ...state, tools: { ...state.tools, [tool]: next }, seq: state.seq + 1 }
}