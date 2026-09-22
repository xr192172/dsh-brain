#!/usr/bin/env node
/**
 * eval-wt-new.mjs —— 起一个**隔离工作树**：给被测 Agent 用它，且**里面没有判据**。
 *
 * ── 它要解决的问题（O69 / R1）────────────────────────────────────────────
 *   `evals/README.md` 的 R1 逐字：**"判据必须在 Agent 够不到的地方"** ——
 *   "2026 年多个公开靶场被【判分代码与 Agent 同环境】破掉（一行代码改掉自己的成绩）"。
 *
 *   本项目真的在这条上翻过车：被测 agent 的 cwd 是**完整检出** ⇒ 里面**有**
 *   `scripts/test-injected-message-shape.mjs` / `scripts/check-all.mjs` / `scripts/eval-validate.mjs` /
 *   `evals/pilot/tasks.jsonl`，且**轨迹里 agent 真读了判据脚本（seq=212）** ⇒ 区分度归零。
 *
 * ── 机制：`git worktree` + `sparse-checkout`（**排除，不是删除**）────────────
 *   1. `git worktree add --detach <dir> HEAD`
 *   2. `git sparse-checkout set --no-cone '/*' '!/scripts/' '!/evals/' '!/docs/' '!/patches/' '!/.workbuddy/'`
 *   ⇒ 排除的目录**根本不落盘**，而 git 用 `skip-worktree` 记住它们
 *     ⇒ ★ `git status --porcelain` **仍然为空**、`git diff --stat` 也**不受影响**
 *       （这两点是"排除 ≠ 删除"的要害：删掉会让工作树永远脏，读数就没法要了）。
 *
 *   ★ 为什么默认多排三个（`docs/` `patches/` `.workbuddy/`）：实测它们**真的**带着判据/期望值的话
 *     （`memory-judge-poison-check` 的命中：`docs/agent-eval-arenas.md` → `content/oracle`；
 *      `.workbuddy/memory/*.md` → `content/oracle` / `content/regression` / `content/expectSeeded`；
 *      `patches/*.patch` → 中文"判据"）。它们**不是**被测代码 ⇒ 排掉只会更严。
 *     ⚠️ **但即使排掉这三处，`memory-judge-poison-check` 仍然报 `BROKEN`** —— 因为它的
 *     `content/zh-expected` 信号会命中**源码注释里的那个普通中文词**（如
 *     `packages/switchboard/src/index.ts:258` 的 `// ── …判据 ──`）。
 *     ⇒ 这是**该启发式信号在"整棵源码树"上的已知假阳性**，详见 `out/w25-r1-fix.md` §门3。
 *     想只排两个目录：`--no-hygiene`。
 *
 * ── ★★ 行尾坑（必须处理，上次真踩过）─────────────────────────────────────
 *   本机 `core.autocrlf=true`（**system 级**：PortableGit 的 etc/gitconfig，无 `.gitattributes`）
 *   ⇒ 检出会把 LF 变成 **CRLF** ⇒ `tasks.jsonl` 里 `seed.find` 写的 `\n`
 *     **匹配 0 次** ⇒ "seed 后应该红"的任务**根本不会红** ⇒ **假绿**（比假红更坏）。
 *
 *   ★★ **O76（2026-09-22）复核：上一轮的 `-c core.autocrlf=false` 确实生效了，
 *      但脏不在"建树"这一步。** 实测（本文件作者，原始读数）：
 *     · `git worktree add -c core.autocrlf=false` → CR=0；随后 `sparse-checkout set -c …` → **仍是 CR=0**；
 *       `_wt/w24-A`、`_wt/w25-R1`、临时树 `_wt/probe-a` **全树 LF**；
 *     · 而 `_wt/w26-fix` 里**只有 `packages/switchboard/src/index.ts` 是 CRLF（CR=523）**，
 *       同树 `package.json` / `coordinator.ts` **都是 CR=0**，主仓同文件也是 **CR=0**
 *       ⇒ 这不是"检出把整棵树变成了 CRLF"，而是**建树之后、某一个文件被单独重新物化了一次**。
 *     · 单独重新物化的实测复现（`git -C <wt> checkout -- <file>`，**不带** `-c`）：
 *       `CR 0 → 523`，而且 `git -C <wt> status --porcelain` **仍然是空的**
 *       （因为 status 也按 system 的 autocrlf 归一化）⇒ **污染是静默的**。
 *     · 而 eval 链路里**真的存在**这样一条没带 `-c` 的命令：`eval-run.mjs` 的
 *       能力题还原 `git checkout -- <file>`（另一处是它自己的 `git worktree add`）。
 *   ⇒ 结论：**"每条会碰工作区的 git 命令都要带 `-c`" 还不够** ——
 *     还要在**建树收尾时把工作区整体重新物化一遍并逐字量一次**（本脚本 [2b]/[5]/[5b] 就是干这个的：
 *     机制是 `git -c core.autocrlf=false -c core.eol=lf checkout -- .`，
 *     它只重写索引里那些文件、**不动** `skip-worktree` 的排除项、也不改 HEAD）。
 *   ★ 为什么要连 `-c core.eol=lf` 一起给：`core.eol` 在 autocrlf 为真/有 `text` 属性时才参与决策，
 *     单给 `autocrlf=false` 在本机够用；但**两条一起给**才是"与 system 配置无关"的硬保证
 *     （将来谁在本机或 CI 上把 `core.autocrlf` 改成 `input`/`true`，这里都不会再反复）。
 *
 * ── ★★ 构建产物：干净检出没有 `lib/` ⇒ oracle 假红（O72，2026-09-22）──────────
 *   干净检出里**没有** `packages/switchboard/lib/`（gitignore 的），而 oracle
 *   （`scripts/test-injected-message-shape.mjs` 的 A 段）import 的正是它 ⇒ 直接报
 *   `FAIL 编译产物存在 — … 不存在，先构建 switchboard` ⇒ **假红**。
 *   实测（`out/_wt/w25-R1`，本文件作者复核）：
 *     `node scripts/test-injected-message-shape.mjs --repo out/_wt/w25-R1`
 *     → `结果：1 passed, 1 failed`（唯一那条失败就是"编译产物存在"）。
 *   ⇒ 本脚本 [3] 步做两件事：**接一条 `node_modules` junction**（tsc 与 `@types/node` 要它）
 *     + **在树内跑 `packages/switchboard/scripts/build.mjs`**。
 *   ⇒ 为什么**不复制主仓的 lib/**：seed 打在 `src`（`tasks.jsonl` 的 `seed.edits` 全是 `.ts`），
 *     复制来的 lib 是**旧 src 的产物** ⇒ "未 seed 绿"能骗过，**seed 之后 oracle 依旧绿**
 *     ⇒ 把判据变成瞎的（假绿比假红更坏）。树内构建则让树里的 src 与 lib **同源**。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node scripts/eval-wt-new.mjs --name w25-R1
 *   node scripts/eval-wt-new.mjs --name w25-R1 --dir D:/tmp/w25-R1 --exclude docs --exclude .workbuddy
 *   node scripts/eval-wt-new.mjs --name w25-R1 --json out/w25-wt.json
 *
 * 退出码：0 = 工作树建好且**全部证据为真**；1 = 有一条证据不成立（或建树失败）。
 * ★ 本脚本**只读**主仓（`git worktree add` 不碰主仓的 `status`），**不删任何东西**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'eval-wt-new'

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

/**
 * ★ 默认排除：
 *   · `scripts/`、`evals/` —— **R1 的直接对象**（判据脚本 + 任务集/期望值）。
 *   · `docs/`、`patches/`、`.workbuddy/` —— **R1 的间接泄漏面**：本仓这三处**确实**带着
 *     判据/期望值的话（实测 `memory-judge-poison-check`：`docs/agent-eval-arenas.md` 命中
 *     `content/oracle`；`.workbuddy/memory/*.md` 命中 `content/oracle` / `content/regression` /
 *     `content/expectSeeded`；`patches/*.patch` 命中中文"判据"）。它们是**文档/记忆/提案**，
 *     对"修好被 seed 打坏的那处代码"没有用 ⇒ 排除它们只会让隔离**更严**，不会削弱任何判据。
 * ★ 要改这份清单用 `--exclude`（**追加**）；不想要默认项就显式传 `--exclude-none`? 没有这个开关 ——
 *   默认项是 R1 的最小面，**故意不允许关掉**（关掉它等于自己把判据放回被测目录）。
 */
