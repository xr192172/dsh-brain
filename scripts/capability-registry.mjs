#!/usr/bin/env node
/**
 * capability-registry.mjs —— 能力库注册表（P2 数据层）
 *
 * 设计依据：docs/capability-registry-evolution.md
 *   §5.1  lineage：{ id, version, source, acceptance, holdoutHash, registeredAt, supersededBy }
 *   §4    四个动作：注册 / 升级(supersede) / 合并(merge) / 淘汰(retire)
 *   §5.5.2 行为信号（选用 / 复用 / 弃用）是最强信号，且必须分开记
 *   §5.5.3 高选用率 + 低复用率 = 描述过度承诺（一个具体、可检出的失败模式）
 *
 * 本脚本只管【数据层】：记录与校验。判据门（L0~L4）是 P3 的事，这里只留挂载点 acceptance/holdout。
 *
 * 用法：
 *   node scripts/capability-registry.mjs init
 *   node scripts/capability-registry.mjs list [--json]
 *   node scripts/capability-registry.mjs show <id>
 *   node scripts/capability-registry.mjs register <id> --pkg <包名> [--path <相对路径>] [--version <v>]
 *                                     [--provider <provider名>] [--tool <工具名>] [--acceptance <引用>]
 *                                     [--caps a,b,c] [--note <说明>]
 *   node scripts/capability-registry.mjs supersede <oldId> --by <newId> [--reason <r>]
 *   node scripts/capability-registry.mjs retire <id> [--reason <r>]
 *   node scripts/capability-registry.mjs merge <newId> --from <id1,id2> [--reason <r>]
 *   node scripts/capability-registry.mjs signal <id> --kind invoke|reuse|success|failure [--note <s>]
 *   node scripts/capability-registry.mjs check
 */
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const DIR = path.join(HOME, 'capabilities')
const FILE = path.join(DIR, 'registry.json')
const SCHEMA = 'dsh-capability-registry/v1'

// ── 存储 ─────────────────────────────────────────────────────────────────────

function emptyDb() {
  return { schema: SCHEMA, updatedAt: new Date().toISOString(), capabilities: [], history: [] }
}

function load() {
  if (!fs.existsSync(FILE)) return emptyDb()
  try {
    const db = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (!Array.isArray(db.capabilities)) return emptyDb()
    return db
  } catch (e) {
    console.error(`X registry.json 解析失败：${e.message}`)
    process.exit(1)
  }
}

/** 原子写：先写 .tmp 再 rename，避免半截文件。 */
function save(db) {
  db.schema = SCHEMA
  db.updatedAt = new Date().toISOString()
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, FILE)
}

function record(db, action, payload) {
  db.history = db.history ?? []
  db.history.push({ at: new Date().toISOString(), action, ...payload })
  if (db.history.length > 500) db.history = db.history.slice(-500)
}

const find = (db, id) => db.capabilities.find((c) => c.id === id)

// ── 参数解析 ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0]
function opt(name, def = undefined) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1]?.startsWith('--')))

// ── 能力记录工厂 ────────────────────────────────────────────────────────────

function newCapability(o) {
  return {
    id: o.id,
    kind: o.kind ?? 'subagent-provider',
    version: o.version ?? '0.1.0',
    source: {
      package: o.package ?? null,
      path: o.path ?? null,
      provider: o.provider ?? null,   // 注册进 ctx.subagents 的名字
      tool: o.tool ?? null,           // 模型看到的工具名
      seat: o.seat ?? null,
    },
    capabilities: o.capabilities ?? null,
    acceptance: {
      kind: o.acceptance ? 'ref' : 'none',
      ref: o.acceptance ?? null,
      status: 'unknown',
      ranAt: null,
    },
    holdoutHash: null,
    status: 'active',
    registeredAt: new Date().toISOString(),
    supersededBy: null,
    retiredReason: null,
    lineage: [{ version: o.version ?? '0.1.0', at: new Date().toISOString(), action: 'register' }],
    signals: { invoked: 0, reused: 0, succeeded: 0, failed: 0, lastUsedAt: null, notes: [] },
  }
}

// ── 命令 ────────────────────────────────────────────────────────────────────

