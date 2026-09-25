#!/usr/bin/env node
/**
 * eval-holdout-run.mjs —— holdout 任务集运行器（L3 的核心组件）
 *
 * ★ 职责：跑 holdout 任务集，把"来源可证的"结果写回 registry。
 *
 * ★ 三条守卫（任一条触发即拒绝运行，exit 1）：
 *   ① **路径守卫（R1）**：holdout 根必须不在被测仓库树内；否则 Agent 可篡改结果
 *   ② **条数守卫**：holdout 任务集必须 ≥ 3 条，少于 3 条无意义
 *   ③ **交集守卫**：holdout id 与 visible（pilot）id 不能有交集
 *
 * ★ 假绿防法（核心）：**holdoutHash 只允许来自独立的历史运行**
 *   — 每次运行结果落盘到 `<DSH_HOLDOUT_ROOT>/results/<capId>.json`
 *   — gate 只从那里读，读不到 = 没有 = blocked（fail-closed）
 *   — 不许"就地生成 hash 当场自证通过"
 *
 * ★ DSH_HOLDOUT_ROOT 默认 = D:/project_develop/_holdout（够不到的地方）
 *   ★ 本机自测时覆盖到工作目录内（例：<wt>/out/holdout）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// ── 配置 ──────────────────────────────────────────────────────────────────
/** holdout 根：默认在仓库外（R1），可用 DSH_HOLDOUT_ROOT 覆盖（自测用）。 */
const HOLDOUT_ROOT = process.env.DSH_HOLDOUT_ROOT ?? 'D:/project_develop/_holdout'
/** pilot 任务集：用于交集守卫。 */
const PILOT_TASKS = path.join(ROOT, 'evals/pilot/tasks.jsonl')
/** 结果落盘目录。 */
const RESULTS_DIR = path.join(HOLDOUT_ROOT, 'results')

