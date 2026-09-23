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
 * ── ★★ O85（2026-09-22）：**建树根可以移出判据根**（`--root`）────────────────────
 *
 * **上一轮的场地错在哪**：默认根是 `<判据根>/out/_wt/<名字>` ⇒ 被测 agent 的 cwd 在
 * `dsh-brain/` **里面**，用 `..` 走两层就回到 `dsh-brain/`：`scripts/`、`evals/`、
 * 以及 `out/` 里**所有历史判据产物**（`gate-vector-run.txt`、`w2*-*`、`face-audit.txt`…）
 * 全在**祖先链**上随手可及。`sparse-checkout` 只挡住了"**树里**没有判据"，
 * **没挡住"树外向上两层就是判据根"** —— 而且 `out/` 下还同时放着**两臂的记忆库**，
 * 于是 A 臂能读到 B 臂的记忆 ⇒ **自变量泄漏**（两臂就不再是两臂）。
 *
 * **新的口径**：判据一律留在判据根、**由外部执行**；场地整体搬到判据根**之外**，
 * 每臂一个**互不共享实验根**的独立目录：
 *   ```
 *   D:/project_develop/_abA/{wt,store}      ← A 臂的实验根（非项目；`_` 前缀 = 本工作区约定）
 *   D:/project_develop/_abB/{wt,store}      ← B 臂的实验根（与 A **不共享**任何子目录）
 *   node scripts/eval-wt-new.mjs --root D:/project_develop/_abA --name wt
 *   ```
 * ★ 这样两条都成立：**判据根不在工作树的祖先链上**；**两臂的祖先链没有公共的"实验根"**
 *   （除了 `D:/project_develop` 这一层）。
 * ★★ 但**这不是沙箱**：被测 agent 有 `pwsh` ⇒ 它可以 `cd` 到任何地方、可以 `ls ..`、
 *   可以走绝对路径 ⇒ **文件系统级的绝对隔离在不加沙箱时做不到**。
 *   本布置只堵三条：① 工作目录子树内 ② 祖先链 ③ 两臂互见（朴素相对路径）。
 *   残余风险见 `out/w31-o85-isolation.md`「残余风险」。
 *
 * ── ★★ O86（2026-09-22）：**同卷的"非兄弟根"不够 —— 两臂必须落在不同卷**────────────
 *
 * **上一轮（O85）的场地仍然是坏的，而且是致命的**：两臂的实验根是**兄弟目录**
 *   ```
 *   D:/project_develop/_abA/{wt,store}      ← A 臂
 *   D:/project_develop/_abB/{wt,store}      ← B 臂   ★ 与 _abA 同一个父目录
 *   ```
 * ⇒ 实测 `D:/project_develop/_abA/wt/../../_abB/store/knowledge_base.json` **真的存在**
 *   ⇒ **A 臂用一条相对路径就直接读到了 B 臂的记忆库** ⇒ 自变量泄漏 ⇒ **A/B 不再是两臂**。
 *   O85 的报告把这条记成"长回旋可达"的**残余**，但它是**判据本身**：臂间互见 = 实验没有对照。
 *
 * **为什么"同卷换个非兄弟根"仍然不够**：`..` 在**同一个卷内是无界的**。
 *   把 B 改到 `D:/_abB` 只是让它从"上两级"变成"上三级"——只要知道名字，**照样到得了**。
 *   ⇒ 想做到**"从任一臂出发，用任意相对路径都到不了对方的 store / wt"**，
 *     唯一的硬办法是让两臂**不在同一个卷**：相对路径**永远跨不过卷根**（`D:\` ↔ `C:\`）。
 *
 * **本轮口径（跨卷 + 长度对齐）**：
 *   ```
 *   D:/project_develop/_abA/{wt,store}      ← A 臂（判据根所在卷 D:）
 *   C:/_abB-experiment-root/{wt,store}      ← B 臂（★ 另一个卷；与 A 的祖先链交集 = ∅）
 *   node scripts/eval-wt-new.mjs --root C:/_abB-experiment-root --name wt --peer D:/project_develop/_abA
 *   ```
 *   · ★ **为什么 B 的目录名要凑成 20 个字符**：`mem-arm.mjs` 有一条既有约束 ——
 *     两臂 cwd 的**路径长度必须相同**（否则长度差异会泄进 `system`，见该文件里的说明）。
 *     `D:/project_develop/_abA/wt` 是 26 字符 ⇒ `C:/_abB-experiment-root/wt` 也正好 26 字符。
 *   · ★ **为什么卷根不同就等价于"不可达"**：`path.relative()` 在跨卷时**不返回相对路径**，
 *     而是回落成绝对路径（`C:\_abB-experiment-root`）⇒ 这本身就是"相对路径表达不出这条路"的机器证据。
 *     `[10]` 步把这条做成断言，并且**再实探一遍**长回旋候选路径（都必须是 ENOENT）。
 *   · ★★ **仍然不是沙箱**：A 臂在 D: 卷 ⇒ 它用长回旋相对路径**照样能回到判据根**
 *     （`../../../project_develop/dsh-brain/scripts/…`）。本轮堵住的只有**臂间互见**这一条。
 *     残余风险见 `out/w32-o86-arms.md`「残余风险」。
 *
 * ── ★★ O117（格 ⑩）：**靶文件在 wt 内**（能力题的靶子单独捞回）──────────────────
 *   上面 O69/R1 的"排除"解决的是"判据别进被测树"；但它顺手把**靶文件**也排掉了 ——
 *   而 `cli-0004` 的靶子在 `scripts/`、`cli-0005` 的靶子在 `evals/pilot/rename-target/`
 *   ⇒ 这两题在隔离布置下**天然无解**（agent 在 cwd 里找不到要改的文件）⇒ 它只能去判据根找
 *     ⇒ 这正是格 ⑨ 的结构性根因（同一句话：**题面与隔离布置自相矛盾**）。
 *   **处置**：`TARGET_INCLUDES` —— 用 sparse-checkout 的 `--no-cone`（后写的覆盖先写的）
 *   把**靶文件**捞回来，`scripts/` 与 `evals/` 目录因此存在、但里面**只有靶文件**：
 *     · R1 仍然成立（oracle / 规格 / 题面 / 任务集**一个都不在**树里，[7] 逐条断言）；
 *     · "靶文件在 wt 内"变成**可打印的读数**（[4b]）。
 *   ⚠️ 捞回靶文件**不等于**"答案不可达"：那还要求封 git（`scripts/eval-seal-git.mjs`）
 *     与 oracle 认 `--repo`（两个能力题的 oracle 原先硬编码自身相对路径）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node scripts/eval-wt-new.mjs --name w25-R1
 *   node scripts/eval-wt-new.mjs --root D:/project_develop/_abA --name wt
 *   ★ O86（跨卷两臂，别忘 --peer）：
 *   node scripts/eval-wt-new.mjs --root C:/_abB-experiment-root --name wt --peer D:/project_develop/_abA
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
/**
 * ── ★★ O117（格 ⑩）：**能力题的靶文件必须落进工作树** ────────────────────────
 *
 * **为什么**：判据 `applicable = 靶文件在 wt 内 ∧ 答案不可达`（`scripts/eval-task-applicability.mjs`）。
 * 靶文件不在 wt 里 ⇒ 被测 agent 在**自己的 cwd 里无解** ⇒ "去判据根找文件"是被题面**逼出来**的必然行为
 * （格 ⑨ 的结构性根因，也是 w41 的 k=4/k=5 的真实成因）。
 * ★ `cli-0005` 的靶子在 `evals/pilot/rename-target/`、`cli-0004` 的靶子在 `scripts/`
 *   —— 正好都在默认排除区里 ⇒ 这两题在隔离布置下**天然无解**。
 *
 * ★★ 但**只放靶文件**：`evals/checks/cli-0004.mjs`（oracle）、`evals/pilot/rename-target/check.mjs`（oracle）、
 *   `evals/pilot/rename-target/README.md`（含期望名的**规格**）、`evals/pilot/tasks.jsonl`（题面 + seed）
 *   —— **一个都不放**（它们才是"答案"），[7] 会逐条断言它们不在树里。
 *   ⚠️ 规格文件故意不进保留区：它写着期望的新名字 ⇒ 进了就变成"答案在 wt 里"，`applicable` 反而为 false。
 *     （题面 `invariant` 已经把"`computeHash` → `digestOf`"说全了 ⇒ 少了 README 只是缺上下文，不是无解。）
 *
 * **怎么做的**：sparse-checkout 的 `--no-cone` 模式里，**后写的模式覆盖先写的** ——
 *   先 `!/<排除项>/` 把整目录排掉，再 `/<靶文件>` 把靶文件单独捞回来。
 *   ⇒ 结果：`scripts/` 与 `evals/` 目录**存在**，但里面**只有靶文件**（[4] 断言"排除区里只有允许清单里那些"）。
 */
const TARGET_INCLUDES = [
  'scripts/verify-drain-after-swap.mjs', // cli-0004 的靶文件（scripts/ 排除区里单独捞回）
  'evals/pilot/rename-target/math.js', // cli-0005 的靶文件 ×3（evals/ 排除区里单独捞回）
  'evals/pilot/rename-target/store.js',
  'evals/pilot/rename-target/index.js',
]
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
  node scripts/eval-wt-new.mjs --name <名字> [--root <绝对路径>] [--dir <绝对路径>]
                               [--peer <另一臂的实验根>] [--exclude <仓库相对目录>]… [--json <file>]

参数：
  --name <n>        工作树名字（默认目录 <建树根>/<n>；建树根默认 <仓库>/out/_wt，out/ 已在 .gitignore 里）
  --root <abs>      建树根目录（必须绝对路径；建树 = <root>/<name>）。★ O85：把它指到判据根
                    **之外**（如 D:/project_develop/_abA）⇒ 判据不在被测 agent 的祖先链上；
                    留在判据根内（默认）⇒ 只挡"树里"，不挡"树外向上两层的 dsh-brain/"。
  --peer <abs>      ★★ O86：**另一臂**的实验根（如 D:/project_develop/_abA）。给了它 ⇒ 多跑一步 [10]：
                    从**本树**出发用相对路径去够对方的 store / wt，判定"两臂互不可见"。
                    **要求两臂在不同卷**（相对路径跨不过卷根）——同卷即使不是兄弟也到得了（'..' 在卷内无界）。
  --peer-only       ★★ O86：**不起树**，只对**已存在**的场地跑"两臂互不可见"判据（**双向**），然后退出。
                    必须与 --dir <本树> 和 --peer <另一臂实验根> 一起给。可复跑命令：
                      node scripts/eval-wt-new.mjs --peer-only --dir D:/project_develop/_abA/wt --peer C:/_abB-experiment-root
  --dir <abs>       直接指定目录（必须绝对路径；与 --name 二选一，优先级最高）
  --exclude <p>     额外排除的仓库相对目录（可重复，**追加**）。默认已排除：${DEFAULT_EXCLUDES.join(' , ')}
  --include <p>     ★★ O117：额外**捞回**的靶文件（仓库相对**文件**路径，可重复，追加）。
                    默认已捞回（两个能力题的靶子）：${TARGET_INCLUDES.join(' , ')}
  --no-hygiene      只排除规格点名的两个目录（scripts , evals），不带 docs/patches/.workbuddy
  --json <file>     把结论写成 JSON（默认不写）
  -h, --help        打印本用法

⚠ 默认建树根在判据根内部：out/ 被 git 忽略 ⇒ 起树**不会**让主仓 \`git status\` 多出
"?? _wt/" 这一行（放在仓库根下的 _wt/ 会让它变脏 —— 而"主仓未被污染"是硬要求）。
★ 但**代价**是：工作树在 \`dsh-brain/\` 里面 ⇒ \`..\` 两层就回到判据根（scripts/ evals/ out/）
⇒ **判据在祖先链上**。要真隔离就显式给 \`--root\`（见文件头 O85 一节）。
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
 * ── ★★ O85：祖先链与"判据面"探测（纯只读，不碰任何东西）────────────────────
 */
/** `p` 相对 `anc` 的路径（正斜杠、可读）。 */
const relFrom = (anc, p) => path.relative(path.resolve(anc), path.resolve(p)).replace(/\\/g, '/')
/** `p` 是否在 `anc` **内部或就是它自己**（`''` = 同一个目录也算在内）。 */
function isInside(anc, p) {
  const rel = relFrom(anc, p)
  return rel === '' || (!rel.startsWith('../') && !path.isAbsolute(rel))
}
/** 工作树的**完整祖先链**（从父目录一路到盘符根，不含自己；循环只从 `return` 退出）。 */
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
/**
 * 每个祖先目录里**直接**（不下钻）有没有"判据面"的目录名 —— 即从工作树用 `..`+名字就能回到的东西。
 * ★ 只收**判据根的专名**，不收泛名（`docs` / `patches` 之类的普通目录在祖先链上到处都是，
 *   收进来只会变成噪音 —— 而噪音会让人忽略真正的提醒）：
 *   · `dsh-brain` = 判据根基线名（回到它就等于回到 `scripts/` `evals/` `out/`）；
 *   · `scripts` / `evals` = R1 的直接对象（判据目录本身的基线名）；
 *   · `out` = 判据产物目录（历史判据产物 `gate-vector-run.txt` / `w2*-*` / `face-audit.txt` 全在里面）。
 * ★ 只报"名字在"，不做"里面有没有判据"的判断（后者是 `memory-judge-poison-check.mjs` 的对象）。
 */
const JUDGE_FACE_NAMES = new Set(['dsh-brain', 'scripts', 'evals', 'out'])
function judgeFaceIn(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && JUDGE_FACE_NAMES.has(e.name))
    .map((e) => e.name)
    .sort()
}

/**
 * ── ★★ O86：两臂互不可见的机器判据（纯只读，不写任何东西）────────────────────
 *
 * 判据对象：**从本工作树出发，用【任意相对路径】都到不了另一臂的实验根（其 `store` / `wt`）**。
 * 三条机器依据（缺一条都不算过）：
 *
 *   1. ★ **卷根不同** —— 相对路径**永远跨不过卷根**：Windows 上从 `D:\…` 出发没有任何相对写法
 *      能落到 `C:\…`；`path.relative()` 自己就会**回落成绝对路径**（`C:\_abB-experiment-root`）
 *      ⇒ 这条不是"抽样没探到"，而是"**这种路径不存在**"的充分证明。
 *   2. ★ **对方不在本树的祖先链上** —— 否则 `..` 就直接上去了（O85 的场地就是这一条破的）。
 *   3. ★ **实探** —— 从本树构造一族**长回旋**候选（上 1…5 级，再拼对方目录名 + 尾部子路径），
 *      逐条 `stat` ⇒ **必须全部 ENOENT**。
 *      ★ 先证明**对方确实存在**：否则"全部 ENOENT"是在空集上为真 = **假绿**（本项目的硬纪律）。
 *
 * 返回的 `attempts` 是**全部**实探读数（报告里要原样贴），不是只贴通过的那一半。
 */
const volumeOf = (p) => path.parse(path.resolve(p)).root.toLowerCase()
const UP_LEVELS = 5
const PEER_SUBPATHS = ['', 'store', 'store/knowledge_base.json', 'wt', 'wt/package.json']
function crossArmVerdict(wtDir, peerRoot) {
  const wt = path.resolve(wtDir)
  const peer = path.resolve(peerRoot)
  const peerExists = fs.existsSync(peer)
  const volWt = volumeOf(wt)
  const volPeer = volumeOf(peer)
  const volumeDiffers = volWt !== volPeer
  // ★ 跨卷时 `path.relative` **不返回相对路径**，而是绝对路径 —— 这本身就是机器证据。
  const relRaw = path.relative(wt, peer)
  const relIsAbsolute = path.isAbsolute(relRaw)
  const peerInAncestors = ancestorsOf(wt)
    .map((a) => a.toLowerCase())
    .includes(peer.toLowerCase())
  const peerBase = path.basename(peer)
  const attempts = []
  for (let k = 1; k <= UP_LEVELS; k++) {
    for (const sub of PEER_SUBPATHS) {
      const p = `${'../'.repeat(k)}${peerBase}${sub ? '/' + sub : ''}`
      const abs = path.resolve(wt, p)
      attempts.push({ rel: p, abs: abs.replace(/\\/g, '/'), exists: fs.existsSync(abs) })
    }
  }
  const reachable = attempts.filter((a) => a.exists)
  const ok = peerExists && volumeDiffers && !peerInAncestors && reachable.length === 0
  return {
    ok,
    wt: wt.replace(/\\/g, '/'),
    peer: peer.replace(/\\/g, '/'),
    peerExists,
    volWt,
    volPeer,
    volumeDiffers,
    relRaw: relRaw.replace(/\\/g, '/'),
    relIsAbsolute,
    peerInAncestors,
    probes: attempts.length,
    reachable,
    attempts,
    ancestorsWt: ancestorsOf(wt).map((a) => a.replace(/\\/g, '/')),
    ancestorsPeer: ancestorsOf(peer).map((a) => a.replace(/\\/g, '/')),
  }
}

/**
 * 把 `crossArmVerdict()` 的结果**打印出来并下判定**（走 `check()` ⇒ 计入退出码）。
 * ★ 打印的是**全部**实探读数（不是只贴通过的那一半）—— 报告要原样引用。
 * @returns 判决对象（供 `--json` 与 `--peer-only` 复用）
 */
function reportPeerCheck(wtDir, peerRoot, label) {
  const pv = crossArmVerdict(wtDir, peerRoot)
  const lower = pv.ancestorsPeer.map((x) => x.toLowerCase())
  const inter = pv.ancestorsWt.filter((a) => lower.includes(a.toLowerCase()))
  say('')
  say(`${label}：两臂互不可见 —— 从**本树**出发，用【任意相对路径】够另一臂`)
  say(`    本树（被测 agent 的 cwd）: ${pv.wt}`)
  say(`    另一臂的实验根            : ${pv.peer}`)
  say(`    前提：对方确实存在？      : ${pv.peerExists ? '是 ✓（否则下面的 ENOENT 是空集上的真）' : '**否 ✗**（空集上为真 ⇒ 本步作废）'}`)
  say('')
  say(`    依据①卷根：本树在 ${pv.volWt}   另一臂在 ${pv.volPeer}   ${pv.volumeDiffers ? '★ 不同卷 ⇒ 相对路径**跨不过去** ✓' : '**同卷** ✗ ⇒ \'..\' 在卷内无界，只要知道名字就到得了'}`)
  say(`      path.relative(本树 → 另一臂) = ${pv.relIsAbsolute ? `**${pv.relRaw}**（★ 回落成绝对路径 = "相对路径表达不出这条路"的机器证据）` : `${pv.relRaw}（是相对路径 ⇒ 可达）`}`)
  say(`    依据②祖先链：另一臂在本树祖先链上？ ${pv.peerInAncestors ? '**在** ✗' : '不在 ✓'}`)
  say(`      本树祖先链（共 ${pv.ancestorsWt.length} 级）: ${pv.ancestorsWt.join('  <  ')}`)
  say(`      另一臂祖先链（共 ${pv.ancestorsPeer.length} 级）: ${pv.ancestorsPeer.join('  <  ')}`)
  say(`      两条祖先链的交集: ${inter.length ? inter.join(' , ') : '（空）'}`)
  say(`        ⇒ 除卷根本身以外，两臂${inter.every((x) => x === pv.volWt || x === pv.volPeer) ? '**不共享任何目录** ✓（交集只含卷根）' : '**共享了非卷根目录** ✗'}`)
  say('')
  say(`    依据③实探：从本树构造 ${pv.probes} 条**长回旋**相对路径（上 1…${UP_LEVELS} 级 + 对方目录名 + 尾部子路径），逐条 stat：`)
  for (const a of pv.attempts) say(`      [${a.exists ? '**可达 ✗**' : 'ENOENT ✓'}] ${a.rel.padEnd(34)} → ${a.abs}`)
  say(`      ⇒ 可达 ${pv.reachable.length}/${pv.probes} 条${pv.reachable.length ? `：${pv.reachable.map((a) => a.rel).join(' , ')}` : '（全部失败）'}`)
  check(pv.peerExists, `O86：另一臂确实存在（${pv.peer}）`, pv.peerExists ? '' : '⇒ 判据对象不存在，"不可见"无意义')
  check(pv.volumeDiffers, 'O86：两臂在**不同卷**（相对路径跨不过卷根）', pv.volumeDiffers ? `${pv.volWt} vs ${pv.volPeer}` : '**同卷** ⇒ 长回旋可达')
  check(!pv.peerInAncestors, 'O86：另一臂不在本树的祖先链上', pv.peerInAncestors ? '**在！**' : '')
  check(pv.reachable.length === 0, `O86：${pv.probes} 条长回旋相对路径**全部 ENOENT**`, pv.reachable.length ? `${pv.reachable.length} 条可达：${pv.reachable.map((a) => a.rel).join(' , ')}` : '0 条可达')
  return pv
}

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
/** ★ O85：建树根（缺省仍是 `<判据根>/out/_wt` —— **默认行为逐字不变**，只多一句提醒）。 */
const rootArg = argOf('--root')
/** ★★ O86：另一臂的实验根。给了它 ⇒ 多跑一步 [10]（两臂互不可见的机器判据）。 */
const peerArg = argOf('--peer')
/** ★★ O86：`--peer-only` —— **不起树**，只对**已存在**的两臂场地跑互不可见判据（双向），然后退出。 */
const PEER_ONLY = argv.includes('--peer-only')
/** `--no-hygiene`：退回"只排规格点名的两个目录"（`scripts` / `evals`）—— 留给想复现旧行为的人。 */
const baseExcludes = argv.includes('--no-hygiene') ? ['scripts', 'evals'] : DEFAULT_EXCLUDES
const extraExcludes = allOf('--exclude')
/** ★★ O117：额外**捞回**的靶文件（仓库相对路径，可重复；追加在 TARGET_INCLUDES 之后）。 */
const extraIncludes = allOf('--include')
const jsonOut = argOf('--json')
if (rootArg && !path.isAbsolute(rootArg)) {
  process.stderr.write(`[${NAME}] 用法错误：--root 必须是绝对路径（用 D:/… 而不是 /d/…）\n`)
  process.exit(2)
}
if (rootArg && dirArg) {
  process.stderr.write(`[${NAME}] 用法错误：--root 与 --dir 不能同时给（--dir 已经直接就是工作树目录）\n`)
  process.exit(2)
}
if (rootArg && !name) {
  process.stderr.write(`[${NAME}] 用法错误：--root 要与 --name 一起用（工作树 = <root>/<name>）\n`)
  process.exit(2)
}
if (!name && !dirArg) {
  process.stderr.write(`[${NAME}] 用法错误：--name 或 --dir 必须给一个\n\n${USAGE}`)
  process.exit(2)
}
if (dirArg && !path.isAbsolute(dirArg)) {
  process.stderr.write(`[${NAME}] 用法错误：--dir 必须是绝对路径（用 D:/… 而不是 /d/…）\n`)
  process.exit(2)
}
if (peerArg && !path.isAbsolute(peerArg)) {
  process.stderr.write(`[${NAME}] 用法错误：--peer 必须是绝对路径（用 D:/… 而不是 /d/…）\n`)
  process.exit(2)
}
if (PEER_ONLY && (!dirArg || !peerArg)) {
  process.stderr.write(`[${NAME}] 用法错误：--peer-only 必须同时给 --dir <本树> 与 --peer <另一臂的实验根>\n\n${USAGE}`)
  process.exit(2)
}
/** ★ 建树根：`--root` 优先；缺省**逐字保持旧值** `<判据根>/out/_wt`。 */
const ROOTDIR = rootArg ? path.resolve(rootArg) : path.join(ROOT, 'out', '_wt')
const DIR = dirArg ? path.resolve(dirArg) : path.join(ROOTDIR, String(name))

/**
 * ── ★★ O86 `--peer-only`：只跑"两臂互不可见"判据（**双向**），不起树、不写任何东西 ─────────
 * 为什么要这个模式：`[10]` 藏在"建树"流程里 ⇒ 想对**已经在用的**两臂场地复跑这条判据，
 * 就得再建一棵临时树（会在 `git worktree list` 里留垃圾）。这个模式把判据**单独**拿出来：
 *   node scripts/eval-wt-new.mjs --peer-only --dir D:/project_develop/_abA/wt --peer C:/_abB-experiment-root
 * ★ 双向都跑：门要的是"**从任一臂出发**都到不了对方"，只测一个方向不算过。
 */
if (PEER_ONLY) {
  const peerRoot = path.resolve(peerArg)
  const aRoot = path.dirname(DIR)
  const peerWt = path.join(peerRoot, 'wt')
  say(`${NAME} —— ★★ O86：两臂互不可见判据（--peer-only；纯只读，不起树、不写文件）`)
  say(`  本树（A，被测 agent 的 cwd）: ${DIR}`)
  say(`  本臂实验根                  : ${aRoot}`)
  say(`  另一臂（B）的实验根          : ${peerRoot}`)
  reportPeerCheck(DIR, peerRoot, '  [A→B]')
  if (fs.existsSync(peerWt)) {
    reportPeerCheck(peerWt, aRoot, '  [B→A]')
  } else {
    say('')
    say(`  ⊘ 方向 [B→A] 跳过：${peerWt} 不存在（对方没有工作树 ⇒ 该方向无从检起；这不等于通过）`)
    problems.push('方向 [B→A] 未能检起（对方的 wt 不存在）')
  }
  const okPeer = problems.length === 0
  say('')
  say('─'.repeat(78))
  say(`结论：${okPeer ? '✓ 两臂互不可见（**双向**、含长回旋）—— 从任一臂出发，任何相对路径都到不了对方' : `✗ 有 ${problems.length} 条判据不成立`}`)
  for (const p of problems) say(`  · ${p}`)
  process.exit(okPeer ? 0 : 1)
}

const EXCLUDES = [...new Set([...baseExcludes, ...extraExcludes])].map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''))
/**
 * ★★ O117：捞回的靶文件清单（默认含两个能力题的靶子；`--include` 可追加）。
 * ★ 在主仓里不存在的项**直接报出来并丢弃** —— 否则会变成"稀疏模式写了但什么都没捞回来"的假证据。
 */
const INCLUDES_RAW = [...new Set([...TARGET_INCLUDES, ...extraIncludes])].map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''))
const INCLUDES_MISSING = INCLUDES_RAW.filter((p) => !fs.existsSync(path.join(ROOT, p)))
const INCLUDES = INCLUDES_RAW.filter((p) => !INCLUDES_MISSING.includes(p))

/** ★★ O85 的核心读数：判据根在不在工作树的祖先链上。 */
const ANCESTORS = ancestorsOf(DIR)
const JUDGE_ROOT_IN_ANCESTORS = ANCESTORS.includes(path.resolve(ROOT))
const DIR_INSIDE_JUDGE_ROOT = isInside(ROOT, DIR)

const result = { name: name ?? path.basename(DIR), dir: DIR, root: ROOTDIR, excludes: EXCLUDES, includes: INCLUDES, includesMissing: INCLUDES_MISSING, repo: ROOT, at: new Date().toISOString() }
say(`${NAME} —— 起隔离工作树（不含判据）`)
say(`  仓库      : ${ROOT}`)
say(`  建树根    : ${ROOTDIR}${rootArg ? '' : '   （缺省：判据根内的 out/_wt/）'}`)
say(`  目标目录  : ${DIR}`)
say(`  排除      : ${EXCLUDES.map((e) => e + '/').join(' , ')}`)
say(`  捞回靶文件: ${INCLUDES.length ? INCLUDES.join(' , ') : '（无）'}${INCLUDES_MISSING.length ? `   ⚠ 主仓里不存在、已丢弃：${INCLUDES_MISSING.join(' , ')}` : ''}`)
if (DIR_INSIDE_JUDGE_ROOT) {
  say('')
  say('  ⚠ 建树根在**判据根内部** ⇒ R1 只挡住了"树里没有判据"，**没挡住**"从这棵树 `..` 上去')
  say(`     就是 \`${ROOT}\`（scripts/ evals/ out/ 全在祖先链上）" ⇒ 判据在祖先链上。`)
  say(`     ⇒ 真隔离请显式给 \`--root\`，指到判据根之外（例：--root D:/project_develop/_abA）。`)
}
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
const patterns = ['/*', ...EXCLUDES.map((e) => `!/${e}/`), ...INCLUDES.map((p) => `/${p}`)]
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
/**
 * ★★ O117：本条判据从"排除目录**不存在**"改成更强的形态 ——
 *   **排除区里出现的文件必须恰好是允许清单（`INCLUDES`）里的那些**。
 * 为什么改：靶文件被**刻意捞回**到 `scripts/` 与 `evals/` 里 ⇒ "目录不存在"不再是正确判据
 *   （继续用它只会假红）；而"目录里只有靶文件"既保住了 R1，又把"捞回"变成**可打印的读数**。
 */
