#!/usr/bin/env node
/**
 * eval-baseline-store.mjs —— 能力基线库（L2 判据的数据源）
 *
 * ★ 职责：存取"每个能力的基线"，并**证明基线的来源**。
 *
 * 基线是什么：某次**独立的历史运行**（不是当前这轮）中，该能力在若干维度上的快照。
 *   比较时：当前指标 >= 基线对应维度 ⇒ 通过；否则 ⇒ blocked。
 *   ★ fail-closed：缺基线 ⇒ blocked（不能假设"没历史=安全"）。
 *   ★ 口径用 **min**（最保守）—— 设计原文要求 "fail-closed"，min 是唯一不引入额外
 *     假设的选择。这里指：**各维度独立地用 min 比**。
 *
 * ★★ 基线来源纪律（防假绿）：
 *   - 基线必须来自【独立的历史运行】（★ 不许"就地生成"）。
 *   - 由 `eval-baseline-store.mjs` 的 CLI 命令单独写入（gate 只读，不写）。
 *   - ★ 不允许"本次运行刚产生信号 → 同一次 run 就把它当基线跑 L2"——
 *     那正是"假绿"路径：门永远绿。
 *
 * ★★ 判据口径：必须比**每次运行都会变**的真实度量，不许比单调累计计数器。
 *   累计计数器（invoked/succeeded/failed）只增不减，结构上不可能检出退化。
 *   改为比 perRunMetrics（每调用指标），例如：
 *     · outputTokens   本次调用的输出 token 数（越高未必好，但会变化）
 *     · wallMs         本次调用的耗时 ms（越低越好）
 *     · costCNY        本次调用的成本（越低越好）
 *     · score          本次调用的质量评分（0~1，越高越好）
 *   各维度的方向由 `direction` 字段声明（'up' 越大越好 / 'down' 越小越好），
 *   compareMetrics 据此判断。
 *
 * 文件位置：<DSH_HOME>/capabilities/baselines.json
 * 形状：
 *   {
 *     "schema": "dsh-baseline-store/v2",
 *     "updatedAt": "<ISO>",
 *     "baselines": {
 *       "<cap-id>": {
 *         "provenance": {
 *           "runAt": "<ISO>",
 *           "provisional": true,
 *           "confirmedAt": null | "<ISO>",
 *           "note": "<可选人话>"
 *         },
 *         "perRunMetrics": {
 *           "outputTokens": 120,
 *           "wallMs": 350,
 *           "costCNY": 0.02,
 *           "score": 0.85
 *         }
 *       }
 *     }
 *   }
 *
 * ★ 可执行判据（供 gate 消费）：
 *   ★ 给定一个能力 id ⇒ 能读出它的基线（或明确报"没有基线"）；
 *   ★ 基线记录里必须含"来源"字段（provenance.runAt + provisional）。
 *   ★ 不许接受"来源不明"的基线（provenance 缺任何字段 ⇒ 返回 null 而不是该基线）。
 *
 * 用法：
 *   node scripts/eval-baseline-store.mjs list                    # 列出所有基线
 *   node scripts/eval-baseline-store.mjs get <id> [--json]       # 读某能力基线
 *   node scripts/eval-baseline-store.mjs set <id> --metrics ...  # 写入新基线（新 provision）
 *   node scripts/eval-baseline-store.mjs confirm <id> [--note]  # 把暂估基线转正
 *   node scripts/eval-baseline-store.mjs diff <id> --metrics ... # 比较当前指标与基线
 *
 * ★ 本文件只导出纯函数，不自己决定退出码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const DIR = path.join(HOME, 'capabilities')
const FILE = path.join(DIR, 'baselines.json')
const SCHEMA = 'dsh-baseline-store/v2'
const REQUIRED_PROVENANCE_FIELDS = ['runAt', 'provisional']

// ── 存储 ─────────────────────────────────────────────────────────────────────

export function load() {
  if (!fs.existsSync(FILE)) {
    return { schema: SCHEMA, updatedAt: null, baselines: {} }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (!raw?.baselines || typeof raw.baselines !== 'object') {
      console.error(`X baselines.json 形状不对（缺 baselines 对象）：${FILE}`)
      process.exit(1)
    }
    return raw
  } catch (e) {
    console.error(`X baselines.json 解析失败：${e.message}`)
    process.exit(1)
  }
}

export function save(db) {
  db.schema = SCHEMA
  db.updatedAt = new Date().toISOString()
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, FILE)
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

/**
 * 读某能力的基线。**不返回"来源不明"的基线**（provenance 缺字段 ⇒ null）。
 * @returns {object|null} 基线对象或 null（无基线 / 来源不明都返回 null）
 */
