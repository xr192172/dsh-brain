# evals/ —— 自进化用的冻结任务集（判据那一半）

> 设计口径见 `docs/agent-eval-arenas.md`（公开靶场调研）与
> `docs/oss-prior-art-and-next-steps.md`（M1/M2 里程碑）。
> 本目录只放**任务与判据**；跑 Agent 的那一半在 `scripts/eval-*.mjs`。

## 为什么判据要自建（而不是刷公开榜）

1. **公开榜对我们几乎饱和**：我们的活儿是"特定仓库 + 特定 MCP 工具集"，通用榜测不到。
2. **抗污染**：自己写的题天然不可污染。2026 年的公开汇总里，SWE-bench Verified 因污染+判据缺陷被
   厂商**停止上报**（审计 138 题 >60% 有缺陷；难度子集里 59.4% 的测试集根本抓不到目标 bug）。
3. **我们已经有现成的 oracle**：把修过的回归**反向打回去**（= `seed`），
   我们自己的门就会红；Agent 修好，门变绿。**这就是 SWE-bench 意义上的 `FAIL_TO_PASS`**，
   而 `check:all` 就是天然的 `PASS_TO_PASS`。⇒ 任务集不用另造，把回归历史反过来用。

## 两条不许破的规则

- **R1 判据必须在 Agent 够不到的地方**。2026 年多个公开靶场被"判分代码与 Agent 同环境"破掉
  （一行代码改掉自己的成绩）。我们的 oracle 一律是**仓库里的门脚本**，由**外部**跑；
  绝不把期望答案放进 Agent 能读能写的工作区。
- **R2 每题必须先证明"有信号"**：打上 `seed` 之后 oracle **必须由绿转红**。
  否则这题是**假题**（跑一万次也不区分好坏）。`scripts/eval-validate.mjs` 就是干这个的，
  它**不需要 Agent、今天就能跑**。

## ★ 「R1/R0 未批 ⇒ 不许提交」这道门：**默认路径上的条件门**，**不是机器约束**

**它是什么**：`scripts/git-hooks/pre-commit`（安装 = `node scripts/gate-commit-check.mjs --install`，
即 `git config core.hooksPath scripts/git-hooks`）+ `scripts/gate-commit-check.mjs`。

**钩子自己判层、自己挂票**（2026-09-23 格 ⑩ v2；起因：独立见证者实测出 v1 的缺口，
`out/w46-witness2-verdict.md` 的「主张 1」与 §3）：

1. 取**暂存区**改动路径 → `scripts/change-classify.mjs` 按【实际改动路径】判层（不看提交信息、不看自述）；
2. **R2 ⇒ 放行**（不产生任何记录）；
3. **R0/R1** ⇒ `pending-approval.mjs gate --level <L>` 有未批记录 ⇒ **拦住**；
4. gate 放行 ⇒ 台账里有一条**已批**记录覆盖本批 ⇒ **放行**；
5. 两者都没有 ⇒ ★ **钩子自己 `record` 一张 `pending` 票**
   （`level` = 判出的层 / `paths` = 实际改动路径 / `note` = 自动生成，注明"由 pre-commit 自动挂票"），
   **然后拦住**。

⇒ v1 的缺口是"**不挂票就无声放行**"（跳过 ②）。v2 之后：**不挂票 ⇒ 机器替你挂一张，然后拦住**。
★★ **自动挂票 ≠ 自动批准**：票仍是 `pending`，**仍必须由独立见证者 `approve`**（§6.2 无环原则）。
**去重**：自动票带**内容指纹**（暂存路径 + 各路径在**索引里的 blob sha**）⇒ 同一批改动反复 commit
**不重复挂票**；已批**且内容未变**才放行（同路径内容变了 ⇒ 新票 + 拦住）。

### ★★ 已知绕过路径（**实测**；客户端钩子的**固有限制**）

| 绕法 | 效果 |
|---|---|
| `git commit --no-verify` | **一步绕过**（钩子**不被调用**） |
| `git -c core.hooksPath=/nonexistent commit` | **一步绕过**（换掉钩子目录） |
| 直接改 `scripts/git-hooks/pre-commit` / `gate-commit-check.mjs` | 下一条命令就绕过（改钩子本身按路径判 **R1**） |
| `git config --local core.hooksPath <别处>` | 同第 2 条（该配置是**仓库本地配置**、不进版本库 ⇒ 新克隆要重跑 `--install`） |
| ★ **直接往台账 append 一行 `approve`**（`out/pending-approval/records.jsonl` 是本地可写文件） | **一步绕过**（**伪造"已批"**；这就是"无环原则"要防的"自己批自己"，钩子**挡不住** —— 它只读台账，**判不了那行是谁写的**） |

