#!/usr/bin/env node
/**
 * eval-run.mjs —— M1-step-2（第一版）：把冻结任务当题面交给 **当前活跃代的 Agent**，量它能不能修好。
 *
 * 这是"单臂基线"：先回答「我们自己的 Agent，在预算内，能不能修好这些回归」。
 * 「现行 vs 挑战者」的成对比较、影子只读沙箱、pass^k 都留到后续（见
 * `docs/oss-prior-art-and-next-steps.md` 的 M1/M2 与 `evals/README.md`）。
 *
 * ## 判据（全部可机验，不靠人看）
 *
 * - **题目有信号**：打上 seed 后 oracle 必须**变红**（复用 `eval-validate.mjs --prepare` 的同一段代码）。
 * - **Agent 修好了吗**：oracle 由红转绿。
 * - **没弄坏别的吗**：`regression` 必须绿。
 * - **超预算即失败**：`budget.maxMinutes` 到点就判失败（不许靠多试几次蒙对）。
 * - 记账：步数 / token / 墙钟（从 `session.list` 的投影读），以及 `git diff --stat`（它到底改了什么）。
 *
 * ## 用法
 *
 *   node scripts/eval-run.mjs --list                            # 列出任务
 *   node scripts/eval-run.mjs --plan --task cli-0001            # 只打印计划（不动任何东西）
 *   node scripts/eval-run.mjs --task cli-0001 --session <sid>   # 真跑（见下面的"安全和副作用"）
 *
 * ## 安全和副作用（真跑会动东西，先读）
 *
 * - 用 `git` 判断工作区**必须干净**（seed/还原依赖 HEAD 当基准），脏了就拒绝跑。
 * - 打 seed / 还原走 `eval-validate.mjs --prepare|--restore`（字节级备份 + sha256 校验）。
 * - **题面会发进你指定的会话**（会消耗 token、会往那份会话里写记录）⇒ 必须显式传 `--session`。
 * - 结束时还原被 seed 的文件，并把 `git status` 打出来 —— Agent 若改动了别的文件，你能一眼看到。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const REPO = 'D:/project_develop/dsh-brain'
const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const TASKS = path.join(REPO, 'evals/pilot/tasks.jsonl')
const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const has = (k) => argv.includes(k)

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
const loadTasks = () =>
  fs
    .readFileSync(TASKS, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .map((l) => JSON.parse(l))

async function rpc(method, payload) {
  const res = await fetch(`${FRONT}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: null, text: text.slice(0, 400) }
  }
}

async function sessionStats(sid) {
  const r = await rpc('session.list', {})
  const items = r.json?.result?.value?.items ?? []
  const s = items.find((x) => x.sessionId === sid)
  if (!s) return null
  const st = s.projections?.values?.sessionStats ?? {}
  const tk = s.projections?.values?.tokenUsage ?? {}
  return {
    running: !!s.running,
    asOfSeq: s.projections?.asOfSeq ?? null,
    steps: st.steps ?? null,
    turns: st.turns ?? null,
    outputTokens: tk.outputTokens ?? null,
    uncachedInputTokens: tk.uncachedInputTokens ?? null,
    cwd: s.cwd ?? null,
  }
}

/**
 * "工作区干净"只要求**已跟踪文件没有改动**（seed/还原以 HEAD 为基准）。
 * 未跟踪的新文件（比如本脚本自己、新写的文档）不该拦住实验 —— 但要**打出来**让人看到。
 */
function worktreeState() {
  const lines = sh('git', ['status', '--porcelain']).stdout.split('\n').filter((l) => l.trim())
  const modifiedTracked = lines.filter((l) => /^( M|M |MM|A | D|D )/.test(l))
  const untracked = lines.filter((l) => l.startsWith('??'))
  return { modifiedTracked, untracked, clean: modifiedTracked.length === 0 }
}
function taskPrompt(t) {
  return [
    '【评测任务】仓库里有一处回归，导致下面这条不变量被破坏：',
    '',
    `  ${t.invariant}`,
    '',
    '请定位并修好它（以仓库内现有代码为准；修完必须让仓库自己的检查脚本通过）。',
    '要求：① 不要向我提问、不要等我确认；② 修完就停手，不要顺手重构无关代码；',
    '③ 用你能用的工具**实际改文件**，不要只在回答里贴 patch。',
    '验证命令（你可以自己先跑）：' + (t.oracle?.cmd ?? []).join(' '),
  ].join('\n')
}

