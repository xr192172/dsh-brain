#!/usr/bin/env node
/**
 * pending-approval.mjs —— R0/R1 的「待批记录 + 一句确认」载体（O107）
 *
 * ★★ 一句话：**R1/R0 类改动不自动续跑 —— 留一条待批记录，等外部一句确认后再续。**
 *    语义原典：`docs/handover-vs-restart.md:232-265` §6.2「无环原则（acyclic approval）」
 *      R2 能力层 ⇒ 判据阶梯（自动）        ⇒ ✅ 自动续跑
 *      R1 判据层 ⇒ 外部（人/独立见证）      ⇒ ❌ 留一条待批记录，等外部确认后再续
 *      R0 自举层 ⇒ 外部 + 自举性检验        ⇒ ❌ 同上
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 消费侧约定（**这就是"不自动续跑"的落地**；给未来调用者用）
 *
 *   任何 **R1 / R0 类**改动，**在【续跑之前】必须先过这道检查**：
 *
 *       node scripts/pending-approval.mjs gate --level R1        # 或 --level R0
 *
 *       有待批记录 ⇒ **非零退出（拦住）**；没有 ⇒ **exit 0（放行）**
 *       R2 类改动 **不产生待批记录**，直接放行（gate 对 R2 恒 exit 0）。
 *
 *   ⇒ 也就是：**"能不能自动继续"这件事，不由发起者声明，而由"有没有未批记录"决定。**
 *   ⇒ 完整链路（本轮端到端演示的就是这条）：
 *        ① `node scripts/change-classify.mjs`                    → 判出 R0/R1/R2（只看路径）
 *        ② 若 R1/R0：`node scripts/pending-approval.mjs record --level R1 --note "<一句话>" --paths <...>`
 *        ③ 续跑前： `... gate --level R1`                        → 有记录 ⇒ 退出码 1（拦住）
 *        ④ 外部确认：`... approve <id> --by <谁> [--note "<一句>"]` → 打印"可以续跑"
 *        ⑤ 再 gate： `... gate --level R1`                       → exit 0（放行）
 *
 * ★ 本脚本**刻意做在控制面之外**（`scripts/` + `out/pending-approval/`），
 *   以便本轮改动自身落在 R2（可自动）—— 代价与自指风险见报告 `out/w39-o106-o107.md`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 记录格式（★ 目录/格式在此写清；报告里也逐字复述）
 *
 *   目录：`out/pending-approval/`（可用 `--dir` 覆盖）
 *   文件：`records.jsonl` —— **append-only 的 JSONL**（一行一条，只追加，绝不改写历史）
 *   两行形状（都带同一 `id`）：
 *
 *     {"schema":"dsh-pending-approval/v1","kind":"record","id":"pa-20260923-a1b2c3",
 *      "level":"R1","status":"pending","note":"<一句话>","paths":["evals/checks/cli-0004.mjs"],
 *      "by":"cli","at":"2026-09-23T06:00:00.000Z","source":"record"}
 *
 *     {"schema":"dsh-pending-approval/v1","kind":"approve","id":"pa-20260923-a1b2c3",
 *      "status":"approved","approvedBy":"<谁>","note":"<一句确认>","at":"2026-09-23T06:05:00.000Z"}
 *
 *   ⇒ `status` 由 **fold 全部行**得到（后出现的 approve 生效）⇒ append-only 也能表达状态迁移，
 *     且"谁在什么时候批的"永远留着（含时间与来源）。
 *
 * 退出码：0 = 成功/放行；1 = **gate 拦住**（有待批记录）；3 = 用法/IO 错或**拒绝记录**。
 *   ★ 1 与 3 分开：让"被规则拦住"和"命令用错/读不到"在 CI 里可区分。
 *
 * 依赖：只用 node 标准库 + 同目录的 `change-classify.mjs`（层级推断的**单一来源**）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { classifyPaths } from './change-classify.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const SCHEMA = 'dsh-pending-approval/v1'
const DEFAULT_DIR = path.join(ROOT, 'out', 'pending-approval')
const FILE_NAME = 'records.jsonl'

const LEVELS = ['R0', 'R1', 'R2']
const STRICTNESS = { R0: 0, R1: 1, R2: 2 }

/**
 * ★ 「更严」的集合：`gate --level L` 要拦住的，是**比 L 更严或同严**的待批记录。
 *   R0 的记录只由 R0 的 gate 拦；R1 的 gate 同时拦 R0+R1（有未批的自举层改动 ⇒ 更不能自动续）。
 */
