#!/usr/bin/env node
/**
 * eval-signal-check.mjs —— **R2 的可执行门**：对**指定任务**做三段自证，任一段不满足即非零退出。
 *
 * ## 它补的是哪个缺口（为什么必须有它）
 *
 * `evals/README.md` 的 **R2** 逐字要求：
 *   "每题必须先证明'有信号'：**打上 `seed` 之后 oracle 必须由绿转红**。否则这题是**假题**"。
 * `scripts/eval-validate.mjs` 早就实现了这条口径 —— 但它是**跑整份任务集的校验器**，
 * 没人把它当成"收一道题/改一次装置之后必须过的那道门"来跑 ⇒ **R2 从未被强制执行**。
 *
 * 2026-09-22 的实测后果（O76，见 `docs/skill-as-agent-spec.md` §43.3）：
 *   隔离工作树 `out/_wt/w26-fix` 里 `packages/switchboard/src/index.ts` 是 **CRLF（CR=523）**，
 *   而 `evals/pilot/tasks.jsonl` 的 `find` 写的是 **LF**
 *   ⇒ `find` 匹配 0 次 ⇒ **"seed 后应该红"在这棵树上根本不会红** ⇒ **假绿**
 *   （比假红更坏：假红你会去查，假绿你以为已经查过了）。
 *   ⇒ 本脚本就是那条缺掉的门的机器形态：**三段都过才算"这题在这棵树上真有信号"**。
 *
 * ## 三段（逐条打印结果与判定；失败点名失败类型）
 *
 * ```
 * ① 干净态   → oracle 必须【绿】  否则 BASELINE-RED      （树有问题，或题已失效）
 * ② 打 seed  → oracle 必须【红】  否则 SEED-NOT-EFFECTIVE（★ 就是这次这个 bug）
 * ③ 还原     → oracle 必须【绿】  否则 RESTORE-FAILED    （含"树没回到干净"）
 * ```
 *
 * ## 为什么它**不自己实现**打 seed / 还原（关键设计）
 *
 * seed 的施加与还原**一律委托** `scripts/eval-validate.mjs --prepare|--restore`：
 *   · 那是**生产路径**（`eval-run.mjs` 的 A/B 用的就是它）⇒ 本门拦下的就是真缺陷，
 *     而不是"门自己那份平行实现"里的另一种缺陷；
 *   · 归一化/备份/sha256 只有**一份**实现 ⇒ 不会漂移。
 * ★ 本脚本自己只做三件事：**跑 oracle**、**读只读诊断**、**下判定**。
 *
 * ## 它的分辨力（自证方式，也是它能抓住 O76 的直接证据）
 *
 * 把 seed 的 `find` 换成一个**打不上的字符串**（用 `--tasks` 指一份改了 `find` 的任务集）
 * ⇒ ② 段必须报 `SEED-NOT-EFFECTIVE` 并**非零退出**。
 * ⚠️ 注意区分两种"打不上"：`--prepare` 因锚点 0 次而**拒绝执行**（此时种子根本没打上），
 *   与"打上了但 oracle 仍绿"（这题本来就没信号）—— 本门对两者都报 `SEED-NOT-EFFECTIVE`，
 *   但在输出里**分别点名原因**（不许把两种混成一句）。
 *
 * ## 用法
 *
 *   node scripts/eval-signal-check.mjs --task cli-0001 --repo <工作树>
 *   node scripts/eval-signal-check.mjs --task cli-0001 --repo out/_wt/w27 --oracle "node scripts/test-injected-message-shape.mjs"
 *   node scripts/eval-signal-check.mjs --task cli-0001 --repo <wt> --tasks <改过的 tasks.jsonl> --json <file>
 *
 * 参数：
 *   --task <id|唯一前缀>  必填（例 `cli-0001`）
 *   --repo <path>         被测树（缺省 = 判据根，即本脚本所在仓库）；判据仍从**判据根**跑
 *   --oracle "<cmd>"      覆盖任务集里的 oracle 命令（按空白切词；默认用 `task.oracle.cmd`）
 *   --tasks <file>        任务集路径（缺省：被测树里的那份，找不到则回落到判据根那份）
 *   --json <file>         把三段读数写成 JSON
 *   -h, --help            打印本用法
 *
 * 退出码：0 = 三段全过；1 = 有段不成立（含 RESTORE-FAILED）；2 = 用法/选题问题（含能力题）。
 *
 * ★ 纪律：本脚本**只读**主仓；seed 打在 `--repo` 指的那棵树上；**跑完必须还原**（try/finally 兜底），
 *   并且结尾**逐字量一次 `git status`**——"跑完树要干净"是判据的一部分，不是礼仪。
 * ★ 跑"干净态"之前，本门**自己**先确认树下没有残留 seed（有残留 ⇒ 立刻停：`out/eval-validate` 的
 *   清单还没清 ⇒ "基线"会被污染成假读数），这是 O77 那条教训的直接落地。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NAME = 'eval-signal-check'
const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
/** ★ 判据根：**本脚本所在的仓库** —— 判据（含任务集与 eval-validate）住在这里，永远是被信的那一侧。 */
const JUDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 与 `eval-validate.mjs` 同一优先级：`--repo` ＞ `DSH_EVAL_REPO` ＞ 判据根（原来的硬编码值）。 */
const REPO_GIVEN = argOf('--repo') ?? process.env.DSH_EVAL_REPO ?? null
const TREE = REPO_GIVEN ? path.resolve(REPO_GIVEN) : JUDGE_ROOT
const TASKS = (() => {
  const given = argOf('--tasks')
  if (given) return path.resolve(TREE, given)
  const local = path.resolve(TREE, 'evals/pilot/tasks.jsonl')
  if (!REPO_GIVEN || fs.existsSync(local)) return local
  return path.resolve(JUDGE_ROOT, 'evals/pilot/tasks.jsonl')
})()

