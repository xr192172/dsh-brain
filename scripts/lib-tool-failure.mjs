#!/usr/bin/env node
/**
 * lib-tool-failure.mjs —— ★「工具失败」的可信判据（替掉被污染的 `tool/result.isError`）
 *
 * ## 为什么需要它（回执 `docs/receipt-to-main-2026-09-20.md` §B1）
 *
 * 实测（`~/.dsh/sessions` 全量 9775 条 `tool/result`，2026-09-21 扫）：
 *
 *   - 按结构信号判红的 **1329 条**真失败里，**1253 条（94.3%）的 `isError` 是 `false`**；
 *     今日（2026-09-20，即回执 B1 的证据日）425 条里判红 53 条，**48 条（91%）isError=false**。
 *   - 尤其 **shell 工具（`pwsh`）从不把执行失败标成 `isError=true`**
 *     （失败一律走 `[stderr] …` / `[exit code: N]` 两条通道）。
 *
 * ⇒ 拿 `isError` 当"工具失败率" ⇒ 漏掉九成以上的真失败（**假绿**）。
 *   这是比回执里"恒为 false"更精确的刻画：`isError` 在 `write`/`edit`/`run_code` 上其实有用，
 *   只是**对 shell 工具完全不工作**，而 shell 恰是靶场失败最集中的地方。
 *
 * ## 判据为什么不用"宽关键词"
 *
 * 靶场现在用的宽启发式（`/\[stderr\]|运行失败|cannot find|denied|timed out|…/i`）实测：
 *   判红 820 条 —— 其中 **326 条是假红**（成功输出里正文恰好含 "denied"/"timed out" 等词，
 *   典型是 `read` 读回源码文件），同时又**漏掉 835 条真失败**（无关键词但有 `[exit code: N]`）。
 * ⇒ 既偏宽又偏漏。本判据只认**结构信号**，不做裸关键词匹配。
 *
 * ## 判据（结构信号，命中任一即判红）
 *
 *   R1 `stderr-payload`   结果以 `[stderr]` 开头（stderr 通道有载荷）
 *   R2 `exit-nonzero`     文本**末尾**是 `[exit code: N]` 且 N != 0
 *                         （锚定末尾：实测 97.2% 贴在结尾，其余紧跟 `(Omitted …)` 溢出提示；
 *                          不锚定的话，`read` 读回"内含失败日志的文件"会被假红 —— 真出现过 2 次）
 *   R3 `ps-error-record`  含 PowerShell 错误记录骨架 `At line:N char:N`
 *   R4 `error-header`     行首 `Error|Exception|Fatal|ResourceUnavailable:` 且带堆栈（` at …`）
 *   R5 `harness-reject`   `isError === true` 且非中断（如 `write` 的前置校验）
 *
 * **单独计数、不算"工具失败"**：`isError === true` 且文案是 "was interrupted" ⇒
 * `interrupted: true` / `failed: false`（工具没跑成 ≠ 工具跑失败；
 * 靶场的 `toolFailures` 与"中断率"应分开报）。
 *
 * **已知边界（如实标注）**：判据只看结果的**第 1 层文本**。若成功工具读回的文件内容里
 * 恰好嵌着 `[stderr]` 或 `At line:`（"第 2 层文本"），仍会假红。R2 已锚定末尾来挡这一类，
 * 但 R1/R3 没有 ⇒ 风险仍存在（当前全量 9775 条里实测 0 条残留）。彻底解法是按 `tool` 分流。
 *
 * ## 用法
 *
 *   import { classifyToolResult, isToolFailure } from './lib-tool-failure.mjs'
 *   classifyToolResult(text, { isError })      // → { failed, rule, interrupted }
 *   isToolFailure(toolResultEvent)             // 直接喂一条 session 的 tool/result 事件
 *
 *   自证： node scripts/lib-tool-failure.mjs --self-test
 *
 * 自证两方向（夹具全部取自真实会话，非杜撰）：
 *   · 红向：真失败夹具 + 全量里"含 `[stderr]` 段"的结果 ⇒ 判红率必须 100%
 *   · 绿向：真成功夹具（含宽启发式会误判的那些）+ `read` 的正常文件输出 ⇒ 判红率必须 0%
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decompress } from 'fzstd'

/** 会话根（只读；运行数据，永不写入） */
export const SESSION_ROOT = 'C:/Users/Admin/.dsh/sessions'

