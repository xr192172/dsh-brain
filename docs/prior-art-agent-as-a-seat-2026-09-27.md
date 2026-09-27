# 先例检索：把开源 agent / skill 注册成"其中一席"

- **日期**：2026-09-27
- **触发**：用户问「市面上（Coze / TRAE / WorkBuddy）这些智能体是怎么实现的？GitHub 上有没有相关 skill 能精炼成材料、注册成子 agent、当其中一席来调用？」
- **纪律**：按 `oss-prior-art-first` 三处检索（①本地 ②GitHub ③arXiv），**每条标证据等级**。
- **结论一句话**：用户的想法**在 VeRO 里已经是一等公民接口**（`CodingAgent` Protocol，23 行）；同时**不抄袭也可行**——我们自己的席位机制已经做到了同构的东西。

---

## 1. 检索①：本地（最便宜，最容易跳过）

### 1.1 命中：`D:\project_develop\_research\vero\`（VeRO 全量源码）

| 项 | 值 |
|---|---|
| 仓库 | VeRO — *"A harness for agents to optimize programs, text, and agents"* |
| 论文 | arXiv **2602.22480**（README 徽章，**我没读论文原文** ⇒ 二手） |
| LICENSE | MIT（`_research/vero/LICENSE` 存在） |
| 语言 | Python 3.11+ |

★ **它逐字就是用户要的东西**（README 第 18 行，**直接读过**）：

> the target is anything you can put under Git and score — a **program** …,
> **text** (a prompt, spec, or config), or an **agent** (its scaffold, tools, and prompts).

★ **关键发现（本次最有价值的一条）**：`vero/src/vero/agents/protocol.py` 全文只有 **97 行**，
其中核心是一个 **`runtime_checkable` 的 `Protocol`**：

```python
@runtime_checkable
class CodingAgent(Protocol):
    async def run(
        self, *, context: AgentContext, prompt: str | None,
        max_turns: int, on_event: Callable[[Any], Any] | None = None,
    ) -> AgentRunResult | None: ...
```

⇒ **"注册成子 agent 当一席"不需要改 VeRO 一行**：实现这个 `async def run` 即可。
（证据等级：**直接读过**源码，可指文件名与行）

### 1.2 已存在的两个适配器（**直接读过**）

| 文件 | 行数 | 说明 |
|---|---|---|
| `agents/claude_code.py` | 364 | `ClaudeCodeAgent` —— Claude Agent SDK 适配 |
| `agents/vero.py` | 419 | `VeroAgent` —— VeRO 自家 agent |
| `agents/producer.py` | 166 | `AgentCandidateProducer` —— 把任意 `CodingAgent` 接进候选产出协议 |
| `agents/protocol.py` | 97 | ★ 协议本体 |

### 1.3 ★ "给什么工具"的实证（用户的第 2 类料，**直接读过**）

`agents/claude_code.py:35-46`：

```python
def default_tool_sets() -> list:
    return [EvaluationTools()]          # ← 工具集是【可注入的对象】

def _default_claude_options() -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        model="claude-sonnet-4-5-20250929",
        permission_mode="bypassPermissions",
        allowed_tools=["WebSearch", "WebFetch", "Task", "Bash"],   # ← 白名单
    )
```

⇒ 这正是我上一轮回答里那句话的**外部佐证**：agent 的"能碰什么"是**白名单枚举**，
不是 prompt 里写"你不许写文件"。**我们踩的坑（architect persona 说只读却真写了）在这里被架构层解掉了。**

### 1.4 ★ SKILL.md 实货（用户第 3 类料的活教材）

| 路径 | 内容 |
|---|---|
| `vero/src/vero/skills/evals/SKILL.md` | 完整读了。**121 行**，含 CLI 契约 + `.evals/` 目录协议 + 披露分级 + **"常见错误"清单** |
| `harness-opt-bench/skills/run-benchmark/SKILL.md` | 未读（仅确认存在） |

★ `evals/SKILL.md` 值得学的地方（**直接读过**，引用其原话）：

- **披露分级（disclosure）**：`full`（逐 case + trace + artifact）/ `aggregate`（只给总指标）/ `none`（只有 acknowledgement）
  ⇒ ★ **这正是我们缺的一层**：我们的判据只有 PASS/FAIL/unknown 三态，**没有"对谁披露到哪一级"这个概念**。
- **"常见错误"清单**（11 条）—— 把踩过的坑**写进 skill 喂给 agent**，例：
  > *"Comparing evaluations run on different case selections — deltas are then case-sampling noise, not signal."*
  > *"Claiming an improvement before the baseline's own evaluation finished."*
  ⇒ 与我们的铁律体系**同族**，但它写在**给 agent 读的 skill 里**（我们写在 MEMORY.md 里给自己读）。
- **预算由外部计量**：*"Budgets are enforced by the evaluator"* ⇒ 对应我们的"判据不能放在被测 agent 读写范围内"（铁律 16）。

### 1.5 ★ 本地结论（重要，且是"好消息"）

**我们自己的三席 `subagent-council` 与 VeRO 的 `CodingAgent` 是同构的。**

