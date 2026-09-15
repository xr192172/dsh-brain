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
 * 本脚本只管【数据层】：记录与校验。判据门（L0~L4）在 scripts/capability-gate.mjs（P3）。
 *   ★ 注册 ≠ 采纳：register/init 只创建 `pending`；只有注册门跑过并把回执写进 acceptance，
 *     该能力才转 `active`。acceptance.kind 只认 `'gate'`，散文引用不被当作判据。
 *
 * 用法：
 *   node scripts/capability-registry.mjs init
 *   node scripts/capability-registry.mjs list [--json]
 *   node scripts/capability-registry.mjs show <id>
 *   node scripts/capability-registry.mjs register <id> --pkg <包名> [--path <相对路径>] [--version <v>]
 *                                     [--provider <provider名>] [--tool <工具名>]
 *                                     [--role <角色>] [--write-scope <none|sandbox|workspace|production>]
 *                                     [--credentials <none|inherit|own>] [--budget <tokens>|--budget-source <inherit|none>]
 *                                     [--caps a,b,c] [--note <说明>]
 *   node scripts/capability-registry.mjs supersede <oldId> --by <newId> [--reason <r>]
 *   node scripts/capability-registry.mjs retire <id> [--reason <r>]
 *   node scripts/capability-registry.mjs merge <newId> --from <id1,id2> [--reason <r>]
 *   node scripts/capability-registry.mjs signal <id> --kind invoke|reuse|success|failure [--note <s>]
 *   node scripts/capability-registry.mjs check
 *
 * 注册门（P3，独立脚本）：
 *   node scripts/capability-gate.mjs ladder           # 看阶梯定义与实施状态
 *   node scripts/capability-gate.mjs run <id>         # 评估单个能力（过门才转 active）
 *   node scripts/capability-gate.mjs run --all
 */
import fs from 'node:fs'
import path from 'node:path'
import { MCP_SOURCES, scanMcpSource } from './capability-sources.mjs'

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

/**
 * 从 CLI 参数构造 L1 不变量声明（P3）。
 * 四项全缺 ⇒ 返回 `null` —— 这是**刻意**的：门对缺声明 fail-closed，
 * 「没声明」不等于「不适用」，只等于「没承认」。
 */
function buildInvariantsFromOpts() {
  const role = opt('role')
  const writeScope = opt('write-scope')
  const credentials = opt('credentials')
  const budgetTok = opt('budget')
  const budgetSource = opt('budget-source') ?? (budgetTok ? 'declared' : undefined)
  if (!role && !writeScope && !credentials && !budgetSource) return null
  const inv = {}
  if (role) inv.role = role
  if (writeScope) inv.writeScope = writeScope
  if (credentials) inv.credentials = credentials
  if (budgetSource) inv.budget = { source: budgetSource, maxTokens: budgetTok ? Number(budgetTok) : null }
  return inv
}

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
    /**
     * ★ L1 不变量门的**声明位**（P3）。
     *   { role, writeScope, credentials, budget:{ source, maxTokens } }
     * 缺声明 ⇒ 门 **fail-closed**（没有明确承认的不变量，就不算成立）。
     *
     * ⚠️ 这里存的是**声明**。「它真的限住了写权 / 真的没超预算吗」属**运行期验证**，
     *    归 L2~L4 —— 那三级**当前未实施**，门会显式标 not-enforced，不得计作通过。
     */
    invariants: o.invariants ?? null,
    acceptance: {
      kind: o.acceptance ? 'ref' : 'none',
      ref: o.acceptance ?? null,
      status: 'unknown',
      ranAt: null,
      proofLevel: null,   // 门跑到哪一级（L0 / L1）；L2~L4 未实施故至今只能是 L0|L1
      unenforced: null,   // 未实施的级（当前恒为 ['L2','L3','L4']）—— 必须显式带出，防"假绿"
      checks: null,       // 逐项检查结果，供审计
    },
    holdoutHash: null,
    // ★ 注册 ≠ 采纳：创建即 pending，只有过了注册门（scripts/capability-gate.mjs）才转 active。
    status: 'pending',
    registeredAt: new Date().toISOString(),
    supersededBy: null,
    retiredReason: null,
    lineage: [{ version: o.version ?? '0.1.0', at: new Date().toISOString(), action: 'register' }],
    signals: { invoked: 0, reused: 0, succeeded: 0, failed: 0, lastUsedAt: null, notes: [] },
  }
}

// ── 命令 ────────────────────────────────────────────────────────────────────

// 外部能力源描述（MCP_SOURCES）与扫描器已抽到 scripts/capability-sources.mjs
// —— **单一实现**，注册表（数据层）与注册门（判据层）共用，杜绝第二份脆弱副本。
//
// ★ 历史教训：这里原先的正则扫描在 design-canvas 2026-09-14 改造后失效，
//   报出「67 个工具全部未归线」的**假漂移** —— 比不报更坏（骗人修不存在的问题，
//   还让人不再信任这个检查）。详见该模块头部注释。

