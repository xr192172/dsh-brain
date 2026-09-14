# design-canvas 改名：发散、证据与推荐

> 状态：**★ 已定案（2026-09-14）**：正名 **`agentio`**（用户拍板："话说现在还没定名字吧，就叫 agent IO 算了"）。
> 中文可用「Agent IO / IO 层」；意象外号（天工 / 林 / 解析世界）不占契约、可继续当外号用。
> **待办**：机器契约层改名（MCP `serverName` → 工具前缀 `mcp__agentio__*`、`DESIGN_CANVAS_HOME`、
> `.design-canvas/` 数据根与 `.design-canvas.json`）是**独立一次性任务**，按 §7 两段式走（影响 179 文件）。
> 起于 2026-09-14 ｜ 背景：`ast-io-entry.md` 把它的身份从「可视化协议层」
> 推向「**agent 的读写编辑统一入口（AST 内核）**」—— 现名只覆盖旧身份的一小半。
> 同类项目怎么命名/怎么做的：见 `agent-code-io-landscape.md`。

---

## 1. 名字要表达的（来自新身份）

| 要表达 | 依据 |
|---|---|
| **AST / 树 / 解析** | 用户原话：「最重要的是一个 AST 解析……生成一棵 AST 树」 |
| **零前置 · 静默生长** | 「遇到某个项目就默认静默去解析」 |
| **精确读写（手与眼）** | 「精确编辑、精准解析、精确筛选」 |
| **基建性** | 「未来我们的 agent 基本上也会接入这一套基础底座」 |
| **家族对位** | 隔壁 `D:\project_develop\ai-base`（**AI-Base＝私有化 AI 智能基座 / AI 基建**）⇒ 这个是**Agent 基建** |

**不再表达**：`canvas`（可视化退化为一条能力线）。

---

## 2. ★ 两条实测硬事实（决定命名策略）

**事实 A：意象好词已被真实项目占满，且多是"同语义"占用。**

| 好词 | 占地者 | 讽刺点 |
|---|---|---|
| `canopy` | PEG parser compiler | **就是解析器** |
| `lexis` | a very simple lexer | **就是词法** |
| `scalpel` | a CSS selector parser | **还是解析器** |
| `silva` | A generic purpose immutable tree data structure | **就是树结构库** |
| `nan`/`tree-sitter`/`babel`/`jscodeshift` 生态 | 已被语言工具链长期占据 | — |
| GitHub `code-scalpel` | ★18「the bridge between Generative AI and Refactoring」 | **同类产品同名** |

**事实 B：`*base` / `*io` 这类"基建/IA 式"直白词反而大量空闲。**
（`agentbase`/`astbase`/`agentio`/`codeio`/`parsebase`/`syntaxbase` npm 全 FREE）

⇒ **命名策略结论**：
**机器名走「基建系」直白词（零解释、可占、前缀好看）；意象词（林 / 手术刀 / 解析世界）留作中文外号 —— 外号不进 npm、不进 MCP 前缀，成本为零，随便浪漫。**

---

## 3. 发散：八条命名轴

### A. 家族对位派（与 AI-Base 同构）—— 最符合用户直觉
| 候选 | npm | 语义 |
|---|---|---|
| **`agentbase`** | **FREE** | Agent 基建，与 `ai-base` 完全对位 | 
| `ast-base` / `astbase` | **FREE** | AST 基建；与 `ai-base` 押韵（ai↔ast 一字之差），GitHub 仅 5 个死库 |
| `syntaxbase` / `parsebase` | **FREE** | 语法/解析基建；GitHub 近空 |
| ⚠️ 反例 | `agent-base` **TAKEN**(2026，function→http.Agent)；`codebase` 语义已被占用（代码库），禁用 |

### B. IO 本体派 —— 最贴"读写编辑统一入口"这个**本体**
| 候选 | npm | 语义 |
|---|---|---|
| **`agentio`** | **FREE** | Agent 的 I/O（读/写/编辑）；GitHub 仅 2 个小库（★3/★5），无同类 |
| `agent-io` / `codeio` / `code-io` / `rwbase` | **FREE** | 同上，形态变体 |
| ⚠️ `agentio` 风险 | — | 68 个 name 命中里有个 ★101 的 `agention-marshall`（相近但非同名）；无实体撞车 |