| 维度 | VeRO | 我们（dsh-brain） |
|---|---|---|
| 一席的接口 | `Protocol { async run(...) }` | persona + `SEAT_TOOL_SCOPE` 白名单 |
| 工具面 | `allowed_tools=[...]` 白名单 | `SEAT_TOOL_SCOPE` 白名单 |
| 知识面 | `skills/*/SKILL.md` | 11 个 skill 目录 |
| 判据面 | evaluator 拥有 case，held-out | 门层 + holdout（★ 未跑过） |
| 谁的进程 | 独立 Python 进程 | DSH 会话 |

⇒ **用户的"不可以吗？"回答：可以，而且两条路都通：**
① **抄接口**：让我们的席位也实现一个 VeRO 风格的 `run()` 契约 ⇒ 可被外部 harness 驱动；
② **不抄**：我们已经有了同构物，缺的不是架构，是**接口的标准化**（让"席"这个概念能被外部注册）。

---

## 2. 检索②：GitHub（**本次未做 —— 诚实标注**）

**我没做。** 理由与风险：

- 本次会话的时间/工具预算投给了检索①（本地，已拿到决定性证据）。
- ⚠️ **因此"开源市场上有哪些 agent skill 能精炼"这个问题，我没有答案。**
- **未核实的是**：GitHub 上 `topic:agent-skills` / `topic:claude-skills` / `awesome-agent-*` 这类聚合仓库的**实际数量与质量**。
- **验证方法**（下一步，半天内可完成）：GitHub 搜索 `topic:agent-skills`、`topic:llm-agent` + star 排序，
  配合 `gh search repos`；再对我们已发现的 `SKILL.md` 结构做**格式对照**。

### 2.1 关于 Coze / TRAE / WorkBuddy 的实现（**二手 + 推断，明确标注**）

| 产品 | 我的了解 | 证据等级 |
|---|---|---|
| **WorkBuddy** | ★ **我就在它里面运行**。它的 agent 机制我**可以直接观测**：skill 列表（本会话 40+ 条，含 `dc-add-tool`、`gate-authoring` 等自有 skill）+ Agent 工具（子代理，可选 model 路由）+ `subagent_type` 分类 | **直接读过其 system prompt 与工具面**（但不是它的源码） |
| Coze | 字节跳动的 Bot 平台，形态是**可视化工作流 + 插件（Plugin）+ 知识库** | **二手**（训练数据，未核实） |
| TRAE | 字节的 AI IDE，形态是**IDE 内嵌 agent + 规则文件** | **二手**（未核实） |

⚠️ **禁令遵守**：以上 Coze / TRAE 两行**不许当结论**。若用户要，需要联网核实（`WebSearch` + 官方文档）。

### 2.2 ★ 但有一条**可以确证的**共同结构

从 WorkBuddy 的**自身可观测面** + VeRO 的源码，**两类产品的 agent 都落在同一组五元组上**：

```
agent = 模型 + 系统提示 + 工具白名单 + 按需知识(skill) + 外部记忆/数据库
```

差别只在**哪一项是硬的**：
- WorkBuddy：`skills` 是**文件系统里可枚举的目录**（观测到）+ tools 有 `mcp__*` 命名空间隔离
- VeRO：`allowed_tools` 硬白名单 + `EvaluationTools()` 可注入
- 我们的：`SEAT_TOOL_SCOPE` 白名单

⇒ **用户的直觉（"不该只是人设+塞模型"）在这三个系统上都成立。**

---

## 3. 检索③：arXiv（**仅确认存在，未读**）

- `_research/vero/README.md` 徽章指向 **arXiv 2602.22480**。
- ⚠️ **我没读这篇论文。** 未核实的是：它是否给出了 agent-scaffold 优化的正式 benchmark 与拆档协议。
- **验证方法**：`WebFetch` 该 arXiv 摘要页，确认 benchmark 名与 held-out 协议。

---

## 4. 行动建议（三档，按代价排序）

### 档 1（零成本，立刻可做）—— 把 `CodingAgent` 协议抄成我们的席位契约
- 我们已有 `SEAT_PERSONAS` + `SEAT_TOOL_SCOPE`；加一层**显式的 `run(ctx) -> AgentRunResult`** 契约。
- 收益：席位可被**外部注册**（用户说的"注册成子 agent"），且**新增一席不改核心**。
- 判据：新增一席只需**加一个实现 + 一条注册**，**不改** `index.ts` 的判断逻辑。

### 档 2（低成本）—— 把 `SKILL.md` 的"披露分级"搬进我们的门层
- 我们目前只有 `PASS/FAIL/SKIP`；VeRO 是 `full/aggregate/none`。
- ⇒ 我们的三态（铁律 33）可以升级为**"三态 × 三级披露"**：判据本身怎么算是一件事，
  **给谁看多少**是另一件事。（本次用户就在问"给我看多少"—— 这正是那个缺口。）

### 档 3（需先补检索②）—— 扫 GitHub 的 agent-skills 生态
- 必须先做完 §2 才谈"精炼哪些做材料"。
- ★ **纪律**：不扫完不许回答"抄哪个"（本次我守住了这条）。

---

## 5. 未核实清单（诚实）

1. VeRO 论文 arXiv 2602.22480 的正式内容 —— 未读。
2. GitHub 上 agent-skills 类仓库的数量/质量/许可证 —— 未搜。
3. Coze / TRAE 的实际 agent 架构 —— 二手，未联网核实。
4. `harness-opt-bench/skills/run-benchmark/SKILL.md` —— 仅确认存在，未读。
5. VeRO 能否在本机离线跑起来（`vero harbor build` 是否需要凭据）—— 未试。
