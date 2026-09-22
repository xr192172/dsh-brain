# O45 落点设计：Go 侧技能导入的「门」

> **一句话**：Go 侧现在**没有门**（导入即 `active`），而要补这道门，**必须同时改三处** ——
> 否则门就是**装饰**（改了导入处、注入处不认）。
>
> 依据：`docs/skill-as-agent-spec.md` §29.3 / O45；`docs/memory-asset-triage.md:169`（已裁决"导入后视为**候选能力**而非注入物"）。
> **本文件只定落点与验收门，不改任何代码**（跨仓变更，`ai-base` 是另一个仓）。

---

## 1. 我核过的现状（逐字）

| 位置 | 逐字事实 |
|---|---|
| `internal/memory/skill_import.go:398` | `Status: "active",` ⇒ ★ **导入即 active，没有 `pending` 态** |
| `internal/memory/skill_import.go:447-448` | `if node.Status == "archived" { node.Status = "active" }` ⇒ ★ **重新导入会把 `archived` 复活为 `active`** |
| `internal/memory/skill_tree.go:1054+` `GetActiveSkills` | `if node.Status == "archived" { continue }`（**只排除 archived**）<br>`l0 := node.Score > 0.7 && node.UseCount > 10 && node.Status == "active"`（**L0 要求 active**）<br>★ **L3（triggers 命中 taskHint）分支【不检查 Status】……** |
| `internal/context/active_skills_injection.go:10/58` | 注入内容 = **`GetActiveSkills` 返回的 `score>0.7 ∧ use>10` 的稳定 skill**；调用点 `m.activeSkills.GetActiveSkills("", brain)` ⇒ ★ **注入实现在 `internal/context`，不在 `memory` 包（跨包）** |

### ★★ 由此得到的**关键结论（这就是"门会被绕开"的位置）**

**路径有两条，一条看 Status、一条不看**：

| 路径 | 条件 | 是否检查 `Status` |
|---|---|---|
| **L0**（高分配稳定技能） | `Score>0.7 ∧ UseCount>10` | ✅ **要求 `Status == "active"`** ⇒ 改成 `pending` 后**不会**走这条 |
| ★ **L3**（触发词命中） | `Triggers` 命中 `taskHint` 关键词 | ❌ **完全不检查** ⇒ ★ **`pending` 的技能照样会被注入！** |

⇒ ★★★ **⇒ 所以"只把导入处改成 `pending`"= 装饰门**：只挡住了 L0 那条路，L3 那条路照走。

### ⚠️ 顺便更正我自己在 spec §29.3 的一处措辞

我在 §29.3 写了"**导入即可注入 prompt**" —— **不够精确**：
- 新导入的 `Score = initialScore(source) ≤ 0.6`（`user .60 / community .55 / learned .30`）且 `UseCount = 0`
  ⇒ **L0 不成立**；
- **但若它带了会命中 `taskHint` 的 `Triggers`，L3 成立 ⇒ 仍会被注入**。
⇒ **精确说法：导入即 `active`；是否被注入取决于（score/use 或 triggers），【其中一条路径不看 Status】。**
（更正已写入 spec §30；§29.3 的措辞按此读。）

---

## 2. 落点：**三处 + 两个前置**（缺一即装饰）

| # | 位置 | 现状 | 改法（方向） | 为什么必须改 |
|---|---|---|---|---|
| **(a)** | `skill_import.go:398` | `Status: "active"` | ⇒ **`"pending"`** | 门存在的前提 |
| **(a′)** | `skill_import.go:447-448` | `archived` → 复活成 `active` | ⇒ 复活到 **`pending`**（重新导入不等于重新采纳） | 否则"复活"这条路绕开门 |
| **(b)** | ★ **`skill_tree.go:1054+` 的 L3 分支** | **不检查 Status** | ⇒ **L3 也必须要求 `Status == "active"`**（或显式排除 `pending`） | ★ **这是门"被尊重"的关键；不改它，(a) 无效** |
| **(c)** | **判据处**（谁把 `pending` → `active`） | **不存在** | ⇒ 接到门：**TS 侧 `capability-gate`（L0/L1）** 或 Go 侧等价；并要有**回执位** | 没有 (c)，`pending` 永远出不去 ⇒ 技能全废 |

**前置一：状态词汇表要定单一来源。**
Go 侧现在**没有集中定义**，全是散落字面量：`"active"` / `"archived"` / `"invalidated"` / `"suspicious"` /（注释里的 `update_pending`）。
⇒ ★ **先定一处常量/枚举**（至少在 `internal/memory` 内集中），否则"再加一个字面量"只会**更散**。

**前置二：与 TS 侧语义对齐（这是 O30/O45 的交汇点）。**

| 概念 | TS 侧（`capability-registry`） | Go 侧现状 | 对齐方向 |
|---|---|---|---|
| 状态 | `pending` → `active`（**注册 ≠ 采纳**） | 只有 `active`（无 pending） | Go 侧补 `pending` |
| 回执 | `acceptance{kind,status,proofLevel,unenforced}` | **无对应物** | Go 侧要有一个"回执位"（哪怕先只记 `proofLevel`） |
| 版本/淘汰 | `supersededBy` / `retire` | 近似物 `AbsorbedBy`/`MergedFrom`/`Status:"archived"` | 先不做映射，**记下来**（不要假装能对上） |

---

## 3. 验收门（**这道门"真的被尊重"怎么证**）

| # | 门 | 判据 |
|---|---|---|
| 1 | **L0 路径被封** | 构造 `Score>0.7 ∧ UseCount>10 ∧ Status="pending"` 的条目 ⇒ **断言它不出现在注入文本里** |
| 2 | ★ **L3 路径被封（最关键）** | 构造 `Status="pending"` 但 **`Triggers` 命中 `taskHint`** 的条目 ⇒ **断言它不出现在注入文本里** |
| 3 | **active 仍能通过（阳性对照）** | 同两条，只把 `Status` 改成 `"active"` ⇒ **断言它们【出现】**（否则门是"全封"，不是"按状态筛"） |
| 4 | **重新导入不复活** | 造一个 `archived` 条目 ⇒ 重新导入 ⇒ 断言它变成 `pending`（**不是 `active`**） |
| 5 | **回执位可读** | 过门后 `Status` 变 `active` 且**有可读的回执字段**（`proofLevel` 至少） |

★ **门 3 是"防过度封锁"的阳性对照**（与铁律 #13/#18 同族：**否定性断言必须配阳性对照**，否则"全封"也能过门 1/2）。

---

## 4. 与既有未闭合的关系

- **O45（本文件）** ⇒ 是 **O42（记忆效果判据）的前置**：门不存在时，"测效果"测的是**未经筛选就被注入的东西**；
- **O30**（两条材料线的关系）与 **前置二** 是同一件事的两面：**Go 侧 skill 与 TS 侧 capability 的状态/回执语义要对齐**；
- **O40**（跨仓纪律）适用：**允许改的只应是 `internal/memory/` 内的状态设置点 + `skill_tree.go` 的筛选**，
  且**必须先弄清 `ai-base` 仓里"上游只读"的边界到底划在哪**（`memory-asset-triage.md` 称 `internal/memory/` 为只读上游
  —— **但 O45 恰恰要改它**）⇒ ★ **这是一处必须先澄清的矛盾**（新增 **O47**）。
