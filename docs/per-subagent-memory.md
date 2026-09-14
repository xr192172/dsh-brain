# 每个子脑配独立记忆（个人树 + 总库）—— 设计与既有资产

> 日期：2026-09-14 ｜ 状态：设计（待拍板）｜ 触发：用户提案"给每个子 Agent 一套基础套装"
> 关联：`capability-registry-evolution.md`（能力库）、`single-front-brain-delegation.md`（委派架构）、
> `self-evolution-master-plan.md`（判据阶梯）、`ai-base/agent-shell/docs/proposal-tier-label-isolation.md`

---

## 0. 结论速览

| 问题 | 回答 |
|---|---|
| 这个想法成立吗？ | **成立，而且它补上了能力库缺的那一环**——能力有了"记忆"，才谈得上"积累" |
| 要新造多少？ | **比预想少**：tier 隔离**已有完整设计**（ai-base 提案），论文系统**已实现**（`KnowledgeEntry` + 写验分离） |
| 关键修正 1 | **隔离用同一份库的分区，不是 N 个库**（发表 = 同库内提升 tier，零拷贝） |
| 关键修正 2 | **记忆的粒度挂在"能力"（provider）上，不挂在实例上**——子代理是 one-shot，按实例分等于不延续 |
| 关键修正 3 | **"发表"必须是一等公民且带评审门**：私有 → 共享不是自评，是有判据的晋升 |
| 一个漂亮性质 | **记忆注入对子代理是免费的，对顶层是昂贵的**（见 §4） |
| "基础套装" | 记忆 ✅ 该配（薄）· 工具商店 ⚠️ 只读+反馈 · 双循环 ❓ 待你确认语义 |

---

## 1. 已存在什么（先查再设计）

### 1.1 Tier 隔离：**完整设计，未实施**

`ai-base/agent-shell/docs/proposal-tier-label-isolation.md`（2026-06-23）定义了：

> 引入两层 Tier 体系：**brain**（高信任，三脑）和 **subagent**（低信任，所有子代理共享池）。
> 实现按层级的读隔离、写降权、睡眠差异化。

**读写权限矩阵（原文）**：

| 读方 | brain 节点 | subagent 节点 | 被授权节点 |
|------|-----------|--------------|----------|
| brain | 全部 | 全部 | — |
| subagent | **否（默认）** | **全部（同层共享）** | 是 |

三条设计要点：
- **subagent 之间同层共享**——`explore_002` 能看到 `explore_001` 的发现，避免重复探索
- **subagent 默认读不到 brain 节点**——防止上下文膨胀
- **Master 预授权**：spawn 时把授权节点注入提示词，用 `scope="granted", granted_tags=[...]` 访问

`scope` 四档：`own`（默认，只看本 tier + 同 `source_label`）/ `hierarchy` / `granted` / `all`（仅 brain）。

写入侧带 `tier` + `source_label="subagent:explore_001"` + `confidence`；
**睡眠差异化**：NREM Hebbian 不给 subagent 加权（delta 0）、REM 关联按 tier 降 confidence
（brain↔brain 0.5 / brain↔subagent 0.4 / subagent↔subagent 0.35）、**Prune 优先清 subagent 叶子**
（`decay 0.85 × 0.7`，且不享受 bridge/anchor 保护）。

> **这份提案的定位**：它就是"每个子代理只能访问自己的 + 上层能看全部"的**精确版本**，
> 而且比"每棵独立树"多考虑了**遗忘与权重**（这恰好是私有树最容易忘掉的问题）。

### 1.2 论文系统：**已实现**（不是设想）

`internal/memory/knowledge.go` 的 `KnowledgeEntry`，注释原文：

> **知识 = 论文**：用模型最熟悉的论文结构承载"可证伪/可迁移/有边界"的知识。

字段（A 版，2026-08-13）：

```
Claim           结论（可证伪断言：一条能判真假的命题）
Scope           适用条件（何时成立）
Transferability 可迁移性（为何成立，换场景是否仍成立）
Limitations     局限（何时不成立 / 反例）
SourceNodes     引用（来源节点/论文 ID，可追溯）
Verified        ""=未验证 / verified / stale / contradict
JournalTier     期刊分区：水刊/四区/三区/二区/一区，空=未判分
Experiment      可复现实验（command + expect），nil=无实验
```

**"论文推论文"**：`gravity_field.go` 计算跨社区节点对（Jaccard + 共激活加成）→ `sleep_rem.go`
的 `RemReplay` 调 LLM 判关系（`related_to / depends_on / contradicts / supersedes`）。

**"实测"**：`sleep_experiment.go` 头部原文——

> 论文的「可复现实验」（`Experiment.command + expect`）由**作者分身（llmRefineDream）**写出，
> **审稿分身（judgeDreamEntry）**复现时真跑 command、比对 expect，产出机器证据。
> **写验分离：作者出题、审稿答题，解「自己出题自己答」的研究者偏差。**