/** 判据规则表。顺序 = 报告优先级。 */
export const RULES = [
  { id: 'R1', name: 'stderr-payload', re: /^\s*\[stderr\]/m },
  { id: 'R2', name: 'exit-nonzero', re: /\[exit code:\s*([1-9]\d*)\]\s*(?:\(Omitted[^\n]*\))?\s*$/ },
  { id: 'R3', name: 'ps-error-record', re: /At line:\d+ char:\d+/ },
  { id: 'R4', name: 'error-header', re: /^\s*(Error|Exception|Fatal|ResourceUnavailable)\s*:[^\n]*(\n|[\s\S]{0,400}?\bat\s+\S)/m },
]

/** harness 层的"没跑成"文案（不是工具失败，单独归类） */
const INTERRUPTED_RE = /was interrupted|no result was durably recorded/i

/**
 * 判定一条工具结果。
 * @param {string} text 结果文本（`tool/result` 的 content 拼接）
 * @param {{isError?: boolean|null, tool?: string}} [opts]
 * @returns {{failed: boolean, rule: string|null, interrupted: boolean, isError: boolean}}
 */
export function classifyToolResult(text, opts = {}) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  const isError = opts.isError === true
  // 中断 = harness 没把这次调用记下来 ⇒ 不是"工具跑了但失败"，单独归类、不计入工具失败
  if (isError && INTERRUPTED_RE.test(s)) return { failed: false, rule: null, interrupted: true, isError }
  for (const r of RULES) {
    if (r.re.test(s)) return { failed: true, rule: r.id, interrupted: false, isError }
  }
  // isError=true 但没撞上任何结构规则：仍是失败（如 write 的前置校验），只是没有结构坐标
  if (isError) return { failed: true, rule: 'R5', interrupted: false, isError }
  return { failed: false, rule: null, interrupted: false, isError: false }
}

/** 从一条 session 事件里取出结果文本（与 eval-run.mjs 的形状一致） */
export function resultTextOf(ev) {
  const c0 = ev?.data?.message?.content?.[0]
  if (Array.isArray(c0?.content)) return c0.content.map((x) => x?.text ?? '').join('')
  return String(c0?.content ?? c0?.text ?? '')
}

/** 直接判一条 `tool/result` 事件 */
export function isToolFailure(ev) {
  return classifyToolResult(resultTextOf(ev), { isError: ev?.data?.message?.content?.[0]?.isError === true })
}

// ─────────────────────────── 夹具（全部取自真实会话，2026-09-21 抽样） ───────────────────────────

/** 红向：真失败 —— 判据必须判红 */
export const RED_FIXTURES = [
  { why: 'shell: 路径不存在', text: "[stderr]\r\nGet-ChildItem : Cannot find path 'D:\\project_develop\\dsh-brain\\apps\\' because it does not exist.\r\nAt line:1 char:129" },
  { why: 'shell: 权限被拒', text: "[stderr]\r\nGet-ChildItem : Access to the path 'D:\\project_develop\\cross-border-scout\\.pytest_cache' is denied.\r\nAt line:1 char:129" },
  { why: 'shell: 静默非零退出', text: '(no output)\n[exit code: 1]' },
  { why: 'shell: JSON 解析失败', text: "[stderr]\r\nConvertFrom-Json : Invalid object passed in, ':' or '}' expected. (1057): {\r\n  \"unit\": { \"name\": \"session_projcache\" }" },
  { why: 'B2 现场: stderr 未重定向崩溃', text: "[stderr]\nResourceUnavailable: 程序'node.exe'运行失败： StandardErrorEncoding is only supported when standard error is redirected.在 行:1 字符:129\r\n[exit code: 1]" },
  { why: 'run_code: 运行时异常 + 堆栈', text: 'Error: code run failed (exception): ReferenceError: require is not defined\n    at eval (eval at runWorkerMain (node:internal/process/execution:446:12)' },
  { why: 'write: 前置校验失败（isError=true）', text: 'Error: cannot overwrite existing "D:\\project_develop\\AGENTS.md" without reading it first', isError: true },
  { why: 'shell: 裸非零退出', text: '[exit code: 2]' },
]