// scanMcpSource / MCP_SOURCES 现由 scripts/capability-sources.mjs 提供（见文件头 import）。

const KNOWN = [
  {
    id: 'spawn', package: '@deepseek-ai/dsh-subagent-spawn-in-process', provider: 'spawn',
    tool: 'subagent', seat: 'upstream',
    // 通用委派（非特定角色）；in-process driver 不削减工具集 ⇒ 子代理可在工作区内写入。
    invariants: { role: 'provider', writeScope: 'workspace', credentials: 'inherit', budget: { source: 'inherit', maxTokens: null } },
  },
  {
    id: 'fork', package: '@deepseek-ai/dsh-subagent-fork-in-process', provider: 'fork',
    tool: 'subagent_fork', seat: 'upstream',
    // 同上；fork 另继承父上下文（inheritsParentContext = true，运行时实测）。
    invariants: { role: 'provider', writeScope: 'workspace', credentials: 'inherit', budget: { source: 'inherit', maxTokens: null } },
  },
  {
    id: 'council-architect', package: '@dsh-brain/subagent-council', path: 'packages/subagent-council',
    provider: 'council-architect', tool: 'council_architect', seat: 'architect',
    /**
     * 架构师 = **设计者**席位 ⇒ writeScope 不得为 production（L1 硬检查）。
     * 诚实的值是 workspace：v1 不削减 in-process driver 工具集（见 SeatProvider 注释），
     * 子代理确实能在工作区内写。**不写 sandbox** —— 那会是假声明。
     */
    invariants: { role: 'designer', writeScope: 'workspace', credentials: 'inherit', budget: { source: 'inherit', maxTokens: null } },
  },
]

