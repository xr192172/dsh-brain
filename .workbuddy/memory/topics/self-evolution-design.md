# 自进化架构设计

> 上级索引：`../MEMORY.md` ｜ 相关：`generation-swap.md`、`prompt-cache.md`、`project-governance.md`
> 完整文档：`docs/self-evolution-master-plan.md`（总纲·判据阶梯）·
> `docs/capability-registry-evolution.md`（能力库）·
> `docs/single-front-brain-delegation.md`（单前脑委派）

## 0. 五条主结论（先看这里）

1. **进化单位从"整体"下沉到"能力"**（= 一个 sub agent）。
   自进化 = 能力库的 **注册 / 升级 / 合并 / 淘汰**。
2. **顶层（消费者）必须蓝绿换代；下层（能力）不需要** —— 「委派」本身就是天然蓝绿。
3. **判据与信号严格分离** —— 裸满意度评分丢弃；采纳只认可执行 `acceptance` + 隐藏 holdout。
4. **决策层可以是"多模型会议室"**（群员是多个**模型**而非多个 Agent）——
   组队靠**先验差异**，不是采样次数；三种裁决按风险分 D1/D2/D3 三档。
5. ★ **无环原则** —— 「**被改的审批层不能自动批准自己的部署**」（详见 §4）。

## 1. 判据阶梯（总纲 §5，能力级实例）

```
L0 机械门     编译/单测/契约形状/接口五成员齐 —— 必须全过
L1 不变量门   对齐、权限边界、沙箱、写权唯一、预算 —— 一票否决
L2 基线不退化 逐维度 fail-closed（不看总分；任一维度低于基线即 reject）
L3 隐藏 holdout  优化器看不见，含红队对抗用例；可见升而隐藏降 ⇒ 判 misevolution
L4 反事实对照 同任务集 shadow A/B，逐切片比到显著性
软门          效率增益，**只用于排序，永不用于豁免硬门**
```

**判据的三条纪律**：fail-closed 逐维度／评测集所有权独立于被优化者／晋升必须带证据链。

**判据公式（用户口径）**：**字典序，不是加权** ——
先过**能力门**（能不能做到），再在"已经做到"的候选之间比**效率**。
> **理由（数学）**："省资源"的边际成本远低于"做对任务" ⇒ 任何加权和里都存在一条
> "省 token / 少调用 / 早收敛，但任务做不成"的**净收益为正**的坡道。**这就是 reward hacking 的数学根源。**

**四域 × 两类指标**：

| 域 | 能力面（硬门） | 效率面（软门·只排序） |
|---|---|---|
| **任务** | **任务完成率** ← 全局唯一终判 | 平均轮数、耗时、成本/成功任务 |
| 上下文 | 不溢出、关键信息不丢 | **token 利用率**、折叠频率、水位、淘汰率 |
| 记忆 | 该记住的没丢 | **有效记忆留存率**、检索命中率 |
| 工具 | 工具能用、**不该用时不误用** | **工具错误率**、耗时、token、"顺不顺手" |

## 2. 能力库：机制（DSH 原生，已查证）

- 服务 `@deepseek-ai/dsh-subagent`：**`registerProvider()`** / `getProvider()` / `providers` / `startContinuable()`
- 事件：**`subagent/provider-added`** / **`subagent/provider-removed`** / `subagent/start|end|descriptor`
- **`SubagentProvider` 只有五个成员**：
  `name` / **`capabilities`**（= 能力清单契约的现成挂载点）/ `inheritsParentContext` /
  `start(request)` / `prepareContinuable()`
  例：`capabilities = { outputSchema, depthLimit, toolFilter, persona }`
- 工具侧 `@deepseek-ai/dsh-tool-subagent`：
  **注册 provider → 委派工具自动 mount**（lazy mount，可"先配工具、后接 provider"）；注销 → 自动摘除；
  **工具无 provider 参数 ⇒ 一个 provider 一个 `toolName` ⇒ 工具名即路由**；
  原生字段 `toolFilter{allow,deny}` / `persona` / `agentOptions{provider,model,maxTokens}` / `maxDepth`
- 配套：`dsh-tool-subagent-control`（**`send_message` + `interrupt_agent`**）、
  `dsh-tool-subagent-report`（**`report`**，父代理回报）、`dsh-client-ui-subagent`（**谱系树 UI**）
- **进程外后端是一等公民**：注释原文「Provider-side vocabulary for **OUT-OF-PROCESS** subagent backends」
  「**capability-validating asynchronous start API**」⇒ **外部 Agent 接入的官方路径**

## 3. ★ 架构分层（`dsh-web-app/cordis.patch.yml` 原文）

