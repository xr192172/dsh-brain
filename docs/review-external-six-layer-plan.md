# 外部方案评估：六层"极端拼合"蓝图

> 对象：另一 AI 给出的《极端拼合方案：Agent 基建全栈蓝图》（Layer 0–5）+《Agent 基建全景 2025–2026》
> 评估日期：2026-09-14
> 评估依据：DSH 现有代码事实 + 本项目已实测的三条硬约束（见 `context-cache-efficiency-measurement.md`、`conveyor-postmortem-and-revival.md`）

---

## 0. 结论速览

| 维度 | 评价 |
|---|---|
| **定位** | 它是一份**优秀的技术名词清单**，但**不是一份工程方案** |
| **最大问题** | 全篇 **6 层、20+ 个"新增 packages/xxx"，没有一处回答"凭什么判定某次进化是变好"** —— 而这是自进化的**唯一**根本问题 |
| **最危险的一条** | Layer 5 的 `auto_evolve`：用 `tool-evolution` 的 **LLM 自评分**（`scores.slice(-3).every(s => s < 6)`）触发自动进化 → **这是 reward hacking 的标准入口** |
| **与现有设计冲突** | Layer 0 的"去中心化 pub/sub、不依赖中央控制面"**直接破坏** switchboard 的 `I1 写权唯一` 不变量（lease 是安全机制，不是集中化的包袱） |
| **场景不匹配** | K8s Pod 隔离、Computer Use、SWE-bench 面向的是**云端生产多租户**或**代码提交系统**；DSH 是**本地单机开发 harness** |
| **值得吸收** | 三层记忆（短/中/长期）、Graph RAG、**全局意图网关（propose→approve→apply）**、多维 leaderboard、自适应 key 权重 |

**一句话**：这份方案把"业界有什么"映射成了"我们该新建什么"，**跳过了"我们已经有什么"和"什么在物理上不可行"**这两步。

---

## 1. 逐层事实核对

> 核对标准：**① DSH 是否已有？ ② 场景是否匹配？ ③ 是否与已验证的约束冲突？**

### Layer 0 — Agent Harness

| 方案主张 | 事实核对 | 判定 |
|---|---|---|
| 「UNU Agent Harness 论文 — 租约管理+审计日志+行为隔离」→ 扩展 `lease.ts` | **DSH 已有**：`switchboard/src/lease.ts` 已实现 **单写者 + fencing token + freezeSeq**，`abort` 有 `abort.txt + boot.log tail + pidGone` 三重校验 | **重复造**。它以为是空白 |
| 「K8s 原生部署」→ 新增 `k8s-spawner.ts` | DSH 的 gen 是**本机进程**（switchboard 派生），目标是**本地开发 harness** | **场景不匹配** |
| 「MVVM 架构」→ 新增 `packages/mvvm-agent/` | 概念套用。Model/View/ViewModel 对 LLM Agent 而言**没有对应物**（"View"是什么？工具调用的渲染层本来就有 UI 包） | **无可验证收益** |
| 「去中心化任务分配：Agent 间 pub/sub，**不依赖中央控制面**」 | **与现有设计直接冲突**。`lease` 的存在目的就是**保证写权唯一**（`I1` 不变量）；去掉中央控制面 = 允许双写 = 会话状态可能被两个 gen 同时写 | **⚠️ 危险，会破坏核心不变量** |

### Layer 1 — 编排层

| 方案主张 | 事实核对 | 判定 |
|---|---|---|
| LangGraph-like 图状态机 | **DSH 已有两层**：`dsh-agent-loop`（工具调用主循环）+ switchboard `HandoverStage`（idle→spawn→ready→freeze→promote→flip→verify→retire） | **重复造** |
| AutoGen 多 Agent 角色池 | **DSH 已有** `dsh-tool-subagent`（+ in-process driver） | **重复造** |
| **全局意图网关**（propose→human-approve→apply） | 目前只有 `propose_design_intent`（限 design-canvas） | **✅ 有价值**——但应接到**判据阶梯**（master-plan §5），而不是独立一层 |

### Layer 2 — 工具调度