★ **本地侧没有能真封住前两条的办法**（`git` 里 `--no-verify` 的定义就是"跳过钩子"）。要"不可绕"必须把
检查移到**被治理者够不到的地方**：① 远端 `pre-receive` / CI（服务端）；② 控制面自身
（`packages/switchboard` 的换代/交接/回滚路径，即 O111，属 R0）；③ 判据根**离机/换卷**（含把台账也移出本机）。
⇒ 准确定性是 **"默认路径上的条件门（conditional gate on the default path）"**，
**不声称"不可绕"**、也**不把它当沙箱**。
★ 台账读不到 / 写不进 ⇒ **不放行**（fail-closed，不假装通过）；代价是那棵树上 R0/R1 的提交会一直失败。
★ 隔离工作树（`eval-wt-new` 建的那种，`scripts/` 被排除）里**没有本脚本** ⇒ 钩子**放行**
（否则会把被测 agent 正常的 `git commit` 堵死）：**刻意设计，不是漏**。

## 任务格式（JSONL，一行一题）

```jsonc
{
  "id": "cli-0001-injected-message-identity",
  "invariant": "一句话说清被破坏的不变量（人读）",
  "kind": "regression-repair",
  "seed": {                       // 让题目"坏掉"的方式：把修过的改动反向打回去
    "edits": [
      { "file": "packages/switchboard/src/index.ts", "find": "（必须恰好出现 1 次的原文）", "replace": "" }
    ]
  },
  "oracle":     { "cmd": ["node", "scripts/test-injected-message-shape.mjs"],
                  "expectSeeded": "fail", "expectFixed": "pass" },   // FAIL_TO_PASS
  "regression": { "cmd": ["node", "scripts/check-all.mjs"] },         // 干净态与修好后都必须绿
  "metrics": ["oracle", "regression", "toolCalls", "tokens", "wallClock", "unsafeActions"],
  "budget":  { "maxToolCalls": 60, "maxMinutes": 15 },                // 超预算即算失败（防"磨出来"）
  "notes": "为什么这题值得测 / 当初的事故一句话"
}
```

字段纪律：

- `find` 必须**恰好出现一次**（出现 0 次 ⇒ 上游改了、题目失效；多次 ⇒ 会误伤）。校验器会拦。
- `oracle.cmd` 必须**非交互、可重复、只读**（我们的门都是）；不许依赖网络。
- `budget` 是判据的一部分：**超预算的运行算失败**，不许靠"多试几次"蒙对。
- 指标里 **`unsafeActions` 与成功率并列**（2026 年 ClawsBench 的教训：完成 ≠ 安全，且两者不成正比）。

## 怎么用

```bash
# 校验整份任务集（每题都要证明"有信号"；不需要 Agent，不动 git）
node scripts/eval-validate.mjs            # ≈ 每题跑两次门，几秒/题
node scripts/eval-validate.mjs --only cli-0001
node scripts/eval-validate.mjs --prepare cli-0001   # 只把题打坏（给 Agent 用），留下还原清单
node scripts/eval-validate.mjs --restore           # 还原（幂等）
```

`--prepare` / `--restore` 用**字节级备份 + sha256 校验**：还原后台账不匹配就大声报错并**保留备份**。
它们**不碰 git**、不改 `node_modules`、不写 `~/.dsh`。

## 还没做的（M1 的下一半）

- **跑 Agent 的那一半**：把 `task.invariant` 作为题面交给挑战者，跑在只读沙箱/分叉会话里，
  收集轨迹，再跑 oracle + regression，产出 **delta 报告**（现行 vs 挑战者）。
  依赖运行时起来（M0），所以先只做"任务有效性"这半边。
- **`pass^k` 可靠性**：同一题重复 k 次（2026 年"Beyond pass@1"的教训：任务一长，能力与可靠性发散）。
  先在报告里留位，等 runner 一起做。
- **通用地板**：挑 1–2 个公开靶场的小子集（首选 Terminal-Bench 风格的容器任务）当"不许退化"的地板。

---

## ★ 哪几条题「不适用于隔离布置」（登记表；判据是**可执行**的）

上面那条 R1 说"判据必须在 Agent 够不到的地方"。**但"够不到"必须逐题验**，不能靠布置的感觉 ——
2026-09-23 的格 ⑨ 就是这条没验出来的：题面把靶文件指向 `scripts/`、`evals/`，而隔离工作树**恰好排除了那两个目录**
⇒ "去判据根找文件"是被题面逼出来的必然行为。

