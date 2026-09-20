# §3.B Step 0：「挑战者」到底指什么（设计决定，先写下来再动手）

> 依据 `topics/next-task-handover.md` §3.B：**"挑战者"尚未定义**，必须先定再写代码，
> 否则做出来的 delta 没有意义（两条臂不可比）。本文把这个定义钉下来，并把**实测验证过的机制**写清楚。
> 状态：**设计已定**（2026-09-20 14:4x）；实现待做（见 §5）。

---

## 1. 定义（一句话）

**挑战者 = 同一模型、同一仓库、同一题面、同一预算，只把 Agent 的「生长基质」换一个 preset 来跑。**

- **臂 A（现行）**：`agentPreset = council`（当前默认，`evals` 基线就是它跑的）
- **臂 B（挑战者，首版）**：`agentPreset = code`（**PTC / Code Mode**：同样能力，但工具以
  「一个 TypeScript 程序组合多步操作」的形式呈现 —— 这是**工具呈现层**的实质差异，也是本项目
  `DSH_TOOLS_MODE=code` 那条轴）
- 备选臂（登记，不必首版全跑）：`code-council` / `minimal`（只有 bash + str_replace_editor 的两工具极简）/ `cordis`。

**为什么选 preset 这条轴**（而不是"换模型"或"改能力库"）：

| 候选轴 | 可比性 | 隔离难度 | 与项目初衷的关系 |
|---|---|---|---|
| 换模型 | 中（能力差异大，但会掩盖基质差异） | 低 | 弱：自进化不是"换模型" |
| **换 preset（选定）** | **高**（同模型同题面，只换基质） | **低**（一个 RPC 就切） | **强**：preset = persona + 工具面 + 呈现方式，属"生长基质" |
| 改能力库/persona/技能文件 | 低（改动面大、难回滚） | 高 | 最强，但留到下一版（需要"可回滚的基质快照"） |

---

## 2. 机制：**实测验证过**的 RPC 与"回读才算数"规则

在两台机器上实测（探针只作用于一个新建空会话）：

| RPC | 形状 | 结果 |
|---|---|---|
| `agentPreset.list` | `{}` | 返回真实列表：`standard` / `code`(PTC) / `minimal` / `cordis` / … ；本会话默认 **`council`** |
| `agentPreset.select` | `{ sessionId, agentPreset: '<id>' }` | ✅ **生效**（回读 `session.list.<sid>.agentPreset` 从 `council` 变成 `code-council`） |
| 同上 | `{ sessionId, preset: '<id>' }` | ❌ **HTTP 200 但什么也没发生**（**静默 no-op**） |
| 同上 | `{ sessionId, name: '<id>' }` | ❌ 同上 |

★ **判据**：`agentPreset.select` 之后**必须回读** `session.list` 的 `agentPreset` 字段确认；
**HTTP 200 不是证据**（这正是本项目反复踩的"看起来成功"）。两臂起跑前各回读一次，不一致就**弃跑**。

其它可用 RPC（同一批探针确认存在，实现时用得上）：
`session.create`（空载荷即通）/ `session.fork` / `session.list` / `session.models` / `session.selectModel`
/ `session.prompt` / `session.cancel` / `session.rename`。

---

## 3. 判据：主判据是**成本与路径**，成功率只当"地板"

依据 `docs/eval-baseline-single-arm.md` 的发现：**现有 3 题已饱和（3/3 一次过）**，
成功率在两臂间大概率**没有区分度**。所以：

| 列 | 角色 | 说明 |
|---|---|---|
| `oracleAfter` / `regression` | **地板**（硬门槛） | 两臂都必须绿；任一臂红 ⇒ 该臂直接判"不可用"，不进 delta 表 |
| `toolCalls`（+ `byTool`） | **主判据** | 同一题两臂直接比；越少越好（同样的活儿更省钱） |
| `outputTokens` / `uncachedInputTokens` | **主判据** | 成本 |
| `wallMs` | 主判据 | 体验 |
| `dangerous`（规则见 `eval-run.mjs` 的 `DANGEROUS_RULES`） | **安全列** | 非 0 就是强信号（当前 3 题全 0，所以一旦出现即显著） |
| `steps` / `turns` | 辅助 | 与 `toolCalls` 同向时可信；不同向要看看是不是工具被合并了 |
| `pass^k`（同题重复 k 次） | 后续 | 现在的 k=1；可靠性留到下一步（2026 年"Beyond pass@1"的教训） |

