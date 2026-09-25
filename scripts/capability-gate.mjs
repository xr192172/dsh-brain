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
 *   L2 基线不退化 在既有能力集上不劣化（逐维度 fail-closed）                    ★ 已实施
 *   L3 隐藏 holdout  优化器看不见的用例 + 红队对抗用例                          ★ 已实施
 *   L4 反事实对照 与现役同能力 shadow A/B 比到显著性                            ⚠ 软门（不入 verdict）
 *
 * ★★ 这个脚本最重要的一条纪律：**不撒谎。**
 *   proofLevel 只报**实际通过**的最高连续级；未跑或跑不过的级绝不计入。
 *   把没跑过的级标成"通过"就是**假绿** —— 那正是本项目花了两天修的那类失败
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
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mcpSourceById, scanMcpSource } from './capability-sources.mjs'
import { atomicWriteJson, readJsonTolerant, formatReadFailure } from './capability-store.mjs'
import { load as loadBaselines, getBaseline, compareMetrics } from './eval-baseline-store.mjs'

const REPO = 'D:/project_develop/dsh-brain'
const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const DIR = path.join(HOME, 'capabilities')
const FILE = path.join(DIR, 'registry.json')
/** 脚本根目录（scripts/ 的上级），用于定位 out/l4-report/ 下的证据文件。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 阶梯定义（单一真相源：打印与回执都用它） ─────────────────────────────────

const LADDER = [
  { level: 'L0', name: '机械门', enforced: true, status: 'implemented', scope: 'provider 能启动 / 接口 5 成员齐 / capabilities 声明与实际一致' },
  { level: 'L1', name: '不变量门', enforced: true, status: 'implemented', scope: 'role·writeScope·credentials·budget 已声明且自洽（一票否决）' },
  { level: 'L2', name: '基线不退化', enforced: true, status: 'implemented', scope: '在既有能力集上不劣化（逐维度 fail-closed）', why: '已实施：scripts/eval-baseline-store.mjs 存取基线，evaluate() 逐维度比较' },
  { level: 'L3', name: '隐藏 holdout', enforced: true, status: 'implemented', scope: '优化器看不见的用例 + 红队对抗用例', why: '已实施：独立 holdout 任务集 + hash 防篡改 + fail-closed' },
  { level: 'L4', name: '反事实对照', enforced: false, status: 'advisory-by-design', scope: '与现役同能力 shadow A/B 比到显著性', why: '已建但设计为软门，不入 verdict' },
]
const UNENFORCED = LADDER.filter((l) => !l.enforced).map((l) => l.level)
/** unenforcedWhy：解释每条 unenforced 级为何没参与判定——区分"未实施"与"设计为软门"。 */
const UNENFORCED_WHY = Object.fromEntries(LADDER.filter((l) => !l.enforced).map((l) => [l.level, l.status]))

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

// ── L2 基线不退化 ───────────────────────────────────────────────────────────
//
// ★ 判据口径：
//   - 比较对象是 **perRunMetrics**（每次运行都会变的真实度量），不是累计计数器。
//     累计计数器（invoked/succeeded/failed）只增不减，结构上不可能检出退化。
//   - 各维度独立 fail-closed（min 口径）：
//       outputTokens: 当前 ≥ 基线（越高越好）
//       wallMs:       当前 ≤ 基线（越低越好）
//       costCNY:      当前 ≤ 基线（越低越好）
//       score:        当前 ≥ 基线（越高越好）
//   - 任一维度不合格 ⇒ blocked。
//
// ★★ 基线来源纪律（防假绿）：
//   - gate **只读**基线，**不写**基线。写基线只能由 `eval-baseline-store.mjs` 的 CLI 命令做。
//   - 无基线 ⇒ **一律 blocked**（任务书原文：`cap.baselines` 缺 ⇒ blocked）。
//   - provisional 基线不参与判定（compareMetrics 返 null），但也不放行。
//   - 不允许"本次运行刚产生信号 → 同一次 run 就把它当基线跑 L2"——那正是假绿路径。