const USAGE = `${NAME} —— R2 的可执行门：对**指定任务**三段自证（干净绿 / seed 红 / 还原绿）

用法：
  node scripts/eval-signal-check.mjs --task <id|唯一前缀> [--repo <被测树>] [--oracle "<cmd>"]
                                     [--tasks <任务集>] [--json <file>]

三段（任一段不成立 ⇒ 非零退出，并点名失败类型）：
  ① 干净态：oracle 必须【绿】  否则 BASELINE-RED
  ② 打 seed：oracle 必须【红】  否则 SEED-NOT-EFFECTIVE
  ③ 还原：  oracle 必须【绿】且 git status 为空  否则 RESTORE-FAILED

退出码：0 = 三段全过；1 = 有段不成立；2 = 用法/选题问题（含"能力题没有 seed"）。
`

const say = (s = '') => console.log(s)
const tail = (s, n = 8) => {
  const lines = String(s ?? '').replace(/\r\n/g, '\n').trimEnd().split('\n')
  return lines.slice(-n).join('\n')
}
const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)

/** 跑 oracle：**从判据根跑**（R1：判据不在被测树里），用 `DSH_EVAL_REPO` 指认被测树（口径同 `eval-validate.mjs`）。 */
function runOracle(cmd) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd: JUDGE_ROOT,
    ...(REPO_GIVEN ? { env: { ...process.env, DSH_EVAL_REPO: TREE } } : {}),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}
