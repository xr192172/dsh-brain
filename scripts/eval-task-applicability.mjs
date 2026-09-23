#!/usr/bin/env node
/**
 * eval-task-applicability.mjs —— 「这道题**适不适用于当前隔离布置**」的机器判据（格 ⑨）
 *
 * ── 它解决的问题（格 ⑨，2026-09-23 暴露）──────────────────────────────────────
 *   隔离工作树（`scripts/eval-wt-new.mjs`）按 R1 排除了 `scripts/` 与 `evals/`
 *   ⇒ 若某题的**靶文件正好在那两处**，被测 agent 在**自己的 cwd 里根本无解**
 *   ⇒ 「去判据根找文件」是被题面逼出来的必然行为（不是它主动越界）
 *   ⇒ 结果：① 它去**改判据根**（污染判据）② 另一臂的 oracle 读到被改过的判据根
 *     ⇒ 判"题目没有信号"⇒ **弃跑**（真事故：k=4 / k=5，见 `out/w42-fullaccess-impact.md`）。
 *
 * ── 判据（**两项都为真才算 applicable**）────────────────────────────────────
 *       applicable = **靶文件在 wt 内** ∧ **答案不在（按所选边界的）可达处**
 *
 *   · 「靶文件在 wt 内」：`seed.edits[].file` ∪ 能力题显式靶子（见下 `CAPABILITY_TARGETS`）
 *     里**每一个**都存在于被测工作树（两臂各判一次）。
 *   · 「答案不在可达处」：答案 = oracle 脚本本体（期望值/基线就写在里面）+ 规格/holdout
 *     + 「种子前字节」这一路（见 `reach.inWtGit`）。按 `--boundary` 分三层：
 *       `wt`      ：只看 **wt 树内**（含 wt 自己的 git 对象库）
 *       `field`   ：+ **祖先链** + **长回旋相对路径**（= 布置本身能给到的边界；O85/O86）
 *       `machine` ：+ **绝对路径**（= 沙箱全开时 agent 的真实能力）★ **缺省**，取最严
 *
 *   ★ 为什么缺省取最严（`machine`）：本项要回答的正是"**沙箱全开也无所谓吗**"。
 *     取 `wt` 当缺省就等于**默认沙箱已经挡住了绝对路径** —— 那正是待检验的假设（会变成假绿）。
 *
 * ── ★★ 答案泄漏有**两条独立通道**（本脚本把它们分开报，别混）──────────────────
 *   1. **判据根通道**：oracle / 期望值 / 规格 / holdout 在 `evals/**` `scripts/**`
 *      ⇒ 从 wt 用**绝对路径**可达（`machine` 层）。
 *      ⛔ **实测先例**：w41 的 `dbc87502` 直接在会话里跑 `node evals\checks\cli-0004.mjs`（11:10:55）。
 *   2. **wt 自身 git 通道**：`seed` 是**未提交的工作区改动**（`eval-validate.mjs:277` 只是
 *      `fs.writeFileSync`），而 wt 的 `.git` 指向判据根的对象库（`git worktree` 语义）
 *      ⇒ **HEAD 里就是"种子前"= 答案那一版**：
 *        · `git diff` 直接打印出被抹掉的那一行（**只读、且不在 DANGEROUS_RULES 里**）；
 *        · `git checkout -- <file>` 一步复原（这条**只在 `unsafeActions` 里被记账，不被拦**）。
 *      ⇒ 这一路**与沙箱档位无关**，**封不住就永远 applicable=false**。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *   node scripts/eval-task-applicability.mjs                       # 两臂 × 全 5 题，边界=machine
 *   node scripts/eval-task-applicability.mjs --only cli-0001-injected-message-identity
 *   node scripts/eval-task-applicability.mjs --boundary field      # 只算"布置"能给到的边界
 *   node scripts/eval-task-applicability.mjs --seal-git            # 假设"种子前字节"这条路已封
 *   node scripts/eval-task-applicability.mjs --json out/applicability.json
 *   node scripts/eval-task-applicability.mjs --wt D:/project_develop/_abA/wt --wt C:/_abB-experiment-root/wt
 *
 * 退出码：0 = 全部题在所选边界下 applicable；1 = 有题不适用（逐条打印 why）；2 = 用法/IO 错。
 * ★ 本脚本**只读**：只读 `tasks.jsonl`、只 `stat`、只跑 `git show`（读对象库）。不写任何文件
 *   （除显式 `--json`）。**不改题面、不改布置**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 判据根（本脚本所在仓库）——oracle / 期望值都在这里。 */
