#!/usr/bin/env node
/**
 * eval-shadow-ab.mjs —— 反事实对照（L4 shadow A/B）
 *
 * 与 `gen-compare.mjs` **同 schema、非 import**：读 `out/generations/<gen-id>/meta.json`
 * 与 `readings.json`，逐题逐指标算 delta，输出方向性结论（不声称显著）。
 *
 * ★ L4 是**软门**：只产证据（evidence），不入 verdict。
 *   本脚本输出的 JSON 会被 `capability-gate.mjs` 的 l4ShadowAb() 读进
 *   `evidence.l4ShadowAb`，但 `verdict` 的计算完全无视它。
 *
 * ## 纪律（继承 gen-compare.mjs 三条）
 *   · 结论**只写方向性**；不写"显著"、不写 p 值；
 *   · 一边有一边没有的题**不计入 delta**（单列并说明）；
 *   · 缺读数（`null`）当缺读数，绝不当 0 参与 delta。
 *
 * ## 用法
 *   node scripts/eval-shadow-ab.mjs --a <gen-a> --b <gen-b> [--gens-root <dir>] [--out <file>]
 *   退出码：0 = 成功产出证据 / 1 = 无可比对（臂名或题号一个都对不上）/ 2 = 用法或数据非法
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'eval-shadow-ab'
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }

const die = (msg, code = 2) => {
  process.stderr.write(`[${NAME}] ${msg}\n`)
  process.exit(code)
}
const readJson = (p, label) => {
  let text
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch (e) {
    die(`读不到${label} ${p}：${e?.message ?? e}`)
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(body)
  } catch (e) {
    die(`${label} ${p} 不是合法 JSON：${e?.message ?? e}`)
  }
}
/** SHA-256 of a file path (UTF-8). */
function sha256File(p) {
  const buf = fs.readFileSync(p)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

const A = argOf('--a')
const B = argOf('--b')
const OUT = argOf('--out')
const GENS_ROOT = path.resolve(ROOT, argOf('--gens-root') ?? path.join('out', 'generations'))
if (!A || !B) die('必须给 --a <gen-a> 与 --b <gen-b>（两代存档 id）')
if (A === B) die('--a 与 --b 是同一天 ⇒ 没有可对比的两代')

// ── 加载一代存档（fail-closed）───────────────────────────────────────────────
const load = (id) => {
  const dir = path.join(GENS_ROOT, id)
  if (!fs.existsSync(dir)) die(`这一代没有存档：${path.relative(ROOT, dir).replace(/\\/g, '/')}`)
  const meta = readJson(path.join(dir, 'meta.json'), `meta.json（${id}）`)
  const readings = readJson(path.join(dir, 'readings.json'), `readings.json（${id}）`)
  if (!readings.arms || typeof readings.arms !== 'object') die(`存档 ${id} 的 readings.json 缺 arms`)
  if (!Array.isArray(meta.evolution) && (typeof meta.evolution !== 'string' || !meta.evolution.trim())) {
    die(`存档 ${id} 的 meta.json 缺"这一代做了什么进化"（evolution）⇒ 拒比：不知道两代差在哪，delta 表没法读`)
  }
  // ★ 钉住来源：计算 readings.json 的 SHA-256
  const readingsPath = path.join(dir, 'readings.json')
  const sha = sha256File(readingsPath)
  return { id, dir, meta, readings, readingsPath, sha }
}
const ga = load(A)
const gb = load(B)

// ── 数值口径（与 gen-compare.mjs 一致，NUM 数组）───────────────────────────
const NUM = [
  { k: 'toolCalls', label: '工具调用', better: 'low' },
  { k: 'tokens', label: 'token', better: 'low' },
  { k: 'wallMs', label: '墙钟ms', better: 'low' },
  { k: 'dangerous', label: '危险动作', better: 'low' },
]
/** ★ 数值口径：'ok' 是布尔型（单列），其余四个是数值型（越小越好）。 */

const armsA = Object.keys(ga.readings.arms ?? {})
const armsB = Object.keys(gb.readings.arms ?? {})
let arms = armsA.filter((x) => armsB.includes(x)).sort()
if (!arms.length) {
  die(`两代没有同名的臂 ⇒ 无从逐题对比（A 有：${armsA.join(',') || '（无）'}；B 有：${armsB.join(',') || '（无）'}）`, 1)
}

const cell = (g, arm, task) => g.readings.arms?.[arm]?.[task] ?? null
const numOf = (c, k) => (c && typeof c[k] === 'number' && Number.isFinite(c[k]) ? c[k] : null)

const lines = []
const P = (s = '') => { lines.push(s); process.stdout.write(s + '\n') }

P(`${NAME} —— 反事实对照（shadow A/B）逐切片 delta 表`)
P(`  存档根   : ${path.relative(ROOT, GENS_ROOT).replace(/\\/g, '/')}/`)
P(`  A 代     : ${ga.id}   存档于 ${ga.meta.at ?? '(未知)'}`)
P(`    ★ 这代做了什么进化：${ga.meta.evolution}`)
P(`  B 代     : ${gb.id}   存档于 ${gb.meta.at ?? '(未知)'}`)
P(`    ★ 这代做了什么进化：${gb.meta.evolution}`)
P(`  比哪些臂 : ${arms.join(' , ')}（两代同名的臂才比）`)
if (armsA.length !== arms.length || armsB.length !== arms.length) {
  const aOnly = armsA.filter((x) => !arms.includes(x))
  const bOnly = armsB.filter((x) => !arms.includes(x))
  P(`  ⊘ 未参与 : ${aOnly.length ? `只在 ${ga.id}：${aOnly.join(', ')}` : ''}${aOnly.length && bOnly.length ? '；' : ''}${bOnly.length ? `只在 ${gb.id}：${bOnly.join(', ')}` : ''}`)
}
P('')

// ── 逐题 delta ───────────────────────────────────────────────────────────────
const rows = []
const skipped = []
for (const arm of arms) {
  const tasksA = Object.keys(ga.readings.arms[arm] ?? {})
  const tasksB = Object.keys(gb.readings.arms[arm] ?? {})
  const all = [...new Set([...tasksA, ...tasksB])].sort()
  for (const t of all) {
    const ca = cell(ga, arm, t)
    const cb = cell(gb, arm, t)
    if (!ca || !cb) { skipped.push({ arm, task: t, side: !ca ? `${ga.id} 缺` : `${gb.id} 缺` }); continue }
    rows.push({ arm, task: t, ca, cb })
  }
}

if (!rows.length) {
  P(`⊘ 两代**没有任何一对 (臂, 题) 能对上** ⇒ 产不出 delta 表。`)
  if (skipped.length) {
    P(`  对不上的逐条（共 ${skipped.length}）：`)
    for (const s of skipped) P(`    · ${s.arm} / ${s.task}  —— ${s.side}`)
  }
  P('')
  P('★ 这不是"平局"，是"没有可比对的读数" —— 拒产出。')
  if (OUT) fs.writeFileSync(path.resolve(ROOT, OUT), lines.join('\n') + '\n', 'utf8')
  process.exit(1)
}

/* ── 逐题 delta 表 ─────────────────────────────────────────── */
P('='.repeat(112))
P('逐题 delta 表（Δ = B 代 − A 代；工具调用/token/墙钟/危险动作**越小越好**）')
P('='.repeat(112))
const head = ['臂', '题', '成功', ...NUM.map((m) => `Δ${m.label}`)]
const widths = [10, 22, 14, 14, 14, 12, 12]
P(head.map((h, i) => String(h).padEnd(widths[i])).join(' '))
P('-'.repeat(112))
const agg = {}
for (const m of NUM) agg[m.k] = { low: 0, high: 0, same: 0, unknown: 0, sum: 0, n: 0 }
let okBetter = 0, okWorse = 0, okSame = 0, okUnknown = 0

const fmt = (v) => (v === null ? '缺' : String(v))
for (const r of rows) {
  const okA = r.ca.ok
  const okB = r.cb.ok
  let okTxt = '缺'
  if (okA === null || okA === undefined || okB === null || okB === undefined) { okUnknown++; okTxt = '缺' }
  else if (okA === okB) { okSame++; okTxt = `同（${okA ? '成功' : '失败'}）` }
  else if (okB === true) { okBetter++; okTxt = '失败→成功' }
  else { okWorse++; okTxt = '成功→失败' }
  const cells = [r.arm, r.task, okTxt]
  for (const m of NUM) {
    const a = numOf(r.ca, m.k)
    const b = numOf(r.cb, m.k)
    if (a === null || b === null) { agg[m.k].unknown++; cells.push('缺') }
    else {
      const d = b - a
      if (d === 0) agg[m.k].same++
      else if (d < 0) agg[m.k].low++
      else agg[m.k].high++
      agg[m.k].sum += d
      agg[m.k].n++
      cells.push(`${d > 0 ? '+' : ''}${d}（${a}→${b}）`)
    }
  }
  P(cells.map((c, i) => String(c).padEnd(widths[i])).join(' '))
}
P('-'.repeat(112))
if (skipped.length) {
  P(`⊘ 未进对比的 (臂, 题) 共 ${skipped.length} 条（一边有读数、一边没有 —— **不计入 delta**，也绝不当 0）：`)
  for (const s of skipped) P(`    · ${s.arm} / ${s.task}  —— ${s.side}`)
  P('')
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
P('='.repeat(112))
P(`汇总（参与对比的 (臂, 题) 对数 = ${rows.length}）`)
P('='.repeat(112))
P(`  成功率   : 变好 ${okBetter} / 变差 ${okWorse} / 不变 ${okSame} / 缺读数 ${okUnknown}`)
for (const m of NUM) {
  const a = agg[m.k]
  const mean = a.n ? (a.sum / a.n).toFixed(2) : '—'
  P(`  ${m.label.padEnd(6)} : 变低 ${a.low} / 变高 ${a.high} / 不变 ${a.same} / 缺读数 ${a.unknown}（有数 n=${a.n}，Δ均值=${mean}）`)
}
P('')

// ── 一句话结论（★ 只写方向性）──────────────────────────────
const dir = (low, high, same) => (low === high ? (same > 0 ? '多数题原地不动' : '无方向') : low > high ? '多数题变低' : '多数题变高')
const n = rows.length
const conclLines = [
  `结论（方向性，n=${n}，**不声称显著**）：`,
  `  · 成功率：${okBetter === okWorse ? (okSame === n ? '两代每题都一样' : `变好 ${okBetter} / 变差 ${okWorse} ⇒ 看不出单一方向`) : okBetter > okWorse ? `多数题变好（${okBetter} vs ${okWorse}）` : `多数题变差（${okWorse} vs ${okBetter}）`}；`,
  `  · 工具调用：${dir(agg.toolCalls.low, agg.toolCalls.high, agg.toolCalls.same)}（低 ${agg.toolCalls.low} / 高 ${agg.toolCalls.high}）；`,
  `  · token：${dir(agg.tokens.low, agg.tokens.high, agg.tokens.same)}（低 ${agg.tokens.low} / 高 ${agg.tokens.high}）；`,
  `  · 墙钟：${dir(agg.wallMs.low, agg.wallMs.high, agg.wallMs.same)}（低 ${agg.wallMs.low} / 高 ${agg.wallMs.high}）；`,
  `  · 危险动作：${dir(agg.dangerous.low, agg.dangerous.high, agg.dangerous.same)}（低 ${agg.dangerous.low} / 高 ${agg.dangerous.high}）。`,
  `  · 两代的差别（人写标注）：A「${ga.meta.evolution}」→ B「${gb.meta.evolution}」。`,
  `  ★ 本表只给方向；n 这么小**不能**用来声称"有效/无效/显著"。`,
]
for (const c of conclLines) P(c)
P('')

// ── 结构化证据输出（被 capability-gate.mjs 的 l4ShadowAb 消费）─────────────
/** ★ 把逐题 delta 表以 JSON 形式产出，方便消费侧做判断。 */
const jsonEvidence = {
  kind: 'shadow-ab',
  ref: 'scripts/eval-shadow-ab.mjs',
  source: {
    a: { id: ga.id, path: ga.readingsPath, sha256: ga.sha },
    b: { id: gb.id, path: gb.readingsPath, sha256: gb.sha },
    ranAt: new Date().toISOString(),
  },
  summary: {
    rowsCompared: rows.length,
    skipped: skipped.map((s) => ({ arm: s.arm, task: s.task, side: s.side })),
    ok: { better: okBetter, worse: okWorse, same: okSame, unknown: okUnknown },
    metrics: Object.fromEntries(
      NUM.map((m) => [m.k, { low: agg[m.k].low, high: agg[m.k].high, same: agg[m.k].same, unknown: agg[m.k].unknown, n: agg[m.k].n, mean: agg[m.k].n ? (agg[m.k].sum / agg[m.k].n).toFixed(2) : null }]),
    ),
  },
  conclusion: conclLines.join('\n  '),
}
if (OUT) {
  const outPath = path.resolve(ROOT, OUT)
  const txtOut = path.join(outPath + '.txt')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(jsonEvidence, null, 2) + '\n', 'utf8')
  fs.writeFileSync(txtOut, lines.join('\n') + '\n', 'utf8')
  process.stdout.write(`\n[${NAME}] 证据写入 ${path.relative(ROOT, outPath).replace(/\\/g, '/')}（JSON） + ${path.relative(ROOT, txtOut).replace(/\\/g, '/')}（文本）\n`)
} else {
  process.stdout.write(`\n[${NAME}] 证据（JSON）：\n${JSON.stringify(jsonEvidence, null, 2)}\n`)
}
process.exit(0)
