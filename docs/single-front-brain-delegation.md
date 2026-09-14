# 单前脑 + 委派式多脑（把三脑下沉为子代理）

> 日期：2026-09-14
> 来源：用户提案 —— 「不再把三个脑平铺给用户看，而是最上层只跑一个脑，它把任务委派给下层三个脑当子代理用；
> 用户只看顶层，聊天框里显示委派了谁、点开能展开看细节；自进化在更下一层。」
> 结论：**方向对，而且比预期更省事 —— 这套机制 DSH 已经实现过两遍，前端组件也已存在。**
> 更深的一层收益：**它把"换代"压缩到唯一真正必要的那一个点上。**

---

## 0. 结论速览

| 问题 | 回答 |
|---|---|
| 这个架构好吗？ | **好，而且不只是 UX 更好** —— 它让"更新频率"和"层级"对齐 |
| 需要新造多少东西？ | **比想象少得多** —— 后端 `dsh-tool-subagent`、前端 `dsh-client-ui-subagent` 都已存在 |
| "点开看细节"要自建吗？ | **一半不用**：树形展开 / 状态 / 耗时 / token 用量 / 诊断**已有**；**子脑内部过程要自建**（§5③） |
| 关键落点 | 把三个脑各自注册为一个 **`SubagentProvider`**（可插拔接口，已带能力契约） |
| **唯一确定的净新增工程量** | **一层委派日志**（把子脑过程落成可展开结构） |
| **顶层脑怎么更新？** | **是的，还是蓝绿换代 —— 而且这是换代唯一不可替代的位置** |
| 下层脑怎么更新？ | **不需要换代**：「下一次委派」天然就是蓝绿 |
| 最大风险 | 子脑自进化后，**顶层的认知会过期** → 必须把"能力清单"做成契约 |

---

## 1. 关键发现：你要的模式 DSH 已经实现过两遍

### 1.1 工具层（Code Mode）

`node_modules/@deepseek-ai/dsh-tools/lib/types/code-mode.js:1-6` 原文：

> "Programs call the registry's agent-visible tools through nested executions…
> **each sub-dispatch is logged for reconstruction, while only the outer curated result enters model history**."

这正是你描述的"**外层只留摘要、内层可展开**"，只不过粒度是工具调用。

### 1.2 Agent 层（`dsh-tool-subagent`）

`node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js` 已经是完整的委派机制：

| 你想要的 | 现成字段/机制 |
|---|---|
| 委派给不同能力的执行者 | **`SubagentProvider` 可插拔接口**（`provider.name` / `capabilities.depthLimit` / `inheritsParentContext` / `prepareContinuable`） |
| 每个执行者能力不同 | `toolFilter: { allow, deny }`（**工具白名单/黑名单**）+ `persona` + `agentOptions: { provider, model, maxTokens }` |
| 只收结果、不收过程 | 工具描述里的硬契约：**"You receive its result, not its intermediate steps."** |
| 长任务后台跑、之后还能追问 | `enableRunInBackground` + `backgroundMode: one-shot \| continuable`（返回 durable subagent id，`send_message` 续轮） |
| 委派深度受控 | `maxDepth`（数字或 `'provider-managed'`） |

### 1.3 前端（`dsh-client-ui-subagent`）

```json
"description": "Subagent conversation catalog, continuation routing UI, and '@' reference source"
```

**"子代理会话目录 + 续接路由 UI + `@` 引用源"** —— 也就是说，
**"聊天框里显示委派了谁、能展开看它做了什么"这个交互，DSH 前端已经实现了。**

于是提案的落点极其清晰：

> **不是发明新架构，而是把现在的"三个并列的 gen 实例 + Hub 三栏前端"，
> 换成"一个顶层 agent + 三个注册为 `SubagentProvider` 的脑"。**

---

## 2. 脑 → Provider 的映射

| 现有（并列实例） | 提案后（委派式） |
|---|---|
| 顶层 = 用户直接对话的三分之一 | **顶层 = 唯一与用户对话的 agent**（窄工具集：委派 / 归档 / 检索） |
| right 脑（导师/科研：选题 + 判定） | 注册为 `provider: researcher` —— `toolFilter` 给「检索 / 读 / 实验执行 / 判据写入」，**不给生产写权** |
| left 脑（执行者：改 sandbox） | 注册为 `provider: builder` —— `toolFilter` 给生产写权 + sandbox 边界 |
| sandbox 脑（被测物） | 注册为 `provider: subject` —— 最窄，且 `capabilities.depthLimit` 收紧 |
| elv/dsh-hub = 给用户看三脑的前端 | **Hub 退到控制面**：brain registry + 委派路由 + 生命周期（用户看不见） |

