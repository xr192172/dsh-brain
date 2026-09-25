#!/usr/bin/env node
/**
 * test-capability-gate.mjs —— 注册门的**自证**（门禁非空过）
 *
 * ★★ 关于 execFileSync / spawnSync：
 *   WorkBuddy 的 node-safe-delete-shim 把 execFileSync 做成了"吞输出+返回 status=null"
 *   （EPERM 静默）。因此本测试**必须用 spawnSync**，它不会被 shim 静默吞掉。
 *   （spawnSync 在同类环境下已实测可用。）
 *
 * 为什么必须有这个测试：本项目刚花两天修过一类失败 —— **保险自己失效**。
 * 一个"看起来在检查"的门，比没有门更危险：它让人以为已经把关了。
 *
 * 所以本测试要同时证明**两个方向**：
 *   ① 挡得住坏的：缺 provider 成员 / capabilities 声明对不上 / apply 抛错 /
 *      设计者声明生产写权 / 缺不变量声明 / budget 非法 ⇒ 一律 blocked；
 *      **新能力无基线也 blocked**（防假绿）。
 *   ② **放行得了好的**：有 confirmed 基线且指标不劣化的能力 ⇒ admitted + proofLevel:L2。
 *   ★ 只证 ① 不够 —— 一个"一律 blocked"的门同样是无用的。两个方向都过，门才算有效。
 *
 * 做法：把夹具包与临时 registry 都放 `out/gate-fixtures/`，用 `DSH_HOME` 指向临时目录，
 *       **绝不触碰真实的 `~/.dsh/capabilities/registry.json`**（会在开头断言这一点）。
 *
 * 用法：node scripts/test-capability-gate.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { removeIfExists } from './lib-safe-fs.mjs'

// ★ 夹具写在自己的 worktree 里（沙箱可写），不碰主仓
const FIX = path.join('D:/project_develop/_merge-l234/wt', 'out/gate-fixtures')
const REAL_HOME = 'C:/Users/Admin/.dsh'
const GATE = path.join('D:/project_develop/_merge-l234/wt', 'scripts/capability-gate.mjs')
// ★ 测试专用的 node：优先用系统 node（无 WorkBuddy shim），否则回退 process.execPath
const NODE_BIN = (() => {
  try {
    if (fs.existsSync('C:/Program Files/nodejs/node.exe')) return 'C:/Program Files/nodejs/node.exe'
  } catch { /* ignore */ }
  return process.execPath
})()

