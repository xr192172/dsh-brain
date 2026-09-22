# 门契约（人读版）

> **机器可读形式**：`evals/gate/contract.json`（Go 侧将来直接读它）。
> **校验器（可执行的门）**：`node scripts/gate-contract-check.mjs` / `--selftest`。
> **本文件与 contract.json 是同一份契约的两种写法**；有冲突时以 `contract.json` 为准（校验器只认它）。
>
> 设计依据：`docs/o45-import-gate-landing.md`（§2 落点 / §3 验收门）、
> `docs/skill-as-agent-spec.md` §30/§31/§32（§32.2 既有范式 / §32.3 状态读取点清单）、
> `docs/memory-effect-judge-design.md` §7（读 + 写 + 条目数）。
> TS 侧参照：`scripts/capability-registry.mjs` / `scripts/capability-gate.mjs`（**注册 ≠ 采纳**）。

---

## 0. ★★ 第一条纪律：「门」是策略 ⇒ 必须走接口 + 集中词汇表，不许写死字面量

`ai-base/AGENTS.md:196-204`「禁止行为」第 **4** 条逐字：

> **4. 不硬编码策略（压缩策略、融合算法、评分维度等必须走接口）**

**读法（这就是 O45 前置一在 Go 侧的对偶）**：

- 「门」——**准进门、进门后算不算数、算数了能不能被注入**——是**策略**，不是实现细节；
- ⇒ 因此 **`skill_import.go` 里不许写死一个 `"pending"` 字面量了事**，`skill_tree.go` 的 L3 分支里也不许写死
  `Status == "active"`。这些**字面量与判定条件都必须集中声明**（本契约的 `states.values` /
  `transition.rules` / `visibility.rules`），由实现**通过接口读取**。
- ⇒ 这正是本目录存在的理由：**把策略从代码里搬到契约里**，让"改策略"= 改一份 JSON，而不是**散落着加字面量**。
- 现状（反例）：Go 侧状态**没有集中定义**，全是散落字面量 —— `"active"` / `"archived"` /
  `"invalidated"` / `"suspicious"`（注释里还有 `update_pending`）⇒ **再加一个字面量只会更散**。

**同一份文件里与我们相关的另两条**（`§31.2` 已核）：

| 条 | 原文 | 对本契约的约束 |
|---|---|---|
| 2 | 不直接读写 `graph.json`（必须通过 `GraphWriter` channel） | 状态迁移的写入**不许自己开旁路**；照抄既有范式（见 §32.2 对应表） |
| 5 | 不跨层调用 —— Agent 不直接调 `ContextManager` 的内部 Layer，不直接调 `Memory` 的 `VectorStore` | DSH 侧够过去只能走**面**（MCP），不摸内部 |

---

## 1. ① 状态词汇表（单一来源）

```
pending | active | archived | invalidated | suspicious
```

| 状态 | 含义 | 来源 |
|---|---|---|
| `pending` | **已导入未过门**（新导入的默认态；也是「重新导入一个 archived 条目」的结果态） | 契约新增 |
| `active` | **过门并写回回执后** | 契约新增（语义收紧） |
| `archived` | 已淘汰 | 沿用现值 |
| `invalidated` | 已失效 | 沿用现值（既有写入路径 `builder.go:491 InvalidateNodes`） |
| `suspicious` | 可疑 | 沿用现值（检索侧**降权而不排除**） |

**为什么必须是单一来源**：

1. `docs/o45-import-gate-landing.md` §2「前置一」逐字：Go 侧现在**没有集中定义**，全是散落字面量 ⇒
   **先定一处常量/枚举**，否则"再加一个字面量"只会**更散**。
2. ★ **加一个新状态，等于给所有读 `Status` 的地方出了新题**（§32.3）。不集中，就必然漏改某个读取点，
   而漏改的表现是**静默**的：不是报错，是"某个东西照常被注入/照常被检索到"。**静默不一致比崩溃难查得多。**
