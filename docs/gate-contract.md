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
| `pending-to-active-requires-passed-receipt` | `pending` → `active` | ★ **`receipt.status == "passed"`** **且** ★ **回执必填字段必须可读（至少 `proofLevel`）** | ★ **这条就是「门」本身**。没有它：要么 `pending` 永远出不去（**技能全废**），要么什么都能出去（**门不存在**）。O45 §2 落点 (c) 说得很直白：**没有 (c)，`pending` 永远出不去** |
| `archived-reimport-returns-to-pending` | `archived` → `pending` | 无 | 重新导入 ≠ 重新采纳（O45 §3 验收门第 4 条）。**不是 `active`** —— 否则"复活"绕开门 |
| `invalidated-and-suspicious-unchanged` | `*` → `invalidated` / `suspicious` | 无 | 沿用现值：这两态由失效/检索路径写入，**本契约不新增门**（别把不属于门的东西也管起来） |

★ **O53：第二条要求（回执必填字段必须可读）是补上去的，理由如下** ——

- 向量的 `transition-pending-to-active-receipt-missing-prooflevel` 的判据是
  **`receipt.status=="passed"` 但缺 `proofLevel` ⇒ `ok:false`**；
- 而本契约 `transitions.rules` 的**字面**原本只要求 `receipt.status == "passed"` ⇒
  **这条更严的判据只活在实现里**（`gate-impl-reference.mjs` 靠 `receipt.schema.required`
  + 不变量 `receipt-is-recorded-on-adoption` 自己补的）；
- ⇒ 现写进契约的**规则本体**（`transitions.rules[0].require` 第二条 +
  `requireFieldsComplete.atLeast = ["proofLevel"]`），实现**从契约读**，不再自己补；
- 依据：不变量 `receipt-is-recorded-on-adoption`（"过了门却读不到证到哪一级 = 没有回执位"）
  与 O45 §3 验收门第 5 条。★ 注意这比 `receipt.schema` **更严**：
  schema 允许 `proofLevel: null`，但**过门时不允许**（`null` / 缺失 ⇒ 拒绝）。
- 守着它的是校验项 `transition-pending-active-requires-readable-receipt`。

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
| 其它 | — | ★ **任何非 `active` 态**（`pending` / `archived` / `invalidated` / `suspicious`，见 §4.1）⇒ **不可见** |

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

### 4.1 ★ 不可见集必须**列全**：`invalidated` / `suspicious`（O52）

**改前的洞**：`visibility.invisibleStates` 只写 `["pending","archived"]`，而 `states.values` 有 **5** 个值
⇒ ★ 一个**严格按 `invisibleStates` 判**的实现会把 `invalidated` / `suspicious` 判成"**可见**"
（= 已失效 / 可疑的东西照样被注入 prompt）。这是**假绿**，而且**没有任何向量覆盖** ⇒ 洞是静默的。

**怎么补的（本契约的选择）**：把四态**枚举完整**：

```json
"invisibleStates": ["pending", "archived", "invalidated", "suspicious"]
"invisibleRule": "凡 status != adoptedState（= active）者一律不可注入；invisibleStates 就是它的【枚举形式】= states.values 减去 adoptedState。"
```

- **选的是「补全枚举」**（另一种写法是"只写一条规则"，本契约**不**采用它作为机器可读形式）：
  ★ 因为 **散文不可断言** —— 校验器只认枚举，写成散文提到这两个词**不算声明**
  （与 §2 那条教训同源：`kind:"ref"` 的散文引用曾是假回执，**散文不是判据**）。
- 契约里同时留了 `invisibleRule` / `invisibleWhy` 两段**文字**（说明这条规则从哪来、为什么），
  但**判定只用枚举**。
- ★ **口径一致**：`invisibleStates` 必须 = `states.values` 减去 `adoptedState`。
  将来往词汇表加第 6 个状态却忘了列进不可见集 ⇒ **校验项会响**（不是静默漏掉）。