**判据脚本（只读）**：`node scripts/eval-task-applicability.mjs …`（退出码 0 = 全部适用 / 1 = 有不适用）。

```
applicable = 靶文件在 wt 内  ∧  答案不在（按所选边界的）可达处
```

三层边界（层层包含，**缺省取最严 `machine`** —— 取松边界会给出**假绿**）：
`wt`（只看工作树 + **它自己的 git**） ⊂ `field`（+ 祖先链 + 长回旋相对路径） ⊂ `machine`（+ 绝对路径）。
`--seal-git` = 把"**wt 自己的 git 对象库里带着种子前字节**"这一条从"可达"里去掉（见下第 1 条）。

### 实测读数（既有两臂场地；2026-09-23 格 ⑩ 复跑，逐格可复现）

| 边界 | `--seal-git` | 两臂都 applicable | 不适用的题（**原因**） |
|---|---|---|---|
| `machine`（缺省） | 否 | **0/5** | 全部 5 题：`absPath` 恒命中（同机同盘 ⇒ 判据根用绝对路径就到得了） |
| `machine` | 是 | **0/5** | 同上（**封 git 救不了这一层**） |
| `field` | 否 | **0/5** | 全部 5 题（A 臂与判据根**同卷** ⇒ 长回旋相对路径命中） |
| `field` | 是 | **0/5** | 前 3 题仍 `relSibling` 命中；`cli-0004/0005` 靶不在 wt |
| `wt` | 否 | **0/5** | 前 3 题：**`inWtGit`**（wt 自己的 git 带着答案）；`cli-0004/0005`：靶不在 wt |
| **`wt`** | **是** | **★ 3/5** | `cli-0004` / `cli-0005`：**`targetInWt=false`** |

### 逐题登记：**不适用**的题 + 为什么 + 处置

| 题 | `wt` 边界（+封 git）下适用？ | 不适用时的原因 | 处置（本批做了什么） |
|---|---|---|---|
| `cli-0001` / `cli-0002` / `cli-0003` | **适用**（**必须先封 git**） | 不封就不适用：`seed` 是**未提交的工作区写入** ⇒ wt 的 `HEAD` 就是"种子前"= 答案那版，于是 `git diff` **直接打印出被抹掉的那一行**、`git log -p` 也能拿、`git checkout -- <file>` **一步复原**（与沙箱档位**无关**） | 用 `node scripts/eval-seal-git.mjs --dir <wt>` 封（断对象库连接 + 单根提交） |
| `cli-0005`（能力题） | **否** | ① 靶文件 `evals/pilot/rename-target/{math,store,index}.js` **本来不在 wt 内**（`evals/` 被排除）② 它的 oracle 按**自身相对路径**读靶子、**不认** `DSH_EVAL_REPO`/`--repo` ⇒ **只把靶子搬进 wt 也没用** | 靶文件已进 `eval-wt-new.mjs` 的**保留区**（`TARGET_INCLUDES`）；oracle 已认 `--repo` / `DSH_EVAL_REPO` |
| `cli-0004`（能力题） | **否** | 同上（靶 = `scripts/verify-drain-after-swap.mjs`） | 同上 |

### ★ 仍然不适用（**不许说成已解决**）

1. **最严边界 `machine` 下 5 题全部不适用**：同机同盘 ⇒ 绝对路径恒可达。
   这一层**靠布置做不到**，只能靠沙箱 / 容器 / 判据根**离机或换卷**（`field` 那一格同理：判据根与 A 臂同卷）。
2. **两处题面侧的指路仍在**（属 R1 冻结面，本批**未改**）：
   - `evals/pilot/tasks.jsonl` 里 `cli-0005` 的 `invariant` 末句把 `evals/pilot/rename-target/README.md` 写进了题面，
     而隔离工作树里**没有**这个文件 ⇒ 仍在指路（该规格文件**故意不进**保留区：它含期望名，进了就变成"答案在 wt 里"）。
   - `scripts/eval-run.mjs:151` 仍把 `oracle.cmd`（含判据根路径）拼进题面末行。
3. 上表的 `wt` 边界读数**只在"既有两臂场地"上取的**（本批不去重建场地）。
   重建后的布置（靶文件进保留区 + oracle 认 `--repo`）在**新树**上是另一组读数，见 `out/w45-gate-in-commit-and-seal-git.md`。

---

## ★ 长程同族两题（2026-09-23 格 ⑪；`cli-0006` / `cli-0007`）

