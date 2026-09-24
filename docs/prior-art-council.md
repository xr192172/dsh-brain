# 先例调查：多模型协作 / 组合 / 路由（"议事厅"的 prior art）

> ★ **为什么写这份**：本项目铁律 #17 —— **做任何"功能组模块"之前，先查三处**（本地源码 / GitHub / arXiv）。
> 本文件是 **"议事厅（`packages/subagent-council`）"** 的 prior art 调查结果。
> ★ 证据分级：**直接读过** / **二手汇总** / **推断** —— 每条都标了。

---

## 0. 一句话结论

★ **"多模型协作达到更强模型效果"这件事有三条成熟路线，而我们的设计在【验真 + 执行闭环】两点上超过它们；
但在【收益是否被度量】和【防对抗/防橡皮图章】两点上，我们【落后于现有研究】。**

---

## 1. 三条先例（**都是直接读到的**）

### ① `LLM-Blender`（**2023-06-05**，ACL 2023）—— **"组合 + 路由"**
- 作者：Dongfu Jiang, Xiang Ren, Bill Yuchen Lin；★ GitHub `yuchenlin/LLM-Blender`（last commit `Jun 4, 2023`）
- ★★ **两个模块**（论文逐字）：
  > **"`PairRanker` … a specialized pairwise comparison method to distinguish subtle differences between candidate outputs"**
  > **"`GenFuser` … merge the top-ranked candidates … by capitalizing on their strengths and mitigating their weaknesses"**
  ⇒ ★ **`PairRanker` = 路由/选择**；★ **`GenFuser` = 组合/融合** —— ★ **即用户说的"小模型组合和路由"** ✓
- ★ 一句话（原话）：**"cut the weaknesses through ranking and integrate the strengths through fusing generation"**
- ★ 基准：`MixInstruct`（11 个开源 LLM 的回答，100k/5k/5k）
- ★★ **副产品 `PairRM`**：**0.4B（DeBERTa）的成对奖励模型**，**"pairwise comparison agreement 【approaches GPT-4's performance】"**
  ★ 表：`PairRM (0.4B)` 平均 **59** vs `GPT-4-0613` **63.87**
  ★ 原因（原话）：**① 为成对比较专门设计的架构（双向注意力）② 大规模高质量人类偏好标注**
  ⇒ ★★ **⇒ 对我们直接有用：0.4B 的小模型可以当"评审席/裁判席"** ✓

### ② `Mixture-of-Agents (MoA)`（**2024-06**，ICLR 2025 Spotlight）—— **"分层汇总"**
- Together AI；★ GitHub `togethercomputer/moa`（50 行版）
- ★★ **纯开源模型 AlpacaEval 2.0 = 65.1% vs GPT-4o 57.5%（+7.6%）**；MT-Bench 9.25 vs 9.19
- ★★★ **核心机制 `collaborativeness`**：**"an LLM tends to generate better responses when presented with outputs from other models, 【even if these other models are less capable】"**
- ★ 角色二分：**`Proposer`（求多样）+ `Aggregator`（评判+合并）**；★ **分层**（每层看上一层全部输出）
- ★ **不需训练**（纯推理编排）；★ **代价：首 token 慢**

### ③ `Multi-Agent Debate`（**Du et al., ICML 2024**，MIT+Google Brain）—— **"互相批评收敛"**
- GitHub `composable-models/llm_multiagent_debate`
- ★★ **"society of minds"**：各自答 ⇒ **读并批评其他所有实例** ⇒ 多轮 ⇒ 收敛
- ★★★ **"甚至当所有 agent 都从错误答案开始，辩论也能把群体推向正确答案"**
- ★ **3 实例 + 2 轮就有明显提升**（更多继续提升，**收益递减**）
- ★ **判决三法**：投票 / 共识 / 裁判

### ④（补充）"AI Council" 工作流（Duke，2026-05）—— **最接近我们的流程**
- ★ 结构：**定义"真相标准" → 分配【有意义差异】的角色（Analyst / Skeptic / Evidence Checker / User Advocate / Implementation Lead / Final Synthesizer）→ 先要求分歧再综合 → 结论与置信度分开**
- ★★★ **Step 3 原话**：**"在给出最终答案前，每个角色必须指出至少两条顾虑或反对意见。在分歧被陈述之前不许综合。"** ⇒ **"这能防止议会变成橡皮图章"**

---

## 2. ★★★ 已知失败模式（**必须防**）