- ★ **与检索侧的区别（别混）**：`states.meaning` 里 `suspicious` 是"**检索侧降权而不排除**"——
  那是**检索路径**（`retriever_DeepRetriever.go`）的行为；本契约管的是**注入路径**。
  **降权 ≠ 可注入**：注入侧只认 `active`，所以 `suspicious` 一律不可见。
- 守着它的是校验项 `visibility-invalidated-and-suspicious-invisible`；
  机器判据由两条向量补齐：`invalidated-trigger-match-hidden` / `suspicious-trigger-match-hidden`
  （都走 **L3** 路径、`expect.visible:false`）。

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

### 5.1 ★ 状态**写回哪里 / runner 怎么读回**（O51）

**改前的洞**：向量的 `expect.statusUnchanged`（"被拒时状态必须没变"）**依赖一个只在实现里存在的约定**——
"`--node` 那个文件会被原地回写"。契约 `implementations.commands` 里**一个字都没有**，
`transitions.result.fields` 也只有 `["ok","status","reason"]`（**没有**"状态去哪了"）。
⇒ 那是**实现与 runner 的私下约定**，不是契约。

**为什么这必须进契约（"静默失真"）**：`statusUnchanged` 的判法是"**读回写回文件，看 status 有没有变**"。
若将来 Go 侧实现**不**按同一个约定写回（比如自己另开一个文件、或干脆不落盘），runner 就读不到 →
**"读不到文件" 与 "状态未变" 不可区分**：
- 判 `statusUnchanged: true` 的向量会**假绿**（读不到 ⇒ 当成没变）；
- 判 `statusUnchanged: false` 的向量会**假红**。
两种都不是报错，是**判决静默失真** —— 正是本项目花了两天修的那类失败（**保险自己失效**）。

**怎么补的（二者择一，写死）**：`contract.json` → `implementations.state`：

| 字段 | 值（本契约写死） | 含义 |
|---|---|---|
| `writeback.mode` | `"in-place"` | ★ **默认原地回写**：把迁移后的节点写回 **`--node` 指向的同一个文件**（含 `status`；`ok:true` 时另写 `receipt`） |
| `writeback.arg` | `"--node"` | 写回位置由这个参数决定（**不是**另开旁路） |
| `writeback.overrideArg` / `overrideRule` | `"--state"` | 仅作为**显式 override** 存在（旁挂文件），**不是**默认；给了且该文件已存在 ⇒ 以它的 `status` 为"当前状态" |
| `readback.field` | `"status"` | ★ runner 读回**哪个字段** |
| `readback.file` | 传实现的那个 `--node` 文件 | ★ runner 读回**哪个文件** |
| `readback.missingFileRule` | —— | 读不回来 ⇒ 按"读不到写回结果"处理 ⇒ runner 必须让它 **FAIL**（偏严方向），**不得**当作"状态未变" |
| ★ `writeback.evidence` | `{kind:"file-digest", scope:"declared-writeback-file", algorithm:"sha256", field:"fileChanged", …}` | ★ **O55**：写回**痕迹**机制（见 §5.2）—— 光有 `statusUnchanged` 分辨不了"没写回" |
| `goSide.why` | —— | ★ **Go 侧必须同款，否则 `statusUnchanged` 判据静默失真** |

**为什么选 `in-place`**：照抄 §3.1 的既有范式「**读节点 → 改字段 → Upsert**」
（`builder.go:491 InvalidateNodes`），而不是另开一条旁路写状态（`AGENTS.md` 禁止行为第 2 条）。
`sidecar`（`--state`）只作为显式 override，**契约已择一写死为 `in-place`**。

**实现与 runner 都真的按契约走**（不是靠隐含约定）：

- `gate-impl-reference.mjs` 的 `stateFileFor()` **从契约读 `writeback.mode`**；
  契约没声明 ⇒ **exit 2**（拒绝猜）；声明了不支持的模式 ⇒ 也 exit 2（宁可答不上来）。
