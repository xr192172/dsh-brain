# 更难的题：设计草案 + 一个必须先解决的有效性威胁（2026-09-20 15:3x）

> 背景：`docs/eval-baseline-single-arm.md` 已证明**现有 3 题饱和**（单臂 3/3 一次过），
> `docs/eval-challenger-arm.md` §9 给出同臂噪声基线（toolCalls ±15%、outputTokens ±11%、wallMs ±9%）。
> 要让"成功率"重新有区分度，必须**加难度**。本文先写清**加难度会踩到的坑**，再给两道候选题。
> 状态：**草案**（等 §3.D 的 `council vs minimal` 结果出来后落地到 `evals/`）。

---

## 1. ★ 先解决有效性威胁：**种子题可以被 `git checkout` 秒解**

现有 3 题的 seed 都是"把**已提交的修复**反向打回去"⇒ 修好的版本**就在 `HEAD` 里**。
于是存在一条**零理解的捷径**：`git diff HEAD` 看一眼 → `git checkout -- <file>` 还原 → oracle 变绿。

- 实测两份轨迹（cli-0002 / cli-0003）**没有**走这条路（它们是 `read`+`edit` 真改的），
  但**一个会省钱的 Agent 迟早会学会这条路**，那时这批题就彻底失去区分度。
- 现有的应对只有"**标注**"：`DANGEROUS_RULES` 里的 `discard-worktree`
  （`git reset --hard|clean|checkout --|restore`）会把它记成"危险动作"。
  ⇒ **标注 ≠ 阻止**：它只让报告里多一行，题目本身照样被秒解。

**结论：加难度必须同时换题型。** 新题型的判据是：
> **`HEAD` 里不存在正确答案** —— 让 `git checkout` 帮不上忙。

三种可行形态（按实现成本排序）：

| 形态 | 做法 | `git checkout` 能救吗 | 例 |
|---|---|---|---|
| **A. 缺失功能 + 机器可验的规格**（**首选**） | 让 Agent 实现一个 HEAD 里**没有**的能力；oracle 是**跑一遍**看行为 | ❌ 救不了（HEAD 里没这段代码） | `verify-drain-after-swap.mjs` 加 `--json` 输出 |
| B. 全新缺陷（新文件/新函数） | 播一个"从未在 HEAD 里存在过"的缺陷 | ❌ 救不了（文件/函数不存在） | 新增一个判断函数，逻辑故意写错 |
| C. 加固/边界（写新断言） | 要求补一条 HEAD 里没有的防护 | ❌（要写新逻辑） | "flushFailed 非空时必须落盘原因串" |

**注意**：形态 A 的 oracle 必须**能真的跑起来并观察行为**（不能靠读源码）——
这与本项目的"判据只跑真证据、不读源码"是同一条纪律。

---

## 2. 候选题 cli-0004：给验收脚本加 `--json`（形态 A）

**不变量 / 规格**（题面）：

> `scripts/verify-drain-after-swap.mjs` 目前只打印人读文本。请让它支持 `--json`：
> ① 加上 `--json` 时，**stdout 只输出一个 JSON 对象**（其余诊断走 stderr），
> ② 对象里每条判据一个键（`R0a…R9b`，与现有判据同名），值为 `{ "status": "ok" | "warn" | "fail", "detail": "<一句话>" }`，
> ③ 另含 `{ "ok": <bool>, "fails": <number> }` 汇总，
> ④ **不带 `--json` 时的输出与退出码必须一字不变**（不许为了加功能改行为），
> ⑤ 退出码语义保持不变（0=通过 / 1=换代了没生效 / 2=还没到能验收的状态）。

**为什么它是一道好题**：
- **无 git 捷径**（`--json` 在 HEAD 里不存在）✓
- **多步 + 真实约束**：要读现有 400 行脚本、抽出判据、把诊断改道 stderr、
  还要**保住旧行为**（回归约束 = 我们自己的 `--selftest` 两方向自证）✓
- **机器可验**：oracle 直接跑它、解析 JSON、再跑一次不带 `--json` 比对旧输出 ✓

**oracle 草案**（新文件 `evals/checks/cli-0004.mjs`，由 harness 在"Agent 停手后"执行）：
1. `node scripts/verify-drain-after-swap.mjs --selftest` 必须仍 **0 退出**（旧行为没坏）；
2. `node scripts/verify-drain-after-swap.mjs --json` 的 **stdout 必须能 `JSON.parse`**（且 stderr 允许有内容）；
3. 对象里**必须**同时含 `R0a/R0b/R0c/R1..R9b` 这些键，且每项有 `status` ∈ {ok,warn,fail} 与 `detail`；
4. **含** `ok`(bool) 与 `fails`(number)，且 `fails` 与实际 `status==='fail'` 的条数一致；
5. 回读"不带 `--json` 的输出"：与改造前的快照**判据行集合一致**（防止为了加功能顺手改了文本判据）。

**预算**：`maxMinutes 15`、`maxToolCalls 30`（比前三题宽——它真的要写代码）。

## 3. 候选题 cli-0005：给 drain 加一条新判据（形态 C）

> `flushFailed` 非空时，`quiesced` 必须为 `false`，且**原因串要出现在流水/诊断里**
> （现在只有 `flushFailed=[…]` 这个数组）。要求：新增 `unflushed: true|false` 字段并写进
> `resume.jsonl` 的 drain 轨迹；`test-handover-drain.mjs` 的 A 段新增一例覆盖它。

- 优点：真实（这是我们自己欠的债）；缺点：判据由**我们自己**写，容易"照着实现写断言"⇒
  落题时**必须先证明"不打 seed 就会红"**（`eval:validate` 的第二关），否则就是**假题**。

---

## 4. 落地顺序（等 §3.D 的 minimal 结果后）

1. 先落 **cli-0004**（形态 A，无 git 捷径）——这是"让成功率有区分度"的关键一步；
2. 用 `eval-validate.mjs` 证明它**打 seed 后 oracle 变红**；注意本题的 seed 是"删掉 `--json` 支持"
   ⇒ 形状上仍是反向打回，但**因为 HEAD 里也没有**，所以 `git checkout` 救不了；
   （若发现 HEAD 里有，就说明我记错了 —— 那就改用形态 B 新写一段。）
3. 用 `--pair --task cli-0004 --armA council --armB minimal --repeat 3` 复验：**成功率是否真的分化**；
4. 只有成功率分化了，才谈把结论接进 **M2**。