const DEFAULT_EXCLUDES = ['scripts', 'evals', 'docs', 'patches', '.workbuddy']
/** ★ 判据清单：这些**必须**在工作树里不存在 —— 这是 R1 的机器证据（存在性断言，无启发式）。 */
const JUDGE_FILES = [
  'scripts/eval-validate.mjs',
  'scripts/test-injected-message-shape.mjs',
  'scripts/test-handover-drain.mjs',
  'scripts/check-all.mjs',
  'scripts/memory-judge-poison-check.mjs',
  'evals/pilot/tasks.jsonl',
  'evals/checks/cli-0004.mjs',
  'evals/pilot/rename-target/check.mjs',
]

const USAGE = `${NAME} —— 起一个**不含判据**的隔离工作树（R1）

用法：
  node scripts/eval-wt-new.mjs --name <名字> [--dir <绝对路径>] [--exclude <仓库相对目录>]… [--json <file>]

参数：
  --name <n>        工作树名字（默认目录 <仓库>/out/_wt/<n>；out/ 已在 .gitignore 里）
  --dir <abs>       直接指定目录（必须绝对路径；与 --name 二选一）
  --exclude <p>     额外排除的仓库相对目录（可重复，**追加**）。默认已排除：${DEFAULT_EXCLUDES.join(' , ')}
  --no-hygiene      只排除规格点名的两个目录（scripts , evals），不带 docs/patches/.workbuddy
  --json <file>     把结论写成 JSON（默认不写）
  -h, --help        打印本用法

为什么默认目录在 out/_wt/ 下：out/ 被 git 忽略 ⇒ 起树**不会**让主仓 \`git status\` 多出
"?? _wt/" 这一行（放在仓库根下的 _wt/ 会让它变脏 —— 而"主仓未被污染"是硬要求）。
`

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}
/**
 * ★★ O76：**所有会碰工作区的 git 命令都必须带这两个 `-c`**（见文件头"行尾坑"）。
 * `core.autocrlf=false` 挡住"按 system 配置把 LF 写成 CRLF"；
 * `core.eol=lf` 是它的**独立保险**（`core.eol` 只在 autocrlf 为真/有 `text` 属性时才参与决策，
 * 但那正是"本机配置变了以后"的场景 ⇒ 两条一起给 = 与 system 配置无关）。
 * ★ 不许把这两条去掉、也不许只给一条 —— 少了任何一条，下面 [2b] 的重新物化都可能没效果。
 */
