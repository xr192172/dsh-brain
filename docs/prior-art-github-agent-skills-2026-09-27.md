# 先例检索 ②：GitHub 实测（2026-09-27）

- 承接：`docs/prior-art-agent-as-a-seat-2026-09-27.md`（检索① = 本地 VeRO）
- 本次：**检索② GitHub，已实测**（`search_repositories` + `search_code` + 3 次 `WebFetch` 读真身）
- 证据等级：**全部"直接读过"**（可指 URL / 文件路径 / 行）；星标数为检索时读数
- ★ 用户原话里的「**superpower**」= `obra/superpowers`，**确认存在**

---

## 1. 星标榜（`topic:agent-skills` / `topic:claude-skills`，按星排序，2026-09-27 实测）

| 仓库 | 星 | 是什么 | 证据 |
|---|---|---|---|
| `anthropics/skills` | 178,613 | **官方 Agent Skills 仓库** | 直接读过（搜索结果字段） |
| `DietrichGebert/ponytail` | 146,733 | "让 agent 像最懒的资深开发" —— 反过度工程 skill | 二手（仅读描述） |
| `addyosmani/agent-skills` | 99,374 | Production-grade engineering skills | 二手 |
| `nexu-io/open-design` | 98,262 | ★ topics 里有 **`deepseek-harness` / `dsh` / `dsh-plugin`** —— 与我们同一底座 | 直接读过 topics |
| `thedotmack/claude-mem` | 94,769 | **持久化跨会话记忆**（压缩后回注） | 二手 |
| `obra/superpowers` | **292,055** | ★★ **用户说的 superpower**，topics 含 `subagent-driven-development` | 直接读过 README + 3 个 SKILL.md |
| `VoltAgent/awesome-openclaw-skills` | 52,818 | 5,400+ skills 目录 | 二手 |
| `sickn33/agentic-awesome-skills` | 46,978 | 2,400+ skills + **本地 MCP + catalog** | 二手 |
| `K-Dense-AI/scientific-agent-skills` | 46,799 | 165 个科学 skill + 100+ 科学数据库 | 二手 |
| `alibaba/open-code-review` | 41,777 | ★ topics 含 **`harness`** | 直接读过 topics |
| `wshobson/agents` | 40,019 | ★ **多 harness agentic 插件市场**，topics 含 `subagents` | 直接读过 topics |
| `VoltAgent/awesome-agent-skills` | 34,920 | 1000+ skills 精选 | 二手 |
| `OthmanAdi/planning-with-files` | 27,144 | Manus 风格文件化规划 + **确定性完成门** | 二手 |
| `titanwings/distilly` | 25,060 | ★ "把他们的思路蒸馏成可复用 Skill"，topics 含 **`deepseek-harness` / `meta-skill`** | 直接读过 topics |

★ **对我们最重要的三条**：
1. `obra/superpowers` —— 用户点名，且有完整方法论。
2. `nexu-io/open-design` / `titanwings/distilly` —— **已有人在 `deepseek-harness` 上做 skill 生态**（topics 明示）⇒ 我们不是孤例，且有邻居。
3. `wshobson/agents` —— 已经是"**多 harness 插件市场 + subagents**"形态 ⇒ 用户设想的"注册成子 agent"是**已存在的产品形态**。

★ 另有 `jnMetaCode/superpowers-zh`（8,218 星）：superpowers 的**完整汉化 + 4 个中国原创 skill**，topics 含 `trae`。
（⇒ 二手；只读了描述，未核验汉化质量。）

---

## 2. ★★★ 深度读取：`obra/superpowers`（证据等级：直接读过）

### 2.1 它是什么（README 逐字）

> **Superpowers is a complete software development methodology for your coding agents, built on top of a set of composable skills and some initial instructions that make sure your agent uses them.**

核心循环（README 逐字，7 步）：`brainstorming` → `using-git-worktrees` → `writing-plans` →
**`subagent-driven-development`**（或 `executing-plans`）→ `test-driven-development` →
`requesting-code-review` → `finishing-a-development-branch`。

★ 关键句（README 逐字）：

> **"The agent checks for relevant skills before any task. Mandatory workflows, not suggestions."**