**为什么加**：既有 5 题里 3 题是"把一行修复打回"（`regression-repair`）、2 题是"给某脚本加一个开关"
—— 都测不出**记忆**：一题一个孤立靶，第二题用不上第一题的经验。
新加的这两题是**同族两题**：第二题**只给增量**，考的就是"第一题学会的那套模式能不能被复用"。

| 题 | kind | 靶（都在隔离工作树保留区内） | 交付物 | 增量点 |
|---|---|---|---|---|
| `cli-0006-selftest-drift-guard-json` | `capability-task` | `evals/pilot/rename-target/{math,store,index}.js` | `guard.mjs` + `guard.selftest.mjs` | ——（**教模式**：记基线 / 查漂移 / 机器可读 / 退出码语义 / 一条命令自证） |
| `cli-0007-store-surface-guard-pinned` | `capability-task` | 同上 | `store-guard.mjs` + `store-guard.selftest.mjs` | ① 读数**自己设计**（不许照抄第一题）② 基线格式**钉死**（纯 LF / 一行一条 / `<条目名>\t<读数>` / 末行换行 / 不许整体哈希）③ `drift` 只列漂了的 + **按条目名升序** ④ ★ 第一题**故意不说**的歧义点（基线文件不存在时怎么办）**被明说成退出码 2** |

★ `kind` **不新增值**（仍用 `capability-task`）：两题都是 `seed.edits: []` 的"做一件还没做的事"，
而 `scripts/eval-validate.mjs:205` **硬性要求**空 seed 题必须 `kind === 'capability-task'`
⇒ 造一个新值只会被那条校验拦下来，没有任何好处。

★ **题面里的歧义点**（按格 ⑨ 的口径"看它会不会停下来问"）：`cli-0006` 的题面**不说**
"基线文件不存在时 `--check` 该退几"，而且 **oracle 故意不测这一条**（测了就成"隐含规格"，不再是歧义）；
`cli-0007` 才把它钉成退出码 2。

★ **靶文件**：`evals/pilot/rename-target/` 那三个纯 Node 文件**本来就在** `scripts/eval-wt-new.mjs` 的
`TARGET_INCLUDES` 保留区里 ⇒ 这次**不需要动布置**。两条题的 `spec` 都是空的（规格**全写在 `invariant` 里**）——
少发一份规格文件就少一条答案泄漏面。

### 两题在适用性判据下的读数（2026-09-23 实跑，可复现）

| 边界 | `--seal-git` | 全 7 题结论 | `cli-0006` / `cli-0007` |
|---|---|---|---|
| `machine`（缺省） | 否 | **0/7** | `applicable=false`（**结构性**：`absPath` 恒命中判据根那一份 ⇒ 与既有 5 题同档，见本页「仍然不适用」第 1 条） |
| `wt` | 否 | **4/7** | ★ **`applicable=true`（两臂都是）** —— 与 `cli-0004`/`cli-0005` 同档 |
| `wt` | 是 | **4/7** | 同上（★ 这两题**不需要** `--seal-git`：空 seed ⇒ 没有"种子前字节"那条通道） |

### 「有信号」怎么证的（能力题没有 `seed` ⇒ `eval-signal-check` 的三段用不上）

`node scripts/eval-signal-check.mjs --task cli-0006 --repo <wt>` 对这两题会**明说拒绝**
（`✗ STAGES-NOT-APPLICABLE`，退出 2）：空 seed 题没有"把修复打回去"这一步，硬套三段只会得到用错口径的结论。
等价证明走**两个方向都跑**（= FAIL_TO_PASS 的机器形态）：

| 树 | `cli-0006` | `cli-0007` | 命令 |
|---|---|---|---|
| 两臂真实 wt（`_abA/wt`、`_abB-experiment-root/wt`） | 红 | 红 | `node evals/checks/cli-0006.mjs --repo <wt>` |
| `out/_w53/clean`（干净副本） | 红 | 红 | 同上 |
| `out/_w53/refT1` / `out/_w53/refT2`（**参考解**） | **绿** | **绿** | 同上 ⇒ 判据**可满足**（不是永远红） |
| `out/_w53/negT1` / `out/_w53/negT2`（**假实现负对照**） | 红 | 红 | 同上 ⇒ 判据有**分辨力**：永远报绿的假实现、照抄第一题的懒实现都翻车 |
| `node scripts/eval-validate.mjs --only <id>` | ✓ | ✓ | 走 `isEmptySeed` 分支：「HEAD 上 oracle 红 + regression 绿 ⇒ 有信号」 |