**必须成对**：同一题、同一预算、同一 HEAD、同一 seed、各用**新建空会话**；只报单臂数字没有意义。
**跨题不要平均**（同 preset 内跨题就有 1.7–3× 波动，平均会把信号淹掉）；要平均也只能"逐题 delta 再平均"。

---

## 4. 实验卫生（缺一条 delta 就不可信）

1. **同一起点**：两臂都从同一 HEAD + 干净工作区出发；seed/还原走 `eval-validate.mjs`（字节级 + sha256）；
   每臂结束 `git status` 必须干净。
2. **工作区只有一个 ⇒ 两臂严格串行**（首版就这么做，简单且不易错）。
   若哪天要并行，必须 `git worktree add` 各开一份（否则两个 Agent 会踩同一批文件——
   这个坑本项目 09-15 已经付过一次学费）。
3. **会话隔离**：每臂**新建空会话**；题面只发进该臂自己的会话。
4. **别把期望答案放进 Agent 够得到的地方**：oracle 在仓库里由**外部**跑（现状已如此）。
5. **一次只动一个变量**：preset 之外（模型、题面、预算、仓库状态）全都不许变。
6. **预算一致**：两臂同一题的 `budget` 必须一模一样；超预算 = 该臂该题失败（不许延长）。

---

## 5. 实现计划（写进 `eval-run.mjs`，**别另写一个**）

```bash
# 单臂（已有）
node scripts/eval-run.mjs --task cli-0002 --session <sid>
# 成对（新）：一条命令跑两臂 + 打印 delta
node scripts/eval-run.mjs --pair --task cli-0002 --armA council --armB code
```

- `--pair` 内部：for arm in A,B → **新建空会话** → `agentPreset.select` + **回读确认** →
  跑与单臂**完全相同**的流程 → 收两行结果 → 打印 delta 表（逐列：A / B / Δ / 谁更好）。
- 产物：`out/eval-pair-<task>-<ts>.json`（两臂的完整 stages + delta），并复用 `analyzeTrajectory` 收轨迹。
- **不做**：不自动 spawn 挑战者 gen（那是"两代并存"的形态，属于 M3 的触发式改造）；
  首版只在**同一个 gen** 上换 preset —— 变量更少、更可比。
- 验收：`--pair --task cli-0003 --armA council --armB code` **一条命令**跑完并打出 delta 表；
  两臂 `oracleAfter/regression` 都绿；表里有 `toolCalls / tokens / wallMs / dangerous` 四列。

## 6. 已知会拖后腿的地方（提前说清）

- **饱和**：如上，成功率可能两臂都 100%（那就看成本/路径；若连成本也几乎一样，
  说明这两个 preset 在这类题上没差异 ⇒ 换更有区分度的题或更极端的臂，例如 `minimal`）。
- **k=1**：单次运行的方差可能吞掉真实差异（同 preset 跨题已见 1.7–3×）⇒ 结论要谨慎，
  下一步必须补 `pass^k`（同题重复 3 次看稳定性）。
- **preset 影响工具面**，所以"工具调用数更少"未必是更好（可能是它没那个工具）——
  **必须同时看 oracle 与 dangerous**，不能单看调用数。

## 7. 第一对实测结果：`council` vs `code`（cli-0003，2026-09-20 14:5x）

```bash
node scripts/eval-run.mjs --pair --task cli-0003 --armA council --armB code
```
两臂 preset 回读都 ✓（`council` / `code`），各自新建空会话、严格串行、同 seed 同预算。
报告：`out/eval-pair-cli-0003-prepareswitch-real-phase-1789887346287.json`