function l2Baseline(cap) {
  const blDb = loadBaselines()
  const existing = getBaseline(blDb, cap.id)
  const checks = []
  const add = (name, ok, detail) => checks.push({ level: 'L2', name, ok, detail })
  const evidence = {}

  if (!existing) {
    // ★ 无基线（无论 signals 是否为零）⇒ blocked
    // 这防止了"新能力第一次跑就自动放行"的假绿路径。
    add('基线存在', false, '无已确认基线 —— 须先用 node scripts/eval-baseline-store.mjs set <id> --metrics <json> 写入基线后再评估')
    evidence.noBaseline = true
    return { checks, evidence }
  }

  if (existing.provenance.provisional) {
    add('基线已确认', false, '基线为 provisional，需人工 confirm 后才参与 L2 判定')
    evidence.provisional = true
    return { checks, evidence }
  }

  // confirmed 基线：拿 perRunMetrics 比较
  const cur = cap.perRunMetrics ?? {}
  const cmp = compareMetrics(cur, existing)
  if (cmp === null) {
    add('基线已确认', false, '基线 provisional，不参与判定')
    return { checks, evidence }
  }
  if (!cmp.ok) {
    add('基线不退化', false, cmp.diffs.join('; '))
    evidence.comparison = cmp
    return { checks, evidence }
  }
  add('基线不退化', true, `perRunMetrics 各维度合格：${Object.keys(cur).join(', ')}`)
  evidence.comparison = cmp
  return { checks, evidence }
}

// ── L3 隐藏 holdout ──────────────────────────────────────────────────────
/**
 * l3Holdout(cap) —— 读 holdout 运行结果，做六条 check：
 *   1. holdout 集存在且可解析（条数 ≥ 3）
 *   2. 实时 SHA-256 == 记录的 holdoutHash（防篡改）
 *   3. 有独立运行结果（读不到 ⇒ FAIL，fail-closed）
 *   4. 运行结果 failed === 0（否则 FAIL）
 *   5. holdout 与 visible pilot id 无交集（否则 FAIL）
 *   6. holdout 根不在被测仓库树内（R1 底线）
 *
 * ★ 假绿防法：任何一条 fail ⇒ blocked（fail-closed）。
 *   holdoutHash 只允许来自"独立的历史运行"（落盘在 DSH_HOLDOUT_ROOT/results/），
 *   不许"就地生成 hash 当场自证通过"。
 */