// ── 工具 ──────────────────────────────────────────────────────────────────
const sha256file = (fp) => {
  if (!fs.existsSync(fp)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')
}
const run = (cmd, cwd = ROOT) =>
  spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

// ── 守卫 ──────────────────────────────────────────────────────────────────

/**
 * ★ 路径守卫（R1）：holdout 根必须不在被测仓库树内。
 *   若 holdout 根落在仓库树内 ⇒ Agent 可以篡改结果文件 = 判据失效。
 *   ★ 这是 R1 隔离底线的直接体现：判据数据必须在 Agent 够不到的地方。
 */
function guardPath() {
  const holdoutAbs = path.resolve(HOLDOUT_ROOT)
  const repoAbs = path.resolve(ROOT)
  // ★ 严格的前缀检查：holdoutRoot 必须是 repo 的父目录或完全不同卷
  //   用 startsWith + 分隔符确保 /a/b 不会误匹配 /a/bc
  if (holdoutAbs.startsWith(repoAbs + path.sep)) {
    console.error(
      `✗ R1 路径守卫触发：holdout 根 ${holdoutAbs} 落在被测仓库树 ${repoAbs} 内部` +
        `\n  → 拒绝运行（判据必须在 Agent 够不到的地方）`,
    )
    return false
  }
  return true
}

/**
 * ★ 条数守卫：holdout 任务集必须 ≥ 3 条。
 *   少于 3 条统计意义不足，不足以构成"隐藏测试集"。
 */
function guardCount(tasks) {
  if (tasks.length < 3) {
    console.error(`✗ 条数守卫触发：holdout 任务集只有 ${tasks.length} 条（需 ≥ 3）`)
    return false
  }
  return true
}

/**
 * ★ 交集守卫：holdout id 与 visible（pilot）id 不能有交集。
 *   有交集 = 同一道题既可见又隐藏 = 优化器可针对它优化 = holdout 失效。
 */
function guardIntersection(holdoutIds, pilotIds) {
  const overlap = holdoutIds.filter((id) => pilotIds.includes(id))
  if (overlap.length > 0) {
    console.error(
      `✗ 交集守卫触发：holdout 与 pilot 有 ${overlap.length} 个相同 id：${overlap.join(', ')}` +
        `\n  → 拒绝运行（holdout 必须是 pilot 看不见的独立任务集）`,
    )
    return false
  }
  return true
}

// ── 加载 ──────────────────────────────────────────────────────────────────

function loadTasks(tasksPath) {
  const raw = fs.readFileSync(tasksPath, 'utf8')
  const tasks = []
  raw.split('\n').forEach((line) => {
    const t = line.trim()
    if (!t || t.startsWith('//')) return
    try {
      tasks.push(JSON.parse(t))
    } catch (e) {
      throw new Error(`${tasksPath}: JSON 解析失败：${e.message}`)
    }
  })
  return tasks
}

function loadPilotIds() {
  if (!fs.existsSync(PILOT_TASKS)) return []
  return loadTasks(PILOT_TASKS).map((t) => t.id)
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const tasksPath = process.argv[2] ?? path.join(HOLDOUT_ROOT, 'tasks.jsonl')
/** ★ 自测开关：跳过 R1 路径守卫（仅 --skip-r1-guard 时生效，正式运行不带此参数）。 */
const SKIP_R1_GUARD = process.argv.includes('--skip-r1-guard')
if (!fs.existsSync(tasksPath)) {
  console.error(`✗ holdout 任务集不存在：${tasksPath}`)
  process.exit(1)
}

const tasks = loadTasks(tasksPath)
const pilotIds = loadPilotIds()

// 守卫 ①：路径守卫（自测时可跳过，用 --skip-r1-guard）
if (!SKIP_R1_GUARD && !guardPath()) process.exit(1)
else if (SKIP_R1_GUARD) console.log('  （自测模式：跳过 R1 路径守卫）')

// 守卫 ②：条数守卫
if (!guardCount(tasks)) process.exit(1)

// 守卫 ③：交集守卫
const holdoutIds = tasks.map((t) => t.id)
if (!guardIntersection(holdoutIds, pilotIds)) process.exit(1)

// ── 计算 holdoutHash（任务集文件的 SHA-256，不是结果 hash）────────────────
const holdoutHash = sha256file(tasksPath)
console.log(`holdout 任务集 hash: ${holdoutHash}`)
console.log(`任务数: ${tasks.length}`)

// ── 跑每个任务 ────────────────────────────────────────────────────────────
const perTask = []
let passed = 0
let failed = 0

for (const task of tasks) {
  const tid = task.id
  console.log(`\n── ${tid}`)

  // 跑 oracle
  const oracleResult = run(task.oracle?.cmd ?? [], ROOT)
  const oracleOk = oracleResult.status === 0
  const oracleExit = oracleResult.status

  // 跑回归
  const regResult = run(task.regression?.cmd ?? [], ROOT)
  const regOk = regResult.status === 0

  const ok = oracleOk && regOk
  if (ok) passed++
  else failed++

  perTask.push({
    id: tid,
    oracleOk,
    oracleExit,
    regressionOk: regOk,
    passed: ok,
  })

  console.log(`  oracle: ${oracleOk ? '绿' : '红'} (exit=${oracleExit})`)
  console.log(`  regression: ${regOk ? '绿' : '红'}`)
  console.log(`  => ${ok ? 'PASS' : 'FAIL'}`)
}

// ── 落盘结果（供 gate 读取）──────────────────────────────────────────────
let resultFile = null
try {
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  const resultObj = {
    holdoutHash,
    ranAt: new Date().toISOString(),
    source: {
      cmd: ['node', 'scripts/eval-holdout-run.mjs', tasksPath],
      cwd: ROOT,
      tasksPath,
    },
    totals: { n: tasks.length, passed, failed },
    perTask,
    // R2 自证：每个任务的三段状态（cleanOracle/regression）
    r2Proof: perTask.map((t) => ({
      id: t.id,
      oracleGreen: t.oracleOk,
      regressionGreen: t.regressionOk,
    })),
  }
  // 以第一个能力 ID 命名结果文件（单一 holdout 集对应一个能力的验收）
  const capId = 'l3-holdout'
  resultFile = path.join(RESULTS_DIR, `${capId}.json`)
  fs.writeFileSync(resultFile, JSON.stringify(resultObj, null, 2), 'utf8')
  console.log(`\n结果已落盘：${resultFile}`)
} catch (e) {
  // ★ 写不进（EPERM/沙箱限制）时不抛错：
  //   这是"真 holdout 集的落盘由主线代劳"这条沙箱限制的直接体现 ——
  //   判据本身能运行，只是写不进工作目录外的路径。gate 读到的是 null，
  //   走 fail-closed 路径（blocked）。
  console.warn(`  ⚠ 结果落盘失败（非致命）：${e.code ?? e.message}`)
  console.warn('    → gate 读不到结果时将 blocked（fail-closed）')
  console.warn(`    → 此限制含义：在 workspace-write 档位下，判据落盘到 Agent 够不到的地方`)
  console.warn(`       需要工作区外权限，本机无审批应答者，提权 = 永久卡死（见任务书第 6-12 行）。`)
}

console.log(`\n汇总：${passed}/${tasks.length} 通过，${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
