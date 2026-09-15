#!/usr/bin/env node
/**
 * capability-gate.mjs —— 注册门（P3）
 *
 * 设计依据：`docs/capability-registry-evolution.md` §5.4 / §9（P3 行）、
 *           《自进化总纲》§5 判据阶梯的**能力级实例**。
 *
 * > 注册 = 采纳。`registerProvider` 是纯 API，**它不会替你验证** ——
 * > 所以闸必须放在调用方。本脚本就是那道闸。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 阶梯（* = 本脚本真正执行的级）
 *
 *   L0 机械门    provider 能启动 / 接口 5 成员齐 / capabilities 声明与实际一致   *
 *   L1 不变量门  role·writeScope·credentials·budget 已声明且自洽（一票否决）    *
 *   L2 基线不退化 在既有能力集上不劣化（逐维度 fail-closed）                    ✗ 未实施
 *   L3 隐藏 holdout  优化器看不见的用例 + 红队对抗用例                          ✗ 未实施
 *   L4 反事实对照 与现役同能力 shadow A/B 比到显著性                            ✗ 未实施
 *
 * ★★ 这个脚本最重要的一条纪律：**不撒谎。**
 *   门只跑到 L1，所以回执写 `proofLevel: 'L1'` 且 `unenforced: ['L2','L3','L4']`。
 *   把 L2~L4 标成"通过"就是**假绿** —— 那正是本项目花了两天修的那类失败
 *   （保险自己失效）。宁可让读的人知道"证明到哪为止"。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 用法：
 *   node scripts/capability-gate.mjs ladder            # 打印阶梯与实施状态
 *   node scripts/capability-gate.mjs run <id>          # 评估单个能力
 *   node scripts/capability-gate.mjs run --all         # 评估全部 pending
 *
 * 过门 ⇒ registry 里该能力 `status: 'active'` 且写入 gate 回执；
 * 未过 ⇒ 保持 `pending`，回执记 `failed` 与逐项原因。两者都会打印"未实施的级"。
 * 退出码：0 = 全部 admitted；1 = 有 blocked。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpSourceById, scanMcpSource } from './capability-sources.mjs'

const REPO = 'D:/project_develop/dsh-brain'
const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const DIR = path.join(HOME, 'capabilities')
const FILE = path.join(DIR, 'registry.json')

// ── 阶梯定义（单一真相源：打印与回执都用它） ─────────────────────────────────

const LADDER = [
  { level: 'L0', name: '机械门', enforced: true, scope: 'provider 能启动 / 接口 5 成员齐 / capabilities 声明与实际一致' },
  { level: 'L1', name: '不变量门', enforced: true, scope: 'role·writeScope·credentials·budget 已声明且自洽（一票否决）' },
  { level: 'L2', name: '基线不退化', enforced: false, scope: '在既有能力集上不劣化（逐维度 fail-closed）', why: '需固化基线与测量口径，未建' },
  { level: 'L3', name: '隐藏 holdout', enforced: false, scope: '优化器看不见的用例 + 红队对抗用例', why: '需独立评测集 + holdoutHash，未建' },
  { level: 'L4', name: '反事实对照', enforced: false, scope: '与现役同能力 shadow A/B 比到显著性', why: '需同任务集与 A/B 编排，未建' },
]
const UNENFORCED = LADDER.filter((l) => !l.enforced).map((l) => l.level)

/** SubagentProvider 的五个成员（`docs/capability-registry-evolution.md` §2）。 */
const PROVIDER_MEMBERS = [
  { key: 'name', type: 'string', why: '注册进 ctx.subagents 的名字（= 路由键）' },
  { key: 'capabilities', type: 'object', why: '能力清单契约的挂载点' },
  { key: 'inheritsParentContext', type: 'boolean', why: '是否继承父会话上下文' },
  { key: 'start', type: 'function', why: '启动一次子代理运行' },
  { key: 'prepareContinuable', type: 'function', why: '可续跑（followup）准备' },
]

// ── L1 词汇表 ───────────────────────────────────────────────────────────────

const ROLES = ['provider', 'scout', 'designer', 'implementer', 'reviewer']
const WRITE_SCOPES = ['none', 'sandbox', 'workspace', 'production']
const CREDENTIALS = ['none', 'inherit', 'own']
const BUDGET_SOURCES = ['inherit', 'declared', 'none']
/** 设计/规划/侦察/审阅类角色 ⇒ **不得有生产写权**（L1 硬检查）。 */
const NO_PROD_WRITE_ROLES = ['scout', 'designer', 'reviewer']

// ── 工具 ────────────────────────────────────────────────────────────────────