const EOL_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']
/** ★ 所有会碰工作区的 git 命令都必须走它（见文件头"行尾坑"）。 */
const gitIn = (dir, args) => sh('git', ['-C', dir, ...EOL_FLAGS, ...args])

/**
 * ── ★★ O72：把"干净检出"变成"可编译 / 已构建"（2026-09-22）───────────────────
 *
 * **症状**：oracle（`scripts/test-injected-message-shape.mjs` 的 A 段）import 的是
 * **编译产物** `packages/switchboard/lib/index.js`，而 `lib/` 是 gitignore 的
 * ⇒ 干净检出里**没有**它 ⇒ oracle 第一条断言就报
 * `FAIL 编译产物存在 — … 不存在，先构建 switchboard` ⇒ **假红**（不是隔离破了，是树没建）。
 *
 * **为什么选"树内构建"而不是"复制主仓的 lib/"**：
 *   · 复制 lib 只能骗过"未 seed 时绿"这一半 —— seed 打在 **src**（`tasks.jsonl` 的
 *     `seed.edits` 指的全是 `.ts`），复制来的 lib 是**旧 src 的产物**
 *     ⇒ seed 之后 oracle 依旧绿 ⇒ **把判据变成瞎的**（比假红更坏：它是假绿）。
 *   · 树内构建让"这棵树里的 src ↔ 这棵树里的 lib"**同源**，判据读的就是这棵树自己
 *     （实测：seed 之后 oracle 确实变红，见 `out/w26-o72-o73-o74.md` 门 3）。
 *   · 也不选"在树上挂个 tsc 的壳"：`packages/switchboard/scripts/build.mjs` 是**树里自带的、
 *     幂等的**构建入口（版本化 `out/<buildId>` + `lib` junction 翻转），复用它比自己拼命令行稳。
 *
 * **为什么必须先接一条 `node_modules`**：tsc 与 `types:["node"]` 要按 tsconfig 所在位置
 * 向上找 `node_modules`，而干净检出里没有它（它也是 gitignore 的）⇒ 构建直接失败。
 * 接的是 **junction**（`fs.symlinkSync(..., 'junction')`，Windows 上不需要管理员）；目标在
 * 判据根 ⇒ 依赖解析从"树自己的 node_modules 起、最后落到判据根"，与运行期 node 的解析方向
 * 一致。★ `node_modules/` 在 `.gitignore` 里 ⇒ **树仍然 `git status` 干净**（证据 D 会验）。
 *
 * ★ **"缺则建"**：已有 `lib/index.js` 就跳过（避免每跑一次树里多一个 `out/b<id>/`）。
 */
