# ai-base → dsh-brain 资产对账（2026-09-21）

> **本文件是「资产对账」，不是搬运。** 只读 `D:\project_develop\ai-base` 与 `D:\project_develop\dsh-brain`，
> 不改任何既有文件，不提交 git。
>
> 触发（用户）：「AI base 这边的资产还是没有完全继承过去是吗？需不需要重新整理一遍这里的资产和 DSH brain。」
>
> **判定四档**（互斥，按定义从严）：
> - **已继承** = dsh-brain 有**落点文件**且**读过其内容**确认真在了；
> - **部分继承** = 有落点但只覆盖该资产的**一部分**，或只落成「已盘点/已规划」而未实现；
> - **未继承** = 无落点，且**没有更新的设计取代它**（仍有价值，只是没做）；
> - **已过时** = 被更新的设计取代 / 文档自标弃用 / 其宿主形态在我们的栈里已不存在。
>
> **证据级别**：`原文读过`（能引到行）/ `只看标题`（读了文件与节标题，未逐节读）/ `推断`。

---

## §1 对账表

### 1.1 P0 —— 与当前主线直接相关（逐份读原文）

| 资产（路径） | 它讲什么（≤15 字） | 行数 | 判定 | 落点 / 为什么不需要 | 证据 |
|---|---|---|---|---|---|
| `ai-base/docs/2026-08-12-avatar-fork-design.md` | 分身子 Agent：缓存成本论 + 判据 + 分区 | 449 | **部分继承** | **文档本体在 dsh-brain 零引用**（grep `avatar` 无命中，见 §4）。思想被三处**重新推导**：① 前缀缓存成本论 → `dsh-brain/docs/context-cache-efficiency-measurement.md`（实测版）；② fork 归属/时间线 → `fork-provenance-ai-base-vs-dsh.md`；③ 写验分离 + 期刊分区 → `per-subagent-memory.md` §1.2 / `self-evolution-master-plan.md` §7。**未继承的部分**：fork 树=前缀树（公共前缀只缓存一份）、`fork(task,n)` 由 AI 运行时定数、回显/回写双通道、VIP 影子社区双重门槛。 | 原文读过（L25–46, L60–72, L113–167, L386–437） |
| `ai-base/docs/ch19-doc-subagent.md` | 第三真相源(文档) + Subagent fork | 471 | **部分继承** | fork 委派 → `fork-provenance-ai-base-vs-dsh.md`（设计归属=你的更早）+ `subagent-persistence-and-evolution.md`（DSH 现成 `fork`/`continuable`）。**未继承**：三源网络（Corpus/Graph/Doc 矛盾以 Corpus 为准）、`doc_search`/`doc_archive`/`doc_init` 三件套、4 种归档策略（append/replace/section/invalidate）、文档失效标记 `#DOC#INVALIDATED#`、§11 条目级结构化文档编辑。**dsh-brain 无任何 doc_* 工具**。 | 原文读过（L25–77, L129–230, L293–318, L408–466） |
| `ai-base/docs/ch18-decision-flow-memory.md` | 决策流纯净主义 + 两真相源 + 失效标记 | 645 | **部分继承** | 传送带侧 → `dsh-brain/docs/conveyor-postmortem-and-revival.md`（Go 版 vs TS 版逐项对照）+ `ideas-spec.md` §1（不变量 I1.1–I1.6）。**未继承**：决策流纯净化（tool 消息压成 `[tool:id 已执行] {摘要}`）、`<summary>`/`<invalidate:node-xxx>` 标签协议、批量修剪真删 Messages、Corpus 原文可召回。`memory-asset-triage.md` §3 把 `CorpusJournal` 列入「直接移植」，**未实施**。 | 原文读过（L36–83, L90–193, L363–378, L633–645） |
| `ai-base/docs/2026-06-20-agent-shell-v2-context-architecture.md` | v2 上下文四层模型（L0–L3） | 692 | **已过时** | 文件**自标**「⚠️ 已弃用 — 2026-06-21 重构为章节体系」，内容拆入 `ch01`/`ch02`/`ch03`/`ch15`（见本表对应行）。**其 L1/L2/L3 分层被 ch01 的传送带模型替代**。 | 原文读过（L1–9 弃用横幅 + 全篇） |
| `ai-base/docs/2026-06-20-agent-shell-v2-memory-system.md` | v2 记忆：图/检索/睡眠/技能树 | 651 | **已过时** | 同上，拆入 `ch07`–`ch10`。**但 §11「Skill Book → Skill Tree + SkillOpt 四机制」的内容是活的**——落在 `dsh-brain/packages/skill-tree/src/index.ts`（见 1.2 ch09 行）。 | 原文读过（L1–10 弃用横幅；L229–328 技能树节） |
| `ai-base/docs/ch02-context-compression.md` | L1 递归/L2 三温区/L3 速率/CCR | 464 | **部分继承** | 三温区+折叠 → `conveyor-postmortem-and-revival.md` + `ideas-spec.md` §1。**§7 CCR 可逆压缩（sidecar_buffer + 哈希占位符 + `memory_recall`）未继承**：`context-cache-efficiency-measurement.md` §11.2 原文把它称作「**你自己写过的更好的那个：ai-base 的 FileBuffer / SidecarBuffer**」并列为 **P2 待移植**（该文 L523）。**§6 AST/JSON/Log 专用压缩器、§8 六维消息打分未继承（无落点）**。 | 原文读过（L5–21, L22–163, L249–345, L347–449） |
| `ai-base/docs/ch11-agent-core.md` | turn loop + 8 接口 + Controller | 356 | **部分继承** | 8 接口/Controller 层**不需要移植**（cordis 插件体系 + DSH 宿主取代）。**真正相关的一条**：§2 turn loop 步骤 d —— `prefixShape = hash(ImmutablePrefix + schemas)`，与上轮比对、变了就 emit cache event，外加 `sessionCacheHit/Miss` 计数器（L49–52, L25–26）= **前缀缓存可观测性**。dsh-brain 侧是**独立重推**的：`context-cache-efficiency-measurement.md` + `scripts/measure-arm-face.mjs`（`subagent-persistence-and-evolution.md` §3.3 要求把它加进 `armFaceCheck`）。不变量抽取 → `ideas-spec.md` §3/§4/§5。 | 原文读过（L9–31, L35–77, L128–164, L190–354） |
| `ai-base/docs/ch12-agent-permission.md` | 三层权限 + DangerScorer 六维 | 66 | **未继承** | **无落点。** 六维 0–100 评分（数据破坏性/权限提升/不可逆性/路径风险/组合风险/范围风险）+ 四档 tier（auto / soft 5s / hard / type_name）+ 50 个校准用例，在 dsh-brain **零对应**（grep 无命中）。仅 `ideas-spec.md` §4 的 I4.1「分级审批」抽象原则与之同向，**无评分实现**。无需重造的理由**不成立**——靶场的「危险动作分级」正好缺这套判据。 | 原文读过（全文 66 行） |
| `ai-base/docs/ch17-task-orchestrator.md` | 三脑平铺 + 工作台编排 + 状态机 | 3790 | **已过时** | **其核心命题被用户 2026-09-20 明确推翻**：`revised-architecture-2026-09-20.md` §1「三脑**已经被颠覆了**……上层只需要做一个**专家评审团**」+ §5.1 明示 canonical 命名表作废。§9 AutoCheckpoint 的现代对应物是 `dsh-brain/packages/switchboard`（蓝绿/回滚/drain/lease），**是自研而非继承**。 | 原文读过（L1–140 目录+§1；§2–§11 只看标题） |

