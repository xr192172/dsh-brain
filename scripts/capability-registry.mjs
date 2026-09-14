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

/**
 * ★ 外部能力源（非 subagent provider）：MCP server / 工具插件。
 *
 * 为什么必须登记它们：**模型手里大部分工具来自 MCP** —— design-canvas 一家就 60 个。
 * 只登记 subagent provider 的能力库，给模型的是**半个答案**。
 *
 * 而且 design-canvas 自带 `capability_map`（6 条能力线 / direct 直调白名单），
 * 它**已经在做工具层的能力导航** —— 我们应当**对接而不是重复造**：
 *   · 我们的 `list_capabilities` 给**跨源总览**（委派能力 + 工具能力源）
 *   · 它的 `capability_map` 给它自己**内部的线级导航**
 *   · 桥接方式：总览里点名"design-canvas：6 条能力线，细节调 capability_map"
 *
 * 附带价值：`capability_map` 的线目录是**手工同步**的静态表（它自己的注释承认），
 * 必然漂移。本脚本把漂移变成**可检出**的（见 scanMcpSource / check）。
 */
const MCP_SOURCES = [
  {
    id: 'design-canvas',
    kind: 'mcp-server',
    label: '设计画布（人机共享可视化 MCP：DSL → 自包含 HTML）',
    repo: 'D:/project_develop/design-canvas',
    entry: 'D:/project_develop/design-canvas/dist/src/server.js',
    registryFile: 'src/server_registry.ts',
    laneFile: 'src/tools/capability_map.ts',
    navTool: 'capability_map',
    transport: 'stdio',
  },
]