3. `ai-base/AGENTS.md` 第 4 条（见 §0）：状态集合是策略的一部分 ⇒ 走接口。

**为什么默认态必须是 `pending`（而不是 `active`）**：

- 现状 `internal/memory/skill_import.go:398` 逐字 `Status: "active",` ⇒ **导入即采纳**；
- 而 `docs/memory-asset-triage.md:169` 早已裁决「导入后视为**候选能力**而非注入物」⇒ **文档裁决与代码相反**；
- 现状 `skill_import.go:447-448` 逐字 `if node.Status == "archived" { node.Status = "active" }`
  ⇒ ★ **「重新导入」是一条绕门路径**：它**不等于重新采纳**，结果必须是 `pending`。

---

## 2. ② 判据回执（对齐 TS 侧 `capability-registry`）

```json
{"kind":"gate"|"none","status":"passed"|"failed"|"unknown","proofLevel":"L0"|"L1"|null,"unenforced":["L2","L3","L4"]}
```

| 字段 | 取值 | 为什么 |
|---|---|---|
| `kind` | `gate` / `none` | **只有 `gate` 是判据**。散文引用（TS 侧曾经的 `kind:"ref"`）**不得被当作通过** —— `capability-registry.mjs:283-285` 曾把散文引用显示成 `pass`，那是**假绿**，已废弃 |
| `status` | `passed` / `failed` / `unknown` | ★ **缺读数 ⇒ `unknown`，不得当 `passed`**（`docs/memory-effect-judge-design.md` §5：「**无证据 ≠ 通过**」） |
| `proofLevel` | `L0` / `L1` / `null` | 门**真正跑到哪一级**。缺它，读的人就不知道"证明到哪为止"（现状 `capability-gate.mjs:340` 只在 admitted 时写 `'L1'`） |
| `unenforced` | 数组，★ **必须含 `["L2","L3","L4"]`** | ★ **防假绿**：本项目的既有事实是**门只跑到 L1**（`capability-gate.mjs:55` `UNENFORCED = LADDER.filter(l => !l.enforced)`）。未实施的级不显式带出 ⇒ 读的人会以为"全过" |

**为什么"缺读数不得当 passed"要写进契约而不是"注意一下"**：

- `capability-gate.mjs` 头部把这条写成纪律：**「把 L2~L4 标成通过就是假绿 —— 那正是本项目花了两天修的那类失败（保险自己失效）」**；
- `memory-effect-judge-design.md` §5 的三条纪律之一：**"失败即弃…降级为 `Executed=false`，让调用方按「无实验证据」继续判分"** +
  **"无证据 ≠ 通过"**；
- ⇒ **纪律写在注释里会退化**，写成 `receipt.invariants` 里的 `missing-reading-is-unknown` 才能被校验器检查
  （`gate-contract-check.mjs` 的 `receipt-missing-reading-is-unknown` 那条检查）。

---

## 3. ③ 状态迁移：`transition(id, to, receipt?) → {ok, status, reason}`

```json
{"ok": bool, "status": "<迁移后的状态>", "reason": "<拒绝时必须可解释>"}
```

| 规则 | from → to | 要求 | 为什么 |
|---|---|---|---|
| `pending-to-active-requires-passed-receipt` | `pending` → `active` | ★ **`receipt.status == "passed"`** | ★ **这条就是「门」本身**。没有它：要么 `pending` 永远出不去（**技能全废**），要么什么都能出去（**门不存在**）。O45 §2 落点 (c) 说得很直白：**没有 (c)，`pending` 永远出不去** |
| `archived-reimport-returns-to-pending` | `archived` → `pending` | 无 | 重新导入 ≠ 重新采纳（O45 §3 验收门第 4 条）。**不是 `active`** —— 否则"复活"绕开门 |
| `invalidated-and-suspicious-unchanged` | `*` → `invalidated` / `suspicious` | 无 | 沿用现值：这两态由失效/检索路径写入，**本契约不新增门**（别把不属于门的东西也管起来） |