const load = () => {
  if (!fs.existsSync(FILE)) {
    console.error(`X 找不到能力库：${FILE}\n  先跑 node scripts/capability-registry.mjs init`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'))
}

function save(db) {
  db.updatedAt = new Date().toISOString()
  fs.mkdirSync(DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, FILE)
}

/**
 * 解析能力的可加载入口（编译产物）。
 *
 * 顺序：显式 `source.entryPath`（绝对路径）→ 仓库内 `source.path` → node_modules → profile junction。
 * 为什么要显式 `entryPath`：让**自证测试**能指向夹具包，而不必往 node_modules 里塞东西；
 * 真能力一般用后两种即可。
 */
function resolveEntry(cap) {
  const cands = []
  if (cap.source?.entryPath) cands.push(cap.source.entryPath)
  if (cap.source?.path) cands.push(path.join(REPO, cap.source.path, 'lib/index.js'))
  if (cap.source?.package) {
    cands.push(path.join(REPO, 'node_modules', cap.source.package, 'lib/index.js'))
    cands.push(path.join(HOME, 'profiles/node_modules', cap.source.package, 'lib/index.js'))
  }
  return cands.find((p) => fs.existsSync(p)) ?? null
}

// ── L0 机械门 ───────────────────────────────────────────────────────────────

/**
 * subagent-provider 的 L0。
 *
 * ★ 为什么用 mock ctx 真跑 `apply()`：这才是"**provider 能启动**"的证据。
 *   只读源码或只查包是否存在，都只是"看起来能启动"。我们刚在别处栽过
 *   「判据与信号不可混」的坑，这里坚持要真信号。
 */
async function l0Provider(cap) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ level: 'L0', name, ok, detail })

  const entry = resolveEntry(cap)
  if (!entry) {
    add('编译产物存在', false, `找不到 lib/index.js（source.package=${cap.source?.package ?? '?'}）`)
    return { checks, evidence: {} }
  }
  add('编译产物存在', true, entry)

  let mod
  try {
    mod = await import(pathToFileURL(entry).href)
  } catch (e) {
    add('模块可导入', false, e.message.slice(0, 200))
    return { checks, evidence: {} }
  }
  add('模块可导入', true, `导出：${Object.keys(mod).sort().join(', ')}`)

  if (typeof mod.apply !== 'function') {
    add('导出 apply()', false, 'provider 包必须导出 apply(ctx, config)')
    return { checks, evidence: {} }
  }
  add('导出 apply()', true, '')

  // 用包自己的 Config 求一份合法配置（provider 名取 registry 声明值）
  let base = {}
  try {
    const r = mod.Config?.['~standard']?.validate({})
    if (r && !r.issues) base = r.value ?? {}
  } catch { /* 容忍：缺配置的包 Config 也应能收敛 */ }
  const cfg = { ...base, providerName: cap.source?.provider ?? cap.id }

  let captured = null
  const touched = new Set()
  const NOOP = () => undefined
  const target = {
    subagents: { registerProvider: (p) => { captured = p } },
    logger: () => ({ debug: NOOP, info: NOOP, warn: NOOP, error: NOOP }),
  }
  const mockCtx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k === 'symbol') return undefined
      touched.add(String(k))
      return NOOP
    },
  })

  try {
    mod.apply(mockCtx, cfg)
  } catch (e) {
    add('provider 能启动（apply 不抛错）', false, e.message.slice(0, 200))
    return { checks, evidence: {} }
  }
  if (!captured) {
    add('provider 能启动（apply 不抛错）', false, 'apply 未调用 ctx.subagents.registerProvider')
    return { checks, evidence: {} }
  }
  add('provider 能启动（apply 不抛错）', true, `捕获到 provider，name=${JSON.stringify(captured.name)}`)

  // 接口 5 成员齐
  const missing = []
  for (const m of PROVIDER_MEMBERS) {
    const v = captured[m.key]
    if (v === undefined || v === null) { missing.push(`${m.key}（缺）`); continue }
    if (typeof v !== m.type) missing.push(`${m.key}（应为 ${m.type}，实为 ${typeof v}）`)
  }
  add(`接口 5 成员齐`, missing.length === 0, missing.length ? `问题：${missing.join('; ')}` : PROVIDER_MEMBERS.map((m) => m.key).join(' / '))

  // capabilities 声明与实际一致（键集合比对 —— 只看值会漏掉"多了/少了字段"）
  const declared = cap.capabilities
  const actual = captured.capabilities ?? {}
  if (!declared) {
    add('capabilities 声明与实际一致', false, 'registry 未声明 capabilities，无法对账（先补声明）')
  } else {
    const dk = Object.keys(declared).sort()
    const ak = Object.keys(actual).sort()
    const diff = JSON.stringify(dk) !== JSON.stringify(ak)
    add(
      'capabilities 声明与实际一致',
      !diff,
      diff ? `registry=[${dk}] vs 实际=[${ak}]` : `[${ak}]`,
    )
  }

  return {
    checks,
    evidence: {
      entry,
      providerName: captured.name,
      inheritsParentContext: captured.inheritsParentContext,
      capabilitiesActual: Object.keys(actual).sort(),
      extraCtxServicesTouched: [...touched].sort(),
    },
  }
}