### C. 手术刀派（用户提出「代码手术刀」）
| 候选 | npm | 评价 |
|---|---|---|
| `code-scalpel` / `codescalpel` | **FREE** | 隐喻最准（AST 级精确编辑＝手术）；但 GitHub 已有 ★18 同类 AI 重构工具 |
| `bistoury`（小手术刀）/ `vivisect`（活体解剖） | **FREE** | 更冷僻、更独特；缺点是要解释 |
| `scalpel` / `lance` / `lancet` | TAKEN | 本体全占（讽刺：`scalpel` 是 CSS 解析器） |

> **建议**：手术刀**别做正名，做能力线的名字** —— 例如 `code_edit` 那条线就叫「手术刀线」，
> 既有画面又不占契约。

### D. 世界派（用户提出「解析世界」「代码世界」）
- 中文极好：有气势、有画面，适合做**文档副标题 / 中文外号**（如「agentio · 解析世界」）。
- 英文不建议正名：`codeworld` 已被占（2025 小库）、`parseworld` 近空但 8 字母 + 非工程语感；
  MCP 工具前缀会变成 `mcp__parseworld__*`，每次调用都长。
- 评价：**留作外号，不作契约。**

### E. 林 / 树派（上一轮主推 `silva`）
- 语义最贴（AST＝树），但见事实 A：`silva`/`arbor`/`banyan`/`woodlot`/`canopy` **全被占**。
- 评价：**降级为中文外号「林」**（"让林先把这片代码建起来"）—— 零成本、可浪漫。

### F. 拆分派（架构分流，别急着整体改名）
把**内核**独立命名（`agentio`/`astbase` 一包一仓），`design-canvas` 保留为"它的一个可视化/DSL 应用"。
- ✅ 好处：改名面从 **179 文件** 缩到"新包的边界"；内核与应用生命周期解耦（内核换代不影响画布）。
- ❌ 代价：与"统一入口"愿景有张力（想要"一个东西既做内核又是入口"，名字却拆成两个）。
- 结论：**若近期不打算开源发布 ⇒ 值得认真考虑；若要"一个名字代表整套" ⇒ 走整体改名。**

### G. 前缀派（AI-Base 家族缩写）
`abio` / `ab-io` / `aib-agent` —— 极短，`mcp__abio__*` 最漂亮；但**纯自造缩写，零语义**，
外人看不懂，与"不要零相关的名字"相悖。

### H. 造词派
`syntaxbase`（已列）、`parsebase`、`agentbase-io` —— 兼顾"可占 + 有语义"，代价是略长。

### I. 角色派（用户 2026-09-14 新提：管家 / 代理 / Agent for agent / 助手的助手）

| 候选 | npm 实测 | 评价 |
|---|---|---|
| `steward`（管家） | TAKEN(2013) + 产品名遍地（steward.ai 等） | 语义其实贴（"替人看管某物的人"），但**"管家"是服务人的角色**，而这个东西**是被 agent 调用的能力层**，不是人格 |
| `butler` / `majordomo` / `valet` / `concierge` / `seneschal` / `adjutant` / `factotum` / `aide` / `squire` | **全部 TAKEN** | 好看的角色词一个不剩（再次验证事实 A） |
| `agentproxy` / `proxyagent` / `metaagent` / `agentofagent` | **FREE** | 唯一空闲的一组，但 `proxy` 与**网络代理**严重撞义（npm 上现有 `agent-proxy` 就是给 agent 用的 HTTP 代理）；`metaagent`/`agentofagent` 听着像递归黑话 |
| `curator-agent` | FREE | "策展人/看管人"，比 proxy 语义干净，但仍是要解释的角色名 |