/** 委托生产路径：`eval-validate.mjs --prepare|--restore`（seed 的施加与还原只此一份实现）。 */
function runValidate(mode, taskId) {
  const args = ['scripts/eval-validate.mjs', '--repo', TREE, '--tasks', TASKS]
  if (mode === 'prepare') args.push('--only', taskId, '--prepare', taskId)
  else args.push('--restore')
  return spawnSync(process.execPath, args, { cwd: JUDGE_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}
/** 工作树是否干净。
 *  ★ 带 `-c core.autocrlf=false -c core.eol=lf` 是为了**尽量不归一化**地看真实字节差。
 *  ⚠️ 但**它不是行尾问题的可靠判据**（别把它当 O76 的判官）：2026-09-22 实测到
 *     `out/_wt/w26-fix` 里 `index.ts` **CR=523、`ls-files --eol` 报 `w/crlf`，
 *     而 `git status --porcelain`（默认/strict 两种视角都试过）报**空**——
 *     而且刚写完文件（size 变了）时同一棵树**会**报 ` M`。⇒ `git status` 对"只差行尾"的改动**不可靠**。
 *  ⇒ 本门真正靠得住的是：① seed 目标文件的 **sha256 逐字节**对比（与行尾风格无关）；
 *     ② `git ls-files --eol` 这类**直接读工作区**的读数（`eval-wt-new.mjs` 的 [5b] 就用它）。
 *     git status 在这里只当**辅助**（问答"本门有没有留下新东西"）。
 */
function porcelain(dir) {
  const r = spawnSync('git', ['-C', dir, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'status', '--porcelain'], {
    cwd: JUDGE_ROOT,
    encoding: 'utf8',
  })
  if (r.status !== 0) return { ok: false, lines: [], why: `git status 跑不动（exit=${r.status}；不是 git 树？）` }
  const lines = String(r.stdout ?? '').split('\n').filter((l) => l.trim())
  return { ok: true, lines, why: lines.length ? `${lines.length} 行未提交改动` : '为空' }
}
/**
 * 只读诊断：seed 的锚点在**这棵树**里能命中几处、命中在**第几行**。
 * ★ 匹配在 **LF 归一化空间**里做 —— 与 `eval-validate.mjs` 的 O76 口径一致（那是纪律，也是诊断口径）。
 * 本函数**不改任何东西**；真正的施加一律委托 `--prepare`。
 */
const toLf = (s) => String(s).replace(/\r\n/g, '\n')
/** 在任意文本里数锚点命中（LF 归一化口径）并给出第一处所在行 —— 与 `eval-validate.mjs` 的 O76 口径一致。 */
function scanAnchors(text, find) {
  const lf = toLf(text)
  const needle = toLf(find)
  let hits = 0
  let first = null
  for (let at = needle ? lf.indexOf(needle) : -1; at >= 0; at = lf.indexOf(needle, at + 1)) {
    hits++
    if (first === null)
      first = { line: lf.slice(0, at).split('\n').length, text: lf.slice(at, at + needle.length).split('\n')[0] }
    if (hits > 64) break
  }
  return { hits, first }
}
function anchorDiag(abs, find) {
  const raw = fs.readFileSync(abs, 'utf8')
  const { hits, first } = scanAnchors(raw, find)
  const crlf = (raw.match(/\r\n/g) ?? []).length
  return { hits, first, fileCrlf: crlf, fileLfOnly: crlf === 0 }
}
/**
 * ★★ 分辨"**场地未复位**"与"**这道题本身坏了**"——两者都会让工作区的锚点命中 0 次，
 * 但处置完全不同（前者去还原，后者去改题）：
 *   · 锚点在工作区 **0 次** 而 **HEAD 里恰好 1 次** ⇒ 工作区被人动过 ⇒ **残留 seed / 场地未复位**；
 *   · 两边都 0 次 ⇒ 是**题目的锚点失效了** ⇒ 不拦，交给 ② 段如实报 `SEED-NOT-EFFECTIVE`。
 * （不给这个分辨，"题坏了"会被误诊成"树脏了" —— 正是上一轮那个教训的反面。）
 */
function headAnchorHits(rel, find) {
  if (!fs.existsSync(path.join(TREE, '.git'))) return null
  const r = spawnSync('git', ['-C', TREE, 'show', `HEAD:${rel}`], { cwd: JUDGE_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return null
  return scanAnchors(r.stdout, find).hits
}

// ── 参数校验 ──────────────────────────────────────────────────────────────
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
const taskSel = argOf('--task')
if (!taskSel) {
  process.stderr.write(`[${NAME}] 用法错误：--task 必填\n\n${USAGE}`)
  process.exit(2)
}
if (!fs.existsSync(TASKS)) {
  process.stderr.write(`[${NAME}] 任务集不存在：${TASKS}\n`)
  process.exit(2)
}
const allTasks = fs
  .readFileSync(TASKS, 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('//'))
  .map((l) => JSON.parse(l))
const exact = allTasks.find((t) => t.id === taskSel)
const prefixed = allTasks.filter((t) => t.id.startsWith(taskSel))
if (!exact && prefixed.length !== 1) {
  process.stderr.write(
    `[${NAME}] --task '${taskSel}' ${prefixed.length > 1 ? `匹配到多题：${prefixed.map((t) => t.id).join(', ')}` : '匹配不到任何题'}\n` +
      `     可用：${allTasks.map((t) => t.id).join(', ')}\n`,
  )
  process.exit(2)
}
const task = exact ?? prefixed[0]
const edits = Array.isArray(task?.seed?.edits) ? task.seed.edits : null
const oracleCmd = (() => {
  const o = argOf('--oracle')
  if (o) return o.trim().split(/\s+/)
  return Array.isArray(task?.oracle?.cmd) ? task.oracle.cmd : null
})()

say(`${NAME} —— R2 三段自证`)
say(`  任务      : ${task.id}`)
say(`  被测树    : ${TREE}${REPO_GIVEN ? '' : '   ★ 未给 --repo ⇒ 就是判据根（主仓）本身'}`)
say(`  判据根    : ${JUDGE_ROOT}`)
say(`  任务集    : ${TASKS}`)
say(`  oracle    : ${(oracleCmd ?? []).join(' ')}`)
say('')

// ★ 能力题（空 seed）：本门的"三段"在它身上**没有定义**（没有"打 seed"这一步）⇒ 明确拒绝，
//   而不是硬套三段判它一个 BASELINE-RED（那是把口径用错地方，会误导下一个人去"修"一道好题）。
//   能力题的有效性判据是"HEAD 上 oracle 必须红"，由 `eval-validate.mjs` 默认校验管。
if (!edits || edits.length === 0) {
  say(`✗ STAGES-NOT-APPLICABLE —— 本题 \`seed.edits\` 为空（kind=${task.kind ?? '?'}，能力题）`)
  say(`  本门的三段自证只对**有 seed 的题**有定义：能力题没有"把修复打回去"这一步，`)
  say(`  它的有效性判据是"**HEAD 上 oracle 必须红**"（见 \`scripts/eval-validate.mjs\` 的空 seed 分支）。`)
  say(`  ⇒ 拒绝在它身上跑本门（宁可不给结论，也不给一个用错口径的结论）。`)
  process.exit(2)
}
if (!oracleCmd || oracleCmd.length === 0) {
  say('✗ 用法问题：本题没有 `oracle.cmd`，且命令行也没给 `--oracle` ⇒ 无从判')
  process.exit(2)
}

// ── 只读诊断：锚点在这棵树里长什么样（先看清，再动手）──────────────────────
say('── 只读诊断（动手前）')
const diags = edits.map((e) => {
  const abs = path.join(TREE, e.file)
  if (!fs.existsSync(abs)) return { file: e.file, exists: false }
  return { file: e.file, exists: true, ...anchorDiag(abs, e.find) }
})
for (const d of diags) {
  if (!d.exists) {
    say(`   · ${d.file}  **不存在于被测树**`)
    continue
  }
  say(
    `   · ${d.file}  锚点命中 ${d.hits} 次（LF 归一化口径）` +
      (d.first ? `  → 第 ${d.first.line} 行：${JSON.stringify(d.first.text.slice(0, 70))}` : '') +
      `  文件行尾：${d.fileLfOnly ? '纯 LF' : `含 CRLF（CR=${d.fileCrlf}）`}`,
  )
}
// ★ O77 的教训落地：**跑基线之前先确认场地已复位**。
//   判据必须是"**上一次的 seed 还在不在**"的直接指纹，而**不是**"仓库有没有未提交改动"
//   （后者在主仓几乎恒为真 —— 拿它当条件会让本门在主仓上永远开不了，等于没有门）：
//     ① `eval-validate` 的**还原清单**还在 ⇒ 树里可能还打着上一次的 seed（这就是 O77 的形状）；
//     ② 锚点在工作区 0 次、而 **HEAD 里恰好 1 次** ⇒ 工作区那个位置被人动过 ⇒ 残留 seed。
//   ⚠️ ②**必须**与 HEAD 对照：只看"工作区 0 次"会把"题目锚点失效"误诊成"树脏了"，
//     那样门就会在负样本上先拦一道、反而报不出 `SEED-NOT-EFFECTIVE`（校准过，见报告）。
//   ★ 另外把"跑之前的 git status（**不归一化**）"原样记下来：结尾要求它**逐行不变**
//     （"跑完树要干净"= 本门没多留下东西；而不是"仓库必须一尘不染"）。
const isGitTree = fs.existsSync(path.join(TREE, '.git'))
const stateDir = REPO_GIVEN
  ? path.join(JUDGE_ROOT, 'out', 'eval-wt-state', crypto.createHash('sha1').update(TREE).digest('hex').slice(0, 8))
  : path.join(TREE, 'out')
const manifestPath = path.join(stateDir, 'eval-prepare.json')
const statusBefore = isGitTree ? porcelain(TREE) : { ok: true, lines: [], why: '（不是 git 树，跳过）' }
const manifestThere = fs.existsSync(manifestPath)
const seededSuspect = edits
  .filter((e) => {
    const d = diags.find((x) => x.file === e.file)
    if (!d?.exists || d.hits !== 0) return false
    return headAnchorHits(e.file, e.find) === 1 // HEAD 里 1 次、工作区 0 次 ⇒ 工作区被动了
  })
  .map((e) => e.file)
const residual = []
if (manifestThere) residual.push(`eval-validate 的还原清单还在：${manifestPath}`)
if (seededSuspect.length)
  residual.push(`锚点在 HEAD 里恰好 1 次、在工作区 0 次（= 这个位置被人动过）⇒ 疑似残留 seed：${seededSuspect.join(', ')}`)
say(
  `   · 场地复位自检：还原清单 ${manifestThere ? '**在**' : '不在'}；` +
    `锚点"HEAD 1 次/工作区 0 次"的文件 ${seededSuspect.length} 个；git status（不归一化）${statusBefore.lines.length} 行`,
)
if (residual.length) {
  say('')
  say('✗ 场地**未复位** —— 现在跑"干净态"读到的是被污染的基线（这正是 O77 那个陷阱）：')
  for (const r of residual) say(`      · ${r}`)
  say(`  ⇒ 先复位（\`node scripts/eval-validate.mjs --repo "${TREE}" --restore\`），再跑本门。`)
  process.exit(1)
}
/** 各 seed 目标文件的**改前字节指纹** —— 后面用它独立证明"还原真的还原了"。 */
const shaOf = (rel) => {
  const p = path.join(TREE, rel)
  return fs.existsSync(p) ? sha16(fs.readFileSync(p)) : null
}
const targetShasBefore = Object.fromEntries(edits.map((e) => [e.file, shaOf(e.file)]))
say('')

// ── 三段 ─────────────────────────────────────────────────────────────────
const R = {
  at: new Date().toISOString(),
  task: task.id,
  tree: TREE,
  judgeRoot: JUDGE_ROOT,
  oracle: oracleCmd.join(' '),
  diag: diags,
  statusBefore: statusBefore.lines,
  targetShasBefore,
  baseline: null,
  seed: { applied: false, prepareOut: null, oracleStatus: null },
  restore: { restored: false, restoreOut: null, oracleStatus: null, porcelain: null },
  verdict: null,
  failureType: null,
  reason: null,
}
let seedApplied = false
let restoreDone = false
const restoreOnce = () => {
  const out = runValidate('restore')
  restoreDone = out.status === 0
  R.restore.restoreOut = { status: out.status, tail: tail(out.stdout, 12) }
  return out
}

try {
  // ① 干净态 → 必须绿
  say('── ① 干净态：oracle 必须【绿】')
  const o1 = runOracle(oracleCmd)
  R.baseline = { status: o1.status, tail: tail(`${o1.stdout ?? ''}${o1.stderr ?? ''}`, 10) }
  say(`   exit=${o1.status}  ⇒ ${o1.status === 0 ? '绿 ✓' : '红 ✗'}`)
  if (o1.status !== 0) {
    say(tail(`${o1.stdout ?? ''}${o1.stderr ?? ''}`, 10))
    R.verdict = 'FAIL'
    R.failureType = 'BASELINE-RED'
    R.reason = '干净态 oracle 就是红的 ⇒ 要么这棵树本身有问题（缺产物/建树不完整），要么这道题已经失效（上游把修复吃掉了，seed 也就没有意义）'
    say('')
  } else {
    say('')

    // ② 打 seed → 必须红（施加与还原都委托生产路径）
    say('── ② 打 seed：oracle 必须【红】')
    const prep = runValidate('prepare', task.id)
    seedApplied = prep.status === 0
    R.seed.applied = seedApplied
    R.seed.prepareOut = { status: prep.status, tail: tail(prep.stdout, 12) }
    say(`   eval-validate --prepare exit=${prep.status}  ⇒ ${seedApplied ? 'seed 已打上' : '**没能打上**'}`)
    if (!seedApplied) {
      say(tail(prep.stdout, 12))
      R.verdict = 'FAIL'
      R.failureType = 'SEED-NOT-EFFECTIVE'
      R.reason = `seed **没能打上**（--prepare exit=${prep.status}）：锚点在这棵树里按 LF 归一化口径只命中 ${diags.map((d) => d.hits).join('/')} 次（必须恰好 1 次）⇒ 本题在这棵树上**根本不会红** ⇒ 正是 O76 那个假绿`
      say('')
    } else {
      // seed 打上之后：把"打在哪"记成机器证据（只读）
      if (isGitTree) {
        const d = spawnSync('git', ['-C', TREE, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'diff', '--stat'], {
          cwd: JUDGE_ROOT,
          encoding: 'utf8',
        })
        R.seed.diffStat = tail(d.stdout, 6)
        say(`   seed 之后 git diff --stat: ${R.seed.diffStat.trim().replace(/\n/g, ' | ')}`)
      }
      const o2 = runOracle(oracleCmd)
      R.seed.oracleStatus = o2.status
      say(`   oracle exit=${o2.status}  ⇒ ${o2.status !== 0 ? '红 ✓（这就是 R2 要的证据）' : '绿 ✗'}`)
      say(tail(`${o2.stdout ?? ''}${o2.stderr ?? ''}`, 10))
      if (o2.status === 0) {
        R.verdict = 'FAIL'
        R.failureType = 'SEED-NOT-EFFECTIVE'
        R.reason = 'seed **确实打上了**（--prepare 成功、git diff 有改动），但 oracle **仍是绿的** ⇒ 改动与判据无关 = 这题没有信号'
      }
      say('')
    }

    // ③ 还原 → 必须绿 且 树必须回到起点（无论②结果如何都要还原：树必须回到起点）
    say('── ③ 还原：oracle 必须【绿】，且 seed 目标**逐字节回到改前**、git status 不多出东西')
    const rest = restoreOnce()
    const o3 = runOracle(oracleCmd)
    R.restore.oracleStatus = o3.status
    const shasAfter = Object.fromEntries(edits.map((e) => [e.file, shaOf(e.file)]))
    R.restore.targetShas = { before: targetShasBefore, after: shasAfter }
    const byteOk = edits.every((e) => targetShasBefore[e.file] === shasAfter[e.file])
    const pr = isGitTree ? porcelain(TREE) : { ok: true, lines: [], why: '（不是 git 树，跳过）' }
    const statusSame = JSON.stringify(pr.lines) === JSON.stringify(statusBefore.lines)
    R.restore.ok = rest.status === 0 && o3.status === 0 && byteOk && statusSame
    R.restore.porcelain = { ok: pr.ok, lines: pr.lines, why: pr.why, sameAsBefore: statusSame, before: statusBefore.lines }
    say(`   eval-validate --restore exit=${rest.status}  ⇒ ${rest.status === 0 ? '已还原 ✓' : '**还原失败** ✗'}`)
    if (rest.status !== 0) say(tail(rest.stdout, 12))
    say(`   oracle exit=${o3.status}  ⇒ ${o3.status === 0 ? '绿 ✓' : '红 ✗'}`)
    // ★ 独立于 git 的**字节级**证明：seed 目标文件的 sha256 必须与跑之前一致
    for (const e of edits) {
      const same = targetShasBefore[e.file] === shasAfter[e.file]
      say(`   ${same ? '✓' : '✗'} ${e.file}  sha ${targetShasBefore[e.file]} → ${shasAfter[e.file]}`)
    }
    say(
      `   git status --porcelain（不归一化）⇒ 跑前 ${statusBefore.lines.length} 行 / 跑后 ${pr.lines.length} 行  ` +
        `${statusSame ? '逐行一致 ✓' : '**不一致** ✗'}`,
    )
    if (!statusSame) for (const l of pr.lines.slice(0, 10)) say(`      ${l}`)
    if (R.verdict !== 'FAIL' && (rest.status !== 0 || o3.status !== 0 || !byteOk || !statusSame)) {
      R.verdict = 'FAIL'
      R.failureType = 'RESTORE-FAILED'
      R.reason =
        `还原这一步不成立：--restore exit=${rest.status}、还原后 oracle exit=${o3.status}、` +
        `seed 目标逐字节回到改前=${byteOk ? '是' : '**否**'}、git status 与跑前一致=${statusSame ? '是' : '**否**'}` +
        ' ⇒ 树没有回到起点（下一轮的"干净态"会被污染）'
    }
    say('')
  }
} finally {
  // ★ 兜底：只要 seed 可能还留在树上，就再还原一次（幂等）。**绝不把带 seed 的树留给下一个人。**
  if (seedApplied && !restoreDone) {
    say('── finally：② 之后没能走到"已还原"⇒ 强制执行一次还原')
    const r = restoreOnce()
    const pr = isGitTree ? porcelain(TREE) : { ok: true, lines: [], why: '' }
    say(`   --restore exit=${r.status}；git status ${pr.lines.length === 0 ? '空 ✓' : `**${pr.lines.length} 行** ✗`}`)
    if (!R.verdict) {
      R.verdict = 'FAIL'
      R.failureType = 'RESTORE-FAILED'
      R.reason = '三段没跑完就退出了（异常）⇒ 由 finally 兜底还原；这不等于通过'
    }
    R.restore.porcelain = { ok: pr.ok, lines: pr.lines, why: pr.why }
  }
}

// ── 判定与汇总（★ 逐条打印三段的结果与判定）────────────────────────────────
const pass = R.verdict !== 'FAIL'
if (pass) R.verdict = 'PASS'
say('─'.repeat(78))
say('三段判定：')
say(
  `  ① 干净态   oracle=${R.baseline?.status ?? '?'}  ${R.baseline?.status === 0 ? '绿 ✓' : '红 ✗'}  ` +
    `${R.baseline?.status === 0 ? 'PASS' : 'FAIL(BASELINE-RED)'}`,
)
say(
  `  ② 打seed   applied=${R.seed.applied ? 'yes' : 'NO'} oracle=${R.seed.oracleStatus ?? '?'}  ` +
    `${R.seed.applied && R.seed.oracleStatus !== 0 ? '红 ✓  PASS（这题有信号）' : '✗  FAIL(SEED-NOT-EFFECTIVE)'}`,
)
say(
  `  ③ 还原     restored=${R.restore.restoreOut?.status === 0 ? 'yes' : 'no'} oracle=${R.restore.oracleStatus ?? '?'} ` +
    `逐字节回改前=${R.restore.targetShas?.before && R.restore.targetShas?.after ? (edits.every((e) => R.restore.targetShas.before[e.file] === R.restore.targetShas.after[e.file]) ? 'yes' : 'NO') : 'pass'} ` +
    `status与跑前一致=${R.restore.porcelain?.sameAsBefore ? 'yes' : 'no'}  ` +
    `${R.restore.ok ? '绿 ✓  PASS' : '✗  FAIL(RESTORE-FAILED)'}`,
)
say('')
if (pass) {
  say(`结论：✓ PASS —— ${task.id} 在 ${TREE} 上**三段全过**（干净绿 → seed 红 → 还原绿）`)
  say(`      ⇒ 这题在这棵树上"有信号"：seed 真的把它打红、还原真的把它收回来。`)
} else {
  say(`结论：✗ FAIL —— 失败类型 **${R.failureType}**`)
  say(`      原因：${R.reason}`)
}
const jsonOut = argOf('--json')
if (jsonOut) {
  const abs = path.isAbsolute(jsonOut) ? jsonOut : path.join(JUDGE_ROOT, jsonOut)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(R, null, 2), 'utf8')
  say(`JSON → ${abs}`)
}
process.exit(pass ? 0 : 1)
