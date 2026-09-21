# 「把 skill 当 agent + 调完就获得新工具」· 可行性裁决（2026-09-21）

> 起因：用户口述的模型 ——「**顶层评审团 → 逐层委派 → 拆成专项任务**；把 skill 当作 agent；
> 调用时只把**目标 + 信息**送给它，**为什么需要 schema**？我只需知道这个 skill 里有什么、用来做什么；
> 在我的上下文里，这就等于**我获得了新工具**（而不是我被削成了瘟神），然后继续往下做，父代等子代回来。」
>
> 结论：**可行，而且不是勉强可行 —— 上游自己就这么用（`dsh-tool-cordis`）。缺的只有两件事，都在我们这一侧。**

---

## 1. 先回答那个最尖的问题：「为什么需要 schema？」

拆成两句话就清楚了：

- **"知道有什么"不需要 schema。** 上游 `dsh-tool-skill` 的 skill 目录**不是 schema，是一条 durable 的 user-role 消息**，
  而且**只带 `name` + `description`**：
  `dsh-tool-skill/README.md:16` —— "Catalog messages contain **only those summaries**;
  skill bodies, paths, sources, providers, and `whenToUse` hints **remain outside the catalog**."
  ⇒ **你这句话说对了，而且上游已经这么做。**
- **"要调它"必须 schema。** 模型执行一个工具的方式就是**生成一个符合 schema 的调用**；
  schema 是**调用契约**，不是介绍。在 Code Mode 里它表现为 `system` 里的 `ToolArgsMap` 文本，本质一样。

**⇒ 精确版："不需要 schema" = "不需要【预先】把 schema 装在面上"。**
先只给目录（名字 + 用途），**调用那一刻才把 schema 挂上去** —— 这正是渐进披露。**你的直觉是对的，只是差一个"后置"的词。**

---

## 2. 裁决：**"调一下就获得新工具"在机制上成立**（三条硬证据）

### 证据一：`ctx.tools.register()` 是公开 API，**按 scope，而且是活的**

`dsh-tools/README.md:20`（原文）：
> "`ctx.tools.register(definition: ToolDefinition): () => void` … **The layer is the calling context's scope**:
> a plain plugin context registers globally; **an agent's `agent.ctx` registers for that agent alone**,
> shadowing a same-named global tool there. … Disposed with the calling fiber."

`dsh-tools/README.md:56`：
> "Tool plugins call `ctx.tools.register()` — **schemas flow into the assembly automatically**."

`dsh-tools/README.md:22`：
> "This is **live visibility composition**, not an authority boundary"

⇒ **在"我这个 agent 自己的 scope"里注册工具 ⇒ 只对我可见（不污染兄弟），并且自动进入装配。**

### 证据二：工具提供者**每次装配都重新求值** ⇒ 同一个 agent 的连续两次请求可以**工具面不同**

`dsh-system-prompt/README.md:5`：
> "The loop **assembles once per step** and renders the result as the complete model prompt."

`dsh-system-prompt/README.md:23`：
> "`ctx.systemPrompt.tools(provider: …)` Contribute tool schemas, **evaluated at each assembly** with that assembly's context."

⇒ **工具面不是"出生时定死"的，它是每步重算的。** "我获得了新工具"是机制上的**字面事实**，不是比喻。

### 证据三：★ **上游自己就在运行中途加工具** —— `dsh-tool-cordis` 就是那个范式

`dsh-tool-cordis/README.md:90`：
> "**A running package may register tools, prompt contributions, or listeners that change later requests** for the scopes it targets;
> `cordis_stop` and `cordis_undefine` remove those contributions after quiescence."

`dsh-cordis-host-runner/README.md:60`：
> "A host half that registers tools **changes the next request's tool view**, which invalidates prefix reuse from the first changed schema token"

⇒ **"模型在会话中途装载一个包 ⇒ 下一个请求就多了工具"是上游的成熟用法**（`cordis_run` 那套）。
⇒ **你要的"调 skill ⇒ 我获得新工具"，就是同一件事 —— 只是把"装载的包"换成"装载的 skill"。**

---

## 3. 现在还缺什么？（只有两件，都在我们这侧）

### 缺口 A：**skill 本身不带能力，只带指令 + 资源**

- `dsh-skill/README.md:64`：**"The registry does not render model guidance or register model-facing tools."**
- `SkillDefinition` 字段全集（`dsh-skill/lib/types/index.d.ts:72-79`）：`name` / `description` / `whenToUse?` /
  `invocation` / `source` / `provider` / `resourceBase?` / `content` / `path?` / `metadata?`
  ⇒ **没有任何字段能携带"工具 / 脚本"这类可执行能力**（`metadata` 是开放对象，但**没有消费者把它变成工具**）。
- 调 `skill` 工具拿到的是一次 **tool result**：`{ name, provider, resourceBase?, content }`（`README.md:25`），
  渲染成 `<skill_content>` / `<skill_resources>` / `<skill_instructions>`（`README.md:26`）
  ⇒ **给的是指令和"去哪取资源"，不是工具。**

⇒ **所以"把 skill 当 agent"在 DSH 里是【断的】，必须我们自己接上那一层。**

**我们已有的半成品**：`packages/skill-tree` 的 `SkillNode.Tools: ToolDef[]`
（`src/index.ts:160-161`，注释原文："ch22 §6：工具声明（**有 Script/Tools ⇒ 可升格 sub agent**）"）。
但该包**是纯数据层**（`package.json` description 明写："**只做数据层**：类型 + 生命周期 + Absorb，**刻意不含执行器**"），
**没有 cordis 插件、没有 `cordis.patch.yml`、一处 `tools.register` 都没有** ⇒ **`Tools` 字段声明了却从未被物化到任何 agent 的脸上。**

**要接的那根线**（落地形状）：
```
skill 声明它需要哪些工具（SkillNode.Tools，已有数据）
  → 调用该 skill 时，用【调用者自己的 scope】ctx.tools.register(那些工具)     ← 缺
  → 下一个装配里，调用者的工具面自动多了这些工具（证据一/二保证）           ← 自动
  → 模型看到"我有了新工具"，继续往下做
```

