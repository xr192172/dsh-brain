#!/usr/bin/env node
/**
 * patch-agent-loop-hardening.mjs —— 对 `dsh-agent-loop` 的两处加固
 *
 * ## ① 非 LlmError 的回合错误：留下堆栈
 *
 * 原代码对非 `LlmError` 只记 `{ message: errorChain(error), code: "UNKNOWN" }` —— **丢掉堆栈**，
 * 于是「本轮运行失败 <message>」在界面上无从定位。这里**只加一条 stderr 日志**，不改控制流。
 *
 * ## ② ★ `isOwned` 少了保护 —— 长期 flake 的真凶（2026-09-15 定案）
 *
 * `RuntimeContextProjection` 的构造函数**倒序遍历会话里所有 `user/message`** 并对每条调
 * `isOwned(event.data)`（见 `lib/index.js` 的 `eventsNewestFirst` 循环与 `session/event` 回调）。
 * ⇒ 任何一条**没有 `source` 的 user message** 都会让这里抛
 * `Cannot read properties of undefined (reading 'kind')`，
 * 被 agent-loop 捕获成 `turn/end` 的 `reason.error`（`code:"UNKNOWN"`）⇒ 界面显示「本轮运行失败」。
 *
 * **实测闭环**（扫全部会话日志）：出现该 flake 的会话 12 个，12 个都含"缺 `source` 的注入消息"；
 * 触发条件 = **交接时注入** + 之后**开了新轮次**（重建投影）。
 * 我们源头那半边已修（`packages/switchboard/src/index.ts` 的 `injectedUserMessage` 带上 `id`/`source`），
 * 但**历史日志里的坏消息仍在** ⇒ 重放仍会崩。所以这里把 `isOwned` 也改成不假设 `source` 存在。
 *
 * ★★ 2026-10-07 大段重写 ②（原先的定点锚已失效）：
 *   症状：postinstall 报 `★未命中 1 处 (isowned-guard)`（6 份实体全中），而 ① 照常。
 *   原因：**上游把 `isOwned` 的条件简化了** ——
 *     老：`return message.source.kind === "plugin" && message.source.plugin === SOURCE;`
 *     新：`return message.source.kind === SOURCE;`   （且 `SOURCE = "runtime-context"`）
 *   ⇒ 锚是逐字匹配的，条件一变就失配；而**上游下次再改还得再来一遍**。
 *   判断：**不修锚点，改成结构式重写** —— 在 `isOwned` 的**函数体内部**把 `message.source`
 *         换成 `message?.source`，**条件表达式原样保留**（不管它是几元、比较什么）。
 *   ⇒ 上游改条件、改常量，我们都不受影响；只有"函数没了"才判红。
 *
 * 幂等；未命中即失败（走 `scripts/patch-anchors.mjs` 的三态判定）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { applyAnchors, reportAndExit, resolveEntities } from './patch-anchors.mjs'

const PATHS = resolveEntities('@deepseek-ai/dsh-agent-loop')
const BACKUP_DIR = 'C:/Users/Admin/.dsh/.backup'

const MARK_STACK = '[dsh-brain/agent-loop] non-LLM turn error'
const MARK_ISOWNED = 'dsh-brain patch (isOwned guard)'

// ── ① 非 LLM 错误的堆栈（锚点仍有效，保持不动）────────────────────────────────
const ANCHOR_STACK = `			turnEnds = {
				kind: "error",
				error: error instanceof LlmError ? error.failure : {
					message: errorChain(error),
					code: "UNKNOWN"
				}
			};`

const REPLACE_STACK = `			// dsh-brain patch (2026-09-15, scripts/patch-agent-loop-hardening.mjs):
			// 非 LlmError 的回合失败原本只记 { message, code: "UNKNOWN" } —— **丢掉堆栈**，
			// 于是"本轮运行失败 <message>"在界面上无从定位。这里把完整堆栈落到 stderr
			// （进 gen 的 boot.log / run 日志）。**只加日志，不改控制流。**
			if (!(error instanceof LlmError)) {
				try {
					console.error("${MARK_STACK}:\\n" + (error && error.stack ? error.stack : String(error)));
				} catch {
					/* 记日志本身绝不能影响错误处理 */
				}
			}