- `gate-vector-run.mjs` 的 `loadStateProtocol()` **从契约读 `writeback.mode` + `readback.field`**
  来决定"读哪个文件的哪个字段"；契约里**没有**这段声明 ⇒ runner **exit 3 拒绝跑**
  （不再退回 runner 自己知道的默认值）。
- 判据：校验项 `impl-state-writeback-declared`。

### 5.2 ★★ 写回**痕迹**：让「从不写回」可被分辨（O55 ↔ spec §35.4）

**改前的洞（§35.4 逐字）**：4 条**负向**迁移向量都期望 `statusUnchanged: true`，
而**一个「从不写回」的实现同样满足**（"读不到"被当成了"没变"）⇒ 这套负向判据
**只**靠那条正向对照 `transition-pending-to-active-receipt-passed` 才能分辨这类错误
⇒ ★ **删掉它，这类错误就会全绿通过。**

**这是 §5.1 自己警告的那条失真的另一半**：§5.1 解决了"读回点必须进契约"，
但**没**解决"**读回点没被动过**"与"**状态确实没变**"这两件事长得一样。

**两层补法（两层都要，缺一不成立）**：

| 层 | 做法 | 谁守 |
|---|---|---|
| **① 写回痕迹** | `transition` **前后**对**契约声明的写回文件**（`readback.file` = `--node` 那份）各取一次 `sha256` + 字节长度摘要 ⇒ 摘要变了 = 文件**确实被写过**（`expect.fileChanged: true`）；没变 = 没写过（`expect.fileChanged: false`）。机制本身**也写进契约**（`writeback.evidence`）：`kind=file-digest` / `scope=declared-writeback-file` / `algorithm=sha256` / `field=fileChanged` | 契约校验项 `impl-writeback-evidence-declared`；runner 每次 transition 都实测 |
| **★★ ② 同形正向对照** | `contract.json` → `vectors.pairing`：**每条 `transition` 类的 `negative-control` 向量，必须存在一条【同 `transition.to`】的 `positive-control` 向量，且那条正向对照必须真的带 `expect.fileChanged: true`**。缺一条 ⇒ 判不合格、非零退出 | 契约校验项 `vectors-negative-control-has-same-target-positive-pair`（+ `vectors-pairing-rule-declared`） |

**为什么 scope 必须钉死在 `declared-writeback-file`**：痕迹只能取自 **runner 按契约读回的那一份文件**。
否则一个"写到别处也算留下痕迹"的实现能让痕迹为真、而 `statusUnchanged` 判的那份文件根本没动 ——
那就等于把 §5.1 的洞换个地方重开。

**为什么第二条（配对）才是核心**：第①层只是"多一个信号"，而**这个信号有没有牙，
取决于向量集里有没有一条期望它为 `true` 的向量**。事实是：**只有那一条正向对照**期望
`fileChanged: true` ⇒ ★ 所以"**它必须存在**"本身必须是**机器检查的规则**，而不是"大家记得别删"。
`gate-vector-run.mjs --vectors <删掉正向对照的副本>` 实测：13/13 PASS、exit 0（**静默全绿**，
连 `--break o51-writeback` 的"从不写回"实现也是 13/13 PASS）⇒ 而
`gate-contract-check.mjs --vectors <同一份副本>` ⇒ ★★ **配对缺失（4/4）**、exit 1。

**为什么这条检查放在契约校验器而不是 runner**：配对规则的"母体"是 `contract.json`
自己声明的 `vectors.pairing`（契约的规则由契约的校验器守）；而且它是「**向量集够不够分辨**」的
**静态**检查，与"跑哪个实现"无关 —— runner 的结果语义是 per-vector 的
PASS / FAIL / NEEDS-EVIDENCE，不必再混入第四种「向量集不完整」。

