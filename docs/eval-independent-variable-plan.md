# 定自变量：**工具数量/集合**（2026-09-21 修订版）

> ⚠️ **本文件初版把自变量定为"委派能力（`subagent-council`）开/关" —— 干跑后【推翻】了。**
> 修订见 §0。保留初版推理（§2–§6）作为"为什么那条路不通"的记录。

---

## 0. ★★ 干跑结果（决定性事实，2026-09-21 实测）

```
造变体：node scripts/make-profile-variant.mjs --from web --to exp-nocouncil --drop @dsh-brain/subagent-council
        ⇒ deps + bundles 两处都摘掉 ✓（该脚本要求"两处才算干净"）
探工具面：node scripts/arm-probe.mjs exp-nocouncil web      # 探完自动切回

  exp-nocouncil（无 subagent-council）: 工具面 101 个
  web（对照）:                          工具面 102 个
```

**⇒ 只少 1 个工具**（`council_architect` —— 它确实随 provider 消失，**验证了上游的 mount/摘除机制** ✓）
**⇒ 但 `subagent` / `subagent_fork` 是【上游 `dsh-tool-subagent` 挂的】** ⇒ **摘我们的 bundle 关不掉** ⚠️
⇒ **"委派能力整体关闭"这个方案不成立。**

### ★ 更重要的量化：**我们自己包的工具体量极小**

| 来源 | 工具数 |
|---|---|
| `design-canvas`（其中 `mcp__*` **64**） | **67** ← 实为 **72**：64(MCP) + **8**(bridge)，见 §2.3 的勘误表 |
| `self_evolve` | 1 ← ✗ **归属记错了**：它是 `design-canvas-bridge` 的，见 §2.3 |
| `capability-bridge`（`list_capabilities` / `capability_report`） | **2** |
| `subagent-council`（`council_architect`） | **1** |

⇒ **除 `design-canvas` 外，"某个能力开/关"能造的反差都只有 1–2 个工具** ⇒ **量级太小，测不出东西。**
⇒ **而 `design-canvas` 正是不可用的那个**（未完成 + `kernelDir` 不匹配 + MCP 迟到挂载 —— 见 §6 来源文档）。
> ⚠️ 上面这张表是**当时**的读数，含两处错（`design-canvas` 少算 5、`self_evolve` 认错归属）。
> 勘误见 §2.3，**以 §2.3/§2.1 的表为准**。

---

## 1. 修正后的自变量：**工具数量/集合**（不是"某能力有无"）

**理由三条**：

1. **量级可控**：能造梯度（0 / 5 / 20 / 全部）⇒ 可测"工具数量 → 表现"的**函数关系**，而不是单点对比；
2. **它才是"我们这一层"的直接变量** —— 也正是一开始那句「**变量不就是工具数量吗**」的字面实现；
3. **它绕开了"能力完成度"这个坑**：不需要所涉能力"已完成"，只需要**能可靠地关掉一批工具**。

**⇒ 而唯一的大旋钮是 `design-canvas` 那 72 个**（64 走 MCP + 8 走 bridge）。
⇒ **所以真正的前置问题变成了**：

> **怎么【可靠地】关掉一个能力挂在工具面上的工具？**

~~已知它**至少三条路**~~ ⇒ **实为【两条】路**（2026-09-21 实测更正，见 §2.1）：
`dsh.profile.bundles`（连带的包内 patch）/ profile 里的 **`mcp-client` insert**。
**"独立 MCP server 进程"不是第三条路，是第二条路的产物。**
⇒ **只 drop bundle 关不掉**（实测：`exp-base-nodc` 早期仍有 `mcp__design-canvas__*`，且 MCP server 会**迟到挂载**）。
⇒ ★ "稳定窗口"只解决"**等它稳**"，不解决"**关掉它**" —— **两者不同**，别混。


---

## 2. 修正后的执行顺序

1. ~~**先解决"怎么可靠地关掉一批工具"**~~ ✅ **已解决，见 §2.1**
2. **再定梯度**（例如 `mcp__*` 全开 / 全关 / 开一半）← **当前在这**
3. **配一道"会用得上被关掉那批工具"的题** ⇒ 否则关了也没差别 ⇒ 那样定出来的自变量仍是"某两种配置的成本差"。

### 2.1 ✅ 「可靠地关掉一批工具」已解决（2026-09-21 实测坐实）