function blockingLevels(level) {
  if (level === 'R0') return ['R0']
  if (level === 'R1') return ['R0', 'R1']
  return []
}

const USAGE = `pending-approval.mjs —— R0/R1 的「待批记录 + 一句确认」（O107）

用法（五条命令）：
  record --level <R0|R1> --note "<一句话>" [--paths <p1,p2>] [--by <谁>] [--fingerprint <hex>]
  list   [--level <L>] [--all] [--json]
  show   <id> [--json]
  approve <id> [--by <谁>] [--note "<一句确认>"]
  gate   --level <R0|R1|R2> [--paths <p1,p2>] [--json]

通用：--dir <目录>（缺省 out/pending-approval）  --help

退出码：0 = 成功/放行；1 = gate 拦住（有待批记录）；3 = 用法/IO 错或拒绝记录
★ 消费侧约定：R1/R0 类改动在续跑前必须先过 \`gate\`；有待批记录 ⇒ 非零退出（拦住）。
`

// ─────────────────────────────────────────────────────────────────────────────
// store（append-only JSONL）
// ─────────────────────────────────────────────────────────────────────────────

function storeFile(dir) {
  return path.join(dir, FILE_NAME)
}

/**
 * 读全部行。坏行**不静默吞掉** —— 计数并原样保留（append-only 的历史不允许被"修好"）。
 * @returns {{entries:object[], corrupt:{line:number, text:string}[]}}
 */
function readAll(dir) {
  const file = storeFile(dir)
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], corrupt: [] }
    throw e
  }
  const entries = []
  const corrupt = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.trim() === '') return
    try {
      const o = JSON.parse(line)
      if (o && typeof o === 'object' && typeof o.id === 'string') entries.push(o)
      else corrupt.push({ line: i + 1, text: line.slice(0, 200) })
    } catch {
      corrupt.push({ line: i + 1, text: line.slice(0, 200) })
    }
  })
  return { entries, corrupt }
}

function appendLine(dir, obj) {
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(storeFile(dir), `${JSON.stringify(obj)}\n`, 'utf8')
}

/** fold 全部行为按 id 的记录（后出现的 approve 生效）。 */
function foldRecords(entries) {
  const map = new Map()
  for (const e of entries) {
    let r = map.get(e.id)
    if (!r) {
      r = {
        id: e.id,
        level: e.level ?? null,
        status: 'pending',
        note: e.note ?? '',
        paths: Array.isArray(e.paths) ? e.paths : [],
        fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : null,
        by: e.by ?? null,
        createdAt: e.at ?? null,
        approvedBy: null,
        approvedAt: null,
        approveNote: null,
        history: [],
      }
      map.set(e.id, r)
    }
    r.history.push(e)
    if (e.kind === 'approve' || e.status === 'approved') {
      r.status = 'approved'
      r.approvedBy = e.approvedBy ?? r.approvedBy
      r.approvedAt = e.at ?? r.approvedAt
      r.approveNote = e.note ?? r.approveNote
      if (r.level === null) r.level = e.level ?? null
    } else if (e.level && r.level === null) {
      r.level = e.level
    }
  }
  return [...map.values()].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
}

function newId() {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `pa-${ymd}-${crypto.randomBytes(3).toString('hex')}`
}

const now = () => new Date().toISOString()

