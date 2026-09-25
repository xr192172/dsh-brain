// ablate-l3.mjs — 用 Node.js 做 L3 消融（避免 PowerShell 字符编码问题）
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const WT = 'D:/project_develop/_merge-l234/wt'
const GATE = path.join(WT, 'scripts', 'capability-gate.mjs')
const ABLATED = path.join(WT, 'scripts', 'capability-gate-l3-ablated.mjs')
const HOME = path.join(WT, 'out', '_m', 'dshhome')
const HOLDOUT = path.join(WT, 'out', '_m', 'holdout-test')
const REGISTRY = path.join(HOME, 'capabilities', 'registry.json')
const BASELINES = path.join(HOME, 'capabilities', 'baselines.json')

const original = fs.readFileSync(GATE, 'utf8')

// L3 ablation: replace hash check block with always-true
const l3Block = `  const realHash = crypto.createHash('sha256').update(fs.readFileSync(tasksPath)).digest('hex')
  const recordedHash = cap.holdoutHash
  if (!recordedHash) {
    add('holdoutHash 已记录', false, 'registry 里还没有 holdoutHash（先跑一次 eval-holdout-run.mjs 再跑 gate）')
  } else if (realHash !== recordedHash) {
    add('holdoutHash 未篡改', false, \`实时=\${realHash.slice(0, 16)}... vs 记录=\${recordedHash.slice(0, 16)}...（任务集被改过）\`)
  } else {
    add('holdoutHash 未篡改', true, \`\${realHash.slice(0, 16)}...\`)
  }`
const l3Repl = `  // [ABLATION] hash 比较已移除 —— 让 Check 2 恒过
  const realHash = 'always_matches'
  const recordedHash = realHash
  add('holdoutHash 未篡改', true, '[ABLATION] hash check disabled')`

if (!original.includes(l3Block)) {
  console.error('L3 block not found in gate source')
  process.exit(1)
}
const ablated = original.replace(l3Block, l3Repl)
if (!ablated.includes('[ABLATION]')) {
  console.error('L3 ablation failed: replacement did not take effect')
  process.exit(1)
}
fs.writeFileSync(ABLATED, ablated, 'utf8')
console.log('L3 ablated gate written')

// Reset registry + set WRONG_HASH
const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
const spawn = reg.capabilities.find(c => c.id === 'spawn')
spawn.status = 'pending'
spawn.holdoutHash = 'WRONG_HASH_0000000000000000000000000000000000000000000000000000000000000000'
spawn.acceptance = { kind: 'none', ref: null, status: 'unknown', ranAt: null }
fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2), 'utf8')
console.log('WRONG_HASH set in registry')

// Run gate
try {
  const out = execSync(`node "${ABLATED}" run spawn`, {
    cwd: WT,
    env: { ...process.env, DSH_HOME: HOME, DSH_HOLDOUT_ROOT: HOLDOUT },
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  })
  const admitted = out.includes('admitted')
  console.log('Verdict:', admitted ? 'admitted ✅ (hash bypassed)' : 'blocked ❌ (ablation failed)')
  console.log('Exit code:', admitted ? 0 : 1)
  const lines = out.split('\n').filter(l => l.includes('L3') || l.includes('admitted') || l.includes('blocked'))
  for (const l of lines) console.log(' ', l)
} catch (e) {
  const out = (e.stdout ?? '') + (e.stderr ?? '')
  const admitted = out.includes('admitted')
  console.log('Verdict:', admitted ? 'admitted ✅ (hash bypassed)' : 'blocked ❌ (ablation failed)')
  console.log('Exit code:', e.status)
  const lines = out.split('\n').filter(l => l.includes('L3') || l.includes('admitted') || l.includes('blocked'))
  for (const l of lines) console.log(' ', l)
}

// Restore
fs.writeFileSync(GATE, original, 'utf8')
const reg2 = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
const spawn2 = reg2.capabilities.find(c => c.id === 'spawn')
spawn2.status = 'pending'
spawn2.holdoutHash = '1050a4bb4453144e2ff46fa0c4de83dae4f0a45b34731318fc7429ec21a8e537'
spawn2.acceptance = { kind: 'none', ref: null, status: 'unknown', ranAt: null }
fs.writeFileSync(REGISTRY, JSON.stringify(reg2, null, 2), 'utf8')
const blDb = JSON.parse(fs.readFileSync(BASELINES, 'utf8'))
blDb.baselines['spawn'] = {
  provenance: { runAt: '2026-09-23T10:00:00.000Z', provisional: false, confirmedAt: '2026-09-23T10:05:00.000Z', note: 'merge-l234' },
  perRunMetrics: { outputTokens: 100, wallMs: 500, score: 0.8 },
}
fs.writeFileSync(BASELINES, JSON.stringify(blDb, null, 2), 'utf8')
console.log('✓ Restored original gate + registry + baseline')
