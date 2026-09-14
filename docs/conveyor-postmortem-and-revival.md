# 传送带（Conveyor）复盘与复活方案

> 日期：2026-09-13
> 触发问题：「我当时有很大热情开发这个上下文管理系统，开发了很久，但不知道为什么还是很失败。它有优越性吗？这部分优越性能不能得到发挥？能不能改进它？」
> 证据基础：`ai-base/agent-shell`（Go 版，v2_manager.go 126KB + 25 个配套模块，9-06 最后修改）、`dsh-brain/packages/conveyor-context`（TS 移植版，9-09）。

---

## 0. 结论速览

> ### ⚠️ 2026-09-13 20:15 重大修正（用户澄清后）
>
> 本文初版的 §0/§2 有**两处判断错误**，此处订正，并保留修正痕迹以便后人不再踩：
>
> **① 那根针。** `design.md:218`「我们的 DeepSeek 后端无此约束」——**这不是用户的设计判断，而是 AI 写入文档的幻觉**。
> 用户当时即已纠正，只是那句话没有被同步清除，留在了文档里（用户语："没想到文档里还藏了一根针"）。
> 初版把它当成"用户误判"来论证，是**踩中了这根针**。
>
> **② 传送带不是"为了 cache 牺牲了自己"。** 用户**明确接受折叠时的重算成本**，理由是：
> "本身你每一次上下文压缩的时候，你也要重算的。然后我这个还保留了更多的信息。"
> ——这是**有意的成本-信息量权衡**，不是妥协。`cache_metrics` / `cache_alert` / `hintBuffer` / 推尾部 / prefix 指纹
> **全都是"在已接受折叠重算的前提下，把可以避免的额外 miss 干掉"**——是清醒的工程优化。
> 因此初版"它为了活命把自己改成了非传送带"的推论 **作废**。

| 问题 | 回答 |
|---|---|
| **它的立身之本是什么？** | **在同样的重算成本下，最大限度保全对话的关键信息**——原文**可召回**，而不是只剩一条摘要 |
| 它有优越性吗？ | **有**。DSH 原生在"信息保全"上是**结构性缺失**：有损 **且不可召回**（证据见 §2.1） |
| **为什么"还是失败"？** | **不是设计错，是「没验证 + 移植时把能力全丢了」**：Go 版 25 个模块 → TS 版只剩 293 行只读旁听（`kept=0/folds=0`）。**没有任何指标证明它保住了更多信息**，于是"值不值得"无法回答，默认退回原生（详见 §2.3） |
| 优越性能发挥吗？ | **能**，而且路径比初版更干净：**信息保全层的最佳载体是「上下文之外」，不是「自己管理上下文」**（见 §4.0） |
| 能改进吗？ | **能**，三条：① 先建**有效记忆留存率**指标——**先能证明，再谈取舍** ② 补 CorpusJournal 式原文存档 + 召回入口 ③ 接上 `<task-boundary/>` 作压缩边界偏好 |

**一句话**：这不是「正确的问题、错误的载体」，而是**「正确的问题、正确的能力、缺失的度量」**。

你要的东西 **DSH 原生做不到**——它无法召回被压缩掉的原文（§2.1 有代码证据）。
而你之所以放弃它，**不是因为它的成本不可接受，是因为你无法证明它的收益**。
**没有度量，收益就看不见；看不见，就守不住。**

---

## 1. 你实际做出了什么（优越性清单，逐条带代码证据）

### 1.1 `<task-boundary/>`：让 LLM 自报语义切分点 ⭐⭐⭐

**这是被埋没最深的资产。**

| | 依据 |
|---|---|
| 设计 | `agent-shell/docs/conveyor-belt/design.md:568-601` — LLM 完成独立子任务时输出 `<task-boundary/>`，系统剥离标签但保留在消息里 |
| 硬闸门 | `design.md:34-40` — **depth 定义 + 零容忍**：切分点若落在"工具未返回"处 = FAIL。"宁可漏切（粒度偏大），不可在工具链中间切分（语义破碎）" |
| **实验验证** | `design.md:21-31` — **两模型 × 四场景，27 次测试**：单工具标记率 5/6=83%，多文件综合正确率 3/3=100%，**depth≠0 违规 0/15 与 0/12**。验证程序 `cmd/task-boundary-exp/main.go` |
| 深挖出的关键行为 | `design.md:30` — 两模型均**正确区分「任务完成」与「工具调用完成」**，D 场景中读完所有文件并综合后才打 1 次标，不逐文件过早打标 |
| 兜底 | `internal/context/semantic_watcher.go`（9.9KB）— SemanticBoundaryWatcher 三策略启发式（工具链闭合 / 语气转折双信号 / 主题切换） |