/** mcp-server 的 L0：入口存在 / 工具面可扫 / 契约形状 / 声明与实际一致。 */
async function l0Mcp(cap) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ level: 'L0', name, ok, detail })

  const src = mcpSourceById(cap.id)
  if (!src) {
    add('能力源已在 MCP_SOURCES 登记', false, `scripts/capability-sources.mjs 里没有 id=${cap.id}`)
    return { checks, evidence: {} }
  }
  add('能力源已在 MCP_SOURCES 登记', true, `entry=${src.entry}`)

  add('入口文件存在', fs.existsSync(src.entry), src.entry)

  const scan = await scanMcpSource(src)
  if (scan.error) {
    add('工具面可扫', false, scan.error.slice(0, 200))
    return { checks, evidence: { scan } }
  }
  add('工具面可扫', true, `mode=${scan.mode}`)

  add('契约形状（有工具、有线索）', scan.toolCount > 0 && scan.laneCount > 0, `${scan.toolCount} 工具 / ${scan.laneCount} 线`)

  const drift = scan.drift ?? {}
  const notIn = drift.registeredNotInLanes ?? []
  const stale = drift.inLanesNotRegistered ?? []
  const laneErrors = scan.laneErrors ?? []
  const clean = notIn.length === 0 && stale.length === 0 && laneErrors.length === 0
  add(
    '能力线目录与实际注册一致',
    clean,
    clean
      ? `${scan.laneToolCount} 个工具已归线，无陈旧标注`
      : `未归线 ${notIn.length} 个${notIn.length ? `：${notIn.slice(0, 8).join(', ')}${notIn.length > 8 ? ' …' : ''}` : ''}` +
        `；陈旧标注 ${stale.length} 个${stale.length ? `：${stale.slice(0, 8).join(', ')}` : ''}` +
        `；lane 校验错误 ${laneErrors.length}`,
  )

  return { checks, evidence: { scan } }
}

// ── L1 不变量门 ─────────────────────────────────────────────────────────────
//
// ★ 这一级检查的是「**声明**齐备且自洽」，不是「运行期真的限制住了」。
//   后者需要跑起来观察（真限住写权 / 真没超预算），属 L2~L4 —— 未实施。
//   回执里必须把这件事说清楚，否则读的人会以为 L1 通过就等于安全。

async function l1Invariants(cap) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ level: 'L1', name, ok, detail })
  const inv = cap.invariants

  if (!inv) {
    add('不变量已声明', false, '缺 role/writeScope/credentials/budget —— fail-closed（未承认的不变量不算成立）')
    return { checks }
  }
  add('不变量已声明', true, '')

  add('role 合法', ROLES.includes(inv.role), `role=${JSON.stringify(inv.role)}（合法值：${ROLES.join('/')}）`)
  add('writeScope 合法', WRITE_SCOPES.includes(inv.writeScope), `writeScope=${JSON.stringify(inv.writeScope)}（合法值：${WRITE_SCOPES.join('/')}）`)
  add('credentials 合法', CREDENTIALS.includes(inv.credentials), `credentials=${JSON.stringify(inv.credentials)}（合法值：${CREDENTIALS.join('/')}）`)

  const b = inv.budget
  const budgetOk =
    Boolean(b) &&
    BUDGET_SOURCES.includes(b.source) &&
    (b.source !== 'declared' || (typeof b.maxTokens === 'number' && b.maxTokens > 0))
  add(
    'budget 合法',
    budgetOk,
    b ? `source=${JSON.stringify(b.source)}${b.source === 'declared' ? `, maxTokens=${JSON.stringify(b.maxTokens)}` : ''}` : '未声明 budget',
  )

  // ★ 核心安全不变量：设计者不能有生产写权
  const isNoProdRole = NO_PROD_WRITE_ROLES.includes(inv.role)
  const hasProd = inv.writeScope === 'production'
  add(
    '设计类角色不得有生产写权',
    !(isNoProdRole && hasProd),
    isNoProdRole
      ? `role=${inv.role} ⇒ writeScope 不得为 production（现为 ${JSON.stringify(inv.writeScope)}）`
      : `role=${inv.role} 不在受限集 ${NO_PROD_WRITE_ROLES.join('/')} ⇒ 不适用`,
  )

  // ★ 这里曾经有一条交叉校验：「inheritsParentContext=false 且 credentials=inherit ⇒ 违反凭据边界」。
  //   2026-09-15 首次实跑即暴露它是**错的**，已删除，理由值得留档：
  //     · `inheritsParentContext` 说的是**会话上下文**（消息历史是否沿用），
  //       与**凭据**不是一个维度 —— 所有 in-process 子代理都在同一进程里，
  //       必然共用同一份 LLM 凭据，`inherit` 是**架构事实**，不是越权。
  //     · 它会产生**假红**：为了过门只能把声明改成 `own`，那是往注册表里**写假话**。
  //     · 会误报的门最终会被人绕过去，于是什么也保护不了 —— 与"假绿"同等有害。
  //   凭据边界在 L1 的诚实判法是「**已显式声明**」（见上一条 `credentials 合法`）；
  //   「它是否真的只用到了该用的凭据」属**运行期验证**，归 L2~L4（未实施）。
  //   `inheritsParentContext` 仍收进 evidence 供审计，但**不参与判定**。

  return { checks }
}