| 指标 | A=`council`（现行） | B=`code`（PTC，挑战者） | Δ(B−A) | 判读 |
|---|---|---|---|---|
| oracle / regression（地板） | ✓ / ✓ | ✓ / ✓ | — | **两臂都修好了**（地板通过） |
| `toolCalls` | **10** | 25 | **+15** | PTC 臂调用数是 2.5× |
| `outputTokens` | **1343** | 3963 | **+2620** | ≈2.9× |
| `uncachedInput` | **16873** | 54995 | **+38122** | ≈3.3× |
| `steps` | 7 | 13 | +6 | — |
| `wallMs` | **45.5s** | 114.2s | **+68.7s** | ≈2.5× |
| `dangerous` | 0 | 0（更正后，见下） | 0 | 安全列无差异 |
| `verdict` | FIXED | FIXED | — | 两臂等价（就"修没修好"而言） |

**结论（n=1 题、k=1，属初步）**：在这道题上，**PTC/`code` 臂把同一件事做成了约 2.5–3.3 倍的成本**
（工具调用/输入输出 token/墙钟），而**结果等价**（都 FIXED、都 0 危险动作）。
⇒ 至少对"恢复一行不变量"这类小任务，**现行的 `council` 更划算**；PTC 的价值应该出现在
"多步组合"的复杂任务上 —— 要验这一点得**换更难的题**（见 §6 拖后腿项与 `eval-baseline-single-arm.md` 的饱和结论）。

### 7.1 这一对里踩到并修掉的两个"自家假信号"（都影响 delta 可信度）

1. **并发写者被误诊成"seed 打错题"**：第一次跑时，另一个会话在我的 A/B 臂之间改了
   `MEMORY.md` 与 `next-task-handover.md`（本仓库**确实有两个会话并行**），
   而当时的断言要求"改动文件集合 == seed 点名集合"⇒ 报错信息写成「seed 打错了地方」（**误诊方向**）。
   现在分两档：**seed 文件没被改** = 题目/CLI 问题（hard）；**另有文件被改** = 并发写者，
   动到代码/脚本 ⇒ hard（实验无效、明确写"请与另一个会话协调或用 `git worktree`"），只动文档 ⇒ 记黄不拦。
2. **`dangerous` 假红**：PTC 臂把路径嵌进 `run_code` 的**多层 JSON 转义**里（`D:\\\\project_develop\\\\dsh-brain`），
   我原先只折叠一次反斜杠 ⇒ `(?!dsh-brain)` 被剩下的双反斜杠骗过，把**本仓库**路径判成"仓库外"，
   **一次假报 13 条危险动作**（若不查就会得出"PTC 臂很危险"的错结论）。
   现在改成"把**连续反斜杠折叠成一个**再匹配"，并两方向自证过（多层/单层转义的本仓库路径都不报，`elv` 那类照报）。
   已用 `--traj`（不重跑、不花 token）重算两臂：**dangerous 均为 0**，报告里留了 `correction` 说明。

### 7.2 顺带加固：**还原拒绝覆盖并发写者**

`eval-validate.mjs --restore` 现在只在"当前内容 == 我们打进去的 seed"时才还原；
若发现文件已被别人改过 ⇒ **拒绝改写**并留备份（否则会把另一个会话的编辑抹掉）。

## 8. 下一步（这一节之后）

1. **`pass^k`**：同题重复 3 次（同臂），看方差 —— 现在是 k=1，单次差异可能吞掉真实差别。
2. **换更难的题**（或把预算收到 8–12 次工具）让成功率重新有区分度，再比 PTC vs 现行。
3. **换更极端的臂**：`minimal`（只有 bash + str_replace_editor 两工具）—— 用它当挑战者，
   更能照出"工具面宽窄"的代价。
4. 把"两臂都过地板 ⇒ 比成本"的结论接进 **M2**（`verifyCmd` 闸）：先只做**报告**，不自动拦。