// ─────────────────────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const flags = { _: [] }
  const takesValue = new Set(['level', 'note', 'paths', 'by', 'dir', 'fingerprint'])
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      flags._.push(a)
      continue
    }
    const eq = a.includes('=') ? a.indexOf('=') : -1
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    if (key === 'all' || key === 'json' || key === 'help') {
      if (eq > 0) throw new Error(`--${key} 不接受取值`)
      flags[key] = true
      continue
    }
    if (!takesValue.has(key)) throw new Error(`未知参数 "--${key}"`)
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (val === undefined) throw new Error(`参数 --${key} 缺少取值`)
    if (key === 'paths') {
      flags.paths = flags.paths ?? []
      for (const one of String(val).split(',')) if (one.trim() !== '') flags.paths.push(one.trim())
    } else {
      flags[key] = val
    }
  }
  flags.dir = path.resolve(ROOT, flags.dir ?? DEFAULT_DIR)
  return flags
}

function requireLevel(raw, { allowR2 = true } = {}) {
  const l = String(raw ?? '').toUpperCase()
  if (!LEVELS.includes(l)) throw new Error(`--level 必须是 R0 / R1 之一（实收 ${JSON.stringify(raw)}）`)
  if (!allowR2 && l === 'R2') {
    throw new Error(
      '拒绝：R2 不产生待批记录（R2 = 能力层 ⇒ 判据阶梯自动 ⇒ 直接放行）。' +
        '★ 若你认为这次改动是 R2，请直接跑 `gate --level R2`；若它其实是 R1/R0，请如实填 R1/R0。',
    )
  }
  return l
}

/**
 * ★ 反"自己给自己降级"：给了 `--paths` ⇒ 用 `change-classify` 复核声明的级别，
 *   **声明的级别不得比按路径推断的更宽**（§6.2 写死条文①：层级标签不能由发起者自己填）。
 */
function reconcileLevel(declared, paths) {
  if (!paths || paths.length === 0) return { level: declared, inferred: null, note: null }
  const inferred = classifyPaths(paths)
  if (STRICTNESS[declared] > STRICTNESS[inferred.level]) {
    throw new Error(
      `拒绝：声明的级别 ${declared} 比【按路径推断】的 ${inferred.level} 更宽 —— ` +
        '层级不能由发起者自己降级（§6.2 写死条文①）。' +
        `推断理由：${inferred.reasons.join(' ；')}`,
    )
  }
  const note =
    STRICTNESS[declared] < STRICTNESS[inferred.level]
      ? `声明 ${declared} 严于按路径推断的 ${inferred.level} ⇒ 按更严的 ${declared} 记录`
      : `声明与按路径推断一致（${declared}）`
  return { level: declared, inferred: inferred.level, note }
}

// ─────────────────────────────────────────────────────────────────────────────
// 命令
// ─────────────────────────────────────────────────────────────────────────────