**结论**：角色派**语义上有道理、工程上不划算** —— 好看的词全被占，剩下的都撞义或需要解释。
真正的判断还是回"这个东西是什么"：**它不是管家，是手眼（IO 层）**。

> ★ **反例校准（重要）**：用户最初的顾虑是"不要零相关的名字"，但同类里最成功的 **Serena ★29.3k**
> 用的正是一个**跟代码毫无关系**的意象美名（希腊语"美丽"，德国两人团队起的）。
> ⇒ **"零相关"本身不是问题，被占用才是问题。** 硬指标只有三个：**唯一 + 好念 + 好记**。

---

## 4. 收敛：五道闸打分

| 闸 | 问什么 |
|---|---|
| ① 语义命中 | 能否说清"给谁用/干什么"？ |
| ② 中文口播 | 每次对话都要说，≤3 字最好 |
| ③ 契约友好 | MCP 前缀 `mcp__X__*` 短、无歧义、无连字符歧义 |
| ④ 唯一性 | npm + GitHub 实测 |
| ⑤ 家族对位 | 在 `ai-base` 谱系里是否说得通 |

| 候选 | ① 语义 | ② 口播 | ③ 前缀 | ④ 唯一 | ⑤ 家族 | 合计 |
|---|---|---|---|---|---|---|
| **`agentio`** | ✅ IO＝读写编辑，最准 | ✅「agent IO / IO 层」 | ✅ 7 字符，无歧义 | ✅ npm FREE；GitHub 无同类 | ✅ AI 基建 → Agent IO | **5/5** |
| **`agentbase`** | ✅ Agent 基建 | ✅「Agent 基建」 | ✅ 9 字符 | ⚠️ npm FREE，但 GitHub ★248 多智能体编排器 + 学术 ABM 抢词义 | ✅ 最对位 | 4.5/5 |
| `astbase` | ⚠️ 只说了机制（AST），没说"给谁用" | ✅「AST 基建」 | ✅ | ✅ 近空 | ✅ 与 ai-base 押韵 | 4/5 |
| `code-scalpel` | ✅ 动作最准 | ✅「手术刀」 | ⚠️ 11 字符 | ⚠️ GitHub ★18 同类 | △ 与 AI 基建不成族 | 3/5 |
| `parseworld` | △ 解释不了"编辑" | ✅「解析世界」 | ✗ 太长 | ✅ | △ | 2.5/5 |
| `silva` | ✅ 树 | △ 需解释 | ✅ | ✗ npm/GitHub 双占 | △ | 2.5/5 |
| `abio` | ✗ 零语义 | ✗ | ✅✅ | ✅ | △ | 2/5 |

---

## 5. 推荐

> **当前状态（2026-09-14）**：用户拍板 **先挂 working name `agentio`**（"那就 agent 的 IO 吧"），
> **正式定名保持待定**；同时排除了「管家/代理」角色派（见 §3-I）。
> 结论仍以下面三条为准 —— 定了就按 §7 两段式动手。

### 主推：**`agentio`** —— 「AI 基建里的 Agent IO 层」

- **语义最准**：它干的就是 agent 对代码的 **I/O**（精确读 / 筛 / 写）——不是又一个"框架/画布"。
- **家族最顺**：`ai-base`（AI 基建）→ `agentio`（Agent 的 IO 基建）；一句话能向任何人解释清楚。
- **契约最干净**：`mcp__agentio__*`；`agentio`(npm FREE)；GitHub 无同类。
- **外号随便起**：中文可叫「**IO 层**」，意象外号可叫「**解析世界**」或「**林**」——**外号不进任何契约**。

### 备选 1：**`agentbase`**（你的直觉）
最对位「Agent 基建」，npm FREE；唯一顾虑是搜索语境里 `agentbase/AgentBase` 已被
**多智能体编排器（★248）** 与学术 **ABM（Agent-Based Modeling）** 占据 —— 作为**内部**名字完全够用，
若将来开源、要在搜索里被找到，会吃亏。

### 备选 2：**`astbase`**（机制向）
`ai-base` ↔ `ast-base` 一字之差，是这组里最好听的**家族押韵**；npm/GitHub 近空。
缺点：只说了"AST"，说不清"给 agent 用"，也说不清"还能编辑"。

