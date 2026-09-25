// test-compare.mjs — standalone test of compareMetrics and gate L2 integration
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = 'D:/project_develop/_merge-l234/wt/out/_l2tmp'
// ★ 必须用系统 node（WorkBuddy shim 的 spawnSync 会 EPERM）
const NODE = 'C:/Program Files/nodejs/node.exe'
const BS = path.join(HERE, 'eval-baseline-store.mjs')
const GATE = path.join(HERE, 'capability-gate.mjs')

// ── 1. Test compareMetrics directly ────────────────────────────────────────
console.log('=== Test compareMetrics ===')
const r1 = execFileSync(NODE, [BS, 'diff', 'fx-test', '--metrics', JSON.stringify({outputTokens:50,wallMs:600,score:0.5})], {
  env: { ...process.env, DSH_HOME }, encoding: 'utf8', timeout: 10000
})
console.log('worse metrics:', r1.trim())

const r2 = execFileSync(NODE, [BS, 'diff', 'fx-test', '--metrics', JSON.stringify({outputTokens:150,wallMs:300,score:0.9})], {
  env: { ...process.env, DSH_HOME }, encoding: 'utf8', timeout: 10000
})
console.log('better metrics:', r2.trim())

// ── 2. Test gate: no baseline => blocked ───────────────────────────────────
console.log('\n=== Test gate: no baseline => blocked ===')
const tmpHome1 = path.join(DSH_HOME, '..', '_gate_test1')
fs.rmSync(tmpHome1, { recursive: true, force: true })
fs.mkdirSync(path.join(tmpHome1, 'capabilities'), { recursive: true })
const capNoBl = {
  id: 'fx-no-bl', kind: 'subagent-provider', version: '0.0.0',
  source: { package: null, path: null, provider: 'fx', tool: null, seat: null, entryPath: 'D:/project_develop/_merge-l234/wt/out/gate-fixtures/good.mjs' },
  capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  invariants: { role: 'provider', writeScope: 'workspace', credentials: 'inherit', budget: { source: 'inherit', maxTokens: null } },
  acceptance: { kind: 'none', ref: null, status: 'unknown', ranAt: null },
  holdoutHash: null, status: 'pending', registeredAt: new Date().toISOString(),
  supersededBy: null, retiredReason: null, lineage: [],
  signals: { invoked: 0, reused: 0, succeeded: 0, failed: 0, lastUsedAt: null, notes: [] },
}
fs.writeFileSync(path.join(tmpHome1, 'capabilities', 'registry.json'),
  JSON.stringify({ schema: 'dsh-capability-registry/v1', updatedAt: new Date().toISOString(), capabilities: [capNoBl], history: [] }, null, 2))

const r3 = execFileSync(NODE, [GATE, 'run', 'fx-no-bl'], {
  env: { ...process.env, DSH_HOME: tmpHome1 }, encoding: 'utf8', timeout: 15000
})
console.log(r3)
const after3 = JSON.parse(fs.readFileSync(path.join(tmpHome1, 'capabilities', 'registry.json'), 'utf8'))
console.log('status:', after3.capabilities[0].status, 'proofLevel:', after3.capabilities[0].acceptance?.proofLevel)

// ── 3. Test gate: confirmed baseline + good metrics => admitted + L2 ────────
console.log('\n=== Test gate: confirmed baseline + good metrics => admitted L2 ===')
const tmpHome2 = path.join(DSH_HOME, '..', '_gate_test2')
fs.rmSync(tmpHome2, { recursive: true, force: true })
fs.mkdirSync(path.join(tmpHome2, 'capabilities'), { recursive: true })
const capGoodBl = { ...capNoBl, id: 'fx-good-bl' }
fs.writeFileSync(path.join(tmpHome2, 'capabilities', 'registry.json'),
  JSON.stringify({ schema: 'dsh-capability-registry/v1', updatedAt: new Date().toISOString(), capabilities: [capGoodBl], history: [] }, null, 2))
fs.writeFileSync(path.join(tmpHome2, 'capabilities', 'baselines.json'), JSON.stringify({
  schema: 'dsh-baseline-store/v2',
  updatedAt: new Date().toISOString(),
  baselines: {
    'fx-good-bl': {
      provenance: { runAt: '2026-09-20T10:00:00.000Z', provisional: false, confirmedAt: '2026-09-20T10:05:00.000Z', note: 'test' },
      perRunMetrics: { outputTokens: 100, wallMs: 500, score: 0.8 },
    }
  }
}, null, 2))

