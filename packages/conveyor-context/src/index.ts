/**
 * conveyor-context — DSH 插件（从 agent-shell 解耦重做），对应思路 #1「传送带上下文」。
 *
 * 本切片落地三条不变量：
 *  - I1.4 摘要目录只追加、低频（目录 = sessionProjections 的纯同步 fold）
 *  - I1.3 非破坏折叠索引（折叠的原文全文不在本插件保留——由 DSH compaction 服务做真正压缩，本插件只维护目录索引）
 *  - I1.5 动态注入可摘除 → 关键事实升格：从 `tool/result` 中提取 `[[KEEP]]…[[/KEEP]]` 片段进 `kept[]`，
 *        原始大结果不滞留（DSH 的 tool-result-pruner 负责裁掉原始结果）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// 声明合并：加载 dsh-compaction 的 `compaction/*` SessionEventMap 扩展，使下面按类型折叠可类型安全
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'
// 装载 ctx.systemPrompt 服务（动态运行时上下文 → user-role 尾端快照，价值选择规则由此注入）
import type {} from '@deepseek-ai/dsh-system-prompt'
export type { ConveyorState, ConveyorView, ConveyorFold, KeptFact, ConveyorDirectoryEntry } from './spec.js'
import type { ConveyorState, ConveyorView, ConveyorFold } from './spec.js'

export const name = 'conveyor-context'
// 顶层不声明要等的服务：投影经 ctx.inject(['sessionProjections']) 在关节存在时才注册，
// 无关节（headless 装配）插件仍可正常激活。
export const inject: string[] = []

export interface Config {
  /** 距离上次折叠满多少轮，就把这些轮收拢进目录（低频批量，I1.4）。 */
  foldEveryTurns: number
  /** kept[] 上限，超出按 seq 淘汰旧事实（避免目录膨胀）。 */
  maxKeptFacts: number
  /** folds[]（DSH 压实记录）上限，超出丢弃最旧折叠。 */
  maxFolds: number
  /** 是否注入"价值选择"尾段指令（LLM 手动标记有价值内容，否则允许折叠）。默认开。 */
  enableValueRules: boolean
  /** 是否注入"Code Mode 工具呈现"显式指令（顶层仅 run_code，其余走 tools.*）。默认开。 */
  enableCodeModePrompt: boolean
}

export const Config = z.object({
  foldEveryTurns: z.number().int().min(1).default(6),
  maxKeptFacts: z.number().int().min(1).default(32),
  maxFolds: z.number().int().min(1).default(40),
  enableValueRules: z.boolean().default(true),
  enableCodeModePrompt: z.boolean().default(true),
})

/**
 * 价值选择指令（内联标记 + 折叠前回顾）。通过 ctx.systemPrompt.context 作为
 * 动态运行时上下文注入 —— 以 user-role 快照追加在历史末尾（tail），变体在尾、
 * 不动 system/tools 前缀缓存。让 LLM 手动判断工具/旧内容价值：有价值 → [[KEEP]] 保留，
 * 否则允许被压缩折叠。
 */
const VALUE_RULES = `【价值保留规则】
凡你觉得"后续可能还要用"的内容——尤其是工具返回里带有跨轮价值的事实——在下一行用 [[KEEP]]…[[/KEEP]] 包住一个要点标出（每次少而精，最多约 3 条）。conveyor 会把它持久保留进 kept[]，压缩折叠时不会丢失；未标记的冗余/长内容允许被折叠回收。
对已滚到早期、即将被压缩的旧工具内容，也先确认其中是否仍有值得保留的要点，有就标出再放手。`

/** Code Mode 工具呈现的显式指令：DSH 把此教学藏在 run_code description 里，
 *  易被上下文压缩掩盖、以致模型仍去顶层试 grep/glob/read。这里以独立 tail 指令打明。 */
const CODE_MODE_RULES = `【当前工具呈现模式：Code Mode】
顶层面板仅在可直接调用 run_code 这一种工具。
grep / glob / read / explore_code 等其余工具都只能作为 run_code 程序内的子工具调用：在 run_code 里写 \`await tools.<name>(args)\`（或 \`import { name } from "./tools"\`）来用它们——不要把 grep/glob/read 当作顶层面板里的独立函数直接调用，它们在 Code Mode 下顶层不可用。
run_code 的入参是「一个 async 程序体」，不是普通工具参数表；如需直接顶层原生工具，请主动提示切换 native / dual 工具呈现模式。`

