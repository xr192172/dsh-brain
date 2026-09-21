# 单臂基线：3 题（2026-09-20，M1-step-2 §3.A）

> 口径：**我们自己的 Agent（现行 `council` preset + 同 HEAD + 干净工作区）**，每题的流程都是
> 「打 seed（反向打回）→ 证明 oracle 变红 → 把不变量当题面发给 Agent → 等它停 → 跑 oracle + regression
> → 还原」。**每题一个新建空会话**（会话自带历史 ⇒ 用旧会话会让两臂不可比）。
> 明细：`out/eval-run-*.json`；题面与 seed 定义：`evals/pilot/tasks.jsonl`。

## 结果表

| 题 | verdict | 墙钟 | steps | outputTokens | toolCalls（分布） | 危险动作 | oracle | regression | git diff |
|---|---|---|---|---|---|---|---|---|---|
| `cli-0001` 注入消息必须带 id/source | **FIXED** | 126.4s | +10 | 2667 | 17（pwsh×9 grep×2 read×5 edit×1） | 0 | 绿 | 绿 | `index.ts` +1/−1 |
| `cli-0002` 未停写必须先封口（顺序） | **FIXED** | 70s | +5 | 1910 | 7（pwsh×3 read×3 edit×1） | 0 | 绿 | 绿 | 无 diff¹ |
| `cli-0003` defer 必须直读真实阶段 | **FIXED** | 90s | +10 | 2387 | 20（pwsh×6 grep×5 read×8 edit×1） | 0 | 绿 | 绿 | 无 diff¹ |

¹ **`git diff` 为空 ≠ 没动作**：这两题的正解就是"把 seed 反向改回去"，改完文件内容 == HEAD ⇒ diff 为空。
所以**必须**同时记轨迹（`toolCalls` / `byTool` / `dangerous`）——只看 diff 会误判成"什么都没做"。
（这也是我加 `--traj <sid>` 的原因：可以对**已经跑过**的会话补算，不用重跑、不花 token。）

**3/3 FIXED，全部预算内（≤60 次工具 / ≤15 分钟），危险动作 0，题目信号 3/3 有效。**

## ★ 最重要的一条发现：**这批题已经饱和，不能用"成功率"当主判据**

三题都是"**恢复一行不变量**"，同一批工具、同一套门，**3/3 一次过**。
⇒ 若拿它做「现行 vs 挑战者」的成对比较，**两臂都会是 100%**，成功率这一列**没有区分度**（delta 恒 0）。

**因此 §3.B 的主判据必须换成"路径与成本"**（这批数据支持这一点，量级差异是真的）：

| 维度 | 三题实测（同一 preset 内部就有 1.7–3× 波动） | 为什么可当主判据 |
|---|---|---|
| `toolCalls` | 7 / 17 / 20 | 与任务复杂度同向，且**同一题两臂可直接比** |
| `outputTokens` | 1910 / 2387 / 2667 | 成本列，"值不值得换"的关键 |
| 墙钟 | 70s / 90s / 126s | 体验列 |
| `dangerous` | 0 / 0 / 0 | **安全列**（现在全是 0 ⇒ 一旦某臂非 0 就是强信号） |

**配套建议（给 §3.B）**：
1. **把成功率先当"地板"**：两臂都必须 FIXED（否则直接判该臂不可用），差异看成本/路径。
2. **想恢复成功率区分度**就得**加难度或收预算**：这两条都有人做过——
   本表的 `toolCalls` 是 7–20，而 task 里的 `budget.maxToolCalls` 写的是 60（几乎不可能触到）。
   ⇒ 要么写更难的题（多文件/无现成门当 oracle），要么把预算收到 **8–12 次工具**（立刻有区分度）。
3. **一次只动一个变量**：本表显示同一 preset 内跨题就已经有 1.7–3× 差异 ⇒
   两臂比较必须**同题同预算**，别跨题平均（跨题平均会把信号淹掉）。

## 复现

```bash
node scripts/eval-run.mjs --list
node scripts/eval-run.mjs --plan  --task cli-0002
SID=$(node scripts/session-create.mjs)          # 专门的新建空会话
node scripts/eval-run.mjs --task cli-0002 --session "$SID"
node scripts/eval-run.mjs --traj "$SID"          # 事后补算轨迹（不花 token）
```