**如实记的偏严代价**：痕迹比的是**原始字节**摘要 ⇒ 一个在**拒绝**时把同一个节点
**换个格式重写**的实现会显示 `fileChanged: true`（而它的 status 其实没变）⇒
对该实现是**假红**。本契约选偏严：假红在跑向量时立刻暴露，假绿不会。
（§未验证里也记了这条。）

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
   （含**阳性对照**：同两条改成 `active` 必须**出现**）—— 那需要一份**实现**。
   ★ 现状（W15/W16 后）：**实现与向量 runner 已经有了**（`scripts/gate-impl-reference.mjs` /
   `gate-impl-broken.mjs` / `gate-vector-run.mjs`，14 条向量），所以"门被尊重"由
   `node scripts/gate-vector-run.mjs` 证明 —— 但**只覆盖向量覆盖到的那部分判据**，
   且**仍是 mjs 夹具，不是 Go 侧真实调用路径**（见第 1 条）。
5. **`unenforced = ["L2","L3","L4"]` 是"本项目当前事实"的硬编码**：若将来 L2 被实施，
   必须**同时**改契约与 `capability-gate.mjs:55`。契约里没有"自动同步"，只有"两边不一致时会响"
   （校验器会把缺 `L2` 判为不合格）。
6. **与 TS 侧的运行时通道尚未打通**：Go 侧 `SkillRegistry` 与 TS 侧 `capability-registry`
   **当前零代码级连接**（`docs/o45-import-gate-landing.md` §2 前置二）。本契约定义的是**语义对齐**，
   不是"已经能互相调用"。

---

## 9. 怎么用

```bash
# 校验契约自洽（28 项检查，每项打印「防的是什么」；任一项失效 ⇒ 非零退出）
node scripts/gate-contract-check.mjs

# ★ 自证有分辨力：阳性对照（真契约必须全过）+ 24 份内存坏契约必须被指定规则挡下
node scripts/gate-contract-check.mjs --selftest

# 校验一份别的契约（例如你把 L3 的 active 要求删掉试试）
node scripts/gate-contract-check.mjs --contract <path>

# ★ O55 / ★★ O57：校验另一份**向量集**
#   （例如"把 L3 的正向对照删掉"的临时副本 ⇒ 必须报「配对缺失」并非零退出）
node scripts/gate-contract-check.mjs --vectors <vectors.json>

# ★ 把契约喂给一份实现（14 条向量；runner 的状态读回约定与写回痕迹机制也都从契约读，O51 + O55）
node scripts/gate-vector-run.mjs --impl "node scripts/gate-impl-reference.mjs"   # 14/14 PASS ⇒ exit 0
node scripts/gate-vector-run.mjs --impl "node scripts/gate-impl-broken.mjs"      # 必须有一批 FAIL ⇒ exit 1
node scripts/gate-vector-run.mjs --impl "node scripts/gate-impl-broken.mjs --break o51-writeback"  # ★ 必须挂 fileChanged 那条
# ★ O57：与 l3-status（"全放"）对称的"全封" —— visible 永远返回 false
node scripts/gate-vector-run.mjs --impl "node scripts/gate-impl-broken.mjs --break all-hidden"      # ★ 必须挂 L0/L3 两条正向可见性向量
```

**改这份契约时必须跑的三条**：`node scripts/gate-contract-check.mjs`、
`--selftest`、以及 `gate-vector-run.mjs`（对参考实现与坏实现各一次）。
第二条是**insurance 的 insurance**：它保证**校验器自己**不会变成"全绿"或"全红"的装饰品；
第三条保证**契约→实现**这条路没断（且"坏一处必须挂"）。

---

## 10. 三处缺口的修补记录（O51 / O52 / O53）