### 缺口 B：**子代现在的自我叙事就是"瘟神"，不是"获得新工具的人"**

实测子代 `system` 里的原文（本轮从真实会话读到）：
> "**You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session**
> — operations that require approval are rejected automatically."
> 以及 "**Approval prompts are disabled in this session** … do not request sandbox escalation"

⇒ 子代看到的是"**我是被削减的、权限锁死的下属**"。**这就是你说的"瘟神"味的来源，而且是上游默认写法。**
**好消息**：这段措辞**不在 `system` 段，而在消息面** —— 它是 `applyChildComposition` 里那条 **runtime-context 贡献**
（`child-agent.js:129`，`name: 'subagent:delegation'`, `order: 120`；`child-agent.d.ts:68-72` 明文
"A runtime-context contribution **rather than a system-prompt section**"）。
⇒ **改写它不动 `system` ⇒ 不砸父代→子代那一整段前缀复用**（已实测：`system` 逐字一致的子代首请求吃到 40576/40448 缓存读）。
⇒ **代价低，收益是"子代的自我认知"**——这本来就是我上一轮说的 B 方案（child-scoped listener），现在它终于有了**比省钱更重要的用途**。

---

## 4. 代价（必须写清，不能只说好处）

**每一次"获得新工具"都会改工具面 ⇒ 从第一个变化的 schema token 起，前缀复用全部失效。**
- 上游原话：`dsh-cordis-host-runner/README.md:60`（见上）、`dsh-tools/README.md:145`
  "Registration, disposal, or scoped restriction may invalidate reuse from the **first changed schema token**"。
- 我们自己的实测（181 会话）：子代多一个工具且**插在列表中段** ⇒ 首请求缓存读 **40576 → 1152（98.6% → 2.8%）**。

⇒ **所以"渐进披露"在 token 上的账是：平时省（脸上只有几十条目录项，几千字符），装载时付一次全价前缀重算。**
⇒ **这是可算的买卖**：只要"装载一次之后能持续多用若干步"，摊销下来就是赚的。
⇒ ★ **而且它给了"在压缩点做这件事"一个【正确的】理由**：
   **压缩本来就要重算前缀**（它替换掉整段历史）⇒ **把"批量装载工具"对齐到压缩点，两笔重算合并成一笔。**
   这正是你最早说的"**压缩时再合并**"——**位置从"改历史里的 system 段"（对象不存在，已作废）改成"改下一次装配的工具面"（成立）。你的时序直觉对了，我上一轮把它的位置判错了。**

---

## 5. 逐条对照你的模型

| 你说的 | 机器 | 判定 |
|---|---|---|
| 顶层评审团 → 逐层委派 | 已有：`council` preset + 议事厅席位；实测 depth 0/1/2/3，**depth 4 被拒** | ✅ |
| 拆成专项任务比混在一起做要好 | 机制上成立：**委派能让执行层的脸更小**；且 code 模式下工具目录占 `system` 净差的 **98.7%** | ✅ 但要成对报"面小了 + 活干成了" |
| 混在一起会"做了这里忘了那里" | 与"上下文越长、中段越易丢"一致；但**我们还没有本项目内的判据**（不能只凭感觉） | ⚠️ 待测 |
| 把 skill 当作 agent | **断的**：DSH 的 skill 只有指令 + 资源，不带工具（§3 缺口 A） | ⚠️ 要我们接 |
| 调 skill 只需知道"它有什么、干什么" | ✅ **上游已经这样**：skill 目录是 user 消息，**只带 name + description**，正文按需加载 | ✅ 完全一致 |
| 调完"我获得了新工具"（能力侧） | ✅ **成立**：`tools.register` 公开 + scope 化 + 活的；provider 每次装配求值；**上游 cordis 工具就是这么用的** | ✅ |
| "而不是瘟神"（叙事侧） | ❌ **现在正相反**：子代 system 明文"你是被委派的子代理，权限已锁死、不能放宽" | ❌ 要改写（在消息面，代价低） |
| 父代等子代回来 | ✅ `one-shot` 前台等；`continuable` 是"派完继续，子代结束投递一次 notice" | ✅ 两种都有 |

---

## 6. 未闭合 / 风险

1. **`tools.register` 在 agent scope 里的"存活期"**：文档说 "Disposed with the calling fiber" —— 若调用发生在**一次工具调用**的 fiber 里，
   注册会不会**随该次调用结束就被回收**？⇒ **必须实测**（这决定"装载"是永久的还是当次有效）。
   ★ **但上游已经把模板给出来了**（`dsh-cordis-host-runner/README.md`）：
   - `:12` —— "the host half is evaluated in the vm under the **`cordis-dynamic` group fiber** and the call returns."
   - `:15` —— "`stop` unwinds one live dispatch — handlers dropped, **host-half fiber disposed to quiescence**,
     `dynamicCordisRunner/retract` broadcast — and leaves the definition runnable."
   ⇒ **注册要挂在【命名 group fiber / 我们自己的长生命周期 scope】下，而不是工具处理函数那次调用的 ctx 里**；
   **卸载**对应 `stop`（dispose 到 quiescence + 广播 retract）。
   ⇒ 我们要仿的是这个做法，不是"在工具调用的 fiber 里 register"。
2. **"registry changes are deliberately unfiltered shared-state notifications"**（`dsh-tools/README.md:39`）
   ⇒ 变更**通知**不按 scope 过滤。**可见性**是 scope 化的（证据一），但**通知**不是。
   ★ 上游对同类问题的定式（`dsh-cordis-host-runner/README.md:16`）：
   "`inventory` answers the whole registry, **unaddressed by session** and with each row naming the session that owns it …
   **Listing is not acting: every acting verb still checks that ownership.**"
   ⇒ **可仿：全局可列 + 每个"动作"校验归属**。