**注意 `inheritsParentContext` 这个能力声明**：它决定子脑是「继承父对话」还是「从零开始」。
判定型任务应注册成**不继承**（独立上下文 → 判据独立性的结构性保证，呼应《自进化总纲》§6.3）。

---

## 3. 为什么它更好（不只是 UX）

1. **心智负担**：从"三个面板 always-on"变成"一个入口 + 按需展开"。
   大部分时间用户不需要关心谁在做；需要时才展开。**这是把"透明"从常驻改为按需 —— 方向是对的。**
2. **职责与更新频率对齐**（最深的一层，见 §4）：顶层稳定少改，下层频繁自进化。
3. **能力路由有全局视野**：路由需要看到"有哪些脑、各自擅长什么、当前状态"，放顶层合理。
4. **子脑可以真正差异化**：`toolFilter` + `agentOptions.model` + `persona` 让三个脑**真的不是同一个东西**——
   而现在三个 gen 跑的是同一套插件树，差异只靠 profile 参数（这也是之前"模式漂移"难发现的根源之一）。

---

## 4. ★ 顶层脑怎么更新 —— 你的问题，答案比"是"更强

**是的，还是蓝绿换代。而且这是换代唯一不可替代的位置。**

理由三条，每条都独立成立：

| 理由 | 说明 |
|---|---|
| **不能重启** | 顶层持有**与用户的连续会话**。重启打断对话 = 直接损失用户可见的工作。 |
| **不能"下次任务生效"** | 下层脑之所以不需要换代，是因为每次委派的上下文是**隔离且任务级**的；顶层不是 —— 它一直活在同一个会话里。 |
| **失败最难发现** | 顶层负责判断与路由。它坏了不表现为"报错"，而表现为**一切正常但一直在做错事**。这正是最需要 verify 闸的位置。 |

**反过来看，这是提案最大的价值（可能超过 UX 收益）：**

> 下层脑**不需要换代** —— 因为"委派"这个动作本身就是一次天然的蓝绿：
> **下一次委派用新版本，正在跑的那次完全不受影响。**
> 蓝绿不是被"实现"出来的，而是**委派语义自带的**。

所以这套架构把换代从"三处都要"压缩到"只有顶层需要"，而顶层恰好是**唯一真正需要它**的地方。
§4 与 `docs/handover-vs-restart.md` 的三级策略在这里合流：

| 层 | 更新手段 | 为什么 |
|---|---|---|
| 顶层 | **换代（蓝绿）** | 连续会话 + 静默失败 + 单点 |
| 三个脑 | **下次委派生效**（相当于 `restart`） | 任务级上下文隔离，切换零成本 |
| 脑内部的能力（工具集 / prompt / 技能） | 热补丁 / 重启 | 坏了会被下一个任务立刻暴露 |

---

## 5. 六个必须提前想清楚的失败模式

### ① 顶层上下文会被委派记录吃掉 ⚠️
每次委派都要在顶层留一条记录（谁 / 做什么 / 结果摘要）。长会话下这是**新的一类上下文增长源**，
而且它正好长在"最不该膨胀的那一层"（顶层还要做规划）。
**解法**：委派档案**外置化** —— 顶层只留引用，详情存外部、按需拉取。
这必须是**写入时外置**（append-only），不能事后改写 surface（否则击穿前缀，见 `docs/context-cache-efficiency-measurement.md` §10）。

### ② 顶层是单点
它挂了，全部不可用。→ 由 §4 的换代覆盖。

### ③ "展开详情"的数据从哪来 —— **已查清：一半已有，一半要自建**

`dsh-client-ui-subagent/lib/client.js` 逐字读下来，它是一个 **子代理谱系树（lineage tree）**：

```js
// 递归渲染，只展开显式打开的行
function CatalogRows({ parentSessionId, currentSessionId, catalog, catalogs,
                       summaries, expanded, level, now, openChild, refresh,
                       toggleBranch, closeCatalog, t }) { ... }
// "recurse only through explicitly expanded rows"
// aria-expanded / treeitem / aria-level  → 树形控件
```

**已有的（直接可用）**：

| 能力 | 证据 |
|---|---|
| 委派**树形**展开/收起 | `branch.expand` / `branch.collapse` =「展开/收起 {label} 的下级子代理」 |
| 每个子代理的运行状态 | `activity.running` / `activity.inactive` |
| 模式 | `mode.oneShot` / `mode.continuable` |
| **耗时** | `activityDuration`，秒/分/时/天分级 |
| **token 用量（含缓存细分）** | `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` |
| **诊断展示** | `diagnostic.corrupt` / `diagnostic.unsupported` / `diagnostic.unavailable` |