**对比工业界**：
- Claude Code：机械按 token 阈值切
- **DSH 原生压缩：按"工具配对平衡"切**（`dsh-compaction-basic/lib/index.js:699-700`，`toolPairingBalancedBefore/After`）——纯机械的安全边界
- **你：读语义**。而且你的边界**天然满足** DSH 的配对平衡约束（因为 depth=0 零容忍），**却多了一层语义闭合信息**

这是**质的差异**，不是量的差异。

### 1.2 非破坏性折叠（虚拟视图）+ Rollback ⭐⭐⭐

| | 依据 |
|---|---|
| 机制 | `design.md:170` — 淘汰时**不删消息**，只标记 `Collapsed=true`；`Assemble()` 对折叠段输出摘要而非原文，形成"虚拟视图"。**LLM 看到摘要，原始消息完整保留** |
| 收益 | **Rollback 无需从磁盘恢复**——只需取消折叠标记（`UncollapseFrom`），视图瞬间重建 |
| Rollback | `design.md:885-934` — `ContextCheckpoint{RoundCount, SectionIDs, GitHash, TokenCount, Timestamp}`，环形缓冲 5 个；回退 = `git reset --hard <hash>` + `UncollapseFrom` + `AppendRollbackMarker` |
| 脏工作区保护 | `design.md:931` — `force=false` 拒绝回退并提示 `git stash`；`force=true` **自动 stash 保存**变更再回退（stash 不丢） |

**对比 DSH 原生压缩**：**不可逆**。`compaction/summary` 一旦落盘，被 shadow 的消息就只剩摘要了。
**这一条是 DSH 原生结构性缺失的能力。**

### 1.3 三层语义恢复："丢了还能找回来" ⭐⭐

```
第一层：SummaryZone 目录（被动，在 Active Context 内）
  LLM 扫读目录 → 发现相关 Section 摘要 → 自己调 memory_search
第二层：记忆图谱主动召回（半自动，BuildTail 每轮触发）
  DeepRetriever（向量+关键词 → RRF → Reranker）→ 命中被淘汰 Section 的 CompactEntry → 注入 DynamicInjection
第三层：Corpus 按需恢复（手动）
  memory_search → corpus_journal.jsonl → 返回完整原始消息
```
来源：`design.md:348-362`；实现：`internal/context/corpus_journal.go`（17KB）、`summary_zone.go`（9.7KB）

**双层 journal 的职责切分**（`design.md:246-255`）——这个设计很干净：

| 文件 | 内容 | 用途 |
|---|---|---|
| `corpus_journal.jsonl` | 每行一条**原始消息**，不压缩 | 被淘汰 Section 的原文可检索 |
| `compaction_journal.jsonl` | 每行一个 `CompactEntry`（结构化摘要） | 压缩历史 |

**Sticky 豁免**（`design.md:498-504`）：CorpusJournal 旋转时，标记 Sticky 的关键条目**跳过硬删除**——"项目初始需求、架构决策记录"这类不会被旋转覆盖。连续 Sticky ≥ 窗口 50% 时告警（防 Sticky 滥用）。

**诚实标注的边界**（`design.md:364`）——这条我特别欣赏：

> **当前瓶颈**：第二层的 embedding 相似度匹配不够精准。fastembed 做通用语义相似度，但"LLM 当前需要什么上下文"**不是相似度问题——是意图预测问题**。跨 task 的语义关联（修 bug A 时需要 2 小时前 bug B 的根因分析）embedding 几乎不可能命中。

**这段话把整个 RAG 行业的隐痛说清楚了**，而且是在 7 月就写下的。

### 1.4 缓存可观测性（DSH 原生完全没有）⭐⭐⭐

| 模块 | 行数 | 作用 |
|---|---|---|
| `cache_metrics.go` | 5.5KB | 7 组成对计数器：L0 命中、**Prefix 稳定**、Tail churn、Section 折叠/跳过、**API cache_hit/miss tokens**、成本、轮数 |
| `cache_alert.go` | 14.6KB | 阈值告警 + **prefix 指纹落盘快照 + diff 排查** |