3. **装载的工具要不要"卸载"**：`cordis_stop`/`cordis_undefine` 是上游的卸载路径 ⇒ 我们对应需要"封存该 skill 的能力"。
4. **`SkillNode.Tools` 的 `ToolDef` 能不能直接变成 `ctx.tools.register` 需要的 `ToolDefinition`**：两套类型没对过，**未验证**。
5. ~~**一次装载 = 一次前缀全失效**~~ ★ **已精确化（见 §7.4）**：代价取决于**注入位置与形态**：
   **消息尾端 ⇒ 100% 保住**；**工具块尾端（不碰 `system`）⇒ ≈97%**；**碰了 `system` 或其 guidance 段 ⇒ ≈3%**；**工具块中段 ⇒ 2.8%（今天）**。
   ⇒ 所以正确的表述是"**一次装载 = 一次【按位置定价】的前缀重算**"，不是"全失效"。
   仍需一条配额/合并策略（见 §4 的"对齐压缩点"），**未设计**。
6. **子代叙事改写**：属于 child-scoped `system-prompt/assemble` listener 或替换那条 runtime-context 贡献；
   ★ 若替换 system 段，**必须自己保住该子代 active 的 Code Mode / structured-output 协议**（driver `README.md:43` 明文）。

---

## 7. ★★★ 用户第八次收紧：**「分身」模型** —— 判定：**合理**，且有一条必须精确化的前提

### 7.1 用户这次的收紧是什么

> "子agent是父类agent的**再次包装**，即它**既有父类的所有功能，又有自己新带来的所有功能**；
> 所以只需把**新注入的工具放在尾端**即可，**就像注入了一个 skill 一样** ⇒ **不会有任何前缀失效**。
> 所谓子 agent 其实就是**副 agent**，或"**用了一次新 skill**"罢了。
> 只是我们把**每一次 skill 都拿到分身里去用，而不是主体直接用** —— 主体并不直接使用 skill。"

⇒ 这是一次**概念降级换工程确定性**：把"动态工具面 / 渐进披露 / 压缩点合并"那一整套，收成
**「主体脸不变；每次装载都发生在短命分身上；分身 = 主体脸 + 增量」**。

### 7.2 先确认前半句：**"分身 = 父代的再次包装"在机器上是真的**

实测（`out/probe-face-share.mjs`）：子代与父代 `system` **逐字相同**、工具清单**逐位相同**（102=102 / 103=103）的那些样本，
子代首请求 `cacheReadTokens` = **40448 ~ 41088**。⇒ **父代整份脸本来就是逐字继承的**（`composeFrom` 加入父代 preset），
**你说的"它有父类所有功能"是事实，不是我为了顺你而说的。**

### 7.3 ★★★ 关键量化（**已用服务端读数独立反推，不信 chars/4**）：脸 ≈ **40.5K token ≈ 首次请求的 99%**

⚠️ **本条已更正（2026-09-21，当晚）**：先前用 `chars/4` 估出"脸占 70%、父代消息占 29%"——**错了**。
独立口径（`out/probe-face-truth.mjs`）：**同一 preset 的首次请求若已被几乎全部命中，则 `cacheReadTokens` ≈ 该 preset 的脸**
（首次请求的消息只有那条 prompt）。

`preset=council` 的 68 个样本里，首次请求 `cacheReadTokens` 呈**密集簇**：

| 读数 | 含义 |
|---|---|
| **40832**（出现 20+ 次，众数） | ★ **脸的真实规模 ≈ 40.8K token**，此时 `uncachedInputTokens` 仅 **219** |
| 40448 / 40576 / 40704 / 41088 | 同一张脸的不同测量（±几百 token） |
| 9344 / 9088 / 8960 / 128~2304 | 只有**部分**被缓存的会话（前缀只热了一截） |

⇒ **`system` 只有 6,461~6,880 chars（≈2.4K token），而缓存读到 40,832** ⇒
**多出来的 ~38K 只能来自工具块** ⇒ ★ **独立结论：`tools` 确实算进缓存前缀，而且它是脸的主体。**
（这顺手回答了 §8.4 原来的"没测过"的问题。）
⇒ **真实 `chars/token ≈ 2.87`（不是 4）** —— JSON schema 文本的 token 密度远高于散文。

**⇒ 修正后的构成（council preset，子代首请求 ≈ 41.1K token）：**

| 构成 | 规模 | 占首次请求 |
|---|---|---|
| `system` 文本 | 6.5~6.9K chars | **≈ 2.4K tok（6%）** |
| **工具块（102 个 schema）** | ~108K chars | **≈ 38K tok（≈92%）** |
| **⇒ 脸合计** | **≈115K chars** | **≈ 40.5K tok（≈ 99%）** |
| **父代消息段 / prompt** | — | **≈ 0.2 ~ 0.6K tok（≈ 1%）** |

⇒ **⇒ 结论完全变了**：**"脸"就是整个请求**。父代那点消息在这张脸面前**微不足道**。
⇒ **所以"把新工具追加在工具列表末尾"不是妥协，是一笔近乎免费的买卖**（保住整份脸 ≈ 99%）。
⇒ 也解释了 `exp-base`(102) 与 `exp-base-nodc`(30) 的差距为什么那么大 —— **脸就是成本本身**。

### 7.4 ★★ 于是"没有任何前缀失效"要分两种形态说 —— **差一个数量级**

| 增量注入的**位置/形态** | 可复用的前缀 | 保住 | 对照今天的实测 |
|---|---|---|---|
| **消息尾端**（skill 形态：一条指令/资源说明） | `[脸][父代消息][增量]` | **100%** | ✅ **真·零失效** —— 你说的"就像注入了一个 skill"正是这种 |
| **工具块尾端**，且**该工具【不带】`system` 指导段** | `[脸 + 新工具][父代消息]` | **≈97%**（保住整份脸 ~40.5K，丢的只是那 ~0.3K 消息段） | ✅ **近乎免费** —— 见 §7.3 的更正（脸 ≈ 99% 的请求） |
| **工具块尾端**，但该工具**带 `system` 指导段**（`report` 就是） | **断在 `system` 里** ⇒ 工具块与消息全废 | **≈3%** | ❌ **实测 1152 tok（2.8%）** —— 断点原文就在那句 `report` 指导的开头，位置在 `system` 的 **6162/6880（89.6%）** |
| 工具块**中段**（今天的实际做法，字典序） | 断在第 88/103 位 | **2.8%** | ❌ 实测 |