### 1.2 P1 —— 其余 `ch*`（读标题 + 各节首段）

| 资产（路径） | 它讲什么（≤15 字） | 行数 | 判定 | 落点 / 为什么不需要 | 证据 |
|---|---|---|---|---|---|
| `ch01-context-engine.md` | 传送带流模型 + 语义边界 + Rollback | 370 | **部分继承** | `conveyor-postmortem-and-revival.md` 逐项对照出「**DSH 原生完全没有的 6 项**」：非破坏折叠+Rollback、CorpusJournal 原文可召回、SummaryZone 导航、**`<task-boundary/>` 语义切分（实验验证过）**、缓存可观测性、CrossRoundNotes（该文与 `self-evolution-master-plan.md:27` 均原文列出）。`ideas-spec.md` §1 抽出 I1.1–I1.6。**实现：`packages/conveyor-context` 曾移植后空转**（`kept=0/folds=0`）。 | 只看标题 + 他文原文对照 |
| `ch03-context-multimodal.md` | 旁路缓冲 + native/ext/none 三模式 | 145 | **未继承** | 无落点。与 `ch02 §7` 的 CCR 同批，`context-cache-efficiency-measurement.md` §11.2 列为 P2。 | 只看标题 |
| `ch04-hub-protocol.md` | 7 Category 消息 + Address + A2A | 388 | **已过时** | 宿主形态（Go Hub + WS 协议）在我们的栈里已不存在；通讯由 DSH 宿主 + cordis 承担。不需要移植。 | 只看标题 |
| `ch05-hub-services.md` | 白名单/转录/ServicePlugin/MCP 端点 | 307 | **已过时** | 同上。ServicePlugin 的「可插拔服务」思想由 cordis 插件体系独立实现（无需移植其 Go 形态）。 | 只看标题 |
| `ch06-session-schema.md` | QQ 消息式会话存储 + 截断规则 | 150 | **已过时** | DSH 有原生 session 持久化（`docs/subagent-persistence-and-evolution.md` §1 已核 `listTree`/`cold-resume`）。 | 只看标题 |
| `ch07-memory-graph.md` | GraphCache/GraphWriter 单写 + 向量索引 | 164 | **部分继承** | **已盘点、未实现**：`memory-asset-triage.md` §1A/§3 把 `graph_cache.go`/`graph_writer.go` 列入「直接移植」并称其「单 goroutine 独占写 + tmp→rename 原子写 + `.corrupted` 恢复」与我们的 **I1 写权唯一同构，是现成的实现」；`skill-tree-port-plan.md` §3/§6 明确标注 `sleep_prune` **依赖它俩、需单独立项**。 | 只看标题 + 他文原文 |
| `ch08-memory-retrieval.md` | 多跳协议 + RRF + dead_end TTL | 132 | **部分继承** | 同上：`memory-asset-triage.md` §3 把 `retriever*.go`/`retrieval_pipeline.go`/`rrf.go`/`reranker.go`/`query_rewriter.go` 全列为「直接移植」；`revised-architecture-2026-09-20.md` §7.3 把 `graph_cache`/`rrf` 列为进化脑缺的「移植」。**未实现**。 | 只看标题 + 他文原文 |
| `ch09-memory-skill.md` | 技能树 Schema + SkillOpt 生命周期 | 215 | **已继承**（**唯一一条**） | **落点：`dsh-brain/packages/skill-tree/src/index.ts`** —— 实测导出 `ToolDef`、`SkillStatus`、`SkillSource`、`AbsorbOutcome`（0..3 枚举）、`MaxEditsPerEpoch=3`、`EditRecord`、`SkillNode`、`SkillTreeMeta`、`EvalResult`、`SkillEvaluator`；`src/skill-tree.ts` + `src/text/tokenize.ts` 已落地。逐字段映射见 `skill-tree-port-plan.md` §4.1（**33 字段 0 缺 0 多**）。⚠️ **只到「数据层」**：`GetActiveSkills`（执行器）**刻意未移**，留 `src/executor/` 占位。 | 原文读过 + 读源码 |
| `ch10-memory-sleep.md` | 三阶段睡眠巩固 + 调度 + REST | 111 | **部分继承** | **已盘点、未实现**：`memory-asset-triage.md` §1D/§3 把 `sleep*.go` 六模块列入「直接移植」，§5 由此推出**「记忆库必须是独立进程」**这条结构性结论。 | 只看标题 + 他文原文 |
| `ch13-agent-hook-checkpoint.md` | 7 Hook 事件 + Git-free Checkpoint | 67 | **部分继承** | Hook 事件集**由 DSH 宿主原生提供，无需移植**；Checkpoint/回滚的思想落在 `dsh-brain/packages/switchboard`（`rollbackFlip`/失败三档/`abort`）。`ideas-spec.md` §4 抽出护栏不变量。 | 只看标题 |
| `ch14-extension-points.md` | 14 可插拔接口 + 生态兼容层 | 1466 | **已过时** | 「可插拔」这一层**由 cordis 插件体系统一承担**，逐个移植 14 个 Go 接口没有落点也没有必要。其**不变量**已被抽进 `ideas-spec.md`（该文自述是「在 DSH 上重新干净实现——而非迁移代码」的**唯一依据**）。 | 只看标题 |
| `ch15-resource-governance.md` | 全系统资源阈值 + 异常恢复 | 351 | **部分继承** | `ideas-spec.md` §4 I4.2（资源阈值：上下文/单轮消息/草稿/工具超时/并发，「不静默超限」）是它的抽象版。**具体数值表未继承**。 | 只看标题 |
| `ch16-mobile-remote.md` | 移动端 + UI 架构重构 | 354 | **未继承** | 无落点。前端线在 `ai-base/hub-router-panels/` 与 `dsh-brain/design-canvas-dev/`，与自进化+靶场主线无关。 | 只看标题 |
| `ch20-error-handling.md` | 统一错误处理 | 497 | **部分继承** | `ideas-spec.md` §4 I4.3「一致错误格式 `ok / error.code / error.message / error.detail`」是它的抽象版。 | 只看标题 |
| `ch20-memory-alignment.md` | 记忆四层对齐 + 全量向量化 | 147 | **部分继承** | `memory-asset-triage.md` §1A 的 `sqlite_store.go`（**单文件 `memory.db` + WAL + `embedding_cache`（key=`sha256(model\0text)`）+ dirty 惰性同步**）就是它的落地形态，已被列入「直接移植」。 | 只看标题 + 他文原文 |
| `ch22-opensquilla-absorption.md` | OpenSquilla 10 项吸收 + 会诊编排 | 776 | **部分继承** | 被 dsh-brain **实际引用**：`memory-asset-triage.md:111` 注明 `SkillNode.Tools` 来自「**ch22 §6: Skill-as-Capability —— 工具声明**」。§11 多 agent 会诊编排的方向 → `dsh-brain/packages/subagent-council`（`council-architect`）。其余 10 项清单未逐项对账。 | 只看标题 + 他文原文引用 |