**为什么失败也必须返回 `reason`**：`ok:false` 单独存在时，调用方只知道"被拒了"，
不知道**被哪条规则拒**。拒绝必须**可解释**，否则下一个人会绕过它（`capability-gate.mjs:307-309` 有先例：
一条会**误报**的 L1 交叉校验上线即被删，理由逐字——「**会误报的门最终会被人绕过去，于是什么也保护不了**」）。

### 3.1 与 §32.2「既有范式」的对应（写状态必须照抄它）

`docs/skill-as-agent-spec.md` §32.2 定稿的形状：**读节点 → 改字段 → Upsert**。

| 既有事实 | 逐字/位置 | 合约上的对应 |
|---|---|---|
| `func (b *Builder) InvalidateNodes(ids []string)` | `ai-base/agent-shell/internal/memory/builder.go:491`：**先 `graphCache.GetNode(id)` 读出现有节点 → `node.Status = "invalidated"` → `UpsertNodes` 提交** | ★ **门的迁移方法必须同形状**：新增一个与 `InvalidateNodes` **同形状**的"状态迁移"方法，而不是在 `skill_import.go` 里写死字面量 |
| `func (b *Builder) SubmitGraphNode(node map[string]any)` | `builder.go:464`（转 `graphNode` + `MergeRequest{Source: "compactor"}`） | 提交通道（`AGENTS.md` 第 2 条：**必须通过 GraphWriter channel**） |
| `bootstrap.go:650` `builder.StartGraphWriter(ctx)` | 装配处 | 门**不能**自己开一条旁路写 `graph.json` |

⚠️ 注意一处**尚未对齐**（见 §8）：`InvalidateNodes` 写的是 `"invalidated"`，而 `"pending"` **不在**它的取值集里 ——
"门"这条路要不要复用 `InvalidateNodes` 还是新增一个同形状方法，属 O45 §32.5 的 **O50**（落哪个包）。

---

## 4. ④ 注入可见性（两条路径都必须要求 `active`）

| 路径 | 条件 | ★ 是否要求 `active` |
|---|---|---|
| **L0**（高分配稳定技能） | `score > 0.7 ∧ useCount > 10` | ✅ **要求** |
| ★ **L3**（触发词命中） | `triggers` 命中 `taskHint` | ✅ ★ **也要求** |
| 其它 | — | `archived` / `pending` ⇒ **不可见** |

**为什么 L3 的 `active` 要求是本契约最不能少的一条**：

`docs/o45-import-gate-landing.md` §1 / §30.1 核过源码（`internal/memory/skill_tree.go:1054+` `GetActiveSkills`）：

| 路径 | 条件 | 检查 `Status` 吗 |
|---|---|---|
| **L0** | `Score>0.7 ∧ UseCount>10` | ✅ 要求 `Status == "active"` ⇒ 改成 `pending` 后**不会**走这条 |
| ★ **L3** | `Triggers` 命中 `taskHint` | ❌ **完全不检查** ⇒ ★ **`pending` 的技能照样会被注入！** |

⇒ ★★★ **只把导入处改成 `pending` = 装饰门**：只挡住了 L0 那条路，**L3 那条路照走**。
⇒ 所以「**L3 也必须要求 `active`**」必须写进契约，且**由机器检查**
（`gate-contract-check.mjs` 的 `visibility-L3-requires-active`）——
否则它只是一句话，下一个人删掉 `requiresStatus` 时没有任何东西会响。

**另两个为什么**：

- **`archived` 不可见**：现状 `GetActiveSkills` 逐字 `if node.Status == "archived" { continue }` ⇒ 契约与现状一致，防"顺手删掉"。
- ★ **`pending` 不可见**：这是**门存在的全部意义**。若 `pending` 仍可注入，那么"过了门才 active"只是记账，
  **对真实行为零影响**。

---

## 5. ⑤ 实现协议（runner 对任意实现说的话）