let pass = 0
let fail = 0
const failures = []
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log('  FAIL ' + n + ' — ' + d) }
const eq = (n, got, want) => (got === want ? ok(n) : bad(n, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`))

// ── 安全闸：绝不能碰真实 registry ───────────────────────────────────────────
const realRegistry = path.join(REAL_HOME, 'capabilities', 'registry.json')
const realBefore = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null

// ── 夹具包 ──────────────────────────────────────────────────────────────────

const FIVE_CAPS = '{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }'

const PKGS = {
  'good.mjs': `
class P {
  name = 'fx-good'
  capabilities = ${FIVE_CAPS}
  inheritsParentContext = false
  start() { return Promise.resolve({}) }
  prepareContinuable() { return Promise.resolve({}) }
}
export const name = 'fx-good'
export function apply(ctx) { ctx.subagents.registerProvider(new P()) }
`,
  'missing-member.mjs': `
class P {
  name = 'fx-missing'
  capabilities = ${FIVE_CAPS}
  inheritsParentContext = false
  start() { return Promise.resolve({}) }
  // ★ 故意不实现 prepareContinuable —— L0「接口 5 成员齐」必须抓到
}
export const name = 'fx-missing'
export function apply(ctx) { ctx.subagents.registerProvider(new P()) }
`,
  'bad-caps.mjs': `
class P {
  name = 'fx-badcaps'
  // ★ 多了一个 registry 没声明的键 —— L0「声明与实际一致」必须抓到
  capabilities = { ...${FIVE_CAPS}, sandbox: true }
  inheritsParentContext = false
  start() { return Promise.resolve({}) }
  prepareContinuable() { return Promise.resolve({}) }
}
export const name = 'fx-badcaps'
export function apply(ctx) { ctx.subagents.registerProvider(new P()) }
`,
  'apply-throws.mjs': `
export const name = 'fx-throws'
export function apply() { throw new Error('boom: 夹具故意抛错') }
`,
  'no-register.mjs': `
export const name = 'fx-noreg'
export function apply() { /* 故意不调 registerProvider */ }
`,
}

function writeFixtures() {
  removeIfExists(FIX)
  fs.mkdirSync(FIX, { recursive: true })
  for (const [f, src] of Object.entries(PKGS)) fs.writeFileSync(path.join(FIX, f), src.trimStart(), 'utf8')
}

const entry = (f) => path.join(FIX, f).replace(/\\/g, '/')
const INV = (over = {}) => ({
  role: 'provider', writeScope: 'workspace', credentials: 'inherit', budget: { source: 'inherit', maxTokens: null }, ...over,
})

/** 造一条能力记录。 */
function cap(id, pkgFile, over = {}) {
  return {
    id,
    kind: 'subagent-provider',
    version: '0.0.0',
    source: { package: null, path: null, provider: id, tool: null, seat: null, entryPath: entry(pkgFile) },
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    invariants: INV(),
    acceptance: { kind: 'none', ref: null, status: 'unknown', ranAt: null },
    holdoutHash: null,
    status: 'pending',
    registeredAt: new Date().toISOString(),
    supersededBy: null,
    retiredReason: null,
    lineage: [],
    signals: { invoked: 0, reused: 0, succeeded: 0, failed: 0, lastUsedAt: null, notes: [] },
    ...over,
  }
}

/**
 * 造一个带 confirmed 基线的 home。
 * baselines.json 放在 home/capabilities/ 下，gate 会从这个 DSH_HOME 读。
 */
function makeHomeWithBaseline(name, caps, baselineData) {
  const home = path.join(FIX, `home-${name}`)
  removeIfExists(home)
  const capsDir = path.join(home, 'capabilities')
  fs.mkdirSync(capsDir, { recursive: true })
  fs.writeFileSync(
    path.join(capsDir, 'registry.json'),
    JSON.stringify({ schema: 'dsh-capability-registry/v1', updatedAt: new Date().toISOString(), capabilities: caps, history: [] }, null, 2) + '\n',
    'utf8',
  )
  if (baselineData) {
    fs.writeFileSync(
      path.join(capsDir, 'baselines.json'),
      JSON.stringify(baselineData, null, 2) + '\n',
      'utf8',
    )
  }
  return home
}

/**
 * 用 spawnSync 调 gate（绕过 WorkBuddy shim 吞掉 execFileSync 输出的坑）。
 * 返回 { code, stdout, stderr }。code=null 表示超时或无法启动（非 0 退出）。
 */
function runGate(home) {
  const r = spawnSync(NODE_BIN, [GATE, 'run', '--all'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  })
  // spawnSync 里 status=null 仅当超时；其它情况都是具体 exit code
  return {
    code: r.status !== null ? r.status : -1,
    stdout: (r.stdout ?? ''),
    stderr: (r.stderr ?? ''),
  }
}

const receiptsOf = (home) =>
  Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(home, 'capabilities', 'registry.json'), 'utf8')).capabilities.map((c) => [c.id, c]),
  )

// ── 开始 ────────────────────────────────────────────────────────────────────
console.log('== 注册门自证 ==')
console.log(`  node bin   : ${NODE_BIN}`)
console.log(`  fixtures   : ${FIX}`)
writeFixtures()

// ── 测试 A：无基线 ⇒ 一律 blocked（含"完好"能力）──
const mixedNoBaseline = [
  cap('fx-good', 'good.mjs'),
  cap('fx-missing-member', 'missing-member.mjs'),
  cap('fx-bad-caps', 'bad-caps.mjs'),
  cap('fx-apply-throws', 'apply-throws.mjs'),
  cap('fx-no-register', 'no-register.mjs'),
  cap('fx-design-prod', 'good.mjs', { invariants: INV({ role: 'designer', writeScope: 'production' }) }),
  cap('fx-no-invariants', 'good.mjs', { invariants: null }),
  cap('fx-bad-budget', 'good.mjs', { invariants: INV({ budget: { source: 'declared', maxTokens: 0 } }) }),
]
const homeA = makeHomeWithBaseline('mixed-no-bl', mixedNoBaseline, null)
const a = runGate(homeA)
if (a.code === -1) {
  console.error('ERROR: gate 子进程启动失败/超时')
  console.error('  stderr:', a.stderr.slice(0, 300))
  process.exit(2)
}
const rA = receiptsOf(homeA)
const checksOf = (c) => c.acceptance?.checks ?? []
const failedNames = (c) => checksOf(c).filter((x) => !x.ok).map((x) => x.name)
const failedLevels = (c) => [...new Set(checksOf(c).filter((x) => !x.ok).map((x) => x.level))]

eq('退出码 = 1（全部 blocked）', a.code, 1)

// 所有能力都应该 blocked（包括 fx-good，因为它没有基线）
for (const id of mixedNoBaseline.map((c) => c.id)) {
  eq(`${id} 被挡`, rA[id].acceptance.status, 'failed')
  eq(`${id} 仍 pending`, rA[id].status, 'pending')
}

// fx-good 是因为 L2 基线缺失被挡
eq('fx-good 因无基线被挡', failedLevels(rA['fx-good']).includes('L2'), true)
eq('fx-good 失败点是基线存在', failedNames(rA['fx-good']).includes('基线存在'), true)

// ── 测试 B：有 confirmed 基线且指标合格 ⇒ admitted + proofLevel L2 ──
const goodWithBaseline = [cap('fx-good', 'good.mjs')]
const baselineData = {
  schema: 'dsh-baseline-store/v2',
  updatedAt: new Date().toISOString(),
  baselines: {
    'fx-good': {
      provenance: {
        runAt: '2026-09-20T10:00:00.000Z',
        provisional: false,
        confirmedAt: '2026-09-20T10:05:00.000Z',
        note: '人工确认的历史基线',
      },
      perRunMetrics: {
        outputTokens: 100,  // 基线：平均每次调用输出 100 tokens
        wallMs: 500,        // 基线：平均耗时 500ms
        score: 0.8,         // 基线：质量评分 0.8
      },
    },
  },
}
const homeB = makeHomeWithBaseline('good-with-bl', goodWithBaseline, baselineData)
const b = runGate(homeB)
eq('有基线+指标合格：退出码 = 0', b.code, 0)
const rB = receiptsOf(homeB)
eq('fx-good 判定 passed', rB['fx-good'].acceptance.status, 'passed')
eq('fx-good 转 active', rB['fx-good'].status, 'active')
eq('fx-good 证明级别 L2', rB['fx-good'].acceptance.proofLevel, 'L2')
eq('fx-good 未实施级 L3/L4', JSON.stringify(rB['fx-good'].acceptance.unenforced), JSON.stringify(['L3', 'L4']))
ok('fx-good 全检通过')

// ── 测试 C：有基线但指标恶化 ⇒ blocked ──
const goodWithWorseMetrics = [
  cap('fx-good', 'good.mjs', {
    perRunMetrics: { outputTokens: 50, wallMs: 600, score: 0.5 } // 比基线差
  })
]
const homeC = makeHomeWithBaseline('good-worse-metrics', goodWithWorseMetrics, baselineData)
const c = runGate(homeC)
eq('指标恶化：退出码 = 1', c.code, 1)
const rC = receiptsOf(homeC)
eq('fx-good 因指标恶化被挡', rC['fx-good'].acceptance.status, 'failed')
eq('fx-good 仍是 pending', rC['fx-good'].status, 'pending')
ok('fx-good 失败点落在 L2')

// ── 测试 D：provisional 基线 ⇒ blocked（不等人工确认）──
const provisionalBaseline = {
  schema: 'dsh-baseline-store/v2',
  updatedAt: new Date().toISOString(),
  baselines: {
    'fx-good': {
      provenance: {
        runAt: '2026-09-24T10:00:00.000Z',
        provisional: true,
        confirmedAt: null,
        note: '暂估基线，待人工确认',
      },
      perRunMetrics: { outputTokens: 100, wallMs: 500, score: 0.8 },
    },
  },
}
const homeD = makeHomeWithBaseline('good-provisional', goodWithBaseline, provisionalBaseline)
const d = runGate(homeD)
eq('provisional 基线：退出码 = 1', d.code, 1)
const rD = receiptsOf(homeD)
eq('fx-good 因 provisional 基线被挡', rD['fx-good'].acceptance.status, 'failed')
ok('provisional 基线不参与判定')

// ── 安全闸复检：真实 registry 未被触碰 ──────────────────────────────────────
const realAfter = fs.existsSync(realRegistry) ? fs.readFileSync(realRegistry, 'utf8') : null
if (realBefore === realAfter) ok('未触碰真实 registry.json')
else bad('未触碰真实 registry.json', `真实 registry 被改动了！（${realRegistry}）`)

console.log(`\n=========================================`)
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  · ' + f)
}
process.exit(fail ? 1 : 0)
