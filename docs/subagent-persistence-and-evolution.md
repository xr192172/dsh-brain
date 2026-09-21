# 子 Agent 的持久化上下文：DSH 的事实、对进化的意义、对判据的毒性（2026-09-21）

> 触发（用户两问）：
> ① 「按我们的规划，最后的自进化是落到**子 Agent** 上的。子 Agent 拥有**不同的提示词和不同的工具集**，应该是很天然的事情吧？」
> ② 「子 Agent 有没有**可持久化的上下文**？如果有，是不是比单纯唤起子 Agent 更好？」
>
> 证据来源：**上游源码逐字读**（`/mnt/d/project_develop/_research/deepseek-harness/deepseek-harness-master`，
> 下载树；引用请回 `github.com/deepseek-ai/deepseek-harness` 核对）；
> 关键材料是那篇架构笔记 `.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.md`（**已通读**）。

---

## 1. 事实：DSH 里"子 Agent"是**一等公民**，且有**两种不同的上下文继承**

| | **`continuable` child** | **`fork` child** |
|---|---|---|
| 谁能建 | `spawn`（base bundle 与 shipped presets 都绑 `backgroundMode: continuable`） | `subagent_fork`（**`fork` provider 是上游的**；绑定**两层不一致**：host 层 base bundle = **`one-shot`**，agent 层 shipped presets = **`continuable`** —— 见 §5） |
| 上下文 | **durable**；**不在时从它持久化的 Session 冷启**（cold-resume） | **继承父代"已完成回合"的前缀**，**创建时快照一次** |
| 持久化语义（原文） | — | *"The fork prefix is captured **ONCE**, at creation: it becomes part of the child's own durable transcript, so a later cold resume **replays that prefix** instead of re-forking the parent's newer history."* |
| 有 `report` 通道吗 | **有**（`dsh-tool-subagent-report`：`report` 工具 + `tool:report` system-prompt 段） | **shipped 配置里没有**（正是为了让子代请求头与父代逐字节相同） |
| 唯一收益 | "同一个主体跨任务持续" | **provider 侧前缀复用**（同 provider/model 下，前缀相同 ⇒ 不重新 prefill） |

**"可继续"的语义（`api-catalog.ts` 原文）**：
> send：*"Deliver one later message to a continuable child as its next FIFO turn. A **resident** child's Agent inbox accepts it directly (waking a `waiting` Activation), while an **absent** one is **cold-resumed from its persisted Session**."*

**子代树是 session-backed 且 durable**：`listTree` 能「枚举根的完整 **session-backed** 子 agent 树，稳定前序，
**且不加载也不恢复任何 Agent**」，每个条目带 `parentId` 与根相对 `depth`。
中断/关停的语义也都写明"**保留**未认领的 inbox 工作、Activation、已发布的子代"。

⇒ **结论①：有可持久化上下文，而且是设计出来的（不是副产物）。** 载体就是 **append-only 的 Session 日志**。

---

## 2. 回答①：「子 Agent 有不同的提示词和工具集」——**是天然的，而且就是两个一等字段**

上游有显式的能力声明 `SubagentCapabilities = { outputSchema, depthLimit, toolFilter, persona }`，
以及 `ContinuableSubagentDescriptorData { mode:'continuable', label, agentProvider?, agentModel?, **persona?**, **toolFilter?** }`。

**但能力因 provider 而异（这条必须知道，否则会静默退化）**：

| provider | persona（提示词） | toolFilter（工具集） | 备注 |
|---|---|---|---|
| **`fork-in-process`** | **✅** | **✅** | `capabilities = {outputSchema:true, depthLimit:true, toolFilter:true, persona:true}`；另有 `inheritsParentContext = true` |
| `acp` | ❌ | ❌ | `capabilities` 全 false；请求不被支持的能力**会被服务拒绝** |
| `dsh-sdk` | ❌ | ❌ | 同注：*"child cannot honor outputSchema/maxDepth/toolFilter/persona"* |
| `claude-code` / `codex` | — | — | 都是 *"Fixed … **one-shot** subagent provider"* |