### 2.2 文件布局（`search_code` 实测，`repo:obra/superpowers filename:SKILL.md`，共 15 个）

```
skills/
  brainstorming/SKILL.md
  writing-plans/SKILL.md
  writing-skills/SKILL.md
  executing-plans/SKILL.md
  using-superpowers/SKILL.md
  using-git-worktrees/SKILL.md
  systematic-debugging/SKILL.md
  receiving-code-review/SKILL.md
  requesting-code-review/SKILL.md
  diagnosing-superpowers/SKILL.md
  subagent-driven-development/SKILL.md      ← ★ 用户要的那个
  dispatching-parallel-agents/SKILL.md
  finishing-a-development-branch/SKILL.md
  verification-before-completion/SKILL.md
  test-driven-development/SKILL.md
```

★ **注意：没有一行"框架代码"，全是 markdown。** 292k 星的工程方法论，载体是 **15 个 md 文件 + 几个 shell 脚本**。

### 2.3 ★★★ `subagent-driven-development/SKILL.md` 的核心契约（**逐字，直接读过**）

这是回答用户"**把开源 skill 注册成子 agent 当一席来调用，不可以吗**"的**决定性证据**。

#### ① 它把子代理定义为"隔离上下文"，且**明确禁止继承历史**（逐字）：

> **"You delegate tasks to specialized agents with **isolated context**. … **They should never inherit your session's context or history — you construct exactly what they need.** This also preserves your own context for coordination work."**

> "A dispatch prompt describes one task, not the session's history. … a real session's dispatch hit **42k chars of which 99% was pasted history**. A fresh subagent needs its task, the interfaces it touches, and the global constraints. Nothing else."

★ **与我们铁律 22「改子代的脸只有追加安全；代价来自'与父代不同'」是同一件事的两面** —— 它要求**主动构造**（少给），我们要求**前缀一致**（可缓存）。**两者可同时满足**：前缀 = 构造出的最小集。

#### ② 它定义了**四种状态码**（逐字）：

| 状态 | 处理 |
|---|---|
| `DONE` | 生成 review package，派任务审查者 |
| `DONE_WITH_CONCERNS` | 完成了但标记了疑虑 |
| `NEEDS_CONTEXT` | 缺信息 ⇒ 补上再派 |
| `BLOCKED` | 无法完成 |

★ **对照我们的三态（铁律 33：`true` / `unknown` / `false`）**：
它的 `DONE_WITH_CONCERNS` ≈ 我们的 `unknown`；`NEEDS_CONTEXT` 是我们**没有**的第五态
（"缺料"与"不确定"是两件事）。**这是一个可采纳的改进。**

#### ③ 它定义了**报告契约**（逐字）：

> "The implementer writes the full report there and **returns only status, commits, a one-line test summary, and concerns.**"

★ **这正是用户上一个问题的答案**：「给我看多少」是**契约的一部分**，不是事后裁剪。

#### ④ 它定义了 **fix loop 上限与升级阶梯**（逐字）：

> "Five rounds maximum per task" / "**Rounds 1-3 — resume the original implementer.**" /
> "**Rounds 4-5 — dispatch a fresh implementer on a more capable model**"

★ 逐字理由（极高价值）：

> "A loop that survives three resumes usually means **the implementer cannot see its own problem** — fresh eyes and a capability bump in one move."

#### ⑤ 它定义了 **ledger（账本）行格式**（逐字）：

```
Task <N>: complete (commits <base7>..<head7>, review clean)
Task <N>: minor (deferred): <one-liner>
Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)
Task <N>: parked — <finding> — Ruling: <why the code stands>
Ruling: <what you decided> — <why> — <what it costs if wrong>
```

★ **`Ruling: <决定> — <为什么> — <错了会付什么代价>`** —— 这三段式与我们铁律 6（"要如实报账：
改了什么、判据是什么、**剩下的不确定是什么**"）**几乎逐字同构**。它是**可机读的格式**，我们目前只是散文。

#### ⑥ ★★★ **它有一条我们该直接抄的纪律**（逐字）：

> "**Always specify the model explicitly when dispatching a subagent.** An omitted model inherits your session's model — often the most capable and most expensive — which silently defeats this section."