function walkFiles(dirAbs, base, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dirAbs, e.name)
    if (e.isDirectory()) walkFiles(abs, base, out)
    else out.push(path.relative(base, abs).replace(/\\/g, '/'))
  }
  return out
}
const excludeAreaRows = []
for (const e of EXCLUDES) {
  const abs = path.join(DIR, e)
  if (!fs.existsSync(abs)) {
    check(true, `已排除：${e}/ 不在工作树（本来就没有）`, '')
    excludeAreaRows.push({ dir: e, exists: false, files: [], unexpected: [] })
    continue
  }
  const found = walkFiles(abs, DIR)
  const unexpected = found.filter((f) => !INCLUDES.includes(f))
  excludeAreaRows.push({ dir: e, exists: true, files: found, unexpected })
  check(
    unexpected.length === 0,
    `排除区 ${e}/ 里只有允许保留的靶文件`,
    unexpected.length ? `**多出 ${unexpected.length} 个**：${unexpected.slice(0, 6).join(', ')}` : `区内文件：${found.join(' , ') || '（空目录）'}`,
  )
}
const status = gitIn(DIR, ['status', '--porcelain'])
const statusLines = String(status.stdout ?? '').split('\n').filter((l) => l.trim())
check(status.status === 0 && statusLines.length === 0, 'git -C <wt> status --porcelain 为空', statusLines.length ? `实得 ${statusLines.length} 行：${statusLines.slice(0, 5).join(' | ')}` : '0 行')
const diffStat = gitIn(DIR, ['diff', '--stat'])
check(String(diffStat.stdout ?? '').trim() === '', 'git -C <wt> diff --stat 为空', JSON.stringify(String(diffStat.stdout ?? '').trim().slice(0, 120)))
const wtHead = String(gitIn(DIR, ['rev-parse', 'HEAD']).stdout ?? '').trim()
check(wtHead === repoHead, '工作树 HEAD == 主仓 HEAD', `${wtHead} vs ${repoHead}`)