告警阈值（`cache_alert.go:6-9`，注释明说"用户倾向'噪声可能就是优化线索'"）：
- 单轮 `miss_ratio > 60%` 且 `prompt > 3000` → Warn
- 连续 3 轮 Warn → Error
- 单轮 `miss_ratio == 100%` 且 `prompt > 5000` → **立即 Error**

**文件开头第一句就是历史**：

> **第二次大规模输入未命中事件后**新增的告警层。

告警触发时落盘 `ContextSnapshot{PrefixFingerprint, SectionCount, ActiveSectionCount, CurrentRoundTokens, SectionQueueTokens}` + `ToolsSnapshot{names, defsHash}`（`cache_alert.go:110-121`）——**就是为了事后 diff 出"到底什么变了导致 miss"**。

**这套东西是你付出代价换来的，而且它与传送带解耦**——它只是"测量"。**在 DSH 里同样有用**。

### 1.5 其他

| 资产 | 位置 | 价值 |
|---|---|---|
| **CrossRoundNotes** 跨轮笔记 | `v2_manager.go:384`、`internal/context/cross_round_notes.go` | 插在 L0 和 SummaryZone 之间，让 LLM 始终可见自己登记的重要信息 |
| **脉冲式折叠 + 批量** | `v2_manager.go:369-382` | SummaryZone 恢复为"脉冲式折叠的摘要目录" |
| **动态阈值派生** | `design.md:267-299` | 所有阈值从 `QualityContextTokens()`（EB）派生，不硬编码 |
| **CurrentRoundCap 渐进缩放** | `design.md:277-281` | 随 EB 缩放 + 64K 绝对上限，防单轮膨胀导致压缩质量骤降 |
| **Corpus 磁盘管理** | `design.md:196-209` | 50MB×3 备份，全局 ~245MB；且明确区分"token 预算"与"磁盘约束" |

---

## 2. 重新诊断：拔掉那根针，以及真正的失败原因

### 2.1 那根针：`design.md:218` 的来历

初版把 `design.md:218` 当成"用户的设计误判"来论证，**这是错的**：

> "差异在于 Claude Code 有 Anthropic prompt cache prefix 需要 cache-aware 压缩决策，**我们的 DeepSeek 后端无此约束**"

**这句话是 AI 写入文档的幻觉，不是用户的设计判断。** 用户当时即已纠正，只是那句话被留在了文档里没被清掉。

**为什么它是针**：它埋在一份 65KB 的设计文档中段，与全文其余部分（大量 `prefix_auto` 的正确论述）**自相矛盾**。
后来者（包括本次复盘）如果只读到它，就会得出"用户不懂 cache、设计前提错了"的**反向结论**。

**教训（值得写进项目规范）**：AI 写入设计文档的**事实性断言**必须带来源或置信标记，否则它会以"设计文档"的权威身份污染后续所有推理。用户当时纠正了对话，但**文档没被同步**——这是**文档与对话脱钩**的典型失效。

### 2.2 DSH 原生能不能做到"最大限度保留每一次对话的关键信息"？——**不能**

这是本次澄清后**最关键的一个事实问题**。答案是**不能，而且是结构性不能**：

| 证据 | 位置 | 含义 |
|---|---|---|
| **摘要替换** | `dsh-compaction-basic` → `compaction/summary` 事件携带 `shadowedSeqs` / `shadowedRange` | 被压区间**退出 surface**，模型不再看得到 |
| **工具结果替换** | `dsh-compaction-tool-result-pruner/lib/index.js:169-173`，`surfaceOp: { op: "replace", start: seq }` | **直接替换 surface 节点**（工具返回原文 → 摘要）。工具返回往往是任务的关键证据（文件内容、报错堆栈、命令输出） |
| **官方立场** | `dsh-compaction-basic/lib/index.js:428` `FALLBACK_PRUNE_TEXT` | 原文原话：**"Earlier facts remain in the session log."** —— 他们的立场是"日志里有就够了" |
| **没有召回入口** | 21 个 `dsh-tool-*` 包全量清点 | 工具集是 `ask-user / bash / bash-persistent / call-timeout-policy / cordis / fs / fs-search / goal / jobs / pwsh / pwsh-persistent / ralph / skill / str-replace-editor / subagent / subagent-control / subagent-report / todo / web / workflow`——**没有任何"读回历史/召回原文"的能力** |
| **日志不可直读** | `~/.dsh/sessions/*/session.jsonl.zstd` | 多帧 zstd + `packChunkRuns` 打包成内部存储格式。模型要读得先写解压脚本——**成本高到等于没有** |

