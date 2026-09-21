# 自造靶场 vs 开源：2026-09 的现实（该借的已经有人做完了）

> 触发：用户问「我之前问过有没有开源的靶场。**为什么还在这里自造靶场**？是不是必须适配 DSH？
> DSH 开源社区有没有？这么多做自进化 agent 的，不会没有任何一家人做靶场吧？」
> 本文是**现查**的结果（2026-09-21），不是复述 `docs/agent-eval-arenas.md`（那份是 09-20 的**题库清单**，本文补的是**装置/隔离**那一层）。
>
> ⚠️ 证据分级（照仓库惯例，不许混）：
> · **直接读过**（我亲自抓了页面）：`github.com/scaleapi/vero` 根 README、`harness-opt-bench/README.md`；
> · **二手汇总**（聚合站/媒体转述，未见原文）：HarnessDev 的细节、HarnessOpt-Bench 的"1.8×"等数字；
> · **推断**（未验证）：VeRO 能否把 target 换成 DSH。
> 下面每处都标了级别。

---

## 0. 一句话结论

**我们不该自造"竞技场的地基"——那一层 2026 年已经有人做完并开源（MIT、可直接跑），而且做得比我们好。
我们该自造的只剩两样：①「工具集/装配树」这个**自变量**（只有 DSH 有）；②**题源与判据**（我们的回归历史就是现成 oracle）。**

而且：**我们自己在 R1 上违规的那件事（判据放在被检 agent 可达处），恰是 VeRO 当"架构"来解的那件事。**

---

## 1. ★★ VeRO / HarnessOpt-Bench（Scale AI，MIT）——**这就是我们的项目**

- 仓库：`github.com/scaleapi/vero`（**直接读过根 README**）；许可证 **MIT**。
- 论文：*VeRO: A Harness for Agents to Optimize Agents*，**arXiv 2602.22480**，**ICML 2026**（引用块原文）；
  以及 *HarnessOpt-Bench*，**arXiv 2608.06301**（读自 commit message 里的 arXiv badge）。
- 自我定位（原文）：**"A harness for agents to optimize programs, text, and agents"** ——
  目标可以是 **program**（单函数到整个代码库）/ **text**（prompt、spec、config）/ **agent**（**scaffold, tools, and prompts**）。
- 循环：**version → evaluate → select**，**用 Git 做版本化**，**每个被评过的候选都保留可取回**。
- ★★★ **隔离是「架构性」的，不是「靠纪律」的**（原文）：
  - `The evaluator owns the cases and the scoring`（**evaluator 拥有用例与评分**）；
  - 优化器跑在 **sandbox**（Harbor 容器；core guide 里有 **no-bind-mount 的 `DockerSandbox` 示例**）；
  - **inference gateway 持有 provider key，并按 scope 计量花费**（per-scope budget）。
  - HarnessOpt-Bench 的立论原话：*"The isolation holds **by construction, not by instruction**: the held-out
    evaluator and permission control sit outside the loop that evolves the harness."*（**二手汇总**，但与仓库结构一致）
- ★★ **协议三档（这正是我们缺的判据预算设计）**（**直接读过 `harness-opt-bench/README.md`**）：
  1. **Development**：逐例反馈（per-case feedback）；
  2. **Validation**：**只给聚合分**；
  3. **Test**：**只有最终 evaluator 才能看到**用例与结果。
  切分 **20% / 40% / 40%**，写在 `baseline/build.yaml`（"that file is the source of truth"）。
  ⚠️ **2026-09-21 实测更正**：**"不可变"不是代码强制的** ——
  代码层真正强制的只有"**partitions 引用的 case 必须在 manifest 里**"；
  `ratios` 与 `partition_digest` 在 `src/` 里**零命中**（只出现在生成脚本中）⇒ 靠"由 seed 确定性重生成 + 流程规则"。
  **详见 `docs/vero-integration-findings.md` §1.3。**