/** 绿向：真成功 —— 判据必须判绿（★ 前 4 条宽启发式都会误判红） */
export const GREEN_FIXTURES = [
  { why: '正文含 "not found"（宽判据误判）', text: 'False\r\ndsh-llm not found\r\n' },
  { why: '表格输出，正文含 "denied"（宽判据误判）', text: '\r\nAccessControlType : Denied\r\nIdentityReference : BUILTIN\\Users\r\n' },
  { why: '源码文件正文含 "timed out"（宽判据误判）', text: '1: /** 超时保护 */\n2: const onTimeout = () => { /* timed out gracefully */ }\n' },
  { why: '日志正文含 "cannot find"（宽判据误判）', text: '2026-09-20 21:00:01 [info] probe: cannot find cache entry, falling back to disk\n' },
  { why: 'read 正常文件输出', text: '<path>D:\\project_develop\\dsh-brain\\scripts\\lib-safe-fs.mjs</path>\n<type>file</type>\n<content>\n1: import fs from \'node:fs\'\n' },
  { why: 'git log 正常输出', text: '8490ff5 feat(archify): 服务端演示端点\n51f2a3f feat(archify): IR↔Archify 投影契约\n' },
  { why: 'shell 表格输出', text: '\r\nCount     Sum\r\n-----     ---\r\n  259 4185199\r\n' },
  { why: 'harness 中断（不算工具失败）', text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.', isError: true },
]

// ─────────────────────────── 自证 ───────────────────────────

function scanSessions() {
  const rows = []
  for (const d of fs.readdirSync(SESSION_ROOT)) {
    const dd = path.join(SESSION_ROOT, d)
    if (!fs.statSync(dd).isDirectory()) continue
    for (const s of fs.readdirSync(dd)) {
      const f = path.join(dd, s, 'session.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      let text
      try { text = Buffer.from(decompress(fs.readFileSync(f))).toString('utf8') } catch { continue }
      const mtime = fs.statSync(f).mtimeMs
      const names = new Map()
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.type === 'tool/call') names.set(ev?.data?.callId, ev?.data?.name ?? '?')
        else if (ev.type === 'tool/result') {
          const c0 = ev?.data?.message?.content?.[0]
          rows.push({
            mtime,
            tool: names.get(c0?.toolCallId ?? ev?.data?.message?.source?.callId) ?? '?',
            isError: c0?.isError === true,
            text: resultTextOf(ev),
          })
        }
      }
    }
  }
  return rows
}