// ── --list ─────────────────────────────────────────────────────────────────
const tasks = loadTasks()
if (has('--list')) {
  console.log(`任务集 ${path.relative(REPO, TASKS)}（${tasks.length} 题）`)
  for (const t of tasks) {
    console.log(`  ${t.id}`)
    console.log(`     不变量：${t.invariant}`)
    console.log(`     oracle：${(t.oracle?.cmd ?? []).join(' ')}   budget：≤${t.budget?.maxToolCalls ?? '?'} 次工具 / ≤${t.budget?.maxMinutes ?? '?'} 分钟`)
  }
  process.exit(0)
}

const taskId = argOf('--task')
// 允许**唯一前缀**（`--task cli-0002` 就够，不用敲全 id）
const exact = tasks.find((t) => t.id === taskId)
const prefix = taskId ? tasks.filter((t) => t.id.startsWith(taskId)) : []
if (!exact && prefix.length > 1) {
  console.error(`--task ${taskId} 匹配到多题：${prefix.map((t) => t.id).join(', ')}`)
  process.exit(1)
}
const task = exact ?? prefix[0]
if (!task) {
  console.error(`--task 必填且要匹配任务集里的 id。可用：${tasks.map((t) => t.id).join(', ')}`)
  process.exit(1)
}

// ── --plan：只打印计划 ─────────────────────────────────────────────────────
const sid = argOf('--session')
if (has('--plan') || !sid) {
  const wt = worktreeState()
  console.log(`任务：${task.id}`)
  console.log(` 不变量：${task.invariant}`)
  console.log(` seed（反向打回）：`)
  for (const e of task.seed.edits) console.log(`   · ${e.file}`)
  console.log(` oracle（FAIL_TO_PASS）：${task.oracle.cmd.join(' ')}`)
  console.log(` regression（不许弄坏）：${task.regression.cmd.join(' ')}`)
  console.log(` budget：≤${task.budget?.maxToolCalls} 次工具 / ≤${task.budget?.maxMinutes} 分钟（超即失败）`)
  console.log(` 工作区是否干净：${wt.clean ? '已跟踪文件无改动 ✓' : '**有已跟踪文件被改**（真跑会被拒绝）'}`)
  if (wt.untracked.length) console.log(` 未跟踪的新文件（不拦实验）：${wt.untracked.slice(0, 5).join(' / ')}${wt.untracked.length > 5 ? ` …等 ${wt.untracked.length} 项` : ''}`)
  console.log(` 会话：${sid ? sid : '(未指定 —— 真跑必须 --session <sessionId>，会往那份会话里发题面)'}`)
  console.log(`\n真跑：node scripts/eval-run.mjs --task ${task.id} --session <sessionId>`)
  console.log(`（计划里含 ${task.metrics?.length ?? 0} 项要记账的指标：${(task.metrics ?? []).join(', ')}）`)
  process.exit(0)
}