> "The subagent **registry and its backends STAY in the host plane**. `subagents` is a
> **process singleton** with a cross-session query surface (**`listChildren`, `followup`**)
> that the host api-proxy serves to the browser, and a provider registers under a
> **globally unique name** … **What a preset chooses is which delegation TOOLS its agent sees**."

⇒ ① `ctx.subagents` 是**进程单例 + 注册名全局唯一 + 跨会话查询面**
  ⇒ **"能力库"不需要新建存储，它已经是了。**
⇒ ② 被禁的不是注册表，是 **preset plane 的委派工具行**（与 `tool-bash`/`tool-pwsh` 同理）
  ⇒ **启用位置在 preset 层，不是 profile 层**；且**是上游禁的，不是我们**。

## 4. 四条关键判断

1. **组装厂不是"脑"，是环境 + 流水线** —— "开发 + 装配 + 验收"三职责挤一个上下文 = 自己出题自己判。
   → **验收必须是"闸"不是"脑"**：设计师产出**可执行 `acceptance`**，控制面机械跑。
   **三脑作为"架构"退场，作为"生产线的两个工位"（设计师 / 开发者）保留。**
2. **必须补第四条规则：淘汰**（长期零命中 / 被他者完全覆盖 / 重叠度过高）。
   判据可与合并共用 = **重叠度**。没有淘汰，能力库会膨胀到无法路由。
3. **能力级蓝绿是免费的**：注册新 provider 时旧 provider 仍在跑，新委派走新注册表
   ⇒ 替换不需要 switchboard。**但必须补 lineage**（`SubagentProvider` 无版本/来源概念）→ 旁挂
   `capability-registry.json`：
   `{id, version, source, acceptance, holdoutHash, registeredAt, supersededBy}`
   （没有它就无法追责，也无法做**谱系毒性召回**）
4. ★ **无环原则（acyclic approval）** —— 「**被改的审批层不能自动批准自己的部署**」。

   把"谁批准谁"画成箭头，**出现回路就是漏洞**。这条专门回答"顶层自己的审批层要怎么变动"：

   | 变动对象 | 见证方 | 换代后自动续跑？ |
   |---|---|---|
   | **R2 能力层**（tool / skill / prompt / 子 agent / 普通代码） | 判据阶梯（自动） | ✅ **自动** |
   | **R1 判据层**（评测集 / holdout / 权限声明 / 配额上限 / **审批逻辑**） | **外部（人 / 独立见证）** | ❌ 留待批记录，外部确认后再续 |
   | **R0 自举层**（启动 / 恢复 / 回滚路径） | 外部 + **自举性检验** | ❌ 同上 |

   **两条写死的规则**：
   ① **层级标签不能由发起者自己填**（否则它自标 R2）→ 由**变更的实际路径**推断，
      且推断逻辑放在**控制面**（改到 guard / 判据文件 / holdout / 权限声明 → R1；其余 → R2）；
   ② **控制面自身属 R1，agent 不可写** —— 即"**决定能不能自动批准的那段代码，
      不能被被批准的东西改写**"。（我们能改它，因为"我们"在 agent 之外；这个内外边界必须显式写清。）

   **这是"契约式授权"成立的前提**：人批**一次**「标准 + 预算」，之后执行全自动；
   只有"标准本身要改"时才回到外部见证。**自动化不会被打断，它只是不能被自己破环。**

## 5. ⚠️ 唯一必须量化的取舍：能力清单变化会击穿前缀

**一个 provider = 一个 `toolName` ⇒ 能力增删改变 tools 段 ⇒ 一次前缀改写**
（实测改写后 5 轮 45%→82%，均低于 93% 线）。

| 方案 | 前缀稳定 | 路由明确 |
|---|---|---|
| A 一能力一工具名 | ❌ 每次增删都击穿 | ✅ **工具名即路由** |
| B 固定 `delegate(provider,task)` | ✅ | ⚠️ 路由退回 LLM 自由选择 |
| **C 分层（推荐）** | ✅ | ✅ |

**方案 C**：少数**稳定核心角色**（designer / builder / reviewer）各占一工具名 +
**长尾动态能力**走固定 `delegate_capability` + `list_capabilities()` **按需查询**（不进前缀）。
= **按变化频率分层**，与三级替换策略同一思路。

## 6. 决策层：多模型会议室（委派不是单人委派）