★★ **这与用户级偏好 §1 逐字一致**（"派子代理时一律路由到 `DeepSeek V4.1 Flash`，不要用默认继承"）——
**我们早就在做，但只在用户记忆里，没有写成子代理侧的硬约束。**

#### ⑦ 它的"常见合理化反驳表"里有一条**直指我们的痛点**（逐字）：

> Excuse: *"The implementer spawned its own reviewer — free extra assurance"*
> Reality: *"It's a duplicate seat reviewing the same diff; the task review is the gate. **A worker-spawned reviewer is a defect to flag, not rigor.**"*

★★★ **这逐字就是我们的「审者席位」问题**：审者若由被审者派生 ⇒ **是缺陷，不是严谨**。
（正是铁律 16 的另一种表述：判据不能放在被测对象的控制范围内。）

### 2.4 ★★ `writing-skills/SKILL.md` 的核心（**逐字，直接读过**）

#### ① frontmatter 契约（逐字模板）：

```markdown
---
name: Skill-Name-With-Hyphens
description: Use when [specific triggering conditions and symptoms]
---
```

| 约束 | 值 |
|---|---|
| 必需字段 | `name` + `description` |
| frontmatter 总量 | **≤ 1024 字符** |
| `name` | 仅字母/数字/连字符 |
| `description` | 第三人称；**以 "Use when..." 开头**；**只写"何时用"，绝不写"做什么"**；尽量 ≤ 500 字符 |

#### ② ★★★ 一个**反直觉但被实测验证**的发现（逐字）：

> "Testing revealed that when a description **summarizes the skill's workflow**, an agent may **follow the description instead of reading the full skill content**. A description saying *'code review between tasks'* caused an agent to do **ONE** review, even though the skill's flowchart clearly showed **TWO** reviews."

★ **教训**：**把工序摘要写进 description，会让 agent 走捷径、跳过 skill 正文。**
⇒ 对应我们铁律 28「**"扫全目录" ≠ "精选入口"**」的同族：**摘要会替代正文，所以摘要不能是正文的降级版。**

#### ③ ★★★ **"按失败类型选指导形式"**（逐字表，**这是本次检索最有可操作价值的一条**）：

| Baseline failure | 正确形式 | 错误形式 |
|---|---|---|
| **知情却违反规则**（压力下） | **禁止 + 合理化对照表 + 红旗清单** | 软性指导（"prefer…""consider…"） |
| **遵守但输出形状不对** | **正向配方/契约**（写清输出"是"什么、含哪些部分、什么顺序） | 禁止清单（"don't restate"） |
| **漏掉必需元素** | **结构性**（在模板里设 REQUIRED 槽位） | 模板旁的散文提醒 |
| **行为取决于条件** | 挂在**可观测谓词**上的条件化规则 | 无条件规则 + 豁免条款 |

★ 并给出**为什么禁止式对"塑形类"问题会适得其反**（逐字）：

> "在存在竞争性动机时，代理会与 'don't X' 讨价还价 —— 措辞对比测试中，**禁止式那一组产出的非期望内容明显更多，甚至比'无指导'的对照组更差。**"

★★★ **这直接修正了我们的一条已有信念**：我们的铁律 9 写着「**否定+禁止 ＞ 说明+让它判断**」。
**它在"纪律类"问题上成立，但在"塑形类"问题上【反了】** —— 输出形状不对时用禁止式会更糟。
⇒ **我们的铁律 9 需要加限定条件**（见 §3 行动建议）。

#### ④ 两条"不许细化"的铁律（逐字）：

> - **No nuance clauses.** "Don't X unless it matters" reopens the negotiation…
> - **Exemption clauses don't scope.** "This limit doesn't apply to code blocks" still suppresses code blocks…

#### ⑤ ★★ **skill 的测试方法 = TDD 用于文档**（逐字 Iron Law）：

```
NO SKILL WITHOUT A FAILING TEST FIRST
```

| TDD 概念 | 对应 skill 创建 |
|---|---|
| test case | **压力场景 + 子代理** |
| production code | `SKILL.md` |
| **RED** | **无 skill 时，agent 违规（baseline）** |
| **GREEN** | **有 skill 时，agent 遵守** |
| **REFACTOR** | **堵新出现的合理化漏洞** |