function ensureDepsLink(dir) {
  const link = path.join(dir, 'node_modules')
  const target = path.join(ROOT, 'node_modules')
  if (fs.existsSync(link)) return { linked: false, why: '已存在，未动' }
  if (!fs.existsSync(target)) return { linked: false, why: `判据根没有 node_modules（${target}）` }
  try {
    fs.symlinkSync(target, link, 'junction')
    return { linked: true, why: `junction → ${target}` }
  } catch (e) {
    return { linked: false, why: `建链接失败：${String(e?.message ?? e)}` }
  }
}
function buildInTree(dir) {
  const pkg = path.join(dir, 'packages', 'switchboard')
  const script = path.join(pkg, 'scripts', 'build.mjs')
  const lib = path.join(pkg, 'lib', 'index.js')
  if (!fs.existsSync(script)) return { ok: true, skipped: true, lib, why: '树里没有 packages/switchboard/scripts/build.mjs（无需构建）' }
  if (fs.existsSync(lib)) return { ok: true, skipped: true, lib, why: '已有构建产物（缺则建）' }
  const r = sh(process.execPath, ['scripts/build.mjs'], { cwd: pkg })
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ')
  return { ok: r.status === 0, skipped: false, lib, why: `exit=${r.status}  ${tail}`.trim() }
}

const say = (s) => console.log(s)
const problems = []
const check = (ok, label, detail = '') => {
  say(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) problems.push(label)
  return ok
}
const countCrlf = (abs) => {
  const b = fs.readFileSync(abs)
  let n = 0
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 13 && b[i + 1] === 10) n++
  return n
}
const readTasks = () =>
  fs
    .readFileSync(path.join(ROOT, 'evals/pilot/tasks.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('//'))
    .map((l) => JSON.parse(l))

// ── 参数 ──────────────────────────────────────────────────────────────────
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
const name = argOf('--name')
const dirArg = argOf('--dir')
/** `--no-hygiene`：退回"只排规格点名的两个目录"（`scripts` / `evals`）—— 留给想复现旧行为的人。 */
const baseExcludes = argv.includes('--no-hygiene') ? ['scripts', 'evals'] : DEFAULT_EXCLUDES
const extraExcludes = allOf('--exclude')
const jsonOut = argOf('--json')
if (!name && !dirArg) {
  process.stderr.write(`[${NAME}] 用法错误：--name 或 --dir 必须给一个\n\n${USAGE}`)
  process.exit(2)
}
if (dirArg && !path.isAbsolute(dirArg)) {
  process.stderr.write(`[${NAME}] 用法错误：--dir 必须是绝对路径（用 D:/… 而不是 /d/…）\n`)
  process.exit(2)
}
const DIR = dirArg ? path.resolve(dirArg) : path.join(ROOT, 'out', '_wt', String(name))
const EXCLUDES = [...new Set([...baseExcludes, ...extraExcludes])].map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''))

const result = { name: name ?? path.basename(DIR), dir: DIR, excludes: EXCLUDES, repo: ROOT, at: new Date().toISOString() }
say(`${NAME} —— 起隔离工作树（不含判据）`)
say(`  仓库      : ${ROOT}`)
say(`  目标目录  : ${DIR}`)
say(`  排除      : ${EXCLUDES.map((e) => e + '/').join(' , ')}`)
say('')