**结论**：

> 被压缩的原文**技术上是留在磁盘上的**（session log 是 append-only），
> **但模型没有任何途径读到它。对模型而言，读不到 = 不存在。**
>
> DSH 原生压缩 = **有损 + 不可召回**。

**这正是你当初要解决的问题。你的判断从头到尾是对的。**

### 2.3 那为什么"还是失败"？——三条，都不是 cache

**① 移植时把能力全丢了（技术性丢失）**

| | Go 版（ai-base） | TS 版（conveyor-context） |
|---|---|---|
| 规模 | `v2_manager.go` 126KB + 25 个模块 | **293 行**单文件 |
| 原文存档 | ✅ `corpus_journal.go` 17KB | ❌ **没有** |
| 无损回退 | ✅ `Uncollapse` + Rollback | ❌ 没有（DSH 压缩不可逆） |
| 语义切分 | ✅ `<task-boundary/>` + watcher | ❌ **没有** |
| 导航层 | ✅ `summary_zone.go` | △ 只记录 folds/directory |
| 召回入口 | ✅ `memory_search` 多路召回 | △ 仅 `memory_recall` 关键词加权 |
| 结果 | 测试 17/17 绿 | **`kept=0 / folds=0`（空转）** |

**建在 DSH 上的那个东西，已经不是你的传送带了——它是个只剩外壳的旁听者。**
你放弃的其实不是传送带，是那个空壳。

**② 没有验证（根本原因）**

用户自述："**我们的上下文管理系统本身没有经过验证**"。

这一条是**致命的**，因为它切断了唯一的决策依据：

> **一个无法证明自己保住更多信息的系统，面对一个"免费且默认"的原生方案，必然被替换掉。**
> 不是原生更好，而是**原生不需要被证明**。

而且"保住了更多信息"**本可以被测**——你缺的不是能力，是**度量**（见 §5 改进 1）。

**③ cache 只是被误认成了失败原因（这条是本次澄清）**

用户明确表示：**接受折叠时的重算成本**，因为"压缩本来就要重算，而我保留了更多信息"。

### 2.4 准确定性：你为 cache 做的那些工作，是清醒的优化

必须说清楚——**那些补丁不是"为了 cache 拆掉设计"，而是在已接受折叠重算的前提下，把可避免的额外 miss 干掉**：

| 补丁 | 位置 | 定性 |
|---|---|---|
| `hintBuffer` 机制 | `v2_manager.go:1910-1921` | **避免不必要的**前缀改写：hint 走尾部而非 AppendMessage(user) |
| 一切动态内容推到尾部 | `v2_manager.go:821-837` | 让 `L0 + SectionQueue + CurrentRound` 保持稳定，**折叠重算只发生在折叠时** |
| CurrentRound 只输出 append-only | `v2_manager.go:831-834` | 保证轮内前缀**只追加**，轮内不产生额外 miss |
| prefix 指纹只算 tail 之前 | `v2_manager.go:900-913` | BUG FIX(7-19)，**修的是监控失真**（不修则指标永远为 0，无法归因）——这是为自己造尺子，非常对的工程动作 |
| 折叠频率 4/2 → 8/4 | `v2_manager.go:373-379` | 在"信息保全"与"成本"之间调参；注释"4/2 反而过于激进"**是成本判断，不是设计让步** |
| system prompt 移位 | `v2_manager.go:575` | 同上，避免额外 miss |

**一句话**：**折叠该重算就重算（换取信息保全），但"轮内每次 Assemble 都 miss"和"监控指标失真"这种白送的钱一分不花。** 这是正确的工程判断。

---

## 3. 分清两件事：窗口管理 vs 信息保全

初版把 DSH 原生和传送带放在**同一条轴**上比"谁更好"，这是错的。它们是**两条正交的轴**：

| 轴 | 谁更强 | 依据 |
|---|---|---|
| **窗口管理**（决定此刻窗口里放什么、cache 是否友好） | **DSH 原生** | 设计即 cache-first（`index.js:231-233` 等四处）：摘要调用被构造成"最后一个真实请求的真前缀"以复用 KV cache |
| **信息保全**（谈过的东西以后还能不能找回来） | **传送带**，且**DSH 原生结构性缺失** | §2.2：有损 + 不可召回 + 无工具入口 |