if (cmd === 'init') {
  const db = load()
  let added = 0
  let demoted = 0
  for (const k of KNOWN) {
    const existing = find(db, k.id)
    if (existing) {
      // ── 幂等同步：invariants 是**代码里的声明**，registry 从代码同步 ──
      if (k.invariants && !existing.invariants) {
        existing.invariants = k.invariants
        record(db, 'sync-invariants', { id: k.id })
      }
      // ── P3 迁移：此前是「未经门的 active」⇒ 如实降级为 pending ──
      if (existing.status === 'active' && existing.acceptance?.kind !== 'gate') {
        existing.status = 'pending'
        record(db, 'demote-ungated', { id: k.id })
        demoted++
        console.log(`  ⚠️ ${k.id}: 原为 active 但无注册门回执 → 降级 pending（那不是「通过」，只是「没跑过门」）`)
      }
      continue
    }
    const cap = newCapability({
      id: k.id, package: k.package, path: k.path, provider: k.provider, tool: k.tool, seat: k.seat,
      invariants: k.invariants,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    })
    if (k.id === 'council-architect') {
      // ★ 这里曾经写死过 acceptance:{kind:'ref', status:'passed'}，而 ref 只是一段散文文档 ——
      //   那是**假回执**：判据没跑，状态却是 passed。P3 已移除；
      //   真回执从此只由注册门（scripts/capability-gate.mjs）写入。
      //   真实发生过的事留在 signals 里 —— 它是**信号**，不是判据（两者不可混）。
      cap.signals.notes.push('2026-09-14 首次真实委派通过（session-c0f05cde）')
    }
    db.capabilities.push(cap)
    record(db, 'register', { id: k.id, via: 'init' })
    added++
  }
  // ── 外部能力源（MCP server / 工具插件）：工具层能力 ──
  for (const m of MCP_SOURCES) {
    const scan = await scanMcpSource(m)
    let cap = find(db, m.id)
    const isNew = !cap
    if (isNew) cap = newCapability({ id: m.id, kind: m.kind, version: '0.0.0', invariants: m.invariants })
    cap.kind = m.kind
    cap.label = m.label
    cap.source = {
      package: null, path: m.repo, provider: null, tool: m.navTool, seat: null,
      transport: m.transport, entry: m.entry,
    }
    cap.tooling = scan
    if (m.invariants && !cap.invariants) {
      cap.invariants = m.invariants
      record(db, 'sync-invariants', { id: m.id })
    }
    if (!isNew && cap.status === 'active' && cap.acceptance?.kind !== 'gate') {
      cap.status = 'pending'
      record(db, 'demote-ungated', { id: m.id })
      demoted++
      console.log(`  ⚠️ ${m.id}: 原为 active 但无注册门回执 → 降级 pending`)
    }
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
  console.log(`init 完成：新增 ${added} 条，降级 ${demoted} 条（未经门的 active），当前共 ${db.capabilities.length} 条`)
  console.log(`文件：${FILE}`)
  if (demoted) console.log(`下一步：node scripts/capability-gate.mjs run --all`)
} else if (cmd === 'list') {
  const db = load()
  if (opt('json')) { console.log(JSON.stringify(db, null, 2)); process.exit(0) }
  console.log(`能力库（${db.capabilities.length} 条）  更新于 ${db.updatedAt}\n`)
  const pad = (s, n) => String(s ?? '-').padEnd(n)
  console.log(`  ${pad('id', 24)} ${pad('kind', 17)} ${pad('status', 10)} ${pad('ver', 8)} ${pad('工具面', 24)} 选用/复用/成/败  注册门`)
  for (const c of db.capabilities) {
    const s = c.signals ?? {}
    const a = c.acceptance ?? {}
    // ★ 判据列只认**注册门回执**。散文引用（kind:'ref'）与缺省都显示为未过门 ——
    //   曾经把散文引用显示成 'pass'，那是假绿，已废弃。
    const acc = a.kind === 'gate'
      ? (a.status === 'passed' ? `门:${a.proofLevel ?? '?'}` : `门:${a.status}`)
      : 'NO-GATE'
    const face = c.tooling
      ? `${c.tooling.toolCount} 工具 / ${c.tooling.laneCount} 线`
      : String(c.source?.tool ?? '-')
    console.log(`  ${pad(c.id, 24)} ${pad(c.kind, 17)} ${pad(c.status, 10)} ${pad(c.version, 8)} ${pad(face, 24)} ${s.invoked ?? 0}/${s.reused ?? 0}/${s.succeeded ?? 0}/${s.failed ?? 0}  ${acc}`)
  }
  console.log('\n  （选用/复用/成功/失败 = 行为信号；高选用 + 低复用 = 描述过度承诺）')
  console.log('  （kind=subagent-provider 是委派层能力；kind=mcp-server 是工具层能力源）')
  console.log('  （status：pending=已注册未过门 · active=已过门；门只跑到 L1，L2~L4 未实施）')
} else if (cmd === 'show') {
  const db = load()
  const c = find(db, positional[0])
  if (!c) { console.error('未找到 ' + positional[0]); process.exit(1) }
  console.log(JSON.stringify(c, null, 2))
} else if (cmd === 'register') {
  const id = positional[0]
  if (!id) { console.error('用法：register <id> --pkg <包名> [--role ... --write-scope ... --credentials ...]'); process.exit(1) }
  const db = load()
  if (find(db, id)) { console.error(`X 已存在：${id}（升级请用 supersede，合并请用 merge）`); process.exit(1) }
  const caps = opt('caps') ? Object.fromEntries(String(opt('caps')).split(',').map((k) => [k, true])) : null
  const invariants = buildInvariantsFromOpts()
  if (opt('acceptance')) {
    console.error('⚠️ --acceptance 只产生 kind:"ref"（散文引用）—— 注册门不认它，跑门后会被真回执覆盖。')
  }
  const cap = newCapability({
    id, package: opt('pkg'), path: opt('path'), provider: opt('provider') ?? id,
    tool: opt('tool'), seat: opt('seat'), version: opt('version'), acceptance: opt('acceptance'),
    capabilities: caps, invariants,
  })
  if (opt('note')) cap.signals.notes.push(String(opt('note')))
  db.capabilities.push(cap)
  record(db, 'register', { id })
  save(db)
  console.log(`已注册：${id}  （来源 ${cap.source.package ?? '?'}）`)
  // ★ 注册 ≠ 采纳
  console.log(`状态：pending —— 尚未采纳。过注册门后才会 active：`)
  console.log(`  node scripts/capability-gate.mjs run ${id}`)
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
    if (!c.invariants) {
      problems.push(`${c.id} 未声明 L1 不变量（role/writeScope/credentials/budget）→ 注册门会 fail-closed`)
    }
    // ★ 注册 ≠ 采纳：pending = 已登记、未过门。不是错误状态，但必须显式给出下一步。
    if (c.status === 'pending') {
      problems.push(`${c.id} 处于 pending（已注册、**未过注册门**）→ node scripts/capability-gate.mjs run ${c.id}`)
    }
    if (c.status === 'active' && c.acceptance?.kind !== 'gate') {
      problems.push(`${c.id} 处于 active 但 acceptance.kind=${JSON.stringify(c.acceptance?.kind ?? null)} —— 不是注册门回执（active 只能由注册门写入）`)
    }
    const s = c.signals ?? {}
    if ((s.invoked ?? 0) >= 3 && (s.reused ?? 0) === 0) problems.push(`${c.id} 选用 ${s.invoked} 次、复用 0 次 → 疑似「描述过度承诺」`)
  }

  // ★ 工具层能力源：实时重扫工具面，检出「能力线目录 vs 实际注册」的漂移
  for (const m of MCP_SOURCES) {
    const c = find(db, m.id)
    if (!c || c.status !== 'active') continue
    const scan = await scanMcpSource(m)
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
