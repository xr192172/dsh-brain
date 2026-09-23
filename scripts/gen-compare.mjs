#!/usr/bin/env node
/**
 * gen-compare.mjs —— ★★★ **逐题对比两代存档** ⇒ 输出 delta（成功率 / 工具调用数 / token / 墙钟 / 危险动作）
 *                        + 一句话结论（**只写方向性；n 小 ⇒ 不声称显著**）。
 *
 * ## 它比的是什么
 *   比的是**两代**（`out/generations/<gen-id>/`，由 `scripts/gen-archive.mjs` 存档）：
 *   · 每一代都带着"**这一代做了什么进化**"的人写标注（`meta.json.evolution`）——
 *     本脚本**先把两代各自的标注打出来**，否则 delta 表读不懂；
 *   · 然后**逐题**对齐（题号相同的才算一对），对每个 (臂, 题) 算 delta；
 *   · 臂按**名字**对齐（两代都有的臂才比；`--arm` 可只比一条）。
 *
 * ## ★ 纪律（不许越界）
 *   · 结论**只写方向性**：多数题往哪个方向动、动了几题；**不写"显著"**、不写 p 值、不写因果；
 *   · 一边有一边没有的题 **不计入 delta**（单独列出来，并说明它没进对比）；
 *   · 缺读数（`null`）当**缺读数**处理（不计入该指标的 delta），**绝不当 0**。
 *
 * ## 用法
 *   node scripts/gen-compare.mjs --a g1 --b g2 [--arm <臂名>] [--out <报告文件>] [--gens-root out/generations]
 *   退出码：0 产出了 delta 表 / 1 没有可比对（臂名或题号一个都对不上）/ 2 用法或数据非法
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'gen-compare'
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

const A = argOf('--a')
const B = argOf('--b')
const ONLY_ARM = argOf('--arm')
const OUT = argOf('--out')
const GENS_ROOT = path.resolve(ROOT, argOf('--gens-root') ?? path.join('out', 'generations'))
if (!A || !B) die('必须给 --a <gen-id> 与 --b <gen-id>（两代的存档 id）')
if (A === B) die('--a 与 --b 是同一天 ⇒ 没有可对比的两代')

const load = (id) => {
  const dir = path.join(GENS_ROOT, id)
  if (!fs.existsSync(dir)) die(`这一代没有存档：${path.relative(ROOT, dir).replace(/\\/g, '/')}（先跑 scripts/gen-archive.mjs --gen ${id} …）`)
  const meta = readJson(path.join(dir, 'meta.json'), `meta.json（${id}）`)
  const readings = readJson(path.join(dir, 'readings.json'), `readings.json（${id}）`)
  if (!readings.arms || typeof readings.arms !== 'object') die(`存档 ${id} 的 readings.json 缺 arms`)
  if (!Array.isArray(meta.evolution) && (typeof meta.evolution !== 'string' || !meta.evolution.trim())) {
    die(`存档 ${id} 的 meta.json 缺"这一代做了什么进化"（evolution）⇒ 拒比：不知道两代差在哪，delta 表没法读`)
  }
  return { id, dir, meta, readings }
}
const ga = load(A)
const gb = load(B)

/** ★ 数值口径：'ok' 是布尔型（单列），其余四个是数值型（越小越好）。 */
const NUM = [
  { k: 'toolCalls', label: '工具调用', better: 'low' },
  { k: 'tokens', label: 'token', better: 'low' },
  { k: 'wallMs', label: '墙钟ms', better: 'low' },
  { k: 'dangerous', label: '危险动作', better: 'low' },
]

const armsA = Object.keys(ga.readings.arms)
const armsB = Object.keys(gb.readings.arms)
let arms = armsA.filter((x) => armsB.includes(x)).sort()
if (ONLY_ARM) {
  if (!arms.includes(ONLY_ARM)) die(`臂 "${ONLY_ARM}" 不是两代都有（A 有：${armsA.join(',') || '（无）'}；B 有：${armsB.join(',') || '（无）'}）`, 1)
  arms = [ONLY_ARM]
}
if (!arms.length) {
  die(`两代没有同名的臂 ⇒ 无从逐题对比（A 有：${armsA.join(', ') || '（无）'}；B 有：${armsB.join(', ') || '（无）'}）`, 1)
}

const cell = (g, arm, task) => g.readings.arms?.[arm]?.[task] ?? null
const numOf = (c, k) => (c && typeof c[k] === 'number' && Number.isFinite(c[k]) ? c[k] : null)

const lines = []
const P = (s = '') => { lines.push(s); console.log(s) }

P(`${NAME} —— 逐题对比两代存档（**只写方向性；n 小，不声称显著**）`)
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

const rows = []
const skipped = []
for (const arm of arms) {
  const tasksA = Object.keys(ga.readings.arms[arm] ?? {})
  const tasksB = Object.keys(gb.readings.arms[arm] ?? {})
  const all = [...new Set([...tasksA, ...tasksB])].sort()
  for (const t of all) {
    const ca = cell(ga, arm, t)
    const cb = cell(gb, arm, t)
    if (!ca || !cb) { skipped.push({ arm, task: t, side: !ca ? (cb ? `${ga.id} 缺` : '两边都缺') : `${gb.id} 缺` }); continue }
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
  P('★ 这不是"平局"，是"没有可比对的读数" —— 不产结论。')
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
let okBetter = 0
let okWorse = 0
let okSame = 0
let okUnknown = 0

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

/* ── 汇总 ───────────────────────────────────────────────────── */
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

/* ── 一句话结论（★ 只写方向性）────────────────────────────── */
const dir = (low, high, same) => (low === high ? (same > 0 ? '多数题原地不动' : '无方向') : low > high ? '多数题变低' : '多数题变高')
const n = rows.length
const concl = [
  `结论（方向性，n=${n}（(臂,题) 对），**不声称显著**）：`,
  `  · 成功率：${okBetter === okWorse ? (okSame === n ? '两代每题都一样' : `变好 ${okBetter} / 变差 ${okWorse} ⇒ 看不出单一方向`) : okBetter > okWorse ? `多数题变好（${okBetter} vs ${okWorse}）` : `多数题变差（${okWorse} vs ${okBetter}）`}；`,
  `  · 工具调用：${dir(agg.toolCalls.low, agg.toolCalls.high, agg.toolCalls.same)}（低 ${agg.toolCalls.low} / 高 ${agg.toolCalls.high}）；`,
  `  · token：${dir(agg.tokens.low, agg.tokens.high, agg.tokens.same)}（低 ${agg.tokens.low} / 高 ${agg.tokens.high}）；`,
  `  · 墙钟：${dir(agg.wallMs.low, agg.wallMs.high, agg.wallMs.same)}（低 ${agg.wallMs.low} / 高 ${agg.wallMs.high}）；`,
  `  · 危险动作：${dir(agg.dangerous.low, agg.dangerous.high, agg.dangerous.same)}（低 ${agg.dangerous.low} / 高 ${agg.dangerous.high}）。`,
  `  · 两代的差别（人写标注）：A「${ga.meta.evolution}」→ B「${gb.meta.evolution}」。`,
  `  ★ 本表只给方向；n 这么小**不能**用来声称"有效/无效/显著"。`,
]
for (const c of concl) P(c)

if (OUT) {
  const p = path.resolve(ROOT, OUT)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8')
  console.log(`\n[${NAME}] 报告写入 ${path.relative(ROOT, p).replace(/\\/g, '/')}`)
}
process.exit(0)