// ── [0] 前置：目录必须不存在；排除项在主仓里必须真的存在（否则"排除了不存在的东西"是假证据）──
say('[0] 前置')
if (fs.existsSync(DIR)) {
  say(`  ✗ 目标目录已存在：${DIR}`)
  say(`     ⇒ 拒绝覆盖。要重来：git worktree remove --force "${DIR}"`)
  process.exit(1)
}
const missingEx = EXCLUDES.filter((e) => !fs.existsSync(path.join(ROOT, e)))
check(missingEx.length === 0, '排除项在主仓里都存在', missingEx.length ? `缺：${missingEx.join(', ')}` : EXCLUDES.map((e) => e + '/').join(' , '))
const repoHead = String(sh('git', ['rev-parse', 'HEAD']).stdout ?? '').trim()
check(!!repoHead, '读到主仓 HEAD', repoHead)
if (problems.length) {
  say(`\n⇒ 前置不成立，**不动任何东西**退出。`)
  process.exit(1)
}

// ── [1] 建工作树（★ 带 EOL_FLAGS）─────────────────────────────────────────
say('')
say(`[1] git worktree add（${EOL_FLAGS.join(' ')}）`)
fs.mkdirSync(path.dirname(DIR), { recursive: true })
const add = sh('git', [...EOL_FLAGS, 'worktree', 'add', '--detach', DIR, 'HEAD'])
if (add.status !== 0) {
  say(`  ✗ git worktree add 失败：${String(add.stderr ?? '').trim().slice(0, 400)}`)
  process.exit(1)
}
say(`  ✓ 已建：${DIR}`)

// ── [2] sparse-checkout 排除（★ 同样带 -c；这一步会把文件按 autocrlf 重新检出）──
say('')
say('[2] sparse-checkout --no-cone 排除判据目录（排除 ≠ 删除）')
const patterns = ['/*', ...EXCLUDES.map((e) => `!/${e}/`)]
const init = gitIn(DIR, ['sparse-checkout', 'init', '--no-cone'])
const set = init.status === 0 ? gitIn(DIR, ['sparse-checkout', 'set', '--no-cone', ...patterns]) : init
if (set.status !== 0) {
  say(`  ✗ sparse-checkout 失败：${String(set.stderr ?? '').trim().slice(0, 400)}`)
  process.exit(1)
}
say(`  ✓ 模式：${patterns.join('  ')}`)

// ── [2b] ★★ O76：把工作区**整体重新物化一遍**成 LF（只靠 `-c` 不够，见文件头）────────
// 机制：`git -c core.autocrlf=false -c core.eol=lf checkout -- .`
//   · 它从**索引**重写工作区里匹配 `.` 的条目 ⇒ 只影响被检出的文件；
//   · `skip-worktree`（sparse 排除）的条目**照旧跳过** ⇒ 排除项不会被重新拉回来（[4] 会验）；
//   · **不改 HEAD、不改索引内容** ⇒ `git status` 仍然为空（[4] 会验）。
// 为什么必须有这一步：上面 [1]/[2] 的 `-c` 只能保证"这两条命令自己不写 CRLF"；
//   一旦**建树之后**有任何一条没带 `-c` 的 git 命令（或将来有人手敲）重新物化了单个文件，
//   污染就是静默的（status 看不出来，因为 status 也按 autocrlf 归一化）。
//   ⇒ 收尾时无条件重写一遍 + 逐字量一次，才是"这棵树是 LF"的**可复现**保证。
say('')
say('[2b] O76：重新物化工作区为 LF（checkout -- . 带 EOL_FLAGS）')
const renorm = gitIn(DIR, ['checkout', '--', '.'])
check(renorm.status === 0, '重新物化成功（checkout -- .）', renorm.status === 0 ? '' : String(renorm.stderr ?? '').trim().slice(0, 300))