const r4 = execFileSync(NODE, [GATE, 'run', 'fx-good-bl'], {
  env: { ...process.env, DSH_HOME: tmpHome2 }, encoding: 'utf8', timeout: 15000
})
console.log(r4)
const after4 = JSON.parse(fs.readFileSync(path.join(tmpHome2, 'capabilities', 'registry.json'), 'utf8'))
console.log('status:', after4.capabilities[0].status, 'proofLevel:', after4.capabilities[0].acceptance?.proofLevel)

// ── 4. Test gate: confirmed baseline + worse metrics => blocked ─────────────
console.log('\n=== Test gate: confirmed baseline + worse metrics => blocked ===')
const tmpHome3 = path.join(DSH_HOME, '..', '_gate_test3')
fs.rmSync(tmpHome3, { recursive: true, force: true })
fs.mkdirSync(path.join(tmpHome3, 'capabilities'), { recursive: true })
const capWorse = { ...capNoBl, id: 'fx-worse', perRunMetrics: { outputTokens: 50, wallMs: 600, score: 0.5 } }
fs.writeFileSync(path.join(tmpHome3, 'capabilities', 'registry.json'),
  JSON.stringify({ schema: 'dsh-capability-registry/v1', updatedAt: new Date().toISOString(), capabilities: [capWorse], history: [] }, null, 2))
fs.writeFileSync(path.join(tmpHome3, 'capabilities', 'baselines.json'), JSON.stringify({
  schema: 'dsh-baseline-store/v2',
  updatedAt: new Date().toISOString(),
  baselines: {
    'fx-worse': {
      provenance: { runAt: '2026-09-20T10:00:00.000Z', provisional: false, confirmedAt: '2026-09-20T10:05:00.000Z', note: 'test' },
      perRunMetrics: { outputTokens: 100, wallMs: 500, score: 0.8 },
    }
  }
}, null, 2))

const r5 = execFileSync(NODE, [GATE, 'run', 'fx-worse'], {
  env: { ...process.env, DSH_HOME: tmpHome3 }, encoding: 'utf8', timeout: 15000
})
console.log(r5)
const after5 = JSON.parse(fs.readFileSync(path.join(tmpHome3, 'capabilities', 'registry.json'), 'utf8'))
console.log('status:', after5.capabilities[0].status, 'proofLevel:', after5.capabilities[0].acceptance?.proofLevel)

// ── 5. Test gate: provisional baseline => blocked ──────────────────────────
console.log('\n=== Test gate: provisional baseline => blocked ===')
const tmpHome4 = path.join(DSH_HOME, '..', '_gate_test4')
fs.rmSync(tmpHome4, { recursive: true, force: true })
fs.mkdirSync(path.join(tmpHome4, 'capabilities'), { recursive: true })
const capProv = { ...capNoBl, id: 'fx-prov' }
fs.writeFileSync(path.join(tmpHome4, 'capabilities', 'registry.json'),
  JSON.stringify({ schema: 'dsh-capability-registry/v1', updatedAt: new Date().toISOString(), capabilities: [capProv], history: [] }, null, 2))
fs.writeFileSync(path.join(tmpHome4, 'capabilities', 'baselines.json'), JSON.stringify({
  schema: 'dsh-baseline-store/v2',
  updatedAt: new Date().toISOString(),
  baselines: {
    'fx-prov': {
      provenance: { runAt: '2026-09-24T10:00:00.000Z', provisional: true, confirmedAt: null, note: 'pending confirm' },
      perRunMetrics: { outputTokens: 100, wallMs: 500, score: 0.8 },
    }
  }
}, null, 2))

const r6 = execFileSync(NODE, [GATE, 'run', 'fx-prov'], {
  env: { ...process.env, DSH_HOME: tmpHome4 }, encoding: 'utf8', timeout: 15000
})
console.log(r6)
const after6 = JSON.parse(fs.readFileSync(path.join(tmpHome4, 'capabilities', 'registry.json'), 'utf8'))
console.log('status:', after6.capabilities[0].status, 'proofLevel:', after6.capabilities[0].acceptance?.proofLevel)

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n=== Summary ===')
console.log('compareMetrics worse:', r1.trim())
console.log('compareMetrics better:', r2.trim())
console.log('gate no-baseline:', after3.capabilities[0].status, '| proofLevel:', after3.capabilities[0].acceptance?.proofLevel)
console.log('gate good-baseline:', after4.capabilities[0].status, '| proofLevel:', after4.capabilities[0].acceptance?.proofLevel)
console.log('gate worse-metrics:', after5.capabilities[0].status, '| proofLevel:', after5.capabilities[0].acceptance?.proofLevel)
console.log('gate provisional:', after6.capabilities[0].status, '| proofLevel:', after6.capabilities[0].acceptance?.proofLevel)
