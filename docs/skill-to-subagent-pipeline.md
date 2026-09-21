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