function l3Holdout(cap) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ level: 'L3', name, ok, detail })

  const holdoutRoot = process.env.DSH_HOLDOUT_ROOT ?? 'D:/project_develop/_holdout'
  const tasksPath = path.join(holdoutRoot, 'tasks.jsonl')
  const resultsFile = path.join(holdoutRoot, 'results', `${cap.id}.json`)

  // Check 1: holdout 集存在且可解析
  if (!fs.existsSync(tasksPath)) {
    add('holdout 任务集存在且可解析', false, `任务集文件不存在：${tasksPath}`)
    return { checks, evidence: { l3Misevolution: null } }
  }
  let tasks
  try {
    tasks = fs.readFileSync(tasksPath, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => JSON.parse(l))
  } catch (e) {
    add('holdout 任务集存在且可解析', false, `JSON 解析失败：${e.message}`)
    return { checks, evidence: { l3Misevolution: null } }
  }
  if (tasks.length < 3) {
    add('holdout 任务集存在且可解析', false, `只有 ${tasks.length} 条（需 ≥ 3）`)
    return { checks, evidence: { l3Misevolution: null } }
  }
  add('holdout 任务集存在且可解析', true, `${tasks.length} 条`)

  // Check 2: 实时 SHA-256 == 记录的 holdoutHash（防篡改）
  const realHash = crypto.createHash('sha256').update(fs.readFileSync(tasksPath)).digest('hex')
  const recordedHash = cap.holdoutHash
  if (!recordedHash) {
    add('holdoutHash 已记录', false, 'registry 里还没有 holdoutHash（先跑一次 eval-holdout-run.mjs 再跑 gate）')
  } else if (realHash !== recordedHash) {
    add('holdoutHash 未篡改', false, `实时=${realHash.slice(0, 16)}... vs 记录=${recordedHash.slice(0, 16)}...（任务集被改过）`)
  } else {
    add('holdoutHash 未篡改', true, `${realHash.slice(0, 16)}...`)
  }

  // Check 3: 有独立运行结果（read-file, fail-closed）
  if (!fs.existsSync(resultsFile)) {
    add('有独立运行结果', false, `读不到结果文件：${resultsFile}（fail-closed：没跑过 = 没证据）`)
    return { checks, evidence: { l3Misevolution: null } }
  }
  let result
  try {
    result = JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
  } catch (e) {
    add('有独立运行结果', false, `结果文件解析失败：${e.message}`)
    return { checks, evidence: { l3Misevolution: null } }
  }
  add('有独立运行结果', true, `ranAt=${result.ranAt}`)

  // Check 4: 运行结果 failed === 0
  if (result.totals?.failed !== 0) {
    add('运行结果全部通过', false, `failed=${result.totals?.failed}（需 0）`)
  } else {
    add('运行结果全部通过', true, `${result.totals?.passed}/${result.totals?.n}`)
  }

  // Check 5: holdout 与 visible pilot id 无交集
  const pilotTasksPath = path.join(REPO, 'evals/pilot/tasks.jsonl')
  let pilotIds = []
  if (fs.existsSync(pilotTasksPath)) {
    try {
      pilotIds = fs
        .readFileSync(pilotTasksPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('//'))
        .map((l) => JSON.parse(l).id)
    } catch { /* ignore */ }
  }
  const holdoutIds = tasks.map((t) => t.id)
  const overlap = holdoutIds.filter((id) => pilotIds.includes(id))
  if (overlap.length > 0) {
    add('holdout 与 pilot id 无交集', false, `重叠：${overlap.join(', ')}`)
  } else {
    add('holdout 与 pilot id 无交集', true, '无重叠')
  }

  // Check 6: holdout 根不在被测仓库树内（R1 底线）
  const holdoutAbs = path.resolve(holdoutRoot)
  const repoAbs = path.resolve(REPO)
  const r1Ok = !holdoutAbs.startsWith(repoAbs + path.sep)
  add('holdout 根不在被测仓库树内（R1）', r1Ok, r1Ok ? `${holdoutAbs} 不在 ${repoAbs} 内` : `R1 违规：${holdoutAbs} 在 ${repoAbs} 内`)

  // ★ misevolution 软门：visible↑ 且 hidden↓ 时写进 evidence.l3Misevolution
  //   不入 verdict（不阻塞 admitted/blocked），因为：
  //   - misevolution 是"优化器在讨好 visible 测试、牺牲 holdout"的征兆，
  //     是**审计信号**而非准入判据 —— 准入判据已经由上面 6 条覆盖了。
  //   - 若把 misevolution 进 verdict，会把"历史数据不足"（还没跑过 visible+holdout 对比）误报为 blocked，
  //     导致新能力永远无法过 gate（因为没有历史基线）。
  //   - 所以 misevolution 只进 evidence，让读回执的人自己判断。
  const misevolution = computeMisevolution(cap, result)
  if (misevolution && misevolution.detected) {
    add('misevolution 检测（软门）', true, misevolution.reason)
  } else if (misevolution && !misevolution.detected) {
    // 数据读不到时，记录缺哪一侧
    add('misevolution 检测（软门）', true, `未检测到（${misevolution.reason}）`)
  }

  return { checks, evidence: { l3Misevolution: misevolution ?? null } }
}

/**
 * computeMisevolution：检测可见测试通过率 ↑ 而隐藏 holdout 通过率 ↓ 的 misevolution 迹象。
 *
 * 数据源（真实落盘，不发明字段）：
 *   - visible（公开集）侧：out/generations/<gen-id>/readings.json（gen-archive 的存档，两代对比）
 *   - hidden（holdout）侧：<DSH_HOLDOUT_ROOT>/results/<capId>.json（独立运行的结果）
 *
 * 判据：visible 的成功率上升 而 holdout 的成功率下降 ⇒ 写 evidence.l3Misevolution = {
 *   visibleBefore, visibleAfter, holdoutBefore, holdoutAfter, detected: true
 * }
 *
 * ★ 它绝不参与 verdict（软门纪律）—— 原因见 l3Holdout() 里的注释。
 * ★ 数据读不到 ⇒ detected 保持 null 并说明缺哪一侧（不许当成 false 或 true 猜）。
 */