⇒ **精确结论**：
- **"把新东西放在尾端 ⇒ 零失效"只在"新东西是消息"时完全成立。**
- **"新工具 schema 追加在工具块末尾" ⇒ ≈97%**（保住整份脸 ≈40.5K，丢的只是 ~0.3K 消息段），
  **前提是该工具完全不碰 `system`**；一碰 `system` 就掉到 ~3%（见 §7.3 的更正与 §8.1）。
- ⇒ **真正的分水岭是"改不改 `system`"**：`system` 在最前，**它一断，后面的工具块与消息无论排得多好都没用**。

### 7.5 判定：**这个调整合理**，理由三条（都不是感觉）

1. **它把"不稳定"隔离到短命对象里。** 装载会改工具面 ⇒ 必然引起一次前缀重算。**主体永不变脸 ⇒ 主体的前缀永远稳定；
   所有长尾能力都发生在短命分身上 ⇒ 重算只发生一次、且随分身消亡。** 这是标准的"把变化关进沙盒"，架构上是对的。
2. **它把主体的脸从"N 条委派工具行"降到"1 个入口"。** 今天主体每个请求都付 `subagent` / `subagent_fork` / `council_architect`
   三条常驻 schema（`dsh-tool-subagent/README.md:44`："each provider instance adds one schema"）。
   ⇒ **主体只留一个入口工具**（skill 或 delegate），**是今天就能做的、立刻可量的瘦身**。
3. **它天然不需要"卸载"。** 分身用完即没 ⇒ 不需要上游 cordis 那套 `stop` / `dispose to quiescence`（见 §6.1）。
   **"短命"本身就是回收机制。**

### 7.6 ⚠️ 但有三条前提必须说清（否则会以为"简化后什么都不用做"）

1. **"主体只有小集合"要求委派入口收敛成一条** —— 这是 preset 级改动，**今天可做**（把三条委派工具行收成一条入口）。
2. **"分身带着增量工具"仍需要缺口 A 被补上**：skill 里声明的工具仍要**物化**成 `ToolDefinition` 并注册到分身自己的 scope。
   `SkillNode.Tools` 的 `ToolDef` 与 `ctx.tools.register` 的 `ToolDefinition` **两套类型没对过（未验证）**。
   ⇒ **"分身"简化的是【概念与主体】，不是【那根要接的线】。**
3. **若增量走工具形态，分身每次要重付一次 ~11.9K 的消息段** ⇒ **分身不宜太短**。
   ⇒ **需要一个"分身最短寿命"判据**（跑够 N 步才回本）—— **未设计**。
   若增量走 **skill 指令形态**（零失效），这条约束**不存在**，代价转移到"每次执行要模型自己用通用工具实现"。

### 7.7 关于"概念没那么刺激眼球、开源炸社区效果没那么强"

诚实说：**这个担心是真的，但赌注押错了地方。**

- **概念平凡的代价是真实的** —— 传播确实吃新名词。但 **"分身 = 主体 + 增量"** 这个词组有个隐藏优势：
  **它把正确性变成可检验的**（可以直接比对主体与分身的 `system` / 工具清单 / 前缀，见 §7.2 的实测）。
- **真正稀缺的传播材料不是新名词，是"可复现的计量与判据"。** 我们手上恰好有：
  `cacheReadTokens` 真实账单、181 会话的复用实测、工具插入点的字节级定位、`leafFace` 行为直方图。
  **"我们试了动态工具面/渐进披露，最后发现答案是把 skill 当分身跑" —— 这种朴素结论 + 硬数据，比任何新词都更像真的。**
- ⇒ **建议的叙事**：不卖"子代理"，卖**"一次装载 = 一次分身，且我们能证明它省了多少"**。
  把 novelty 从**概念**移到**可验证的闭环**（无回归 + 拓展新功能节点 + 更省）—— 这才是别人抄不走的部分。

---

## 8. ★★★ 用户追问「工具 schema 一定要追加在工具块尾端吗？不能放在消息尾端吗？不能改吗？」 —— **能改，但改的是"载体"不是"顺序"；且"71%"这个数要更正**

### 8.1 ❌ 先更正我自己：追加在末尾是 **≈97%**（不是 71%）；真正的杀招是"碰了 `system`"

我上一轮说"把新工具挪到工具块末尾 ⇒ 2.8% → 71%"。**两个数都要改**：
- 71% 来自用 `chars/4` 估的"父代消息段 ≈ 11.9K"——**这个估算错了**（真实 `chars/token ≈ 2.87`，见 §7.3）。
  脸的真实规模是 **≈40.5K token ≈ 首次请求的 99%**，父代消息段只有 **~0.3K**。
  ⇒ **追加在工具列表末尾能保住整份脸 ⇒ ≈97%，近乎免费。**
- 而 `report` 实测的 **2.8%** 是**另一回事**：它**同时往 `system` 里加了一段指导**。
  实测（`out/tool-insert-point.txt`）：`report` 这个工具**同时**带来两处改动：

1. `system` 里多了一段 `tool:report` 指导 —— 断点原文就在它的开头：
   > "…ime sends a notice containing its outcome and any final assistant message.⏎⏎**Deliver your result with the `report` tool before you finish**: call it once with a …"
   断点位置 = `system` 的 **6162 / 6880（89.6%）**。
2. `tools` 列表里多一项，按字典序落在**第 88 / 103 位**。

⇒ **`system` 在 89.6% 处先断 ⇒ 它后面的工具块与全部消息，无论怎么排都拿不回来。**
⇒ 所以 `436fde97` 实测只有 **1152 tok / 2.8%** —— **不是"位置没排好"，是"动了 `system`"。**