const KNOWN = [
  { id: 'spawn', package: '@deepseek-ai/dsh-subagent-spawn-in-process', provider: 'spawn', tool: 'subagent', seat: 'upstream' },
  { id: 'fork', package: '@deepseek-ai/dsh-subagent-fork-in-process', provider: 'fork', tool: 'subagent_fork', seat: 'upstream' },
  { id: 'council-architect', package: '@dsh-brain/subagent-council', path: 'packages/subagent-council', provider: 'council-architect', tool: 'council_architect', seat: 'architect' },
]

if (cmd === 'init') {
  const db = load()
  let added = 0
  for (const k of KNOWN) {
    if (find(db, k.id)) continue
    const cap = newCapability({
      id: k.id, package: k.package, path: k.path, provider: k.provider, tool: k.tool, seat: k.seat,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    })
    if (k.id === 'council-architect') {
      cap.acceptance = { kind: 'ref', ref: 'docs/subagent-provider-howto.md §5（重启后：工具清单出现 council_architect）', status: 'passed', ranAt: new Date().toISOString() }
      cap.signals.notes.push('2026-09-14 首次真实委派通过（session-c0f05cde）')
    }
    db.capabilities.push(cap)
    record(db, 'register', { id: k.id, via: 'init' })
    added++
  }
  save(db)
  console.log(`init 完成：新增 ${added} 条，当前共 ${db.capabilities.length} 条`)
  console.log(`文件：${FILE}`)
} else if (cmd === 'list') {
  const db = load()
  if (opt('json')) { console.log(JSON.stringify(db, null, 2)); process.exit(0) }
  console.log(`能力库（${db.capabilities.length} 条）  更新于 ${db.updatedAt}\n`)
  const pad = (s, n) => String(s ?? '-').padEnd(n)
  console.log(`  ${pad('id', 24)} ${pad('status', 11)} ${pad('ver', 8)} ${pad('tool', 22)} 选用/复用/成/败  判据`)
  for (const c of db.capabilities) {
    const s = c.signals ?? {}
    const acc = c.acceptance?.status === 'passed' ? '✅' : c.acceptance?.kind === 'none' ? '—' : '?'
    console.log(`  ${pad(c.id, 24)} ${pad(c.status, 11)} ${pad(c.version, 8)} ${pad(c.source?.tool, 22)} ${s.invoked ?? 0}/${s.reused ?? 0}/${s.succeeded ?? 0}/${s.failed ?? 0}  ${acc}`)
  }
  console.log('\n  （选用/复用/成功/失败 = 行为信号；高选用 + 低复用 = 描述过度承诺）')
} else if (cmd === 'show') {
  const db = load()
  const c = find(db, positional[0])
  if (!c) { console.error('未找到 ' + positional[0]); process.exit(1) }
  console.log(JSON.stringify(c, null, 2))
} else if (cmd === 'register') {
  const id = positional[0]
  if (!id) { console.error('用法：register <id> --pkg <包名>'); process.exit(1) }
  const db = load()
  if (find(db, id)) { console.error(`X 已存在：${id}（升级请用 supersede，合并请用 merge）`); process.exit(1) }
  const caps = opt('caps') ? Object.fromEntries(String(opt('caps')).split(',').map((k) => [k, true])) : null
  const cap = newCapability({
    id, package: opt('pkg'), path: opt('path'), provider: opt('provider') ?? id,
    tool: opt('tool'), seat: opt('seat'), version: opt('version'), acceptance: opt('acceptance'), capabilities: caps,
  })
  if (opt('note')) cap.signals.notes.push(String(opt('note')))
  db.capabilities.push(cap)
  record(db, 'register', { id })
  save(db)
  console.log(`已注册：${id}  （来源 ${cap.source.package ?? '?'}）`)
} else if (cmd === 'supersede') {
  const oldId = positional[0]
  const by = opt('by')
  const db = load()
  const old = find(db, oldId)
  const nw = by ? find(db, by) : null
  if (!old) { console.error('未找到 ' + oldId); process.exit(1) }
  if (by && !nw) { console.error('未找到新能力 ' + by); process.exit(1) }
  old.status = 'superseded'
  old.supersededBy = by ?? null
  old.retiredReason = opt('reason') ?? null
  if (nw) nw.lineage.push({ version: nw.version, at: new Date().toISOString(), action: 'superseded-from', from: oldId })
  record(db, 'supersede', { from: oldId, to: by ?? null, reason: opt('reason') ?? null })
  save(db)
  console.log(`已升级：${oldId} → ${by ?? '(未指定新 id)'}`)
} else if (cmd === 'retire') {
  const id = positional[0]
  const db = load()
  const c = find(db, id)
  if (!c) { console.error('未找到 ' + id); process.exit(1) }
  c.status = 'retired'
  c.retiredReason = opt('reason') ?? null
  record(db, 'retire', { id, reason: opt('reason') ?? null })
  save(db)
  console.log(`已淘汰：${id}${opt('reason') ? '  理由：' + opt('reason') : ''}`)
} else if (cmd === 'merge') {
  const newId = positional[0]
  const from = String(opt('from') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const db = load()
  if (!newId || from.length < 2) { console.error('用法：merge <newId> --from <id1,id2>'); process.exit(1) }
  if (find(db, newId)) { console.error('新 id 已存在：' + newId); process.exit(1) }
  for (const f of from) {
    const c = find(db, f)
    if (!c) { console.error('未找到 ' + f); process.exit(1) }
    c.status = 'merged'
    c.supersededBy = newId
  }
  const cap = newCapability({ id: newId, kind: 'subagent-provider', version: '0.1.0' })
  cap.lineage.push({ version: '0.1.0', at: new Date().toISOString(), action: 'merged-from', from })
  cap.signals.notes.push('合并前必须在【两个各自的 holdout】上都过，否则是用 A 的强项掩盖 B 的退步。')
  db.capabilities.push(cap)
  record(db, 'merge', { into: newId, from })
  save(db)
  console.log(`已合并：${from.join(' + ')} → ${newId}`)
  console.log('⚠️ 待办：在两个 holdout 上各自验证（P3 注册门）')
} else if (cmd === 'signal') {
  const id = positional[0]
  const kind = opt('kind')
  const db = load()
  const c = find(db, id)
  if (!c) { console.error('未找到 ' + id); process.exit(1) }
  const map = { invoke: 'invoked', reuse: 'reused', success: 'succeeded', failure: 'failed' }
  const key = map[kind]
  if (!key) { console.error('--kind 必须是 invoke|reuse|success|failure'); process.exit(1) }
  c.signals[key] = (c.signals[key] ?? 0) + 1
  c.signals.lastUsedAt = new Date().toISOString()
  if (opt('note')) {
    c.signals.notes.push(String(opt('note')))
    if (c.signals.notes.length > 50) c.signals.notes = c.signals.notes.slice(-50)
  }
  record(db, 'signal', { id, kind })
  save(db)
  const s = c.signals
  const ratio = s.invoked ? (s.reused / s.invoked).toFixed(2) : 'n/a'
  console.log(`${id}: ${key}=${s[key]}  复用率=${ratio}`)
} else if (cmd === 'check') {
  const db = load()
  const problems = []
  const ids = new Set()
  for (const c of db.capabilities) {
    if (ids.has(c.id)) problems.push(`重复 id：${c.id}`)
    ids.add(c.id)
    if (c.supersededBy && !find(db, c.supersededBy)) problems.push(`${c.id}.supersededBy 指向不存在的能力：${c.supersededBy}`)
    if (c.status === 'active' && !c.acceptance?.ref) problems.push(`${c.id} 处于 active 但没有任何 acceptance 引用（P3 注册门会拒绝这种）`)
    const s = c.signals ?? {}
    if ((s.invoked ?? 0) >= 3 && (s.reused ?? 0) === 0) problems.push(`${c.id} 选用 ${s.invoked} 次、复用 0 次 → 疑似「描述过度承诺」`)
  }
  console.log(`能力库校验：${db.capabilities.length} 条`)
  if (!problems.length) console.log('  ✅ 无问题')
  else for (const p of problems) console.log('  ⚠️ ' + p)
} else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('\n').slice(1, 26).join('\n'))
}