| 方案主张 | 事实核对 | 判定 |
|---|---|---|
| 工具选择/参数生成/结果解析三层分离 | DSH 的工具注册表 + schema 校验 + `defineTool` 已覆盖 | **重复造** |
| Computer Use 风格 runtime | DSH 已有 `bash` / `pwsh` / `fs` / `str-replace-editor`，本地场景够用 | **场景不匹配** |
| 自适应权重轮询（按成功率调 key 权重） | `key-pool-proxy` 已有轮询 | **✅ 小改进值得做** |

### Layer 3 — 记忆系统

| 方案主张 | 事实核对 | 判定 |
|---|---|---|
| 三元图（时间-语义-关系） | **ai-base 已有对应物**：知识图谱 + `graph_writer` + Leiden 社区 + `KnowledgeEntry`；ConveyorFold 目前确实是线性 | **✅ 有价值**，方向与本项目一致 |
| Graph RAG | ai-base 已有 `DeepRetriever`（向量+关键词 → RRF → Reranker → community diversity） | **✅ 有价值**（图遍历是增量） |
| 三层记忆（短期/中期/长期） | ai-base 的 L0–L4 分层 + SummaryZone 已有雏形 | **✅ 有价值** |

### Layer 4 — 安全沙箱

| 方案主张 | 事实核对 | 判定 |
|---|---|---|
| MVVM 三级权限 | DSH 已有 `guard.ts`（P2 正则拦截 + 白名单）+ `dsh-sandbox-windows-acl` | **重复造** |
| K8s Pod 级隔离 | 同上，场景不匹配 | **过度设计** |
| **Vibe Gate：置信度阈值门控**（低于阈值降级/转人工） | ⚠️ **用 LLM 置信度当判据** = 把判据交给被判定者 | **⚠️ 危险** |

### Layer 5 — 评估与进化

| 方案主张 | 事实核对 | 判定 |
|---|---|---|
| SWE-bench 集成 | 方向对，但 DSH 不是代码提交系统；SWE-bench 需要完整仓库+测试执行环境，成本极高 | **成本/收益不匹配** |
| GitGoodBench | 同上 | 同上 |
| 多维 leaderboard（复杂度×成功率×延迟） | `tool-evolution` 的 `ToolStat` 可扩展 | **✅ 有价值** |
| **`auto_evolve` 全链路自进化** | ⚠️ **最危险的一条**，详见 §2 | **⚠️ 必须重做** |

---

## 2. 最危险的一条：`auto_evolve` 踩在 reward hacking 上

方案给的伪代码：

```ts
async function triggerAutoEvolve(toolName: string, evalData: ToolStat) {
  if (evalData.avgLatencyMs > THRESHOLD || evalData.scores.slice(-3).every(s => s < 6)) {
    const patch = await proposeToolPatch(toolName, evalData)
    const result = await self_evolve({ patch, verify: './scripts/verify-tool' })
    if (result.passed) await tool_apply({ note: `auto-evolve: ${toolName}` })
  }
}
```

**三个致命问题**：

**① `evalData.scores` 是 LLM 自评分。**
我们自己盘过 DSH 的 `tool-evolution`：它通过 `tool_score` 工具收集 **1–10 的模型自评分数**，**没有任何 accept/reject 判据**。
用自评分触发"是否该进化"，等于：
> **让被优化的对象（工具）自己决定要不要被改** —— 它可以通过刷高自评分**避免**被改，也可以反过来刷分**触发**它想要的"进化"。

这正是 ICLR 2026《Your Agent May Misevolve》与我们 master-plan 反复强调的那条：
**判据一旦能被被优化者看见/影响，优化器就会去优化判据，而不是优化能力。**

**② `verify: './scripts/verify-tool'` 是单脚本 `{ok:true}` 门。**
这跟 switchboard 现在的 verify gate 同级——**只回答"能不能跑"，不回答"有没有变好"**。
master-plan §5 已经把它升级为 **L0 机械门 → L1 不变量门 → L2 基线不退化 → L3 隐藏 holdout → L4 反事实对照** 的阶梯，这个方案**完全没有触及**。

**③ "score < 6 连续 3 次就自动改"是 opens-loop 的自我强化。**
它没有**冻结基线**、没有**对照组**、没有**回滚证据链**。改完之后 score 升了还是降了，它无法分辨——因为分数是同一个 LLM 给的。

**⇒ 正确做法**：把 `auto_evolve` 建在 master-plan §5 的判据阶梯上：
- 触发信号用 **可执行判据**（任务完成率、错误率、token 利用率），而不是自评分
- 必过 **L2 逐维度不退化**（对照冻结基线）
- 必过 **L3 隐藏 holdout**（含红队用例）
- 采纳必须带 **`acceptance` + `rollbackPoint` + `blastRadius`** 三件套