// ── [3] O72：接依赖 + **树内构建**（干净检出没有 lib/ ⇒ oracle 假红）────────────
say('')
say('[3] O72：让树"可编译 / 已构建"（依赖 junction + 树内构建，缺则建）')
const link = ensureDepsLink(DIR)
check(fs.existsSync(path.join(DIR, 'node_modules')), 'node_modules 就位（构建与运行判据都要它）', link.why)
const built = buildInTree(DIR)
check(built.ok, `树内构建 switchboard：${built.skipped ? '跳过（已有产物）' : '已构建'}`, built.why.slice(0, 240))
check(fs.existsSync(built.lib), 'O72 要害：packages/switchboard/lib/index.js 在**这棵树里**存在', built.lib)

// ── [4] 证据：排除生效 + 工作树是"干净"的 ─────────────────────────────────
say('')
say('[4] 证据 A：排除生效 且 工作树没被改脏（★ 含上一步的链接与构建产物）')
for (const e of EXCLUDES) {
  const abs = path.join(DIR, e)
  check(!fs.existsSync(abs), `已排除：${e}/ 不存在于工作树`, fs.existsSync(abs) ? `（仍在！${abs}）` : '')
}
const status = gitIn(DIR, ['status', '--porcelain'])
const statusLines = String(status.stdout ?? '').split('\n').filter((l) => l.trim())
check(status.status === 0 && statusLines.length === 0, 'git -C <wt> status --porcelain 为空', statusLines.length ? `实得 ${statusLines.length} 行：${statusLines.slice(0, 5).join(' | ')}` : '0 行')
const diffStat = gitIn(DIR, ['diff', '--stat'])
check(String(diffStat.stdout ?? '').trim() === '', 'git -C <wt> diff --stat 为空', JSON.stringify(String(diffStat.stdout ?? '').trim().slice(0, 120)))
const wtHead = String(gitIn(DIR, ['rev-parse', 'HEAD']).stdout ?? '').trim()
check(wtHead === repoHead, '工作树 HEAD == 主仓 HEAD', `${wtHead} vs ${repoHead}`)

// ── [5] 证据 B：行尾（CRLF 坑）真的被治住 ─────────────────────────────────
say('')
say('[5] 证据 B：行尾 —— 工作树里必须是 LF（否则 seed.find 的 \\n 匹配 0 次）')
const seedTargets = [...new Set(readTasks().flatMap((t) => (t.seed?.edits ?? []).map((e) => e.file)))]
for (const rel of seedTargets) {
  const abs = path.join(DIR, rel)
  if (!fs.existsSync(abs)) {
    check(false, `CRLF 探针文件存在：${rel}`, '（不在工作树里，无法量行尾）')
    continue
  }
  const crlf = countCrlf(abs)
  check(crlf === 0, `CRLF 计数为 0：${rel}`, `实得 ${crlf}${crlf > 0 ? '  ★ autocrlf 又把行尾改回 CRLF 了' : ''}`)
}
// ── [5b] 证据 B2：**全树**都没有 `w/crlf`（不只是 seed 目标那几个文件）────────────
// 为什么加这条：O76 的真实形态不是"整棵树 CRLF"，而是**某一个文件被单独重新物化**——
// 只看 seed 目标的话，"将来 seed 换到另一个文件"就会漏。`git ls-files --eol` 报的是
// **工作区实际字节**（不受 autocrlf 影响），是这条断言最直接的机器证据。
say('')
say('[5b] 证据 B2：全树 `git ls-files --eol` 里不许有 `w/crlf`')
const eolRows = String(gitIn(DIR, ['ls-files', '--eol']).stdout ?? '')
  .split('\n')
  .filter((l) => l.trim())
const crlfRows = eolRows.filter((l) => /\bw\/crlf\b/.test(l))
check(eolRows.length > 0, '读到了行尾台账（否则这条断言在空集上为真 = 假绿）', `实得 ${eolRows.length} 行`)
check(
  crlfRows.length === 0,
  '全树没有 w/crlf 文件',
  crlfRows.length ? `实得 ${crlfRows.length} 个：${crlfRows.slice(0, 5).map((l) => l.trim().split(/\s+/).pop()).join(', ')}` : '0 个',
)

