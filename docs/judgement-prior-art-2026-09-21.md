# 判据机制的开源先例：查完了，结论与"直接引用"相反（2026-09-21）

> 触发（用户）：「判据雏形可以过 —— 但**具体是什么**？**会是我在 AI base 里的那些吗？会不会过时了？和现在这些适配吗**？
> 而且**不应该直接引用开源社区的吗**？」
>
> 做法：子代理做开源检索（三问）；**主代理逐条核验存在性与许可证**（按铁律 #17：不许编项目；
> 并**发现子代理引用的 mem0 行为已过时**，见 §3）。
> 相关：`docs/ai-base-asset-inventory.md`（资产对账）、`docs/self-evolution-master-plan.md` §5.3（我们的 L0–L4 阶梯）。

---

## 0. 先纠正审计的一处混淆：**"判据雏形"其实是两样不同的东西**

| | **ch12 DangerScorer** | **`gateDreamEntry` / `judgeDreamEntry`** |
|---|---|---|
| 轴 | **安全轴**：*"这个动作有多危险"* | **验收轴**：*"这条知识/改动该不该被接受"* |
| 内容 | 六维 0–100（数据破坏性 0-40 / 权限提升 0-40 / 不可逆性 0-20 / 路径风险 0-20 / 组合风险 0-15 / 范围风险 0-10）+ 四档（auto / soft 5s / hard / type_name 手输工具名）+ **50 校准用例**（auto×10 / soft×15 / hard×15 / type_name×10）+ 每维 `Explain()` | `gateDreamEntry` = **L1 机械门 + L2 向量查重 0.85**；`judgeDreamEntry` = **LLM 四维打分 + 五档期刊分区** |
| **Go 实现位置** | `agent-shell/permission/danger.go` + `danger_calibration_test.go` + `gate.go` + `policy.go` | **`agent-shell/internal/memory/sleep.go`** / **`builder.go`** |
| 对应我们哪一层 | 靶场的**危险动作读数**（我们现在只有 `eval-run.mjs` 的粗糙规则命中，**无分档、无校准用例**） | **L2/L3 的雏形**（`self-evolution-master-plan.md:186` 自己这么写） |

⇒ **把 ch12 说成"判据阶梯的雏形"是不准的** —— 它是**安全轴**的分级，不是**验收轴**的阶梯。
两者都该做，但**适配的目标不同**。

---

## 1. ① 工具调用危险度分级：**开源有"分档执行"，没有"我们的标尺"**

| 项目 | URL | 许可证 | ★ | 类型 | 它判什么 |
|---|---|---|---|---|---|
| **`microsoft/agent-governance-toolkit`（AGT）** | github.com/microsoft/agent-governance-toolkit | **MIT** | 6.3k | **生产级（Public Preview）** | YAML/OPA/Cedar 策略 → **allow / deny / `require_approval`(+approvers)**；零信任身份（SPIFFE/DID/mTLS）；**四级权限环沙箱**；Merkle 审计；**MCP 安全网关（工具投毒/漂移）**；Agent SRE（kill switch / SLO）；`agt verify --strict` 可做 **CI 门** |
| `rain6fish/KeelBase` | — | Apache-2.0 | **2** | 个人项目 | R0–R5 六档（自动/策略/人工/双人审批/封禁），**逐工具声明而非逐调用计算** |
| `webpro255/agentlock` | — | **AGPL-3.0** | 19 | 参考实现 | 五决策（含 STEP_UP）+ 会话累积风险分；**AGPL 是采用障碍** |
| `haoyuwang99/AgentSpec` | — | **无 LICENSE** | 53 | 研究代码（arXiv 2503.18666） | 四档含 `user_inspection`；**无证 ⇒ 不能合法采用** |
| `WhitzardAgent/AgentGuard` | — | GPL-3.0 | 141 | 研究/工程混合 | 工具调用 ABAC 准入，**无危险度评分** |