### 1.3 v2 六件套 + 目录/流程/前端

| 资产（路径） | 它讲什么（≤15 字） | 行数 | 判定 | 落点 / 为什么不需要 | 证据 |
|---|---|---|---|---|---|
| `2026-06-20-...-v2-hub-protocol.md` | v2 Hub 消息协议 | 828 | **已过时** | 自标「⚠️ 已弃用」，拆入 `ch04`/`ch05`/`ch06`。 | 原文读过（L1–4） |
| `2026-06-20-...-v2-session-schema.md` | v2 会话持久化 Schema | 275 | **已过时** | 自标「⚠️ 已弃用」，内容「已迁至 `ch06`」。 | 原文读过（L1–4） |
| `2026-06-21-...-v2-agent-core.md` | v2 Agent 核心重构 | 281 | **已过时** | 自标「⚠️ 已弃用」，拆入 `ch11`。 | 原文读过（L1–4） |
| `2026-06-21-...-v2-extension-points.md` | v2 扩展点体系 | 1032 | **已过时** | 自标「⚠️ 已弃用」，内容「已迁至 `ch14`」。 | 原文读过（L1–4） |
| `v2-architecture.md` | ch* 的架构总目录 + 决策索引 + 术语表 | 190 | **未继承** | **无落点，而且这是一个真缺口**：dsh-brain **没有任何「规格索引」**；`ideas-spec.md`（80 行）是我们这边规格层的全部。于是「哪些规格存在、哪条决策编号对应哪份文档」在 dsh-brain 无处可查。 | 只看标题 |
| `v2-implementation-roadmap.md` | Phase 0–M4 实施路线图 | 321 | **已过时** | 讲的是 **Go 版的实施顺序**，对本栈无效。 | 只看标题 |
| `v2-implementation-status.md` | Phase 0–12 实施状态跟踪 | 677 | **已过时** | 同上（Go 版状态）。注意：它是**唯一记录了「哪条已实现/哪条只是设计」的台账**——这类台账 dsh-brain 目前**没有**。 | 只看标题 |
| `agent-behavior-flow.md` | Turn 时序 + Hub readLoop + 前端状态机 | 240 | **未继承** | 无落点（Hub/前端不在我们线）。 | 只看标题 |
| `agent-cognitive-flow.md` | 认知链路图 + 协议事件对应 | 167 | **未继承** | 无落点。 | 只看标题 |
| `multi-bubble-design.md` | 认知阶段分层多气泡展示 | 141 | **未继承** | 无落点（纯前端）。 | 只看标题 |
| `reference-agentchat-skill.md` | AgentChat 仿真反爬思路分析 | 195 | **未继承** | 无落点，与主线无关（外部参考笔记）。 | 只看标题 |
| `visual-style-guide.md` | 前端可视化风格规范 | 30 | **未继承** | 无落点（纯前端）。 | 只看标题 |