| 缺口 | 改前的洞 | 修法 | 守着它的校验项 | 补的向量 |
|---|---|---|---|---|
| **O51** | `implementations.commands` **没声明**状态写回哪里、runner 怎么读回 ⇒ `statusUnchanged` 靠私下约定 | 新增 `implementations.state`（`writeback.mode` 写死 `in-place` + `readback.field/file`），实现与 runner **都从契约读** | `impl-state-writeback-declared` | —— （由 runner 每次运行都走这条约定来证） |
| **O52** | `invisibleStates` 只列 `pending`/`archived`，漏 `invalidated`/`suspicious` ⇒ 严格按它判的实现会把这两态判成可见（假绿） | 枚举补全为四态（`invisibleRule`/`invisibleWhy` 只作文字说明，**不参与判定**） | `visibility-invalidated-and-suspicious-invisible` | `invalidated-trigger-match-hidden`、`suspicious-trigger-match-hidden` |
| **O53** | 向量 `…-missing-prooflevel` 的判据比 `transitions.rules` 字面更严（缺 `proofLevel` ⇒ `ok:false`）⇒ 只活在实现里 | `transitions.rules[0].require` 增加 `receipt.proofLevel in ["L0","L1"]` + `requireFieldsComplete.atLeast=["proofLevel"]` | `transition-pending-active-requires-readable-receipt` | —— （原有 `…-missing-prooflevel` 现在有契约依据了） |

★ 三处**都只新增/收紧**：原有 19 项检查一项未删（21 + 1 = 22 项），
原有 12 条向量的 `expect` 一个都没改（只新增 2 条 ⇒ 14 条）。
逐条原始输出见 `out/w16-contract-gaps.md`。

---

## 11. ★★ O55：「从不写回」必须可被分辨 —— 两层（写回痕迹 + 同形正向对照）

**缺口来源**：`docs/skill-as-agent-spec.md` **§35.4**（O54 顺手抓到、标为待办）。

**改前的洞**：4 条**负向**迁移向量都期望 `statusUnchanged: true` ⇒
**一个「从不写回」的实现同样满足**（"读不到"被当成"没变"）⇒ 这套负向判据
**只**靠那条正向对照 `transition-pending-to-active-receipt-passed` 才能分辨这类错误
⇒ ★ **删掉它，这类错误就会全绿通过。**
（实测：把那条正向对照删掉后，`--break o51-writeback` 的"从不写回"实现 **13/13 PASS、exit 0**。）

| 层 | 修法 | 守着它的校验项 | 补的向量字段 |
|---|---|---|---|
| **① 写回痕迹** | `contract.json` → `implementations.state.writeback.evidence` 显式声明痕迹机制（`kind:"file-digest"` / `scope:"declared-writeback-file"` / `algorithm:"sha256"` / `field:"fileChanged"` / `compare` / `why` / `caveat`）；`gate-vector-run.mjs` 在每次 `transition` **前后**对**契约声明的写回文件**取 `sha256`+字节长度摘要，支持 `expect.fileChanged: true\|false`；契约没声明痕迹机制 / 声明了不认识的那种 ⇒ runner **exit 3 拒绝跑** | `impl-writeback-evidence-declared` | 5 条 transition 向量全补：正向对照 `fileChanged: true`，4 条被拒绝的 `fileChanged: false` |
| **★★ ② 同形正向对照** | `contract.json` → `vectors.pairing`（`requireFor:"transition.negative-control"` / `mode:"same-transition-target"` / `vectorsFile` / `requirePairAsserts:"fileChanged"`）；**每条 `transition` 类的 `negative-control` 向量都必须存在一条【同 `transition.to`】且带 `fileChanged:true` 断言的 `positive-control` 向量**，缺一条即不合格、非零退出 | `vectors-pairing-rule-declared`、`vectors-negative-control-has-same-target-positive-pair` | —— （规则本身是新增的检查，不新增向量 ⇒ 仍是 14 条） |

**为什么第②层才是 O55 的核心（也是为什么它不能只靠"记得别删"）**：
第①层只提供"一个能被断言的信号"，而**这个信号有没有牙，取决于向量集里有没有一条期望它为
`true` 的向量** —— 事实是**只有那一条正向对照**。⇒ "**它必须存在**"必须是**机器检查的规则**。