⇒ **更正后的规则（这条比什么都重要）：**
> **分水岭不是"工具排在列表哪里"，而是"改不改 `system`"。**
> **`system` 在最前 —— 它一断，后面排得再好都无效。**

- 新增工具**不带** `system` 段 ⇒ 保 **≈97%**（保住整份脸 ≈40.5K，丢的只是那 ~0.3K 消息段）
- 新增工具**带** `system` 段（`report` 就是）⇒ 保 **≈3%**

**⇒ 顺带的推论：DSH 里"工具集"与"system"是耦合的** —— `dsh-system-prompt/README.md:42` 说工具包各自拥有
"cross-call guidance（`tool:bash`, `tool:read`, …）"，且 `dsh-tool-subagent/README.md:40` 明说
"a tool restriction removes **both its schema and this guidance**"。
**⇒ 在 DSH 里想只动工具不动 system，是不自然的操作。**

### 8.2 ✅ 「能不能放在消息尾端？」—— 能，但**必须走 dispatcher**

**能不能**取决于一件事：**这个能力由谁执行？**

- **由已有 dispatcher 执行**（`run_code` / `bash` / `pwsh`，或 `subagent` 本身）
  ⇒ **能，而且这是唯一 100% 免费的形态**：`tools` 字段不变、`system` 不变，增量只是一条**消息**。
  ★ **上游有两个现成先例**：
  - **Code Mode**：wire 工具只有 `run_code`，而**整份工具目录是 `system` 里的文本**（`ToolArgsMap` + MCP 指导，
    实测占净差的 98.7% / 39284 chars）⇒ **"能力以文本描述、以 dispatcher 执行"上游本来就在用**。
  - **`skill` 工具**：正文作为**一次 tool result** 落在**消息尾端**（`dsh-tool-skill/README.md:25-31`）。
- **要求原生工具调用**（模型直接 emit tool call、由 API/框架校验 schema）
  ⇒ **不能**。`tools` 是 provider 请求的**顶层字段**，位置在 `system` 之后、`messages` 之前
  （`dsh-llm/lib/types/types.d.ts:344-347`；`dsh-system-prompt/README.md:35`："adapters transmit schemas as a separate wire field"）。
  **这是 provider 的 API 契约，不是 DSH 的设计选择。**

### 8.3 「就算它是现有的形式，我们不能修改它吗？」

**能改的、与不能改的，要分开：**

| | 能不能改 | 说明 |
|---|---|---|
| **字段顺序**（system → tools → messages） | ❌ **不能** | provider API 契约；这不是我们和 DSH 能协商的东西 |
| **"什么放进 `tools`、什么放进消息"** | ✅ **能** | ★ 这才是真正自由的维度（Code Mode 与 skill 已经证明了） |
| 新增工具的**列表位置** | ✅ 能 | `dsh-system-prompt` 的 `toolOrder` + `<unlisted-tools>` rest entry（`README.md:14`） |
| 新增 guidance 的**段序** | ✅ 能 | `PromptSection.order`（工具指导用 **100–199** 带，`README.md:34`） |
| **装载时机** | ✅ 能 | 对齐压缩点（压缩本来就要重算前缀） |

⇒ **结论：我们改不了"顺序"，但完全能改"载体与形状"。**
**而"零成本"只对"整个请求里最后出现的那一段"成立** —— 所以若要零成本，增量就必须是**最后一个消息**。

### 8.4 ✅ 原"没测过"的问题，已用独立口径破案：**`tools` 算进缓存前缀，而且是脸的主体**

先前担心"`system` 与 `tools` 总是同时变化，从未分离过"。**但用服务端读数可以直接反推**（`out/face-token-truth.txt`）：
`preset=council` 的首次请求 `cacheReadTokens` 众数 = **40832**，而此时 `uncachedInputTokens` 仅 **219**；
`system` 只有 6,461~6,880 chars ≈ **2.4K token** ⇒ **多出来的 ~38K 不可能来自 system** ⇒ **只能来自工具块。**

⇒ **`tools` 确实参与缓存前缀，且是主体（≈92%）。** 不需要再跑实验验证这一点。
⇒ 但仍值得做一次**受控 A/B**（保持 `system` 逐字不变，只往工具列表**末尾**追加一个**不带 guidance** 的工具）
来把 §8.1 的"≈97%"从推演变成实测。

---

## 9. ★★★ 用户第九次确认（「猴毛」模型）—— 三条**逐字成立**，一处措辞要改，一个撤回我同意

### 9.1 用户原话里的三条断言 → **都已在源码里逐字成立**

| 用户说 | 源码 | 判定 |
|---|---|---|
| "分身对他而言其实就是**新加载的一个 skill**" | 同构：skill 也是"摘要常驻 + 正文按需装入" | ✅ 概念一致 |
| **"从工具开始的那一瞬间，全都不给子 agent，因为他不需要知道"** | `dsh-subagent-fork-in-process/lib/index.js:5-9`：<br>"The seed **ends at the last `turn/end`**: **the current tool-call turn is unbalanced and cannot be replayed as a valid child session**."<br>`:16-19`："every event up to and including the last `turn/end`. **The in-flight turn is excluded**" | ✅ **一字不差** —— **快照语义，不是直播**：子代拿到"到上一个回合结束为止"的历史，**父代当前这一轮（含那次委派调用本身）不入种子**，父代此后的一切也不流向子代 |
| "分身的**当前目标和期望的回执**，当作对子代的**用户输入**" | 对应 API：`prompt`（目标）+ `description`（短标签）+（可选）`outputSchema`（期望回执的形状，由 `attachStructuredRuntime` 落地，子代被要求"结构化输出即终局答复"） | ✅ 映射得上 |

★ 顺带：上游给的**机制理由**比"权限"更根本 —— **"the current tool-call turn is unbalanced"**：
正在进行的回合里工具调用还没配对完成，**没法作为合法子会话重放**。所以"切断"不是设计偏好，是**结构必然**。

### 9.2 ★ 用户撤回"压缩时二次重载" —— **同意，而且现在有账支撑**