### 1.4 其余目录 + 被 dsh-brain 引用过的 agent-shell 文档

| 资产（路径） | 它讲什么（≤15 字） | 行数 | 判定 | 落点 / 为什么不需要 | 证据 |
|---|---|---|---|---|---|
| `ai-base/docs/discussion/2026-08-06-llm-context-awareness.md` | 五议题：上下文感知/管控/指标/doc 工具 | 422 | **部分继承**（**含一次「继承+纠错」**） | **落点：`self-evolution-master-plan.md`**。§5.0 原文引用它 L92「每个维度一个分数（0-100），**加权聚合为架构健康度总分**」——**并明确把这条修正为字典序**（「这条要被修正掉……这就是 reward hacking 的数学根源」）。§5.1 把它 L79–88 的 6 类指标拆成「4 域 × 2 类」并致谢「老指标清单……直接复用，不必重采」。**议题 4（doc_* 三件套替代 Write/Edit）、议题 5（`batch_edit`）未继承**。 | 原文读过（L70–205 + 被引行） |
| `ai-base/docs/audit/*` （6 份） | 对 Go 实现的审计记录 | 1453 | **已过时** | 审计对象是 Go 实现，随实现一起过时。**按目录合并为一行**（见 §4）。 | 只看标题 |
| `ai-base/docs/archive/*` （3 份） | v1 架构 + 修复计划 | 1077 | **已过时** | 同上（v1 已弃用）。**按目录合并为一行**。 | 只看标题 |
| `ai-base/docs/toke_with_doubao/*.txt` （1 份） | 与豆包关于 traework 的讨论 | 267 | **未继承** | 无落点（散谈记录）。 | 只看标题 |
| `ai-base/agent-shell/docs/ch21-tool-optimization.md` | 工具优化 | 60 | **部分继承** | ⚠️ **注意：`ch21` 不在 `ai-base/docs/`，在 `agent-shell/docs/`**（所以「ch01–ch22 共 23 章」= `docs/` 22 份 + 这一份）。方向落在 `dsh-brain/packages/tool-evolution`（`tool_evol`/`tool_score`/`maxReviews:8`）—— 但那是**自研**，且 `self-evolution-master-plan.md` §1 判定它「**无 accept/reject，纯 LLM 自评 1–10，成熟度低**」。 | 只看标题 + 他文原文 |
| `ai-base/agent-shell/docs/proposal-tier-label-isolation.md` | tier 隔离读写矩阵 + 睡眠差异化 | 166 | **部分继承** | **被 dsh-brain 原文引用**：`per-subagent-memory.md` §1.1 逐段引它（`brain`/`subagent` 两档、`scope` 四档 `own/hierarchy/granted/all`、NREM 不给 subagent 加权、Prune 优先清 subagent 叶子 `decay 0.85 × 0.7`），并在 §2.2 判它「**缺发表门**」→ 合成为三档 + 一次晋升。**实现未做**。 | 只看标题 + 他文原文 |
| `ai-base/agent-shell/docs/proposal-memory-redesign.md` | SQLite 单库 + 作用域列 + supersede | 484 | **部分继承** | **被 dsh-brain 原文引用**：`per-subagent-memory.md` §1.3 引其结论「**隔离用同一份库的分区，不是 N 个库**」（`nodes` 表带 `brain` 列、KNN 过滤 `superseded_by IS NULL`、`anchors` 同锚查重）。**实现未做**。 | 只看标题 + 他文原文 |
| `ai-base/agent-shell/docs/proposal-subagent-parallel.md` | 独立 subagent 并行验证 | 120 | **部分继承** | **被 dsh-brain 引用**：`verification-contract.spec.md:56` 把它列为「三脑」一项的来源之一。 | 只看标题 + 他文引用 |
| `ai-base/agent-shell/docs/` 其余 18 份 `.md` + `conveyor-belt/`(5) `superpowers/` `audit/`(2) | 传送带设计/memory-filter/各种 feedback 与 proposal | ~3800 | **未继承**（未逐份读） | 无落点（**未逐份读，见 §4**）。其中 `conveyor-belt/design.md` 等大概率与 `ch01` 重叠、`superpowers/` 未打开。 | 推断 |

### 1.5 P2 —— 代码模块 vs `packages/`