const ROOT = path.resolve(HERE, '..')
const NAME = 'eval-task-applicability'

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const allOf = (k) => {
  const out = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === k && argv[i + 1] !== undefined) out.push(argv[i + 1])
  return out
}
const has = (k) => argv.includes(k)

const USAGE = `${NAME} —— 判「这道题适不适用于当前隔离布置」（格 ⑨）

判据：applicable = 靶文件在 wt 内 ∧ 答案不在（所选边界的）可达处

用法：
  node scripts/${NAME}.mjs [--tasks <jsonl>] [--only <id>] [--wt <abs>]… [--boundary wt|field|machine]
                                       [--seal-git] [--json <file>]

参数：
  --tasks <f>        任务集（缺省 <判据根>/evals/pilot/tasks.jsonl）
  --only <id>        只判一条题
  --wt <abs>         被测工作树（可重复；缺省 = 本项既有的两臂场地，见 DEFAULT_ARMS）
  --boundary <b>     wt | field | machine（缺省 machine = 取最严：把"沙箱全开"算进来）
  --seal-git         假设「wt 自身 git 对象库里带着种子前字节」这条通道**已封**
                     ⇒ 把它从"答案可达"里去掉（用于回答"只封这一路够不够"）
  --json <f>         落一份 JSON（缺省不写）
  -h, --help         本用法

退出码：0 = 全部 applicable；1 = 有题不适用；2 = 用法/IO 错。
`

/**
 * ★ 两臂场地（**既有事实**，逐字来自 `scripts/eval-wt-new.mjs` 文件头的 O85/O86 一节）。
 * 为什么要写死在这里：本判据必须能在**不重建场地**的情况下对"正在用的两臂"复跑
 * （复跑是判据的一部分：场地说变就变，读数必须能重取）。`--wt` 可覆盖。
 */
const DEFAULT_ARMS = [
  { arm: 'A', wt: 'D:/project_develop/_abA/wt' },
  { arm: 'B', wt: 'C:/_abB-experiment-root/wt' },
]

/**
 * ★★ `seed.edits` 为空的**能力题**：靶文件不在任务集里 ⇒ 这张表补上（**并自检**）。
 * 每一句 `source` 都写明"这个靶子是从哪儿读出来的"，且 `evidence` 里的字符串**必须**
 * 逐字出现在该题的 `invariant` 或 `notes` 里 —— 否则报 `stale`（tasks.jsonl 被改过 ⇒ 表过期）。
 * ★ 为什么不解析 `invariant` 的散文：文本匹配型判据不懂语义（本项目的既有纪律）
 *   ⇒ 宁可"显式表 + 过期自检"，也不要"聪明地猜"。
 */
const CAPABILITY_TARGETS = {
  'cli-0005-symbol-rename-design-canvas': {
    targets: [
      'evals/pilot/rename-target/math.js',
      'evals/pilot/rename-target/store.js',
      'evals/pilot/rename-target/index.js',
    ],
    spec: ['evals/pilot/rename-target/README.md'],
    source:
      'invariant 逐字："把模块级导出函数 computeHash 按语义重命名为 digestOf，跨 3 个文件（导出/导入/调用/注释）全部跟改 … 规格见 evals/pilot/rename-target/README.md"；oracle = evals/pilot/rename-target/check.mjs（它按**自己所在目录**读 math.js/store.js/index.js）',
    evidence: ['evals/pilot/rename-target/README.md'],
  },
  'cli-0004-verify-drain-json-output': {
    targets: ['scripts/verify-drain-after-swap.mjs'],
    spec: [],
    source:
      'invariant 逐字："让 scripts/verify-drain-after-swap.mjs 支持 --json"；oracle = evals/checks/cli-0004.mjs 里 `TARGET = path.join(REPO, "scripts", "verify-drain-after-swap.mjs")`（REPO = 判据根）',
    evidence: ['scripts/verify-drain-after-swap.mjs'],
  },
}