### 中文昵称解耦（重要）
| 层 | 用什么 | 例子 |
|---|---|---|
| 机器契约 | 正名字典（英文、小写、可占） | `agentio` |
| 口头/文档 | 中文外号 | 「Agent IO 层」 |
| 意象/叙事 | 随便浪漫，不限一个 | 「解析世界」「代码手术刀（=code_edit 线）」「林」 |

⇒ 你纠结的「解析世界 / 代码世界 / 代码手术刀」**全部保留**，只是**不占 npm 名**。想用哪个写进文档都行。

---

## 6. 迁移影响面（实测）

| 面 | 量级 | 位置 |
|---|---|---|
| design-canvas 仓内引用 | **179 个文件** | `package.json`、README×2、AGENTS.md（**改 `scripts/gen_agents.mjs` 源头**）、`.trae/skills/design-canvas-{mind,router}`、`.trae/mcp.json`、`docs/`、`schema/*.json`、`scripts/*`、`tests/*`、`go-observe/*`（Go module 路径） |
| **机器契约** | 少量但致命 | ① MCP `serverName` → 工具前缀 `mcp__<name>__*` ② `DESIGN_CANVAS_HOME` ③ 数据根 **`.design-canvas/`**（已有真实 feature/基线数据）④ 项目配置 **`.design-canvas.json`** ⑤ npm 名 / CLI bin |
| DSH 侧 | 3 处 | `~/.dsh/profiles/web/cordis.patch.yml`（`serverName`+env+`cwd`）、`packages/design-canvas-bridge/`、`~/.dsh/capabilities/registry.json` 的能力条 id |
| 记忆/文档 | 多处 | `dsh-brain/.workbuddy/memory/*`、`docs/*`、skill 文本、persona 里的工具名 |

> 教训参考：本仓 `docs/tool-convergence.md` §5.7 记过一次**单个工具**改名波及 **37 个文件**，
> 且 `rename_*` 工具**认不出**注册名字面量与 user-facing 字符串 ⇒ 必须走 `report_literals` + 分 kind 决策。

---

## 7. 建议的两段式迁移（不要滴灌）

**A 段 · 品牌层（低风险，可先做）**：仓名 / README 标题 / 文档 / 显示名 / skill 名 / 能力库 label / 中文外号。
不动机器契约 ⇒ 现有 agent、缓存、数据全不受影响。

**B 段 · 机器契约层（一次原子 + 单独提交 + 可回滚）**
1. `package.json` name/bin + `src/server.ts` 的 MCP server name
2. `~/.dsh/profiles/web/cordis.patch.yml` + bridge 包 + 能力库登记
3. **旧名兼容**：`.design-canvas/` 与 `.design-canvas.json` 建议"新名优先、旧名回退"，否则要迁移已有 feature 数据
4. 跑 `npm run check:profile` + `check:bom` + 全量回归 + **一次换代**验收（工具前缀变了 ⇒ 首轮命中率必然 0%，属预期）
5. Dogfood：`rename_symbols report_literals=true` 先出清单 → 按 kind 决策 → 再 `apply_literals`

**验收判据**：① `mcp__<新名>__capability_map` 调通 ② 旧数据/旧 config 仍可读 ③ 装配基线行数不变 ④ 换代后工具数仍 **60**

---

## 8. 待用户确认

1. **定名**：`agentio`（主推）/ `agentbase`（备选·对位）/ `astbase`（备选·机制）/ 其他？
2. **中文外号**用哪个：「IO 层」/「解析世界」/「林」/ 允许并存？
3. **是否近期开源**？影响唯一性权重（要发 npm 就选 FREE 的名；内部用则随喜好）
4. **是否走「拆分派」**（内核独立命名 + design-canvas 退为应用）—— 可把 179 文件改名缩到最小
5. **`.design-canvas/` 数据根与 `.design-canvas.json` 是否一起改**（建议：改新名 + 读旧名兼容）