/** 扫一个 MCP 源的"工具面"：实际注册的工具 + 能力线目录 + 漂移。 */
function scanMcpSource(m) {
  const out = { toolCount: 0, laneCount: 0, lanes: [], laneToolCount: 0, directCount: 0, drift: null, scannedAt: new Date().toISOString() }
  try {
    const reg = fs.readFileSync(path.join(m.repo, m.registryFile), 'utf8')
    const cm = fs.readFileSync(path.join(m.repo, m.laneFile), 'utf8')

    const registered = new Set([...reg.matchAll(/^\s*name:\s*'([a-z][a-z0-9_]*)'/gm)].map((x) => x[1]))
    const inLanes = new Set([...cm.matchAll(/\{\s*name:\s*'([a-z][a-z0-9_]*)'/g)].map((x) => x[1]))
    const direct = new Set([...cm.matchAll(/direct:\s*\[([^\]]*)\]/g)].flatMap((x) =>
      [...x[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((y) => y[1])))
    const lanes = [...cm.matchAll(/^\s*id:\s*'([a-z]+)',/gm)].map((x) => x[1])

    out.toolCount = registered.size
    out.laneCount = lanes.length
    out.lanes = lanes
    out.laneToolCount = inLanes.size
    out.directCount = direct.size
    out.drift = {
      // 已注册但没进任何线 —— 靠 capability_map 导航的 agent 看不见它们
      registeredNotInLanes: [...registered].filter((x) => !inLanes.has(x)).sort(),
      // 线里写了但没注册 —— 陈旧条目，会把 agent 指向不存在的工具
      inLanesNotRegistered: [...inLanes].filter((x) => !registered.has(x)).sort(),
      // 导航工具自身不算漏收
      exempt: [m.navTool],
    }
  } catch (e) {
    out.error = e.message
  }
  return out
}

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
  // ── 外部能力源（MCP server / 工具插件）：工具层能力 ──
  for (const m of MCP_SOURCES) {
    const scan = scanMcpSource(m)
    let cap = find(db, m.id)
    const isNew = !cap
    if (isNew) cap = newCapability({ id: m.id, kind: m.kind, version: '0.0.0' })
    cap.kind = m.kind
    cap.label = m.label
    cap.source = {
      package: null, path: m.repo, provider: null, tool: m.navTool, seat: null,
      transport: m.transport, entry: m.entry,
    }
    cap.tooling = scan
    if (isNew) {
      cap.signals.notes.push(
        `工具面：${scan.toolCount} 个工具 / ${scan.laneCount} 条能力线（${scan.lanes.join(', ')}）` +
        (scan.drift?.registeredNotInLanes?.length
          ? `；${scan.drift.registeredNotInLanes.length} 个工具未进任何能力线`
          : ''),
      )
      db.capabilities.push(cap)
      record(db, 'register', { id: m.id, via: 'init:mcp' })
      added++
    } else {
      record(db, 'sync-tooling', { id: m.id, toolCount: scan.toolCount, laneToolCount: scan.laneToolCount })
    }
  }

  save(db)
  console.log(`init 完成：新增 ${added} 条，当前共 ${db.capabilities.length} 条`)
  console.log(`文件：${FILE}`)
} else if (cmd === 'list') {
  const db = load()
  if (opt('json')) { console.log(JSON.stringify(db, null, 2)); process.exit(0) }
  console.log(`能力库（${db.capabilities.length} 条）  更新于 ${db.updatedAt}\n`)
  const pad = (s, n) => String(s ?? '-').padEnd(n)
  console.log(`  ${pad('id', 24)} ${pad('kind', 17)} ${pad('status', 11)} ${pad('ver', 8)} ${pad('工具面', 26)} 选用/复用/成/败  判据`)
  for (const c of db.capabilities) {
    const s = c.signals ?? {}
    const acc = c.acceptance?.status === 'passed' ? 'pass'
      : (!c.acceptance?.ref || c.acceptance?.kind === 'none') ? 'MISSING' : '?'
    const face = c.tooling
      ? `${c.tooling.toolCount} 工具 / ${c.tooling.laneCount} 线`
      : String(c.source?.tool ?? '-')
    console.log(`  ${pad(c.id, 24)} ${pad(c.kind, 17)} ${pad(c.status, 11)} ${pad(c.version, 8)} ${pad(face, 26)} ${s.invoked ?? 0}/${s.reused ?? 0}/${s.succeeded ?? 0}/${s.failed ?? 0}  ${acc}`)
  }
  console.log('\n  （选用/复用/成功/失败 = 行为信号；高选用 + 低复用 = 描述过度承诺）')
  console.log('  （kind=subagent-provider 是委派层能力；kind=mcp-server 是工具层能力源）')
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

  // ★ 工具层能力源：实时重扫工具面，检出「能力线目录 vs 实际注册」的漂移
  for (const m of MCP_SOURCES) {
    const c = find(db, m.id)
    if (!c || c.status !== 'active') continue
    const scan = scanMcpSource(m)
    if (scan.error) { problems.push(`${m.id} 工具面扫描失败：${scan.error}`); continue }
    const d = scan.drift ?? {}
    const missed = (d.registeredNotInLanes ?? []).filter((x) => x !== m.navTool)
    if (missed.length) {
      problems.push(
        `${m.id}: ${missed.length} 个已注册工具**没进任何能力线** → 靠 ${m.navTool} 导航的 agent 看不见它们：${missed.join(', ')}`,
      )
    }
    if ((d.inLanesNotRegistered ?? []).length) {
      problems.push(`${m.id}: 能力线里有 ${d.inLanesNotRegistered.length} 条**陈旧条目**（工具已不存在）：${d.inLanesNotRegistered.join(', ')}`)
    }
    if (c.tooling && c.tooling.toolCount !== scan.toolCount) {
      problems.push(`${m.id}: 工具数从 ${c.tooling.toolCount} 变成 ${scan.toolCount}（registry 未同步）`)
    }
  }

  console.log(`能力库校验：${db.capabilities.length} 条`)
  if (!problems.length) console.log('  ✅ 无问题')
  else for (const p of problems) console.log('  ⚠️ ' + p)
} else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('\n').slice(1, 26).join('\n'))
}