export function getBaseline(db, id) {
  const b = db.baselines?.[id]
  if (!b) return null
  if (!b.provenance || typeof b.provenance !== 'object') return null
  for (const f of REQUIRED_PROVENANCE_FIELDS) {
    if (b.provenance[f] === undefined || b.provenance[f] === null) return null
  }
  if (!b.perRunMetrics || typeof b.perRunMetrics !== 'object') return null
  return b
}

/**
 * 检查基线是否存在且来源明确。
 */
export function checkBaseline(db, id) {
  const b = getBaseline(db, id)
  return { exists: b !== null, provenanceOk: b !== null, baseline: b }
}

// ── 写入 ─────────────────────────────────────────────────────────────────────

/**
 * 写入一条基线。
 * ★ 默认创建已确认基线（provisional=false）。
 *   传 opts.provisional=true 可创建暂估基线（需人工 confirm 后才参与判定）。
 * ★ gate 不调用此函数——只有 eval-baseline-store.mjs 的 CLI 命令写基线。
 *   这防止了"就地生成基线然后自己给自己放行"的假绿路径。
 */
export function setBaseline(db, id, metrics, opts = {}) {
  const now = new Date().toISOString()
  const provisional = opts.provisional === true
  db.baselines = db.baselines ?? {}
  db.baselines[id] = {
    provenance: {
      runAt: opts.runAt ?? now,
      provisional,
      confirmedAt: provisional ? null : (opts.confirmedAt ?? now),
      note: opts.note ?? null,
    },
    perRunMetrics: { ...metrics },
  }
  return db
}

/**
 * 把某能力的暂估基线转正（provisional=false → confirmed）。
 */
export function confirmBaseline(db, id, opts = {}) {
  const b = db.baselines?.[id]
  if (!b) {
    throw new Error(`没有 ${id} 的基线，无法确认`)
  }
  if (!b.provenance) {
    throw new Error(`基线 ${id} 来源不明（缺 provenance），拒绝确认`)
  }
  b.provenance.provisional = false
  b.provenance.confirmedAt = opts.confirmedAt ?? new Date().toISOString()
  if (opts.note) b.provenance.note = opts.note
  return db
}

// ── 比较 ─────────────────────────────────────────────────────────────────────

/**
 * 每个可比较维度的方向声明。
 *   'up'   = 当前值 >= 基线值 才合格（越大越好，如 score、token 产出量）
 *   'down' = 当前值 <= 基线值 才合格（越小越好，如 wallMs、costCNY）
 */
const METRIC_DIRECTIONS = {
  outputTokens: 'up',
  wallMs: 'down',
  costCNY: 'down',
  score: 'up',
}

/**
 * L2 比较：当前 perRunMetrics vs 已确认基线。
 *
 * ★ 口径：各维度独立比（min 原则——最保守口径）。
 *   只比 perRunMetrics 中的字段；未声明方向的字段跳过。
 *   任一维度不合格 ⇒ { ok: false, diffs: [...] }
 *   所有维度合格    ⇒ { ok: true, diffs: [] }
 *
 * ★ 基线未确认（provisional）⇒ 返回 null（不参与 L2 判定）。
 * ★ 当前缺某字段 or 基线缺某字段 ⇒ 该字段跳过（不报错）。
 */