用户说："压缩的时候还能把工具重新更新……但其实这个已经没有必要了，我们前面已经设计得很完善了，**这一步有点画蛇添足**。"
**⇒ 同意。** 我先前建议"把装载对齐到压缩点以摊薄前缀重算"，前提是**装载很贵**；而 §8.1 已证
**追加在工具列表末尾 ≈ 97%（近乎免费）** ⇒ **不需要摊薄，压缩点对齐确实多余。**
（唯一例外：若新增工具把说明写进 `system`，代价回到 ~3%，那时对齐才有意义 —— 但那应按 §9.3 直接避免。）

### 9.3 ⚠️ 一处措辞必须改：**"合进前面的系统提示词"会砸前缀**

用户说："它的工具**只需要把它合进前面的系统提示词即可**，**不需要把父类的剔除**。"
- **"不需要剔除父类的" ✅ 对** —— 脸本来就是逐字继承的，分身是**超集**（§7.2 实测）。
- **"合进系统提示词" ⚠️ 要改成"合进【工具列表末尾】，且说明别走 `system`"**：
  在 DSH 里一个工具的"能力"分两半 —— **schema 在 `tools` 字段**、**使用说明（guidance）在 `system`** 里的 `tool:<name>` 段
  （`dsh-system-prompt/README.md:42`："tool packages own their cross-call guidance（`tool:bash`, `tool:read`, …）"）。
  **`report` 的 2.8% 就是被后半句打死的**：它往 `system` 加了一句说明 ⇒ 断在 `system` 的 6162/6880 ⇒ **后面 38K 的工具块全废**。
- **正确做法**：新增工具的 **schema 走 `tools.register`（追加在列表末尾）**，
  它的**说明走 `systemPrompt.context()`（运行时上下文 ⇒ 落在消息面），而不是 `systemPrompt.section()`**。
  ★ **上游自己就是这么给子代写委派声明的**（`subagent:delegation`, order 120，明文 "a runtime-context contribution
  **rather than a system-prompt section**"）⇒ **两头都不砸前缀。**

### 9.4 ★★ 一个限定条件（容易漏，会直接翻车）：**这条"免费"只对 native 模式成立**

- **native 模式**：工具知识在 **`tools` 字段** ⇒ **追加在末尾 ⇒ 保住整份脸 ⇒ ≈97%** ✅
- **code 模式**：**工具目录与 `ToolArgsMap` 被渲染进 `system` 文本**
  （实测 `exp-base` 79405 chars vs `exp-base-nodc` 39605，净差 39284 ≈ **98.7% 是工具目录**）
  ⇒ **在 code 模式下，任何工具增删都改 `system` ⇒ 必然断在 system ⇒ 必然 ~3%** ❌

⇒ **⇒ 要"近乎免费地加能力"，分身应当走 native 模式**；code 模式的脸更小，但**增量的代价高**。
（这是一个**取舍**，不是优劣：code 模式省常态，native 模式省增量。）

### 9.5 更正后的账（把 §7.3 的真实数字带进来）

**追加在工具列表末尾** ⇒ 保住**整份脸 ≈40.5K tok（≈99%）**；丢的是**该子代自己的消息段**（fork 种子 + 任务）。
- 我们样本里的 fork 子代，消息段只有 **~200–550 tok**（种子很短）⇒ 总命中 **≈97%**。
- ⚠️ **种子越长丢得越多** —— 我们**没有大种子的样本**，**这一条未实测**（诚实标注）。
- 若**完全不追加工具**（纯 skill 指令形态）⇒ **连种子都保住 ⇒ 100%**。

### 9.6 「猴毛」隐喻里真正被机器支持的部分

- **"像元帅指挥军队，而不是每部分都自己上手"**：`dsh-tool-subagent/README.md:54,58` 明文 ——
  "Success contains **only the child's final text** … **Intermediate child steps stay out of the parent**"、
  "The prompt and result remain in parent history until compaction; **child working context remains in the child**"
  ⇒ **父代的上下文里只多出"任务 + 回执"两段，子代的过程完全不在父代** ✅
- **"主线只需要一直推演现在的局面"** ⇒ 这就是上一条的直接后果：主线的上下文增长**与任务的复杂度解耦** ✅
- **"大大缩减长程任务的漂移"** ⚠️ **机制上说得通，但本项目还没有判据** ——
  需要一个"长程任务漂移"的可测定义（例如：同一多步任务，委派版 vs 单线程版的**步数、返工次数、最终正确率**）。
  **未设计。** 在拿到这个判据之前，"缩减漂移"只能算**有机制支撑的假设**，不是结论。

---

## 10. ★★★ 用户更正我的读法（2026-09-21 深夜）—— **我撤回上一轮的"同意"；你的"压缩点合入"是对的**

### 10.1 先把两个定义钉死（逐字，不是我的解释）

`dsh-agent-tool-presentation/README.md:5`：
> "The row an agent preset carries to say which form of its tools the model sees:
> **`native` (every schema)**, **`code` (only `run_code` plus a generated TypeScript SDK)**, or `both`."

| 模式 | 模型看到什么 | 怎么调 | 工具知识住在哪 |
|---|---|---|---|
| **`native`** | **每个工具的完整 schema** | 直接 emit tool call | **`tools` 字段** |
| **`code`** | **只有 `run_code`** + 一个**生成的 TypeScript SDK** | 写代码，在 `run_code` 里调 | **`system` 里的 SDK section** |

补充事实：
- **presentation 是 per-agent 的**：`ctx.tools.presentAs()` "declares it for the mounting agent alone,
  so a Code Mode session runs beside native ones in one process, **each seeing its own catalog**"（`:9`）
  ⇒ ★ **主体走 `code`、分身走 `native` 是允许的。**
- 但**一个 agent 只能声明一种**：`:19` "**One agent declares one presentation.** A second declaration in the same composition is refused rather than merged"。
- 我们 preset 里的对应关系（`scripts/make-council-preset.mjs` 头部注释）：
  **`standard` = native**；**`code` = `standard` + 一行 `tool-presentation`** —— 那一行就是 Code Mode。