/** 从工具结果文本里提取 `[[KEEP]]…[[/KEEP]]` 关键事实（I1.5 升格）。 */
function extractKept(text: string, turn: number, seq: number): { text: string; turn: number; seq: number }[] {
  const out: { text: string; turn: number; seq: number }[] = []
  const re = /\[\[KEEP\]\]([\s\S]*?)\[\[\/KEEP\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const s = m[1].trim()
    if (s.length) out.push({ text: s, turn, seq })
  }
  return out
}

const emptyState = (): ConveyorState => ({ directory: [], folds: [], kept: [], lastFoldSeq: -1 })

/** 一次记忆召回的命中。 */
interface RecallHit {
  /** 命中来源层：kept 升格事实 / fold 折叠摘要 / directory 轮次目录。 */
  layer: 'kept' | 'fold' | 'directory'
  seq: number
  turn: number
  text: string
  /** 加权匹配分（kept 权重最高，命中词数 × 权重）。 */
  score: number
}

/**
 * 在 conveyor 记忆里做轻量关键词召回。纯同步、零副作用：
 * 分词 → 子串命中累计 → 按层加权 → 同分按新近（seq 降序）→ 截断 limit。
 * kept[] 是 [[KEEP]] 升格的关键事实，权重最高；folds[]/directory[] 只作兜底。
 */
function buildRecallHits(state: ConveyorState | undefined, query: string, limit: number): RecallHit[] {
  if (!state) return []
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (terms.length === 0) return []
  const hits: RecallHit[] = []
  const push = (layer: RecallHit['layer'], seq: number, turn: number, text: string, weight: number): void => {
    const lower = text.toLowerCase()
    let overlap = 0
    for (const t of terms) if (lower.includes(t)) overlap++
    if (overlap > 0) hits.push({ layer, seq, turn, text, score: overlap * weight })
  }
  for (const k of state.kept) push('kept', k.seq, k.turn, k.text, 3)
  for (const f of state.folds) if (f.summary) push('fold', f.seq, 0, f.summary, 1.5)
  for (const d of state.directory) {
    const text = [d.reason, d.summary].filter(Boolean).join(' · ')
    if (text) push('directory', d.seq, d.turn, text, 0.8)
  }
  hits.sort((a, b) => b.score - a.score || b.seq - a.seq)
  return hits.slice(0, limit)
}

export function apply(ctx: Context, config: Config): void {
  // 投影注册要放在 sessionProjections 关节存在时才生效（headless 装配无关节则自动跳过）。
  ctx.inject(['sessionProjections'], (sctx) => {
    sctx.sessionProjections.register<'conveyor', ConveyorState>({
      key: 'conveyor',
      stateSchema: z.object({
        directory: z.array(
          z.object({ seq: z.number(), turn: z.number(), reason: z.string(), summary: z.string() }),
        ),
        folds: z.array(
          z.object({
            compactionId: z.string(),
            seq: z.number(),
            summary: z.string(),
            shadowedSeqs: z.array(z.number()),
            shadowedTokenCount: z.number(),
            model: z.string(),
          }),
        ),
        kept: z.array(z.object({ seq: z.number(), turn: z.number(), text: z.string() })),
        lastFoldSeq: z.number(),
      }),
      init: emptyState,
      apply(state, event: SessionEvent): ConveyorState {
        if (event.type === 'turn/end') {
          const sinceLastFold = state.directory.filter((d) => d.seq > state.lastFoldSeq).length
          const dir = [
            ...state.directory,
            { seq: event.seq, turn: event.data.turn, reason: event.data.reason?.kind ?? 'end', summary: '' },
          ]
          // 低频折叠：满 foldEveryTurns 条后推进 lastFoldSeq，后续可据此触发异步压实。
          const lastFold = sinceLastFold + 1 >= config.foldEveryTurns ? event.seq : state.lastFoldSeq
          return { directory: dir, folds: state.folds, kept: state.kept, lastFoldSeq: lastFold }
        }
        if (event.type === 'compaction/summary') {
          const d = event.data
          const fold: ConveyorFold = {
            compactionId: String(d.compactionId ?? ''),
            seq: event.seq,
            summary: blocksToText(d.summary).slice(0, 2000),
            shadowedSeqs: d.shadowedSeqs ?? [],
            shadowedTokenCount: d.shadowedTokenCount ?? 0,
            model: d.model ?? '',
          }
          const folds = [...state.folds, fold].slice(-config.maxFolds)
          return { ...state, folds, lastFoldSeq: event.seq }
        }
        if (event.type === 'compaction/prune') {
          const d = event.data
          const fold: ConveyorFold = {
            compactionId: '',
            seq: event.seq,
            summary: '[pruned]',
            shadowedSeqs: d.shadowedSeqs ?? [],
            shadowedTokenCount: d.shadowedTokenCount ?? 0,
            model: '',
          }
          const folds = [...state.folds, fold].slice(-config.maxFolds)
          return { ...state, folds, lastFoldSeq: event.seq }
        }
        // LLM 的价值选择注释：assistant 消息里携带的 [[KEEP]] 标记（对工具/旧内容的保留声明）
        if (event.type === 'assistant/message') {
          const msgText = extractText(event.data.message)
          const facts = extractKept(msgText, event.data.turn, event.seq)
          if (facts.length === 0) return state
          const seen = new Set(state.kept.map((k) => k.text))
          const fresh = facts.filter((f) => !seen.has(f.text))
          const kept = [...state.kept, ...fresh].slice(-config.maxKeptFacts)
          if (kept.length === state.kept.length && kept[0] === state.kept[0]) return state
          return { directory: state.directory, folds: state.folds, kept, lastFoldSeq: state.lastFoldSeq }
        }
        if (event.type === 'tool/result') {
          const msgText = extractText(event.data.message)
          const facts = extractKept(msgText, event.data.turn, event.seq)
          if (facts.length === 0) return state
          const seen = new Set(state.kept.map((k) => k.text))
          const fresh = facts.filter((f) => !seen.has(f.text))
          const kept = [...state.kept, ...fresh].slice(-config.maxKeptFacts)
          if (kept.length === state.kept.length && kept[0] === state.kept[0]) return state
          return { directory: state.directory, folds: state.folds, kept, lastFoldSeq: state.lastFoldSeq }
        }
        return state
      },
      wire: {
        viewSchema: z.object({
          directory: z.array(
            z.object({ seq: z.number(), turn: z.number(), reason: z.string(), summary: z.string() }),
          ),
          folds: z.array(
            z.object({
              compactionId: z.string(),
              seq: z.number(),
              summary: z.string(),
              shadowedSeqs: z.array(z.number()),
              shadowedTokenCount: z.number(),
              model: z.string(),
            }),
          ),
          kept: z.array(z.object({ seq: z.number(), turn: z.number(), text: z.string() })),
        }),
        view(state: ConveyorState): ConveyorView {
          return { directory: state.directory, folds: state.folds, kept: state.kept }
        },
      },
      stateVersion: 2,
    })
  })

  // 价值选择尾段指令：作为动态运行时上下文注入（user-role 快照追加在尾，cache 安全）
  if (config.enableValueRules) {
    ctx.inject(['systemPrompt'], (spCtx) => {
      spCtx.systemPrompt.context({
        name: 'conveyor:value',
        order: 10_000, // 靠后，落在稳定的 system/tools 前缀之后
        text: () => VALUE_RULES,
      })
    })
  }

  // Code Mode 显式指令：让模型明确"顶层仅 run_code，其余经 tools.*"，避免它反复试顶层 grep。
  if (config.enableCodeModePrompt) {
    ctx.inject(['systemPrompt'], (spCtx) => {
      spCtx.systemPrompt.context({
        name: 'conveyor:tool-mode',
        order: 10_100, // 比 value 规则更靠后，贴近尾端最醒目
        text: () => CODE_MODE_RULES,
      })
    })
  }

  // memory_recall：读回 conveyor 记忆（kept[] 升格事实 + folds[] 折叠摘要 + directory[] 轮次索引），
  // 只读、纯同步、无副作用。只在 sessionProjections + tools 都装配时才注册——conveyor 投影不在则记忆无从读起。
  ctx.inject(['sessionProjections', 'tools'], (recallCtx) => {
    recallCtx.tools.register(
      defineTool({
        name: 'memory_recall',
        description:
          '按关键词检索 conveyor 记忆——折叠前已 [[KEEP]] 升格的关键事实（权重最高）、折叠摘要、每轮目录。' +
          '用它找回早期/被压缩出的工具内容要点，避免在窗口里硬翻历史。只读，不改任何状态。',
        parameters: {
          query: {
            type: 'string',
            required: true,
            description: '要找回的要点/关键词（空格分隔多个词，命中越多权越高）。',
          },
          limit: {
            type: 'integer',
            description: '返回条数上限，默认 6，最大 20。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              hits: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    layer: { type: 'string', required: true },
                    seq: { type: 'integer', required: true },
                    turn: { type: 'integer', required: true },
                    text: { type: 'string', required: true },
                    score: { type: 'number', required: true },
                  },
                },
              },
              total: { type: 'integer', required: true },
            },
          },
          render: (args, value) => {
            if (value.total === 0) {
              return [{ type: 'text', text: `No conveyor memory matched "${args.query}".` }]
            }
            const body = value.hits
              .map((h, i) => `${i + 1}. [${h.layer}] ${h.text}`)
              .join('\n')
            return [
              {
                type: 'text',
                text: `Recalled ${value.total} conveyor memory hit(s) for "${args.query}":\n${body}`,
              },
            ]
          },
        },
        execute(args, exec) {
          const query = (args.query ?? '').trim()
          const limit = Math.max(1, Math.min(args.limit ?? 6, 20))
          const session: Session | undefined = exec.agent?.session
          const state = session ? recallCtx.sessionProjections.stateOf(session, 'conveyor') : undefined
          const hits = buildRecallHits(state, query, limit)
          return Promise.resolve({ hits, total: hits.length })
        },
      }),
    )
  })

  // 加载探针日志：验证“思路插件 → bundle → dsh 启动”链路已通（插件注册即打印）。
  console.log('[conveyor-context] apply running; foldEveryTurns=' + config.foldEveryTurns + ' valueRules=' + config.enableValueRules)
}

/** 从 ContentBlock[]（compaction/summary.summary）里取 text 拼成可读摘要。 */
function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
}

/** 从 ToolResultMessage 里取可读文本（content 可能是 string / 结构化）。 */
function extractText(message: unknown): string {
  if (typeof message === 'string') return message
  if (message && typeof message === 'object') {
    const c = (message as { content?: unknown }).content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((p) => (p && typeof p === 'object' ? ((p as { text?: unknown }).text ?? '') : String(p)))
        .join('\n')
    }
  }
  return ''
}