```
<impl> visible    --node <jsonfile> --task-hint <text>                       → {"visible": bool}
<impl> transition --node <jsonfile> --to <status> [--receipt <jsonfile>]     → {"ok": bool, "status": string, "reason": string}
```

**为什么是这两条命令**：

- ★ **`visible` 让"注入面"也进契约**。只声明"谁能变 `active`"而不管"`pending` 会不会被注入"，
  就是**半截门** —— 而现状的绕开点**恰恰在注入侧**（L3 分支，见 §4）。
- **契约不关心实现语言**：实现可以是 Go 侧 `internal/external/` 的新面、TS 脚本、或评测夹具。
  runner 只认这两条子命令 + stdout 形状 ⇒ 「策略走接口」落地成**可替换的实现**。
- **`stdout` 必须是机器可读的单行 JSON**：自然语言输出**不可断言**，等于没判据。
  `transition.stdouts` 与 `transitions.result.fields` **逐字对齐**，避免 runner 与实现两套形状。

---

## 6. 与 TS 侧 `capability-registry` 的对应表

| 契约概念 | TS 侧（`scripts/capability-registry.mjs` / `capability-gate.mjs`） | Go 侧现状 | 对齐方向 |
|---|---|---|---|
| **状态** | `status: 'pending'`（`newCapability`，`:148` 逐字 `// ★ 注册 ≠ 采纳`）→ `'active'`（**只由注册门写入**，`capability-gate.mjs:384-389`） | 只有 `active`（`skill_import.go:398`），**无 `pending`** | Go 侧补 `pending`（本契约 ①） |
| `receipt.kind` | `acceptance.kind` —— **只有注册门写入的 `'gate'` 才算**（写入处 `capability-gate.mjs:334`；判定/显示层 `capability-registry.mjs:283-285`、`:402`） | **无对应物** | 回执位按同一键名建 |
| `receipt.status` | `acceptance.status`（`receiptOf`：`passed` / `failed`） | **无** | 同上；★ 另加 `unknown` 表达"缺读数" |
| `receipt.proofLevel` | `acceptance.proofLevel`，`admitted ? 'L1' : 'L0'`（`capability-gate.mjs:340`） | **无**（Go 侧 `Level int`（`skill_tree.go:28`）**语义未定义**，**不可**当 L0~L4 用） | 回执位至少记 `proofLevel`（O45 §3 验收门第 5 条） |
| `receipt.unenforced` | `acceptance.unenforced = UNENFORCED`（`capability-gate.mjs:55`，恒为 `['L2','L3','L4']`） | **无**（**Go 侧不存在"未实施的级要显式带出"的防假绿字段**） | 回执位必须有 |
| 迁移 `pending → active` | `run` 子命令：`admitted ⇒ cap.status='active'`，否则 `'pending'`（`:384-389`） | **不存在**（没有判据处） | 门的接口钩子（O45 落点 (c)） |
| 淘汰 | `supersededBy` / `retire`（`status='retired'`）/ `merge`（`status='merged'`） | 近似物 `AbsorbedBy` / `MergedFrom` / `Status:"archived"` | ⚠️ **先不做映射，记下来**（`o45-import-gate-landing.md` §2 前置二：**不要假装能对上**） |
| 行为信号 | `signals.{invoked,reused,succeeded,failed}`（★ 信号**不是**判据，两者不可混） | `UseCount` / `SuccessRate` / `Score` | 部分可映射；**不得**把信号当回执 |

**一处必须记住的既有教训**（`capability-registry.mjs:219-225` 逐字）：

> ★ 这里曾经写死过 `acceptance:{kind:'ref', status:'passed'}`，而 `ref` 只是一段散文文档 ——
> 那是**假回执**：判据没跑，状态却是 passed。

⇒ **本契约的 `receipt` 必须由判据侧写入，不许由导入侧或文档侧写入。**

---

## 7. §32.3「状态的所有读取点」清单（这同时是 O45 的改动检查表）

加一个新状态（`pending`），**必须让所有读 `Status` 的地方都"考虑过它"**：