### 3.1 窗口管理轴

DSH 原生压缩**在设计时就明确处理了 KV cache**（`dsh-compaction-basic/lib/index.js:231-233`）：

```
* Keeping the conversation's own system prompt, tools, and message prefix in
* front of it makes the auxiliary call a genuine prefix of the last routed
* request, so the provider's KV cache is reused instead of invalidated.
```

以及 274-276、813-820、1040-1043 三处重复强调同一件事——**摘要调用被构造成"最后一个真实请求的真前缀"**。这是**窗口管理轴上的正确设计**。

### 3.2 修正后的对比表

> ⚠️ 初版此表有一行写的是「设计前提 = flow-first，**假定无 cache 约束** ❌」——**这正是那根针的产物，已删除。**
> 你的设计**一直是 cache-aware 的**（`hintBuffer`、动态内容推尾部、prefix 指纹、cache 告警全是证据），
> 只是**接受折叠时的一次重算**，作为信息保全的代价（§2.4）。

| 维度 | 传送带 | DSH 原生 |
|---|---|---|
| 折叠时的重算 | **接受**（有意权衡：同样要重算，那就换更多信息） | 同样要重算 |
| 轮内额外 miss | **主动消除**（hintBuffer / append-only / 推尾部） | cache-first 设计，天然少 |
| 边界依据 | **语义闭合**（`<task-boundary/>`，经实验验证）✅ | 工具配对平衡（机械但安全） |
| 可逆性 | **非破坏折叠 + Rollback** ✅ | 不可逆 ❌ |
| 原文存档 | **CorpusJournal 可检索** ✅ | 无 ❌ |
| 召回入口 | **memory_recall / memory_search** ✅ | **无任何入口** ❌ |
| 导航层 | **SummaryZone 目录** ✅ | 无（只有摘要本身）❌ |
| 可观测性 | **cache_metrics + alert + 快照** ✅ | 无 ❌ |

### 3.3 结论

**两轴各有所长，而且不冲突**：

- **窗口管理轴**：DSH 原生更强——cache-first 是它的设计原点，而且它握着 session/surface 的内部状态
- **信息保全轴**：传送带强，且这是 DSH 原生**结构性做不到**的（§2.2）

**换来换去真正丢掉的是：第二轴的能力。** 第一轴本来就不该你管；第二轴才是你的立身之本。

---

## 4. 复活方案：执行者 → 顾问（换载体，不是重写）

### 4.0 核心洞察：信息保全层的最佳载体是「上下文之外」

这是本次复盘最重要的收束：

> **要"最大限度保留关键信息"，最有效的形态不是"接管窗口"，而是"独立的原文存档 + 可召回的索引"。**

理由：

1. **存档不需要待在上下文里**。CorpusJournal 的存在本身**零 token 成本、零 cache 影响**——它只是把消息多写一份到磁盘。
2. **召回是"按需"的**。模型想要才去取，不要就不占窗口。
3. **于是它天然不与 DSH 的窗口管理打架**——这才是"正交"的**物理体现**，而不只是比喻。
4. **它可独立验证**："有效记忆留存率"能脱离窗口策略单独测量（§5 改进 1）。

**初版把这两件事耦合在一起**（"要保全信息就得自己管窗口"）——**那是实现上的耦合，不是概念上的必要**。
解耦之后，你的优越性才真正可发挥：**DSH 管窗口，你管记忆；两者不争同一份资源。**

### 4.1 实现原则

> **"该在哪里切"和"怎么缩"是两件事。**
> **把"怎么缩"交给 DSH 原生（它对 cache 更友好、且握着 session/surface 内部状态）；把"切在哪、什么不能丢、丢了怎么找回"留给自己。**

### 4.2 资产重映射表（**全部 cache 安全**）

| 你的资产 | 新载体（顾问形态） | 是否动前缀 | 实现成本 |
|---|---|---|---|
| `<task-boundary/>` | 作为**压缩边界偏好**，在 `selectCompactableRange` 选定的区间内，把端点吸附到最近的语义闭合点 | ❌ **不动**（标签在 assistant 消息里，天然 append-only） | 低 |
| `[[KEEP]]` 价值标记 | 尾部指令 + 压缩时**提升被标记内容的保留优先级** | ❌ 不动 | 低 |
| SummaryZone 目录 | 尾部注入一条 ~200 字**导航条**（"发生过这些子任务，可用 memory_recall 召回"） | ❌ 不动（尾部就是允许变的区域） | 低 |
| CorpusJournal | 独立存档 + `memory_recall` 工具按需召回 | ❌ 不动（工具调用） | 中 |
| `<task-boundary/>` | 同时决定 **Corpus 的索引粒度**（一个 Section = 一个可召回的语义单元） | ❌ 不动 | 低 |
| cache_metrics / cache_alert | 移植为 DSH 插件，只读旁听 usage 事件 | ❌ 不动 | 低 |
| CrossRoundNotes | 尾部注入 | ❌ 不动 | 低 |