⇒ **"每个子 Agent 自带提示词与工具集"是我们该走的形态，但必须绑到支持这两项的 provider（in-process fork）**，
并且**"支持"要用能力位去读，不是靠猜** —— 这又是一例铁律 #18 的同族（"看起来支持" ≠ "支持"）。

---

## 3. 回答②：「比单纯唤起子 Agent 更好吗？」——**分两半，答案相反**

### 3.1 做**进化**：更好，而且几乎是必需

- 一次性子调用是**无记忆的**：每次从零开始，经验无处沉淀 ⇒ **"进化"没有载体**。
- `continuable` child 才有"**同一个主体跨任务积累**"的可能；`send` 能唤醒它继续下一轮。
- ★ 而且它给了一个**可审计**的进化载体：**它每次唤醒都是一份 append-only 的会话**
  ⇒ "它学到了什么"是**可查的**，不像隐含在权重里的变化。
  ⇒ 这与我们的架构（`docs/revised-architecture-2026-09-20.md`：顶层专家评审团 / 下层子 agent 层，进化发生在下层）**天然对齐**。

### 3.2 做**判据**：有毒，必须显式关掉（**上游自己踩过同构的坑，并写成了架构决策**）

我们**今天刚建立**的干净自变量是：**固定 preset ⇒ 提示面一词不变（`systemChars` 46）、只变工具数（5 vs 77）**。
一旦被测子 Agent 带着**上次任务的上下文**开跑，**两次跑就不是同一个输入分布**：
- `pass^k` 测的是"重复"而不是"能力"；
- 臂间会出现**跨轮污染**（上一轮的经验带进下一轮）；
- 而且**污染不可见** —— 它在会话里，**不在工具面里**（我们的 `armFaceCheck` 现在看不见它）。
⇒ **判据侧必须用 `backgroundMode: one-shot`。**

**上游把这件事想得比我们清楚**（笔记原文要点）：
> fork 的唯一差别是子会话被**父代已完成回合的前缀**播种；那笔播种**真花 token**（继承的历史在每个子请求里重发一遍），
> 唯一的具体回报是**前缀复用**。任何**加在继承历史之前**的子作用域增量都会花掉这份回报，
> 因为"复用止于第一个不同的字节"。
> 而 `report` 工具 schema 与 `tool:report` system 段**都住在请求头**（system 块与 tool 块**先于所有消息**）
> ⇒ **continuable 的 forked child 在第一个继承回合之前就作废了复用**，把整份转录重新 prefill 一遍。
> ⇒ **所以 host 层的 base bundle 把 fork 绑成 `one-shot`；`spawn` 保留 `continuable`。**
> ⚠️ **但 agent 层的 shipped presets 仍写着 `continuable`**（同一个 id）—— 两层谁生效**尚未判定**，见 §5。

★★ **这段论证与我们今天的实测是同一件事**：我量到 **code 模式下工具目录被渲染进 `system`、占两臂净差的 98.7%**；
上游说的是 **"工具 schema 与 system 段都在请求头，且先于消息"**。
**两条独立证据指向同一个机制：请求头里的 system/tool 块是"前缀"的一部分，改它就等于改前缀。**

### 3.3 所以正确做法是**两个档位都留，并让档位可观测**

| 档位 | 用途 | 配置 | 判据 |
|---|---|---|---|
| **`one-shot`** | 评测/对照 | `backgroundMode: one-shot` | 必须**读得出**"这轮有没有继承上下文" |
| **`continuable`** | 进化 | `backgroundMode: continuable` | **按 lineage 统计**（不是按 run 统计） |

★ **判据不能只靠配置声明**（铁律 #18 同构："写了 continuable ≠ 这轮真带了上下文"）：
应在 `armFaceCheck` 一族里加一条**上下文指纹**（例如子会话**首条** `request/header` 的
system 长度 + 消息数 + 是否含 `report` 工具/section），让"继承与否"变成**可读读数**。

---

## 4. ★★ 一个我们能用的上游切口（而且我们已有工具）