function cmdRecord(flags) {
  if (!flags.note || String(flags.note).trim() === '') throw new Error('record 需要 --note "<一句话>"（这是给人看的那一句）')
  const declared = requireLevel(flags.level, { allowR2: false })
  const rec = reconcileLevel(declared, flags.paths)
  // ★ 可选的内容指纹（加法式：不给就是 null ⇒ 老行为一字不变）
  let fingerprint = null
  if (flags.fingerprint !== undefined && flags.fingerprint !== null && String(flags.fingerprint).trim() !== '') {
    const fp = String(flags.fingerprint).trim().toLowerCase()
    if (!/^[0-9a-f]{16,128}$/.test(fp)) throw new Error(`--fingerprint 必须是 16~128 位 hex（实收 ${JSON.stringify(flags.fingerprint)}）`)
    fingerprint = fp
  }
  const id = newId()
  const entry = {
    schema: SCHEMA,
    kind: 'record',
    id,
    level: rec.level,
    status: 'pending',
    note: String(flags.note).trim(),
    paths: flags.paths ?? [],
    ...(fingerprint ? { fingerprint } : {}),
    by: flags.by ?? 'cli',
    at: now(),
    source: 'record',
  }
  appendLine(flags.dir, entry)
  const out = {
    ok: true,
    id,
    level: entry.level,
    status: 'pending',
    fingerprint,
    file: path.relative(ROOT, storeFile(flags.dir)).replace(/\\/g, '/'),
    inferred: rec.inferred,
    reconcile: rec.note,
    next: `node scripts/pending-approval.mjs gate --level ${entry.level}`,
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
  process.stdout.write(
    `⇒ 已留一条待批记录 ${id}（级别 ${entry.level}）—— ★ 现在 ` +
      `\`gate --level ${entry.level}\` 会【拦住】（非零退出），直到有人 \`approve ${id}\`。\n`,
  )
  return 0
}

function cmdList(flags) {
  const { entries, corrupt } = readAll(flags.dir)
  let all = foldRecords(entries)
  if (flags.level) all = all.filter((r) => r.level === String(flags.level).toUpperCase())
  const shown = flags.all ? all : all.filter((r) => r.status === 'pending')
  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        dir: path.relative(ROOT, flags.dir).replace(/\\/g, '/'),
        total: all.length,
        pending: all.filter((r) => r.status === 'pending').length,
        approved: all.filter((r) => r.status === 'approved').length,
        corruptLines: corrupt.length,
        records: shown,
      })}\n`,
    )
    return 0
  }
  process.stdout.write('════════════════════════════════════════════════════════════════════════\n')
  process.stdout.write(`pending-approval —— 待批记录（append-only: ${path.relative(ROOT, storeFile(flags.dir)).replace(/\\/g, '/')}）\n`)
  process.stdout.write(
    `  全部 ${all.length} ／ 待批 ${all.filter((r) => r.status === 'pending').length} ／ 已批 ${all.filter((r) => r.status === 'approved').length}` +
      `${corrupt.length > 0 ? ` ／ ★ 坏行 ${corrupt.length}` : ''}${flags.all ? '' : '（只列待批；--all 看全部）'}\n`,
  )
  process.stdout.write('════════════════════════════════════════════════════════════════════════\n')
  if (shown.length === 0) {
    process.stdout.write('  （没有待批记录 ⇒ `gate --level R1` / `--level R0` 会放行）\n')
    return 0
  }
  for (const r of shown) {
    process.stdout.write(
      `  [${String(r.status).padEnd(8)}] ${r.id}  ${String(r.level).padEnd(3)} ${r.createdAt ?? ''}  by:${r.by ?? '-'}  ${r.note}\n`,
    )
    if (r.paths.length > 0) process.stdout.write(`             paths: ${r.paths.join(', ')}\n`)
    if (r.status === 'approved') process.stdout.write(`             approvedBy: ${r.approvedBy ?? '-'} @ ${r.approvedAt ?? '-'}\n`)
  }
  return 0
}

function cmdShow(flags) {
  const id = flags._[0]
  if (!id) throw new Error('show 需要 <id>')
  const { entries } = readAll(flags.dir)
  const rec = foldRecords(entries).find((r) => r.id === id)
  if (!rec) {
    process.stderr.write(`找不到待批记录 ${id}（目录 ${path.relative(ROOT, flags.dir).replace(/\\/g, '/')}）\n`)
    return 3
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, record: rec })}\n`)
    return 0
  }
  process.stdout.write(`${JSON.stringify({ ok: true, record: rec, historyLines: rec.history.length }, null, 2)}\n`)
  return 0
}

function cmdApprove(flags) {
  const id = flags._[0]
  if (!id) throw new Error('approve 需要 <id>')
  const { entries } = readAll(flags.dir)
  const rec = foldRecords(entries).find((r) => r.id === id)
  if (!rec) {
    process.stderr.write(`找不到待批记录 ${id} ⇒ 不批（拒绝凭空批准一个不存在的记录）\n`)
    return 3
  }
  if (rec.status === 'approved') {
    process.stdout.write(
      `${JSON.stringify({ ok: true, id, status: 'already-approved', approvedBy: rec.approvedBy, approvedAt: rec.approvedAt })}\n`,
    )
    process.stdout.write(`⇒ ${id} 早已被 ${rec.approvedBy ?? '未知来源'} 于 ${rec.approvedAt ?? '未知时间'} 确认 ⇒ 可以续跑。\n`)
    return 0
  }
  const by = flags.by ?? process.env.USERNAME ?? process.env.USER ?? 'human'
  const entry = {
    schema: SCHEMA,
    kind: 'approve',
    id,
    level: rec.level,
    status: 'approved',
    approvedBy: by,
    note: flags.note ?? '',
    at: now(),
  }
  appendLine(flags.dir, entry)
  process.stdout.write(
    `${JSON.stringify({ ok: true, id, level: rec.level, status: 'approved', approvedBy: by, approvedAt: entry.at })}\n`,
  )
  process.stdout.write(`⇒ ${id} 已被【外部】确认（来源 ${by} @ ${entry.at}）⇒ 可以续跑。\n`)
  process.stdout.write(`   复核：node scripts/pending-approval.mjs gate --level ${rec.level}\n`)
  return 0
}