> ⛔ **定位已改（2026-09-20）**：本节的"多模型会议室"**不再是"决策层"**，而是**升格为顶层 = 专家评审团**；
> 三脑则**降入子 agent 层**（变成"三个调控其他子 agent 的脑"）。
> **当前架构以 [`docs/revised-architecture-2026-09-20.md`](../../../docs/revised-architecture-2026-09-20.md) 为准。**
> **本节仍然有效**的部分：三省六部映射、D1/D2/D3 分档、**三条硬约束**（防 consensus collapse）——全部继承给顶层评审团。

**提案**：委派层不一定是单人委派 —— 群聊，但**群员是多个模型而非多个 Agent**；
多模型动态各出方案；通过 ①人审 ②互相辩论 ③预先指定审核员 决定最终方案；再委派给子代理。
（用户类比"**三省六部**"）

### 为什么"多模型"≠"多 Agent"（本质区别）

| | 多 Agent（多会话 / 多角色） | **多模型（会议室）** |
|---|---|---|
| 差异来源 | 同模型 + 不同上下文（prompt/角色/工具） | **不同先验**（系统性差异） |
| 多样性上限 | **采样噪声** | **系统性差异** |
| 能消除的错 | 上下文相关的错（漏看、被 prompt 带偏） | **模型本身的系统性偏见** |
| 成本 | 低（同 provider 可共享 KV cache） | **高**（跨 provider **无法共享 KV cache**） |

> **同一个模型即使换 100 个 prompt，仍然会掉进同一类错。**
> "多开几个会话"的多样性上限是**采样次数**；对抗性检查需要的是**先验差异**。

**⇒ 评分者独立性的强度：跨模型 > 跨会话 > 同会话换 prompt。**
（修正 §7 的表述：上下文隔离只消除"同一偏见被重复采样"，**消除不了模型本身的系统性偏见**）

### 三省六部映射

| 三省六部 | 对应 | 要点 |
|---|---|---|
| 中书省（草拟） | 会议室各模型**独立出方案** | 多人独立起草 |
| **门下省（审核/驳正）** | **审核员模型 + 判据闸** | ★ **"封驳"权 = 独立否决权，且与中书省不同机构** |
| 尚书省（执行） | **委派给子代理（能力库）** | 执行统筹 |
| 六部 | **能力库各 provider** | 分工执行 |

**精髓 = "拟—审—行"三分，审核方持独立否决权** —— 与"判据必须独立于被判定者"是同一原则的古代版本。

### 三种裁决 = 按风险分档（复用三级策略思路）

| 档 | 裁决 | 适用 | 成本 |
|---|---|---|---|
| D1 | **单模型** | 低风险、可撤回 | 最低 |
| D2 | **跨模型辩论/投票**（自动） | 中风险、有明确 `acceptance` | 中 |
| D3 | **人审 + 隐藏 holdout** | 高风险、不可撤回、**涉及判据自身** | 高 |

### 三条硬约束（缺一条就退化）

1. **先独立作答，再交换意见** —— 否则第一个发言者**锚定**所有人 → 趋同（consensus collapse）
2. **异议必须记录，不能被抹平** —— `dissent: [{model, objection, evidence}]`；
   与"没有理由的评分应被丢弃"同理：**被抹平的异议有信息量**
3. **审核员不能由被审者指定，也不能是被审模型自己** ——
   改成"由**判据层**指定，且与被审模型**不同源**"，否则"谁指定审核员"成为新的单点

### 技术约束

- **跨模型无法共享 KV cache** ⇒ 每个参会模型都是**冷启动**
- ⇒ **会议输入必须是"压缩后的任务规格"，不是整个会话历史**，否则成本爆炸
- ⇒ **会议开在决策层，不在执行层**：输入 = 任务描述 + 能力清单 + **上下文摘要（外置引用）**；
  输出 = 方案 + 选路 + `acceptance`；结论**一次落盘**（决策记录），后续委派引用 → 又是"写入时外置化"

### 它顺手解决的两件事

1. **"设计师"工位有了具体形态**：会议室**就是**设计师 —— 产出 ①路由 ②方案 `acceptance` ③能力缺口候选提案
2. **失败模式④（"路由判据不能靠 prompt 自由发挥"）有解**：路由从"顶层 LLM 凭感觉选"
   变成"**多模型各自给出"该派给谁 + 为什么"，由判据层按可执行规则裁决**"
   —— **路由从"感知"变成"可审议的命题"**

## 7. 上层反馈：盲评、行为信号、信号/判据分工

**盲评（不告诉它在被测）只能提高信号纯度，不能把信号升级成判据。**
讨好的根源**不是"知道在考试"，而是"收益函数由判据持有者的主观反应定义"**：