| 资产（路径） | 它讲什么（≤15 字） | 规模 | 判定 | 落点 / 为什么不需要 | 证据 |
|---|---|---|---|---|---|
| `ai-base/agent-shell/internal/memory/` （33 非测试模块） | 记忆库全栈：存储/图/检索/技能/睡眠 | 457 KB | **部分继承** | **已被完整盘点**（`memory-asset-triage.md` §1 逐模块 + §3 三类处置），**已部分落地**：`ch09` 那 6 个文件 → `dsh-brain/packages/skill-tree`（类型层）。其余（`sqlite_store`/`graph_*`/`retrieval*`/`rrf`/`sleep_*`/`knowledge`/`heat`/`gravity_field`/`tool_feedback`/`meta_skill`）**停在「已规划未实施」**，且 `memory-asset-triage.md` §9 自陈 **P0（记忆宿主进程形态）未决**是横在前面、不解决会白干的前提。 | 原文读过（他文）+ 读源码 |
| `ai-base/agent-shell/internal/context/v2/` （传送带 25 模块） | `v2_manager.go` 126KB + 25 配套模块 | — | **部分继承** | 落点 `dsh-brain/packages/conveyor-context` —— **但它是 293 行只读旁听版，已空转**（`cordis.patch.yml` 曾 `disabled: true`；用户自注「实测该插件记忆侧空转 kept=0/folds=0」），复盘与复活方案见 `conveyor-postmortem-and-revival.md`。 | 原文读过（他文） |
| `agent-shell/internal/` 其余（`vault`/`browser`/`mouse`/`keyboard`/`sms`/`email`/`tracecap`/`report`/`permission`/`compactor`/`hub`/`hubclient`/`ws`/`client`/`external`/`adapters`/`session`/`background`/`bootstrap`…） | 桌面自动化/通讯/密钥/权限/多 provider | 26 个包目录 | **未继承** | **无任何落点**。其中 `permission`（DangerScorer，见 ch12）、`compactor`（专用压缩器，见 ch02 §6）、`vault`/`sms`/`email`/`browser`/`mouse`/`keyboard` 是**只在 Go 版存在的能力**，dsh-brain `packages/` 里**一个都没有**。 | 推断（按目录名对照，未读各包源码） |
| dsh-brain 对侧独有（`capability-bridge`/`key-pool-proxy`/`subagent-council`/`switchboard`/`tool-evolution`/`design-canvas-bridge`） | 能力注册/钥匙池/议事厅/蓝绿/工具进化 | 6 包 | ——（**反向行**） | **ai-base 侧无对应物**。其中 `capability-bridge/src/index.ts:106-107` 已有 `holdoutHash?: string \| null` 与 `supersededBy?: string \| null` 字段，`:337` 注释写明它管「隐藏 holdout 哈希……以及 lineage」⇒ `revised-architecture-2026-09-20.md` §4 判定：**「专家团判效果」所需的那格早就设计好了、一直空着**。 | 读源码 |

**排除项（不计入本表）**：`ai-base/references/` 与 `ai-base/_archive/` = 上游 DSH 源码副本，**不是 ai-base 的资产**（与 `fork-provenance-ai-base-vs-dsh.md` §2 的口径一致）。

---

## §2 可取清单（给做决定用 · 按「对自进化 + 靶场主线有用」排序）

> 排序依据**不是**「看起来重要」，是「**能不能让判据/靶场/子 Agent 三条线更早跑起来**」。