function selfTest() {
  const fails = []
  const ok = []
  const t = (cond, msg) => (cond ? ok : fails).push(msg)

  // —— 方向 1：真失败必须判红 ——
  for (const f of RED_FIXTURES) {
    const r = classifyToolResult(f.text, { isError: f.isError === true })
    t(r.failed, `红向 ✗ [${f.why}] 未判红（rule=${r.rule}）`)
  }
  // —— 方向 2：真成功必须判绿 ——
  for (const f of GREEN_FIXTURES) {
    const r = classifyToolResult(f.text, { isError: f.isError === true })
    t(!r.failed, `绿向 ✗ [${f.why}] 误判红（rule=${r.rule}）`)
  }
  // 中断类单独归类，不算工具失败
  const intr = classifyToolResult(GREEN_FIXTURES[GREEN_FIXTURES.length - 1].text, { isError: true })
  t(intr.interrupted === true && intr.failed === false, '归类 ✗ 中断类应 interrupted=true 且 failed=false')

  // —— 方向 1（全量）：含 [stderr] 段 ⇒ 100% 判红 ——
  let rows = []
  try { rows = scanSessions() } catch (e) { console.log('会话扫描跳过：' + e.message) }
  if (rows.length) {
    const stderrRows = rows.filter((r) => /^\s*\[stderr\]/m.test(r.text))
    const missed = stderrRows.filter((r) => !classifyToolResult(r.text, { isError: r.isError }).failed)
    t(missed.length === 0, `红向(全量) ✗ 含 [stderr] 的 ${stderrRows.length} 条里 ${missed.length} 条未判红`)

    // —— 方向 2（全量）：read 的正常文件输出 ⇒ 0% 判红 ——
    const goodRead = rows.filter((r) => r.tool === 'read' && !r.isError && r.text.startsWith('<path>') && r.text.includes('<type>file</type>'))
    const falseRed = goodRead.filter((r) => classifyToolResult(r.text, { isError: false }).failed)
    t(falseRed.length === 0, `绿向(全量) ✗ read 正常输出 ${goodRead.length} 条里 ${falseRed.length} 条误判红`)

    // —— 污染面统计 ——
    const judged = rows.map((r) => classifyToolResult(r.text, { isError: r.isError }))
    const red = judged.filter((x) => x.failed && x.rule !== 'R5')
    const today = '2026-09-20'
    const rowsToday = rows.filter((r) => new Date(r.mtime).toISOString().slice(0, 10) === today)
    const redToday = rowsToday.map((r) => classifyToolResult(r.text, { isError: r.isError })).filter((x) => x.failed && x.rule !== 'R5')
    console.log(`\n  今日(${today}) tool/result : ${rowsToday.length}`)
    console.log(`    判红 ${redToday.length} 条，其中 isError=false: ${redToday.filter((x) => !x.isError).length} (${(redToday.filter((x) => !x.isError).length / Math.max(1, redToday.length) * 100).toFixed(0)}%)`)
    const interrupted = judged.filter((x) => x.interrupted)
    const WIDE = /\[stderr\]|运行失败|找不到路径|cannot find|not recognized|is not defined|Traceback|ECONNREFUSED|EPERM|EACCES|denied|超时|timed out/i
    const wide = rows.filter((r) => WIDE.test(r.text))
    const wideFalse = wide.filter((r) => !classifyToolResult(r.text, { isError: r.isError }).failed)

    console.log('\n── 污染面（~/.dsh 全量 tool/result = ' + rows.length + '）──')
    console.log(`  isError=true            : ${judged.filter((x) => x.isError).length}（其中"中断/没跑成" ${interrupted.length}）`)
    console.log(`  本判据判红（结构信号）   : ${red.length}`)
    console.log(`  ★污染面 = 判红里 isError=false 的: ${red.filter((x) => !x.isError).length} / ${red.length} = ${(red.filter((x) => !x.isError).length / Math.max(1, red.length) * 100).toFixed(1)}%`)
    console.log(`    ⇒ 「工具失败率」若读 isError，会漏掉这个比例的真失败`)
    console.log(`  宽启发式判红            : ${wide.length}（假红 ${wideFalse.length}，漏判 ${red.length - (wide.length - wideFalse.length)}）`)
  }

  console.log('\n通过 ' + ok.length + ' / 失败 ' + fails.length)
  for (const f of fails) console.log('  ' + f)
  return fails.length === 0
}

/**
 * ★★ 只在"被当作主模块运行"时派发 CLI（与 `skill-sieve.mjs` 同形）。
 * 原守卫用 `startsWith('lib-tool-failure')` 是弱校验——被 import 方传 `--self-test`
 * 即可触发本文件 selftest + process.exit()，截断调用方。改用 canonical URL 比对。
 */
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
if (process.argv[1] && path.basename(process.argv[1]).startsWith('lib-tool-failure') && process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}
}