// ── [4b] ★★ O117 证据：能力题的靶文件**真的落进了工作树**（贴的是实际路径）────────
say('')
say('[4b] O117 证据：捞回的靶文件在工作树里的**实际路径**（判据是"文件真的在"，不是"模式写了"）')
const targetRows = []
for (const rel of INCLUDES) {
  const abs = path.join(DIR, rel)
  const exists = fs.existsSync(abs)
  targetRows.push({ file: rel, inWt: exists, abs: abs.replace(/\\/g, '/') })
  check(exists, `靶文件在 wt 内：${rel}`, exists ? abs.replace(/\\/g, '/') : '**不存在 ⇒ 该题在隔离布置下无解**')
}
// 反向自证：这些靶文件在主仓里确实存在（否则"wt 里有"是在空集上为真 = 假绿）
const targetInRepo = INCLUDES.filter((rel) => fs.existsSync(path.join(ROOT, rel)))
check(targetInRepo.length === INCLUDES.length, `反向自证：${INCLUDES.length} 个靶文件在主仓里都在（${targetInRepo.length}/${INCLUDES.length}）`, '')

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

// ── [9] ★★ O85 证据 F：**判据根不在工作树的祖先链上**（这是本轮的要害）──────
// 上一轮的场地是 `<判据根>/out/_wt/<名字>` ⇒ 从工作树 `cd ../..` 就回到判据根 ⇒
// scripts/ evals/ out/（含**两臂的记忆库**与全部历史判据产物）全在祖先链上 ⇒
// ① 判据泄漏 ② 自变量泄漏（A 能读 B 的记忆）。本步把"祖先链"变成**可打印、可断言的读数**。
say('')
say('[9] O85 证据 F：工作树的完整祖先链（判据根必须不在其中）')
say(`    祖先链（自下而上，共 ${ANCESTORS.length} 级）：`)
say(`      工作树  ${DIR}`)
for (const a of ANCESTORS) {
  const face = judgeFaceIn(a)
  say(`        ↑     ${a}${face.length ? `   ⚠ 该目录下有判据面目录名：${face.join(' / ')}` : ''}`)
}
check(!JUDGE_ROOT_IN_ANCESTORS, `判据根**不在**祖先链上（不含 ${ROOT}）`, JUDGE_ROOT_IN_ANCESTORS ? `**在！**祖先链里有 ${ROOT} ⇒ 判据在 agent 够得到的地方` : `${ANCESTORS.length} 级祖先，一个都不是判据根`)
const faceHits = ANCESTORS.map((a) => ({ dir: a, names: judgeFaceIn(a) })).filter((x) => x.names.length)
if (DIR_INSIDE_JUDGE_ROOT) {
  say(`    ⚠ 目标目录在判据根**内部** ⇒ 判据在祖先链上（这是缺省布局的已知代价；用 --root 移出去）`)
} else if (faceHits.length) {
  // ★ 诚实：这不是"破了"，因为**同盘符下任何位置都能用 `..`+名字回到判据根**（`..` 是无界的）。
  //   这条只说明"从工作树用 `..` 加一个目录名就能看到判据根的**名字**"⇒ 本布置不是沙箱。
  say(`    ⚠ 诚实提示（**不是**失败）：祖先链上有目录含判据面目录名 ——`)
  for (const h of faceHits) say(`        ${h.dir} → ${h.names.join(' / ')}`)
  say(`      ⇒ 被测 agent 只要知道名字，用 \`..\` 就能回到判据根 ⇒ **本布置不构成沙箱**（见报告"残余风险"）。`)
} else {
  say(`    ✓ 祖先链上没有任何一级目录含判据面目录名（dsh-brain / scripts / evals / out）`)
}
// ★ .git 指针：`git worktree` 必在树里留一个文本文件 `.git`，内容是判据根的**绝对路径**。
//   它不是"判据文件"，但它**指出了判据根在哪** ⇒ 必须如实打印，不许当成没发生。
// ★★ 比之前先**统一到同一套斜杠**再比 —— 否则 `D:\…` 与 `D:/…` 一比就恒为"未指向"，
//    这条自检会**静默变瞎**（实测踩过：arm-A 明明指向判据根，却打印"未指向判据根"）。
const dotGit = path.join(DIR, '.git')
const slash = (s) => String(s).replace(/\\/g, '/')
if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
  const txt = fs.readFileSync(dotGit, 'utf8').trim()
  const pointsIntoJudge = slash(txt).includes(slash(ROOT))
  say(`    ${pointsIntoJudge ? '⚠' : '✓'} .git 指针（git worktree 内建）：${txt}`)
  say(`      ${pointsIntoJudge ? '★ 它**指向判据根内部**（.git/worktrees/…）⇒ 被测 agent 读这一个文件就知道判据根在哪（残余风险，见报告）' : '未指向判据根'}`)
}