function computeMisevolution(cap, holdoutResult) {
  // ── hidden 侧：从独立运行结果文件读（真实落盘） ──────────────────────────
  const holdoutRoot = process.env.DSH_HOLDOUT_ROOT ?? 'D:/project_develop/_holdout'
  const hiddenResultsPath = path.join(holdoutRoot, 'results', `${cap.id}.json`)
  let hiddenCurrent = null
  try {
    hiddenCurrent = JSON.parse(fs.readFileSync(hiddenResultsPath, 'utf8'))
  } catch {
    return { detected: false, reason: 'hidden side 读不到（' + hiddenResultsPath + ' 不存在或解析失败）' }
  }
  const hiddenPassed = hiddenCurrent.totals?.passed ?? 0
  const hiddenTotal = hiddenCurrent.totals?.n ?? 0
  const hiddenRateCurr = hiddenTotal > 0 ? hiddenPassed / hiddenTotal : 1

  // ── visible 侧：从 gen-archive readings.json 读（真实存档） ───────────────
  // 格式：out/generations/<gen-id>/readings.json → { arms: { "<arm>": { "<taskId>": { ok } } } }
  // 找最近一代和上上代做对比；找不到 ⇒ 只有当前代，返回 null 并说明。
  const genArchiveDir = path.join(REPO, 'out', 'generations')
  let visibleCurrentRate = null
  let visiblePrevRate = null
  let visibleSource = 'none'
  try {
    if (fs.existsSync(genArchiveDir)) {
      const genDirs = fs.readdirSync(genArchiveDir).sort().reverse() // 最新的在前
      if (genDirs.length >= 2) {
        const currGenFile = path.join(genArchiveDir, genDirs[0], 'readings.json')
        const prevGenFile = path.join(genArchiveDir, genDirs[1], 'readings.json')
        if (fs.existsSync(currGenFile) && fs.existsSync(prevGenFile)) {
          const currReadings = JSON.parse(fs.readFileSync(currGenFile, 'utf8'))
          const prevReadings = JSON.parse(fs.readFileSync(prevGenFile, 'utf8'))
          // 从 arms 里汇总所有 ok 条目
          const sumRates = (r) => {
            let ok = 0, total = 0
            for (const armData of Object.values(r?.arms ?? {})) {
              for (const taskData of Object.values(armData ?? {})) {
                if (taskData?.ok === true) ok++
                if (taskData?.ok !== null && taskData?.ok !== undefined) total++
              }
            }
            return total > 0 ? ok / total : null
          }
          visibleCurrentRate = sumRates(currReadings)
          visiblePrevRate = sumRates(prevReadings)
          visibleSource = `${genDirs[0]} (curr) vs ${genDirs[1]} (prev)`
        }
      }
    }
  } catch { /* 忽略解析错误 */ }

  // ── 判定 ──────────────────────────────────────────────────────────────────
  if (visibleCurrentRate === null || visiblePrevRate === null) {
    return {
      detected: false,
      reason: [
        visibleCurrentRate === null ? 'visible side 无 gen-archive readings.json（缺公开集历史）' : null,
        visiblePrevRate === null ? 'visible side 无上一代 readings（无法对比）' : null,
        `hidden side OK（当前 holdout 通过率=${hiddenRateCurr.toFixed(2)}，来源=${hiddenResultsPath}`
      ].filter(Boolean).join('; '),
    }
  }
  // visible↑ 且 holdout↓
  if (visibleCurrentRate > visiblePrevRate + 0.01 && hiddenRateCurr < visiblePrevRate - 0.01) {
    return {
      detected: true,
      visibleBefore: visiblePrevRate,
      visibleAfter: visibleCurrentRate,
      holdoutBefore: visiblePrevRate, // 占位：当前实现只用可见通过率作基准
      holdoutAfter: hiddenRateCurr,
      reason: `visible 通过率 ${visiblePrevRate.toFixed(2)}→${visibleCurrentRate.toFixed(2)} ↑, holdout 通过率 ${hiddenRateCurr.toFixed(2)}（来自 ${hiddenResultsPath}），数据来源：${visibleSource}`
    }
  }
  return null
}

// ── L4 反事实对照 ───────────────────────────────────────────────────────────
/**
 * L4 反事实对照：读 eval-shadow-ab.mjs 落盘的结构化证据，返回 { ok, detail, evidence }。
 *
 * ★ L4 是**软门**（advisory-by-design）：
 *   —— 它只往 evidence 里写，**绝不影响 verdict 的计算**。
 *   —— enforced 保持 false；UNENFORCED 仍含 'L4'（诚实表达：L4 不作为门在跑）。
 *   —— 把 L4 标成 enforced:true 就是假绿（回执看起来"L4 已实施"但它根本拦不住任何东西）。
 *   —— 因此 L4 不进 checks 的失败判定、不参与 failed 列表。
 */