// ── [6] 证据 C：seed 锚点在**这棵树**里"恰好 1 次"（这才是 CRLF 坑的最终判据）──
say('')
say('[6] 证据 C：每题 seed.find 在工作树里**恰好命中 1 次**（CRLF 会让它变 0）')
const seedRows = []
for (const t of readTasks()) {
  for (const e of t.seed?.edits ?? []) {
    const abs = path.join(DIR, e.file)
    if (!fs.existsSync(abs)) {
      check(false, `${t.id} ${e.file} 存在`, '（文件不在工作树里）')
      seedRows.push({ id: t.id, file: e.file, hits: null })
      continue
    }
    const n = fs.readFileSync(abs, 'utf8').split(e.find).length - 1
    check(n === 1, `${t.id} ${e.file} 锚点命中 1 次`, `实得 ${n}${n === 0 ? '  ★ 0 次 = 行尾/内容不对' : ''}`)
    seedRows.push({ id: t.id, file: e.file, hits: n })
  }
}

// ── [7] 证据 D：R1 —— 判据清单在树里"一个都不存在"（存在性断言，无启发式）────
say('')
say('[7] 证据 D：R1 —— 判据文件在工作树里的存在性（全部必须为"不存在"）')
const judgeRows = []
for (const rel of JUDGE_FILES) {
  const exists = fs.existsSync(path.join(DIR, rel))
  check(!exists, `${rel} 不存在于工作树`, exists ? '**仍在！R1 破了**' : '')
  judgeRows.push({ file: rel, existsInWt: exists })
}
// 反向自证：R1 的对象**必须**在主仓里存在（否则这条断言在空集上为真 = 假绿）
const judgeInRepo = JUDGE_FILES.filter((rel) => fs.existsSync(path.join(ROOT, rel)))
check(judgeInRepo.length > 0, `反向自证：判据在主仓里确实存在（${judgeInRepo.length}/${JUDGE_FILES.length}）`, '否则"工作树里没有"是在空集上为真')

// ── [8] 证据 E：工作树确实**有东西**（没被执行错误地清空）────────────────────
say('')
say('[8] 证据 E：工作树不是空壳（被测代码要在）')
const mustHave = ['package.json', 'packages/switchboard/src/index.ts']
for (const rel of mustHave) check(fs.existsSync(path.join(DIR, rel)), `存在：${rel}`, '')
const trackedWt = String(gitIn(DIR, ['ls-files']).stdout ?? '').split('\n').filter((l) => l.trim()).length

// ── 汇总 ──────────────────────────────────────────────────────────────────
const ok = problems.length === 0
result.ok = ok
result.head = wtHead
result.checks = {
  problems,
  seedRows,
  judgeRows,
  judgeInRepo,
  build: { lib: built.lib, skipped: built.skipped, why: built.why },
  eol: { files: eolRows.length, wCrlf: crlfRows.map((l) => l.trim().split(/\s+/).pop()) },
}
result.nodeModules = fs.existsSync(path.join(DIR, 'node_modules'))
result.built = fs.existsSync(built.lib)
say('')
say('─'.repeat(78))
say(`结论：${ok ? '✓ 工作树建好（已构建），且全部证据为真（判据不在树里）' : `✗ 有 ${problems.length} 条证据不成立`}`)
if (!ok) for (const p of problems) say(`  · ${p}`)
say('')
say(`工作树：${DIR}`)
say(`  ★ 已接依赖（node_modules junction）并**在树内构建**过：packages/switchboard/lib/index.js ${result.built ? '存在' : '**不存在**'}`)
say(`  改用 --repo 指认这棵树（判据脚本**在主仓里跑**，被检的树是它）：`)
say(`    node scripts/eval-validate.mjs --repo "${DIR}" --only <id> --prepare <id>`)
say(`    node scripts/test-injected-message-shape.mjs --repo "${DIR}"`)
say(`    node scripts/check-all.mjs --repo "${DIR}"`)
say(`    node scripts/memory-judge-poison-check.mjs --wt "${DIR}"`)
say(`  （也可以只用环境变量：DSH_EVAL_REPO="${DIR}"）`)
say(`  工作树里 git 跟踪文件 ${trackedWt} 个；node_modules：${result.nodeModules ? '已接（junction → 判据根）' : '**没接上**（构建/判据可能跑不动）'}`)
say('')

if (jsonOut) {
  const abs = path.isAbsolute(jsonOut) ? jsonOut : path.join(ROOT, jsonOut)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(result, null, 2), 'utf8')
  say(`JSON → ${abs}`)
}
process.exit(ok ? 0 : 1)
