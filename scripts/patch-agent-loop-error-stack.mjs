#!/usr/bin/env node
/**
 * patch-agent-loop-error-stack.mjs —— 让"非 LLM 回合错误"**留下堆栈**
 *
 * ## 为什么需要（2026-09-15，一个长期未破的 flake）
 *
 * 用户长期看到会话出现「本轮运行失败 `Cannot read properties of undefined (reading 'kind')`」
 * 且 `UNKNOWN`，发生在蓝绿交接附近，**一直没查出为什么**。
 *
 * 已排查掉的：`turn/end` 的 `reason` 不是元凶 —— 上游 `dsh-agent-loop` 自己就有兜底
 * `reason: turnEnds ?? { kind: "completed" }`，且全库实测「缺 reason 的 turn/end = 0」。
 *
 * **卡在哪**：`dsh-agent-loop` 捕获回合内错误时，对**非 `LlmError`** 只记
 * `{ message: errorChain(error), code: "UNKNOWN" }` —— **丢掉堆栈**。
 * 于是 UI 只显示一句 message，无从知道是哪个 `.kind` 崩的。
 *
 * ## 做什么
 *
 * 在这一处**只加一条 stderr 日志**（含完整堆栈），**不改任何控制流**：
 * 出错仍照样走原来的 `turnEnds` / `throwError` 路径，只是日志里多一份可定位的证据。
 * 下次 flake 复现 ⇒ 去 gen 的 `boot.log` / run 日志里拿堆栈 ⇒ 直接定位。
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

const MARK = '[dsh-brain/agent-loop] non-LLM turn error'

// 锚点：整段是唯一的（`message: errorChain(error),` 在全文件只出现一次）
const ANCHOR = `			turnEnds = {
				kind: "error",
				error: error instanceof LlmError ? error.failure : {
					message: errorChain(error),
					code: "UNKNOWN"
				}
			};`

const REPLACE = `			// dsh-brain patch (2026-09-15, scripts/patch-agent-loop-error-stack.mjs):
			// 非 LlmError 的回合失败原本只记 { message, code: "UNKNOWN" } —— **丢掉堆栈**，
			// 于是"本轮运行失败 <message>"在界面上无从定位。这里把完整堆栈落到 stderr
			// （进 gen 的 boot.log / run 日志）。**只加日志，不改控制流。**
			if (!(error instanceof LlmError)) {
				try {
					console.error("${MARK}:\\n" + (error && error.stack ? error.stack : String(error)));
				} catch {
					/* 记日志本身绝不能影响错误处理 */
				}
			}
${ANCHOR}`

const EDITS = [{ id: 'log-non-llm-error-stack', anchor: ANCHOR, replace: REPLACE, done: MARK }]

// 先备份（node_modules 不在 git 里，改坏了不好回退）
// ★ 按 realpath 去重：PATHS 里两个路径常是同一文件（profiles 侧是 junction），
//   不去重会为同一份内容存两次备份（.backup 立刻堆垃圾）。
const seen = new Set()
for (const p of PATHS) {
  if (!fs.existsSync(p)) continue
  let real = p
  try { real = fs.realpathSync(p) } catch { /* 用原路径 */ }
  if (seen.has(real)) continue
  seen.add(real)
  const text = fs.readFileSync(p, 'utf8')
  if (text.includes(MARK)) continue
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = path.join(BACKUP_DIR, `dsh-agent-loop.index.js.${stamp}.bak`)
  fs.copyFileSync(p, bak)
  console.log(`已备份 → .backup/${path.basename(bak)}`)
}

reportAndExit('patch-agent-loop-error-stack', PATHS.map((p) => applyAnchors(p, EDITS)))