**★ 主代理核验（AGT，读了 README 原文）**：**真实存在、MIT、多语言 SDK（Py/TS/.NET/Rust/Go）、
10 份 RFC-2119 规格 + 992 条一致性测试 + 29 ADR**，覆盖 **OWASP Agentic Top 10 / NIST AI RMF / EU AI Act / SOC 2 / AARM R1–R9**；
`policy.yaml` 里确有 `action: require_approval` + `approvers: [...]`。
它**自己如实写了边界**：*"governance 在**应用中间件**层，不在 OS 内核层；policy engine 与 agent 同进程边界"*
+ 建议 *"每个 agent 跑在独立容器里获得 OS 级隔离"*，并附 `LIMITATIONS.md`。

**★ 关键结论（子代理的判定，我认可）**：**没有任何开源件同时具备"多维 0–100 数值分 + 四档（含手输工具名）+ 校准语料"**。
⇒ **分档执行 / 审计 / 身份 / MCP 安全：开源更成熟 ⇒ 该借（甚至该认真评估整体采用 AGT）；
六维评分 + `Explain()` + 50 校准用例：开源成色差 ⇒ 自研**（**这是结论，不是借口**）。

---

## 2. ② 记忆写入门：**⚠️ 子代理的推荐"过时"了 —— 我核验后推翻**

子代理推荐 **`mem0ai/mem0`（Apache-2.0，65.8k★，生产库）**，理由是它"LLM 抽取门（可输出 NOOP）→ 向量查相似 →
LLM 选 ADD/UPDATE/DELETE/NOOP，**≈ 我们 L1+L2(0.85)+LLM 评审三合一**，读写双阈值 0.7/0.9"。

**★ 但我读了 mem0 现行 README（主代理核验），它写的是**：
> **New Memory Algorithm (April 2026)** —— *"**Single-pass ADD-only extraction** — one LLM call,
> **no UPDATE/DELETE**. Memories accumulate; **nothing is overwritten**."*
> （另有：实体链接、多信号检索 = 语义 + BM25 + 实体融合、时间推理；**基准分数是托管平台的**，
> 开源 SDK "directionally similar but not identical"。）

⇒ **mem0 现在的算法是「只增不改不拒」** —— **它不做"该不该写进去"的判定**。
⇒ **子代理引的是旧算法**（ADD/UPDATE/DELETE/NOOP + 0.7/0.9 阈值确实出现在 mem0 的旧文档里）。
⇒ **所以 mem0【不是】"记忆写入门"的替代品**；它更像"**只增的记忆存储层**"，而我们 ② 要的是**拒写判定**。
（⚠️ **仍未确证**：开源 SDK 的默认流程是否仍保留 UPDATE/DELETE/NOOP 分支 —— README 讲的是新算法，
**要用起来必须先核 SDK 文档/源码**，不能凭 README 下结论。）

**其他候选**：`getzep/graphiti`（Apache-2.0，31k★）—— **也不拒写**，只做"合并 / 双时态失效"（比门**弱**）；
`langchain-ai/langmem`（MIT）—— 去重与门禁更弱。

⇒ **② 的结论**：**"拒写判定"这一格，开源成色一般**（mem0 转向 ADD-only、Graphiti 不拒写）
⇒ **ai-base 那套「机械门 → LLM 评审判据」的骨架在这个点上反而更贴合我们的需求** ⇒ **继续自研**，
但**可以借别人的"去重/矛盾判定"实现细节**（子代理另提一条：Graphiti 有过"静默失效"的第三方事故报告，**二手未核实**，
可作为"矛盾判定必须带回归门"的理由）。

---

## 3. ③ 验收阶梯 / 隐藏 holdout：**门禁借开源，阶梯本体自研，holdout 只有 VeRO**

| 项目 | 许可证 | ★ | 它是什么 | 对我们的价值 |
|---|---|---|---|---|
| `promptfoo/promptfoo` | MIT | 25.3k | YAML 断言、LLM-rubric、延迟/成本阈值、官方 PR Action | **门禁该借** |
| `confident-ai/deepeval` | Apache-2.0 | 18.4k | pytest 形态 + 50+ 指标（含 ToolCorrectness / TaskCompletion） | **门禁该借** |
| `UKGovernmentBEIS/inspect_ai` | MIT | 2.8k | 政府级 solver/scorer/log 框架 | 可借 |
| `openai/evals` | NOASSERTION | 19.5k | **陈旧**（最后提交 2026-04-14）；二手报道称 dashboard 关停（**未核实**） | 不建议 |
| **`scaleapi/vero`** | **MIT** | 本机已 clone | **evaluator 拥有用例与评分、在优化循环之外**；dev/val/test | ★ **唯一"隔离按构造成立"的** |