export function compareMetrics(currentMetrics, baseline) {
  if (!currentMetrics || typeof currentMetrics !== 'object') {
    return { ok: false, diffs: ['currentMetrics 缺'] }
  }
  if (!baseline || !baseline.perRunMetrics || typeof baseline.perRunMetrics !== 'object') {
    return { ok: false, diffs: ['baseline 缺 perRunMetrics'] }
  }
  if (baseline.provenance?.provisional) {
    return null // 暂估基线，不用于判定
  }

  const bm = baseline.perRunMetrics
  const diffs = []

  for (const [key, direction] of Object.entries(METRIC_DIRECTIONS)) {
    const curVal = currentMetrics[key]
    const baseVal = bm[key]
    if (curVal === undefined || baseVal === undefined) continue // 缺一边就跳过该字段
    if (typeof curVal !== 'number' || typeof baseVal !== 'number') continue

    if (direction === 'up' && curVal < baseVal) {
      diffs.push(`${key} ${curVal} < ${baseVal}（退化，应↑）`)
    } else if (direction === 'down' && curVal > baseVal) {
      diffs.push(`${key} ${curVal} > ${baseVal}（恶化，应↓）`)
    }
  }

  return { ok: diffs.length === 0, diffs }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0]

/**
 * ★ 只在"被当作主模块运行"时派发 CLI（与 `skill-sieve.mjs` 同形）。
 * 被 import 时拿 import 方的 argv 跑自己的 CLI ⇒ 静默截断调用方。
 */
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
if (cmd === 'list') {
  const db = load()
  const ids = Object.keys(db.baselines ?? {})
  console.log(`基线库共 ${ids.length} 条（${FILE}）\n`)
  for (const id of ids) {
    const b = db.baselines[id]
    const tag = b.provenance?.provisional ? '⏳ provisional' : '✅ confirmed'
    const m = b.perRunMetrics ?? {}
    const fields = Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`  ${id.padEnd(24)} ${tag}  ${fields || '(空)'}`)
  }
} else if (cmd === 'get' && argv[1]) {
  const id = argv[1]
  const db = load()
  const b = getBaseline(db, id)
  if (!b) {
    console.log(`无基线（或来源不明）：${id}`)
    process.exit(0)
  }
  const flags = b.provenance.provisional ? ' [provisional]' : ' [confirmed]'
  console.log(`基线${flags}：${id}`)
  console.log(JSON.stringify(b, null, 2))
} else if (cmd === 'set' && argv[1]) {
  const id = argv[1]
  const idx = argv.indexOf('--metrics')
  if (idx < 0) { console.error('用法：set <id> --metrics <json>'); process.exit(1) }
  const metrics = JSON.parse(argv[idx + 1])
  const db = load()
  setBaseline(db, id, metrics)
  save(db)
  console.log(`已写入基线（confirmed）：${id}  ${JSON.stringify(metrics)}`)
} else if (cmd === 'confirm' && argv[1]) {
  const id = argv[1]
  const noteIdx = argv.indexOf('--note')
  const note = noteIdx >= 0 ? argv[noteIdx + 1] : null
  const db = load()
  confirmBaseline(db, id, { note })
  save(db)
  console.log(`已确认基线：${id}`)
} else if (cmd === 'diff' && argv[1]) {
  const id = argv[1]
  const idx = argv.indexOf('--metrics')
  if (idx < 0) { console.error('用法：diff <id> --metrics <json>'); process.exit(1) }
  const cur = JSON.parse(argv[idx + 1])
  const db = load()
  const b = getBaseline(db, id)
  if (!b) { console.log(`无基线：${id}`); process.exit(0) }
  const r = compareMetrics(cur, b)
  if (r === null) {
    console.log(`基线为 provisional，不参与判定`)
  } else {
    console.log(r.ok ? 'OK（未劣化）' : `BLOCKED${r.diffs.length ? ': ' + r.diffs.join('; ') : ''}`)
  }
} else if (cmd === 'ladder') {
  console.log('L2 基线不退化 — 判据口径')
  console.log('  比较对象：perRunMetrics（每次运行都会变的真实度量）')
  console.log('  方向声明：outputTokens↑ wallMs↓ costCNY↓ score↑')
  console.log('  口径：各维度独立用 min 比（fail-closed 最保守）')
  console.log('  来源：provenance.runAt + provisional 必须齐备')
  console.log('  缺基线（无论 signals 是否为零）⇒ blocked')
  console.log('  provisional 基线不参与判定，须人工 confirm 后才生效')
  console.log('  ★ gate 不写基线，基线只能由 eval-baseline-store.mjs CLI 写入（防假绿）')
} else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('\n').slice(1, 18).join('\n'))
}
} // ← 收尾：`if (isMain)`（被 import 时不派发 CLI）