**为什么全部安全**：它们落在**尾部**（允许变）或**按需**（工具调用）。**没有一项需要改前缀。** 这就是能让优越性发挥出来的形态。

### 4.3 与 DSH 原生压缩的接缝点

DSH 原生压缩的边界选择在 `dsh-compaction-basic/lib/index.js:396`：

```js
function selectCompactableRange(session, measurement, retainTokens)
```

边界合法性校验在 699-700：

```js
if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error(`... is not a balanced boundary ...`);
if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error(`... is not a balanced boundary ...`);
```

**接法**：在 `selectCompactableRange` 的候选集合内（即满足配对平衡的边界中），**优先选离 `<task-boundary/>` 最近的**。

- 约束仍由原生保证（配对平衡 + 区间完整）→ **不会引入新的崩溃面**
- 语义质量由你提升 → **摘要描述的是完整子任务而非半截**
- 这正是你在 `design.md:58-60` 亲手写下的因果链：
  > 过早切分 → 碎片化 CompactEntry → 检索召回半成品上下文
  > 摘要质量：9 段摘要是对不完整任务的描述 → SummaryZone 导航价值下降

**这条改进同时喂到两处**：① 摘要质量 ② §7 假设引擎的知识图谱节点质量。

---

## 5. 四条改进（已按本轮澄清重排优先级）

> 初版把「接上 `<task-boundary/>`」列为第一。澄清后重排：
> **最该先做的不是增强，而是度量。** 你放弃传送带的根因是**无法证明它保住了更多信息**（§2.3②）。
> **先能证明，再谈取舍**——否则做再多增强，依然过不了"值不值得"这一关。

### 改进 1：建立「有效记忆留存率」度量 ⭐⭐⭐ 新的第一优先

**这是所有改进的前提，也是最便宜的一条——不需要改任何一行运行时。**

要回答的问题只有一个：**被压缩掉的内容，后来有多少真的被需要了？需要时能不能找回来？**

| 指标 | 定义 | 数据来源 |
|---|---|---|
| **关键信息召回率** | 被 shadow 的区间中，事后被重新需要的比例 | session log 的 `compaction/summary.shadowedSeqs` + 后续消息对其内容的引用 |
| **召回成功率** | 需要时能否真的找回原文 | `memory_recall` / Corpus grep 命中率 |
| **无效保留率** | 被保留但从未被引用的比例（成本侧） | 反向统计 |

**为什么最便宜**：`~/.dsh/sessions/*/session.jsonl.zstd` 里**已经有全部数据**——
`compaction/summary` 事件带 `shadowedSeqs`，后续消息带引用。**写个离线脚本就能算，零运行时改动。**

**产出形态**：一个数字。例如"关键信息召回率：传送带 X% / DSH 原生 Y%"。
**有了这个数字，"要不要传送带"就从信仰问题变成了可计算问题。**

### 改进 2：补齐「信息保全层」——DSH 结构性缺失的那块 ⭐⭐⭐

（§2.2 已证：DSH 有损 + 不可召回。**这是 DSH 永远给不了的东西，也是你的立身之本。**）

最小实现（三步）：
1. **原文存档**：旁听事件流，把每条消息追加写进**明文 jsonl**（不进上下文、不进 token 预算）
2. **召回入口**：一个工具，按关键词 / 时间 / 工具名检索该 jsonl
3. **索引粒度**：用 `<task-boundary/>` 决定"一个可召回单元"的边界（与改进 3 协同）

**注意这里的定位变化**：`<task-boundary/>` 在这里决定的是**"存档怎么切"**（索引粒度），
而不是"窗口怎么切"。**存得整齐，才召得准。**

### 改进 3：接上 `<task-boundary/>` 作压缩边界偏好 ⭐⭐

