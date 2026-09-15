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
 * ```js
 * function isOwned(message) {
 *   return message.source.kind === "plugin" && message.source.plugin === SOURCE;
 * }
 * ```
 *
 * `RuntimeContextProjection` 的构造函数（`lib/index.js:34-38`）**倒序遍历会话里所有
 * `user/message`** 并对每条调 `isOwned(event.data)`。
 * ⇒ 任何一条**没有 `source` 的 user message** 都会让这里抛
 * `Cannot read properties of undefined (reading 'kind')`，
 * 被 agent-loop 捕获成 `turn/end` 的 `reason.error`（`code:"UNKNOWN"`）⇒ 界面显示「本轮运行失败」。
 *
 * **实测闭环**（扫全部会话日志）：
 *   · 出现该 flake 的会话 **12 个**，**12 个**都含"缺 `source` 的注入消息"（100% 相关）
 *   · 触发条件：**交接时**注入（只有交接会注入）+ 之后**开了新轮次**（重建投影）
 *   · 这也解释了为什么"新会话没问题"、"一直查不出"（崩溃点离注入点隔了两个包，且无堆栈）
 *
 * 我们源头那半边已修（`packages/switchboard/src/index.ts` 的 `injectedUserMessage` 带上 `id`/`source`），
 * 但**历史日志里的坏消息仍在** ⇒ 重放仍会崩。所以这里把 `isOwned` 也改成不假设 `source` 存在。
 *
 * 幂等；锚点未命中即失败（走 `scripts/patch-anchors.mjs` 的三态判定）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { applyAnchors, reportAndExit } from './patch-anchors.mjs'

const PATHS = [
  'D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
  'C:/Users/Admin/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
]
const BACKUP_DIR = 'C:/Users/Admin/.dsh/.backup'

const MARK_STACK = '[dsh-brain/agent-loop] non-LLM turn error'
const MARK_ISOWNED = 'dsh-brain patch (isOwned guard)'

// ── ① 非 LLM 错误的堆栈 ─────────────────────────────────────────────────────
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

// ── ② isOwned 加上 source 保护 ───────────────────────────────────────────────
const ANCHOR_ISOWNED = `function isOwned(message) {
	return message.source.kind === "plugin" && message.source.plugin === SOURCE;
}`

const REPLACE_ISOWNED = `function isOwned(message) {
	// ${MARK_ISOWNED} (2026-09-15): 原实现直接读 message.source.kind，
	// 只要会话里存在一条**没有 source 的 user message**（历史日志里有 —— 由别处注入且缺字段），
	// RuntimeContextProjection 构造函数倒序遍历时就会抛
	// "Cannot read properties of undefined (reading 'kind')"，被捕获成 turn 错误
	// （UI 显示"本轮运行失败"）。实测：出现该错误的 12 个会话 100% 都含这种消息。
	// 这里不假设 source 存在 —— 对"不是自己的消息"本来也该是 false。
	return message?.source?.kind === "plugin" && message.source.plugin === SOURCE;
}`

const EDITS = [
  { id: 'log-non-llm-error-stack', anchor: ANCHOR_STACK, replace: REPLACE_STACK, done: MARK_STACK },
  { id: 'isowned-guard', anchor: ANCHOR_ISOWNED, replace: REPLACE_ISOWNED, done: MARK_ISOWNED },
]

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

reportAndExit('patch-agent-loop-hardening', PATHS.map((p) => applyAnchors(p, EDITS)))