### 10.2 「code 模式一定要渲染进 system 吗？」—— **是，而且是它的定义所迫**

`:23` 逐字：
> "`code` presents `run_code` plus **a generated SDK section** and the rule that only `run_code` may be called directly"
> "…under `code` the registry resolves **a model-direct call naming any other tool to `UNKNOWN_TOOL`**, so this row is what keeps
> **the announced surface and the callable surface the same**"

两条推论：
1. **必须进文本**：既然模型**只能直接调 `run_code`**，其余工具就**不能出现在 `tools` 字段** ⇒ 它们在 prompt 里的唯一去处是**文本**；
   而文本要么进 `system`（稳定），要么进消息（每步变）⇒ 上游选了 `system` 的一个 section。
2. ★ **`code` 模式下"尾部注入告知"是调不动的**：模型直接调那个名字会得到 **`UNKNOWN_TOOL`**。
   要真能调，它必须进 SDK 段 ⇒ **必然改 `system`** ⇒ 与我们实测一致（79405 vs 39605，净差 39284 ≈ **98.7% 是工具目录**）。

### 10.3 ★★ 我上一轮的"同意撤回"**要撤回** —— 你的"压缩点合入"是对的

**上游的设计前提（`:27` 逐字）：**
> "**No direct invalidation; the presentation is fixed when the agent is composed, so its request prefix is stable for the session's life.**"

⇒ 上游**刻意让脸在整个会话生命周期固定不变**，目的正是保住前缀。
⇒ **"中途改脸"是上游刻意避免的事**；**你的方案把"改脸"限制到唯一不付代价的时刻 —— 方向与上游一致**，
只是把"永不改"放宽为"**只在压缩点改**"。**⇒ 你的两段式（先尾部、压缩点合入）成立，我错了。**

**我错在哪（这条是真正的原因，也是本次最重要的更正）：**

我上一轮说"装载已经近乎免费（97%），所以不需要压缩点对齐"——**那只算了"子代刚出生时装载"**：那时消息段 ≈ 0。
**但装载如果发生在子代跑了很久之后，代价不是"消息段很小"，而是丢掉【子代自己已经积累的全部消息】：**

```
[system][旧工具][★新工具][子代已积累的消息 ……]
                    ↑ LCP 断在这里 ⇒ 后面那一大段消息【全部重算】
```

⇒ **代价 = 子代当时的消息总量，随它的寿命增长。**
⇒ ★★ **只有压缩点没有这笔账** —— 因为**压缩本来就要把那段消息替换成摘要**，前缀**无论如何都要重写一次**。
⇒ **⇒ 在压缩点把尾部声明折进 `system` 是【真·免费】。你的直觉对，我上一轮的"画蛇添足"结论作废。**

### 10.4 但有一条必须同时说清：**"零代价"与"立刻能调"对【原生工具】不能兼得**

| 增量形态 | 尾部注入后**能不能立刻真调** | 成本 |
|---|---|---|
| **指令 + 已有 dispatcher**（`run_code`/`bash`，即 skill 形态） | ✅ **能**（dispatcher 本来就在脸上） | **0** |
| **原生工具 schema** | ❌ **不能**（`tools` 里没有它） | 要么**立刻加** ⇒ 按"已积累消息量"付费；要么**等到压缩点** ⇒ 合入前调不动 |

⇒ **⇒ 设计规则**：
1. **优先让增量走"指令 + 已有 dispatcher"** —— 零代价 **且** 立刻可用（这是你"就像注入了一个 skill"的字面形态）。
2. **确需原生工具**时，**把"合入 `system`"安排到压缩点**（唯一免费时刻），并接受"合入前不能直接调"，
   或选择"立刻加 schema 到工具列表末尾"并接受重算子代已积累的消息段。

### 10.5 「子 agent 自己做一套新的注入系统，全都往后面」—— **能，而且上游已有现成范式**

★ **`skill` 的 catalog 就是"尾部的、可替换的、渐进披露的注入通道"**（`dsh-tool-skill/README.md:16,18`）：
- 它是 **durable user-role 消息**（**不是 schema**），且**只带 `name` + `description`**；
- 变化时**追加一条完整的替换消息**（同一个 `<available_skills>` 信封），空替换显式作废旧名字；
- 正文**按需装入**（`skill` 工具调用时）⇒ **"摘要常驻 + 正文按需"**。

⇒ **所以分身的"自己的注入系统"不需要发明**：仿这个形态即可 ——
**一个 child-scoped 的 catalog 消息（尾部、可替换）承载"我现在会什么"，
需要正文时再装入，而"硬脸"（`tools`/SDK section）只在压缩点更新。**

### 10.6 未闭合（本轮新增）

1. **"压缩点合入 `system`"的落地钩子**：写 system 的只能是**装配层**（§2 结论不变），所以"压缩点合入"=
   **一个 child-scoped 的装配贡献 + 一个"是否已过压缩点"的判据**（读该子代的压缩计数/`surfaceOp` 事件）。
   **触发条件的实现未设计。**
2. **`code` 模式下 SDK 段会因注册变化而重生成** ⇒ 在 `code` 模式下"压缩点合入"**价值最大**（那是唯一免费时刻）；
   在 `native` 模式下"出生时追加"也已足够便宜。**两种模式的最优策略不同，未做对照实验。**
3. **子代能否自己选 presentation**（`presentAs` 是 per-agent，但子代是否被允许声明与父代不同）—— **未验证**。

---

## 11. ★★★★ 用户提出**更省的一条路**：「**上下文只暴露第一次的初始化，变动由工具内部知道**」

### 11.1 用户的提案（原话）

> "那你就子代不掉这个 `run_code` 呗……**Tool 字段有必要限制的那么严吗？我们只要上下文里面不动**，然后**本身在那个工具里面，它同意（知道）不就可以了**？
> **为什么一定要追加进上下文里呢？这部分上下文只用暴露第一次的初始化即可呀，后续有什么变动？为什么要在这里变？
> 工具内部知道，然后上下文后续也追加了不就可以。**"

