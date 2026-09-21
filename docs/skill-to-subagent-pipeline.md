# skill → 子 Agent：可行性评估（2026-09-21）

> 触发（用户）：「不是有一个 skill tree 吗？那个 SkillTree 不就是现成的 agent 吗？
> 你根据它**重新开发一版子 Agent** 可不可行？然后把这个开发过程**分成两部分**：
> 一是对 skill 里的**工具进行提取**，再和现有工具**整合**，或者**直接做新工具**；
> 二是**复用/整理收纳其中的提示词**。」
>
> **结论：可行，而且这不是外部设想 —— "可升格 sub agent" 是我们自己类型里的原话。**
> 但有 **两格必须先补**（§6），且有一条**工序边界**（§4）。

---

## 0. 一句话

`packages/skill-tree/src/index.ts:160` 的注释原文：

```ts
  // ── ch22 §6：工具声明（有 Script/Tools ⇒ 可升格 sub agent）──
  Tools: ToolDef[]
```

⇒ **"skill 有 Tools 就能升格成 sub agent" 早就写在我们的类型定义里了。**
用户提的两部分（工具 / 提示词）**正好就是 `SkillNode` 的两个字段族**：
**`Tools: ToolDef[]`** 与 **`Principle` / `Fix`（★ 实为提示词正文，见 §6#1）/ `Triggers`**。

---

## 1. 数据结构现状（逐字读的，不是推测）

`ToolDef`（`src/index.ts:21-36`）**是一份完整的工具定义，不是工具名列表**：

| 字段 | 含义 |
|---|---|
| `Name` | 工具名（全局唯一，建议前缀如 `scout_`） |
| `Description` | 给 LLM 看的描述 |
| `Kind` | `"python" \| "shell" \| "subprocess"` |
| `Entry` / `Fn` | 脚本入口（相对 skill 目录）/ 函数名或子命令 |
| **`Schema`** | **JSON Schema（注释写明：注册到 ToolRegistry）** |
| **`ReadOnly`** | 纯计算/查询、不改文件系统（注释：**跳过权限审批**） |

`SkillNode` 里与"升格"直接相关的字段：