安全边界（5 条，全部实现）：命令白名单（`go/python/node/npm/pytest/echo`）/ 黑名单拦截
（`rm -rf`/`format`/`git push`/`curl`…）/ 60s 超时杀进程树 / 工作目录强制 / **Windows Job Object
进程隔离**（KILL_ON_JOB_CLOSE + 进程数内存上限，创建失败降级为字符串守卫且**显式标注不静默**）。

### 1.3 存储：**单文件 + 作用域列**（不是多库）

`proposal-memory-redesign.md`（2026-07-27，含完整实施记录到 §14）：

- `memory.db` **单文件**（SQLite + sqlite-vec 纯 Go 嵌入），**三脑 WAL 并发共享**
- `nodes` 表带 `brain` 列：`source='graph'`（**全脑共享**）/ `source='context_graph'` + `brain=?`（**归属脑**）
- KNN 过滤：`superseded_by IS NULL AND (source='graph' OR brain=?)`
- NREM 对账"**作用域限定删除**"：`source='graph'` 共享 + `context_graph` 本脑，**别脑 context 不动**
- `supersede` 语义（旧版本不删、只标记）+ `anchors`（`file:` / `tool:` / `node:`）+ 同锚查重

**⇒ 已经验证过的结论：隔离用"同一份库里的作用域列"，而不是"多份库"。**

### 1.4 工具反馈：**已有**，且分工明确

`internal/memory/tool_feedback.go`——append-only JSONL，记 `{tool, pattern, env, fix}`，注释原文：

> Separate from SkillTree — this is about "**what broke in the tool**", not "**how to work better**".

---

## 2. 你的提案 vs 已有设计：差在哪

| 维度 | 你的提案 | ai-base 已有设计 | 我的建议 |
|---|---|---|---|
| 隔离单位 | **每个子 Agent 一棵独立记忆树** | 一份库 + `tier` + `source_label` 作用域 | **用后者**（见下） |
| 子代理之间 | 互不可见（完全私有） | **同层共享** | **分两段**：过程私有、成果共享 |
| 总库 | 给讨论层看 | `brain` tier 可读全部 | 一致 ✅ |
| 发表 | "发论文到总社区印证" | ❓ **缺**：tier 是写入时静态指定的 | **补：发表门** ⭐ |

### 2.1 为什么不用"每棵独立树"

**四条硬理由**（前三条来自项目自己的实施记录）：

1. **碎掉 embedding cache**：`embedding_cache` 的 key 是 `sha256(model\0text)`，多库 = 同一段文本
   重复付费/重复计算。
2. **发表要拷贝**：独立树之间"提升"必须物理搬运 + 重建索引；**同一个库里的提升只是一次 tier 字段更新**。
3. **跨作用域去重做不到**：`supersede` + `anchors` 查重依赖**同库 JOIN**（`node_anchors` 表）。
   多库就没法发现"A 树和 B 树记了同一件事"。
4. **收不回**：一旦分库，讨论层想"全局看一遍"就得 N 个库都查（N 次连接、N 份 dim 对账）。

> **一句话**：你要的是"**作用域**"，不是"**物理隔离**"。
> 物理隔离是**实现手段**，用错了会把"发表"这个核心动作变得昂贵。

### 2.2 但你和 ai-base 各缺一半——合成三档

- **ai-base 缺**：tier 是**写入时静态**的，没有"低 tier 晋升到高 tier 需要评审"的机制 → **发表无处发生**
- **你的提案缺**：没有区分"**过程**"与"**成果**"。全私有 → 好的发现传不出去；全共享 → 子代理的啰嗦过程污染总库

**合成后（三档 + 一次晋升）**：

| tier | 谁可读 | 谁可写 | 内容 |
|---|---|---|---|
| **`private:<provider>`** | 只该 provider（+ 其晋升出的共享条目） | 该 provider 自由写 | **过程**：探索笔记、试错的假设、临时结论 |
| **`shared`（总库）** | 全部脑 + 讨论层 | ⚠️ **只能经发表门** | **成果**：通过评审的论文（Claim/Scope/Limitations/Experiment） |
| `brain` 层（三脑间） | 保留现有 `brain` 列隔离 | 各脑自由写 | 三脑各自的 context 记忆 |

**"发表" = `private → shared` 的层级晋升**，其判据见 §3。

---

## 3. 发表门：这是唯一必须新造的东西

**为什么必须有门**：`shared` 会被**所有脑**消费。一条错的知识不是"一个子代理记错"，而是**污染全局判断**。
（ai-base 的 `Prune` 已经对 subagent 节点设了更激进的遗忘——说明它的作者也知道低信任层级不能直通共享。）

**门的三段**（复用 ai-base 已有机制，不重造）：

