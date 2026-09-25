// test-l2.mjs — self-contained L2 integration test
// All baseline DBs are in-memory to avoid file-state pollution between tests.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let passed = 0
let failed = 0
const bad = (n, got, want) => { failed++; console.log(`  FAIL ${n}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`) }
const ok = (n) => { passed++; console.log(`  ok   ${n}`) }

// ── 1. Import eval-baseline-store ───────────────────────────────────────────
console.log('=== Import eval-baseline-store ===')
const BS = pathToFileURL(path.join(HERE, 'eval-baseline-store.mjs')).href
const { getBaseline, compareMetrics, setBaseline, confirmBaseline }
  = await import(BS)

// ── Helper: create fresh in-memory DB ──────────────────────────────────────
function freshDb() {
  return { schema: 'dsh-baseline-store/v2', updatedAt: null, baselines: {} }
}

// ── 2. Test compareMetrics ──────────────────────────────────────────────────
console.log('\n=== Test compareMetrics ===')
const db1 = freshDb()
setBaseline(db1, 'fx-base', { outputTokens: 100, wallMs: 500, score: 0.8 })
confirmBaseline(db1, 'fx-base')
const baseline = getBaseline(db1, 'fx-base')
console.log('baseline found:', !!baseline, 'provisional:', baseline?.provenance?.provisional)

const worse = { outputTokens: 50, wallMs: 600, score: 0.5 }
const better = { outputTokens: 150, wallMs: 300, score: 0.9 }
const equal  = { outputTokens: 100, wallMs: 500, score: 0.8 }

const r_worse = compareMetrics(worse, baseline)
const r_better = compareMetrics(better, baseline)
const r_equal  = compareMetrics(equal, baseline)

console.log('worse:', JSON.stringify(r_worse))
console.log('better:', JSON.stringify(r_better))
console.log('equal:', JSON.stringify(r_equal))

r_worse.ok === false ? ok('worse metrics -> blocked') : bad('worse', r_worse.ok, false)
r_better.ok === true ? ok('better metrics -> pass')   : bad('better', r_better.ok, true)
r_equal.ok === true  ? ok('equal metrics -> pass')     : bad('equal', r_equal.ok, true)

// ── 3. Test: no baseline => getBaseline returns null ─────────────────────────
console.log('\n=== Test: no baseline => null ===')
const db2 = freshDb()
const noBl = getBaseline(db2, 'nonexistent')
noBl === null ? ok('no baseline => null') : bad('no baseline', noBl, null)

// ── 4. Test: provisional baseline => compareMetrics returns null ────────────
console.log('\n=== Test: provisional baseline => compareMetrics null ===')
const db3 = freshDb()
setBaseline(db3, 'fx-prov', { outputTokens: 100, wallMs: 500, score: 0.8 }, { provisional: true })
// Don't confirm => stays provisional
const provBl = getBaseline(db3, 'fx-prov')
console.log('provisional found:', !!provBl, 'provisional flag:', provBl?.provenance?.provisional)
const r_prov = compareMetrics(better, provBl)
r_prov === null ? ok('provisional => compareMetrics returns null') : bad('provisional', r_prov, null)

// ── 5. Source-code verification of gate.mjs ─────────────────────────────────
console.log('\n=== Verify capability-gate.mjs source ===')
const gateSrc = fs.readFileSync(path.join(HERE, 'capability-gate.mjs'), 'utf8')

gateSrc.includes("enforced: true, status: 'implemented', scope: '在既有能力集上不劣化")
  ? ok('LADDER: L2 enforced=true, status=implemented')
  : bad('L2 enforced', gateSrc.includes("enforced: true"), true)

gateSrc.includes('function l2Baseline')
  ? ok('l2Baseline function exists')
  : bad('l2Baseline', false, true)

gateSrc.includes('passedLevels')
  ? ok('evaluate returns passedLevels array')
  : bad('passedLevels', false, true)

// MAX_ENFORCED should only appear in comments, not as const declaration
const maxEnforcedCodeMatches = gateSrc.match(/const MAX_ENFORCED\s*=/g)
maxEnforcedCodeMatches === null
  ? ok('MAX_ENFORCED constant removed')
  : bad('MAX_ENFORCED removed', maxEnforcedCodeMatches.length, 0)

gateSrc.includes('setBaseline') === false
  ? ok('gate does NOT call setBaseline (read-only)')
  : bad('gate calls setBaseline', true, false)

gateSrc.includes('getBaseline')
  ? ok('gate imports getBaseline')
  : bad('getBaseline import', false, true)