> ★ **臂名以 canonical 为准**：本方向的两臂是 **`exp-base`（开） / `exp-base-nodc`（关）**
> （见 `topics/next-task-handover.md` 的 eval 回执）。
> 本段先用 `web` / `web-nodc` 验证机制（现役 `web` 就是 `exp-base` 的来源，两者配置**逐字节相同**：
> bundles 相同、`cordis.patch.yml` 相同），随后**用 canonical 两臂复跑，数字完全一致**：
> `exp-base` **102** ↔ `exp-base-nodc` **30**（gen-3113/3114/3115，各 3 次采样）。
> ⚠️ 我临时造的 `web-nodc` **已退役并删除**（它是 `exp-base-nodc` 的**逐字节重复**，
> 且该名字被另一会话标记过"已作废"⇒ 留着就是给后人挖坑）。删除前已逐字比对确认它与 `exp-base-nodc` 相同，
> 因此**不留副本、无需重建**（要重建就是 §2.1 那条命令）。

**旋钮**（一个命令，可复跑）：

```bash
node scripts/make-profile-variant.mjs --from web --to exp-base-nodc \
     --drop @dsh-brain/design-canvas-bridge \   # 断①「包」这条路
     --drop-insert mcp-client                   # 断②「profile 的 - insert」这条路
```

**两条路的真相**（此前记的"三条"是把**产物**当成了路）：

| # | 路 | 断它的旋钮 | 提供什么 |
|---|---|---|---|
| ① | `dependencies` + `dsh.profile.bundles` 里的 `@dsh-brain/design-canvas-bridge` | `--drop` | **bridge 的 8 个工具**（本包自己的 `cordis.patch.yml` 随之装配） |
| ② | profile 的 `cordis.patch.yml` 里 `- insert: id: mcp-client` | `--drop-insert mcp-client` | **64 个 `mcp__design-canvas__*`** |
| ③ | 「独立 MCP server 进程」 | — | **不是一条独立的路**，是②的**产物**（②在，server 才被拉起） |

**四条判据，全部为真**：

| 通道 | 开（`exp-base`） | 关（`exp-base-nodc`） | 依据 |
|---|---|---|---|
| ① **请求侧**工具面（`request/header.tools[]`） | **102**（design-canvas 67 / mcp 64） | **30**（design-canvas 0 / mcp 0） | 3 次采样全一致，窗口 10s |
| ② **装配侧** boot.log（末段） | bridge apply=1、MCP server started=1、**7 行"已注册"** | **全 0** | `scripts/probe-gen-boot.mjs` |
| ③ 装载树（离线 `--profile X --dump-config`） | 575 行 | 548 行 | diff **只差那两条 entry**，逐字无其它改动 |
| ④ 健康性（防"关掉"与"坏了"混淆） | plugin-tree-failed=0 / dupId=0 / startup-error=0 | **同样全 0** | ⇒ 是**干净地少**，不是**坏掉** |

**★ 数量守恒（这条判据自己会说话）**：

```
102 − 30 = 72
72 = 64（路②）+ 8（路①，boot.log 逐行点名的 7 个 + 无日志的 design_canvas_index）
⇒ 两条路合计**正好**覆盖全部差量，**无残留**
```

**可复现性**：`exp-base ↔ exp-base-nodc`（gen-3113/3114/3115）与 `web ↔ web-nodc`（gen-3105…3110，两轮）
**两组共五腿**，102 ↔ 30 **全部完全复现**，无一次振荡。


### 2.2 ★★ 过程中翻的一个车：**阳性对照选错了**（必须记住）

第一版探针拿 `self_evolve` 当"恒在的阳性对照"，结果它在**被测臂里也归零了** ⇒ 脚本只能判"不可采信"。

**根因**：`self_evolve` **根本不是 `tool-evolution` 的工具**，而是 **`design-canvas-bridge` 的 8 个工具之一**
（`src/index.ts:633`）。⇒ **它就在被关掉的那一族里**，当对照等于"拿体温计量自己的体温"。

**⇒ 规则（已写进 `arm-probe.mjs` 文件头与 `gate-authoring` skill）**：

> **阳性对照族必须与本次自变量【正交】** —— 即"你不动它，它就在"。
> 否则"读数可见"这件事本身就没被证明，"全 0"仍然只是"看不到"。

**已修**：
- 默认对照改为 `subagent`（`subagent-council` 的产物，关 design-canvas 时恒为 3）；
- 支持 `--control <族名>`；
- 多臂时新增**对照体检**：对照族在**每一臂**都必须非 0，否则直接宣告"前面的判语作废，换对照族重跑"。

### 2.3 已知限制（如实记）


- `--samples` / `--interval` / `--control` 是**全局**的（对所有臂生效）；给不同臂不同采样数要分开跑。
- `arm-probe --proc <kw>`（进程通道）在 **Agent 的 Bash 沙箱里调不到 PowerShell**（`spawn ENOENT`，
  且命令里出现相关字样还会被安全策略拦）⇒ 该通道在自动化里**不可用**；
  已改为**显式报"不可用"而不是报"没有"**（否则又是一个假绿）。
  真正顶替它的是**通道② boot.log** —— 纯文件、不需要任何外部 shell。