**上游自己写了重开条件与实现位置**（笔记原文）：
- *"**The restriction is composition, not code**"* —— `ForkInProcessProvider.prepareContinuable` **仍实现着**，
  `ctx.subagents.startContinuable()` **仍接受 `fork`**；**只有 shipped `cordis.yml` 的那几行被改了**。
  ⇒ *"a bundle or `--patch` overlay can **reintroduce it with no code change and no warning**."*
- **重开条件 = issue #2124**：*"continuable fork reopens when **a child's system prompt and tool schemas can match its parent's byte for byte**."*

⇒ ★★ **这个条件正是我们今天在做的两件事的交点**：
1. 我们**已经会**把子代的请求头做成**可控且可测**的（`g0` = 46 字符 persona + 平台 gate 的 shell 组；
   `scripts/measure-arm-face.mjs` 能量 `systemChars` / `toolSetSize` / 工具名）；
2. 我们**已经知道**工具 schema 与 system 段是**请求头结构**（今天量到它们占了净差的 98.7%）。
⇒ **如果我们能证明"子代的 system prompt 与 tool schemas 与父代逐字节相同"，就满足了 #2124 的条件
⇒ 持久化（continuable）与前缀复用（fork）可以同时拿到。**
**而证明"逐字节相同"正是 `measure-arm-face` 这类工具的活。** 这条值得记：**我们的测量工具可以直接用来判上游 issue 的重开条件。**

---

## 5. ⚠️ 更正：**不是"我方偏离"，是【上游自己两层互相矛盾】**（我先前把归属搞错了）

**先纠正我先前写的那句"我方偏离"——错的。** 实测归属：

| 问题 | 答案 | 证据 |
|---|---|---|
| `subagent_fork` / `fork` provider 是我们写的吗？ | **不是，是上游的** | 我们 `packages/` 只有 `capability-bridge`/`conveyor-context`/`design-canvas-bridge`/`key-pool-proxy`/`skill-tree`/`subagent-council`/`switchboard`/`tool-evolution`；**没有任何 fork provider**（`subagent-council` 注册的是 `council-architect`）。fork 由 `@deepseek-ai/dsh-tool-subagent` + `@deepseek-ai/dsh-subagent-fork-in-process` 提供 |
| 我们 `council` 那段是哪来的？ | **逐字继承自上游 shipped preset** | 我们 `council` 的 `tool-subagent-fork` 段与 `node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml` **逐字相同**（含 `provider: fork` / `toolName: subagent_fork` / `backgroundMode: continuable`） |

**真相是：上游两个层用【同一个 loader id `tool-subagent-fork`】，但绑定不同：**

| 层 | 文件 | `backgroundMode` | 附注 |
|---|---|---|---|
| **host / deployment 层** | `packages/bundle/base/cordis.patch.yml` | **`one-shot`** | **带三行注释写明理由**：*"Fork stays one-shot: a continuable child's `report` tool and prompt section precede the inherited history a fork exists to reuse; one-shot fork children install neither, keeping the parent's request prefix."* |
| **agent / 会话层** | shipped presets `standard` / `code` / `cordis` | **`continuable`** | 同一个 id，**没有**注释 |
| （我们的） | `~/.dsh/.agent-presets/council` | `continuable` | = 继承 `standard` 那一层 |

**⇒ 而架构笔记自己列的是**：*"Every shipped composition binds the fork delegation tool to `backgroundMode: one-shot`: [the base bundle], [the ACP example], [the headless example]"*
—— **它列了 bundle 与两个 example，【没列 agent presets】**。⇒ 两种解释，**我无法从现有材料判定**：
- (i) 那次改动**漏改了 presets**（上游的遗漏/bug），或
- (ii) 两层各管一段、**preset 层对该 agent 生效** ⇒ 那笔记那句 *"no shipped composition creates a continuable forked child"* 就是**不准确的**。

### ★ 这直接影响你的设计意图（而且你的意图是对的）

你说：*"我当时设计这个 fork 的时候，是希望**主进程直接 fork 自己的上下文进去**，这样就能**省掉一笔让子进程理解上下文的开支**。"*