★★ **holdout 的真假（这是最值钱的一条）**：**promptfoo / deepeval / inspect_ai 的"holdout"只是"另一份测试集"**
—— 数据集路径由你给，**agent 有文件权限就能读** ⇒ **与我们踩过的 R1 违规同类**。
**只有 VeRO 是架构性隐藏**（evaluator 在优化循环之外）；但按我们自己的核对（`docs/vero-integration-findings.md` §1.3），
**它的 20/40/40 与 `partition_digest` 并非代码强制**，只强制"partitions 引用的 case 必须在 manifest 里"
⇒ **"真隐藏"靠结构 + 流程纪律，不是可校验的不变量**。

⇒ **③ 的结论**：**CI 门禁层改用 promptfoo / deepeval（别自造门禁）；holdout 用 VeRO 或至少借它的 dev/val/test 协议；
L2（能力面）/ L4（效率面）的口径是本题特有 ⇒ 自研。**

---

## 4. 一句话总结（回答"不应该直接引用开源的吗？"）

**该引用的地方开源确实更好，但"判据设计"这一半恰恰是开源的空格。** 按层分：

| 层 | 谁更好 | 动作 |
|---|---|---|
| 分档执行 / 审计 / 身份 / MCP 安全 | **AGT（MIT，比 ai-base 那份 Go 设计成熟得多）** | **借（或整体采用）** |
| CI 门禁（断言/阈值/rubric） | **promptfoo / deepeval** | **借** |
| 真 holdout 的**结构** | **VeRO** | **借结构 + 协议** |
| **多维危险度评分 + 校准语料** | **开源是空的** | **自研**（ai-base ch12 的设计没过时） |
| **记忆写入门（拒写判定）** | **开源是空的/成色一般**（mem0 转 ADD-only；Graphiti 不拒写） | **自研**（ai-base 门→评审的骨架更贴合） |
| **能力面 / 效率面口径（L2/L4）** | 本题特有 | **自研** |

⇒ **回到"会不会过时/适配"**：**ai-base 那两样里，过时的是"与宿主强绑的部分"**
（Go 权限三层、16 bash security layers、Hub 形态 —— 已被 DSH 原生 permission/sandbox 取代）；
**没过时的是"判据设计本身"**（六维 + `Explain()` + 50 校准用例；门 → 评审判据的骨架）
—— **而这一半正是开源没有更好的那一半。**
⇒ **所以"挂上阶梯"该以"判据设计"的身份过，不是"移植 Go 实现"过**；
**且能借的门禁与分档外壳，改用开源。**

---

## 5. 诚实清单

1. **mem0 的"现行算法已是 ADD-only"来自它 README 的 "What changed" 段**；**开源 SDK 是否仍保留 UPDATE/DELETE/NOOP 分支未确证** ⇒ 用它之前必须核 SDK 文档/源码。
2. **AGT 的 star 数、维护活跃度**我只核到"真实存在 + MIT + 多语言 + 992 测试 + 规格/ADR"；**star 数未独立复核**。
3. **KeelBase(2★) / agentlock(19★) / AgentSpec(无证) / AgentGuard(GPL-3.0) / ai-tool-guard(0★停更)** 来自子代理的 GitHub API 核对，**我未逐个复核**。
4. **"promptfoo/deepeval 的 holdout 只是另一份测试集"是我的判断**（依据它们的公开定位：数据集由你提供）——**未逐份读其实现**。
5. **arXiv 2605.10555**（风险基级 + 加性维度 + ≥2 即审批，与我们最像）**未找到公开仓库**；CSDN 的 `Risk=W×S/T>80` 是博客；Anthropic《Measuring AI agent autonomy》是度量研究不是库。
6. 本文件**不改任何代码**；结论只到"该借哪一层、该自研哪一层"。