① 隐藏的是"哪一次是考试"，不是"评分这件事存在"（只要它能推出"产出会被评价"，激励就一直在）
② 讨好常常**不是作弊，而是"正确地做被要求的事"**（任何 assistant 的本能目标就是"让用户满意"，
   于是"让上层满意"与"把事做好"在目标函数层面重合 —— 客服 agent 学会动不动退款就是这类）
③ **要迭代就必然暴露"有评价"**：顶层给修改意见 = 告诉它产出会被评价；
   "委派详情可展开" = 它知道可被查看 ≈ 知道会被评价。**信息隐藏路线与迭代需求直接冲突。**

**信号三层强度**：

| 强度 | 信号 | 性质 | 可否伪造 |
|---|---|---|---|
| **最强** | **选用 / 复用 / 弃用**（行为） | **costly signal**（选错要付代价） | ❌ **不可伪造** |
| 中 | 满意度 + **具体理由 + 可复现反例** | 声明 + 证据 | ⚠️ 有信息量 |
| 最弱 | 裸满意度评分 | **cheap talk** | ✅ 可随意敷衍 |

> **"打 8 分"是声明；"下次还用不用它"是承诺。**
> 一个 agent 能给自己打 10 分，也能让上层给它 9 分 —— **但它没法强迫别的 agent 下次还用它。**

⇒ **工具商店的真正改造不是"换个人打分"，而是：把打分降级（辅助证据），把行为信号升级（主信号）。**
更彻底的形态：**每个子 agent 里都装工具商店** ⇒ 反馈从"评测环节"变成"使用痕迹"，
与"实验室阶段不设收益率门槛"同一条原则：**让反馈成为使用的副产品，而不是额外流程。**

**行为信号的两个偏差与解药**：
① **样本选择偏差**：**"从未被选用" ≠ "没用"，可能是"发现失败"**（描述差 / 名字不起眼）
   → 解药 **探索配额**（强制把一小部分委派派给低选用率能力），否则锁定早期赢家（bandit 标准问题）
② **高选用率可能是"描述过度承诺"**：同时记 **选用率**（发现性）与**复用率**（交付后被再次选用 = 真实价值）
   → **高选用率 + 低复用率 = 描述过度承诺**，一个具体可检出的失败模式
③ 评分者之间必须**互相隔离**，否则顶层偏好被下游继承 → "多 agent 投票"退化成"一个 agent 投 N 次"

**最终分工**：**信号**（行为为主 + 满意度附理由）高频零边际成本 → 决定**何时花贵判据**；
**判据**（可执行 `acceptance` + 隐藏 holdout）低频昂贵 → 决定**是否采纳**。
**裸满意度评分应被丢弃**；修改意见 = 候选提案 `{path, change, expectedGain, falsifier}` → 进注册门，
**满意度本身不进闸**。

## 8. 单前脑 + 委派式多脑

**提案**：不三栏平铺三个脑；**顶层只跑一个脑**，把三脑当子代理委派；用户只看顶层 + 可展开委派详情。

**这套机制 DSH 已实现两遍**：
- 工具层 Code Mode sub-dispatch（`dsh-tools/lib/types/code-mode.js:1-6`）：
  「**each sub-dispatch is logged for reconstruction, while only the outer curated result enters
  model history**」
- Agent 层 `dsh-tool-subagent`：契约「**You receive its result, not its intermediate steps**」

**前端已有 / 没有**（`dsh-client-ui-subagent` = 子代理**谱系树** `CatalogRows`）：
- 已有：树形展开（`branch.expand`/`collapse`）、状态（`activity.running/inactive`）、
  模式（`mode.oneShot/continuable`）、**耗时**、**token 用量含缓存细分**、**诊断位**（`diagnostic.*`）
- **没有**：子脑**内部过程** —— 数据模型只有 `catalog` + `summaries` + `activity` + `usage`，
  它展开的是"下级子代理"（层级），不是"步骤"
- ⇒ **唯一净新增工程量 = 一层委派日志**

**★ 顶层脑的更新仍然必须是蓝绿换代，且这是换代唯一不可替代的位置。**
**下层脑不需要换代** —— 「委派」本身就是天然蓝绿。
→ 提案最大价值：**把换代从"三处都要"压缩到"只有顶层需要"**。

**最易忽略的失败模式**：**子脑自进化后顶层认知过期** → 必须把**能力清单做成契约**
（`capabilities` + `acceptance`）。"工具少 25 个且一天无人发现"就是它的预演。

**Hub 定位变化**：不消失，从「用户前端」降级为「**控制面**」。
分工：**switchboard 管"代际"，Hub 管"身份与能力"**。

## 9. 六个必修的失败模式（委派架构）