- `boot.log` **跨启动累积**（分隔符 `===== BOOT gen=… =====`）⇒ 必须**只数末段**。
  实测 gen-3105 的 boot.log 有两段，**第一段是前一天一次失败的启动**（`MODULE_NOT_FOUND`）；
  整篇一起数会把**阳性臂谎报成"起来了"**。
- **`self_evolve` 的归属此前记错了**：长期记忆里写在 `tool-evolution` 名下 —— 实际是
  `design-canvas-bridge` 的。各包**真实**工具体量（2026-09-21 从源码核出）：

  | 包 | 工具数 | 名字 |
  |---|---|---|
  | `design-canvas-bridge` | **8** | `design_canvas_index` / `design_canvas_prewarm` / `design_canvas_prewarm_scan` / `memory_observe` / `move_symbol` / `safe_rename` / `symbol_edit` / `self_evolve` |
  | `tool-evolution` | 1 | `tool_score` |
  | `capability-bridge` | 2 | `list_capabilities` / `capability_report` |
  | `subagent-council` | 0（注册 **provider**） | 产物是上游的 `subagent` / `subagent_fork` + 自己的 `council_architect` |
  | MCP（`mcp-client` insert） | **64** | `mcp__design-canvas__*` |

---

## 2.4 下一步：定梯度（三个旋钮位，四个点）

同一个旋钮家族可以给出**四个**可复跑的配置：

| 级别 | 怎么造 | 工具面 | 备注 |
|---|---|---|---|
| **L0 全关** | `--drop design-canvas-bridge --drop-insert mcp-client`（= `exp-base-nodc`） | **30** | ✅ 已造并坐实 |
| **L1 只 bridge** | `--drop-insert mcp-client` | 38 | 8 个 bridge 工具在，但它们的执行端（MCP）没了 ⇒ **工具"在"但多半调不通** |
| **L2 只 MCP** | `--drop design-canvas-bridge` | 94 | 64 个 MCP 工具在，少了本地编排/索引封装 |
| **L3 全开** | 直接用 `exp-base`（≡ `web`） | **102** | ✅ 已坐实 |

**★ 主对比用 L0 vs L3（干净）**：一整块能力（design-canvas）整体开/关，语义清楚。
**L1 / L2 是"梯度补充"，必须标注 confound**：它们把**同一个能力的两半**拆开，
所以"少 64 个"≠"少一份能力"，而是"少了执行端"（或反之）⇒ 会与"能力完整性"混淆。
⇒ 若目标是"**工具数量** → 表现"的函数关系，L1/L2 有价值；若目标是"**能力有无**"，只用 L0/L3。

## 3. 再下一步：配一道"会用得上被关掉那批工具"的题

**约束（来自 §A.3 的教训，别忘）**：design-canvas 的工具**大多可被 grep + edit 手工替代**
⇒ 关掉后**不是"做不到"，只是"更贵/更易错"** ⇒ 判据必须**同时**有：
- **行为面**：轨迹里该家族工具的实际调用次数（关的臂必然为 0）；
- **成本面**：`toolCalls` / `tokens` / `wallMs`（关的臂应显著上涨）；
- **质量面**：产物正确性（关的臂应更容易漏改 / 漏引用）；
⇒ **区分度主要来自成本面与质量面**，不是"能不能做"。

**题面方向（待落盘）**：拿一个**索引工具才划算**的仓库（文件多、跨文件引用密），
要求"做一次跨文件重构 + 报出完整影响面"—— 手工 grep 会**成本爆炸且易漏**，
而有 `find_references` / `impact_analysis` / `rename_symbols` 时是**一次调用**。

---

## 附录：初版推理（**为什么「委派能力开/关」那条路不通** —— 留档）

> 保留初版推理，是为了让读者看到「候选清单 → 判匹配 → 定自变量」这条链**在哪一步断了**，
> 以及**干跑**（§0）如何把它推翻。**结论以 §1/§2 为准。**

### A.1 为什么上一对（`web` vs `exp-base-nodc`）不能用

`task-bank-thinking.md` §6 已列三条，此处只补一句**结构性**的：
那对变量是 **`design-canvas` 的 64 个工具**，而**它未完成 + `kernelDir` 指向真项目 + MCP server 独立进程会迟到挂载**
⇒ 三重污染。**而根因是"变量选了一个未完成且与题目目标不匹配的能力"。**

### A.2 候选清单（实测，2026-09-21）