**关键限制**：它展开的是「**下级子代理**」（委派树的层级），**不是「子代理内部做了什么」**。
数据模型是 `catalog` / `catalogs`（按 session id）+ `summaries` + `activity` + `usage`
—— **读的是"每个子会话的摘要与用量"，不是完整过程**。

**完全对得上** `dsh-tool-subagent` 的契约原文：*"You receive its result, not its intermediate steps."*
步骤被刻意分离，但**没有读回入口**（21 个 `dsh-tool-*` 无任何会话检索能力，
见 `conveyor-postmortem-and-revival.md`）。

→ **结论**：UI 外壳已有，缺的是**过程数据的来源**。
需要一层**委派日志**，把子脑过程落成可展开的结构。
**注意**：`diagnostic.*` 那三个键说明这个组件已经有"显示异常"的位置 —— §5⑥ 有现成挂载点。

### ④ 路由判据不能靠 prompt 自由发挥
如果顶层凭 LLM 自由判断"该派给谁"，会漂移、会形成偏好。
→ 判据必须是**可执行的**（接《自进化总纲》§5 的判据阶梯），不是提示词里一句"请合理分配"。

### ⑤ ★ 子脑自进化后，顶层的认知会过期 —— 这是最容易被忽略的失败模式
今天的证据：gen 之间"工具少 25 个、Code Mode 静默回落 native"，**没有报错、没人发现、藏了一天以上**。
在委派架构下，同样的病会表现成：**顶层按过期认知把任务派给一个已经不会做这件事的脑**。
→ 必须把**能力清单做成契约**：每个 provider 对外声明「我能做什么 + 怎么验证我做成了」，
即自进化提案里的 `proposes: { path, change, expectedGain, falsifier }` + `acceptance`。
**`SubagentProvider.capabilities` 就是现成的挂载点。**

### ⑥ "看起来只有一个脑"会掩盖委派失败
三栏平铺虽然烦，但**它让异常可见**。收成一个入口后，
如果委派卡片只展示"快乐路径"，失败会被静默吞掉。
→ 委派卡片必须能显示**健康状态**（是否降级、能力是否残缺），而不只是"已委派"。

---

## 6. Hub 的定位变化

**Hub 不消失，它退到用户看不见的地方。**

| | 现在 | 提案后 |
|---|---|---|
| 形态 | 用户前端：三栏展示三个脑 | **控制面**：brain registry + 委派路由 + 生命周期管理 |
| 用户可见性 | 主要界面 | 不可见（只有 `?cmd=panel` 这类运维投影） |
| 与 switchboard 的关系 | 平行 | 明确分工：**switchboard 管"代际"，Hub 管"身份与能力"** |

这实际上让 `elv/dsh-hub` 的定位第一次清晰了 ——
"三个脑平铺"不是它的价值，只是因为之前没有别的表达方式。

---

## 7. 落地路径（按依赖顺序）

| 阶段 | 做什么 | 依赖 |
|---|---|---|
| ~~**P0**~~ | ~~验证 `dsh-client-ui-subagent` 能否展开过程~~ → **已查清（§5③）**：树形展开/状态/耗时/用量/诊断**已有**；**内部过程要自建** | ✅ 已完成 |
| **P0'** | 顶层脑用**窄工具集**（委派 / 归档 / 检索），三个脑注册为三个 `SubagentProvider` | §1.2 的接口已就绪 |
| **P1** | **委派日志**：把子脑过程落成可展开结构（补上 §5③ 缺的那一半） | 复用 `compaction/summary` 的落盘模式 |
| **P2** | 委派档案**外置化**（顶层只留引用，不占顶层上下文） | §5① |
| **P3** | 能力清单作为契约（`capabilities` + `acceptance`），顶层路由按它判断 | §5⑤ |
| **P4** | 顶层换代 = 唯一蓝绿路径；三个脑改为"下次委派生效" | §4 |

**P0 已收口，结论明确**：这是"接线"而不是"从零造" ——
但**必须自建一层委派日志**，因为 DSH 刻意把"结果"与"步骤"分开且没有读回入口。
这是整个提案里唯一确定的净新增工程量。

---

## 8. 一句话

**你提的不是一个 UI 改版，而是一次"把可更新单位下沉"的重构。
它的真正收益不是好看的界面，而是：把蓝绿换代从"三处都要"压缩到"只有顶层需要" ——
而下层之所以不需要，是因为「委派」这个动作本身就是一次天然的蓝绿。**