**为什么放在契约校验器而不是 runner**：配对规则是 `contract.json`（`vectors.pairing`）自己
声明的 ⇒ 由契约的校验器守；且它是「**向量集够不够分辨**」的**静态**检查，与跑哪个实现无关 ——
runner 的结果语义是 per-vector 的 PASS/FAIL/NEEDS-EVIDENCE，不必再混入第四种「向量集不完整」。
★ 但**两条命令都要跑**：光跑 runner ⇒ 删掉正向对照后仍会**静默全绿**（exit 0）；
光跑契约校验器 ⇒ 不知道契约有没有被实现尊重。

**如实记的偏严代价**：痕迹比的是**原始字节**摘要 ⇒ 一个在**拒绝**时把同一个节点
**换个格式重写**的实现会显示 `fileChanged: true`（status 其实没变）⇒ 对该实现是**假红**。
本契约选偏严（假红会被立刻看见，假绿不会），并把这条写进 `writeback.evidence.caveat`。

★ 本次**只新增/收紧**：原有 22 项检查一项未删（22 + 3 = **25** 项）；
原有 14 条向量的 `expect`（含 4 条负向）**一个判据都没改**，只**新增** `fileChanged` 字段。
逐条原始输出见 `out/w18-o55-writeback-trace.md`。

---

## 12. ★★ O57：配对规则扩到 **L0/L3 可见性类**（三类各有一个机器可判的"同形"定义）

**缺口来源**：`docs/skill-as-agent-spec.md` **§36.5 第 3 条**逐字：

> **配对规则只覆盖 `transition` 类** —— **L0/L3 的负向向量也有正向对照，但没有机器检查。**

### 12.1 洞的形状（与 §11 已证的 transition 那侧**同构**）

一个「**全封**」的实现（`visible` **永远返回 false**）⇒ **L0/L3 的 6 条负向向量全部 PASS**
（L0 的 2 条 + L3 的 4 条 `negative-control`，它们都期望 `visible:false`）
⇒ **只有同类的那 2 条正向对照能抓到它** ⇒ 若正向被删/被弱化 ⇒ **静默全绿**。

★ **实测过，不是理论**（做法照 §36.4）：把 `l0-active-highscore-visible` 与
`l3-active-trigger-match-visible` 两条正向对照从临时副本里删掉后，
`gate-vector-run.mjs --impl "… --break all-hidden"` ⇒ **12/12 PASS、exit 0**；
★ 同一份副本喂给契约校验器 ⇒ **两条按类配对检查 FAIL、exit 1**。
（顺带如实记：runner 的「两条关键对照」那一行会打印 `★ 向量缺失，无法判定（这批向量不完整）`，
但它**不影响退出码** ⇒ 光靠 runner 这条路径是**挡不住**的，所以配对规则必须由契约校验器守。）

### 12.2 三类"同形"定义（`contract.json` → `vectors.pairing.classes.rules`）

| 类 | `mode` | "同形"（机器可判） | 正向对照必须有牙的断言 |
|---|---|---|---|
| `transition`（**不动**，O55 原文） | `same-transition-target` | 同 `kind` ∧ 同 `transition.to`（★ **弱配对**：不比 `from` / `node.status` —— §36.5-2 如实记的残留，本次未碰） | `expect.fileChanged: true` |
| ★ `l0` | `same-l0-bucket` | 同 `kind`(=l0) ∧ 同 `taskHint` ∧ 【`status` 之外、L0 规则读到的节点字段】逐值相等（本契约 = `score` / `useCount`，由 `visibility.rules[level=L0].conditions[*].metric` 决定）∧ 负向那条这些字段**满足 L0 全部 conditions**（`score>0.7 ∧ useCount>10`，即"同档位、都在阈值内"）∧ 两者 `node.status` **不同** ⇒ status 是**唯一自变量** | `expect.visible: true` 且正向 `node.status === requiresStatus`(=`active`) |
| ★ `l3` | `same-l3-trigger-hit` | 同 `kind`(=l3) ∧ 同 `taskHint`（命中**输入**不变）∧ `triggers` 逐值相等（命中**载体**不变 ⇒ "命中"在两条上同真同假）∧ 两者 `node.status` **不同** ⇒ status 是唯一自变量 | 同上 |