| 候选 | 能力来源 | 工具面 | 已完成 | 能关 | 判"匹配" |
|---|---|---|---|---|---|
| **A. 委派三件套** | **`@dsh-brain/subagent-council`**（一个包注册 3 个 provider） | `subagent` / `subagent_fork` / `council_architect` | ✅ | ✅ **摘 bundle ⇒ 三 provider 全没** | ★ **结构性**（见 §3） |
| B. 能力库桥 | `@dsh-brain/capability-bridge` | `list_capabilities` / `capability_report` | ✅ | ✅ 摘 bundle | ⚠️ 弱：**不用它也做得成**（可以猜有哪些能力） |
| ~~C. design-canvas~~ | `design-canvas-bridge` | 64 工具 | ❌ **未完成** | ✅ | ❌ 目标不匹配（§6） |
| ~~D. key-pool-proxy~~ | — | 无工具面（基础设施） | ✅ | ❌ | ❌ 关掉 = 模型调用断 |
| ~~E. switchboard~~ | — | — | ✅ | ❌ | ❌ 底座，关掉栈起不来 |

⇒ **只有 A 能同时满足"已完成 + 能关 + 结构性匹配"。**

### A.3 为什么 A 是【结构性】匹配（这是关键）

**委派能力与"改代码"这类任务【正交】** ⇒ **可以把题设计成"必须委派"**：
- 关掉后 ⇒ **不是"更贵"，而是"做不到"**（单个 agent 只能给一个视角）
⇒ **区分度不靠"规则陷阱"（`cli-0005` 那种），而靠【机制的有无】** —— 比 §2 说的"难度须靠陷阱 + 成本"**更硬**。

**★ 而且它就是我们产品方向的核心**：`revised-architecture-2026-09-20.md` 的**顶层 = 专家评审团（多模型讨论）**
⇒ **测委派 = 提前验证架构的核心机制** ✓

### A.4 配对的题（`cli-0006`，待落盘）

**题面（不变量）草案**：

> 对**同一份改动**（给定 diff），产出 **3 个独立视角的审查结论**，
> 每段必须含：**视角名** / **结论** / **依据**（指向具体文件:行）；
> 并且**必须**让其中一个视角对另外两个做**对抗性检查**（指出它们可能的错或遗漏）。
> ⇒ 交付物是**结构化文本**（不是代码）。

**oracle（**行为 + 结构**两条腿，以行为为主）**：

| 面 | 判据 | 为什么 |
|---|---|---|
| **★ 行为** | 轨迹里 `subagent` / `subagent_fork` / `council_architect` **合计被调用 ≥3 次** | **那才是"确实用了委派"的证据** ⇒ 也是"能力关"臂必然红的那个面 |
| 结构 | 产物含 3 段独立结论（各有视角名 + 依据）+ 1 段对抗性检查 | 防"随便写三段" |
| 成本 | `toolCalls` / `tokens` / `wallMs` / `dangerous` | **"值不值得留"的数据** |

**★ 预期（可证伪的形式）**：
- **能力开**：行为面绿（有委派）+ 结构面绿 ⇒ **FIXED**，但**成本可能更高**（起子代理要 token）
- **能力关**：**行为面必红**（无 provider ⇒ 委派调不通）⇒ **NOT-FIXED**
⇒ **成功率必然分化（1/1 vs 0/1）** ⇒ 那就是 §8 要的"成功率有区分度" ✓
⇒ **而更有价值的是成本面**：**开着的能力，值不值那份额外 token？** ← 那才是"值不值得留"的答案

### A.5 ⚠️ 这个方案的两个风险（诚实写出）

1. **行为面判据可能退化成"测工具存在性"**
   —— 它测的是"有没有调那个工具"，**不等于"委派带来了更好的结论"**。
   ⇒ 缓解：**成本面为并列主判据**（若开着的臂只是更贵、结论没更好 ⇒ 那就是"不值得留"的结论 ✓）
2. **`subagent-council` 摘掉后，`subagent` 工具会不会【自动摘除】还没实测**
   —— 上游注释说"注册 provider → 委派工具自动 mount；注销 → 自动摘除"，
   但**本仓库没验过**。⇒ **落题前必须先干跑一次**（`make-profile-variant --drop-insert` + 就绪闸读工具面）
   —— **这正是"先证明判据成立、再拿它测"的纪律**。

### A.6 执行顺序（建议）

1. **先干跑**：造一个"无 `subagent-council`"的 profile 变体 ⇒ **读它的工具面** ⇒
   确认 `subagent*` 是否真的消失（**决定性事实**，决定第 2 步的判据）；
2. **落 `cli-0006`**（按 §4）+ 用 `eval-validate` 证明"HEAD 上 oracle 红"（能力不存在 ⇒ 行为面红）；
3. **跑单臂基线**（`council` preset，同 HEAD）⇒ 拿到"开着时"的成本；
4. **跑 `--pair`**（`--profileA <有> --profileB <无>`，**同 preset**）⇒ 看成功率与成本是否分化；
5. 只有分化了，才谈接 **M2**（`verifyCmd`）。
