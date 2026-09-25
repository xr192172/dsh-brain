#!/usr/bin/env node
/**
 * test-ablation-merge.mjs —— 判据 i：合并级消融实验
 *
 * 策略：每次把消融后的 gate 写到 scripts/capability-gate.mjs（原地替换），
 *       跑测试后还原。不用 subprocess，直接用 fs.readFileSync 读取 gate 源码并
 *       通过 node --input-type=module -e 内联执行关键逻辑来验证行为。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, '..')
const GATE = path.join(WT, 'scripts', 'capability-gate.mjs')
const HOME = path.join(WT, 'out', '_m', 'dshhome')
const HOLDOUT = path.join(WT, 'out', '_m', 'holdout-test')
const REGISTRY = path.join(HOME, 'capabilities', 'registry.json')
const BASELINES = path.join(HOME, 'capabilities', 'baselines.json')
const L4_EVIDENCE = path.join(WT, 'out', 'l4-report', 'shadow-ab-evidence.json')

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; console.log('  FAIL ' + n + ' — ' + d) }

function resetRegistry() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
  const s = reg.capabilities.find(c => c.id === 'spawn')
  if (s) {
    s.status = 'pending'
    s.holdoutHash = '1050a4bb4453144e2ff46fa0c4de83dae4f0a45b34731318fc7429ec21a8e537'
    s.acceptance = { kind: 'none', ref: null, status: 'unknown', ranAt: null }
  }
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2), 'utf8')
}

function restoreBaseline() {
  const blDb = JSON.parse(fs.readFileSync(BASELINES, 'utf8'))
  blDb.baselines['spawn'] = {
    provenance: { runAt: '2026-09-23T10:00:00.000Z', provisional: false, confirmedAt: '2026-09-23T10:05:00.000Z', note: 'merge-l234' },
    perRunMetrics: { outputTokens: 100, wallMs: 500, score: 0.8 },
  }
  fs.writeFileSync(BASELINES, JSON.stringify(blDb, null, 2), 'utf8')
}

function runGate(args) {
  try {
    const out = execSync(`node "${GATE}" ${args.join(' ')}`, {
      cwd: WT,
      env: { ...process.env, DSH_HOME: HOME, DSH_HOLDOUT_ROOT: HOLDOUT },
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

const original = fs.readFileSync(GATE, 'utf8')

// ═══════════════════════════════════════════════════════════════
// 消融 L2：无基线 check 恒过
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 消融 L2：无基线 check 恒过 ===')
const l2Target = "add('基线存在', false, '无已确认基线 —— 须先用 node scripts/eval-baseline-store.mjs set <id> --metrics <json> 写入基线后再评估')"
const l2Ablated = original.replace(l2Target, "add('基线存在', true, '[ABLATION] 无基线 check 恒过')")
fs.writeFileSync(GATE, l2Ablated, 'utf8')

// 删掉基线
const blDb = JSON.parse(fs.readFileSync(BASELINES, 'utf8'))
delete blDb.baselines['spawn']
fs.writeFileSync(BASELINES, JSON.stringify(blDb, null, 2), 'utf8')
resetRegistry()

const r1 = runGate(['run', 'spawn'])
const l2Admitted = r1.out.includes('admitted') && r1.code === 0
console.log('消融后 verdict:', r1.out.includes('admitted') ? 'admitted ✅' : 'blocked ❌')
console.log('退出码:', r1.code)
if (l2Admitted) ok('L2 消融：无基线 check 恒过后，原本 blocked 的能力变为 admitted')
else bad('L2 消融', '消融后仍 blocked')

// 还原
fs.writeFileSync(GATE, original, 'utf8')
restoreBaseline()
console.log('✓ 已还原 capability-gate.mjs + 基线')

// ═══════════════════════════════════════════════════════════════
// 消融 L3：hash 比较恒过
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 消融 L3：hash 比较恒过 ===')
const l3BlockStart = "  const realHash = crypto.createHash('sha256').update(fs.readFileSync(tasksPath)).digest('hex')\n  const recordedHash = cap.holdoutHash\n  if (!recordedHash) {\n    add('holdoutHash 已记录', false, 'registry 里还没有 holdoutHash（先跑一次 eval-holdout-run.mjs 再跑 gate）')\n  } else if (realHash !== recordedHash) {\n    add('holdoutHash 未篡改', false, `实时=${realHash.slice(0, 16)}... vs 记录=${recordedHash.slice(0, 16)}...（任务集被改过）`)\n  } else {\n    add('holdoutHash 未篡改', true, `${realHash.slice(0, 16)}...`)\n  }"
const l3BlockRepl = `  // [ABLATION] hash 比较已移除 —— 让 Check 2 恒过
  const realHash = 'always_matches'
  const recordedHash = realHash
  add('holdoutHash 未篡改', true, '[ABLATION] hash check disabled')`
const l3Ablated = original.replace(l3BlockStart, l3BlockRepl)
fs.writeFileSync(GATE, l3Ablated, 'utf8')
resetRegistry()

// 设 WRONG_HASH
const reg2 = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
const spawn2 = reg2.capabilities.find(c => c.id === 'spawn')
spawn2.holdoutHash = 'WRONG_HASH_0000000000000000000000000000000000000000000000000000000000000000'
fs.writeFileSync(REGISTRY, JSON.stringify(reg2, null, 2), 'utf8')

const r2 = runGate(['run', 'spawn'])
const l3Admitted = r2.out.includes('admitted') && r2.code === 0
console.log('消融后 verdict:', r2.out.includes('admitted') ? 'admitted ✅' : 'blocked ❌')
console.log('退出码:', r2.code)
if (l3Admitted) ok('L3 消融：hash 比较恒过后，WRONG_HASH 不再被拦截')
else bad('L3 消融', '消融后仍 blocked')

// 还原
fs.writeFileSync(GATE, original, 'utf8')
resetRegistry()
console.log('✓ 已还原 capability-gate.mjs')

// ═══════════════════════════════════════════════════════════════
// 消融 L4：l4ShadowAb 塞进 checks
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 消融 L4：l4ShadowAb 进入 checks ===')
const l4Ablated = original
  .replace(
    '  const allChecks = [...l0.checks, ...l1.checks, ...l2.checks, ...l3.checks]',
    `  const l4Result = l4ShadowAb(cap)\n  // [ABLATION] L4 进 checks（原版只进 evidence）\n  if (!l4Result.ok) allChecks.push({ level: 'L4', name: '反事实对照 evidence', ok: false, detail: l4Result.detail })\n  const allChecks = [...l0.checks, ...l1.checks, ...l2.checks, ...l3.checks]`
  )
  .replace(
    '  const evidence = { ...l0.evidence, ...l2.evidence, ...l3.evidence, l4ShadowAb: l4 }',
    '  const evidence = { ...l0.evidence, ...l2.evidence, ...l3.evidence, l4ShadowAb: l4Result ?? l4 }'
  )
fs.writeFileSync(GATE, l4Ablated, 'utf8')
resetRegistry()

// 删除 evidence 文件使 l4ShadowAb 返回 ok=false
let evidenceWasDeleted = false
try {
  if (fs.existsSync(L4_EVIDENCE)) {
    fs.unlinkSync(L4_EVIDENCE)
    evidenceWasDeleted = true
  }
} catch (e) {
  console.log('  ⚠ 无法删除 evidence 文件（sandbox 限制）')
}

const r3 = runGate(['run', 'spawn'])
const l4Blocked = !r3.out.includes('admitted') || r3.code !== 0
console.log('消融后 verdict:', r3.out.includes('blocked') ? 'blocked ✅' : 'admitted ❌')
console.log('退出码:', r3.code)
if (evidenceWasDeleted && l4Blocked) ok('L4 消融：l4ShadowAb 进 checks 后，缺 evidence 变为 blocked（证明原版软门）')
else if (!evidenceWasDeleted) bad('L4 消融', 'evidence 文件未删（sandbox），无法验证软门纪律')
else bad('L4 消融', '消融后仍 admitted，软门纪律可能被破坏')

// 还原
fs.writeFileSync(GATE, original, 'utf8')
resetRegistry()
console.log('✓ 已还原 capability-gate.mjs')

// ═══════════════════════════════════════════════════════════════
// 复绿验证
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 复绿验证 ===')
const r4 = runGate(['run', 'spawn'])
const green = r4.out.includes('admitted') && r4.code === 0
console.log('还原后 verdict:', r4.out.includes('admitted') ? 'admitted ✅' : 'blocked ❌')
console.log('退出码:', r4.code)
if (green) ok('还原后复绿：spawn 重新 admitted（proofLevel=L3）')
else bad('复绿', '还原后仍 blocked')

console.log(`\n=========================================`)
console.log(`消融结论：${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