| # | 是什么 | 为什么**现在**有用 | 目标落点 | 成本 | 风险 |
|---|---|---|---|---|---|
| **1** | **前缀缓存敏感的凭据轮换**（`f8d6a80f`，2026-08-04，8 文件 ~280 行） | 我们的实验自变量里，**成本面**是一根主轴。这条是**硬纪律**：缓存敏感 ⇒ 保守轮换；无缓存 ⇒ 限流即轮换。**臂间/轮内轮换凭据或池 ⇒ 前缀缓存被清 ⇒ 成本读数漂**。上游架构笔记只讲了「请求头增量会作废复用」，**没讲换凭据也会**。 | 落点不是代码，是**实验纪律 + 元数据**：`docs/context-cache-efficiency-measurement.md` 记一条规范；`packages/key-pool-proxy` 须确认实验期不轮换并把轮换次数写进成本面 | **2–4h** | 若 `key-pool-proxy(pool=3)` 在实验期自动轮换，则**已完成的历史读数可能全部不可比**（需先查再改） |
| **2** | `stripTrailingUnpairedToolCalls` 的 **7 个用例**里两个边角：**「尾部多条」**与**「不污染源」** | 我们要写「子代请求头与父代**逐字节相同**」的判据（正是上游 issue #2124 的重开条件）。这两个边角（`fork` 后尾部**多条**未配对 `tool_calls` / 剥除时**不得污染源切片**）在判据用例里最容易漏，而漏了就是**假绿**。 | `docs/subagent-persistence-and-evolution.md` §4 的「重开条件」→ 补进 `armFaceCheck` 一族 / `scripts/measure-arm-face.mjs` 的用例 | **2h** | 低。已是**已作废的坑位**（`fork-provenance` §3 已核 DSH 用「只切到最后一个 `turn/end`」更干净地解决）⇒ **只取用例形态，不取实现** |
| **3** | **传送带信息保全层的 `<task-boundary/>` 语义切分** + CorpusJournal 原文可召回 + 非破坏折叠 | 这是**唯一被实验验证过**的一条：`self-evolution-master-plan.md:27` 把「`<task-boundary/>` **实验验证过**的语义切分」列为 DSH 原生**完全没有**的能力。DSH 原生压缩**有损且不可召回**（21 个 `dsh-tool-*` 无任何读回历史入口）⇒ 上下文域能力门（「关键信息不丢」）现在**没有判据可挂**。 | `packages/conveyor-context` 复活；`conveyor-postmortem-and-revival.md` 已给复活路径（**DSH 管窗口、我们管记忆**） | **8–16h** | ⚠️ **它已空转过一次**，根因是「**没验证 + 移植时能力全丢**」（25 模块 → 293 行只读旁听）⇒ **必须先定义「它保住了更多信息」的指标，再写代码** |
| **4** | **论文系统 `KnowledgeEntry`**（Claim/Scope/Transferability/Limitations/SourceNodes/Verified/**JournalTier**/Experiment）+ **写验分离** | 已被 dsh-brain 判为「**全套资产里最独特的东西**」，且 `self-evolution-master-plan.md` §7 要求把它从「记忆子系统」**提升为假设引擎（提案与证据层）**——四条路径的改动提案都该由它产出。**80% 的零件已实现**（`knowledge.go` + `sleep.go` + `sleep_experiment.go`） | `self-evolution-master-plan.md` §7 的 `proposes: {path, change, expectedGain, falsifier}`；落点宿主 = 待定的**记忆独立进程**（`per-subagent-memory.md` §7 选项 2） | **16–24h** | 阻塞于「**记忆库放哪侧**」未决（P0）；且「论文推论文」**目前只有设计、无代码** |
| **5** | **`gateDreamEntry`（L1 机械门 + L2 向量查重 0.85）+ `judgeDreamEntry` 四维五档投区** | 这两件**就是判据阶梯 L2/L3 的现成雏形**：`self-evolution-master-plan.md:186` 原文「`judgeDreamEntry` 的四维 + 期刊分区**就是** L2/L3 的雏形，把它接进阶梯即可，**不必重造**」。我们的 L2~L4 **至今未实施** | `docs/self-evolution-master-plan.md` §5.3 判据阶梯；`docs/verification-contract.spec.md` | **4–8h** | 五档分区是**知识域**的判据，迁到任务域需换语义（别直接搬阈值） |
| **6** | **`SkillNode` 数据层剩余部分**（`skill-tree.ts` 生命周期 + `Absorb` 6 条合并规则 / 2 条不合并检查 + `Exclusive` 保护位） | **能力库不需要设计**（`SkillTree` 已经是了）—— 我们已落地**类型层**，缺的是**执行**：`Active Skill Injection` → `spawn provider` 委派。且 `Absorb`/`AbsorbedBy`/`MergedFrom` 是「**合并/融合**」这一操作的现成账本（`revised-architecture` §7.1 的三种操作正好要它） | `packages/skill-tree/src/skill-tree.ts`（`skill-tree-port-plan.md` §7 步骤 2） | **8–16h** | 序列化映射（Go snake_case ⇄ TS camelCase）**必须显式做一层**，不许靠「字段名刚好一样」；`sqlite_store` 的最难处（`better-sqlite3` 原生编译）**不要顺手做** |
| **7** | **tier 三档隔离 + 差异遗忘**（`scope` 四档 / NREM 不给 subagent 加权 / Prune `decay 0.85 × 0.7`） | 子 Agent 一旦有记忆，「**低信任层不能直通共享**」就是必须的：`per-subagent-memory.md` §3 已判定缺「**发表门**」⇒ 合成三档 + 一次晋升。差异遗忘是**现成的、可用的**（该文 §6.1 原文「直接可用」） | `docs/per-subagent-memory.md` §2.2/§8（P3/P4） | **8–12h** | 依赖 #4/#6；且「发表门」是**唯一必须新造的东西** |
| **8** | **`gravity_field.go`** —— 「**无 LLM、无 IO、无新持久字段**」的确定性评分层 | `memory-asset-triage.md` §3 原文：「这种**纯函数层最容易移植、最难腐坏**」。它同时服务睡眠三阶段，且在 ST 侧只依赖 `jaccard`（L0 纯函数）⇒ **可先于一切依赖落地**，且**天然适合当判据层的可信计算基** | `packages/skill-tree/src/gravity-field.ts`（该文 §7 步骤 5） | **4–6h** | 低。⚠️ 小坑：Go 有 `container/heap`，**JS 无标准堆** ⇒ 自写二叉堆或排序替代 |
| **9** | **检索管线 `rrf.go` + `reranker.go` + `query_rewriter.go`** | 「记忆域能力门」=「**该记住的没丢（召回后仍能做成）**」。RRF 是**纯算法零依赖**（1 KB 文件），是这条门的最小可信实现；且 `revised-architecture-2026-09-20.md` §7.3 把 `graph_cache`/`rrf` 列为进化脑「**相似比较**」环节缺的那一环 | `memory-asset-triage.md` §3 的「直接移植」清单 | **6–10h** | 需要 `embedder` + 向量后端一起定（阻塞于记忆宿主进程未决） |
| **10** | **DangerScorer 六维 + 四档 tier**（ch12，**全文只有 66 行**） | 靶场要判「**不该用时不误用**」、免疫系统要判「权限扩张」，**都需要一套可解释的危险度量化**。137 行内给全了：六维分值域 + `Explain()` + 四档行为 + 50 个校准用例的分档要求 | 无现成落点（**这是唯一的纯新增项**）；接口可对齐 `packages/capability-bridge` 的注册门 | **4–6h** | ⚠️ DSH 原生 permission 已是另一套 ⇒ **对齐而非叠加**，否则两层判据会互相掩盖（假绿） |

