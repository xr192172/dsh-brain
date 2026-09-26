# 自开发第一棒 报告

## 1. 简报四段

### 一、文档在哪（docs 段）

| id | 路径 | 字节 | 为什么读 |
|---|---|---|---|
| handover | `.workbuddy/memory/topics/next-task-handover.md` | 33941 | ★ 接手先读 |
| memory-index | `.workbuddy/memory/MEMORY.md` | 20614 | ★ 每次都要遵守 |
| lessons | `.workbuddy/memory/topics/lessons-learned.md` | 83384 | 实证细节 |
| architecture | `docs/revised-architecture-2026-09-20.md` | 29829 | 当前架构权威记录 |
| skill-as-agent | `docs/skill-as-agent-spec.md` | 282535 | ★ 子 Agent 施工规格 |
| training-ground | `docs/training-ground-and-skill-sieve-2026-09-25.md` | 45119 | ★ 训练场 + Agent 工厂 |
| gaps | `docs/self-evolution-gap-analysis.md` | 15324 | 缺口清单 G1–G8 |
| where-we-are | `docs/where-we-are.md` | 4088 | 给用户看的一页 |
| ledger | `docs/main-chain-ledger.md` | 13758 | 主线账本 |
| entry-docs | `docs/ideas-spec.md` / `docs/handover-vs-restart.md` / `docs/oss-prior-art-and-next-steps.md` | — | 改架构前先读 |

### 二、题在哪（tasks 段）

- 目录：`evals/tasks/`，共 **3** 道
  - `t1-guard` ⇒ `evals/tasks/t1-guard/task.md`
  - `t2-scriptlang` ⇒ `evals/tasks/t2-scriptlang/task.md`
  - `t3-tooldef` ⇒ `evals/tasks/t3-tooldef/task.md`

### 三、手在哪（tools 段）

核心 8 条（有 role）+ 157 条无 role 脚本由扫描自动发现：
- `node scripts/task-bank.mjs list` —— 列题库（agent-agnostic）
- `node scripts/task-bank.mjs show <题id>` —— 看一道题的题面 + 判据口径
- `node scripts/task-bank.mjs verdict <题id>` —— 该题的重放轨迹 + 报警数
- `node scripts/arm-up.mjs <臂名>` —— ★ 另起一代（自己的 DSH_HOME + 端口，**不 flip**）
- `node scripts/run-experiment.mjs <题id> --arm <臂名>` —— ★ 闭环：取题→起一代→发题→收卷→判定
- `node scripts/skill-sieve.mjs --in <skill_tree.json>` —— 筛
- `node scripts/skill-factory.mjs --in <skill_tree.json>` —— 工厂
- `node scripts/check-all.mjs` —— 常驻守卫总入口

### 四、管理面（mgmt 段）

- 现役臂：**A**，管理面：`http://127.0.0.1:31800`
- `tasks` ⇒ `http://127.0.0.1:31800/?cmd=mgmt&action=tasks`
- `verdict` ⇒ `http://127.0.0.1:31800/?cmd=mgmt&action=verdict&task=<题id>`
- `experiment` ⇒ `http://127.0.0.1:31800/?cmd=mgmt&action=experiment&task=<题id>&arm=A`
- `result` ⇒ `http://127.0.0.1:31800/?cmd=mgmt&action=result&runId=<runId>`
- `brief` ⇒ `http://127.0.0.1:31800/?cmd=mgmt&action=brief`

## 2. 三条铁律

### 铁律 #10：同文件并行 Edit 会静默丢改动
- **约束**：同一文件两次 Edit 必须串行执行。
- **防的事故**：两个 Edit 都报 success，但后一次基于旧快照覆盖，静默丢前一次改动。
- **我的遵守**：本次只修改 `scripts/self-dev-brief.mjs` 一个文件，所有 edit 操作串行执行。

### 铁律 #21：消融自证
- **约束**：判据要证明"修复真的在起作用"，必须用消融自证——撤掉修复，判据必须变红。
- **防的事故**：假判据（测试永远绿，实际无任何防护作用）。
- **我的遵守**：新增判据 ⑩（清空 role map → role 全空）和 ⑪b（扫描空目录 → tools=[]），都是消融自证。

### 铁律 #11：判据与信号不可混
- **约束**：裸满意度评分丢弃；未实施的判据级不计通过；见假红先证判据错再改判据。
- **我的遵守**：所有验收都基于真实命令输出，没有"看起来应该对"的主观判断。

## 3. 我选了什么、为什么

**选择：候选 A**（让 `TOOL_SPEC` 动态扫描替代硬编码手抄清单）。

