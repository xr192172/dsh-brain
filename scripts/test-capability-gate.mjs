#!/usr/bin/env node
/**
 * test-capability-gate.mjs —— 注册门的**自证**（门禁非空过）
 *
 * 为什么必须有这个测试：本项目刚花两天修过一类失败 —— **保险自己失效**。
 * 一个"看起来在检查"的门，比没有门更危险：它让人以为已经把关了。
 *
 * 所以本测试要同时证明**两个方向**：
 *   ① 挡得住坏的：缺 provider 成员 / capabilities 声明对不上 / apply 抛错 /
 *      设计者声明生产写权 / 缺不变量声明 / budget 非法 ⇒ 一律 blocked；
 *   ② **放行得了好的**：完好的能力 ⇒ admitted。
 *   ★ 只证 ① 不够 —— 一个"一律 blocked"的门同样是无用的。两个方向都过，门才算有效。
 *
 * 做法：把夹具包与临时 registry 都放 `out/gate-fixtures/`，用 `DSH_HOME` 指向临时目录，
 *       **绝不触碰真实的 `~/.dsh/capabilities/registry.json`**（会在开头断言这一点）。
 *
 * 用法：node scripts/test-capability-gate.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { removeIfExists } from './lib-safe-fs.mjs'

const REPO = 'D:/project_develop/dsh-brain'
const FIX = path.join(REPO, 'out/gate-fixtures')
const REAL_HOME = 'C:/Users/Admin/.dsh'
const GATE = path.join(REPO, 'scripts/capability-gate.mjs')

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
  fs.rmSync(FIX, { recursive: true, force: true })
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

function makeHome(name, caps) {
  const home = path.join(FIX, `home-${name}`)
  removeIfExists(home)
  fs.mkdirSync(path.join(home, 'capabilities'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'capabilities', 'registry.json'),
    JSON.stringify({ schema: 'dsh-capability-registry/v1', updatedAt: new Date().toISOString(), capabilities: caps, history: [] }, null, 2) + '\n',
    'utf8',
  )
  return home
}

function runGate(home) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, 'run', '--all'], {
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

const receiptsOf = (home) =>
  Object.fromEntries(
    JSON.parse(fs.readFileSync(path.join(home, 'capabilities', 'registry.json'), 'utf8')).capabilities.map((c) => [c.id, c]),
  )

// ── 开始 ────────────────────────────────────────────────────────────────────
console.log('== 注册门自证 ==')
writeFixtures()

// ① 挡得住坏的 + ② 放行得了好的（同一个 registry 里同时放，一次跑完）
const mixed = [
  cap('fx-good', 'good.mjs'),
  cap('fx-missing-member', 'missing-member.mjs'),
  cap('fx-bad-caps', 'bad-caps.mjs'),
  cap('fx-apply-throws', 'apply-throws.mjs'),
  cap('fx-no-register', 'no-register.mjs'),
  cap('fx-design-prod', 'good.mjs', { invariants: INV({ role: 'designer', writeScope: 'production' }) }),
  cap('fx-no-invariants', 'good.mjs', { invariants: null }),
  cap('fx-bad-budget', 'good.mjs', { invariants: INV({ budget: { source: 'declared', maxTokens: 0 } }) }),
]
const homeA = makeHome('mixed', mixed)
const a = runGate(homeA)
const rA = receiptsOf(homeA)
const checksOf = (c) => c.acceptance?.checks ?? []
const failedNames = (c) => checksOf(c).filter((x) => !x.ok).map((x) => x.name)
const failedLevels = (c) => [...new Set(checksOf(c).filter((x) => !x.ok).map((x) => x.level))]

eq('退出码 = 1（有 blocked）', a.code, 1)

// ② 正向：完好的必须放行
eq('fx-good 判定', rA['fx-good'].acceptance.status, 'passed')
eq('fx-good 转 active', rA['fx-good'].status, 'active')
eq('fx-good 证明级别', rA['fx-good'].acceptance.proofLevel, 'L1')

// ★ 未实施的级必须显式带出（防"假绿"）
eq(
  'fx-good 显式标注未实施级',
  JSON.stringify(rA['fx-good'].acceptance.unenforced),
  JSON.stringify(['L2', 'L3', 'L4']),
)

// ① 反向：六种坏法必须分别被挡，且**指名原因**
const expects = [
  ['fx-missing-member', 'L0', '接口 5 成员齐'],
  ['fx-bad-caps', 'L0', 'capabilities 声明与实际一致'],
  ['fx-apply-throws', 'L0', 'provider 能启动（apply 不抛错）'],
  ['fx-no-register', 'L0', 'provider 能启动（apply 不抛错）'],
  ['fx-design-prod', 'L1', '设计类角色不得有生产写权'],
  ['fx-no-invariants', 'L1', '不变量已声明'],
  ['fx-bad-budget', 'L1', 'budget 合法'],
]
for (const [id, level, checkName] of expects) {
  const c = rA[id]
  eq(`${id} 被挡`, c.acceptance.status, 'failed')
  eq(`${id} 仍 pending`, c.status, 'pending')
  if (failedLevels(c).includes(level) && failedNames(c).includes(checkName)) {
    ok(`${id} 失败点落在 [${level}] ${checkName}`)
  } else {
    bad(`${id} 失败点错位`, `期望 [${level}] ${checkName}；实得 ${JSON.stringify(failedNames(c))}`)
  }
}

// ★ 门不是"一律拒绝"：单独放一个好的，必须 exit 0
const homeB = makeHome('good-only', [cap('fx-good', 'good.mjs')])
const b = runGate(homeB)
eq('单放完好能力：退出码 = 0', b.code, 0)
eq('单放完好能力：admitted', receiptsOf(homeB)['fx-good'].status, 'active')

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