// ── 真跑 ───────────────────────────────────────────────────────────────────
const t0 = Date.now()
const report = { task: task.id, session: sid, at: new Date().toISOString(), stages: {} }
const done = (code) => {
  const out = path.join(REPO, 'out', `eval-run-${task.id}-${Date.now()}.json`)
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n报告 → ${path.relative(REPO, out)}`)
  process.exit(code)
}

const wtRun = worktreeState()
if (!wtRun.clean) {
  console.error('有**已跟踪文件被改动**，拒绝跑（seed/还原以 HEAD 为基准）：\n' + wtRun.modifiedTracked.join('\n'))
  process.exit(1)
}

const budgetMs = (task.budget?.maxMinutes ?? 15) * 60_000
const oracle = task.oracle.cmd
const regression = task.regression.cmd

// ① 打 seed + 证明题目有信号
console.log('① 打 seed 并确认 oracle 变红（题目有信号）…')
const prep = sh('node', ['scripts/eval-validate.mjs', '--only', task.id, '--prepare', task.id])
if (prep.status !== 0) {
  console.error(prep.stdout + prep.stderr)
  done(1)
}
// ★ 断言 seed **真的打在了本题点名的文件上**（2026-09-20 加的：此前 `--prepare <id>` 因 CLI 缺陷
//   静默打了第一题，导致"题目没有信号"的假警报，白查一圈）。判据：git 看到的改动文件集合 == seed 点名的文件集合。
const expectFiles = [...new Set(task.seed.edits.map((e) => e.file))].sort()
const changedFiles = sh('git', ['diff', '--name-only']).stdout.split('\n').filter((l) => l.trim()).sort()
report.stages.seedFiles = { expect: expectFiles, actual: changedFiles }
if (JSON.stringify(expectFiles) !== JSON.stringify(changedFiles)) {
  console.error(
    `seed 打错了地方：期望改动 ${expectFiles.join(', ')}，实际改动 ${changedFiles.join(', ') || '(无)'}\n` +
      `⇒ 弃跑（否则后面的"没信号/有余量"全不可信）`,
  )
  sh('node', ['scripts/eval-validate.mjs', '--restore'])
  done(1)
}
const seeded = sh(oracle[0], oracle.slice(1))
report.stages.seededOracle = { status: seeded.status, hasSignal: seeded.status !== 0 }
if (seeded.status === 0) {
  console.error('题目没有信号（seed 之后 oracle 仍绿）⇒ 弃跑，先修题')
  sh('node', ['scripts/eval-validate.mjs', '--restore'])
  done(1)
}
console.log('   ✓ 有信号：oracle 现在红')

// ② 交给 Agent
const before = await sessionStats(sid)
console.log(`② 把题面发给会话 ${sid}（cwd=${before?.cwd ?? '?'}）…`)
report.stages.before = before
const sent = await rpc('session.prompt', {
  sessionId: sid,
  mode: 'steer',
  content: [{ type: 'text', text: taskPrompt(task) }],
})
report.stages.promptStatus = sent.status
if (sent.status !== 200) {
  console.error(`发题面失败：HTTP ${sent.status} ${sent.text ?? JSON.stringify(sent.json)?.slice(0, 300)}`)
  sh('node', ['scripts/eval-validate.mjs', '--restore'])
  done(1)
}

// ③ 等它跑完（或超预算）
let last = before
let outcome = 'timeout'
const deadline = Date.now() + budgetMs
for (;;) {
  await new Promise((r) => setTimeout(r, 4000))
  last = (await sessionStats(sid)) ?? last
  if (last && last.running === false && (last.asOfSeq ?? 0) !== (before?.asOfSeq ?? 0)) {
    outcome = 'settled'
    break
  }
  if (Date.now() > deadline) {
    outcome = 'over-budget'
    break
  }
}
const wallMs = Date.now() - t0
report.stages.after = last
report.stages.outcome = outcome
report.stages.wallMs = wallMs
const stepDelta = (last?.steps ?? 0) - (before?.steps ?? 0)
const tokDelta = (last?.outputTokens ?? 0) - (before?.outputTokens ?? 0)
report.stages.stepDelta = stepDelta
report.stages.tokenDelta = tokDelta
console.log(`   结束：${outcome}（${(wallMs / 1000).toFixed(0)}s，steps +${stepDelta}，outputTokens +${tokDelta}）`)

// ④ 判据
const after = sh(oracle[0], oracle.slice(1))
const reg = sh(regression[0], regression.slice(1))
const diff = sh('git', ['diff', '--stat']).stdout.trim()
report.stages.oracleAfter = { status: after.status, pass: after.status === 0 }
report.stages.regression = { status: reg.status, pass: reg.status === 0 }
report.stages.diffStat = diff
report.stages.verdict = outcome === 'settled' && after.status === 0 && reg.status === 0 ? 'FIXED' : 'NOT-FIXED'
report.stages.budgetOk = outcome !== 'over-budget'

// ⑤ 还原
sh('node', ['scripts/eval-validate.mjs', '--restore'])
const afterRestore = sh('git', ['status', '--porcelain']).stdout.trim()
report.stages.statusAfterRestore = afterRestore

console.log('')
console.log(`④ oracle：${after.status === 0 ? '绿 ✓' : '红 ✗'}   regression：${reg.status === 0 ? '绿 ✓' : '红 ✗'}`)
console.log(`   它改了什么：\n${diff || '   （无改动）'}`)
console.log(`⑤ 已还原被 seed 的文件；还原后 git status：${afterRestore ? '\n' + afterRestore : ' 干净 ✓'}`)
console.log('')
console.log(`结论：**${report.stages.verdict}**（outcome=${outcome}，预算内=${report.stages.budgetOk}）`)
done(report.stages.verdict === 'FIXED' ? 0 : 2)