**理由**：
1. 风险最低：只动 `scripts/self-dev-brief.mjs`
2. 问题真实存在：仓库有 165 个 `.mjs` 脚本，简报只硬编码 8 条，其余 157 条完全不可见
3. 与现有 docs 段"missing 显形"纪律对称
4. 消融自证容易构造

**不选 B**：需要深入理解全部行为路径，不确定性高。
**不选 C**：涉及架构决策，且任务书明确说"如实说明不做是合格交付"。

## 4. 复现（动手前）

```bash
node scripts/self-dev-brief.mjs --selftest
```
输出（改前）：
```
ok    ①~⑨ 全部通过
结果：判据 9/9 ⇒ PASS
```
但 `renderBrief(b)` 只有 **2895 字符**（8 条工具），而仓库实际有 **165 个** `.mjs` 脚本。删除任何一条硬编码脚本，旧判据全部仍 PASS——手抄清单静默过期，没有任何告警。

## 5. 修复（动手后）

替换 `TOOL_SPEC` 为动态扫描机制：
- 新增 `scanActualTools(wt)` 扫描 `scripts/*.mjs`
- 新增 `makeTools(actualTools, wt)` 派生 tools 段
- 新增 `TOOL_ROLE_MAP` 作为 role seed
- `buildBrief` 对每条 tool 检查 cmd 路径存在性，缺的标 `missing: true`
- 新增判据 ⑩、⑪、⑪b（共 +3 条）

修复后 `renderBrief` 从 2895 → **10749 字符**。

## 6. 消融自证

### 判据 ⑩
- 操作：清空 `TOOL_ROLE_MAP`
- 预期：所有 tool.role = `''`
- 实测：`165/165 条` ✓

### 判据 ⑪b
- 操作：扫描空临时目录
- 预期：`tools.length === 0`
- 实测：`tools.length=0` ✓（证明 tools 来自扫描而非手抄）

### 模拟脚本删除
若删除 `scripts/task-bank.mjs`，新 `buildBrief` 扫描后 `task-bank` 将标 `missing: true`，而旧实现（硬编码）对此毫无感知。

## 7. 自测与检查

### 7.1 selftest（必须 PASS）
```
ok    ① 简报产出且文档全在 — missing=0
ok    ② 报出来的文档路径全部真实存在 — 12 份已核实存在
ok    ③ ★ 把 handover 标成 missing ⇒ 必须显形 — .workbuddy/memory/topics/next-task-handover.md
ok    ④ ★ 管理面 URL 随臂派生（不是手抄） — A=http://127.0.0.1:33180 B=http://127.0.0.1:33220
ok    ⑤ 题库列出的题面路径真实存在 — 3 道题
ok    ⑥ 简报只报题面路径（不搬内容、不带"谁"） — {"id":"t1-guard","taskMd":"evals/tasks/t1-guard/task.md"}
ok    ⑦ 渲染含四段（文档/题/手/管理面） — 10749 字符
ok    ⑧ 消融：撤掉 missing 显形 ⇒ ③ 变红 — 撤掉后 missing 计数=0
ok    ⑨ 消融：端口写死 ⇒ ④ 变红 — 写死即失去派生
ok    ⑩ 消融：清空 role map ⇒ 所有 cmd role 必须为空字符串 — 165/165 条
ok    ⑪ 消融：假脚本名必须显形 missing — missing=true 是预期行为
ok    ⑪b 扫描空目录 ⇒ tools=[]（证明工具来自扫描而非手抄） — tools.length=0

结果：判据 12/12 ⇒ PASS
```

### 7.2 `node --check scripts/self-dev-brief.mjs`
```
exit=0（成功）
```

### 7.3 `git diff --stat`
`scripts/self-dev-brief.mjs` 是 **untracked 新建文件**，git diff 不显示改动统计。
仓库其他文件的修改均非本次任务产生。

## 8. 我可能错在哪

**最不确定点**：`scanActualTools` 扫描了全部 165 个 `.mjs` 脚本，包括测试/探针/一次性脚本（`test-*.mjs`、`probe-*.mjs`、`w61-*.mjs`）。简报的"手在哪"段现在列出了 165 条，其中只有 6 条有 role，其余 159 条 role 为空字符串（显形"未写 role"）。

**风险**：agent 拿到这份简报，"手在哪"段有 165 条，噪音太大，可能浪费 token 读无意义 entry。

**如何验证**：读用户设计意图——如果意图是"只暴露核心工作流脚本"，则需要加白名单过滤；如果意图是"全量暴露供 agent 按需发现"，则 165 条是正确的。

**当前妥协**：有 role 的 6 条作为核心工具，其余 159 条空 role 显形"未写 role"，agent 可通过 role 非空过滤。