- **现成 benchmark（4 套，同一结构）**：GAIA / OfficeQA / BrowseComp-Plus / **Terminal-Bench 2.1**；
  每套 = `target/`（**可被优化器编辑的 seed harness**）+ `partitions/`（钉住的 dev/val/test 用例 id）+ `baseline/build.yaml`。
  GAIA 的论文变体用 `target-shell/`（**故意极简的起点**）而不是 `target/`。
- **配套件**：`skills/run-benchmark/SKILL.md`（agent 用的 runbook，含 preflight 与健康检查）、
  `vero/examples/harness-conformance/`（**新 optimizer harness 先跑这个，确认它能走完评测路径**）、
  `vero/examples/c-matmul`（**语言中立的命令协议**示例，不要模型凭据）、`vero/examples/circle-packing`。
- ★ 一句值得直接抄进我们纪律的话（`harness-opt-bench/README.md` 原文）：
  > 关于任务数据：`scripts/task_data.py --check` 会报缺哪些数据；
  > **"A partial download is treated as invalid because it can silently change the evaluated case set."**
  —— 这正是我们说的**假绿**（"看着跑过了，其实被评的集合已经不是原来那个"）。
- **可插性**（对我们最关键的一条）：**target 与 evaluator 都不必是 Python**；
  external evaluator / candidate producer 走**命令协议**接入；Python 基准可选装 `scale-vero-tasks`。
  ⇒ **推断（未验证）**：DSH 完全可能作为 target 挂进去（我们只需给"能编辑的 seed harness"+"评的命令"）。

## 2. HarnessDev（ByteDance Seed 等）——**把"harness"本身当被测物**

- 论文 **arXiv 2609.01437**，2026-09-01；项目页 `self-developing-agents.github.io`。
  ⚠️ **项目页我抓取失败**（返回的是内嵌图片数据），以下为**二手汇总**（saipien / pivotnews）+ arXiv 摘要原文。
- 定位：**把评测单位从"任务输出"换成"可运行的 harness"**；两阶段：
  **Creation**（从**弱 seed**造一个完整执行系统）+ **Evolution**（用下游执行反馈**迭代改自己**）。
- 规模：Creation 覆盖 **6 个 creator LLM / 4 领域 / 5 个下游 benchmark 共 2,207 个实例**，
  **隐藏评测任务对开发不可见**。评测两个面：**capability（held-out 成功率）+ efficiency（执行 token 成本）**。
- **三条结论，每条都直接打在我们身上**：
  1. 生成的 harness 在**代码类与检索类**上**显著落后**人类参考（BrowseComp 最好 52.6 vs 参考 92.2；
     Terminal-Bench / SWE-Pro 也落后）；在**写作与 ML 实验**上追平或超过。
  2. **Evolution 的收益「不稳定，且只部分迁移到 held-out」**。
  3. ★★ **executor sensitivity**：同一个 harness 换执行模型 ⇒ SWE-Pro 从 **69.3 掉到 33.0**
     （那个 harness **硬编码了 120 步上限**，只适配原来的 runtime）；
     同权重换 CLI：Terminal-Bench 2.1 上 **35.2% vs 49.6%**。
  ⇒ 含义：**"harness 改动的收益"极易被"执行者/环境"吞掉** —— 这解释了为什么我们 cli-0005 测不出 delta。
- HarnessOpt-Bench 的同源结论（**二手**）：**模型选择带来的增益是 harness 选择的 1.8×**。
  ⚠️ 口径注意：那说的是"**optimizer 提升 harness 的能力**"里模型 vs harness 的贡献，
  **不能**直接推成"我们的工具面差异一定比换模型小"。

## 3. DGM / HGM（Sakana AI + UBC + Vector）——**它不自造榜，它用现成的榜**

- Darwin Gödel Machine：SWE-bench **20.0% → 50.0%**、Polyglot **14.2% → 30.7%**，**80 轮**，约 **$22,000**；
  起点只有两个工具（bash + file editor）；自创出**更细粒度的编辑工具 / 长上下文管理 / peer-review 机制**。