⇒ 读法：**别去追"让上下文与真实能力集保持同步"。让上下文的脸【固定不变】（= 初始化那一份），
真实能力长在【工具内部】（运行时解析）；真正需要告知时，只往【消息尾端】**追加**。**

★ **这是我这几轮听到的成本最低的一条路，而且机制上通。**

### 11.2 机制为什么通 —— 因为"能力面"是**投影**，不是权威

| 事实 | 出处（逐字） |
|---|---|
| `code` 模式交给模型的是：`run_code` + **`tools:sdk` 段** + "只有 `run_code` 可直接调"的规则 | `dsh-tools/README.md:16` |
| **SDK 段是 lazy section，每次装配【重新生成】** | `:122` "a **lazy prompt section regenerating** … **at each assembly**" |
| 它的内容 = **当前 scope 的可见工具集**（`ToolArgsMap` / `ToolOutputMap`，逐工具精确类型） | `:118`，`:122` |
| ⇒ **所以"工具集变 ⇒ SDK 段变 ⇒ `system` 变"** | 与实测 39284 chars 净差一致 |
| ★★ **但装配层 listener 可以【替换注册表的贡献】，且"其返回的装配是权威的"** | `:20` "A `system-prompt/assemble` listener **may replace the registry's contributions**; its returned assembly is **authoritative**" |
| 那个 listener 由它自己负责保住**可用的 Code Mode 协议** | `:20` 同上 |
| SDK 段对**未变的工具集是逐字节相同**的（lexicographic，缓存友好） | `:122` |

⇒ **结论：SDK 段是"注册表的一个投影"，而投影是可以被我们替换的。** 我们不必让它是"逐工具清单"。

### 11.3 回答"能不能改 `run_code`" —— **改不了，但也不需要改**

`:16` 逐字：**"The reserved transport cannot be registered, shadowed, restricted, or removed"**
⇒ **`run_code` 这个名字与存在性都动不了**（它是保留传输，任何模式都保留）。
⇒ **但真正要控制的是 `tools:sdk` 段，而不是 `run_code` 本身** —— 而 SDK 段的正规入口就是装配层 listener（`11.2` 第 5 行）。**⇒ 不需要 patch。**

### 11.4 回答"Tool 字段有必要限制得那么严吗" —— **那不是"权限限制"，是"声明面 = 可调面"的一致性保证**

`:120` 逐字：under `code`，**"a model-direct call naming any other tool resolves to `UNKNOWN_TOOL`** at execution creation,
before `tools/pre-execute`, approval `ask`, and guards, so nothing observes or approves a call that can only fail"，
且拒绝信息会**指路**（"only `run_code` is callable directly — call `<name>` from inside a `run_code` program instead"）。
⇒ 它的目的是**不让你调一个没告诉你、也必然失败的东西**，并在失败时明确告知怎么走对路（因为同一个 prompt 里确实声明了那个工具）。
⇒ **它不是安全边界**（`dsh-tools/README.md:22`："This is **live visibility composition**, not an authority boundary"）。

**⇒ 而"我们替换 SDK 段"这件事没有破坏这个保证** —— 一致性只是从"**逐工具**"变成"**逐能力名**"：
**声明面（固定的通用调用面）仍然等于可调面（通用调用面能路由到的那些）。** 我们只是把"精确清单"挪到了运行时。

### 11.5 ★ 落地形状（三段，零 patch）

```
① 脸：固定不变
   child-scoped 的 system-prompt/assemble listener 把 tools:sdk 段替换成【固定的通用调用面】
   （不再逐工具生成 ToolArgsMap）⇒ 工具集变化【不再改 system】⇒ 前缀永不失效
        ↓
② 能力：活在运行时
   真实可用能力集由我们的插件解析；模型在 run_code 程序里通过那个稳定入口调用
   （"工具内部知道"）—— 与 code 模式"每个 binding 重入完整工具管线"的语义一致（:118）
        ↓
③ 告知：只追加消息
   需要让模型知道"现在有什么"时，往【消息尾端】追加一条（skill catalog 形态：durable user-role 消息、
   只带 name+description、变化时追加一条完整替换消息）⇒ 代价 0
```

### 11.6 ⚠️ 代价必须成对量（不能只报收益）

| 换来 | 付出 |
|---|---|
| **前缀永不变 ⇒ 工具集可以随时长/缩而不付一次重算** | **放弃逐工具的精确类型**（`ToolArgsMap` / `ToolOutputMap`，实测 `ToolArgsMap` 块约 27350 chars）⇒ 模型失去"精确参数类型"这一层保护 |
| 上下文变小（不再逐工具列清单） | **错误率可能上升**（参数写错靠运行时校验才发现，而不是写出来就错不了） |

⇒ **必须成对报的判据**：**「零失效省下的 token」 vs 「类型信息缺失带来的错误率/返工次数」。**
**在拿到这一对之前，这条路只能算"机制可行、账未结"。**

### 11.7 其他硬约束（会直接卡住实现的）

1. **一个 agent 内不能 native/code 混**：`:196` "**within one agent no tool can be native-only while another is code-only**"
   ⇒ 分身要么**整张脸 native**，要么**整张脸 code**。
2. **`presentAs` 每个 agent 只能声明一次**，且**从普通 context 调用会抛**（`:21`），同一 scope 第二次声明也抛。
3. **替换 SDK 段后，"保住可用的 Code Mode 协议"是我们的责任**（`:20` 明文）—— 这条账要认。
4. **`code` 模式要求 `ctx.codeRuntime` 存在且有 SDK renderer**（TS 随 `dsh-code-runtime-worker-thread`；Python 内置渲染器但后端另交付）：
   `mode: code/both` 在没有 runtime 时**拒绝装配**，且 `dsh-agent-presets` 会**拒绝挂载并点名该 id**（`dsh-agent-tool-presentation/README.md:15`）。
5. ★ **且 SDK 段的"通用调用面"具体长什么样、我们的运行时解析怎么接进 `run_code` 的 binding 管线，未设计。**