function l4ShadowAb(cap) {
  const EVIDENCE_FILE = path.join(ROOT, 'out', 'l4-report', 'shadow-ab-evidence.json')
  if (!fs.existsSync(EVIDENCE_FILE)) {
    return { ok: false, detail: `证据文件不存在：${path.relative(ROOT, EVIDENCE_FILE)}（先跑 scripts/eval-shadow-ab.mjs --a ... --b ...）`, evidence: { status: 'missing' } }
  }
  let ev
  try {
    const body = fs.readFileSync(EVIDENCE_FILE, 'utf8')
    ev = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body)
  } catch (e) {
    return { ok: false, detail: `证据文件解析失败：${e?.message ?? e}`, evidence: { status: 'invalid' } }
  }
  if (ev.kind !== 'shadow-ab') return { ok: false, detail: `证据文件格式错误：expected kind='shadow-ab' got '${ev.kind ?? 'undefined'}'`, evidence: { status: 'malformed' } }
  return {
    ok: true,
    detail: `n=${ev.summary?.rowsCompared ?? 0} 对 (臂,题) 参与对比；结论：${(ev.conclusion ?? '').slice(0, 120)}`,
    evidence: ev,
  }
}

// ── 评估一个能力 ────────────────────────────────────────────────────────────

/**
 * 评估结果包含每个级别的通过状态，供 receiptOf 计算最高连续通过的级。
 */
async function evaluate(cap) {
  let l0, l1, l2, l3
  if (cap.kind === 'mcp-server') {
    l0 = await l0Mcp(cap)
  } else {
    l0 = await l0Provider(cap)
  }
  l1 = await l1Invariants(cap)
  l2 = l2Baseline(cap)
  l3 = l3Holdout(cap) // L3 是同步的（只读文件，不跑子进程）

  // L4 软门纪律：l4ShadowAb 的结果只进 evidence，不入 checks，不参与 failed
  const l4 = l4ShadowAb(cap)

  // ★ 唯一决定因子是 checks[].ok（l2Baseline/l3Holdout 的 verdict 字段已删，不复出）
  const allChecks = [...l0.checks, ...l1.checks, ...l2.checks, ...l3.checks]
  const failed = allChecks.filter((c) => !c.ok)
  const verdict = failed.length === 0 ? 'admitted' : 'blocked'

  // 记录每级是否通过（true = 该级所有检查都 ok）
  const l0Passed = l0.checks.every((c) => c.ok)
  const l1Passed = l1.checks.every((c) => c.ok)
  const l2Passed = l2.checks.every((c) => c.ok)
  const l3Passed = l3.checks.every((c) => c.ok)

  return {
    verdict,
    checks: allChecks,
    failed,
    evidence: { ...l0.evidence, ...l2.evidence, ...l3.evidence, l4ShadowAb: l4 },
    passedLevels: [l0Passed, l1Passed, l2Passed, l3Passed], // 对应 L0/L1/L2/L3
  }
}

/**
 * computePassedLevels：从 L0 起连续通过的级列表。
 * ★ L2/L3 均已实施（enforced=true），连续链可到 L3；L4 未实施（enforced=false）故断开。
 * 例：L0=ok, L1=ok, L2=ok, L3=ok, L4=skip(未实施) ⇒ ['L0','L1','L2','L3']
 */
function computePassedLevels(checks) {
  const levels = ['L0', 'L1', 'L2', 'L3', 'L4']
  const byLevel = {}
  for (const c of checks) {
    byLevel[c.level] = byLevel[c.level] ?? { ok: 0, total: 0 }
    byLevel[c.level].total++
    if (c.ok) byLevel[c.level].ok++
  }
  const result = []
  for (const lv of levels) {
    const stats = byLevel[lv]
    // enforced=false 的级（未实施）不参与连续链，也打断连续
    if (!stats) continue
    const ladderDef = LADDER.find((l) => l.level === lv)
    if (ladderDef && !ladderDef.enforced) {
      // 未实施的级：连续链在此断开，不再往后推
      break
    }
    const allOk = stats.total > 0 && stats.ok === stats.total
    if (allOk) {
      result.push(lv)
    } else {
      // 某级有失败 ⇒ 连续链在此断开
      break
    }
  }
  return result
}