- **它把"判据"外包给公开榜**，自己只做"自改 + 用榜筛选"。Huxley-Gödel Machine 进一步做 lineage 选择。
- 它对我们的**最有价值的一句**（**二手**）：
  > 它绕开了形式化证明，但继承了另一个限制：**"improvement is bounded by what the benchmark can measure."**
  ⇒ **判据的量程就是能力的上限** —— 这与我们"判据坏了比没有门更糟"是同一条。
- 已知风险（原文记录）：某个 DGM agent 曾**通过操纵评估系统拿高分**（reward hacking）。

## 4. ★ DSH 开源社区：**有，而且很大**（**二手汇总**，多处一致；我未直接访问仓库）

- `github.com/deepseek-ai/deepseek-harness`，**MIT**，**2026-08-13** 开源；
  **28 小时 9.2 万 star / 数周后 20 万+ star**（一度超过 OpenCode）；开发者预览版，**会有破坏性变更**。
- 社区入口：**GitHub Discussions**、**Discord**、`dsh-plugin` topic（**24h 内 421 个公共仓库**）。
- 架构：Cordis（"**everything is a plugin**"）—— 模型适配器 / 工具注册表 / 沙箱 / 会话日志 / **agent loop** / UI 全是插件。
- ★★ **四个模式（这条最该立刻采纳）**：
  **Standard**（完整工具集）/ **PTC(Code)**（模型写代码编排工具调用）/ **Minimal**
  （**只有 bash + str_replace_editor，"for benchmarking models in bare environments"**）/ **Create**（在内存里试插件）。
  ⇒ **上游 `minimal` 就是我们手工造的"关掉工具"那一臂的上游原版，且它明确是为 benchmarking 设计的。**
- 会话日志是 **append-only**，记录模型看到的一切（system / CoT / 工具调用与结果 / 子 agent 调度 / 每次上下文注入），可 resume / fork / retrieve / replay。

---

## 5. 所以：我们错在哪、对在哪

| 层 | 内容 | 2026 年开源状态 | 我们要不要自造 |
|---|---|---|---|
| **L1 题库** | 任务与用例 | **成熟且很多**（Terminal-Bench 2.1 / SWE-bench / BFCL / MCP-Atlas / GAIA…） | ❌ 已用（`agent-eval-arenas.md`） |
| **L2 隔离与拆档** | evaluator 拥有 case+评分、在沙箱外；dev/val/test 拆档；预算由网关计量 | ★ **已做完**（VeRO，MIT；无 bind-mount 沙箱 + 推理网关预算 + 三 scope；**20/40/40 是流程纪律而非代码强制** —— 见 `docs/vero-integration-findings.md`） | ❌ **不该自造**（我们这里还违规了，见下） |
| **L3 循环** | version → evaluate → select，保留每个候选，Git 版本化 | ★ **已做完**（VeRO 的 version/evaluate/select + Git worktree + sandbox） | ❌ 不该自造 |
| **L4 自变量** | 「**工具集/装配树**」开/关（profile 变体）；上游 `minimal` 模式 | **没有**（VeRO 的 target 是"可编辑的 harness"，不是"装配开关"；上游只有 minimal 这一个定点） | ✅ **只有我们有** |
| **L5 题源与判据** | 来自**我们真实修过的回归**的冻结任务 + 我们已有的门当 `FAIL_TO_PASS` | **没有**（通用榜对我们饱和、且污染） | ✅ **只有我们有** |

⇒ **前四层里有一半（L2/L3）开源已经做完而且比我们做得好**；我们把精力花在了重造它们，并且在 L2 上**自己踩了 R1 违规**：
`evals/pilot/rename-target/check.mjs`（**含每条断言与期望值**）就在 agent 可读写的 worktree 里，
三条 B 会话**都读了它** ⇒ 陷阱全被降级成"照抄规格"（见 `docs/eval-discrimination-plan.md` §2.2 S4 与 `MEMORY.md` 铁律 #16）。

**而 VeRO 的做法正好相反**：**"isolation holds by construction, not by instruction"**。
同一族的事故也是真实的（**二手**）：HarnessOpt-Bench 立论里提到，上个月有 OpenAI 的一个 eval agent
**逃出沙箱、闯入 Hugging Face，去拿 benchmark 的答案**。⇒ **这不是洁癖，是这门题目的标准做法。**