① 顶层上下文被委派记录吃掉 → 委派档案**写入时外置化**（顶层只留引用）
② 顶层单点 → 由换代覆盖
③ "展开详情"的数据来源 → 需自建委派日志（见 §7）
④ 路由判据不能靠 prompt 自由发挥 → 必须是**可执行判据**
⑤ 子脑自进化后顶层认知过期 → **能力清单做成契约**（见 §7）
⑥ "看起来只有一个脑"会掩盖委派失败 → 委派卡片必须显示**健康状态**（`diagnostic.*` 是现成挂载点）

## 10. 落地顺序（**能力库线**；2026-09-20 校订状态）

> ⚠️ **本节是"能力库线"的顺序**，与 `docs/self-evolution-master-plan.md` §10 的**总纲线**
> （P0 判据阶梯骨架 → P1 三脑环接阶梯 → P2 holdout → P3 记忆 → P4 技能 → P5 工具 → P6 红队 → P7 元层）
> **是两张不同的表**，别混。**总纲 P0「Genome + 分维度判定报告」代码里还没有**（2026-09-20 实测无 `Genome`）。

| 阶段 | 做什么 | 状态（2026-09-20 校订） |
|---|---|---|
| ~~P0'~~ | ~~在 preset 层启用委派工具~~ | ✅ 无需改（上游随附 preset 本就挂了 4 个 tool-subagent 行）。详见 `2026-09-14.md` 12:40 段 |
| **P1-a** | 真实委派跑通 | ✅ ⚠️ Code Mode 下唯一入口是 `run_code` 里的 `tools.*()` |
| **P1-b** | 写我们自己的第一个 `SubagentProvider` | ✅ **已建**：`packages/subagent-council/src/index.ts:122` 的 `ctx.subagents.registerProvider(...)` |
| **P2** | `capability-registry.json`（lineage + acceptance + holdoutHash + 状态） | ✅ 已建（`node scripts/capability-registry.mjs list` = 4 条能力） |
| **P3** | **注册门**：判据阶梯接成"注册前必须过" | 🟡 **只到 L1**；L2/L3/L4 的 `enforced:false`（且各自写着 why）。**见新议题 `tool-refinement-handover.md`** |
| **P4** | 按 §5 方案 C 分层：核心角色一工具名，长尾走 `delegate_capability` | ✅ 能力通知已落地并真机验证（`npm run verify:p4`） |
| **P5** | **外部 Agent adapter**（包一个现成开源 agent） | ⬜ **未开工**（`packages/` 下无 adapter 包） |

**P1-b 的契约（写新 provider 时照抄，别重查）**：`inject:['subagents']` + `apply()` 里
`ctx.subagents.registerProvider()`；provider 成员 `name` / `capabilities` / `inheritsParentContext` /
`start(request)` / `prepareContinuable()`。
**`start()` 里可注入 `persona` / `toolFilter` / `outputSchema` / `maxDepth` / `agentOptions`
—— 这正是"多模型会议室"的技术底座**（一个 provider = 一个预配置的子代理工厂）。

## 11. 外部 Agent 接入（四个硬问题）

接口侧写 adapter 只要五成员。但注册门必须解决：