// ── 评估一个能力 ────────────────────────────────────────────────────────────

async function evaluate(cap) {
  let l0, l1
  if (cap.kind === 'mcp-server') {
    l0 = await l0Mcp(cap)
  } else {
    l0 = await l0Provider(cap)
  }
  l1 = await l1Invariants(cap)
  const checks = [...l0.checks, ...l1.checks]
  const failed = checks.filter((c) => !c.ok)
  const verdict = failed.length === 0 ? 'admitted' : 'blocked'
  return { verdict, checks, failed, evidence: l0.evidence ?? {} }
}

function receiptOf(r, ranAt) {
  return {
    kind: 'gate',
    ref: 'scripts/capability-gate.mjs',
    status: r.verdict === 'admitted' ? 'passed' : 'failed',
    ranAt,
    // ★ 证明只到 L1；L2~L4 未实施 —— 必须显式带出，防读的人误以为是"全过"
    proofLevel: r.verdict === 'admitted' ? 'L1' : 'L0',
    unenforced: UNENFORCED,
    checks: r.checks,
    evidence: r.evidence,
  }
}

function printResult(id, r) {
  const tag = r.verdict === 'admitted' ? '✅ admitted' : '⛔ blocked'
  console.log(`\n${tag}  ${id}`)
  for (const c of r.checks) console.log(`    ${c.ok ? 'ok  ' : 'FAIL'} [${c.level}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  if (r.verdict === 'admitted') {
    console.log(`    证明级别：L1（L0+L1 全过）`)
    console.log(`    ⚠️ 未实施的级：${UNENFORCED.join(', ')} —— 这些**没有被验证**，不计作通过`)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0]

if (cmd === 'ladder') {
  console.log('判据阶梯（能力级实例）—— 《自进化总纲》§5 / capability-registry-evolution §5.4\n')
  for (const l of LADDER) {
    console.log(`  ${l.level}  ${l.name.padEnd(6)} ${l.enforced ? '★ 已实施' : '✗ 未实施'}  ${l.scope}`)
    if (!l.enforced && l.why) console.log(`        └ ${l.why}`)
  }
  console.log('\n  ★ 只标"已实施"的级才参与判定；未实施的级在回执里进 unenforced，绝不计作通过。')
} else if (cmd === 'run') {
  const db = load()
  const all = argv.includes('--all')
  const ids = all
    ? db.capabilities.filter((c) => c.status === 'pending' || c.status === 'active').map((c) => c.id)
    : [argv[1]]
  if (!ids[0]) { console.error('用法：run <id> | run --all'); process.exit(1) }

  let blocked = 0
  for (const id of ids) {
    const cap = db.capabilities.find((c) => c.id === id)
    if (!cap) { console.error(`未找到能力：${id}`); blocked++; continue }
    const r = await evaluate(cap)
    printResult(id, r)
    cap.acceptance = receiptOf(r, new Date().toISOString())
    if (r.verdict === 'admitted') {
      cap.status = 'active'
    } else {
      cap.status = 'pending'
      blocked++
    }
    db.history = db.history ?? []
    db.history.push({ at: new Date().toISOString(), action: 'gate', id, verdict: r.verdict, proofLevel: cap.acceptance.proofLevel })
  }
  save(db)
  console.log(`\n回执已写入 ${FILE}`)
  console.log(`结果：${ids.length - blocked} admitted / ${blocked} blocked`)
  process.exit(blocked ? 1 : 0)
} else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('\n').slice(1, 22).join('\n'))
}