| 读取点 | 逐字行为 | 新状态需要它做什么 | 本契约是否覆盖 |
|---|---|---|---|
| ★ `internal/memory/skill_tree.go:1054+` `GetActiveSkills` | `if Status == "archived" { continue }`；**L0 要求 `Status=="active"`**；★ **L3（triggers 命中）不检查 Status** | ★ **L3 也必须要求 `active`**（否则门是装饰） | ✅ `visibility-L3-requires-active` |
| `internal/memory/builder.go:546` | `if n.Status != "active" \|\| n.Type != "decision_flow" { … }` | 需确认它**要不要**对 `pending` 显式处理 | ⚠️ **未覆盖**（见 §8，O49） |
| `internal/memory/retriever_DeepRetriever.go:125/130/171/178` | 按 `"invalidated"` / `"suspicious"` **降权**（非排除） | 需决定 `pending` **是否应当被降权/排除** —— "没测过的东西不该被检索到"？ | ⚠️ **未覆盖**（见 §8，O49） |
| `internal/context/active_skills_injection.go` | 经 `GetActiveSkills` 间接读（调用点 `m.activeSkills.GetActiveSkills("", brain)`，`:58`） | 无需直接改（只要 `GetActiveSkills` 对） | ✅ 间接覆盖 |

★ **这张清单是"改一个状态 = 检查所有读取点"的检查表**；本契约目前**只覆盖第一行**，
第二、三行仍是**未闭合项**（如实记录，见 §8）。

---

## 8. 已知边界（这份契约**没有**保证什么）

1. ★ **契约自洽 ≠ 门已被实现**。本契约与校验器只证明"门的设计**不装饰、不假绿、不撒谎**"，
   **不证明 Go 侧 `skill_tree.go` 的 L3 分支已经改了**。O45 的落点 (a)/(a′)/(b)/(c) 仍是**代码改动**，尚未做。
2. **`GateWriter` channel 未接入**：契约只说"迁移要走接口"，**没有**约束它接到哪个函数
   （`InvalidateNodes` 同形状新方法 vs 复用 `InvalidateNodes`）—— 属未闭合 **O50**。
3. **`builder.go:546` 与 `retriever_DeepRetriever.go` 对 `pending` 的行为未定义** —— 属未闭合 **O49**
   （`§32.5`）。本契约**没有**对这两处下任何结论。
4. **校验器只验"契约自洽"，不验"契约被实现遵守"**。要证明"门被尊重"，需要 O45 §3 的 5 条验收门
   （含**阳性对照**：同两条改成 `active` 必须**出现**）—— 那需要一份**实现**，目前没有。
5. **`unenforced = ["L2","L3","L4"]` 是"本项目当前事实"的硬编码**：若将来 L2 被实施，
   必须**同时**改契约与 `capability-gate.mjs:55`。契约里没有"自动同步"，只有"两边不一致时会响"
   （校验器会把缺 `L2` 判为不合格）。
6. **与 TS 侧的运行时通道尚未打通**：Go 侧 `SkillRegistry` 与 TS 侧 `capability-registry`
   **当前零代码级连接**（`docs/o45-import-gate-landing.md` §2 前置二）。本契约定义的是**语义对齐**，
   不是"已经能互相调用"。

---

## 9. 怎么用

```bash
# 校验契约自洽（19 项检查，每项打印「防的是什么」；任一项失败 ⇒ 非零退出）
node scripts/gate-contract-check.mjs

# ★ 自证有分辨力：阳性对照（真契约必须全过）+ 12 份内存坏契约必须被指定规则挡下
node scripts/gate-contract-check.mjs --selftest

# 校验一份别的契约（例如你把 L3 的 active 要求删掉试试）
node scripts/gate-contract-check.mjs --contract <path>
```

**改这份契约时必须跑的两条**：`node scripts/gate-contract-check.mjs` 与 `--selftest`。
后者是**insurance 的 insurance**：它保证**校验器自己**不会变成"全绿"或"全红"的装饰品。