// ── [10] ★★ O86 证据 G：**两臂互不可见（含长回旋）** ─────────────────────────
// ★ 这一步被抽成 `reportPeerCheck()`：正常建树流程里跑一次；
//   `--peer-only` 模式下**双向各跑一次**（A→B 与 B→A）—— 见文件头 O86 一节。
let peerVerdict = null
if (peerArg && !PEER_ONLY) peerVerdict = reportPeerCheck(DIR, peerArg, '[10] ★★ O86 证据 G')

// ── 汇总 ──────────────────────────────────────────────────────────────────
const ok = problems.length === 0
result.ok = ok
result.head = wtHead
result.checks = {
  problems,
  seedRows,
  judgeRows,
  judgeInRepo,
  targetRows,
  excludeAreaRows,
  build: { lib: built.lib, skipped: built.skipped, why: built.why },
  eol: { files: eolRows.length, wCrlf: crlfRows.map((l) => l.trim().split(/\s+/).pop()) },
}
result.ancestors = ANCESTORS
result.judgeRootInAncestors = JUDGE_ROOT_IN_ANCESTORS
result.dirInsideJudgeRoot = DIR_INSIDE_JUDGE_ROOT
result.judgeFaceInAncestors = faceHits
result.peer = peerVerdict
  ? {
      root: peerVerdict.peer,
      exists: peerVerdict.peerExists,
      volWt: peerVerdict.volWt,
      volPeer: peerVerdict.volPeer,
      volumeDiffers: peerVerdict.volumeDiffers,
      relFromWt: peerVerdict.relRaw,
      relIsAbsolute: peerVerdict.relIsAbsolute,
      peerInAncestors: peerVerdict.peerInAncestors,
      probes: peerVerdict.probes,
      reachable: peerVerdict.reachable,
      ok: peerVerdict.ok,
      ancestorsWt: peerVerdict.ancestorsWt,
      ancestorsPeer: peerVerdict.ancestorsPeer,
    }
  : null
