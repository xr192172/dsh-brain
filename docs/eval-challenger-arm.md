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
