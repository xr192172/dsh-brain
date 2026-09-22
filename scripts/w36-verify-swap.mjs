#!/usr/bin/env node
/**
 * w36-verify-swap.mjs —— 换代（tool_apply）前的 **verify 闸**。
 *
 * 由控制面（coordinator.runVerifyGate）在 flip 之前执行：
 *   - 经 `tool_apply(verify=<本脚本绝对路径>)` 提交 ⇒ 控制面先跑本脚本，
 *     stdout 首个以 `{` 开头的行必须能被 JSON.parse 且 `ok===true`，才正式 flip；
 *     否则判定 verify-gate 失败 ⇒ 回滚旧代（见 coordinator.ts:481-490, 568-637）。
 *   - 本脚本自身**任一条判据不过 ⇒ 非零退出**（保险不靠调用方读 stdout 判断）。
 *
 * 判据（三条，全部为"必须为真"）：
 *   A. 静态自证①：node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js 里确有
 *      `ctx.sandbox.confine(...)` 调用（stdio MCP server 的 spawn 过沙箱 seam）。
 *   B. 静态自证②：packages/design-canvas-bridge/ 的**编译产物**里确有 `FS_SANDBOX_DENIED`
 *      （三条写工具在调内核之前的哨兵 fence 以该错误码判定）。
 *   C. 回归：`node scripts/gate-vector-run.mjs --impl <out/gatecheck.exe>` 必须 **16/16 PASS**。
 *
 * 刻意**不**放进本脚本的（需真会话、太重，见报告 §④）：行为级复验
 *   （旁路被拒 / 工作区写成功 / shell 未回退）。
 *
 * 用法：node scripts/w36-verify-swap.mjs
 * 退出码：0 = 全过；1 = 有判据不过。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = 'D:/project_develop/dsh-brain'
const HERE = dirname(fileURLToPath(import.meta.url))
// 以脚本自身位置反推仓库根（scripts/ 的上一级），避免写死路径在别处跑错。
const REPO = join(HERE, '..')

const MCP_LIB = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js')
const DCB_LIB = join(REPO, 'packages', 'design-canvas-bridge', 'lib', 'index.js')
const GATE_RUNNER = join(REPO, 'scripts', 'gate-vector-run.mjs')
const GATECHECK = join(REPO, 'out', 'gatecheck.exe')

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
}

function readText(path, label) {
  if (!existsSync(path)) throw new Error(label + ' 不存在：' + path)
  return readFileSync(path, 'utf8')
}

// ── A. 静态自证①：mcp-client 的 stdio spawn 过沙箱 seam ────────────────────
try {
  const src = readText(MCP_LIB, 'mcp-client lib/index.js')
  // 必须真出现一次 `ctx.sandbox.confine(` 调用（不是注释、不是仅 import）。
  const callCount = (src.match(/ctx\.sandbox\.confine\s*\(/g) ?? []).length
  const hasFn = /function\s+confineStdioArgv\s*\(/.test(src)
  const ok = callCount >= 1 && hasFn
  record(
    'A: mcp-client 调用的确是 ctx.sandbox.confine',
    ok,
    `ctx.sandbox.confine( 出现 ${callCount} 次；confineStdioArgv 定义=${hasFn}；file=${MCP_LIB}`,
  )
} catch (e) {
  record('A: mcp-client 调用的确是 ctx.sandbox.confine', false, String(e && e.message ? e.message : e))
}

// ── B. 静态自证②：design-canvas-bridge 编译产物含 FS_SANDBOX_DENIED ────────
try {
  const out = readText(DCB_LIB, 'design-canvas-bridge lib/index.js')
  const deniedCount = (out.match(/FS_SANDBOX_DENIED/g) ?? []).length
  // 补强（不替代）：fence 实现与三条写工具的调用点都要在编译产物里。
  const fenceFn = (out.match(/function\s+fenceThroughFsSeam\s*\(/g) ?? []).length
  const fenceCalls = (out.match(/await\s+fenceThroughFsSeam\s*\(/g) ?? []).length
  const ok = deniedCount >= 1 && fenceFn >= 1 && fenceCalls >= 3
  record(
    'B: design-canvas-bridge 编译产物含 FS_SANDBOX_DENIED + 3 处 fence',
    ok,
    `FS_SANDBOX_DENIED×${deniedCount}；fenceThroughFsSeam 定义=${fenceFn}；调用点=${fenceCalls}（期望 3）；file=${DCB_LIB}`,
  )
} catch (e) {
  record('B: design-canvas-bridge 编译产物含 FS_SANDBOX_DENIED + 3 处 fence', false, String(e && e.message ? e.message : e))
}

// ── C. 回归：gate-vector-run 必须 16/16 PASS ──────────────────────────────
try {
  if (!existsSync(GATE_RUNNER)) throw new Error('gate-vector-run.mjs 不存在：' + GATE_RUNNER)
  if (!existsSync(GATECHECK)) throw new Error('gatecheck.exe 不存在：' + GATECHECK)
  const r = spawnSync(process.execPath, [GATE_RUNNER, '--impl', GATECHECK], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const so = r.stdout ?? ''
  const se = r.stderr ?? ''
  // 原始输出落盘（证据）
  try {
    mkdirSync(join(REPO, 'out'), { recursive: true })
    writeFileSync(join(REPO, 'out', 'w36-verify-gate-vector.txt'), so + se, 'utf8')
  } catch {
    /* 落盘失败不影响判据 */
  }
  const allPass = /16\/16 PASS/.test(so)
  const zeroFail = /0 FAIL/.test(so) && /0 NEEDS-EVIDENCE/.test(so)
  const ok = r.status === 0 && allPass && zeroFail
  record(
    'C: gate-vector-run 16/16 PASS（exit 0）',
    ok,
    `exit=${r.status}；含"16/16 PASS"=${allPass}；0 FAIL/0 NEEDS-EVIDENCE=${zeroFail}`,
  )
} catch (e) {
  record('C: gate-vector-run 16/16 PASS（exit 0）', false, String(e && e.message ? e.message : e))
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
const ok = failed.length === 0
console.log('[w36-verify-swap] 换代前 verify 闸 —— 判据明细：')
for (const r of results) console.log(`  ${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}\n         ${r.detail}`)
console.log(`[w36-verify-swap] 合计 ${results.length - failed.length}/${results.length} PASS ⇒ ${ok ? '放行 flip' : '拒绝 flip（控制面应回滚）'}`)
// 控制面只认 stdout 首个以 `{` 开头的行 ⇒ 这一行必须是唯一的 JSON 行。
console.log(
  JSON.stringify({
    ok,
    reason: ok ? 'static:mcp-client-confine + static:dcb-FS_SANDBOX_DENIED + regression:gate-16/16' : 'failed: ' + failed.map((f) => f.name).join(' | '),
    checks: results.map((r) => ({ name: r.name, ok: r.ok })),
  }),
)

process.exit(ok ? 0 : 1)