| 字段 | 对"子 Agent"意味着什么 |
|---|---|
| **`Tools: ToolDef[]`** | **Part A 的输入**（工具声明） |
| `Principle` / `Fix` / `Triggers[]` | **Part B 的候选落点**（提示词/路由），`Triggers` 注释就是"路由依据" |
| `Script` / `ScriptLang` / `Archive` | 配套脚本与归档 |
| `Extends` / `Requires[]` | **继承**（父的 body+triggers+script）/ **组合**（一层深，拉入依赖） |
| `Level`（0/1/3，L3 = score≥0.7 ∧ use_count≥10）/ `Score` / `UseCount` / `SuccessRate` / `ValidationScore` / `LastValidated` | ★ **现成的"进化账本"** |
| `EditHistory: EditRecord[]` / `MergedFrom` / `AbsorbedBy` / `RejectedAttempts` / `Exclusive` | ★ **现成的"谱系与合并账本"** |
| `SkillStatus`（active/demoted/archived/**absorbed**）/ `SkillSource`（learned/user/community/shared）/ `AbsorbOutcome`（0..3 + 我们补的自环 4） | ★ **现成的生命周期** |

**当前实现状态（`src/skill-tree.ts:11` 自述）**：*"本文件**只做数据层**：`GetActiveSkills` / `nodeToSkillEntry`"*
⇒ **数据层是真的（`load`/`save`/`SkillTree` class/epoch 都在）；执行器（注入/委派）刻意没做**（`src/executor` 不存在）。
⇒ **所以"要写的就是那个适配器"**，不必碰 skill-tree 内部。

---

## 2. Part A：工具（提取 → 整合 / 新建）

`Tools: ToolDef[]` 逐条按**三档**处置：

| 档 | 判据 | 动作 | 落点 |
|---|---|---|---|
| **① 已有等价** | 父代工具面里已有同名/同能力工具 | **不注册**，只把它写进该子代的 **`toolFilter.allow`** | 子代的委派参数（per-delegation，今天已实测可裁 103→3/98/1） |
| **② 部分覆盖** | 现有工具能做但差参数/差语义 | **整合**：改造现有工具，或**组合**（`Requires[]` 一层深，今天类型里已有） | 现有插件 / `Requires` |
| **③ 没有** | 父代工具面里不存在 | ★ **按 `ToolDef` 写新工具**（`Kind`+`Entry`+`Fn`+`Schema`） | ⚠️ **必须落 profile/preset —— 见 §4** |

## 3. Part B：提示词（复用 / 整理收纳）

- **提示词正文 = `Fix` 字段**（★ Go 侧注释原文 `Body (Fix)`，见 §6#1 —— 别被名字误导，它不是"修复说明"）
  + `Principle` + `Triggers` → **整理成该子代的 `persona`**（委派工具参数，per-delegation）。
- **`Triggers[]`** → **路由依据**：*"什么时候该派这个专项"* —— 它本来就叫"路由依据"，可以直接当**派发判据**。
- `Extends` → **子代继承父 skill 的提示词**（类型注释已承诺：子继承父的 body + triggers + script）。

⇒ 于是 **Part A + Part B 合成一个子 Agent**，而"子 Agent 是什么"**今天已经实测**：
**`(preset, persona, toolFilter)`**（preset 继承父代；persona/toolFilter 逐次委派可给）。

## 4. ★★ 更正：**"只能裁"不是缺陷，裁就是子代理存在的理由**

> 用户 2026-09-21 指出：「**如果只能裁不能加，那父代为什么需要委派给子代理？**
> 子代理主要是为了解决**一个 Agent 对其暴露的工具过多、导致其心智收益非常低下**的问题。
> 所以就应该**专项的 skill、或者专项的 Agent 去读取专项的工具**才对。」
>
> **⇒ 用户说得对。我上一轮把"`toolFilter` 只能裁"写成"硬边界（阻碍）"，框错了 —— 裁正是目的。**

### 4.1 "工具过多 ⇒ 心智收益低"**不是感觉，有机制**（我们今天量到了）

**code/PTC 模式下，工具目录是被【渲染进 system prompt】的**：
把 `exp-base`（102 工具）与 `exp-base-nodc`（30 工具）的 system 做行级 diff ——
**8 个纯删除块合计 39 284 字符 ≈ 净差的 98.7%，全部是工具目录内容**
（最大单块 **27 350 字符** = 那批 MCP 工具的 guidance + `ToolArgsMap`）。
⇒ **"我的工具多"的直接代价 = 每次请求都为那批工具的说明付 token。**
⇒ **所以"把专项工具交给专项 Agent"，收益是【实打实的 token 与注意力】**，不是修辞。

### 4.2 两件事必须分开（这是修正的核心）

| 轴 | 动作 | 治谁的病 | 频率 | 要不要判据 |
|---|---|---|---|---|
| **专项化（分工）** | **裁**：`toolFilter.allow/deny` ⇒ 子代**只看它那几件**（实测 103 → **3** / **98** / **1**） | **子代**的负荷 | **每任务都做** | ❌ **廉价、无风险、无需过门** |
| **能力增长（进化）** | **加**：新工具 → 写插件 → 挂 **profile/preset** | **所有人**的面 | **低频** | ✅ **必须过 L0–L4** |

⇒ **把两者混在一条"工序"里（我上一轮的写法）是误导**：**裁**是**常态动作**，**加**是**进化产物**。

### 4.3 ⚠️ 但有一个**必须说清的坑**：**委派【不减小父代自己的面】**

实测：`allow`/`deny` 只作用于子代 —— **父会话自身仍是 102 个工具**。
⇒ **若"心智收益低下"的受害者是【父代/编排者】，那委派治不了它。**
⇒ **要治编排层的负荷，只有改 `profile` / `preset`**（三层的第①、②层）。
⇒ **所以两个动作各治一种病，缺一不可**：
- **裁** ⇒ 子代窄 ⇒ **执行**好；
- **改 profile/preset** ⇒ 父代窄 ⇒ **编排**好。

### 4.4 ★ 由此得到一条结构原则（**取舍，不是默认**）

**父代该宽（路由与评审需要广视野）还是该窄（不被自己的面拖累）是一个要做的取舍** —— 今天的数据给出了**它的价格**：
**在 code 模式下，多 72 个工具 ≈ 每次请求多 39 800 字符（≈13k token）。**
⇒ 合理的默认是**"上层宽、执行层窄"**：**编排/评审层承担宽面的成本（它需要广度来做路由与评价），
执行层一律窄面**（由 `toolFilter` 裁到刚好够用）。
⇒ 而"父代自己动手做"这件事，**恰恰是最该避免的**（它有最宽的面、最差的信噪比）。

### 4.5 "专项"的可测定义（对齐用户原话："专项 skill → 专项 Agent 读专项工具"）

**`toolFilter.allow` 列出的就是那个专项的完整暴露面**，而它必须**同时**满足两条 —— **都能测**：

| 判据 | 怎么测（现成工具） |
|---|---|
| **① 面够小** | `scripts/measure-arm-face.mjs` ⇒ `toolSetSize` / `systemChars` |
| **② 面够用** | 该专项的 oracle（任务能不能做成） |

⇒ ★ 这两条构成**一个新的、可测的判据对**：**"专项化的收益"（面变小）与"专项化的代价"（会不会不够用）** ——
而**它俩正好是同一个改动的一正一反**，所以**必须成对报**（只报"面小了"就是假绿：可能只是把活干不了了）。


## 5. ★ 顺带确认：**权限那套只要一个布尔**

`ToolDef.ReadOnly` 的注释原文：*"true = 纯计算/查询，不修改文件系统（**跳过权限审批**）"*。
⇒ 印证上一轮的结论：**权限审批那套是为"审查每个调用"服务的**；
我们**只要 `ReadOnly` 这一个布尔**（作为**度量**的一个维度），**不要审批流**。

## 6. ⚠️ 缺的三格（**先补这些，再写适配器**）

| # | 缺什么 | 结论 | 建议 |
|---|---|---|---|
| ~~1~~ | ~~`body` 字段（提示词正文）在 TS 侧不存在~~ | ★ **不是缺口 —— 我查错了，已更正**：Go 侧 `SkillNode` 也**没有 `Body`**，但 `agent-shell/internal/memory/skill_import.go:462` 的注释写着 **`Body (Fix)`** ⇒ **提示词正文就是 `Fix` 字段**（`skill_tree.go:33`；TS 侧 `src/index.ts:127` 已移植）。`Extends` 注释说的"继承父的 body"= **继承父的 `Fix`**。 ⚠️ **命名坑：`Fix` 不是"修复说明"，它是正文/方法论** —— 按字面读会理解反（`Body` 那个字段名属于**知识条目**：`knowledge.go:47`，不是 skill 的） | **不必补字段**；但要在 TS 侧给 `Fix` 加一条"实为 body（正文）"的注释，防后续误读 |
| **2** | **执行器（注入/委派）为空** | `src/skill-tree.ts:11` 自述"只做数据层"、刻意不含执行器；`src/executor` 不存在 | 这正是"**升格**"要写的东西：`SkillNode → (persona, toolFilter) + 委派调用` |
| **3** | **没有"skill 目录"的真实数据** | 数据层是 `load(snapshot)`，快照从哪来未在本次核 | 先用 1 个**手写**的 `SkillNode` 走通（别等整棵树） |

## 7. 建议的第一步（可证伪、便宜）

**拿一个真实 skill，走一遍"升格"，产出可测量的子 Agent：**

1. 手写 1 个 `SkillNode`（`Tools[0]` 指向**已有工具**避免碰 profile；`Triggers` 填一个路由条件）；
2. 写**适配器**（`SkillNode → {persona, toolFilter}`）；
3. **委派一次**，用 `measure-arm-face.mjs` 读子代的 `systemChars` / `toolSetSize` / 工具名 ⇒
   **验证"这个子 Agent 的面 = skill 声明的面"**；
4. 记账：**子代身份指纹**（preset / persona hash / toolFilter / systemChars / toolSetSize / `delegationDepth`）。

⇒ **成功判据**：子代工具面**恰等于** `toolFilter.allow`（今天已验证这条机制成立），且 `systemChars` 随 persona 变化。
⇒ **若成功**，就得到了**第一个"由 skill 定义的专项子 Agent"**，而且它**可测、可比、可记账**。

## 8. 诚实清单

1. ~~`body` 的归属未确证~~ ⇒ **已查明并更正**：**`body` = `Fix` 字段**（Go 侧 `skill_import.go:462` 原文 `//  2. Body (Fix): …`），
   **TS 侧已移植，不是缺口**。我先前写"可能是移植缺口"**是错的**（先怀疑后核实的又一次）。
2. **"`Tools` 的 Schema 能直接喂给 DSH 的 `ctx.tools.register`"未验证** —— Go 的 ToolRegistry 与 DSH 的工具注册**未必同构**。
3. **`Triggers` 当路由判据是否够** 未验证（它只是字符串数组，没有匹配语义）。
4. **TS 侧 `Fix` 字段目前没有"实为正文"的注释** ⇒ 容易被后人理解成"修复说明"（本次我就差点那么读）。
5. `SkillNode` 的 33 字段我是**通读类型文件**得到的；**Go 侧 `skill_tree.go` 我只查了 `Principle/Fix/Triggers/Body` 四处**，未系统核对其余字段。
6. 本文**未改任何代码**；`packages/skill-tree` 现状未动。

---

## 9. ★★★ 用户的完整构想 + 评估（2026-09-21，含**一处硬冲突**）

> 用户原话（要点）：
> ① **「对于 Agent 来说，子代理不就是原来的 skill 吗？」** —— 他只要**读到 skill**，
>    **渐进式披露**读这个 Agent 的能力，然后**委派下去**即可。
> ② 「我之前提过一个机制：**动态暴露当前有什么技能** —— **往后面注入**，**当压缩的时候再在前面合并**，
>    最开始有多少、后面减到多少，这样一个**动态增减**机制。」
> ③ 于是可以「**既复用 fork 的父类 Agent 的上下文**，又让上下文意识到**自己进入了子代模式、工具面变成了子代的面**」
>    ⇒ **子代很快地理解现状**。
> ④ 最终：**父类像调用 skill 一样调用子 Agent；子 Agent 直接从父类上下文了解现状 + 知道自己最新的工具能力面** ⇒ 完成任务。

### 9.1 这个构想**把今天的零件全串起来了**，而且每一件都已落地或已实测

| 构想里的部件 | 现成的东西 | 状态 |
|---|---|---|
| **片 skill 当入口** | `tool-skill` 已提供 **catalog + loader**（preset 注释原文：*"gives them the catalog and loader"*）；skill 正文 = `Fix` 字段 | ✅ 已有 |
| **渐进式披露"这个子代理的能力"** | `SkillNode.Tools: ToolDef[]` + `Principle/Fix/Triggers` ⇒ **读一条 skill 就拿到它的工具声明与人格** | ✅ 数据层已有 |
| **"像调 skill 一样调子 Agent"** | 委派工具 = `subagent`（`persona` + `toolFilter` 逐次可给） | ✅ 已实测 |
| **子 Agent 有自己的工具面** | `toolFilter.allow/deny`（实测 103 → 3/98/1） | ✅ 已实测 |
| **子代继承父代上下文** | `fork` provider（`inheritsParentContext = true`） | ✅ 上游已有 |
| **记账/谱系** | `delegationDepth` 持久化 + `SkillNode` 的 `Level/Score/EditHistory/MergedFrom` | ✅ 已有 |

### 9.2 ★★★ 一处**硬冲突**：**"省 token 的上下文复用" 与 "子代有不同工具面" 不能同时拿到**

**必须先把"复用上下文"拆成两个不同的意思**：

| | **token 上的复用**（provider 前缀缓存） | **语义上的复用**（子代不用重新摸索） |
|---|---|---|
| 要求 | **请求头逐字节相同**（上游原文：*"复用止于第一个不同的字节"*） | **只要子代能"看到"父代的历史** |
| 而工具面在哪 | ★ **在请求头里**（system/tools 块） | 无关 |
| ⇒ 与"子代有自己工具面" | ❌ **互斥**（工具面变 ⇒ 前缀失效） | ✅ **完全兼容** |

⇒ **用户要的是第 2 种**（*"子代直接从父类上下文中了解现状"*）—— **它成立，而且节省更大**（省的是**子代重新摸索的轮次**，不只是 prefill）。
⇒ **但账要按"省轮次"算，不能按"省 prefill"算** —— 否则会去优化一个本来就拿不到的东西。

**⚠️ 由此要回头复查我们今天的一个决定**：我们把 `subagent_fork` 从 `continuable` 改成了 **`one-shot`**，
理由是**保前缀复用**。而**若采用本构想（子代有 `persona`/`toolFilter` ⇒ 请求头必然不同）⇒ 那个前提不成立**，
⇒ **该决定的依据要换成别的判据**（例如：**子代要不要能被后续唤醒 / 要不要 `report` 通道**），
**不是**"能不能保前缀"。**（列为待重新裁定项，不擅自回退。）**

> ★★ **但用户随后给出了破解办法（见 §9.3）：把 header 的变更对齐到"本来就要重算的时刻"（压缩 / 换代），
> 在那之前用【尾部注入】顶着。⇒ 于是"立刻的行为引导（保前缀）"与"最终的真裁剪（代价≈0）"可以【都要】。**


### 9.3 ★★★ 更正：**"改工具面"是【能】的，而且能不以额外代价改**（用户 2026-09-21 反驳，我上一轮说错）

> 用户：「**为什么不能改工具面呢？** 变成子 Agent 时，**先 fork 父上下文**，然后**后面注入一条提示**：
> 『您现在的上下文为父类上下文所复制的上下文，后续您能用到的工具集是……』，把**子 Agent 暴露的能力面**告诉他；
> 然后**在下一次压缩的时候，才把前面父类上下文的那个工具面清掉** —— 因为那时候就不重要了。
> **子类只需要知道当前实时的自己能用什么不就 OK 了吗？**」

**⇒ 用户对，我上一轮把"代价"说成了"不能"。而且这套机制里有一处我没想到的聪明之处。**

#### (a) 修正：代价只在"不在重算点改"时存在

我上一轮说*"改工具面 = 改请求头 = 必付一次 prefill"* —— **对，但只在"不在压缩/换代点改"的时候。**
而**压缩本身就是一个前缀改写源**（我们自己的文档原文：*"命中率不是被「压缩质量」拖低的，是被「**前缀改写频率**」拖低的"*、
*"prune 的剩余收益只是延迟压缩，而**它自己每次都是一次前缀改写**"*）。
⇒ ★★ **用户的机制 = 把 header 的变更【对齐到"本来就要重算的时刻"】** ⇒ **额外代价 ≈ 0。**
（换代同理：换代本来就要重算。）

#### (b) 两段式时间线（把用户的机制写成可实施形态）

```
T0  父代（宽面）
T1  委派：fork 父上下文
     ＋ 【尾部注入】"你现在是子代；你当前可用的工具是 X"     ← 在 messages 里 ⇒ 【保前缀】、立刻生效
T2  子代执行（header 仍是父代的面 ⇒ 前缀未断）
T3  【压缩点】（本来就要重算）⇒ 此时才真裁剪 header ＋ 清掉旧的工具面指引   ← 代价 ≈ 0
T4  此后子代 header = 窄面（与父代不同头，但前缀反正刚被重置过）
```

⇒ **所以"能不能改工具面"的答案是：能，且能不以额外代价改** —— **改动对齐到压缩/换代点；在那之前用"尾部告知"顶着。**

#### (c) ⚠️ 但有两条必须说清（否则会误以为"告知"能替代"裁剪"）

**① "告知" ≠ "限制"**：`tools[]` 没变 ⇒ **模型仍【能】调用未授权的工具**。
| 手段 | 治什么 | 不治什么 |
|---|---|---|
| **尾部"告知"**（在 messages） | **行为引导**：少选错、少越界 | **不减少暴露**（父代的 schema 仍在请求里，仍占 token/注意力） |
| **header"硬裁剪"**（`toolFilter`） | **真的减少暴露**（可调用面 + token + 注意力） | 不改行为意图（模型不知道"为什么少了"） |
⇒ 对**自进化**（要的是信噪比）**告知够用**；对**防误用**（安全）**不够**。

**② ⚠️ 实现前提（本轮新核实的）**："**压缩时清掉旧工具面指引**"要求**压缩器能改 `system` 段** ——
而**我们现役的 compaction 补丁处理的是 `input.messages`**（补丁里 `_foldChunks(input,…)`，遍历 `input.messages`），
**而工具面指引在 `system` 里**（今天实测：`tool:subagent_fork` 段改一次，父会话 system 少 365 字符 ⇒ 它在 system）。
⇒ **"压缩时清 system 段"这个能力目前【没有】** ⇒ 要么扩展压缩器、要么换别的清法。**列为前提，不是结论。**

### 9.4 ⇒ 修正后的实施形态（把 §9.2–9.3 的结论吃进去）

```
父代（宽面，做路由/评审）
  │  ① 读到 skill（catalog + 渐进式披露）⇒ 拿到该专项的 {persona 来源: Fix, 工具面: toolFilter.allow}
  │  ② 委派：subagent( persona = Fix, toolFilter = allow, … )
  ▼
子代（窄面，做执行）
  ├─ 上下文：fork 继承父代历史 ⇒ 【语义复用】立刻懂现状（不追求前缀复用）
  ├─ 工具面：**T1 先用【尾部告知】顶着（保前缀）；T3 到压缩/换代点才真裁剪 header（代价≈0）** ← 见 §9.3(b)
  └─ 技能注入：动态增减放在【消息尾部】⇒ 不影响任何前缀
```

**判据（成对报，防假绿）**：
| 面 | 判据 | 现成工具 |
|---|---|---|
| **收益** | 子代 `toolSetSize` / `systemChars` 显著小于父代 | `scripts/measure-arm-face.mjs` |
| **代价** | 子代仍能完成该专项任务 | 该专项的 oracle |
| **（新增）复用收益** | 子代**首次请求的轮次/延迟**是否显著低于"不 fork 的同类子代" | 同 oracle 下 A/B（fork vs spawn） |

⇒ ★ **第三条是这次新增的、也是用户构想的核心卖点**：
**"继承上下文"到底省了多少？** 它**必须与"不继承"的子代做 A/B** 才量得出来 ——
而那正是我们今天建立的那套成对装置（同 preset / 同 toolFilter / **只差 fork vs spawn**）。

### 9.5 未闭合

1. **`subagent_fork` 的 `one-shot` vs `continuable` 要按新判据重裁**（见 §9.2 末）。
2. **"渐进式披露子代理能力"是否需要新的工具**：`tool-skill` 现在披露的是**技能**；
   若要让"子代理"也走同一条路，需要**技能目录里能列出可用的专项子代理**（= `SkillNode` 树 + `Triggers` 当路由依据）—— **未验证可行性与成本**。
3. **`Triggers` 的匹配语义**未定（现在只是字符串数组）。
4. **fork 与 persona/toolFilter 同时使用**在 DSH 上**是否被允许**（上游把 fork 绑到 one-shot，而 `toolFilter`/`persona` 是支持的）—— **未实测**。

---

## 10. ★★★ 两项更正 + "改写 system"的正确钩子（2026-09-21，用户反驳后的核实）

### 10.1 更正：**子代理不是"父代的裁剪"，而是"父代 + 它自己的专有工具"**

> 用户：「**我们不是说子类是父类的裁剪，而是父类的增加**。少不少其实也无所谓 ——
> **父类能用的东西不一定比子类多**。」

**⇒ 用户对，而机制是清楚的**：

| 层 | 谁决定 | 能否 ≠ 父代 |
|---|---|---|
| **子代的"基础面"** | **子代自己的 `preset`**（`CreateAgentOptions.meta.agentPreset` ⇒ **宿主侧可指定**） | ★ **能** |
| **子代面之上的再裁剪** | `toolFilter.allow/deny`（委派参数） | 只能在这两者之内 |

⇒ **所以"加"是可行的，机制是"给子代一份【专属 preset】"，不是 `toolFilter`。**

**⚠️ 这撤掉我两轮前的"硬边界"**：我曾说*"新工具必然要加宽**父代**的面"* —— **错**。
正确的是：**专项工具挂在【子代专属 preset】上，父代完全不背这个成本** —— 这比我原设想的方案**好得多**。

**修正后的模型（对子代）**：**子代 face =（它自己的 preset 装配）→ `toolFilter` 再裁**；
而"它的 preset"可以是**专为这个专项写的一份**（这就是"专项 skill → 专项预设 → 专项 Agent"的落点）。

### 10.2 ★★ "改写 system"的**正确钩子不是压缩器**，而是 **child-scoped 的 `system-prompt/assemble` waterfall**

用户说「**扩展压缩器，写一个子 agent 专用的压缩器，在原基础上加一个改写 system 的功能**」。
我核实后发现**有一个更省、且上游明文支持的做法**：

**证据（我逐个 grep 过）**：

| 证据 | 出处 |
|---|---|
| `system-prompt/assemble` waterfall **真实存在且是常规扩展点** | `node_modules/@deepseek-ai/dsh-agent/lib/index.js:273`（`agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => …)`）；`dsh-agent-presets/lib/invariant.js:1164` |
| ★ **事件带 `scope`** ⇒ **可做 scope 化 listener** | `dsh-scope/lib/invariant.js:30`：`"system-prompt/assemble": (args) => args[1]["scope"]` |
| ★★★ **上游明文：子作用域的 listener 可以【替换】子代的 system 贡献** | `dsh-subagent-in-process-driver/README.md:43`：*"Both contributions are ordinary **child-scoped registrations**. An expert `system-prompt/assemble` listener **may replace them** and therefore **owns preserving the structured-output protocol for that child**."* |
| **压缩引擎是抽象类，要自己实现三个方法** | `compaction/compaction/src/index.ts:96` `abstract class CompactionEngine extends Service` ⇒ `compactIfNeeded` / `compactNow` / `compactRegion` |
| **压缩 = 对 surface 区间做 replace，并发出事件** | `compaction-basic/src/region.ts:463` `surfaceOp: { op: 'replace', start, end }`；`compaction/src/types.ts:74` 提到共用的 **surface `replace` 事件** |

⇒ **⇒ 两个部件分工，实现量小得多**：

| 部件 | 职责 | 工作量 |
|---|---|---|
| **`system-prompt/assemble` child-scoped listener**（**新写，小插件**） | **怎么改**：把该子代的 system 段替换成"你现在的工具面是 X"的版本 | ★ 小 |
| **压缩引擎**（现有 `compaction-basic` + 我们的补丁） | **什么时候改**：它发 `surfaceOp: replace` 事件 ⇒ **用它当触发器** | 已有，**不用重写** |

⇒ **不必重新实现 `CompactionEngine` 的三个抽象方法**；把"时机"交给压缩事件、把"改写"交给 listener 即可。

**⚠️ 两条必须遵守的约束（上游明文/机制推论）**：
1. ★ **替换者要负责保住该子代的 structured-output 协议**（上游原话 "owns preserving the structured-output protocol for that child"）
   ⇒ 若该子代用 `outputSchema`，替换 system 段时**不能把它的协议段删掉**。
2. ★ **必须 scope 化**（事件带 `scope`）⇒ **只对本子代生效，绝不许污染父代**（否则就是"改父代的面"，破坏父代的前缀与行为）。

### 10.3 未闭合（新增）

1. **`system-prompt/assemble` listener 能否在"压缩之后"才替换**（即用户说的"下一次压缩时才清掉"）——
   机制上：listener 每次装配都会跑 ⇒ **"何时切换"要靠它自己读状态**（如该子代的压缩计数/`delegationDepth`）⇒ **需要设计一个"切换条件"**，**未设计**。
2. **`surface replace` 事件的订阅名与载荷**未核（只知道有 `surfaceOp` 字段）。
3. **本方案 A（扩压缩器）与 B（listener + 压缩事件触发）的取舍** —— **我建议 B**，但**待用户拍板**。
