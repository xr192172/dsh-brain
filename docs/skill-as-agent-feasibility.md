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
5. **一次装载 = 一次前缀全失效** ⇒ 需要一条配额/合并策略（见 §4 的"对齐压缩点"），**未设计**。
6. **子代叙事改写**：属于 child-scoped `system-prompt/assemble` listener 或替换那条 runtime-context 贡献；
   ★ 若替换 system 段，**必须自己保住该子代 active 的 Code Mode / structured-output 协议**（driver `README.md:43` 明文）。