```
① 作者分身（llmRefineDream）产出论文
   { Claim, Scope, Transferability, Limitations, SourceNodes, Experiment{command, expect} }

② 审稿分身（judgeDreamEntry）复现
   → runExperiment 真跑 command、比对 expect → 机器证据（非 LLM 自评）
   → 四维判分 → JournalTier

③ 门（gate）
   L0 机械门：Claim/Scope/Limitations 非空 + Experiment 可执行且 Passed
   L1 不变量门：不得含权限扩张 / 绕过判据类主张（一票否决）
   L2 不退化：若要替换已有 shared 条目 → 必须走显式 supersede 链
   L3 隐藏 holdout：shared 条目的真实判据 = **它在后续真实任务中被引用后的效果**
   L4 反事实：A/B 引用了该条 vs 没引用，任务成功率/轮数对比
```

**门后必须可撤回**（这是 ai-base 也没做的）：

> 任一来源事后被判定有害 → 按 `SourceNodes` **反查全部后代论文** → 批量降级回 `private` 或标记 `contradict`。
> 没有这条，"一次投毒永久留存"（OWASP 明确点出的失败模式）。

**与 `Verified` 字段的接法**：发表成功 → `Verified="verified"`；被后代论文反驳 → `Verified="contradict"`；
依赖的锚（`anchors`）被改 → `Verified="stale"`（ai-base 已有 `MarkSuspiciousByFiles` 的锚精确波及）。

---

## 4. 一个漂亮性质：记忆注入对子代理**免费**，对顶层**昂贵**

这是我们实测过的前缀缓存约束（`docs/context-cache-efficiency-measurement.md`）推出来的：

| | 注入记忆索引的代价 |
|---|---|
| **顶层（长会话，95 工具，46 万 token 前缀）** | **= 一次前缀改写** → 5 轮内命中率 45%→82% 才恢复（实测） |
| **子代理（`spawn` = fresh child，零父上下文，自己的 system prompt）** | **= 0**。它的提示词**本来就从零构造**，没有任何可复用的前缀 |

**DSH 的 spawn 语义原文**：
> runs each child as a fresh child `Agent` on the same cordis context (**its own session, own system prompt, zero parent context**)

**⇒ 推论**：
> **把记忆放到子代理层，不只是"更干净"，它是唯一"注入不花钱"的位置。**
> 想让记忆进入长会话，正确形态是**按需检索**（`scope=hierarchy`），不是注入。

---

## 5. 粒度：记忆挂在**能力**上，不挂在**实例**上

**这条容易搞错，而且是致命的**：

- 子代理后端 `spawn` 是 **fresh child**，每次委派都是**全新 session 且零父上下文**
- 若记忆按"实例"（每次委派）分区 → 每次都是空记忆 → **等于没有延续**

**正确粒度**：`private:<provider-name>`，即**按能力类型**分区。
（DSH 的 provider 注册名是**全局唯一**的，是天然的分区键。）

> **能力（provider）是持久身份，实例是瞬时执行。记忆跟着能力走。**
> 这跟"能力库 = 进化单位"（`capability-registry-evolution.md`）完全同构——
> **记忆是能力的属性，不是某次执行的属性。**

---

## 6. "基础套装"该配什么

你说给每个子代理配：**记忆系统 · 工具商店 · 双循环管理系统（待定）**。逐个判断：

### 6.1 记忆系统 ✅ 该配，但要薄

- **配什么**：① 读自己 `private:` 分区（`scope=own`）② 写进自己分区
  ③ 被 Master 显式授权时可读指定 shared 条目（`scope=granted`）
- **"薄"的含义**：注入的是**索引**（标题 + Claim 一行），不是全文；全文按需检索。
  理由同 §4——虽然对子代理注入免费，但**子代理的 context 也是预算**。
- **必须配遗忘**：ai-base 的 subagent 遗忘策略（`decay 0.85 × 0.7`，不享受 bridge/anchor 保护）直接可用。

### 6.2 工具商店 ⚠️ 该配，但**只读 + 反馈**，不能改

按我们已定的原则（`capability-registry-evolution.md` §5.5）：

- **可以**：选用工具、产生**行为信号**（选用率/复用率）、写 `tool_feedback`（"这个工具哪里坏了"）
- **不可以**：改工具、改工具评分、决定工具上下架 —— **那属于判据层（R1）**

> 你早先说"一堆 agent 在真实使用中选用自己需要的工具并打分"——**那个"打分"就是这里的行为信号**。
> 它成立的前提正是：子代理只能**产信号**，不能**定判据**。

### 6.3 双循环管理系统 ❓ 待你确认语义

我查不到项目里叫"双循环"的东西。**我的两个猜测**：

- **猜测 A（我认为是）**：**作者分身 / 审稿分身的写验双循环**（`llmRefineDream` ↔ `judgeDreamEntry`）。
  这正是本轮查到的、已实现的那套。