const lf = (s) => String(s ?? '').replace(/\r\n/g, '\n')
const slash = (s) => String(s ?? '').replace(/\\/g, '/')
const volumeOf = (p) => path.parse(path.resolve(p)).root.toLowerCase()
const relOf = (from, p) => slash(path.relative(path.resolve(from), path.resolve(p)))
function ancestorsOf(p) {
  const out = []
  let cur = path.resolve(p)
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) return out
    out.push(parent)
    cur = parent
  }
}

const say = (s) => console.log(s)
const problems = []

// ── 参数 ──────────────────────────────────────────────────────────────────
if (has('-h') || has('--help')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
const BOUNDARY = argOf('--boundary') ?? 'machine'
if (!['wt', 'field', 'machine'].includes(BOUNDARY)) {
  process.stderr.write(`[${NAME}] 用法错误：--boundary 只能是 wt | field | machine（实得 ${BOUNDARY}）\n\n${USAGE}`)
  process.exit(2)
}
const SEAL_GIT = has('--seal-git')
/** ★ 每个边界包含哪些"可达层"（层层包含：wt ⊂ field ⊂ machine）。 */
const LAYERS = {
  wt: ['inWtPath', 'inWtGit'],
  field: ['inWtPath', 'inWtGit', 'ancestor', 'relSibling'],
  machine: ['inWtPath', 'inWtGit', 'ancestor', 'relSibling', 'absPath'],
}
const ACTIVE_LAYERS = LAYERS[BOUNDARY].filter((l) => !(SEAL_GIT && l === 'inWtGit'))
const TASKS_FILE = path.resolve(argOf('--tasks') ?? path.join(ROOT, 'evals/pilot/tasks.jsonl'))
const ONLY = argOf('--only')
const JSON_OUT = argOf('--json')
const wtArgs = allOf('--wt')
const ARMS = wtArgs.length ? wtArgs.map((w, i) => ({ arm: String.fromCharCode(65 + i), wt: w })) : DEFAULT_ARMS

// ── 前置：任务集可读 + 至少一条臂存在（否则是空集上为真 = 假绿）───────────────
if (!fs.existsSync(TASKS_FILE)) {
  process.stderr.write(`[${NAME}] 读不到任务集：${TASKS_FILE}\n`)
  process.exit(2)
}
const tasks = fs
  .readFileSync(TASKS_FILE, 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('//'))
  .map((l) => JSON.parse(l))
const picked = ONLY ? tasks.filter((t) => t.id === ONLY) : tasks
if (!picked.length) {
  process.stderr.write(`[${NAME}] 没有选中任何题（--only ${ONLY ?? '(未给)'}）\n`)
  process.exit(2)
}
const armsLive = ARMS.filter((a) => fs.existsSync(a.wt))
if (!armsLive.length) {
  process.stderr.write(`[${NAME}] 没有任何被测工作树存在（判据对象不在 ⇒ 本判据无意义）：\n  ${ARMS.map((a) => a.wt).join('\n  ')}\n`)
  process.exit(2)
}

// ── 工具 ──────────────────────────────────────────────────────────────────
/** `git show HEAD:<rel>` 是否含 `needle`（= HEAD 是不是"种子前/答案"那一版）。 */
function headHasPreSeed(wt, rel, needle) {
  const r = spawnSync('git', ['-C', wt, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (r.status !== 0) return { ok: false, hits: null, why: `git show HEAD:${rel} 失败（exit=${r.status}）` }
  const text = lf(r.stdout)
  const n = needle ? text.split(lf(needle)).length - 1 : 0
  return { ok: n >= 1, hits: n, why: n >= 1 ? '' : `HEAD 里没有种子锚点（命中 ${n} 次）` }
}
/** `git -C <wt> rev-parse HEAD`（读不到就 null —— 如实报，不当成"封住了"）。 */
function headOf(wt) {
  const r = spawnSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout).trim() : null
}
/** oracle.cmd 里那个"脚本文件"（= 期望值/基线的载体）。 */
function oracleFileOf(task) {
  const cmd = task.oracle?.cmd ?? []
  const cand = cmd.find((a) => typeof a === 'string' && /[/\\]/.test(a) && /\.(mjs|js|cjs)$/.test(a))
  return cand ? slash(cand) : null
}
/** ★ oracle 会不会被 `DSH_EVAL_REPO` / `--repo` 指到 wt（不会 ⇒ 靶子搬进 wt 也没用）。 */
function oracleBindsWt(oracleRel) {
  if (!oracleRel) return { binds: false, why: 'oracle.cmd 里没有可解析的脚本路径' }
  const abs = path.join(ROOT, oracleRel)
  if (!fs.existsSync(abs)) return { binds: false, why: `oracle 不在判据根：${oracleRel}` }
  const src = fs.readFileSync(abs, 'utf8')
  const binds = /DSH_EVAL_REPO/.test(src) || /['"]--repo['"]/.test(src)
  return { binds, why: binds ? '读 DSH_EVAL_REPO / --repo' : '**硬编码/自身相对** ⇒ 无论 wt 里有什么，它只判判据根那一份' }
}

// ── 主判 ──────────────────────────────────────────────────────────────────
const out = {
  schema: 'dsh-eval-task-applicability/v1',
  at: new Date().toISOString(),
  judgeRoot: slash(ROOT),
  tasksFile: slash(TASKS_FILE),
  boundary: BOUNDARY,
  sealGit: SEAL_GIT,
  activeLayers: ACTIVE_LAYERS,
  arms: ARMS.map((a) => ({ arm: a.arm, wt: slash(a.wt), exists: fs.existsSync(a.wt) })),
  tasks: [],
}

say(`${NAME} —— 「适不适用于当前隔离布置」判据`)
say(`  判据根    : ${slash(ROOT)}`)
say(`  任务集    : ${slash(TASKS_FILE)}（${tasks.length} 条，选中 ${picked.length} 条）`)
say(`  两臂场地  : ${ARMS.map((a) => `${a.arm}=${slash(a.wt)}${fs.existsSync(a.wt) ? '' : '（**不存在**）'}`).join('   ')}`)
say(`  边界      : ${BOUNDARY}（层：${ACTIVE_LAYERS.join(' + ')}）${SEAL_GIT ? '  ★ --seal-git：已把 inWtGit 从"可达"里去掉' : ''}`)
say(`  判据      : applicable = 靶文件在 wt 内 ∧ 答案不在（上述边界的）可达处`)
say('')

for (const t of picked) {
  const cap = CAPABILITY_TARGETS[t.id] ?? null
  const seedTargets = (t.seed?.edits ?? []).map((e) => slash(e.file))
  const targets = [...new Set([...seedTargets, ...(cap?.targets ?? [])])]
  const oracleRel = oracleFileOf(t)
  const binds = oracleBindsWt(oracleRel)
  /** 答案载体：oracle 本体（期望值/基线写在里面）+ 规格/holdout。 */
  const answerPaths = [...new Set([...(oracleRel ? [oracleRel] : []), ...(cap?.spec ?? [])])]
  // ★ 过期自检：显式表的依据必须还逐字在题面里
  const blob = lf(t.invariant) + '\n' + lf(t.notes)
  const stale = (cap?.evidence ?? []).filter((s) => !blob.includes(s))
  /** 种子锚点（用于判"HEAD 是不是答案那一版"）：`find` = 种子**之前**的原文 = 答案里的那一段。 */
  const finds = (t.seed?.edits ?? []).map((e) => ({ file: slash(e.file), find: e.find }))

  const row = {
    id: t.id,
    kind: t.kind ?? null,
    oracle: (t.oracle?.cmd ?? []).join(' '),
    oracleFile: oracleRel,
    oracleBindsWt: binds.binds,
    oracleBindsWhy: binds.why,
    targets,
    targetsFrom: seedTargets.length ? 'seed.edits[].file' : 'CAPABILITY_TARGETS（seed 为空的能力题）',
    targetSource: cap?.source ?? null,
    staleEvidence: stale,
    answerPaths,
    arms: {},
  }

  say(`── ${t.id}   [${row.kind}]`)
  say(`   靶文件（${row.targetsFrom}）：${targets.length ? targets.join(' , ') : '（无）'}`)
  say(`   oracle ：${row.oracle}`)
  say(`     └ 绑定 wt？ ${binds.binds ? '是 ✓' : '**否 ✗**'}（${binds.why}）`)
  if (stale.length) say(`   ★ 显式表过期：题面里已找不到 ${stale.join(' , ')} ⇒ 本行结论作废`)

  for (const a of ARMS) {
    const exists = fs.existsSync(a.wt)
    if (!exists) {
      row.arms[a.arm] = { wt: slash(a.wt), exists: false, targetInWt: null, answerReachable: null, applicable: null, why: '工作树不存在 ⇒ 该臂无从检起（**不等于**通过）' }
      say(`   [${a.arm}] ⊘ 工作树不存在：${slash(a.wt)}（该臂不参与判定，**不等于通过**）`)
      continue
    }
    const anc = ancestorsOf(a.wt)
    const inWt = targets.map((rel) => ({ rel, inWt: fs.existsSync(path.join(a.wt, rel)), inJudge: fs.existsSync(path.join(ROOT, rel)) }))
    const targetInWt = targets.length > 0 && inWt.every((x) => x.inWt)

    // ── 可达层（逐层可打印，不许藏）────────────────────────────────────────
    const inWtPath = answerPaths.filter((rel) => fs.existsSync(path.join(a.wt, rel)))
    const gitRows = finds.map((f) => ({ ...f, ...headHasPreSeed(a.wt, f.file, f.find) }))
    const inWtGit = gitRows.filter((g) => g.ok)
    const ancHits = answerPaths.filter((rel) => anc.includes(path.resolve(ROOT)) && fs.existsSync(path.join(ROOT, rel)))
    const relProbes = []
    for (let k = 1; k <= 5; k++) {
      for (const rel of answerPaths) {
        const p = `${'../'.repeat(k)}${path.basename(ROOT)}/${rel}`
        const abs = path.resolve(a.wt, p)
        relProbes.push({ rel: p, abs: slash(abs), exists: fs.existsSync(abs) })
      }
    }
    const relHits = relProbes.filter((x) => x.exists)
    const absHits = answerPaths.filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    const reach = {
      inWtPath: { hit: inWtPath.length > 0, paths: inWtPath },
      inWtGit: {
        hit: inWtGit.length > 0,
        files: inWtGit.map((g) => g.file),
        detail: gitRows.map((g) => ({ file: g.file, headHasPreSeedBytes: g.ok, hits: g.hits, why: g.why })),
      },
      ancestor: { hit: ancHits.length > 0, paths: ancHits, judgeRootInAncestors: anc.includes(path.resolve(ROOT)) },
      relSibling: { hit: relHits.length > 0, probes: relProbes.length, hits: relHits },
      absPath: { hit: absHits.length > 0, paths: absHits, existsOnDisk: absHits.length > 0, volWt: volumeOf(a.wt), volJudge: volumeOf(ROOT) },
    }
    const blocking = ACTIVE_LAYERS.filter((l) => reach[l]?.hit)
    const answerReachable = blocking.length > 0
    const applicable = !!targetInWt && !answerReachable && stale.length === 0

    const whyParts = []
    whyParts.push(targetInWt ? '靶文件全部在 wt 内 ✓' : `靶文件**不在** wt 内 ✗（${inWt.filter((x) => !x.inWt).map((x) => x.rel).join(' , ')}）`)
    whyParts.push(
      answerReachable
        ? `答案**可达** ✗（触发层：${blocking.join(' + ')}）`
        : `答案在 ${BOUNDARY} 边界下不可达 ✓`,
    )
    if (!binds.binds) whyParts.push('★ oracle 不绑定 wt ⇒ 即使靶子搬进 wt，oracle 仍只判判据根那一份')
    if (stale.length) whyParts.push('★ 显式表过期 ⇒ 作废')

    row.arms[a.arm] = {
      wt: slash(a.wt),
      exists: true,
      head: headOf(a.wt),
      targetsInWt: inWt,
      targetInWt,
      answerReachable,
      blockingLayers: blocking,
      applicable,
      reach,
      why: whyParts.join('；'),
    }

    say(`   [${a.arm}] ${slash(a.wt)}`)
    for (const x of inWt) say(`       靶文件 ${x.inWt ? '在 wt 内 ✓' : '**不在 wt 内 ✗**'}  ${x.rel}${x.inJudge ? '   （在判据根里）' : ''}`)
    say(`       可达层：inWtPath=${reach.inWtPath.hit ? '★命中' : '无'}  inWtGit=${reach.inWtGit.hit ? '★命中' : '无'}${reach.inWtGit.hit ? `(${reach.inWtGit.files.join(',')})` : ''}  ancestor=${reach.ancestor.hit ? '★命中' : '无'}  relSibling=${reach.relSibling.hit ? '★命中' : '无'}(${reach.relSibling.hits.length}/${reach.relSibling.probes})  absPath=${reach.absPath.hit ? '★命中' : '无'}`)
    say(`       ⇒ targetInWt=${targetInWt}  answerReachable=${answerReachable}  **applicable=${applicable}**`)
    say(`       why：${row.arms[a.arm].why}`)
  }
  const armVals = Object.values(row.arms).filter((x) => x.exists).map((x) => x.applicable)
  row.applicableAllArms = armVals.length > 0 && armVals.every((v) => v === true)
  row.applicableSomeArm = armVals.some((v) => v === true)
  if (!row.applicableAllArms) problems.push(`${t.id}：${row.applicableSomeArm ? '只有部分臂适用' : '不适用'}于当前布置`)
  say('')
  out.tasks.push(row)
}

const nAll = out.tasks.filter((r) => r.applicableAllArms).length
out.summary = {
  tasks: out.tasks.length,
  applicableAllArms: nAll,
  notApplicable: out.tasks.length - nAll,
  problems,
}
say('─'.repeat(78))
say(`结论（边界=${BOUNDARY}${SEAL_GIT ? '，已 --seal-git' : ''}）：**${nAll}/${out.tasks.length}** 条题「两臂都 applicable」`)
for (const r of out.tasks) {
  if (r.applicableAllArms) continue
  const tgt = Object.values(r.arms).filter((x) => x.exists)
  const why = tgt.map((x) => `${x.targetInWt ? '靶在wt' : '靶不在wt'}/${x.answerReachable ? '答案可达' : '答案不可达'}`).join(' ')
  say(`  · ${r.id} —— ${why}${r.oracleBindsWt ? '' : '；oracle 不绑定 wt'}`)
}
say('')
if (JSON_OUT) {
  const abs = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(ROOT, JSON_OUT)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(out, null, 2), 'utf8')
  say(`JSON → ${slash(abs)}`)
}
process.exit(problems.length ? 1 : 0)