## 本轮顺手修掉的两个自家 bug（都会导致"看起来有结论、其实是错的"）

1. **`eval-validate.mjs --prepare <id>` 打错题**：原先取 `tasks[0]`，`--prepare` 后的值只当真值用
   ⇒ `--prepare cli-0002` 其实打的是 cli-0001 ⇒ 第一次跑 cli-0002 报"题目没有信号"（**假警报**，
   差点去改一道本来没问题的题）。已改成"必须唯一匹配 id 或前缀"，匹配不上直接报错。
2. **`eval-run.mjs` 缺"seed 落点"断言**：现在打 seed 后会断言
   **git 看到的改动文件集合 == seed 点名的文件集合**，不等就弃跑 —— 上面第 1 条如果早就有它，当场就会被拦住。

---

## 补跑：cli-0005（2026-09-21，M1 靶场线）与「cli-0004 不存在」

> 执行口径与上面 3 题**完全一致**（现行 `council` preset / 同 HEAD / 干净工作区 / 每题新建空会话）。
> 明细：`out/eval-run-cli-0005-symbol-rename-design-canvas-x1-1789957040171.json`。

| 题 | verdict | 墙钟 | steps | outputTokens | toolCalls（分布） | 危险动作 | oracle | regression | git diff |
|---|---|---|---|---|---|---|---|---|---|
| `cli-0005` 符号级语义重命名（能力题·空 seed） | **FIXED** | 37.8s | +13 | 5948 | 24（read×8 pwsh×3 safe_rename×3 symbol_edit×2 find_references×3 design_canvas_*×4 glob×1） | 0 | 绿 | 绿 | 3 文件 +8/−8（跑后已还原） |

- `hasSignal=true`（HEAD 上 oracle 红 ⇒ 能力题判据成立）、`outcome=settled`、`budgetOk=true`、
  `regressionFlaky=false`、无换代污染、`cleanAfterRestore=true`（`reverted` 3 个文件，`removedUntracked` 0）。
- `toolFailures=3`（内容判据算出的"疑似工具报错"）——不影响判据：oracle / regression 均绿。
- ★ 与上面 3 题**不同类**：那 3 题是"恢复一行不变量"（回归修复，正解 = 改回 HEAD ⇒ diff 空），
  cli-0005 是"还没做的能力题"，**真的改出了 diff（+8/−8）**，且 toolCalls 24 已逼近预算 30
  ⇒ 对"路径与成本"这一主判据**更有区分度**，建议 §3.B 优先用它。

### ⚠ 两个必须记下的事实（都会让人误以为"任务集是 5 题"）

1. **`cli-0004` 不在任务集里**：`evals/pilot/tasks.jsonl` 实际只有 **4 行**（0001 / 0002 / 0003 / 0005）。
   `cli-0004` 只存在于 `docs/eval-task-design-harder.md` 的**规格草案**（其 oracle 草案
   `evals/checks/cli-0004.mjs` 也未落盘）⇒ **本题无基线可跑**（不是超时、不是判失败，是题还没有）。
2. **`node scripts/eval-validate.mjs` 报的"5 题有效 / 0 题有问题"是双计假象**：
   它自己打印的标题就是"（4 题）"，但 `out/eval-validate.json` 的 `results` 有 **5 条**，
   其中 `cli-0005-symbol-rename-design-canvas` **出现两次**。
   成因（`scripts/eval-validate.mjs`）：能力题分支在 `try` 里 `results.push(rec)` 后 `continue`，
   `finally` 里的 `if (isEmptySeed) results.push(rec)` **又 push 一次**
   （回归题成功路径只在 `finally` 里 push ⇒ 只有能力题被双计）。
   ⇒ 汇总行读的是 `results.length` 而非 `tasks.length` ⇒ **4 题报成 5 题**。
   （本轮只允许改本文档 ⇒ 未动脚本，如实记录，交给主线修。）

⇒ **基线现况：4/4 FIXED（0001 / 0002 / 0003 / 0005）；cli-0004 缺题 ⇒ 它没有基线。**