**次选（有价值但排在 Top 10 之后）**：`doc_search`/`doc_archive` 的「**只追加 + 失效标记而非删除**」（ch19 §4.5 / `discussion` 议题 4）—— 它与我们「证据链 append-only」是同一原则，且能直接治「AI 改写文档 surface 击穿前缀」；（2）`sleep_wander.go` 的新颖性游荡（`memory-asset-triage.md` §3B 自己标「优先级低」）。

---

## §3 结论

**不是「没完全继承」，而是「只继承了最容易继承的那一层」。** 具体说：

1. **代码层继承得不错，文档层几乎没继承。** `ai-base/docs/` 顶层 **37 份 `.md`（含 ch01–ch22 共 22 份、11 432 行）里，判定「已继承」的只有 `ch09` 一份**（而且是**只到数据层**）；反观 `internal/memory/` 的 33 个 Go 模块，`memory-asset-triage.md` 已逐模块盘完并给了三类处置。**结构性的不对称是**：dsh-brain 有**代码资产的处置表**（`memory-asset-triage.md` + `skill-tree-port-plan.md`），却**没有文档资产的处置表** —— 本文件就是补这一格。

2. **最要紧的缺口①：11432 行成文规格没有任何「规格索引」。** dsh-brain 里没有 `ch*`/`v2-*`（已知事实），也**没有 `v2-architecture.md` 那种目录页的等价物**——`ideas-spec.md` 只有 80 行，且它自述是「重新干净实现的**唯一依据**」。后果已经发生过：`fork-provenance-ai-base-vs-dsh.md` §6 自陈「ai-base 里是否还有 `ch18/ch19` 那份成文的设计提案，**我没去找**」——**而 ch18/ch19 一直在 `docs/` 里**。缺索引 ⇒ **重复推导**（`avatar-fork-design` 的分身/写验分离被重新推了一遍）与**漏读**同时发生。

3. **最要紧的缺口②：四条线的判据只有记忆环有雏形，而「判据」正是主线唯一的硬缺口。** 三脑环有硬门、压缩环有「严格收缩」、记忆环有期刊分区+实测，**工具环只有 LLM 自评分、技能环连判据都没有**（`self-evolution-master-plan.md` §1 原文）。而我们**已有的最强判据资产（ch12 六维 + 50 校准用例、`judgeDreamEntry` 四维五档、`gateDreamEntry` 机械门+查重）在 dsh-brain 侧全部处于「未挂上阶梯」状态**。

4. **一句话**：需要整理的**不是 ai-base 的资产**（它已被盘点得相当细），**而是「从文档规格到 dsh-brain 落点」的那张表**——本文件即为此而写；而**下一个动作只有一个**：把 §2 的 #1（凭据轮换纪律）与 #5（判据雏形挂上阶梯）做掉，因为它们**不被任何未决前提阻塞**。

---

## §4 诚实清单

**A. 没读的（逐条列出，不许被当成读过了）**

1. `ai-base/docs/ch17-task-orchestrator.md` **3790 行只读了前 140 行**（目录 + §1 设计哲学/核心抽象）；§2–§11 **只看标题**。
2. **P1 的 16 份 `ch*`（ch01/03/04/05/06/07/08/10/13/14/15/16/20×2/22）只读了文件名与节标题**，**未逐节读**。其中若干份的判定**依赖 dsh-brain 侧他文的对照**（已在「证据」列标出是「只看标题 + 他文原文」），**不是我自己读原文得出的**。
3. `ai-base/agent-shell/docs/`：**22 份 `.md` 里只读了 3 份 proposal 的行数与被 dsh-brain 引用的段落**，其余 18 份 + `conveyor-belt/`(5) + `superpowers/` + `audit/`(2) **一份都没打开**。
4. `ai-base/docs/audit/*`（6 份 1453 行）、`archive/*`（3 份 1077 行）、`toke_with_doubao/*`（1 份 267 行）：**只看了文件名**，按目录合并成一行。
5. `ai-base/docs/ch16-mobile-remote.md`、`multi-bubble-design.md`、`reference-agentchat-skill.md`、`visual-style-guide.md`：**只看标题**判「未继承」，未读正文。
6. **两个仓库的 `agent-shell/internal/` 与 `packages/` 源代码：只按目录名做了对照**，未读各包实现（例外：`packages/skill-tree/src/index.ts` 的导出、`packages/capability-bridge/src/index.ts:106-107/337` 已读源码确认）。

**B. 是推断的（无原文/无代码支撑或支撑很弱）**

1. §1.5 的「`internal/` 其余 26 个包**未继承**」——**推断**：依据是「dsh-brain `packages/` 只有 8 个包、名字对不上」，**没有逐包读源码证明功能确实缺失**。
2. §1.2 中 ch04/ch05/ch06/ch13/ch14 判「已过时」——**推断**：依据是「宿主形态（Go Hub）在我们栈里不存在」，**不是读原文得出的结论**。
3. §1.4 最后一行「`agent-shell/docs/` 其余未继承」——**推断**（未打开文件）。
4. §1.1 `avatar-fork-design.md` 的「思想被重新推导」——**推断**：我确认了该文件在 dsh-brain **零引用**，但「三处落点是它的思想」是我读两边后的**判断**，不是文档里写着的引用链。