---

## 3. 它跳过的三个根本问题

**① "DSH 已经有什么"** —— 它把已有能力当空白，于是 Layer 0/1/2/4 大半是重复造。
（实际已有：lease/fencing、HandoverStage 状态机、subagent、guard + ACL 沙箱、工具注册表、spill-policy、code-mode……）

**② "什么在物理上不可行"** —— 它不知道本项目已实测的三条硬约束：

| 硬约束 | 依据 | 该方案是否遵守 |
|---|---|---|
| **前缀必须稳定**，任何"事后改写 surface"都击穿缓存 | 一次改写 → 后 5 轮命中率 45→82%，均 <93% | ❌ 未提及 |
| **外置化必须在写入时**（append），不能事后 replace | `spill-policy` 对 vs `tool-result-pruner` 错 | ❌ 未提及 |
| **判据必须独立于被优化者** | misevolution 论文 + 我们实测的自评分现状 | ❌ `auto_evolve` 反其道 |

**③ "怎么判定变好了"** —— 全篇 6 层、20+ 新 package，**没有一处回答这个**。
而这是自进化的**唯一**根本问题：**能改不是本事，敢采纳才是。**

---

## 4. 值得吸收的部分（4 条）

1. **全局意图网关**（propose → human-approve → apply）
   - 把 `propose_design_intent` 从 design-canvas 提升为**跨模块**的意图审批
   - **接法**：接进 master-plan §5 的判据阶梯 + §6.1 的 R1/R2 分级（跨出 sandbox 一律人批）

2. **三层记忆**（短期窗口 / 中期折叠 / 长期 kept + 经验图）
   - 与 ai-base 的 L0–L4 分层、SummaryZone 呼应
   - **接法**：与 `conveyor-postmortem-and-revival.md` §5 改进 2（信息保全层）合并做

3. **Graph RAG**（图遍历 + 向量混合检索）
   - ai-base 已有 DeepRetriever（向量+关键词 → RRF → Reranker），增量是**图遍历**
   - **接法**：作为 master-plan §7 假设引擎的检索层

4. **多维 leaderboard**（复杂度×成功率×延迟）
   - `ToolStat` 可直接扩展。**但**必须用可执行指标，不能用自评分

**明确不建议做的**：K8s Pod 隔离（本地场景）、MVVM 抽象（无对应物）、去中心化 pub/sub（破坏写权唯一）、Computer Use（场景不匹配）、SWE-bench 全量集成（成本极高）。

---

## 5. 与本项目 master-plan 的关系

两份文件是**互补但优先级完全相反**的：

| | 六层蓝图 | 本项目 `self-evolution-master-plan.md` |
|---|---|---|
| 起点 | **业界有什么** → 我们要建什么 | **我们缺什么** → 先补判据 |
| 第一优先 | 铺 6 层架构 | **立判据阶梯**（L0–L4 + 能力门/效率面分离） |
| 对"判据"的回答 | **无** | 全篇核心 |
| 对已有资产的处置 | 当作空白，重复造 | 逐条接驳（§9 接驳清单） |
| 风险 | 建起 20 个新包，但 **无法判定任何一次进化是否变好** | 前期只动判据，看起来"进展慢" |

**判断**：
> **它的第 5 层（进化）是空的——而进化恰恰是整个项目的目的。**
> 如果按它铺 6 层，最后会得到一个"什么都能改、但不知道改得对不对"的系统，而这正是 misevolution 论文描述的最坏结局。

**建议采纳方式**：
- **不要**按它的分层去建；**要**按 master-plan 的顺序（判据优先）推进
- 把它的 4 条有价值项作为**候选实现**，挂到 master-plan 对应的卷/节下
- 对它明确标记的"重复造"项（lease/subagent/guard/工具注册表），**在 DSH 侧只需确认现状、补齐缺口**，不新建包

---

## 6. 一句话

**这份方案的广度是真的（业界方案它基本都覆盖到了），但它缺的是"我们"——**
**缺对 DSH 现状的了解，缺对物理约束的敬畏，缺对"怎么判定变好"的回答。**

**它把工程问题当成了名词映射问题。**