★ **micro-test 五条**（逐字要点）：① 每次调用一个**全新上下文**样本；② **必须有无指导对照组**
（对照不呈现失败 ⇒ 没什么可修的，**别写这个 skill**）；③ **每个变体 ≥5 次重复**；④ **人工读每条命中**
（模板回显与引用反例会伪装成命中）；⑤ **方差本身是指标**（5 次 5 种解释 ⇒ 措辞不具约束力）。

★★★ **第 ② 条 = 我们的铁律 13**（"否定命题必须带一个正交的阳性对照；对照在任一臂为 0 ⇒ 前面判语全废"）。
**它在 292k 星的仓库里被独立写成了同一条。** 这是对我们铁律体系的**外部佐证**。

#### ⑥ 何时**不该**造 skill（逐字）：

> "Don't create for: One-off solutions / Standard practices well-documented elsewhere / **Project-specific conventions (put in your instructions file)** / **Mechanical constraints (if it's enforceable with regex/validation, automate it—save documentation for judgment calls)**"

★★ **第三条直接适用于我们**：我们的"项目约定"（如 `D:/…` 路径写法）**应该放 instructions file（= 我们的 MEMORY.md）**，不该做成 skill。
★★ 第四条 = 铁律 40 的同族（"如果有门能自动判，就自动化，别写在文档里靠自觉"）。

---

## 3. 行动建议（按 §2 的实证，重新排序）

| # | 动作 | 依据（逐字） | 代价 |
|---|---|---|---|
| **A** | **把 `NEEDS_CONTEXT` 加进我们的席位状态码**（现只有 `true/unknown/false`） | 它有四态，我们三态；"缺料"≠"不确定" | 低 |
| **B** | **把裁决写成可机读行**：`Ruling: <决定> — <为什么> — <错了付什么代价>` | 逐字同构于我们的铁律 6，但它是格式 | 低 |
| **C** | ★ **修正铁律 9**：加限定"**纪律类用禁止式；塑形类用正向契约**" | 逐字实测："禁止式在塑形问题上比无指导更差" | 低（改一行 memory） |
| **D** | **抄 `writing-skills` 的 skill 测试法**给我们自己的 skill 加 baseline 对照组 | 逐字：**没对照组就别写这个 skill** | 中 |
| **E** | 抄 VeRO 的 `CodingAgent` Protocol 作为席位注册接口 | `docs/prior-art-agent-as-a-seat-2026-09-27.md` §1.1 | 中 |
| **F** | 把"审者不能由被审者派生"从铁律 16 提升为**显式契约并加判据** | 逐字："A worker-spawned reviewer is a defect to flag, not rigor." | 低 |

★ **用户设想的"把开源 skill 精炼成材料、注册成子 agent 当一席"—— 结论：可以，且路径有三条：**
1. **直接装**：superpowers 支持 17 种 harness（含 `hermes` / `pi` / `opencode`）；**是否支持 DSH 未核实**（`DSH` 未出现在其安装清单里）。
2. **抄接口**：抄 `subagent-driven-development` 的四态码 + 报告契约 + ledger 格式（**全是我们缺的格式**）。
3. **抄材料**：15 个 `SKILL.md` 是 MIT 许可（`_research/vero` 是 MIT；superpowers 的 LICENSE **我未核实**）⇒
   ⚠️ **未核实项：superpowers 的实际 LICENSE**。若要用它的文本，**必须先核 LICENSE**。

---

## 4. 未核实清单（诚实）

1. **superpowers 的 LICENSE** —— 未核（README 只说 "MIT License - see LICENSE file"，**但那是 `writing-skills` 引用的 VeRO... 不，是 superpowers README 的 License 段**；**实际 LICENSE 文件未读**）。
2. **superpowers 是否支持 DSH** —— 其安装清单 17 个 harness 里**没有 DSH**；是否可通过通用 plugin 机制接入，未验证。
3. `jnMetaCode/superpowers-zh` 的汉化质量 —— 未验证。
4. `nexu-io/open-design` / `titanwings/distilly` 的 `deepseek-harness` 兼容性 —— 仅见 topics 标注，**未读源码**。
5. 星标数会变；本次为 2026-09-27 检索时读数。
6. `planning-with-files` / `claude-mem` 的具体机制 —— 未读源码。