| # | 问题 | 处置 |
|---|---|---|
| ① | **`acceptance` 由谁定？** | **必须由我们定**。绝不能采信外部自报的合格声明 |
| ② | 凭据与文件边界 | 明确可见范围；`toolFilter` 不适用时在 adapter 层强制 |
| ③ | 可靠性 | 外部依赖会挂/超时/**静默降级** → 能力健康状态必须上报 |
| ④ | 版本追责 | 外部 Agent 会自己升级 → **升级视为新候选，重跑注册门** |

**战略意义**：把"自进化"从**自我修改**变成**能力组合** ——
**瓶颈从"造不造得出来"变成"发不发现得了"**，并天然引入新角色 **侦察（scout）**
（产出候选：接口 + acceptance + 来源，不产代码，必须过注册门）。

## 12. 每个子脑的记忆（2026-09-14 设计，详见 `docs/per-subagent-memory.md`）

**三档 tier + 一次晋升**（ai-base 只有 `brain`/`subagent` 两档，**缺发表门**）：

| tier | 谁可读 | 谁可写 | 内容 |
|---|---|---|---|
| `private:<provider>` | 只该 provider | 自由写 | **过程**（探索笔记、试错假设） |
| `shared`（总库） | 全部脑 + 讨论层 | ⚠️ **只能经发表门** | **成果**（通过的论文） |
| `brain` 层 | 保留现有 `brain` 列隔离 | 各脑自由写 | 三脑 context 记忆 |

**三个关键修正**：
1. **隔离用同库作用域（`tier`+`source_label` 列），不是 N 个库** —— 分库会碎掉
   `embedding_cache`、发表要物理拷贝、跨作用域去重做不了（`supersede`+`anchors` 依赖同库 JOIN）
2. **记忆粒度挂"能力"（provider，全局唯一名）不挂"实例"** —— 子代理是 one-shot
   （`spawn` = fresh child / own session / zero parent context），按实例分区 = 无延续
3. **"发表"= `private → shared` 的层级晋升，必须过门**（复用 ai-base 的
   作者分身 `llmRefineDream` + 审稿分身 `judgeDreamEntry` + `runExperiment` 真跑 command）
   + **可撤回**（按 `SourceNodes` 反查后代、批量降级；否则"一次投毒永久留存"）

**一个漂亮性质**：记忆注入对**子代理免费**（提示词从零构造，无可复用前缀）、
对**顶层昂贵**（= 一次前缀改写，实测 5 轮才恢复 45%→82%）→ **记忆的正确位置就是子代理层**；
顶层若要读总库，走**按需检索**（`scope=hierarchy`），不注入。

**既有资产（ai-base，勿重造）**：tier 隔离设计 `proposal-tier-label-isolation.md`（含
**睡眠差异化**：NREM 不给 subagent 加权、Prune 优先清 subagent 叶子 `decay 0.85×0.7`）；
论文系统 `knowledge.go` `KnowledgeEntry`（`Claim/Scope/Limitations/SourceNodes/Verified/
JournalTier/Experiment`，注释"知识 = 论文"）；`gravity_field.go` 跨社区对生成；
`tool_feedback.go`（工具失败反馈，与 SkillTree 分工）。

**DSH 侧**：`*memory*` 包为空、21 个 `dsh-tool-*` 无任何记忆/召回工具 → **记忆本体是唯一要自建的部分**；
其余全现成（`spawn` 语义 / provider 全局唯一名 / `capabilities{persona,toolFilter,agentOptions}` /
`report` 做投稿 / `dsh-client-ui-subagent` 谱系树）。

**基础套装判断**：记忆 ✅（薄，注入索引不注入全文）· 工具商店 ⚠️ **只读 + 产行为信号，
不可改工具/评分**（那是判据层 R1）· 双循环 ❓ 若指作者/审稿写验循环 → **只在发表门开，不是每个子代理**。

## 13. ★ 技能树就是能力库（2026-09-14 盘点，详见 `docs/memory-asset-triage.md`）

**盘点结果**：`ai-base/agent-shell/internal/memory/` = **33 个非测试模块 / 457 KB**（Go）。
其中 **`SkillNode`（`skill_tree.go:21`）已经是一个完整的能力库字段表**：

```go
Status/Score/UseCount/SuccessRate          // 生命周期 + 健康度
Triggers                                    // 路由依据
Script/ScriptLang/Archive                   // 可执行体
Tools []external.ToolDef                    // ch22 §6 "Skill-as-Capability" → 注册到 ToolRegistry
Extends / Requires                          // 继承 / 组合
EditHistory / MergedFrom / AbsorbedBy       // 谱系 + 编辑审计
Absorb / AbsorbOutcome                      // ★ 跨路径吸收 = 用户说的"合并"
Exclusive                                   // 用户钉住不许合并
```

**⇒ 能力库不需要设计，`SkillTree` 已经是了。它唯一缺的是执行方式**：
现在是 `Active Skill Injection`（ch09 §6：按 `score>0.7∧use_count>10` / trigger 匹配选出来
**注入主脑 prompt**），新架构要的是 **`spawn provider` 委派**。

**⇒ 迁移工作量大幅下降**：`skill_tree.go`(36KB)+`skill_import.go`(19KB) 的**数据模型与生命周期
整体可用**，只需换掉"注入"那一段。**顺序上数据先行、执行器可替换**（P2 数据 → P3 执行器）。

**处置三类**：
- **直接移植**：存储/图/检索（`sqlite_store`/`graph_cache`/`graph_writer`/`rrf`…）、
  `gravity_field.go`（**无 LLM 无 IO 无新字段**的确定性评分层，三阶段睡眠地基）、
  `sleep_experiment.go`（实测执行器）、`sleep_prune.go`（**遗忘**）、`heat.go`、`tool_feedback.go`、
  `knowledge.go`、`meta_skill.go`
- **换执行器**：`skill_tree.go`（注入→委派）、`skill_import.go`（保留导入器，导入后视为候选能力）
- **不移植**：`shallow_writer.go`（跑 `os/exec` 抓状态 —— DSH 里是工具调用）、
  `sleep_config.go` 的 REST API（DSH 有 admin 面）、`builder.go` 的装配部分（插件体系取代）

**技能的三分去向**：带 `Script`/`Tools` → 升格 sub agent；只有 `Principle`+`Fix` → 降格为
记忆/论文条目（是知识不是能力）；纯 prompt 技巧 → **不需人工退役**，`Score`+`sleep_prune` 自然淘汰。
（**判断**：纯 prompt 技巧是最脆弱的资产，会被模型升级本身淘汰。）

## 14. ★ 睡眠需要常驻宿主 ⇒ 记忆库必须是独立进程（2026-09-14 结构性推论）

`sleep.go` depends: `HeatStore, SkillTree, ExplorationState, client.Client`；
`sleep_scheduler.go` 要求"**同时最多 1 个运行** + checkpoint 断点续跑 + 会话关闭/手动/定时三种触发"。

**⇒ 睡眠是一个需要"后台常驻 + 独占 + 断点续跑"的长期进程。**
而 gen **会换代**（实测 4.6s）、子代理**是一次性的**（`spawn` = fresh child 跑完即销毁）。

**结论**：**睡眠 + 它整理的对象（技能树/知识库/图）不能住在 gen 或子代理里，必须有独立常驻宿主。**
这比上一轮"跨代际不丢"的理由更强 —— **是机制本身需要常驻**。

**顺带架构收益**：该进程天然处于**外部见证**位置 → 发表门的判据持有者（作者/审稿分身）、
谱系毒性召回的执行者都应住在它里面 ⇒ **"判据持有者与被判定者分离"在架构上就成立，不靠约定。**

## 15. ★ 语言与进程边界 + ⚠️ 订正（2026-09-14，详见 `memory-asset-triage.md` §7）

### ⚠️ 订正：我查错了对象

我原先写"design-canvas 没有代码翻译能力"——**错**。原因：**只查了 `design-canvas-bridge` 的 8 个
「编排壳」工具，没查 kernel 的 58 个 MCP 工具**。
⇒ **方法教训：查一个系统的能力，要查它真正的注册表，不是它的包装层。**

### `translate_go_ts` 真相（**确实是 tree-sitter AST 底座**）

实现于 `design-canvas/src/translate/`（**15 个模块**）：
`go_extractor.ts`(22KB) 用 **`tree-sitter-go`**（复用 `ts_kernel.parseAstRoot`）萃取 Go 顶层
函数/结构体 → `ts_codegen.ts`(14KB，含 `mapGoType`) 生成 TS → `verify.ts`(6KB) 用
**`tree-sitter-typescript`** 语法闸（含 `hasError` 拦截）。`package.json` 已装
`tree-sitter` / `-go` / `-typescript` / `-c` / `-c-sharp`。
设计文档 **`design-canvas/docs/go-ts-translate.md`**（质量极高）。

**默认路径 = AST 骨架 + 验证闸**（`src/translate/tool.ts`）：机械骨架 + 语法闸 + 结构闸（签名/参数/形状）
**默认开**；`fill=true` 才用 key 池 LLM **逐孔填函数体**（**锁定签名**、`maxRetries` 默认 2 纠错重试）；
`verify=true` 才对已填**纯函数**跑 Go↔TS **行为对拍**；`tscVerify=true` 项目模式全工程 tsc 门禁；
**未过闸的单元「不可落盘」**。

**两条设计原则（文档 §三/§四，值得内化）**：
> §三「**别越界硬造**——把语义（并发/error/复合值）伪装成机械产物，会让 LLM 拿着**错误前提**翻译，反而更差。」
> §四「const 对拍：值是机器自己算出/抄出的，比较是**恒等废话**；类型对拍：编译期擦除，**运行时无实体可比**。
> **对拍只对可运行的纯函数有意义。**」
> ⇒ 与我们"**裸满意度评分应被丢弃**（没成本就没信息量）"**同一条原则**：**验证必须有信息量**。

### `vID` / 丢首字符 是谁产生的 —— **不是这个工具**

AST 路径**签名与结构是机器生成的**，LLM 只填 `bodyHole` ⇒ 不可能产生字符级错误。
而 `fix_translation_artifacts.cjs` 修的正是**声明层**错误（`vID`→`void`、`.Method:` 丢首字符）。
⇒ **那次 `elv/dsh-hub` 搬运绕过了 `translate_go_ts` 的 AST 骨架路径**，改用 LLM 逐文件通篇翻，
再用 **35 个 `fix_*.cjs`（144 KB；`fix_patterns` 1~15 轮、`fix_errors_v5~v9`）** 正则回补。

> **用户记的是对的**：工具**确实做成了 AST 底座**且设计清醒。**出问题的是使用环节。**

**★ 可推广教训**：**"边界文档存在" ≠ "边界被遵守"。**
三条做法：① 产出带 **provenance**（哪些走了骨架/哪些 hole 是 LLM 填的）② 门禁**前置强制**
（搬运时强制 `tscVerify`，绕过骨架的产物在门禁处暴露）③ **把"正则修补"当红灯**——
需要 35 个修补脚本本身就说明上游有环节没按设计走（**修补是症状不是解法**）。

### 结论：**不是"翻译不好"，而是"不需要翻译"**

理由链：记忆库必须是独立进程（§14）→ 无"必须同语言"约束 → 协议用 **MCP**（DSH 已有 `mcp-client`，
design-canvas 正是 MCP server，模式已验证）→ **Go 保留 + MCP 面**，零重写。
（**将来若真要迁**，正确路径是 `translate_go_ts(projectDir=…, fill=true, tscVerify=true)`，
不是让 LLM 逐文件翻。）**ai-base 本就是 Hub↔Brain 走 REST 的架构**（`sleep_config.go` +
`internal/hub/v2/plugins/memory_view/`）。

### design-canvas 拓扑与使用指引（**环境事实，重要**）

| 名称 | 角色 |
|---|---|
| **`D:\project_develop\design-canvas`** | **工具真身**，独立 git 仓 v0.1.3（commit `1d19e23`），**TRAE 与 DSH 都拉起的活内核** |
| `dsh-brain/design-canvas-dev` | dsh-brain 内**开发副本**（`node_modules` 是 junction） |
| `Downloads\…\design-canvas-main` | `node_modules` **宿主** |

三者**同版本同 commit**。
**两通道**：TRAE 侧 `mcp_design-canvas`（**快照 58 个工具**）；DSH 侧 `dsh-mcp-client` 以 stdio
拉起 `server.js` → `mcp__design-canvas__*`，再由 `design-canvas-bridge`（**编排壳**）额外注册 8 个。

**使用指引**：改名/检索前先 **`design_canvas_prewarm`** 上索引；**翻译走 `translate_go_ts`**
（LLM 池已自动接 `http://127.0.0.1:3101` key-pool-proxy，**无需额外 key**）；
**改内核源码要 rebuild + 重启新一代才生效**。

## 16. 技能「声明」工具（用户已拍板）与建议池（2026-09-14）

**✅ 已定：技能只「声明」所需工具，不「自带」工具定义。** 理由：工具**共享** ⇒
一次工具改进**对所有能力自动生效**（工具域自进化的杠杆点）。

**但它引入反向依赖**（`能力A/B/C → 声明 tool:fs_read`，改 fs_read 同时影响三者），需四条配套：
1. **改工具前查影响面**（谁声明了它）—— "能力清单作为契约"的**反向用法**
2. **工具的判据不能由使用者定** → 工具域要有自己的 `acceptance` + holdout
3. **契约变更要注入，别让 LLM 试错反推** —— 工具 schema 变更时在**委派提示里附变更说明**
   （对子代理**零成本**：fresh child 从零构造提示词）。代价不是钱，是**任务成功率**
4. **两笔账分开记**：工具变更击穿（可控）vs 长期空闲击穿（provider TTL，不可控，>30min→7.04%）

**★ 建议池 = 科研目标的第三个来源（内生）**（补齐"人提需求 / 自主找课题"）：

| 来源 | 谁提 | 进科研队列条件 |
|---|---|---|
| 人提需求 | 人 | 目标可写成能力用例 |
| 自主找课题 | 脑上网/情报 | 须声明预期指标 + **falsifier** |
| **建议池** | **系统自身** | **能写成可证伪假设 + 可执行 `acceptance`** |

条目 = `{path, change, expectedGain, falsifier, evidence}`；
四路来源：`tool_feedback`（工具失败）· `meta_skill`（元层反思）· 行为信号（**高选用+低复用
= 描述过度承诺**）· 红队用例。
**两条硬约束**：① **`evidence` 必填且可验证** —— 否则是 **prompt injection 新入口**
② **是候选池不是队列** —— 须过"能否写成能力用例"才进科研队列（防**目标漂移**）。

**⇒ `meta_skill.go` 由此成为建议池的一个来源，且只产建议不自动应用** ——
即"R1 需外部共签"的**第一个具体实例**。

**新增待拍板**：Go 记忆宿主的接口面选 **MCP**（我倾向，DSH 已有 mcp-client）还是 loopback HTTP+JSON。