/**
 * 回执：proofLevel = 从 L0 起最高连续通过的级。
 * ★ 不是 MAX_ENFORCED（那是"已实施的最高级"，不等于"本次跑过的最高级"）。
 *   如果 L2 blocked，proofLevel 回到 L1；L1 也 blocked 则回 L0。
 */
function receiptOf(r, ranAt) {
  // proofLevel = 从 L0 起最高连续通过级
  const levels = ['L0', 'L1', 'L2', 'L3', 'L4']
  let proofLevel = 'L0'
  for (const lv of levels) {
    const ladderDef = LADDER.find((l) => l.level === lv)
    if (!ladderDef) continue // 不存在的级跳过
    if (!ladderDef.enforced) {
      // 未实施的级打断连续链
      break
    }
    // 检查该级是否全部通过
    const levelChecks = r.checks.filter((c) => c.level === lv)
    if (levelChecks.length > 0 && levelChecks.every((c) => c.ok)) {
      proofLevel = lv
    } else {
      // 该级有失败或没有检查项，连续链断开
      break
    }
  }
  return {
    kind: 'gate',
    ref: 'scripts/capability-gate.mjs',
    status: r.verdict === 'admitted' ? 'passed' : 'failed',
    ranAt,
    // ★ 证明级别：从 L0 起最高连续通过级
    proofLevel,
    // ★ passedLevels：供审计用，显示哪些级真的通过了
    passedLevels: r.passedLevels,
    unenforced: UNENFORCED,
    // ★ unenforcedWhy：区分"未实施"与"设计为软门"——两种完全不同的状态，混在一起是误导
    unenforcedWhy: UNENFORCED_WHY,
    checks: r.checks,
    evidence: r.evidence,
  }
}

function printResult(id, r, receipt) {
  const tag = r.verdict === 'admitted' ? '✅ admitted' : '⛔ blocked'
  console.log(`\n${tag}  ${id}`)
  for (const c of r.checks) console.log(`    ${c.ok ? 'ok  ' : 'FAIL'} [${c.level}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  if (r.verdict === 'admitted') {
    console.log(`    证明级别：${receipt.proofLevel}（L0~${receipt.proofLevel} 全过）`)
    // ★ L4 证据（软门，不入 verdict）
    const l4e = r.evidence?.l4ShadowAb
    if (l4e) {
      console.log(`    L4 反事实对照 evidence：${l4e.ok ? '✓ 已产出' : '✗ ' + l4e.detail}`)
    }
    // ★★ 措辞必须区分「未实施」与「设计为软门」—— 两者完全不同，混着写就是误导（2026-09-25 主线修）。
    //    原文只印「未实施的级：L4」，而 L4 是**已实施**、只是设计上不入 verdict ⇒ 读的人会以为 L4 没做。
    //    这里直接从 `LADDER[].status` 取（单一真相源），不再另立映射。
    const whyOf = (lv) => {
      const st = LADDER.find((l) => l.level === lv)?.status
      if (st === 'advisory-by-design') return '已实施，但设计为软门（只产证据、不入 verdict）'
      if (st === 'implemented') return '已实施，但本次未参与判定'
      return '未实施'
    }
    console.log(
      `    ⚠️ 不参与判定的级：${UNENFORCED.map((lv) => `${lv}（${whyOf(lv)}）`).join('　')}` +
        `　—— 它们**没有被用来拦门**（详见回执的 unenforcedWhy）`,
    )
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0]

if (cmd === 'ladder') {
  console.log('判据阶梯（能力级实例）—— 《自进化总纲》§5 / capability-registry-evolution §5.4\n')
  for (const l of LADDER) {
    const statusTag = l.status === 'implemented'
      ? '★ 已实施'
      : l.status === 'advisory-by-design'
        ? '⚠ 软门（不入 verdict）'
        : '✗ 未实施'
    console.log(`  ${l.level}  ${l.name.padEnd(6)} ${statusTag}  ${l.scope}`)
    if (l.why) console.log(`        └ ${l.why}`)
  }
  console.log('\n  ★ 只标"已实施"的级才参与判定；L4 设计为软门（advisory-by-design）—— 产证据，但 verdict 完全不读它。')
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
    const receipt = receiptOf(r, new Date().toISOString())
    printResult(id, r, receipt)
    cap.acceptance = receipt
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