**每条规则都带 `why`（防的是什么）**，逐字写在 `contract.json` 里（校验器会检查 `why` / `sameShape` 非空）。
`⛔ node.id 不参与比较` —— 向量 id 只是身份，不参与判定（两条向量的 `node.id` 必然不同）。

**为什么 L0 必须把"档位都在阈值内"写进同形定义**（★ 本契约的选择，理由在此）：
若负向那条的 `score` 本来就低于阈值，它的**不可见不是 `status` 造成的** ⇒ 那样的"配对"无法证明
L0 路径真的没被全封（**status 这个自变量被稀释了**）。所以 `l0` 类显式声明
`mustSatisfyRuleConditions: true`，校验器逐条按契约算子判该负向向量的档位。

**为什么 L3 **不**设 `mustSatisfyRuleConditions`**（同样是本契约的选择，理由在此）：
L3 的 `condition` 只声明了 `{"kind":"triggers-hit-taskHint"}` 而**没有声明命中算法**
（`gate-impl-reference.mjs` 用的是"大小写不敏感子串包含"，那是**实现选择**）。
⇒ 校验器**不重造一套算法**去判"命中"（那会把一个未声明的实现选择偷渡进契约）；
改以「`triggers` + `taskHint` 逐值相等」+「正向对照已被向量断言 `visible:true`」
= 命中条件**以正向对照为证据**被固定 —— 这已足够把 `status` 隔离成唯一自变量。

### 12.3 守着它的校验项（**25 → 28 项，原有项零删除**）

| 校验项 | 守什么 |
|---|---|
| `vectors-pairing-classes-declared` | 按类规则**自身**合法：三类齐 + `requireFor`=`kind.role` + `mode` 在该类白名单内 + `requirePairAsserts`(牙) / `sameShape` / `why` 非空 + `nodeFields` **覆盖该 level 规则真正读到的字段**（L0 需含 `conditions[*].metric`；L3 需含 `triggers`，且契约 L3 规则必须确实声明 `condition.kind = "triggers-hit-taskHint"`）+ `transition` 那一档与顶层 O55 声明的三个值**逐字一致**（防同一档规则两处各写一遍而漂移） |
| ★ `vectors-pairing-l0-negative-controls-have-same-shape-positive` | 每一条 `l0.negative-control` 必须有一条满足 `same-l0-bucket` 的正向对照；缺一条 ⇒ FAIL + 非零退出，明细**逐条列出缺配对的向量 id**（含"有同 taskHint 的正向对照但都不同形"的具体原因） |
| ★ `vectors-pairing-l3-negative-controls-have-same-shape-positive` | 同上，`same-l3-trigger-hit` |

★ **缺配对 vs 读不到向量，两种失败必须分得清**（§36.3 的教训）：向量集读不到 ⇒ 报
`★ 配对检查的向量集不可读：…`；配对缺失 ⇒ 报 `★★ 配对缺失/无牙（n/m）：… ⇒ <逐条 id>`。
**两者不共用一句文案**，否则又会拿到"理由错误的 exit 1"。

### 12.4 `--break all-hidden`：与 `l3-status`（"全放"）对称的"全封"

`gate-impl-broken.mjs --break all-hidden` ⇒ `visible` **永远返回 false**。
表达方式仍是"**只动数据**"（该文件 §坏法④ 逐字记了理由）：把**每一条**可见性路径的
`requiresStatus` 换成一个任何合法 `status` 都不等于的哨兵 `__all-hidden__`。

- ★ **为什么不存在"合法的全封值"**：`states.values` 的 5 个状态**全都被向量用到**
  （L0 用到 `active`/`pending`/`archived`；L3 用到全部 5 个）⇒ 把 `requiresStatus` 设成任何
  **合法**取值都会**放出**一批本该被挡下的向量（那就变成另一种坏法，不是"全封"）
  ⇒ 只能用哨兵。