**这正是 fork 的用途**（上游笔记原话：*"its one concrete payoff is **provider-side prefix reuse**"*）。
⇒ **而满足这个意图的配置恰恰是 `one-shot`**：不装 `report`，子代请求头与父代**逐字节相同** ⇒ 前缀可复用、不必重新 prefill；
**`continuable` 会装 `report` 工具 + `tool:report` system 段，在第一个继承回合之前就把复用作废**
（笔记：*"pays fork's duplication cost and collects none of its benefit"*）。
⇒ **你的意图 = 上游 base bundle 的立场；与该立场冲突的是 upstream presets 那一层。**
⇒ **所以要改的是 `preset` 那层**（或先确认"到底哪层生效"）—— **不是"我们改错了"。**

### ★ 新问题（可验证，且正是铁律 #18 的同族）：**两层同 id，谁生效？**

这与我今天记的"多根配置、同 id 静默遮蔽"是同一族问题，**而我目前【没有】这条判据**。可验证路径：

1. **便宜**：读 mount 语义 —— agent preset 的行是否**覆盖** host 层的行？（`packages/preset/agent-presets` 的 mount/`isolate` 逻辑、cordis 的 scoped realm 语义）
2. **经验（推荐，且我们已有工具）**：**看一个 fork 子代的请求头里有没有 `report` 工具 / `tool:report` 段**
   —— **有 ⇒ `continuable` 生效；无 ⇒ `one-shot` 生效。**
   实现方式与我们现有 `measure-arm-face.mjs` 同路（读子代会话的 `request/header` 的 `tools[]` 与 `system`）。
   ★ **这正好是我先前建议要加的"上下文指纹读数"的第一个真实用例**，而且它**同时**回答了"哪层生效"。


---

## 6. 对本项目的净结论

1. **形态确认**：子 Agent = **自己的 persona + 自己的 toolFilter + 自己的持久会话** —— 这三件在 DSH 里都是现成的
   （前提：绑 `fork-in-process` 这个 provider）。**我们的"进化落到子 Agent"有现成地基。**
2. **两个档位都要**：进化用 `continuable`（并有**可审计的 append-only 证据**）；评测用 `one-shot`。
3. **上下文是"第三个隐藏变量"**：它既不在提示里也不在工具面里，但会毁掉可比性
   ⇒ **必须给它一条可读读数**（加进 `armFaceCheck` 一族）。
4. **一条可贡献的上游切口**：#2124 的重开条件（子代请求头逐字节相同），**我们已有测量工具能去证明它**。

---

## 7. 未验证 / 没把握

1. ~~我们 `council` 把 `subagent_fork` 设成 `continuable` 是"有意"还是"历史遗留"~~ ⇒ **已查清：是上游 shipped preset 的默认，我们逐字继承**（见 §5）。
2. ~~`dsh-tool-subagent-report` 在我们现役 profile/preset 里到底装了没有~~ ⇒ **已查清：在装配树里**（`--profile web --dump-config` 第 272 行，来自 base bundle）。
3. ★★ **【新的头号未闭合项】host 层与 agent 层同 id 冲突，谁生效？** —— 现有材料判不了（见 §5 的两种解释）。
   验证法已有：**看 fork 子代请求头里有无 `report` 工具 / `tool:report` 段**。
4. **"冷启"的实际行为未实测**（只在源码/文档描述层确认：`cold-resumed from its persisted Session`）。
5. `capabilities` 表里 `acp` / `dsh-sdk` 的 false 是**源码注释**（可能落后于实现）；未跑测。
6. 上游那份是**下载树不是 git clone**（无 `.git`）⇒ 行号会漂，引用请回仓库核对。
7. ★ **一处我自己的归属错误（已改正）**：我先前把"preset 里 fork=`continuable`"写成**我方偏离**，
   实际是**上游两层互相矛盾、我们只是继承**。教训与铁律 #17 同族：**先说清"这东西是谁的"再谈"谁错了"。**