function cmdGate(flags) {
  if (!flags.level && !(flags.paths && flags.paths.length > 0)) {
    throw new Error('gate 需要 --level <R0|R1|R2>（或给 --paths 让它自己推断）')
  }
  let level
  let reconcile = null
  if (flags.level) {
    level = requireLevel(flags.level)
    const rec = reconcileLevel(level, flags.paths)
    level = rec.level
    reconcile = rec.inferred ? `声明 ${rec.level} / 按路径推断 ${rec.inferred}：${rec.note}` : null
  } else {
    const inf = classifyPaths(flags.paths)
    level = inf.level
    reconcile = `未声明 --level；按 --paths 推断 ⇒ ${level}`
  }

  const { entries, corrupt } = readAll(flags.dir)
  const all = foldRecords(entries)

  if (level === 'R2') {
    const out = {
      ok: true,
      gate: 'PASS',
      level,
      blocking: [],
      dir: path.relative(ROOT, flags.dir).replace(/\\/g, '/'),
      reconcile,
    }
    process.stdout.write(`${JSON.stringify(out)}\n`)
    process.stdout.write('⇒ 放行（exit 0）：R2 = 能力层 ⇒ 判据阶梯自动 ⇒ 不产生待批记录、不需要外部见证。\n')
    return 0
  }

  const levels = blockingLevels(level)
  const blocking = all.filter((r) => r.status === 'pending' && levels.includes(r.level))
  const out = {
    ok: blocking.length === 0,
    gate: blocking.length === 0 ? 'PASS' : 'BLOCKED',
    level,
    blockingLevels: levels,
    blocking: blocking.map((r) => ({ id: r.id, level: r.level, createdAt: r.createdAt, note: r.note, paths: r.paths })),
    pendingTotal: all.filter((r) => r.status === 'pending').length,
    corruptLines: corrupt.length,
    dir: path.relative(ROOT, flags.dir).replace(/\\/g, '/'),
    reconcile,
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
  if (blocking.length === 0) {
    process.stdout.write(`⇒ 放行（exit 0）：${level} 级没有未批的待批记录 ⇒ 可以续跑。\n`)
    return 0
  }
  process.stdout.write(`★★ 拦住（exit 1）：${level} 级有 ${blocking.length} 条未批记录 ⇒ **不自动续跑**（§6.2 无环原则）。\n`)
  for (const r of blocking) process.stdout.write(`     ${r.id}  [${r.level}] ${r.note}\n`)
  process.stdout.write(`   外部确认后放行：node scripts/pending-approval.mjs approve ${blocking[0].id} --by <谁>\n`)
  return 1
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main(argv) {
  let flags
  try {
    flags = parseArgv(argv)
  } catch (e) {
    process.stderr.write(`pending-approval 用法错误：${e.message}\n\n${USAGE}`)
    return 3
  }
  if (flags.help || flags._.length === 0) {
    process.stdout.write(USAGE)
    return flags.help ? 0 : 3
  }
  const cmdRaw = flags._.shift()
  try {
    switch (cmdRaw) {
      case 'record':
        return cmdRecord(flags)
      case 'list':
        return cmdList(flags)
      case 'show':
        return cmdShow(flags)
      case 'approve':
        return cmdApprove(flags)
      case 'gate':
        return cmdGate(flags)
      default:
        process.stderr.write(`未知命令 "${cmdRaw}"\n\n${USAGE}`)
        return 3
    }
  } catch (e) {
    process.stderr.write(`pending-approval 拒绝/失败：${e.message}\n`)
    return 3
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  process.exit(main(process.argv.slice(2)))
}