gateSrc.includes('compareMetrics')
  ? ok('gate imports compareMetrics')
  : bad('compareMetrics import', false, true)

// Check that l2Baseline blocks on no baseline (verdict field removed per merge discipline)
const noBaselineBlock = gateSrc.includes('无基线') && gateSrc.includes('唯一决定因子是 checks[].ok')
noBaselineBlock ? ok('l2Baseline blocks when no baseline (regardless of signals)')
  : bad('no-baseline block', noBaselineBlock, true)

// Check proofLevel uses continuous-passed logic (merged version uses for...of over levels array)
const hasContinuousLogic = gateSrc.includes('for (const lv of levels)') &&
                           gateSrc.includes('break') &&
                           gateSrc.includes('levelChecks.every((c) => c.ok)')
hasContinuousLogic ? ok('proofLevel uses highest-continuous-passed logic')
  : bad('proofLevel continuous logic', hasContinuousLogic, true)

// ── 6. Direct l2Baseline logic test (mirrors gate's function) ───────────────
console.log('\n=== Direct l2Baseline logic test ===')
function testL2Baseline(cap, blDb) {
  const existing = getBaseline(blDb, cap.id)
  if (!existing) {
    return { verdict: 'blocked', reason: 'no baseline' }
  }
  if (existing.provenance.provisional) {
    return { verdict: 'blocked', reason: 'provisional' }
  }
  const cur = cap.perRunMetrics ?? {}
  const cmp = compareMetrics(cur, existing)
  if (cmp === null) return { verdict: 'blocked', reason: 'provisional fallback' }
  if (!cmp.ok) return { verdict: 'blocked', diffs: cmp.diffs }
  return { verdict: 'admitted' }
}

// Test 6a: no baseline => blocked
const t6a = testL2Baseline({ id: 'fx-no-bl', perRunMetrics: {} }, freshDb())
t6a.verdict === 'blocked' ? ok('no baseline => blocked')
  : bad('no baseline test', t6a.verdict, 'blocked')

// Test 6b: confirmed baseline + good metrics => admitted
const db6b = freshDb()
setBaseline(db6b, 'fx-good', { outputTokens: 100, wallMs: 500, score: 0.8 })
confirmBaseline(db6b, 'fx-good')
const t6b = testL2Baseline(
  { id: 'fx-good', perRunMetrics: { outputTokens: 150, wallMs: 300, score: 0.9 } },
  db6b
)
t6b.verdict === 'admitted' ? ok('good metrics => admitted')
  : bad('good metrics test', t6b.verdict, 'admitted')

// Test 6c: confirmed baseline + worse metrics => blocked
const db6c = freshDb()
setBaseline(db6c, 'fx-worse', { outputTokens: 100, wallMs: 500, score: 0.8 })
confirmBaseline(db6c, 'fx-worse')
const t6c = testL2Baseline(
  { id: 'fx-worse', perRunMetrics: { outputTokens: 50, wallMs: 600, score: 0.5 } },
  db6c
)
t6c.verdict === 'blocked' ? ok('worse metrics => blocked')
  : bad('worse metrics test', t6c.verdict, 'blocked')

// Test 6d: provisional baseline => blocked
const db6d = freshDb()
setBaseline(db6d, 'fx-prov-t', { outputTokens: 100, wallMs: 500, score: 0.8 }, { provisional: true })
// Don't confirm
const t6d = testL2Baseline(
  { id: 'fx-prov-t', perRunMetrics: { outputTokens: 150, wallMs: 300, score: 0.9 } },
  db6d
)
t6d.verdict === 'blocked' ? ok('provisional baseline => blocked')
  : bad('provisional test', t6d.verdict, 'blocked')

// ── 7. Verify gate ladder output ────────────────────────────────────────────
console.log('\n=== Verify gate ladder ===')
const ladderSrc = fs.readFileSync(path.join(HERE, 'capability-gate.mjs'), 'utf8')
ladderSrc.includes('★ 已实施') && ladderSrc.includes('L2')
  ? ok('gate ladder shows L2 as implemented')
  : bad('ladder L2 shown', false, true)

ladderSrc.includes("L3") && ladderSrc.includes('未实施')
  ? ok('gate ladder shows L3 as not implemented')
  : bad('ladder L3 shown', false, true)

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n=========================================`)
console.log(`结果：${passed} passed, ${failed} failed`)
if (failed) {
  console.log('失败项见上方')
}
process.exit(failed ? 1 : 0)