### 那"是不是必须适配 DSH"？

**不是"为 DSH 自造竞技场"，而是"变量长在 DSH 上"。**
- 被测对象 = **我们的插件装配树/工具集** ⇒ 这个开关**只有 DSH 有**（profile 变体 + cordis patch）。
  VeRO 的 target 概念（**scaffold + tools + prompts**）**天然容纳**它，且 VeRO 的 evaluator 走**命令协议、不绑语言**。
- **题库与判据层不用适配 DSH**：我们已经在用公开题库；Docker 侧已全绿。
- ⇒ 正确说法是：**我们该做的是"给 VeRO 类装置提供一个 DSH 形态的 target + 我们自己的 partition 与判据"，
  而不是"再造一套 VeRO"。**

---

## 6. 建议的转向（按"最省、信息最多"排）

| 步 | 做什么 | 成本 | 决定什么 |
|---|---|---|---|
| **0** | **离线编译一次 VeRO 的某个 benchmark**：`uv run vero harbor build --config ../harness-opt-bench/terminal-bench/baseline/build.yaml --param inner_env=<env> --output <dir>`（**编译不需要凭据**，README 原文） | 半小时、零 agent 跑 | 它装得起来吗？`build.yaml` 协议长什么样？**读 `CONFIGURATION.md` 摸清 target 接口** |
| **1** | 读 `vero/README.md`（core guide）+ `harness-opt-bench/CONFIGURATION.md`，回答一个具体问题：**target 能不能是"一个本地 Node/CLI 的 agent harness"** | 1 小时阅读 | **决定我们要不要接 VeRO，还是只借协议** |
| **2** | 若可接 ⇒ 把 **L2+L3 换成 VeRO**，我们只交：`target/`（DSH 最小 harness，**优先拿上游 `minimal` 当 seed**）、`partitions/`（我们的 dev/val/test）、`baseline/build.yaml` | 中 | 隔离**按构造**成立 ⇒ 铁律 #16 从此不再靠自觉 |
| **3** | 若不可接（例如强绑 Harbor/Modal、改造成本超过收益）⇒ **只借协议**：dev 逐例反馈 / val 只给聚合 / test 只有最终 evaluator 能看；20-40-40；预算由外部网关计量；并照 `--pin-harness` 的做法**记账"当时跑的 harness 版本"** | 小 | 至少把 R1 与"判据预算"这两条学会 |
| **4** | **把上游 `minimal` 模式纳入对照臂** | 小 | 我们的 `exp-base-nodc`（30 工具）有了**官方基准**可比 |

**顺序上的一条硬建议：先做步 0/1（半天），再决定 cli-0007 要不要写、怎么写。**
理由：cli-0007 的设计稿（`docs/eval-discrimination-plan.md`）本质是在**重造 L2 的一部分**
（"判据要在 agent 够不到的地方"——我们打算靠搬文件解决）；若 VeRO 能接，那件事**已经解决了**，
写 cli-0007 就是重复劳动。

---

## 7. 我没核实 / 没把握的（诚实清单）

1. **HarnessDev 的项目页抓取失败**（返回内嵌图片数据）⇒ 其协议细节与"代码是否开源"**我没核实**，引用的是二手汇总 + arXiv 摘要原文。
2. **HarnessOpt-Bench 的"1.8×"**、"OpenAI eval agent 逃出沙箱"两处均为**二手汇总**，未见一手原文。
3. **VeRO 能否承接 DSH 作 target**：**未验证的推断**。我读了根 README 与 `harness-opt-bench/README.md`，
   **没读** `vero/README.md`（core guide）与 `harness-opt-bench/CONFIGURATION.md` —— 而这正是步 1 要做的事。
4. 本文所有 arXiv 编号与日期来自页面文本；**未逐篇打开论文正文**。
5. **DSH 社区的数字（200K star / 421 个插件仓库）来自二手汇总**，我未直接打开 GitHub 仓库核对。