result.dotGitPointer = fs.existsSync(dotGit) && fs.statSync(dotGit).isFile() ? fs.readFileSync(dotGit, 'utf8').trim() : null
result.nodeModules = fs.existsSync(path.join(DIR, 'node_modules'))
result.built = fs.existsSync(built.lib)
say('')
say('─'.repeat(78))
say(`结论：${ok ? `✓ 工作树建好（已构建），且全部证据为真（判据不在树里${result.judgeRootInAncestors ? '' : '、也不在祖先链上'}${peerVerdict ? '、两臂互不可见（含长回旋）' : ''}）` : `✗ 有 ${problems.length} 条证据不成立`}`)
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
say(`  ★★ O117 捞回的靶文件（在工作树里，判据根里的 oracle 用 --repo 判它们）：`)
for (const t of targetRows) say(`      ${t.inWt ? '在 ✓' : '**不在 ✗**'}  ${t.file}`)
say(`      ⇒ 绝对路径：${targetRows.filter((t) => t.inWt).map((t) => t.abs).join('  |  ') || '（一个都没有）'}`)
say(`  O85 隔离读数：判据根在祖先链上 = ${result.judgeRootInAncestors ? '**是**（判据在 agent 够得到的地方）' : '否'}；` +
  `工作树在判据根内部 = ${result.dirInsideJudgeRoot ? '**是**' : '否'}（祖先链 ${result.ancestors.length} 级）`)
if (peerVerdict) {
  say(`  O86 两臂读数：卷 ${peerVerdict.volWt} vs ${peerVerdict.volPeer}（${peerVerdict.volumeDiffers ? '不同卷' : '**同卷**'}）；` +
    `另一臂在祖先链上 = ${peerVerdict.peerInAncestors ? '**是**' : '否'}；长回旋相对路径可达 = ${peerVerdict.reachable.length}/${peerVerdict.probes}`)
}
say('')

if (jsonOut) {
  const abs = path.isAbsolute(jsonOut) ? jsonOut : path.join(ROOT, jsonOut)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(result, null, 2), 'utf8')
  say(`JSON → ${abs}`)
}
process.exit(ok ? 0 : 1)