**C. 不能判定的**



1. **「已继承」这一档我给得极严**：全表只有 `ch09` 1 项。`ch09` 是否真的算「完整继承」也**取决于口径**——它只到数据层（`GetActiveSkills` 刻意未移、`src/executor/` 是空占位）。**若按「能力是否可用」判，它也只到「部分继承」。**
2. **`ai-base/docs/` 到底几份**：顶层 `.md` 实测 **37** 份（`ls -1 *.md | wc -l`）；用户口径「41 份」可能含子目录。**`find` 在 Git Bash 报「参数格式不正确」，递归计数没拿到**，故只有顶层数可核。**`ch01–ch22` 我数出 22 份文件、合计 11 432 行**（与用户给的数字**逐行相符**）；用户的「23 章」我推断是**加上 `agent-shell/docs/ch21-tool-optimization.md`**（列表里确实没有 `docs/ch21`）——**此推断未获确认**。
3. **v2 六件套的行数**：我算 3 759 行（692+828+651+275+281+1032），**与用户给的 3 759 逐行相符** ⇒ 口径一致。
4. **哪些「已过时」的文档里还藏着未过时的一节**：我只对 `ch17`（§9 AutoCheckpoint → switchboard）与 v2 两件套（`v2-memory-system` §11 技能树 → `packages/skill-tree`）做过这种「节级翻找」。**其余标「已过时」的 15 份，我只做了文件级判定，没做节级翻找** ⇒ 可能各含 1–2 个仍有效的节。
5. **`docs/discussion/2026-08-06-llm-context-awareness.md` 的议题 1/2/3**：我只读了 L70–205（议题 3/4/5 部分）；**议题 1/2 的内容与它是否已被继承，未判定**。

---

## §5 主代理核验补记（2026-09-21，读完之后）

### 5.1 ★ 本审计**自己最大的缺口**：`agent-shell/docs/conveyor-belt/`（未读，但**我们自己的文档在引它**）

`ai-base/agent-shell/docs/conveyor-belt/` 有 **5 份、约 180 KB**：

| 文件 | 行数/大小 |
|---|---|
| **`design.md`** | **1 064 行 / 65 KB** |
| `migration-plan.md` | 74 KB |
| `section-queue.md` | 24 KB |
| `audit-phase1.md` | 16 KB |
| `watcher.md` | 7 KB |

★ **而 `dsh-brain/docs/conveyor-postmortem-and-revival.md:49` 已经在用【精确行号】引用它**：
`design.md:568-601`（`<task-boundary/>` 的设计）、`:34-40`（**depth 定义 + 零容忍**：切分点落在"工具未返回"处 = FAIL；
"宁可漏切，不可在工具链中间切分"）、`:21-31`（**实验验证**）。
⇒ **这份 1 064 行的设计文档是 §2 第 3 项（`<task-boundary/>`）的权威源，而它在本次审计里【一份都没打开】**
—— 与「ch18/ch19 一直在 `docs/` 里却没被找到」**是同一类失败**（**源就在本地、还被自己的文档引着，仍然漏读**）。

**从我们自己的文档里能读到的关键数字**（`conveyor-postmortem-and-revival.md:49-52` 转引）：
**两模型 × 四场景、27 次测试**；单工具标记率 **5/6 = 83%**；多文件综合正确率 **3/3 = 100%**；
**depth≠0 违规 0/15 与 0/12**；验证程序 `cmd/task-boundary-exp/main.go`；
两模型均**正确区分「任务完成」与「工具调用完成」**（不逐文件过早打标）。
⇒ 这是**实验验证过的设计**，不是纸面设想。

### 5.2 我（主代理）的两处口径错误 —— 审计抓对了，我更正

| 我先前说 | 实际 | 说明 |
|---|---|---|
| `ai-base/docs/` **41 份** | **顶层 `.md` = 37 份** | 我说的 41 是 `ls -1 \| wc -l`（**含子目录**） |
| `ch01–ch22` 共 **23 章** | **22 份 / 11 432 行**（逐行相符） | `docs/` 里**没有 ch21**；`ch21-tool-optimization.md` 在 **`agent-shell/docs/`** |

⇒ 教训与铁律 #12/#18 同族：**数"份数"要说明口径（条目数 vs `.md` 数 vs 章节数）**，否则会以讹传讹。

### 5.3 已核验为真的关键断言（主代理独立复核）

- **规格索引缺口**：dsh-brain 里引用 `ch0x/ch1x/ch2x` 的**只有本文件**（新写的）⇒ 之前**确实没有规格索引** ✓
- **`DangerScorer` 无落点**：在 dsh-brain `docs/`/`packages/`/`scripts/` 里 **grep 命中 0**（本文件之前）✓
  仅 `ideas-spec.md` 有抽象的 I4.1「分级审批」同向原则 —— 与审计说法一致 ✓
- **两处引文逐字相符**：`self-evolution-master-plan.md:27`（「`<task-boundary/>` **实验验证过**的语义切分」）与
  `:186`（「记忆环：`judgeDreamEntry` 的四维 + 期刊分区**就是** L2/L3 的雏形…不必重造」）✓
- **计数**：顶层 `.md` 37 / `ch*.md` 22 份 11 432 行 / v2 六件套 3 759 行 ✓（见我 §5.2 的更正）