- ⚠️ **实测到的第三个陷阱**：哨兵**不能**用空串 —— 参考实现的判据是
  `if (rule.requiresStatus && statusOf(node) !== rule.requiresStatus) return false`，
  空串是 falsy ⇒ 那道状态检查会被**跳过**，L0 反而退化成"只看 `score`/`useCount`"（**全放**）。
- 实测（`—break all-hidden`）：**2 FAIL**，且正好是 `l0-active-highscore-visible` 与
  `l3-active-trigger-match-visible` 两条正向可见性向量；runner 自己的判定行也打印
  `★★ 判定：门全封 —— pending 挡住了，但 active 也出不来（技能全废）`。
- ★ **旧模式不得回退**（实测，未回退）：`l3-status` 仍 4 条向量 FAIL（且**默认、`--break l3-status`
  两种跑法的逐向量结果逐字节相同**，只有一行回显的 `impl` 命令不同）；
  `o51-writeback` 仍挂 `fileChanged(写回痕迹 file-digest/sha256)`；`o53-receipt` 仍挂 `…missing-prooflevel`。

### 12.5 自检里新增的坏样本（19 → **24** 份，`--selftest` 全部被指定规则挡下）

| 坏样本 | 期望被挡下的规则 |
|---|---|
| ★★ 删掉 L0 的正向对照 `l0-active-highscore-visible` | `vectors-pairing-l0-…-same-shape-positive` |
| ★★ 删掉 L3 的正向对照 `l3-active-trigger-match-visible` | `vectors-pairing-l3-…-same-shape-positive` |
| ★ L0 正向对照还在，但 `expect.visible` 改成 `false`（**配对无牙**） | 同上（L0）|
| ★ L0 负向向量的档位改到阈值外（`score 0.9 → 0.5`，**同形判据被破坏**） | 同上（L0）|
| ★ 契约没声明按类配对（删掉 `vectors.pairing.classes`） | 三条按类检查**全部 FAIL**（★ 不许"规则没声明就静默跳过"）|

### 12.6 如实记的边界与代价

1. ★ **偏严方向**：`l0`/`l3` 类现在**无条件**要求每条 `negative-control` 有一条同形正向对照。
   若将来有人加一条**不是由 `status` 造成**的 L0/L3 负向向量（例如"分/次不达标 ⇒ 不可见"），
   这条规则会**报"配对缺失"**并要求他补一条同形正向对照（或改判据）。
   ★ 这是**故意**的：任何 `expect.visible:false` 的 L0/L3 向量都**天然**被「全封」实现满足，
   ⇒ 它**必须**有能分辨"门没漏 / 全封"的正向对照，否则又是静默全绿。
2. ★ `transition` 类**仍是弱配对**（只比 `transition.to`，不比 `from` / `node.status`）——
   §36.5-2 的残留**本次未闭合**（本任务只做"扩到 L0/L3"，没动 O55 那一档的语义）。
3. ★ **`nodeFields` 的覆盖性是"下界"不是"上界"**：校验器只核对声明的 `nodeFields`
   **至少覆盖**该 level 规则读到的字段；若有人把额外字段塞进 `nodeFields`，两条向量会变得
   **更难配对**（更严，不是更松）⇒ 不会产生假绿。
4. ★ **本次没有改 `evals/gate/vectors.json`**：14 条向量一条未增未改（`expect` 一个都没动）——
   L0/L3 的正向对照**本来就在**，缺的只是"它们必须存在"这条**机器检查**。
5. ★ 本轮**顺带发现**（未闭合，供后续参考）：`gate-vector-run.mjs` 的「两条关键对照」那行
   在向量缺失时会打印 `★ 向量缺失，无法判定`，但**不改变退出码**；
   ⇒ 「向量集完整性」这条信号**只有契约校验器有牙**（这也是它被放在那里的理由，§11 已记）。

逐条原始输出见 `out/w19-o57-pairing-l0-l3.md`。