${ANCHOR_STACK}`

const EDITS = [
  { id: 'log-non-llm-error-stack', anchor: ANCHOR_STACK, replace: REPLACE_STACK, done: MARK_STACK },
]

// ── ② 结构式重写：isOwned 函数体内 message.source → message?.source ───────────
const FN_HEAD = 'function isOwned(message) {'
const GUARD_COMMENT = `\t// ${MARK_ISOWNED} (2026-09-15, 2026-10-07 改为结构式重写):
\t// 原实现直接读 message.source.kind，只要会话里存在一条**没有 source 的 user message**
\t// （历史日志里有 —— 由别处注入且缺字段），RuntimeContextProjection 倒序遍历时就会抛
\t// "Cannot read properties of undefined (reading 'kind')"，被捕获成 turn 错误
\t// （UI 显示"本轮运行失败"）。实测：出现该错误的 12 个会话 100% 都含这种消息。
\t// 这里不假设 source 存在 —— 对"不是自己的消息"本来也该是 false。
`

/** 从 `{` 出发找配对的 `}`（忽略字符串/模板/注释里的括号） */
function matchBrace(text, open) {
  let depth = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (lineComment) { if (c === '\n') lineComment = false; continue }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++ } continue }
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue }
    if (c === '/' && n === '*') { blockComment = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 返回该文件上 ② 的三态增量 */
function applyIsOwnedGuard(file) {
  const out = { applied: [], already: [], missing: [] }
  if (!fs.existsSync(file)) return out
  let text = fs.readFileSync(file, 'utf8')
  if (text === '') return out

  if (text.includes(MARK_ISOWNED)) { out.already.push('isowned-guard'); return out }

  const head = text.indexOf(FN_HEAD)
  if (head < 0) { out.missing.push('isowned-guard(未找到 isOwned 函数)'); return out }
  const openBrace = text.indexOf('{', head + FN_HEAD.length - 1)
  const closeBrace = matchBrace(text, openBrace)
  if (closeBrace < 0) { out.missing.push('isowned-guard(函数体括号不配对)'); return out }

  const body = text.slice(openBrace + 1, closeBrace)
  if (!body.includes('message.source')) {
    // 上游已经自己防护了（例如 message?.source），或条件不再读 source
    if (body.includes('message?.source')) { out.already.push('isowned-guard(上游已自带可选链)'); return out }
    out.missing.push('isowned-guard(函数体里没有 message.source)')
    return out
  }

  // ★ 只把 `message.source` 变成 `message?.source`，**条件表达式其余部分原样保留**
  const newBody = GUARD_COMMENT + body.replace(/\bmessage\.source\b/g, 'message?.source')
  text = text.slice(0, openBrace + 1) + newBody + text.slice(closeBrace)
  fs.writeFileSync(file, text, 'utf8')
  out.applied.push('isowned-guard')
  return out
}

// 先备份（按 realpath 去重：两个路径常是同一文件）
const seen = new Set()
for (const p of PATHS) {
  if (!fs.existsSync(p)) continue
  let real = p
  try { real = fs.realpathSync(p) } catch { /* 用原路径 */ }
  if (seen.has(real)) continue
  seen.add(real)
  const text = fs.readFileSync(p, 'utf8')
  if (text.includes(MARK_STACK) && text.includes(MARK_ISOWNED)) continue
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = path.join(BACKUP_DIR, `dsh-agent-loop.index.js.${stamp}.bak`)
  fs.copyFileSync(p, bak)
  console.log(`已备份 → .backup/${path.basename(bak)}`)
}

const results = PATHS.map((p) => {
  const r = applyAnchors(p, EDITS)
  const g = applyIsOwnedGuard(p)
  return {
    ...r,
    applied: [...r.applied, ...g.applied],
    already: [...r.already, ...g.already],
    missing: [...r.missing, ...g.missing],
  }
})

reportAndExit('patch-agent-loop-hardening', results)