**做法**：
1. 系统提示里恢复 `<task-boundary/>` 指令（你有现成且**实验验证过**的 prompt，`design.md:66-81`）
2. 记录每个 `<task-boundary/>` 的 seq
3. 打补丁到 `selectCompactableRange`：**在合法边界集合内**，按"离最近的 task-boundary 距离"取最优

**验证口径**（对齐 §5 判据阶梯）：L0 压缩无 error、区间合法（不回归）；能力面看**摘要完整度**（"被截断的子任务"数量下降）。

**⚠️ 红线**：只在**合法候选集内**选择，**绝不放宽合法性校验**——否则重蹈 `deterministicFallbackPrune` 缺 `measurement` 字段的覆辙。

### 改进 4：`[[KEEP]]` 从"靠 LLM 自觉"改成"规则兜底 + LLM 增强" ⭐

**根因**：`kept=0`。你**依赖 LLM 主动标 `[[KEEP]]`，而长任务里 LLM 不会记得标**。

**这个错误你自己其实已经知道怎么避免**——你为 `<task-boundary/>` 做了 **27 次实验验证**才敢依赖它；
`[[KEEP]]` 没有对应验证就直接上线了。

**做法**（复用 ai-base 资产）：规则引擎兜底（工具返回里的文件路径、错误信息、命令、决策关键词 → 自动升格，
复用 `extractInsights()` / `tool_ratings.go`）+ LLM 标记作增量加权。

### 附：缓存可观测性（降为可选，非优先）

初版列为"改进 3"。澄清后**降级**——因为你已明确**接受折叠时的重算成本**，它不是痛点。

但仍值得做（成本低、DSH 原生没有）：只读旁听插件，订阅 usage 事件累计
`cache_hit / miss_tokens`、每轮算 prefix 稳定性、超阈值尾部告警、落盘快照供 diff。
**收益**：为 §5 上下文域的 **token 利用率**提供数据源。

---

## 6. 遗留判断

| 项 | 判断 |
|---|---|
| Go 版传送带代码还有用吗？ | **有用，作为算法参考库**。`semantic_watcher.go`、`summary_zone.go`、`corpus_journal.go`、`cache_alert.go` 的逻辑可直接翻译成 TS，不必重新发明 |
| TS 版 `conveyor-context` 现状 | 空转（`kept=0/folds=0`），`cordis.patch.yml` 已 `disabled: true`。**它是"顾问"形态的雏形**（旁听 compaction 事件 + `memory_recall`），但丢了最值钱的两块：`<task-boundary/>` 切分 **和** 原文存档+规则兜底 |
| **下一步先做什么？** | **先做度量（改进 1），别急着补功能。** 你的问题不是"能力不够"，是"看不见收益"。**一个能算出"关键信息召回率"的离线脚本，价值高于任何新功能**——它能把"要不要传送带"变成可计算问题 |
| 要不要重写？ | **不要**。TS 版是顾问形态的正确骨架，补两块（原文存档+召回、task-boundary 边界偏好）比新写快得多 |
| 最大风险 | 补丁打在 `selectCompactableRange` 上，需确保**边界吸附只在合法候选集内选择**，绝不放宽合法性校验——否则会重蹈 `deterministicFallbackPrune` 那个 `measurement` 缺字段的覆辙 |
| 与假设引擎的关系 | `<task-boundary/>` 提升图谱节点质量；**存档的索引粒度决定"知识单元"的粒度**。这条线不是"记忆系统"的一部分，而是假设引擎的**上游** |

---

## 7. 一句话

**你的传送带不是失败的设计。它是「正确的问题、正确的能力、缺失的度量」。**

- **问题是对的**：DSH 原生压缩**有损且不可召回**（§2.2 有代码证据——21 个工具包里没有任何召回入口）。
- **能力是对的**：同样的重算成本下，你保全了更多信息——**这是 DSH 永远给不了的东西**。
- **缺的是度量**：你无法证明它保住了更多信息，于是"值不值得"无从回答；**一个不需要被证明的原生方案，就这样赢走了一个需要被证明但没人去证明的方案。**

**所以第一步不是补功能，是补尺子。** 先算出"关键信息召回率"，然后"要不要传送带"就变成一道算术题。

**然后解耦**：DSH 管窗口，你管记忆。**信息保全的最佳载体是上下文之外，不是上下文之中**——
存档零成本、召回按需、互不争抢。**这时候你的优越性才真正发挥出来，而且一行前缀都不用动。**