- **猜测 B**：上下文折叠的双循环（传送带那种）。

**若是 A**：**不该每个子代理都配**，理由和你说"待定"一致——
写验分离的价值在于**解研究者偏差**，而它需要"作者出题、审稿答题"两个**独立上下文 + 真跑实验**。
一个跑 3 步的子代理摊不起这个成本（还要开 second opinion、还要跑 command）。
**正确位置**：写验循环属于**发表门**（§3），即"**只有在要晋升到 shared 时**才开双循环"。
低风险的 `private` 写入 → 不套双循环。

**若是 B**：子代理是 one-shot、生命周期短，折叠机制（为长会话设计）**没有作用对象**，不配。

---

## 7. 与 DSH 的接合点（全部现成）

| 需要 | DSH 现成物 | 说明 |
|---|---|---|
| 子代理隔离上下文 | `spawn` provider：**own session / own system prompt / zero parent context** | 天然私有 |
| 记忆分区键 | provider 注册名（**全局唯一**） | 直接做 `private:<name>` |
| 套装挂载点 | `SubagentProvider.capabilities`：`persona` / `toolFilter{allow,deny}` / `agentOptions{provider,model,maxTokens}` | "套装"就是这些字段的组合 |
| 子代理回传（= 投稿载体） | `dsh-tool-subagent-report`（`report` 工具）+ 契约"You receive its result, not its intermediate steps" | 回传 = 提交论文；过程不外泄 |
| 可展开的谱系 | `dsh-client-ui-subagent`（谱系树 + 用量 + 诊断位） | 论文引用网络的 UI 外壳 |
| 动态注册能力 | `ctx.subagents.registerProvider` + `subagent/provider-added` | 记忆分区随 provider 生命周期创建/销毁 |
| 记忆本体 | **无**（DSH 21 个 `dsh-tool-*` 里没有任何记忆/召回工具） | ⚠️ 唯一要自建的部分 |

**⇒ 净新增工程量**：
1. **记忆库本体**（ai-base 的 `internal/memory/` 是 Go 实现，DSH 侧要 TS 重写或改为外部服务）
2. **tier 隔离 + 发表门**（机制设计已有，实现要写）
3. **provider ↔ 记忆分区绑定**（薄薄一层接线）

**一个必须提前定的架构问题**：记忆库放哪一侧？
- **选项 1**：DSH 侧 TS 插件（进程内，与 provider 同生命周期）—— 简单，但多 gen 换代时状态要外置
- **选项 2**：**独立进程**（外部服务，类似三级替换策略里的"外部见证"位置）—— 换代不丢、可跨 gen 共享，
  且**天然满足"判据持有者独立于被判定者"**
- **我倾向选项 2**：记忆库是**跨代际资产**，不该随 gen 换代而迁移；而且它能顺带充当 §3 发表门的执行者（外部见证）。

---

## 8. 落地顺序

| 阶段 | 做什么 | 前置 | 依赖 |
|---|---|---|---|
| **P0** | 定"记忆库放哪侧"（§7 的选项 1/2） | 无 | 决定后面全部形状 |
| **P1** | 记忆库最小版：`private:<provider>` 分区 + 写入 + `scope=own` 读回 | P0 | 冷启动可用 |
| **P2** | 委派时注入索引（薄）+ 子代理写回 | P1 + 委派工具启用（`preset` 层） | 第一个闭环 |
| **P3** | 三档 tier + `scope=granted`（Master 预授权） | P2 | 对齐 ai-base 设计 |
| **P4** | **发表门**（作者/审稿双循环 + `runExperiment` + `JournalTier`） | P3 | 唯一的新造件 |
| **P5** | 谱系毒性召回（按 `SourceNodes` 反查后代、批量降级） | P4 | 免疫系统 |

**P1 之前不要动 P4** —— 没有 `private` 层，就没有"发表"的源；先让记忆能存能取，再谈晋升。

---

## 9. 待你拍板

1. **记忆库放哪侧**：DSH 插件（简单）还是独立进程（跨代际 + 可当外部见证）？我倾向独立进程。
2. **tier 是两档还是三档**：ai-base 是 `brain/subagent` 两档；我建议加 `shared` 成三档。同意？
3. **发表门的严格度**：`shared` 写入是否一律要求 `Experiment` 可执行（即"无实验不得进入总库"）？
   我倾向**是** —— 这正是"可证伪才算科学"，也防止总库被"看起来有道理"的话污染。
4. **"双循环"是哪个**（§6.3 的猜测 A 还是 B）？这决定它配在哪里、配不配。
5. **子代理之间共享还是私有**：ai-base 设计是"同层共享"（避免重复探索）；我建议**过程私有 + 成果可发布**。
   你的原意是"完全私有"，要收紧吗？