| # | 失败模式 | 出处 | 对我们的含义 |
|---|---|---|---|
| **1** | ★★★ **一个"能言善辩的对抗性 agent"能把多智能体辩论【推向错误答案】、降低准确率、并让群体对错误达成共识** | **2026 Scientific Reports**（**二手汇总**，未读原文） | ★ **"更多 AI 声音 ≠ 更多真相"** ⇒ 需要**结构 + 证据 + 人的监督** |
| **2** | ★★ **裁判若与参与者是同一模型，会偏向熟悉的论证风格** | Multi-Agent Debate 论文 | ★ **支持我们"独立见证者"的设计**（换模型/独立上下文） |
| **3** | ★★ **简单自我反思会卡住**（模型一旦对初始答案有信心）；**结构化辩论才鼓励发散** | 同上 | ★ **要"强制分歧"，不能只让它自查** |
| **4** | ★ **收益随基线强度递减**（小模型集成能追平大模型；换成强聚合器提升就小） | MoA（**推断**：它自己也说 GPT-4o 版与纯开源版差距模式不同） | ★ **必须度量"1 席 vs 2 席 vs 3 席"，别假设越多越好** |
| **5** | ★ **成本/延迟成倍**（MoA 承认首 token 变慢） | MoA | ★ 开发任务不在乎秒级延迟，**但要在记录里记账** |

★ `LLM-Blender` 自己的 GitHub issues（**直接读到的**）**没有"方法无效"的证据**，只有工程问题：
**`#8 Unable to reproduce the results`**（复现困难）/ **`#22 依赖重`** / **`#33 transformers v5 破坏了它（仍 open）`** /
**`#30 torchrun 训练脚本报错（open）`** / **`#24 Training the GenFuser（open）`** / `#11 无网加载失败` / `#20 重训要显存`。

---

## 3. ⇒ 对我们的建议（"议事厅 v1"）

### 要**学**的（三条）
1. ★★★ **`collaborativeness`**：**把"别人的输出"作为输入喂给它**（★ 不是各做各的互不相干）—— ★ MoA 与 Debate 的共同点
2. ★★★ **"先要求分歧，再综合"**（★ 每个席位必须给 ≥2 条反对意见；**分歧未陈述不许综合**）—— ★ 防橡皮图章
3. ★★ **评审/裁判席可以用【小模型】**（`PairRM` 0.4B 接近 GPT-4）⇒ ★ **便宜、可本地、且与被评者不同源**（★ 顺带解了失败模式 #2）

### 要**做**的（我们独有、而且比它们强的）
4. ★★★ **"验真"席**：**派模型去【查文件的真实实现】**（★ 三个先例**都没有**这步 ⇒ ★ **它们停在"说"**）
5. ★★★ **执行闭环**：**交子代理做 → 议事厅复查 → 最高层复查 → 回执**（★ 三个先例**都只产文本**）

### 要**防**的
6. ★★★ **收益必须被度量**：**用我们自己的判据装置**测"1 席 / 2 席 / 3 席"的差异 —— ★ **否则扩席只是"看起来更热闹"**
7. ★★ **防对抗带偏**：★ **不让任何一席独占"总结权"**；★ **顶层确认席必须看【分歧清单】而不是【共识摘要】**；★ **保留人的决策点**
8. ★ **记账成本**（★ 延迟/token 成倍）

### v1 形态（**先做 2 层，别一上来 5 席**）
```
拆解（架构师席，★ 现成 persona：五段式）
  → 提议（2–3 席，各配不同 model）            ← MoA 的 Proposer
  → ★ 强制互相指正（每人 ≥2 条反对）          ← Council Step 3
  → ★ 核查（只读工具集的核查席，去查真实实现）  ← 【我们独有】
  → 汇总（★ 与参与者不同来源）                ← 防失败模式 #2
  → 顶层确认（带【分歧清单】+ 置信度 + 风险 + 人的决策点）
  → 执行（子代理）                            ← 【我们独有】
  → 复查（议事厅 + 最高层）                    ← 【我们独有】
  → 回执（WorkBuddy = 用户代理）
```

---

## 4. 与现状的差距（`packages/subagent-council`）

| 环节 | 现状 |
|---|---|
| 席位 | ❌ **只有 1 席（架构师）** |
| 装配 | ❌ **未接进任何 profile（孤儿包）** |
| 架构师 persona | ✅ **已有，且质量高**（五段式 + 反编造 + 不许删反面意见） |
| 多模型入口 | ✅ **机制已留**（`Config.model` / `Config.provider`；"每席一个 provider"） |
| 核查 / 汇总 / 顶层确认 / 复查 | ❌ 都没有 |
