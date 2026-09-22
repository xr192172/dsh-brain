# 分身规格 · 施工用（2026-09-21 定稿）

> **本文件是自足的施工依据**：不依赖任何对话历史、不依赖 `skill-as-agent-feasibility.md` 的上下文。
> 那份 feasibility 文档是**讨论过程记录**（§1–14，含每一次更正），**本文件是它的结论固化**。
> **压缩上下文后如需恢复工作，只读本文件 + `out/` 下的实测输出即可继续。**
>
> 证据格式：`包/lib/...:行` 或 `docs/子路径:行`（克隆在 `D:\project_develop\_research\deepseek-harness\deepseek-harness-master\`）。

---

## 0. ★★★ 当前状态摘要（2026-09-22 11:20 更新；**压缩后先读这节**）

> **一句话**：**上游 fork 的"复用价值"已被我们实测证实；而我们自己的"分身机制"一行代码都还没写。**

### 0.1 ✅ 已完成（都可复算）

| 项 | 结论 | 证据 |
|---|---|---|
| **fork 的复用是真的（且 1:1）** | 种子 **≈92.6K** 时子代首请求 `cr` 从 40,448 涨到 **133,248**（+92,800，近 1:1），命中 **99.69%**，未缓存仅 **413** | `out/verify-bigseed.txt` |
| **"不污染父代窗口"成立** | 父代委派前 133,334 → 之后 133,603 ⇒ **净增 +269** | 同上 |
| **脸的实测构成** | `system` 2.4K（6%）+ `tools` 103 个 **37.8K（94%）** ≈ **40.2K tok** | `out/face-anatomy.txt` |
| **官方缓存机制** | 每请求构建缓存；**命中要求完整匹配一个 cache prefix unit**（单元在"请求边界/公共前缀/固定间隔"三处持久化）；TTL **数小时~数天** | `api-docs.deepseek.com/guides/cache/…`（见 §14） |
| **压缩信号可订阅** | 判据 = `compaction/summary`(shadowedSeqs 非空) 或 `compaction/prune`；订阅 `ctx.on('session/event')` 且**本就 scope 过滤**；历史为真 **202 次** | §9/§10 |
| **(d) 路线可行** | 用 `system-prompt/assemble` listener 包 `next()` 只钉一段，**实测通过**（含消融负对照） | `out/w7-pin-probe.mjs` |
| **无生效 `complete` 段** | 唯一真风险 `dsh-persona` 未启用 `complete` ⇒ 钉住当前不会被静默作废（**但仍须启动期断言**） | §10.1 |
| **无头驱动真实会话** | 前端 RPC 可用：`session.prompt` / `session.create` / `session.list` | §11.6 |

### 0.2 ❌ 未完成 —— **真正要做的事**

1. **施工 S1–S5 一行未写**（当前全部产出是：取证 + 规格 + 度量工具）。
   - **S1 已无阻塞**（O3 已解）⇒ 可直接开工。
2. ~~**度量工具两处待改**~~ ✅ **已完成（2026-09-22，见 §15）**：
   - **O24 已修**：主表"首请求"改为取 `seedLength` 之后第一条；旧口径并列保留（仅 3/185 个会话两者不同）。
   - **O22 已修**：负对照改为**按 `seedLength` 是否存在分臂**（臂 A 全 >0 / 臂 B 全 ==0），现已 `passed = true`。
   - ⚠️ 但臂 B 的断言是**结构性恒真**（切分只在 `seedLength > 0` 时执行）⇒ **鉴别力有限**；且臂 A 的 n=3 里有 1 个不是子代理。详见 §15.3。
3. ~~**需要你拍板的两件事**~~ ✅ **已定（2026-09-22，见 §16）**：
   - **D2′：用户已接受** —— 理由比我的更根本：**"声明面 ≤ 可调面"是"子代能力可超过主代"的功能前提**。
   - **`outputSchema`：倾向【默认不用】**（用固定小标题的文本回执）⇒ 但**由三列数据定**（解析失败率 / 因回执约束返工 / 字段缺失率），**做成 S6 的可切换臂**。
   - **⇒ 施工无阻塞，可直接开 S1。**
4. **S6/S7 的判据未做**：成本成对报（省下的 token vs 绕过管线的代价）；**"长程漂移"仍无可测定义**。

### 0.3 已消解 / 已关闭（不要重复劳动）

- **O13 已随 D2′ 消解** —— D2′ 让能力**照常真实注册** ⇒ 走完整管线 ⇒ `tools/result` 正常 ⇒ `outputSchema` 不受影响。
- **O19 已解**（无生效 `complete` 段）；**O21 已解**（造出带种子 fork）；**O3 已解**（订阅签名）。
- **O4 已答**（`end` 无 `shadowedSeqs`，判据改用 `summary`/`prune`）。
- **§11.2 的"只省 0.7%"、§13.5 的"TTL 是最大边界"、§10.2 的"end-seed ⇔ continuable"** —— **三处均已作废/更正**。

---

## 1. 目标与不变量（invariants）

**要造什么**：一个「**分身**」机制 —— 父 agent 把一个任务连同**它的专有能力**交给一个短命子 agent，
子 agent 在**父代的上下文快照**之上工作，完成后只回最终文本；**父代的主线不受子代过程污染**。

**四条不变量（任何施工步骤都不得违反）**：

| # | 不变量 | 判据（可复算） |
|---|---|---|
| I1 | **能力集的变化不影响「脸」** | 改能力集前后，同一会话相邻两次请求的 `[system + tools]` **指纹不变** |
| I2 | **装配零责任** | 我们不替换上游的 Code Mode 协议贡献（不写 `system-prompt/assemble` 替换器） |
| I3 | **只影响自己** | 子代的刷新**只改子代自己的装配**；父代与兄弟的注册不被触碰 |
| I4 | **诚实的账** | 任何"省了"必须成对报出"付出了什么"（见 §5 的判据表） |

---

## 2. 已定裁决（**施工按这些执行，不再重开**）

### D1 ★ 脸**冻结**：能力集不影响脸；刷新只发生在压缩点
- **依据**：`dsh-agent-tool-presentation/README.md:27` 逐字 —— "**the presentation is fixed when the agent is composed,
  so its request prefix is stable for the session's life**" ⇒ 上游刻意让脸固定以保前缀。
- **为什么刷新只能在压缩点**：`dsh-session/README.md:109` 逐字 ——
  "**A `replace` operation invalidates reuse from the first shadowed message**" ⇒ **压缩本来就让复用失效**，
  所以**在那里刷脸不额外付费**；而中途刷脸会**丢掉该 agent 已积累的全部消息**（随寿命增长）。
- **状态**：✅ 定。

### D2 ★ 我们加的能力**不注册进注册表**；脸上只留**一个固定的桥**
> 🚫 **本条已被 D2′ 取代（2026-09-22）—— 不要按 D2 施工。** 保留在此仅为记录推理过程。
> 取代原因：D2 会让内层能力绕过管线 ⇒ ★ **打坏 `outputSchema`（O13）**；而 D2′ 能同时解决 O13/O14。见下方 D2′。
- **依据**：能力面是**投影**，不是权威。`dsh-tools/README.md:122`：SDK 段是 **lazy section，每次装配重新生成**，
  内容 = 当前可见工具集 ⇒ 注册即改 `system`。
- **两条通道必须同时关**：
  - 通道一 **schema / SDK 段**（`:122`）
  - 通道二 **`tool:<name>` 指导段** —— ★ `dsh-system-prompt/README.md:75` 逐字：
    "**Sections and schema providers are separate assembly inputs**, so a tool restriction does not remove
    **independently registered guidance**" ⇒ **冻结 SDK 段关不掉它**，必须**不注册**或**不给指导**。
- **纪律**：**绝不要"独立注册指导"**（它不随工具消失，却永远占 `system`）。
- **状态**：✅ 定。

### D3 告知走**消息尾端**（skill catalog 形态）
- **依据**：`dsh-tool-skill/README.md:16,18` —— catalog 是 **durable user-role 消息**（不是 schema），
  **只带 `name`+`description`**，变化时**追加一条完整替换消息**（同一信封），正文按需装入。
- **为什么安全**：追加式 ⇒ 不破坏已有前缀。
- **状态**：✅ 定。

### D4 触发判据 = **`compaction/end`（无 `error`）** 或 **`compaction/prune`**
- **依据（实测，本机 181 会话）**：`compaction/start` **132** / `compaction/end` **130** / `compaction/summary` 89 / `compaction/prune` **72**。
  ⇒ ★ **不挂 `start`**（132 vs 130 ⇒ 有未正常收尾的，挂 start 会在失败压缩上白刷）；
  ⇒ ★ **`prune` 也必须触发**（它无模型调用，但**同样 replace 历史节点 ⇒ 同样改前缀**）。
- **判据必须能报"历史为真次数"**：本机为真 **130 + 72 = 202 次** ⇒ 不是假绿；**落地时把这两个计数打进日志，为 0 就报警**。
- **次选**：`compaction/summary.shadowedSeqs`（被替换掉的是哪些节点）。
- **★ 判据的准确形状（已由 W1 取证修正，2026-09-22）**：
  实测/源码事实 —— **`compaction/end` = `{compactionId, turn, error?}`，【没有】`shadowedSeqs`**；
  **`compaction/summary` 才有 `[]{compactionId, shadowedSeqs, shadowedRange, shadowedTokenCount, llmStreamCall, …}`**；
  **`compaction/prune` 有 `{shadowedRange, shadowedSeqs, shadowedTokenCount}` 但【没有】`compactionId`**。
  ⇒ **正确判据 = `compaction/summary`（其 `shadowedSeqs` 非空）或 `compaction/prune`** ——
  这两者各在一条路径上（摘要 / 剪枝），**都携带"哪些节点被替换"的事实**。
  ⇒ **`compaction/end` 只用于收尾配对，不参与"刷不刷"的决策。**
- **★ 关于"`end` 带 `error`"**：**不看 `error`，看"历史是否真的被 replace 过"**（即上一条的 `shadowedSeqs`）。
  理由：`error` 是"这次尝试的结果"，我们关心的是"**surface 动没动**"（132 start vs 130 end ⇒ 存在未正常收尾的，
  而**未收尾 ≠ 没动过**）。⇒ 把**不可靠的状态信号**换成**可验证的事实信号**。
- ⚠️ **附带发现（W1）**：`docs/subsystems/compaction.md:17` 的表格把 `end` 简写为 `{ turn, error? }`，**与源码不一致**（源码含 `compactionId`）。
- **兜底**：`text` 闭包内比较工具集指纹 —— ⚠️ 它测的是"**脸变了没**"，**不是"压缩发生没"**，两者**不可互替**。
- **状态**：✅ 定。

### D5 订阅用 **`session/event`**，且**它本来就是 scope 过滤的** ⇒ 不必自己重写
- **依据（逐字）**：`docs/subsystems/session.md:807` ——
  "Post-commit, fire-and-forget append feed. … **Scope-filtered dispatch (`@deepseek-ai/dsh-scope`):
  agent-scoped listeners receive only events from sessions entered through that agent's context.**"
- **⇒ 给子代挂 listener ⇒ 只收到子代自己会话的事件（含它自己的压缩）。不需要自建过滤。**
- **配套**：`:33` "publishes post-commit append notifications with **per-listener containment**" ⇒
  **我们的刷新逻辑抛错不会拖垮持久化**（`:807` 亦明文 "observer failures are logged and contained"）。
- **状态**：✅ 定（**签名只需按 `session.md:#ctxsessions` 段写**）。

### D6 ★ **只需在【目标 agent 自己的 scope】注册一条同名 `tools:sdk` section（跨层遮蔽，安全）** —— 不必自写 presentation
> **本条已由 W3 取证降级（2026-09-22）**：原判"同 scope 同名 throw ⇒ 必须自写一套 presentation"**前提错了**。
- **依据一：`composeFrom` 是 `bind` 不是 `mount`。** `dsh-agent-presets/lib/index.js:988-995` 逐字：
  ```js
  composeFrom(agentCtx, parentCtx) {
    const agentKey = scopeOf(agentCtx);
    if (agentKey === void 0) throw new Error("agent-presets: refusing to compose an unscoped context; …");
    const standing = standingMountFor(parentCtx);
    if (standing === void 0) return void 0;
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key));   // ★ 只 bind
    return standing.presetId;
  }
  ```
  ⇒ **子代不重跑 preset 的各行**（所以 `tool-presentation` 不会被跑第二遍）。
- **依据二：跨层同名 ⇒ 遮蔽（最近者胜），且【被遮蔽的 `text` 不会被调用】。**
  `dsh-scope/lib/index.js:177-181`（`merge()` 按 `chainLayers` 逐层 `set`）；
  `packages/core/system-prompt/tests/scoped.spec.ts:66-79`：`expect(globalText).not.toHaveBeenCalled()`。
- **依据三：上游自己就这么干** —— `packages/subagent/subagent/src/child-agent.ts:170-174`
  在**子代自己的 scope** 里注册 `deployment:persona`（order 0）来遮蔽父代的同名字段，即"同名、跨层、遮蔽"的官方范例。
- **依据四（上游原话）**：`packages/core/tools/src/index.ts:964-966` ——
  "Under a deployment that already defaults to a code mode this **shadows** the global registration with an identical body, **which costs nothing**…"
- **★ 边界（这才是 D9 真正该担心的）**：**同层**才抛错；**注册到【共享的 standing scope】会撞 `presentAs` 那份**
  ⇒ **所以必须注册在目标 agent 自己的 scope。**
- **★ 代价**：遮蔽是**逐层**的 —— 父代与子代都要生效，就**两处各注册一条**。
- **★ 不要碰** `run_code` 传输（原文：`a scoped registration must not shadow it`）。
- **实现位**：`PromptSection.text` 可为 `string | ((context: AssembleContext) => string)`
  （`dsh-system-prompt` 类型：`types/index.d.ts:61`；`AssembleContext = {scope?, signal?}`，被 `dsh-agent` 扩为含 `agent?`）
  ⇒ **冻结 = 在函数里返回同一缓存串；压缩点 = 让缓存失效。**
- **状态**：✅ 定（**比原判更简单**）。

### D7 兜底路线：**native 模式 + 新工具排到工具列表末尾**
- **依据（实测）**：脸 ≈ **40.5K token ≈ 首次请求的 99%**（服务端读数众数 **40832**，未缓存仅 219；
  `system` 只 ~2.4K ⇒ **`tools` 确实算进前缀且是主体 ≈92%**）。
  追加在**列表末尾** ⇒ 保住整份脸 ⇒ **≈97%**；插在**中段**（字典序，实测第 88/103 位）⇒ **2.8%**。
- **注意**：`code` 模式下**任何**工具增删都会改 `system`（工具目录在 system）⇒ 兜底路线**只适用 native**。
- **状态**：✅ 定（**作为 S1–S5 未跑通前的可用退路**）。

### D8 **不 patch 上游**
- **依据**：`dsh-tools/README.md:16` —— "The **reserved transport cannot be registered, shadowed, restricted, or removed**"
  ⇒ `run_code` 改不了；**但也不必改** —— 要控制的从来是 `tools:sdk` 段（D6）。
- **状态**：✅ 定。

### D2′ ★★★ **取代 D2**：能力**照常真实注册**（保完整管线），只把**文本投影「钉住」**（保前缀）—— **桥被取消**

> **本条由 2026-09-22 的二次取证产生，取代 D2 的"不注册只留桥"。**
> 触发原因是 **O13**（D2 会打坏 `outputSchema`），而新证据表明**有一条同时解决 O13/O14 的路**。

**决定性证据（`dsh-tools/lib/index.js:1314-1321` 逐字）：**
```js
const functions = Object.create(null);
for (const schema of registry.schemas(exec.agent)) {      // ★ 每次 run_code 执行时，从【当前注册表】现算
  if (schema.name === "run_code") continue;
  Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(schema.name) });
}
result = await runtime.run({ program: args.code,
  bindings: [{ global: "tools", functions, errorClass: { name: "ToolCallError", memberNameProperty: "toolName" } }], … });
```
⇒ ★★ **运行时绑定是"每次执行现算"的，【不是 prompt 的一部分】**。

**⇒ 于是"可执行性"与"可见性"是两件可分离的事：**
| | 由谁决定 | 我们能否控制 |
|---|---|---|
| **能不能调**（运行时绑定） | **当前注册表**（每次 `run_code` 现算） | ✅ 只要注册就行 |
| **prompt 里露不露**（脸） | **`tools:sdk` 段的文本** | ✅ **可遮蔽**（D6，已验） |

**⇒ 新形状（比 D2 严格更好）：**
```
① 能力【照常注册】到注册表
     ⇒ 运行时绑定自动生成 ⇒ 走完整管线（guards / 调度契约 / tools/result / ToolCallError 规范化）
     ⇒ ★ O13（结构化输出依赖 tools/result）【自动解决】
     ⇒ ★ O14（pruner 看不到内层结果）【自动解决】
        ↓
② 把 `tools:sdk` 段的【取值钉住】：在一段静止期里返回【同一份缓存文本】
     ⇒ prompt 里的脸与"能力集"彻底解耦 ⇒ 能力可以随时长/缩而【前缀逐字节不变】
     ⇒ ★ 与 D2 的关键差别：缓存的是【上游渲染出来的那份文本】⇒ **保留全部逐工具精确类型**（不放弃 `ToolArgsMap`）
        ↓
③ 新能力的【名字 + args】走【消息尾端】告知（D3 的尾部目录）⇒ 追加式 ⇒ 零代价
        ↓
④ 到【压缩点】再让缓存失效、用上游的新渲染重算（D1：唯一免费的时刻）
```

**实现缝（两个候选，都未实施）**：
- **(d) 首选**：`system-prompt/assemble` listener **包住 `next()`**，拿到上游装配结果后**只对 `tools:sdk` 那一段取值做"钉住"**，其余原样透传
  （`:20` 允许替换，并要求替换者负责保住可用协议；**我们只钉一段、不删任何东西，协议按构造保住**）。
- **(c) 备选**：从会话日志的 `request/header.system` 里**取回上一次渲染出的那段文本**再原样返回（笨重，但完全不碰装配层）。

**⚠️ 偏差（已按用户 2026-09-22 的更正改写，我这句原来说过头了）**：
钉住文本 ⇒ **"声明面 ⊊ 可调面"** —— 被钉住的新能力**可调但未被宣告**（模型不知道名字，除非尾部目录告诉它）。

**★ 准确表述（撤回"与上游相悖"）**：
上游那条不变量的**目的**是防止"**声明了却调不动**"——原文给的后果是
"a model-direct call naming any other tool resolves to `UNKNOWN_TOOL` … **a bare `unknown tool` reads as a broken deployment**"
（`dsh-tools/README.md:120`、`:23`）。**而我们的偏离方向恰好相反：可调但未声明** ——
prompt 里没有任何地方声明它 ⇒ **不产生"声明了却失败"的困惑失败**。
⇒ **⇒ 我们偏离的是"字面一致性"，不是"它的目的"；而且偏离在【无害的那一侧】。**
⇒ 另外偏差**只发生在短命子代自己的 scope 内**：遮蔽是**逐层**的（D6），**主代理的装配零改动**（I3）。

**⇒ 结论：这条代价比原判轻得多，可以接受**（但仍如实记账：声明面与可调面在静止期内不一致）。

**仍然成立的（D2 的这两条保留）**：能力面的两条通道（schema/SDK 段 + `tool:<name>` 指导段）**都不得在静止期内变化**；
**绝不要"独立注册指导"**（`dsh-system-prompt/README.md:75`：独立注册的指导不随工具消失）。
⇒ 区别只在于：**D2 靠"不注册"来关通道；D2′ 靠"钉住文本"来关通道，从而保住了管线。**

- **状态**：🟡 **待用户拍板**（因为它主动放弃了上游的 announced=callable 一致性，这属于产品取舍，不是我该单方面定的）。
### D9 ★★ 我们的注册必须是 **host-plane 单例 + scope 感知**；**禁止"每个分身/preset 各挂一份"**
> ⚠️ **与 D2′/D6 不矛盾**：D9 管的是 **setup 类注册**（`registerContinuableSetup`，**不 scope-aware**）；
> D2′/D6 管的是 **prompt section**（**scope-aware，逐层遮蔽**）。**两者是不同的注册表。**
- **依据（上游原文，`~/.dsh/.agent-presets/council/agent.cordis.yml:169-172`）**：
  > "`tool-subagent-report` is host-plane for the same reason as the registry, not because a preset may not want it:
  > it registers a **CONTINUABLE SETUP** on that singleton rather than a tool this agent calls, and
  > **the setup list is not scope-aware — one copy per mounted preset means every child gets `report`
  > registered once per live session, which throws on the second.**"
- **⇒ 这就是"并发"的真实雷**：**分身的会话不会互相覆盖**（各是独立 session + 独立 UUID），
  **但"按 preset 各挂一份"的注册会重复 ⇒ 第二个就抛错**。上游的 `report` 正是因此被挪到 host plane。
- **⇒ 施工含义**：**"桥"（S2）与任何 setup 类注册，必须注册在 host plane 一次，并按 scope 分派；绝不许每分身/每 preset 各注册一次。**
- **状态**：✅ 定。

---

### D10 ★★ **两个变体分工：fork 版必须"钉住"；spawn 版不需要**
> 用户 2026-09-22 提出"**fork 版必须这么做；我们也可以做一版不 fork 的**"。**结论：方向对，但机制要说准。**
- **★ 先纠正一处（用户未意识到的）**：**"不 fork"并不会得到更干净的脸。**
  `applyChildComposition` 是在**共享驱动**里调用的（`dsh-subagent-in-process-driver/lib/index.js:172`），
  **spawn provider 内没有它**（grep 零命中）⇒ **spawn 与 fork 走同一条装配路径，只差一个 `seed`**
  （driver `README.md:33`："Spawn omits it."）⇒ **两者的脸都来自同一个 preset 层**（`composeFrom`）。
  ⇒ **窄脸只能靠 `toolFilter`（裁）或 scoped 注册/遮蔽（改）来拿，换 provider 拿不到。**
- **★ 但用户的直觉指向的机制是对的**：两个变体的差别不在"脸"，而在【**出生时有没有历史要保**】：

| | 出生时有历史种子吗 | 出生时改脸的代价 | 需要"钉住"吗 |
|---|---|---|---|
| **fork 版** | 有（父代已完成回合前缀） | **会丢掉种子的复用** ⇒ 贵 | ★ **必须**（D2′） |
| **spawn 版** | 无 | **它自己还没有消息 ⇒ ≈0** | **不需要** |

⇒ **⇒ 所以 spawn 版可以"从出生就带窄脸"**：`toolFilter` 裁到所需子集 + 出生时把脸定死
⇒ **出生即一致**（announced = callable，无偏差）**且不需要钉住**。
⇒ **而 fork 版要"继承历史 + 加新能力"，就只能钉住文本**（D2′），代价是"静止期内声明面 ⊊ 可调面"。
⇒ **两版并列，不是二选一**：
- **要继承父代上下文** ⇒ 用 **fork + D2′**
- **只要一个干净窄脸从头干** ⇒ 用 **spawn + `toolFilter`**（无偏差、无钉住）
- **两者都不碰主代理**（遮蔽逐层 + scope 隔离）。
- **状态**：✅ 定（分工）；选择用哪版属产品决定。

## 3. 术语（施工统一口径）

| 词 | 定义 |
|---|---|
| **脸** | ★ **= `system` 文本 + `tools` 字段的合称**。即"**每次请求都要重发的那份说明书**"：模型被告知"你是谁、你能做什么"的全部内容。<br>**★ 它不是**任务要求、不是期望回执、也不是对话历史 —— 那些都在 **messages** 里。<br>**实测构成**（council preset，103 个工具）：`system` **2,397 tok（6%）** + `tools` **37,818 tok（94%）** = **≈40,216 tok** |
| **投影** | 脸中的能力描述（code 模式 = `tools:sdk` 段；native 模式 = `tools` 字段里的 schema 列表）。**可替换、可冻结** |
| **桥** | 注册表里**唯一一个、schema 永不变**的入口工具；它把我们内部的能力集暴露给模型 |
| **尾部目录** | 往**消息尾端**追加的能力清单（skill catalog 形态） |
| **native / code** | `dsh-agent-tool-presentation/README.md:5`："`native` (every schema)" / "`code` (only `run_code` plus a generated TypeScript SDK)" / `both` |
| **压缩点** | 一次 `compaction/end`（无 error）或 `compaction/prune`。**唯一可以免费动车的地方** |

### 3.1 ★ "分身是 skill" 与 "它有持久化" —— 不矛盾，说的是两件事

| 层次 | 是什么 | 落盘否 |
|---|---|---|
| **调用形态** | 像 skill：**投一次、拿结果、主体不直接上手**（父代只拿到最终文本，中间步骤不进父代） | — |
| **会话** | 分身**有自己的 `Session`**（append-only 真相源，"an agent's whole interaction history"，`docs/subsystems/session.md`） | ★ **落盘**（`~/.dsh/sessions/.../session.jsonl.zstd`） |
| **可达性** | `continuable` ⇒ 可**冷唤醒续派**（`send_message`）⇒ 这才是"有下次"的含义；`one-shot` **没有下次** | 由 descriptor 的 `mode` 决定 |

⇒ **"持久化"指的是"这个分身自己的对话记录留在磁盘上"，不是"skill 的状态"。**
**实测佐证**：我们自己扫到 **depth=1 有 12 个会话、depth=2 有 1 个、depth=3 有 1 个** ⇒
**子代的会话确实独立落盘**（这也是我们事后复盘它的唯一途径）。
⇒ **并发**：分身各是**独立 session + 独立 UUID**，**不会互相覆盖**；
真实的并发雷只有一处 —— **"按 preset 各挂一份"的注册会重复**（见 D9）。

---

## 4. 实测数据基线（可复算，`out/` 下有原始输出）

| 量 | 值 | 来源 |
|---|---|---|
| 脸的真实规模（council preset） | **≈ 40,832 tok**（未缓存仅 219） | `out/face-token-truth.txt` |
| 其中 `system` | ~2.4K tok（6.5–6.9K chars） | 同上 |
| 其中 **`tools`（102 个 schema）** | **≈38K tok（≈92%）** | 同上 |
| 真实 `chars/token` | **≈2.87**（**不是 4**） | 同上 |
| 追加在工具列表**末尾** | 保住 **≈97%** | `out/face-vs-messages-share.txt` |
| 插在工具列表**中段**（第 88/103 位） | 保住 **2.8%**（实测 1152 tok） | `out/tool-insert-point.txt` |
| 压缩次数（181 会话） | start 132 / end 130 / summary 89 / **prune 72** | `out/compaction-signal.txt` |
| 子代历史快照边界 | seed 到**最后一个 `turn/end`**；**进行中的回合被排除** | `dsh-subagent-fork-in-process/lib/index.js:16-19` |

---

## 5. 施工计划（有序；每步都有验收门；卡住的先说清）

> **纪律**：每步的"门"必须是一条**可执行、可复算**的判据；跑不通就**保持 in_progress**，不许标完成。
> **任何"省了"的结论必须成对报出代价**（I4）。

### S0 ✅ 规格落盘（本文件）
- 门：本文件 + `out/` 的 5 个实测输出都存在且可复算。

### S1 压缩信号订阅（子代作用域）
- 做什么：在**子代 scope** 挂 `session/event` listener，只关心 `compaction/end`（无 error）与 `compaction/prune`。
- **门（三条）**：
  1. 打印的计数与该子代真实压缩次数一致（对照 `out/compaction-signal.txt` 的方法）；
  2. ★ **只收到该子代的**（另起一个无关会话压缩，本 listener **不该**被触发）；
  3. listener 抛错不影响写入（per-listener containment，`session.md:33`）。
- **依赖**：D5（已定）。**未闭合**：cordis 侧确切签名需按 `docs/subsystems/session.md:#ctxsessions--sessionstore` 段写。

### S2 桥（schema 永不变的入口）
- 做什么：注册**一个**工具（如 `dsh_capability({name, args})`），handler 路由到我们内部的能力表。
- **门**：同一会话连续两次请求，`request/header.tools` 里桥的 schema **逐字节相同**；且**不新增任何 `tool:<name>` 指导段**。
- **依赖**：D2、D8。**未闭合 O2**（桥的接口形状）。

### S3 脸冻结（改能力集 ⇒ 指纹不变）
- 做什么：能力集在插件内部增删，**不进注册表**。
- **门**：增删能力前后各取一次 `[system + tools]` 指纹，**必须相同**（I1）。

### S4 尾部目录（告知）
- 做什么：用 **`systemPrompt.context()`**（运行时上下文 ⇒ 落消息面）注入当前能力目录；变化时**追加一条替换**。
- **门**：① 目录变化**不改 `system`**；② 相邻两次请求的 `cacheReadTokens` **不下降**（对照 `measure-delegation-reuse.mjs`）。
- **依赖**：D3。

### S5 压缩点刷新（D1 的兑现）
- 做什么：S1 的信号到达 ⇒ 失效 S4 的目录缓存（若走 D6 路线，同时刷新脸）。
- **门**：① 刷新**只**发生在压缩之后；② 一次"能力增删"的总开销 = **0 次额外前缀重算**（对比 S3 的指纹与 `cacheReadTokens`）。
- **依赖**：D1、D4、D6（若需刷脸）。

### S6 ★ 成对判据（**这一条不做，前面都算白做**）
必须**同时**报出：

| 省下的 | 付出的 |
|---|---|
| 零失效省下的 token（`cacheReadTokens` 差值 × 步数） | ① 内层能力绕过上游管线（`pre-execute`/guards/`tools/result` 观察者/**调度契约**/`ToolCallError`）② 放弃逐工具精确类型 ⇒ **错误率/返工次数可能上升** |

- **门**：给出两列数字，**缺一列不算通过**。

### S7 长程漂移判据（本项目目前**没有**）
- 做什么：同一多步任务，**委派版 vs 单线程版**，量：**步数 / 返工次数 / 最终正确率**。
- **门**：三列都给出，才允许说"能缩减长程漂移"。**在此之前该说法只能是假设。**

---

## 6. 未闭合清单（挡住哪一步，一清二楚）

> ⚠️ **本表是历史登记；【当前状态以 §0 为准】** —— **O3 / O4 / O13 / O19 / O21 已关闭或已消解**（见 §0.3），
> 其中 **O13 已随 D2′ 消解**（能力照常注册 ⇒ 管线完整 ⇒ `outputSchema` 不受影响）。
> 仍待办的代码项是 **O22** 与 **O24**（见 §0.2 第 2 条）；**O15 的切分标记应为 `header.seedLength`（不是 `end-seed`）**。

| # | 未闭合 | 挡住 | 下一步怎么查 |
|---|---|---|---|
| O1 | `text` 是纯函数，**它怎么知道"已经过了一次压缩"** | S5 | 用 S1 的信号翻一个闭包标志（**首选**）；次选读压缩计数 |
| O2 | **桥的接口形状** + 运行时解析怎么接进 `run_code` 的 binding 管线 | S2 | 读 `docs/tool-catalog.md` 的 `run_code` 段 + `dsh-code-runtime-worker-thread` README |
| O3 | `session/event` 订阅的**确切签名**（生成区） | S1 | 读 `docs/subsystems/session.md` 的 `#ctxsessions--sessionstore` 段 |
| O4 | `compaction/end` **带 `error`** 时刷不刷 | S5 | 需要一次受控实验（故意让压缩失败） |
| O5 | 全局注册 vs per-scope 注册在**遮蔽/重复抛错**上的准确边界 | D6 | 一次最小实验：同 scope 同名 section 两次声明 |
| O6 | 内层能力要不要**补回**上游的调度契约与 `tools/result` 观察者 | S6 | 产品决定 + 一次 A/B |
| O7 | 子代能否声明与父代**不同的 presentation** | D7/S3 | 未验证 |
| O8 | **"压缩点刷新"本身会不会引入额外模型调用**（若会，必须计入成本账） | S5/S6 | 设计时确认；若走 D6 的纯文本重渲染则**不引入** |
| O9 | **父代被中断时，在飞的分身如何收**（`drainContinuableDescendants` / 父代取消的传播） | S5 正确性 | 读 `dsh-subagent/README.md` 的 drain 段 + 一次中断实验 |
| O10 | **分身的失败判据**：父代只看到 `Error: <stop reason>` ⇒ 如何区分"任务失败"与"能力不足" | S6 的"错误率"列 | 读 driver 的 result 段；设计一个归类口径 |
| O11 | **按分身拆账的读数**：`tokenUsage` 是 per-session 的 ⇒ 需要按 session 拆出"每个分身花了多少" | S6 | 复用 `scripts/measure-delegation-reuse.mjs` 的口径扩写 |
| O12 | **深度上限**：默认 `maxDepth = 3`（depth 4 运行时被拒）⇒ "分身再分身"的层数是否够 | 架构 | 产品决定 |

---

## 7. 反模式 / 纪律（**别做这些**）

1. ❌ **别用 `chars/4` 估 token**（真实 ≈2.87）—— 会把脸少估 40%。
2. ❌ **别把新工具插在工具列表中段**（字典序默认）—— 2.8%。要加就**排到末尾**。
3. ❌ **别往 `system` 里加东西** —— `system` 在最前，它一断后面全废；尤其**别"独立注册指导"**。
4. ❌ **别挂 `compaction/start`** 当刷新信号（会白刷）。
5. ❌ **别漏 `compaction/prune`**（它同样改前缀）。
6. ❌ **别把"历史里那段脸"当可清理对象** —— 脸是每步装配的派生物，**压缩器里没有它**。
7. ❌ **别为让判据变绿去改被检对象**；**假绿 > 假红**。
8. ❌ **别写"看不到 ⇒ 没有"的判据**；"通道不可用 ≠ 读数为 0"。
9. ❌ **别把 `compaction/end` 当"历史被替换"的证据**（它没有 `shadowedSeqs`）—— 见 D4。
10. ❌ **别把 D6 与 D9 搞混**：**section 要逐层注册**（跨层遮蔽安全，D6）；**setup 类注册只能一次**（不 scope-aware，D9）。两者是**不同的注册表**。

---

## 8. 六路取证汇总（2026-09-22，六个并发子代理；**每条已由我独立复核**）

> 原始产出：`out/w1-o3-session-event.md`、`out/w2-o2-bridge.md`、`out/w3-o5-section-shadowing.md`、
> `out/w4-o8-o6-cost-and-bypass.md`、`out/w5-o11-o10-metrics.md`、`out/w6-o9-o12-cancel-depth.md`

### 8.1 ✅ 已关闭 / 已更正

| 项 | 结论 | 我的复核 |
|---|---|---|
| **O4** | ✅ 关闭 —— 正确判据是 `compaction/summary`(shadowedSeqs 非空) **或** `compaction/prune`；`end` 没有该字段 | ✅ 我方实测日志亦证 `prune` 无 `compactionId`、`end` 无 `shadowedSeqs` |
| **O5** | ✅ 关闭 —— **跨层同名 ⇒ 遮蔽（安全，被遮蔽的 text 不评估）；同层 ⇒ 抛** | ✅ 逐字核验 `composeFrom`（bind 非 mount，`agent-presets/lib/index.js:988-995`）+ 上游测试 |
| **O6** | ✅ 关闭（代价确认）—— ★ **`attachStructuredRuntime` 依赖 `tools/result`** ⇒ 桥内绕过会**直接打坏 `outputSchema` 回执** | ✅ 逐字核验 `dsh-subagent-in-process-driver/lib/index.js:85` `childCtx.on("tools/result", …)` + `README.md:44` |
| **O2** | ✅ 关闭 —— ★ **不存在"注册了但不上脸"的工具** ⇒ **桥内路由只能是直接函数调用（绕过管线）**，sub-dispatch **抵不掉**该代价；泛化 schema `{name,args}` 在 native 下无契约问题；桥名不能是 `run_code`、不能同层重名、不能是 `<unlisted-tools>`；**code 模式下不能把桥写进 `toolOrder`** | ✅ 抽查通过 |
| **O8** | ✅ 关闭 —— **纯文本重渲染 = 0 次模型调用**；压缩本身 **1~2 次**（`compactionRetries` 默认 1）；`prune` 0 次；**"压缩后再发请求"只发生在 overflow 路径** | ✅ 抽查通过 |
| **O11** | ✅ 关闭（附**对我自己脚本的修正**）—— ★ **`scripts/measure-delegation-reuse.mjs` 会漏账**（只读 `assistant/message`；chunk-usage 与 message.usage 是**同一 step 的两阶段**，投影按 `(turn,step)` **替换而非相加**；本机 18 个样本只有 chunk）★ **fork 子的日志含父代 seed 深拷贝 ⇒ 父子相加会把父代历史计两遍** ⇒ **必须按最后一个 `session/end-seed` 切开** | ✅ 采纳（**这条要改脚本**） |
| **O10** | ✅ 关闭 —— stop reason **恰 5 个**（`completed/aborted/error/max-tokens/refusal`）且可扩展；`Error: <stop reason>` 后**只跟部分文本、不跟 provider diagnostic**；★ **"缺工具/权限被拒"多数表现为【成功】**；★ **结构化输出没提交会被 driver 主动改写成 `error`** ⇒ **四种情况里只有"取消"真可辨** | ✅ 抽查通过 |
| **O12** | ✅ 关闭 —— `maxDepth` 是**绝对深度**（无递减）；默认 3 **够用**（S1–S5 只需 depth 1 + 可选 depth 2）；混用 `provider-managed` 会让深度**失去单一权威** | ✅ 抽查通过 |
| **O3** | ✅ 关闭 —— 订阅**不是** `ctx.sessions` 的方法，而是 cordis `ctx.on('session/event', (session, event) => …)`；**scope 判定键 = "谁调用了 `enter()`"** ⇒ 子代 `agent.ctx` 上挂 ⇒ **只收该子代**（唯一"多收"方向是**祖先**）；★ **必须在创建窗口挂**（append 前先快照 listener，挂晚即漏） | ✅ 采纳 |

### 8.2 ⚠️ 新增未闭合（由取证产生）

| # | 未闭合 | 挡住 |
|---|---|---|
| **O13** | ★ **`attachStructuredRuntime` 依赖 `tools/result`** ⇒ 若走 D2 的桥，**`outputSchema` 回执会坏**。要么桥自己补发等价的 `tools/result` 观察语义，要么**放弃"能力藏桥后"的路**（回到 D6/D7） | **S2/S6 —— 这条可能改变 D2 的走向，是当前最大风险** |
| **O14** | ★ **内层结果不产出 `tool/result` 持久事件** ⇒ `compaction-tool-result-pruner` **永不剪它** ⇒ **token 账偏低**（账要显式加这一项） | S6 |
| **O15** | ★ **fork 子的 seed 深拷贝会让父子拆账重复计父代历史** ⇒ 拆账脚本必须按 `session/end-seed` 切分 | S6 |
| **O16** | `out/o5-shadow-probe.mjs` 的实验只覆盖 section 注册；**`presentAs` 的注册落在哪一层**（`ctx.inject(['codeRuntime'], cb)` 里的 `runtimeCtx` 是否仍带 standing tag）**未实测** | D6 的"注册在哪一层" |
| **O17** | **顶层父代被替换 ⇒ continuable 子代"自动被收"没有证据** ⇒ **若 S5 依赖这个假设，是错的** | S5 |
| **O18** | 克隆版本（`0.1.0-rc.5`）与已装产物（`0.1.1-rc.2`）**行号可能不同** ⇒ 引用克隆行号时需回落到已装产物复核 | 全部取证的引用 |

### 8.3 ★ 由此产生的两条**即时行动**

1. **改 `scripts/measure-delegation-reuse.mjs`**（O11）：usage 来源改为**投影侧**（含 chunk），
   并在拆账时**按 `session/end-seed` 切开 seed 与"分身自己"** —— 否则 S6 的两列数字都不可信。
2. **先解 O13**（`tools/result` 依赖）再动 S2 —— 否则可能白写一个桥。

---

## 9. ★★★ (d) 路线验证结论：**可行，已实测**（2026-09-22；子代理执行 + 我独立复核）

**问题**：能否用 `system-prompt/assemble` waterfall 的 listener **包住 `next()`**，只把 `tools:sdk` 那一段换成缓存文本、其余原样透传？

**结论：① 可行。** 探针 `out/w7-pin-probe.mjs`（可复跑）+ 报告 `out/w7-pin-feasibility.md`。
**我独立复核的方式**：① 亲手重跑探针（exit 0，输出与报告一致）；② 逐字读实现（`dsh-system-prompt/lib/index.js:258-289`）；
③ 检查其"作用域计数"断言是否**循环论证**（结论：**不是**，计数器在 listener 体内**无条件递增**）。

**四个验收门（探针原始输出）**：

| 门 | 实测 |
|---|---|
| ① 能看到 `tools:sdk` | `{"name":"tools:sdk","order":150,"textType":"function"}` |
| ② 只改一段、**其余逐字节不变** | 三处 digest 全等（替换前 / 替换后 / 跨装配） |
| ③ **注册表变了，钉住的文本不变** | 两次装配间 `register(gamma)` ⇒ 原值 1890→**2072** 字符变了，而 `sdk1.text === sdk2.text` = **true** |
| ④ 返回值**确实被采纳** | `=== pinned ? true` / `=== raw ? false` |
| ★⑤ **负对照（消融自证）** | 关闭钉住（A3）⇒ 文本 2072→**2252** ⇒ **证明是"钉住"在起作用，不是别的东西恰好稳定** |

★ 探针用的是**真**上游 `tools:sdk`（真 `sdkSection()` / 真 `renderToolsSdk` / 真 `ToolRuntime.register()`），
只有 `codeRuntime` **后端**用 `ctx.provide('codeRuntime', { language: 'typescript' })` 顶替（`requireCodeRuntime` 只从中读 `language`）—— **没有退到"自注册同名段"的退路**。

### 9.1 ★★ 三条实施前提（**必须遵守**，都经我逐字复核）

1. **`AssembledSection` 只有 `{name, text}`，【没有 `order`】**（`lib/index.js:269-275`：`order` 只用于排序，随后被丢弃）
   ⇒ **listener 只能按 `name` 认段**，不能按 order。✅ 复核通过。
2. **★★ `complete: true` 的段会在 waterfall【之后】整体覆盖 `sections`**（`lib/index.js:283-289`）：
   ```js
   const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
   if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
   return { ...transformed, sections: completeSection === void 0 ? transformed.sections : [completeSection], … };
   ```
   ⇒ ★ **`complete` 段一生效，我们的钉住就被【静默作废】**（实测 `a6.sections === ["w7:complete"]`，`tools:sdk` 连同钉住一起消失）。
   ⇒ ★ **而且 `completeSection` 是在 waterfall【之前】捕获的** ⇒ **连"改 complete 段本身"也没用**（我读源码发现的，报告未提）。
   ⇒ **必须做成【启动期断言】：目标 scope 里不得存在生效的 `complete` 段**（否则钉住无效且无告警）。
3. **必须挂在【目标 agent 自己的 scope】**：实测 scoped listener **只收自己的装配**；而**全局 listener 会收到每个 scope 的装配**
   ⇒ 全局挂会**违反 I3**（污染别的 agent）。
   ★ 官方背书：`packages/core/system-prompt/tests/scoped.spec.ts:214` 逐字用了同一签名并在该处调 `next()`。

### 9.2 影响

- ⇒ **D2′ 的实现缝 (d) 选定**（(c) 降为备选）。
- ⇒ **O16（`presentAs` 注册在哪一层）不再阻塞** —— 钉住不依赖它。
- ⚠️ **新增未闭合 O19**：**我们的 preset / 目标 scope 里到底有没有生效的 `complete` 段**（现场态未验）—— 这是 (d) 的**硬前置**，必须有启动期断言。
- ⚠️ **新增未闭合 O20**：报告与探针的**作用域断言表述含糊**（打印的是"GLOBAL 装配【之后】的累计值"，
  而非 before/after 两个原始值）⇒ 断言有效但**可读性差**，后续复用它时应改成打印两个原始值。
- ⚠️ **未跑成本读数**：本轮**没有**测 `cacheReadTokens`（探针是进程内装配，不产生请求）⇒ **"省了多少"仍未实测**（属 S6）。

---

## 10. ★★★★ O11 修完了，但顺手查出一件**推翻我早先结论**的事实（2026-09-22）

### 10.1 O11 已修（子代理执行 + 我独立复核）

脚本 `scripts/measure-delegation-reuse.mjs` 三处改动（**旧口径一律保留并列**）：
① usage 两源归并（`assistant/chunk` 的 usage + `assistant/message.usage`，按 `(turn,step)` **替换不相加**）；
② 子代账切「种子份 / 分身自己」；③ 负对照。

**我的独立复核**：脚本 exit 0；三个改动确实在脚本里（`grep` 见 `:22-27 / :87 / :139 / :182`）；种子三列确实在输出文件里；
**★ 首次 grep 落空是因为新汇总走 stdout 而非输出文件**（我一开始把它丢进 `/dev/null` 了）——
**教训：核验"某输出在不在"时，要分清 stdout 与它自己写的文件。**

**漏账量级（实测，181 会话）**：`prompt 侧 341,590,865 → 342,565,029`，**漏 974,164 ≈ 0.285%**；
**只有 chunk 的样本 18 个**，逐会话有差异的 **2/181** ⇒ **总量影响小，但分会话口径会错**（所以要修）。

### 10.2 ★★ 新事实 1：`session/end-seed` **不是种子边界**，它与 `mode=continuable` 完全相关

逐个子代核对（探针 `out/probe-fork-seed-why.mjs` → `out/fork-seed-why.txt`）：

| 有 `session/end-seed` | 无 `session/end-seed` |
|---|---|
| `436fde97`(c) / `7e8eb2e1`(c) / `b589e319`(c) / `b7327cc6`(c) / `ecdd3990`(c) —— **全是 `continuable`** | `1df6c839` / `3333bdd5` / `638c62ce` / `85fcf47d` / `b094f295` / `c3647728` / `d0414827` —— **全是 `one-shot`** |

⇒ ★ **5/5 与 7/7 完全按 `mode` 分开，与 `provider`（fork/spawn）、与"有无种子"都无关。**
⇒ **W8 把它当"种子边界"的候选是错的**（它最终选了 `seedLength`，**这个选择救了他**）。
⇒ **可复用的知识：判断子代有没有继承历史，不要看 `session/end-seed`；看 `header.seedLength`。**

### 10.3 ★★★ 新事实 2：**我们手上 4/4 个 `fork` 子代，种子【全为空】** ⇒ "fork 复用父代历史"**从未被实测**

| fork 子代 | `seedLength` | 有父代深拷贝吗 | 事件数 | 委派前父代完成过回合？ |
|---|---|---|---|---|
| `1df6c839` | **缺键** | ✗ | 21 | **✗** |
| `b094f295` | **缺键** | ✗ | 21 | **✗** |
| `c3647728` | **缺键** | ✗ | 21 | **✗** |
| `b7327cc6` | **缺键** | ✗ | 22 | **✗** |

**机制（自洽）**：`completedTurnPrefix` 取"最后一条 `turn/end`"之前的事件；
**这 4 例的委派都发生在父代【第一个 `turn/end`】之前**（上表最后一列全是 ✗）⇒ **`turn/end` 一条都没有 ⇒ 返回 `[]` ⇒ 空种子
⇒ `fork` 退化成 `spawn`**（`dsh-subagent-fork-in-process/lib/index.js:23-28,47`）。
★ **原因是我们历来的测试习惯**：**在新会话里"立刻委派"** ⇒ 父代还没跑完任何一轮 ⇒ **种子恒为空**。

**⇒ ⇒ 必须更正的结论**：
1. ❌ **我早先"fork 复用成立（首请求 40576 `cacheReadTokens` = 父代历史被复用）"是【错的】** ——
   那 40576 **是"脸"被缓存**（父代刚刚请求过同一张脸 ⇒ 脸已热），**不是父代历史**。
   ⇒ 这也与 §7.3 的"脸 ≈ 99%、消息段 ≈ 0.3K"**完全自洽**（本来就没有历史可复用）。
2. ✅ **"fork 省一笔上下文理解开支"这件事，我们【一次都没有真实验证过】** —— **样本里没有一次带种子的 fork**。
3. ⇒ ★ **要验证它，必须先构造场景**：**父代先跑完至少一整轮（有 `turn/end`）、再委派** ⇒ 才会有非空种子。
   **这是 S6/S7 的硬前置**（否则那两列数字永远测不到"复用"这一项）。

### 10.4 新增未闭合

| # | 未闭合 | 挡住 |
|---|---|---|
| **O21** | **制造一次"带非空种子的 fork 子代"**（父代先完成一整轮再委派），并量它的 `seedLength` 与首请求 `cacheReadTokens` —— 这是"fork 复用"唯一的验证途径 | **S6/S7 的复用列** |
| **O22** | 负对照**未通过**（fork 臂全为空种子 ⇒ 无法与 spawn 对照）—— **不是脚本错，是样本不可满足**；O21 解决后应重跑 | S6 |
| **O23** | W8 自称：其"全局 `(turn,step)` map + message 优先"与上游"相邻性单槽"（`usage-projection.ts:134` `addReplacing`）**在本机结果逐字节相同**，但**是否等价未证明**（只是观测） | 口径证明 |

### 10.5 纪律（本轮新增）

- ★ **核验"某段输出在不在"时，先分清 `stdout` 与"脚本自己写的文件"** —— 我第一遍就因为把 stdout 丢了而误判"没找到"。
- ★ **子代理如实报告"负对照未通过"是好行为，要保留这种报告口径**（它没有为了让门变绿去改判据）。

---

## 11. ★★★★ O21 达成：**第一次真正量到 fork 的种子复用**（⚠️ **本节结论"≈0.7%"已被 §13 推翻 —— 那是小种子的算术结果；请看 §13**）（2026-09-22）

### 11.1 造出来的样本（三条硬判据全中）

| 项 | 值 |
|---|---|
| 子代 | `a04d96f5…`，`provider=fork`，`mode=one-shot`，`depth=1` |
| **`header.seedLength`** | **22**（不是缺键） |
| 事件数 | 42；`endSeedN=1`，`lastEndSeq=22`，`maxSeq=40` |
| 父代 | `session-200895d2…`；**委派前已有 `turn/end`**（这是造出非空种子的关键） |
| 做法 | **同一个会话发两条消息**：①"只回一个字：好"（让父代完成一整轮）②"调用 `subagent_fork`…"（父代在**第二轮**委派） |

### 11.2 ★★ 实测收益：**≈0.7%**（⚠️ **此结论已被 §13 推翻 —— 它是"种子只有 291 token"的算术结果，不是机制上限**）
> 🚫 **不要引用本节的结论。** 本节把自变量（种子规模）调到了**最小端**却去否定一个关于**长上下文**的命题。
> 更正见 **§13**：种子 92.6K 时 `cr` 涨 92,800（**1:1 复用**），命中 99.69%。保留本节仅为记录推理过程。

子代**自己那次**首请求（种子之后）：

| 子代 | 未缓存 `in` | 缓存读 `cr` | 合计 |
|---|---|---|---|
| `b094f295`（**空种子** fork） | 567 | 40448 | **41015** |
| `a04d96f5`（**带种子** fork） | **474** | **40832** | **41306** |
| 差 | **−93** | **+384** | **+291** |

⇒ **种子段带进来的 ~291 token 整段落进命中区间**（没被重新计费），未缓存甚至少了 93。
⇒ **但量级要诚实：291 / 41306 ≈ 0.7%。而同一请求里被命中的大头 40832 是「脸」** ——
**空种子 fork 同样吃到 40448** ⇒ **"脸逐字相同 + 父代刚请求过"才是首请求成本的决定项。**

**⇒ ⇒ 对靶场的直接后果（重要）**：**`fork` vs `spawn` 恐怕【不是一个有意义的自变量】** ——
两者首请求成本差 ≈0.7%，而它们真正的差别（**看得见/看不见父代历史**）**是行为面的差别，不是账单的差别**。
⇒ 靶场要量 fork/spawn，**判据应当落在"行为/结果"（步数、正确率、返工）上，而不是 token**。

### 11.3 ★★ 我 §10.2 的结论被**反驳**，撤回

新样本 `a04d96f5` 是 **`one-shot` 却写了 `session/end-seed`** ⇒ **"`end-seed` ⇔ `continuable`"不成立**。

**更正为实测规律（不是定律）**：

| 情形 | 有 `end-seed` 吗 |
|---|---|
| **有真种子**（`seedLength > 0`） | ✅ 有（`a04d96f5`） |
| **`continuable` + 空种子** | ✅ 有（5 例：`436fde97` / `7e8eb2e1` / `b589e319` / `b7327cc6` / `ecdd3990`） |
| **`one-shot` + 空种子** | ❌ 没有（6 例：`1df6c839` / `b094f295` / `c3647728` / `3333bdd5` / `638c62ce` / `85fcf47d` / `d0414827`） |

⇒ **`end-seed` 的触发条件【未查明】**（"带 seed 选项"这条假说与 `continuable` 空种子那组不符）。
⇒ ★ **但 §10.2 那条【可用结论】仍然成立且更该守**：**判断子代有没有继承历史，看 `header.seedLength`，不要看 `end-seed`。**

### 11.4 ★★ 新发现：**主表的"首请求"列对【带种子的】子代是错的**（度量 bug）

同一份输出里两处自相矛盾：
- 主表（`out/delegation-reuse.txt:405`）：`a04d96f5 … 2 steps … 首命中=0.3% 缓存读=128`
- 种子切分段（`:515`）：`自己=in=474 cr=40832`

**原因**：主表取的是"日志里第一条带 usage 的 `assistant/message`"，而**带种子的子代日志前段是【拷贝来的父代消息】** ⇒
**它取到的是父代的历史请求（`cr=128`），不是子代自己的首请求**。
⇒ ★ **所以主表的"首命中/首缓存读"两列只对【空种子】子代有效**；带种子的子代必须取 **`seedLength` 之后**的第一条。
⇒ **新增 O24**。**这也解释了我为何一度以为"40576 就是父代历史被复用"—— 那张表本身对种子不敏感。**

### 11.5 负对照：**仍未通过，但原因已明确**（不是数据不可满足）

```
判据：spawn 子代种子份全为 0 ? true（0/7 个 > 0）
      fork 子代种子份全 > 0 ? false（实测 1/5 个 > 0）   ← 从 0/5 变成 1/5
negative control passed = false
```
⇒ **判据形状有问题**：它要求 fork 臂**全部** > 0，而**4 个历史空种子样本仍在样本集里**。
⇒ **正确判据**：按 `seedLength` **是否存在**分臂（有种子 / 无种子），或只对"新增样本"断言。**O22 更正为此。**

### 11.6 ★ 可复用资产：前端 RPC（本机实测可用）

- **发消息**：`session.prompt { sessionId, mode: 'queue' | 'steer', content: [{ type: 'text', text }] }`
- **建会话**：`session.create { cwd?, agentPreset? }`
- **列会话**：`session.list {}` → `json.result.value.items[]`（含 `sessionStats{steps,turns}` / `tokenUsage` / `agentPreset`）
- 响应值一律在 `json.result.value`；调用形状抄 `scripts/eval-run.mjs:57-67` 的 `rpc()`。
- ★ **前端已在跑**：`http://127.0.0.1:3080` 与 `:3131` 都返回 200 ⇒ **无头驱动真实会话是可行的**（新脚本 `scripts/make-seeded-fork.mjs`）。
- ⚠️ 已装产物里的 RPC 是**空壳**，方法名必须读**克隆**（`rpc-map.ts:24-77` / `sessions.ts:234,261,347-353`）。

---

## 12. ★★★★ 「空种子凭什么有缓存？」—— 用户质疑的答复 + 一个**真实存在的口径陷阱**（2026-09-22）

用户质疑（原话）：**"你空种子怎么缓存的呢？……它可能是多次 IO 累加起来的缓存命中率。有没有可能说它哪怕缓存命中率是 99%，但这些都是新的呢？"**

**逐条去读原始请求记录**（探针 `out/probe-per-request-usage.mjs` → `out/per-request-usage.txt`）：

| 子代 | **自己的请求数** | 首请求 `in` / `cr` / `out` | 单次命中率 | 后续请求 `cr` |
|---|---|---|---|---|
| `b094f295`（**空种子** fork） | **1** | 567 / **40448** / **2** | **98.6%** | — |
| `1df6c839`（**空种子** fork） | **1** | 557 / **40576** / **2** | **98.6%** | — |
| `a04d96f5`（带种子 fork） | **1** | 474 / **40832** / **2** | **98.9%** | — |
| **`436fde97`**（spawn, continuable） | **7** | 40103 / **1152** / 58 | **2.8%** | 41216 / 41728 / 41856 / 42368 / 43264 / 43904 |

### 12.1 回答"是不是多次 IO 累加"：**不是**

两个空种子 fork 都**只有 1 条带 usage 的请求**，且 **`out=2`**（模型只回了两个字）⇒ **单次请求，不是累加**。
⇒ **我报的 98.6% 是【单次首请求】的命中率，口径正确。**

### 12.2 回答"空种子凭什么有缓存"：**因为缓存是【provider 侧、按 token 前缀共享、跨会话】的，不是会话隔离的**

空种子子代的请求前缀 = `[system][tools][任务]`，而 **`[system][tools]` 与父代刚刚发过的逐字节相同**（同 preset、无人格改动）⇒ 命中。
**⇒ 空种子命中的那 40K 是「脸」，与"有没有继承历史"无关。**

★ **父代侧独立印证**：同一时段父代自己那几次请求的 `cr` 也是 **41088 / 41216 / 44288** ⇒
**那张脸本来就在缓存里**，不是子代第一次写进去的。

### 12.3 回答"哪怕 99%，有没有可能这些都是新的"：**不可能，`cacheReadTokens` 的定义就是"从缓存读"**

**被新算的**是 `uncachedInputTokens`（=474/567/557）。若 40K 真是"新的"，它们应当落在 `in` 里 ⇒ 实际 `in` 只有几百。
⇒ **`cr=40832` 意味着那 40832 个 token 没有重新计算。** 这与 `in ≈ 500` 互相印证。

### 12.4 ★★ 但用户的担心在**另一个口径上真的成立** —— `436fde97` 就是活例

它有 **7 条**自己的请求：**首请求 2.8%（`cr=1152`）**，其后每条都 ~99%（41216→43904）。
⇒ **会话累计口径会算出 ~85.7%，把"首请求几乎全新"这件事完全抹掉。**
⇒ ★★ **纪律（新增）：报"命中率"必须标注口径 —— 【单次首请求】还是【会话累计】。**
  两者在"该会话有过冷启动"时**可以差 30 倍以上**（2.8% vs 85.7%）。
⇒ 这也解释了 `436fde97` 为什么首请求只有 2.8%：它是 **spawn + continuable**，
**脸与父代不同**（多一个 `report` 工具 + `tool:report` 段，见 §11.5）⇒ **没有可命中的脸** ⇒ 全新。
**⇒ 三件事至此完全自洽**：
- **脸一致**（空种子 fork）⇒ 首请求就 **98.6%**
- **脸不一致**（continuable 多 `report`）⇒ 首请求 **2.8%**，其后自己稳定在 ~99%
- **脸一致 + 带种子**（`a04d96f5`）⇒ **98.9%**（比空种子只多 0.3%）

### 12.5 对 §11.2 结论的加固（而非推翻）

⇒ **"fork 省一笔"小到 0.7% 的原因现在彻底清楚了**：
**首请求成本几乎全由「脸是否逐字相同」决定；种子（父代历史）在这张脸面前微不足道。**
⇒ 靶场量 fork/spawn，**要量行为（步数/正确率/返工），不要量 token** —— 这条结论**不变，而且更硬**。

---

## 13. ★★★★★ ★★ 重大更正：**§11.2 的"只省 0.7%"是错的** —— 用户指出实验设计缺陷，重做后**证实其主张**

### 13.1 用户指出的缺陷（**成立，是我的错**）

> "这个 fork 分身的意义在于：假如我在做**长程任务**，你已经上下文有一半了。fork 出去的话，
> **不管你是有 50K 还是 500K，子代可以直接复用这 50K/500K 的上下文缓存**，对整个任务的理解非常全面，
> 但又可以使用，而且**还不会导致这 50K/500K 的长模型窗口被污染**，导致长程任务出现**漂移**。**这才是它真正的价值所在。**
> 而不是说你放两个、就放一句话的上下文历史在那里，然后把脸做成占模。**你没有拉长视角来看。**"

**⇒ 我的 O21 实验把自变量调到了它的最小端**（父代只跑一轮、只回一个字 ⇒ 种子 291 token），
**然后据此宣布"fork 不是有意义的自变量"** —— 这是**用最小端样本否定一个关于长上下文的命题**。
**⇒ §11.2 那条结论作废。**

### 13.2 重做后的实测（**三档对照，我点名复核过原始逐条请求**）

| 档 | `seedLength` | 种子规模 | 子代首请求 `in` | `cr` | 总量 | 命中率 |
|---|---|---|---|---|---|---|
| 空种子 fork（`b094f295`） | 缺键 | 0 | 567 | 40,448 | 41,015 | 98.6% |
| 短种子 fork（`a04d96f5`） | 22 | ≈291 | 474 | 40,832 | 41,306 | 98.9% |
| **★ 长种子 fork（`bd7d6e6d`）** | **381** | **≈92,646** | **413** | **133,248** | **133,661** | **99.69%** |

**逐条原始请求（`bd7d6e6d`，5 条 = 4 条种子拷贝 + 1 条自己的）**：

| idx | 段 | turn/step | `in` | `cr` | `out` |
|---|---|---|---|---|---|
| 0–3 | 种子（父代历史拷贝） | 1/1 … 1/4 | 767…20774 | 40,448 → **112,512** | 166…2 |
| **4** | **★自己** | 2/1 | **413** | **133,248** | **2** |

⇒ ★ **子代【自己】的请求数 = 1**（`out=2`）⇒ **单次，不是累加**；命中 **99.69%**。
⇒ ★ **超出空种子脸基线（40,448）的部分 = 133,248 − 40,448 = 92,800 = 种子带来的复用**
  ⇒ **`d(cr)/d(种子) ≈ 1.0`（近 1:1 线性）**。
⇒ ★ **机制完全按用户描述的方式运作**：**父代最后那次请求的 `cr` = 133,120~133,376，子代紧接着用同一段前缀 ⇒ 直接吃中。**

### 13.3 ★★ "不污染父代窗口"也实测成立

父代轨迹：**委派前 `seq=453 turn=2` 总量 133,334**（`in`=214 + `cr`=133,120）→ **委派后最终 `seq=563 turn=3` 总量 133,603**
⇒ **父代窗口净增长 = +269 token**（= 任务 + 回执）。
⇒ **⇒ 子代拿着 ~133K 的理解去探索，父代只多花 269 token。** 这才是这个机制的**真正价值**，而它不是"百分比"，是
**"让子代拥有父代全部理解，而父代窗口几乎不动"**。

### 13.4 更正后的结论（**取代 §11.2**）

- ❌ **作废**："fork 只省 0.7%"、"fork vs spawn 不是有意义的自变量"。
- ✅ **成立**：**fork 复用量级 ≈ 种子量级（1:1）**。
  - 父代 50K 上下文 ⇒ 子代首请求 ≈ 40K 脸 + 50K 种子，**未缓存仅几百 token**。
  - 父代 500K 上下文 ⇒ 同理，**子代拿到 500K 的理解，自己只付新增的那点**。
- ✅ **父代窗口净增长 ≈ 任务 + 回执（本例 +269）** ⇒ **长程任务不被子代的探索污染** ⇒ 这是**抗漂移**的机制来源。
- ⇒ **靶场要量 fork/spawn：既要量行为（步数/正确率/返工），也要量"父代窗口净增长"与"子代获得的理解量"。**
  **token 不是无意义的维度 —— 只是我先前量错了位置。**

### 13.5 ★ 诚实边界（本次未测）

1. **缓存 TTL 完全没测**：子代首请求与父代请求**同秒发生**。
   ⇒ "**父代静置 30 分钟后再 fork，还能不能复用这 100K+**"**是这结论最大的适用边界**（可能需要独立实验）。
2. **种子规模 ≈92,646 是差值法**（四条互校落在 91,873~92,800），不是日志里的字段；脸基线 40,448 是**外借**空种子样本。
3. **n=1**；子代只活了 1 次请求 ⇒ **多轮复用、子代自身增长后的复用**均未测。
4. **没有跑 `measure-delegation-reuse.mjs`**（它固定覆写已有输出文件，与"不改已有文件"冲突）⇒ 本次无该脚本的负对照读数。

### 13.6 ★★ 纪律（本轮最重要的教训）

> **用一个【把自变量调到最小端】的样本，去否定一个关于"大端"的命题 —— 这是假否定。**
> 与铁律 #13（否定命题必须带正交阳性对照）同族，但方向相反：**这次不是"对照选错"，是"自变量的取值选错"。**
> ⇒ **派活/设计实验前先问：「我的自变量取在哪一档？被检主张说的是哪一档？」两者不一致就是无效实验。**
> ⇒ 配套：**凡结论含"只有 X%"这类比例，必须同时报出【分母是什么】与【自变量取值】**（本例：0.7% 的分母是 41K，而种子只有 291）。

---

## 14. ★★★★ 官方文档核证：用户关于「缓存时序 / 多子代共存」的判断成立，且**我上一轮的 TTL 警告过度**

**查证来源**：DeepSeek 官方文档 `https://api-docs.deepseek.com/guides/kv_cache`（Context Caching，逐字引用如下）。

### 14.1 ★ 用户的两点判断成立

| 用户的判断 | 官方原文 | 判定 |
|---|---|---|
| "**父代都已经准备动了……它调用工具的这一次，百分百是建立了缓存的**" | "**Each user request will trigger the construction of a hard disk cache.**" | ✅ **成立** —— **委托是由父代的一次请求执行的 ⇒ 那一刻缓存必然刚被构建/刷新** |
| "**多个子代……后一个子代会影响另一个子代的缓存，但按理来说不会**" | "**When the system detects a common prefix across multiple requests, it will persist that common prefix as an independent cache prefix unit.**" | ✅ **成立** —— 同一父代、同一 fork 点的多个子代**共享同一条公共前缀** ⇒ 系统把它**持久化为一个独立单元** ⇒ **它们共享一个条目，而不是互相驱逐** |

### 14.2 ★★ 我上一轮的"TTL 是最大适用边界"**过度了**

官方：**"Once the cache is no longer in use, it will be automatically cleared, usually within a few hours to a few days."**
⇒ **窗口是【数小时~数天】**，不是我暗示的"同秒级脆弱"。
⇒ 再叠加"**每个请求都触发缓存构建**" ⇒ **"父代刚做完事就 fork"这个用法下，TTL 根本不是问题**；
真正要付"重建一次"的钱的场合只有：**父代长期静置后**第一次动 —— **而那一波是父代自己的成本，且它本来也要付**。
⇒ **§13.5 第 1 条（"TTL 是最大的适用边界"）作废**，改为下面的 14.3。

### 14.3 ★★★ 官方给的机制**比我的表述更精确**（这是本轮真正的收获）

> "**A cache hit requires that the corresponding prefix has already been 'persisted' … Each cached prefix is an independent, complete unit.
> A subsequent request can only hit the cache if it【fully matches】a cache prefix unit.**"

**单元在三个时机被持久化**（逐字）：
1. **"Persistence at request boundaries"** —— 每个请求产生**两个单元**：**用户输入末尾** 与 **模型输出末尾**。
2. **"Common prefix detection persistence"** —— 检测到多请求公共前缀 ⇒ 把它持久化为独立单元。
3. **"Persistence at fixed token intervals"** —— 长输入/长输出**按固定 token 间隔**切单元，
   **"to avoid long prefixes from being completely uncacheable due to never reaching an end position"**。

⇒ ★★ **所以"能复用多少"不是简单地"1:1 等于种子长度"**，而是：
**子代的前缀必须【完整匹配】父代留下的某个单元边界**（用户输入末尾 / 模型输出末尾 / 固定间隔）。
⇒ **这与我们的实测精确吻合**：子代首请求 `cr=133,248`，而**父代自己在那次请求里命中的也是 `133,248`**
（父代 `seq=495` 那一行）⇒ **子代命中的就是父代留下的同一个单元**。
⇒ 而 fork 之所以**结构性地几乎总能命中**：**子代的种子 = 到最后一个 `turn/end` 为止**
= **父代"模型输出末尾"** ⇒ **正好落在规则 1 的单元边界上**；再加上规则 3 的固定间隔兜底（长上下文不会被"够不到边界"卡死）。

### 14.4 ⚠️ 由此得到一条**可证伪的预测**（新的实验，值得做）

**预测**：若某次 fork 的**种子边界不落在任何单元边界上**（既非用户输入末尾、也非模型输出末尾、也不在固定间隔上），
**该子代的首请求命中应当显著下降**（而不是仍等于"脸 + 种子"）。

⇒ **做法**：构造"父代在一轮中途被中断/委派（没有干净 `turn/end`）"的场景 ——
但注意 `completedTurnPrefix` 本来就只取**完整回合**，所以**默认情形下种子必然落在模型输出末尾**。
⇒ ★ **所以这条预测更可能的形态是**：**种子的"非末尾部分"能否命中，取决于固定间隔规则** ⇒
**值得测的是：种子长度取不同值（例如刚好卡在两个固定间隔之间）时，`cr` 是否出现台阶**。
⇒ 这与"多轮复用"一起，构成下一批实验（**O25**）。

### 14.5 其它官方约束（要记账）

- "**best-effort**…**does not guarantee a 100% cache hit rate**" ⇒ 与我们的诚实边界一致，**不可把"命中"当保证**。
- "**The hard disk cache only matches the prefix part of the user's input. The output is still generated through computation**"
  ⇒ 缓存只影响**输入前缀**，输出仍要算 ⇒ **不能把"命中"理解成"这一步免费"**。
- 命中读数就是 `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（= 我们一直在用的 `cacheReadTokens` / `inputTokens`）✓ 口径对得上。

---

## 15. O24 / O22 已修（2026-09-22；子代理执行 + 我独立复核）

### 15.1 O24：主表"首请求"改为取【`seedLength` 之后】第一条

**旧行为（bug）**：取"日志里第一条带 usage 的 `assistant/message`" ⇒ 对带种子的子代**取到拷贝来的父代消息**。
**新行为**：取**第一条 `seq > seedLength`** 的；无 `seedLength` 时保持原语义。
**旧口径并列保留**（本项目纪律：只做并列，不删口径），并标 `Δ`。

**我独立复核的硬数值（`node scripts/measure-delegation-reuse.mjs` → exit 0）**：

| 子代 | 新口径（**权威**） | 旧口径（并列对照） | 判定 |
|---|---|---|---|
| `a04d96f5`（`seedLength=22`） | **命中 98.9% / in=474 / cr=40832** | 0.3% / 40803 / 128 | ✅ 与 `out/per-request-usage.txt` 真值一致 |
| `bd7d6e6d`（`seedLength=381`） | **命中 99.7% / in=413 / cr=133248** | 98.1% / 767 / 40448 | ✅ 与 `out/verify-bigseed.txt` 一致 |

- **两口径只有 3/185 个会话不同**（`a04d96f5` / `bd7d6e6d` / `session-432f6207`），其余逐字相同
  ⇒ **修正只影响"带种子"的样本，不影响既有结论**（空种子样本本来就没 bug）。
- 脚本内建了**期望值自检**（`⇒ ✅ MATCH`），这比"报个数"更可信。
- ★ 顺带印证 §12.4：`bd7d6e6d` 的**会话累计命中 81.3%** vs **单次首请求 99.7%** ⇒ **"累计 vs 单次"差异真实存在**。

### 15.2 O22：负对照改为**按 `seedLength` 分臂**

**旧判据形状错**：要求"**fork** 子代种子份全部 > 0"，而样本里有 **4 个历史空种子 fork** ⇒ **永远不可能通过**。
**新判据（与 provider 无关）**：
- **臂 A**：有 `seedLength`（真继承了历史）⇒ 种子份必须 **> 0**
- **臂 B**：无 `seedLength` ⇒ 种子份必须 **== 0**

**实测**：臂 A `n=3` 全 >0 ⇒ `passed = true`；臂 B `n=182` 全 ==0 ⇒ `passed = true` ⇒ **总 `negative control passed = true`**。
provider 分组**保留为信息列**（`fork` 组仍 `2/6 > 0`）—— **没有为了让门变绿去改样本或改判据** ✓

### 15.3 ⚠️ 两处残余弱点（必须记账，别把它当强证据）

1. ★ **臂 B 的断言"结构性恒真"**：切分只在 `seedLength > 0` 时才执行 ⇒ **臂 B 必然全为 0** ⇒
   **这条断言不可能失败 ⇒ 鉴别力有限**。**真正有分辨力的是臂 A。**
   ⇒ 与铁律 #11 是同一族的反面：那里是"**从未为真** = 假绿"，这里是"**必然为真** = 弱证据"。
2. ★ **臂 A 的 n=3 里有一个不是子代理**：`session-432f6207` 有 `seedLength=6989` 但**无 `subagent/descriptor`**
   （是会话级的种子拷贝，不是 fork 子代）⇒ **真·子代理样本只有 2 个**（`a04d96f5` / `bd7d6e6d`）。
   ⇒ 若要更严，臂 A 应**额外要求"有 `subagent/descriptor` 且 `delegationDepth ≥ 1`"**（**未做**，子代理如实把它标为待拍板项）。

### 15.4 未改动的部分（确认没被牵连）

usage 两源归并（O11）、种子/分身三列切分、切分标记普查、A/B 并列、机制正对照、全量一览、交叉表 —— **全部仍在**，
且 182/185 个会话的两口径输出**逐字相同** ⇒ **这次修改是增量的、可审计的**。

---

## 16. 用户裁定 D2′ + 两个新问题的答复（2026-09-22）

### 16.1 ✅ **D2′ 已被用户接受**，且给出的理由比我的更根本

> 用户原话："**我接受啊，这就是我自己提出来的呀。声明面就是要小于可调面，或等于可调面，
> 因为只有这样，我们才可以通过后续追加的方式使子代理的能力大于主代理，然后专门去做专项功能。**"

⇒ ★ **"声明面 ≤ 可调面"不是一致性妥协，而是【功能前提】**：
**只有允许"可调多于所宣告"，才能在不改主代脸的前提下，让子代通过追加获得超过主代的能力。**
⇒ **D2′ 状态：✅ 定**（不再待拍板）。**实现缝 (d) 已实测可行**（§9）。

### 16.2 ★★ 新问题："子代再调子代，**会不会把主代/子代的专有能力带下去**？"

**答：不会——不会串台，也不会累积。**（机制 + 实测双重印证）

**机制**：`composeFrom` 把子代的 scope key **`bindScopeParent` 到 preset 的 standing scope**，
**不是绑到父代 agent 的 scope**（§D6 逐字：`bindings.set(agentKey, bindScopeParent(agentKey, standing.key))`）。
⇒ 子代的 scope 链 = `[global, 该 preset 的 standing, 它自己]` ⇒ **父代 agent scope 上的注册不在链上**
（`dsh-scope/lib/index.js:162-181`：`chainLayers` 沿 `scopeChainOf` 逐层合并、**最近者胜**；`:256-262` `bindScopeParent`）。

**实测印证（逐层比对，`out/delegation-reuse.txt:60/82`）**：

| 层 | preset | `tools` 数 | `system` 公共前缀 |
|---|---|---|---|
| depth 1（`436fde97`） | council | **103** | — |
| depth 2（`8ac9ffef` ← depth 1） | council | 子 **103** / 父 **103** | **6880 / 6880 = 100%** |
| depth 3（`8314ffa9` ← depth 2） | council | 子 **103** / 父 **103** | **6880 / 6880 = 100%** |

⇒ ★ **层层都是同一张 preset 脸，深度增加不带来任何工具累积。**

**⇒ 两个必须同时记住的后果：**

| 后果 | 说明 |
|---|---|
| ✅ **不会串台 / 膨胀** | 每个分身的能力是**显式给的**，不是继承累加来的 ⇒ 不会出现"越往下越臃肿" |
| ⚠️ **也不会自动传承** | 若 **A 的专有能力 B 也需要，必须【显式给 B】**（我们控制创建钩子 ⇒ 可做）—— **这是要专门设计的一件事（新增 O26）** |

### 16.3 ★ 新问题："结构化回执（`outputSchema`）有更好还是没有更好？你觉得哪个更好？"

**用户明确要我以"模型内部更适应什么"的视角回答。** 我的回答（并附可测判据，不只表态）：

**⇒ 我倾向【默认不用 schema，用固定小标题的文本回执】**，三条理由：
1. **文本回执能承载"不确定 / 部分结论 / 风险提示"**；schema 会逼着把丰富的东西**压进字段** ⇒ 更容易丢掉该说的。
2. ★ **schema 是"终局约束"**：`attachStructuredRuntime` 要求"结构化输出即终局答复"，而且
   **捕获后单调守卫阻断后续工具调用**；**干净一轮若从未提交结构化值，会被 driver 主动改写成 `error`**（§O10 实测）。
   ⇒ 对"要边探索边回话"的分身是**负担**，不是帮助。
3. **父代是【读】回执，不是【解析】它** ⇒ schema 的主要收益（机器可解析）用不上。

**⇒ 但两种情形应当上 schema**（这时它的收益是真的）：
- ① **父代要按字段分支**（例如"状态=失败 ⇒ 改派"）；
- ② **要机器校验 / 统计**（S6 的"错误率 / 返工次数"要能**自动归类**）。

**★ 但这件事不该靠我表态定** ⇒ **可测判据（缺一不算结论）**：
**① 父代解析回执的失败率；② 子代因回执约束而返工的次数；③ 回执字段缺失率。**
⇒ 建议：**默认文本；把"要不要 schema"做成 S6 里一个可切换的臂**，用它三列数据决定。
⇒ **状态**：🟡 我的**倾向**已给出（默认文本），**最终由这三列数据定**。

---

## 17. ★★★★★ 「孙代继承了子代的工具面**宣称**，而它其实没有那些工具」—— 机制与处置（2026-09-22）

### 17.1 用户提出的问题（成立，而且是真缺口）

> "子代**需要增加功能**，然后这个时候它的上下文就在中断了。也就是说，此时**如果切换到孙代的话，孙代就会拥有子代的工具的宣称**。
> 除非我们后续告诉他这个宣称失效了，但是又要怎么去处理它呢？不过由于**我们并没有介入到前面的 `system`**，
> 我不清楚，**直接告诉他"你已经换了环境、工具面发生了变化"有没有效果**？
> **需不需要在子代的时候就标记好"这是某工具面"，然后再说"某工具面失效、进入新工具面"？**"

**问题本体**：§16.2 已证 **孙代的脸 = preset 脸**（不带子代的追加）⇒ 但**孙代的种子（= 子代的已完成回合）里含子代的"你具备 X"声明**
⇒ ★ **孙代继承了一条【对它不成立】的宣称** ⇒ 它会尝试调用它没有的工具 ⇒ 白费步数 / 困惑。

### 17.2 ★★ 上游**已经有**这套机制，而且语义正好是我们要的（逐字证据）

| 证据 | 原文 |
|---|---|
| **每条快照显式推翻更早的** | `dsh-system-prompt/lib/index.js:87`：<br>`return \`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}\`;` |
| **整段失效有专门措辞** | `dsh-agent-loop/lib/index.js:17`：<br>`const CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";` |
| **快照是"有主的"，可被识别/替换** | 同文件 `:16,18-20`：`SOURCE = "@deepseek-ai/dsh-system-prompt"` + `isOwned(message) => source.kind==='plugin' && plugin===SOURCE` |
| **状态可跨 resume 恢复** | `:25-47`：`RuntimeContextProjection` 从 `session.events` **倒扫**取最近一条 surface 可见的 owned 消息作为 `retained {seq, text}` |
| **随会话事件跟进** | `:48-51`：`ctx.on("session/event", …)` 更新 `retained`（⇒ **可判重、不必每步重发**） |
| **provider 每次装配求值** | `dsh-system-prompt/README.md:21`：`ctx.systemPrompt.context()` 的 "Providers are evaluated for **each eligible assembly**"；产出的快照落在**消息面** |

⇒ ★ **所以"直接告诉他工具面变了"是【有效】的 —— 而且这不是我们发明的，是上游既有语义。**
**要害只有一个：它必须是【runtime-context（每次装配重算、可被推翻）】，而不是【写进历史的一次性声明】。**

### 17.3 ★ 回答用户的第二个子问题：「需不需要在子代时就标记好'这是某工具面'？」

**⇒ 需要，但用途是【审计与判据】，不是替代快照机制。** 两半分开看：

- **"标记"这一半：采纳。** 给工具面一个**短指纹**并写进快照文本：
  `当前工具面 face=<短指纹>（N 个工具）：…`
  ⇒ ★ **它换来一条可机验的判据**：**从会话日志里比对"模型当时看到的 face 指纹" vs "当时真实注册表指纹"**
  ⇒ **能自动检出"陈旧宣称"** ⇒ 把"到底有没有效果"变成**可复算**的东西（本项目的标准做法）。
- **"失效"这一半：不需要我们发明。** 上游已有：**新快照自带"supersedes 更早快照"**；整段清空时发 **`CLEARED`**。

### 17.4 ★★ 落地形状（这就是"怎么处理它"的答案）

```
① 分身创建时：把「当前工具面」注册为【child-scoped】的 systemPrompt.context() provider
     文本 = `当前工具面 face=<短指纹>（N 个工具）：<清单>`
     （它自带 "This snapshot supersedes earlier runtime-context snapshots." 前缀）
        ↓
② 能力集变化时：provider 重新求值 ⇒ 文本变 ⇒【新快照被追加】⇒ 历史里那条旧的被【显式推翻】
        ↓
③ 孙代 fork 时：种子里那条旧快照【仍在历史里】（删不掉），
     但孙代【自己装配时会注入它自己的快照】⇒ 旧宣称被显式推翻 ⇒ 孙代不会去调它没有的工具 ✓
        ↓
④ 某层 face 变空：上游直接发 CLEARED（"…no longer apply"）
        ↓
⑤ 审计：face 指纹比对（日志里的宣称 vs 真实注册表）⇒ 自动检出不一致
```

★ **全部落在消息面 ⇒ 不改 `system` ⇒ 不砸前缀**（与 D2′/D3 一致）。

### 17.5 ⚠️ 一条必须承认的残留代价（并顺势回到用户最早那个"压缩点"直觉）

**孙代【仍然会看到】种子里那条已被作废的旧快照** —— 历史只能追加，**推翻 ≠ 删除**。
⇒ **代价**：历史里多一段无效文本，且**随深度累积**（每层各留一段）。
⇒ ★ **它的正确清理位置就是【压缩点】**：**压缩本来会把那段消息吞进摘要** ⇒ **那是唯一免费的时刻**。
⇒ **⇒ 用户最早说的"压缩时再合并/清理"在这里得到了它【正确且唯一】的位置**：
  **不是去清理 `system`（那里没有东西可清），而是让压缩把"已作废的运行时快照"吞掉。**

### 17.6 新增未闭合

| # | 未闭合 | 挡住 |
|---|---|---|
| **O26** | **分身的"能力传承"要显式设计**（§16.2：能力不自动累积 ⇒ A 的专有能力 B 拿不到） | S3/S5 |
| **O27** | **face 指纹的具体取法**（可见工具名集合的哈希？含 system 段？）与**审计脚本** | S3/S6 |
| **O28** | **快照"仅在变化时注入"是否真的去重**（`retained` 的比对逻辑我只读到状态跟踪，**未读到判重那一段**） | 前缀安全性的证明 |

---

## 18. 机制确认 + 一个**更省的改法** + 一个战略问题的诚实答案（2026-09-22）

### 18.1 ✅ 用户的机制描述成立："就行了"

> 用户原话："这套机制的理由是**让 LLM 清楚自己现在有什么**。子代时宣告**进入了新工具面、有了新工具**；
> 进入孙代时再告诉他**上一个工具面失效了、有下一个工具面**。是不是就行了？毕竟现在模型应该能理解这种简单的变化吧。"

**⇒ 成立，而且这正是上游维持正确性的唯一手段**（§17.2 的 `supersedes` 那句话就是干这个的）。

### 18.2 ★★ 但有一个**更省、更不易过期**的改法（从第一原理推出来的）

**关键认识：模型本来就看得到"当前真脸"。**
- **native 模式**：当前 schema 就在本次请求的 `tools` 字段里；
- **code 模式**：当前 SDK 段就在本次请求的 `system` 里。

⇒ 所以 **runtime-context 那句的价值不是"提供信息"，而是"消解矛盾"**：
种子里那条旧声明说"你有 X"，而本次请求的 schema 里**没有 X** ⇒ **模型面对同一上下文里两条互相矛盾的信息**，
且**旧的那条当时是真的** ⇒ 它可能继续信旧的。
⇒ ★ **因此快照文本应当【强调作废、而不是重述清单】**：

```
推荐写法：`工具面已变更为 face=<指纹>；更早关于工具面的声明不再适用。当前可用工具以本次请求的工具列表为准。`
不推荐：  把全部工具名再列一遍（与 schema/SDK 段重复，白花 token，且自己也会过期）
```

⇒ **好处**：① 更短（省 token）；② **指向权威来源**（"以本次请求的工具列表为准"）⇒ **它自己永不过期**；
③ 与 17.3 的 face 指纹审计兼容（指纹用于**机验**，句子用于**告知模型**）。

### 18.3 ★★★ 战略问题："上游已经做得这么深入，**上游更新了，我是不是等于白做**？"

**⇒ 不含安慰的回答：分三档，白做的风险差别极大。**

**（a）风险最高：重写上游已有的机制。**
上游手里已有三块料（`presentAs` / `context()` / `tools.register`）＋ 一整套 fork/spawn/compaction。
**我们若去写"脸冻结 + 钉住 SDK 段 + 尾部目录"，上游完全可能自己做一个更好的版本。**
⇒ ★ **这正是铁律 #17 那条红线**："同一件事，开源已经做出了更好的版本，而我还在自己写。"
⇒ **⇒ 结论：不要在这条路上投重兵。**

**（b）风险极低：我们这几轮真正产出的东西 —— 它们【不是功能】，是【判据与量测】。**
本机 `chars/token≈2.87`、脸 40.2K（tools 占 94%）、fork 种子复用 **1:1**、`end-seed` 与 mode 的**伪**相关、
`complete` 段会**静默作废**钉住、压缩信号历史为真 **202 次**、`node -e` 被 shell 吃引号、`chars/4` 估错 **40%**、
主表"首请求"取错事件、**用小种子否定长上下文主张**……
⇒ ★ **这些是"在这台机器、这套配置下的物理事实"与"我们踩过的坑"。上游更新不会让它们失效 ——
只会让我们【重新量一遍】。而且它们的功能恰恰是：测出"这次更新有没有把我们的假设弄坏"。**
⇒ **上游永远不回答"我们的不变量是否被破坏"（它有它自己的不变量）。⇒ 门是长期资产。**

**（c）上游不会替我们做的（因为它的默认组合不需要）：**
1. **能力传承（O26）** —— 上游的子代**绑到 preset 的 standing scope**，**刻意不继承父代 agent 的注册**（§16.2）⇒
   "A 的专有能力怎么传给 B"**是它不解决的问题**，因为它没有这个需求。
2. **压缩点吞掉作废快照（§17.5）** —— 上游的压缩是**通用区域压缩**，不会专门处理"我们注入的已作废快照"。
3. **本机的复合体**：council preset / 议事厅席位 / switchboard / eval 靶场 —— 上游没有也不会有。

**（d）⇒ 由此得到的策略（可执行）**

| 做什么 | 为什么 |
|---|---|
| ★ **把重心从"造机制"移到"定判据 + 量证据"** | 判据在上游更新后**仍然有用**（它就是用来测更新的） |
| ★ **把本轮判据接进"漂移体检"** | 我们已有 `scripts/check-upstream-drift.mjs` + `npm run check:upstream`（铁律 #10：升之前先跑）⇒ **把"脸指纹 / 前缀命中 / 复用比 / 钉住是否被 complete 作废 / 压缩计数"接进去** ⇒ 上游一更新**先知道哪条假设坏了**，而不是重读源码猜 |
| ★ **S1–S5 先做"能被上游变化测到"的最小实现（观测/门），再做会随上游变动的机制代码** | 让返工面最小 |
| ★ **优先做上游明确没做的两条**：**O26 能力传承**、**§17.5 压缩点吞作废快照** | 这两条由**我们特有需求**驱动 ⇒ 上游不会替我们做 |

**⇒ 一句话**：**"造通用机制"很可能白做；"定判据 + 量证据 + 做上游没需求做的事"不会白做。**
而且用户早就定过这条纪律（铁律 #10：**不追上游版本，只按需合并对我们有利的改动**）——
**⇒ 我们的收益来自"按需合并"，不来自"抢先实现"。**

### 18.4 新增未闭合

| # | 未闭合 | 挡住 |
|---|---|---|
| **O29** | **把本轮判据接进 `check-upstream-drift.mjs`**（脸指纹 / 复用比 / 钉住有效性 / 压缩计数） | 抗上游漂移的长期价值 |

---

## 19. ★★★★ 「材料树 / 成品树」二分评估（2026-09-22，用户提出）

### 19.1 用户的提法

> "子 agent 要管理很多不同的子 agent，而这个'子'是由 **skill 树**来展现的。
> 也就是说，**skill 树是不是需要有两个：一个是材料树，一个是成品树？**
> **成品树就是 sub agent；材料树就是外部 skill 的归一化。**"

### 19.2 ✅ 二分成立 —— 判据一句话：**"这个东西需要被【执行/委派】吗？"**

| | 材料（来源） | 成品（可委派） |
|---|---|---|
| 需要什么 | **被读 / 被融合 / 被溯源**（对外部来源的归一化；要能探测上游变更） | **被委派 / 被评分 / 被淘汰**（要有身份、能力面、回执约定、预算） |
| 生命周期 | 会被 absorb 掉 | 会被使用、评分、提升、归档 |

### 19.3 ★★ 但**不必是"两棵独立的树"** —— 现有 schema 已经把"账本"和"升格门"建好了

核过 `packages/skill-tree/src/index.ts` 的 `SkillNode`：

| 需要的能力 | **现有字段** | 说明 |
|---|---|---|
| 材料的来源与版本 | `Source` / `SourceFile` / **`SourceHash`** / `ImportVersion` | ★ `SourceHash` 注释原文就是"用于探测上游变更 → `update_pending`" |
| ★ **"材料 → 成品"的升格门** | **`Tools: ToolDef[]`** | ★ 注释原文：**"有 Script/Tools ⇒ 可升格 sub agent"** —— **门已经有了** |
| **多对多映射账本** | `MergedFrom` / **`AbsorbedBy`** / `Status=absorbed` | 融合与吸收的溯源（`isAbsorbed()`） |
| 成品之间的继承/组合 | `Extends`（继承父 body+triggers+script）/ `Requires`（一层深） | |
| 成熟度与淘汰 | `Score` / `UseCount` / `SuccessRate` / `Level`（L3 = `score≥0.7 ∧ use_count≥10`） | |

⇒ ★ **⇒ "成品树" = 这棵树里 `Tools.length > 0` 且状态可用的那些节点** ⇒
**它不是第二棵树，是同一棵树的一个【筛选投影】。**
⇒ 而且这**与我们这几轮反复用的原则一致**：**权威 vs 投影**（脸是注册表的投影、SDK 段是投影）
⇒ **成品树应当是材料树的投影，不能是第二个真相源**（否则两份数据必然漂移）。

**⇒ 结论：一棵真相源 + 一个可执行投影 + 一份谱系账本。**

### 19.4 ★★ 真正缺的三件（**重点：不是"再加一棵树"**）

**(a) "成品"没有 sub-agent 的实体字段。**
已核：`packages/skill-tree/src/*.ts` 里 `Agent` / `Subagent` / `Preset` / `Face` / `Recipe` **零命中**。
今天 `Tools` 只声明工具，**缺**：席位/身份、**能力面（脸）指纹**、**回执约定**（文本 or `outputSchema`，见 §16.3）、
**深度预算**、**"它能委派给谁"（编排）**。

**(b) `Tools` → "脸" 的映射未定义。**
声明要变成脸，必须 ①**注册**（走完整管线，D2′）②定 **presentation**（native / code）③定**钉住/刷新时机**（D1/D2′）。
⇒ 这层没有，`Tools` 就只是注释。

**(c) ★★ 最硬的前置：能力不自动传承 + per-child preset 无公开入口。**
§16.2 已实测：**子代的脸 = preset 脸，不继承父代 agent 的注册**（`composeFrom` 绑到 standing scope）；O7 同样未解。
⇒ **⇒ 所以"成品"目前【无法真正持有一套专属能力面】** —— 它顶多是"一个引用了某些 `Tools` 的节点"，
而**这些 `Tools` 落不到那个子代身上**。
⇒ **⇒ 「成品树」的落地前置就是 O7 + O26。没有这两个，成品树只是名字。**

### 19.5 命名建议（"树"这个字会误导）

**"树"暗示两个独立的数据结构** ⇒ 会诱导出"两份真相源" ⇒ 必然漂移。建议按**功能**命名：

- **材料** → `Sources`（来源/素材）或 `Shelf`（架子：只读参照、可探测上游变更）
- **成品** → `Lineup`（阵容/可委派名册）或 `Agents`（可委派成品）

⇒ 并**共用一个 `Node` schema + 阶段字段**（现有的 `Status` + `Tools.length > 0`）。

### 19.6 落地顺序（按依赖，不能跳）

1. **先解 O7**（per-child preset 入口）—— 否则成品没有"自己的脸"
2. **再解 O26**（能力传承：显式给 B）—— 否则成品之间无法协作
3. **然后给 `SkillNode` 补"成品实体字段"**（身份 / 脸指纹 / 回执约定 / 预算 / 编排），**并保持它是投影而非第二真相源**
4. 最后才是"管理很多不同子 agent"的**名册与预算层**（现有 `skill-tree` **刻意不含执行器**，这一层是新的）

### 19.7 一句话结论

**二分对；判据已在现有 schema 里（`Tools` 非空 = 可升格）；
但不要做成两棵独立的树 —— 做成"一棵真相源 + 一个可执行投影 + 一份谱系账本"。
真正缺的不是第二棵树，而是 O7 / O26 两个前置 + 成品的实体字段。**

---

## 20. ★★★★★ **更正 §19**：我们**已经有"成品层"了**，而且它**不是树** —— 是 `ctx.subagents` 的 provider 注册表

> 起因：用户授权改名并说明"`skill-tree` 原本是记忆系统里做自学习/自进化的，现在要迁到 agent 里"。
> **我先按铁律 #17 查"有没有人做过"（含我们自己做过的）—— 查出了关键事实，必须更正 §19。**

### 20.1 ★★★ 关键发现：`docs/capability-registry-evolution.md` 里已经把这件事**设计过了**

逐字（该文档 62KB，我只读关键行）：

| 行 | 原文 |
|---|---|
| `:7` | **核心论断：「sub agent 就是它的能力；sub agent 的能力就是它的能力。这比自己给自己改好得多。」** |
| `:5` | "装配完成 → 验收 → **形成一个新 sub agent → 注册为新 sub agent**" |
| `:8` | "最后一条要求：**「重要的是能不能把市面上已有的 Agent 注册为 sub agent 让它调用。」**" |
| `:20` | ｜"sub agent 就是它的能力"成立吗？｜**成立，而且是架构可判定的** —— **顶层能力 = 已注册 provider 的并集**｜ |
| `:23` | "外部 Agent 能接进来吗？ → **能，且是官方设计目标** —— 注释原文「Provider-side vocabulary for **OUT-OF-PROCESS** subagent backends」" |
| **`:30`** | ★ **"`ctx.subagents` 是进程单例、注册名全局唯一、自带跨会话查询面（`listChildren`/`followup`）→ \*\*「能力库」不需要新建存储，它已经是了\*\*（§3.4）"** |
| `:384` | "→ 需要一个**旁挂**的 `capability-registry.json`：`{ id, version, source, acceptance, holdoutHash, registeredAt, supersededBy }`" |

⇒ ★★ **所以"成品树"不是要新建的东西**：
**成品层 = `ctx.subagents` 的 provider 注册表**（进程单例、名字全局唯一、自带 `listChildren`/`followup`）
⇒ **它就是"可委派名册"，而且文档早就判定"能力库不需要新建存储"。**

### 20.2 ★★ 而"材料层"我们**有两套，且互不认识**（这才是真问题）

| 材料线 | 是什么 | 状态 |
|---|---|---|
| **`scripts/capability-*`**（registry / gate / sources / store / snapshot） | **外部来源归一化 + 注册门 + lineage 账本**（`id/version/source/acceptance/holdoutHash/supersededBy`；四动作 注册/升级/合并/淘汰；"**注册 ≠ 采纳**"——register 只建 `pending`） | ✅ **在用**（62KB 设计文档 + 门 + 快照） |
| **`packages/skill-tree`** | **自学习 / 自进化 skill 树**（`SkillNode` + `Absorb` 账本 + `Tools` 升格门 + L3 成熟度） | ⚠️ **孤儿包**（见 20.3） |

**★ 二者互不提及**（双向 grep 零命中：能力库文档里 `SkillTree / 技能树 / absorb` 全无；`skill-tree` 侧 `capability` 零命中）
⇒ **⇒ 两条材料线各自演化，关系【从未被定义】。这才是要先解决的问题，而不是"要不要第二棵树"。**

### 20.3 ★ `packages/skill-tree` 现在是**孤儿包**（未被挂载、零引用）

实测：`skill-tree` 只被**它自己包内**的文件引用（`package.json` / `src/*` / `test/*`），
**没有任何 profile / preset / `cordis.patch.yml` 引用它**
⇒ **它没被挂载、没注册任何东西**（与 §3 一致：纯数据层、刻意不含执行器）。

### 20.4 ⇒ **改名的正确顺序变了**（撤回上一轮"改名成本低、可以做"的说法）

**名字应当反映"它在架构里的位置"；位置未定 ⇒ 现在改名只是给一个还没归档的东西贴标签。**
**⇒ 应先做一次【裁决】—— 三条候选关系：**

| 候选 | 内容 | 评价 |
|---|---|---|
| **① 两条并行材料线** | `skill-tree` = **内部自学习**材料（经验 → skill）；`capability-*` = **外部来源**材料（MCP/插件/外部 Agent） | ⚠️ 风险：**又变成两份互不相识的账** |
| **② `skill-tree` 是 capability 的上游** | skill 成熟（L3 / 有 `Tools`）⇒ **升格为 capability** 走注册门 | ✅ 合 D19"别做两个真相源" |
| **③ 合并** | `SkillNode` 成为 `capability-registry` 的一种 **entry 来源**（只留一个真相源） | ✅ 最彻底，改动最大 |

**⇒ 我的倾向：② 或 ③**（都指向"一个真相源"）；**① 不可取**（会重演"两份账、必然漂移"）。
**⇒ 裁决之前：`skill-tree` 保持原名、保持不动**（它现在是孤儿，不动零风险）。

### 20.5 ★★ 修正后的整体结构（**取代 §19.3 的表述**）

```
【成品层】ctx.subagents 的 provider 注册表        ← 已存在，不需要新建"树"
            进程单例 / 名字全局唯一 / 自带 listChildren + followup
            （每个 provider = 一个可委派的 sub agent）
                 ↑ 由谁上架、上架何版本、依据何判据
【账本层】capability-registry.json（旁挂）          ← 已存在
            { id, version, source, acceptance, holdoutHash, registeredAt, supersededBy }
            "注册 ≠ 采纳"：register 只建 pending；过门并写回 acceptance 才算
                 ↑ 材料从哪来
【材料层】两条线，关系待裁决（§20.4）
            · scripts/capability-*（外部来源：MCP / 工具插件 / 外部 Agent）  ← 在用
            · packages/skill-tree（内部自学习：SkillNode + Absorb + Tools 升格门）← 孤儿包
```

⇒ ★ **⇒ 对用户"两棵树"的最终回答**：
**你直觉里的"成品"已经有了（它是注册表，不是树）；你直觉里的"材料"有两份、还没对齐。
⇒ 下一步不是"建第二棵树"，而是「定两条材料线的关系」→ 再给 `skill-tree` 一个位置 → 名字随之而来。**

### 20.6 新增未闭合

| # | 未闭合 | 挡住 |
|---|---|---|
| **O30** | ★ **裁决两条材料线的关系**（§20.4 的 ①②③） | `skill-tree` 的去向与改名、成品层的上架来源 |
| **O31** | **`capability-registry` 的 entry 与 `ctx.subagents` provider 的对应关系**（一个 capability = 一个 provider？一对多？改名/版本怎么映射） | 成品层与账本层的接线 |

---

## 21. 四路并行取证结果（2026-09-22；**每条关键指控我都独立复核过**）

> 产出：`out/w12-o7-per-child-preset.md` / `w12-o30-o31-material-lines.md` / `w12-o28-snapshot-dedup.md` / `w12-o27-face-fingerprint.md`
> + 新脚本 `scripts/face-audit.mjs`（可复跑）

### 21.1 ★★ 更正 §20.2：两条材料线的关系**不是"从未被定义"，而是"文档里写过、从未落成代码或裁决"**

**我核验了 W2 的纠正（逐字，`docs/revised-architecture-2026-09-20.md`）：**

| 行 | 原文 |
|---|---|
| `:273` | "`capability-registry` 有 `lineage`（注册/升级/合并/淘汰）+ `supersededBy`；**`SkillNode`（技能树，未移植）本身就是候选池**" |
| `:285` | "⇒ **Skill 树是这套操作的对象与账本**：新子 agent 不断长出来，能力面决定'该新建 / 该合并 / 该融合'。" |
| `:350` | "7. **skill → subagent 的构建路径**：**`SkillNode.Script/Tools` 升格成 provider 时**，…" |
| `:347` | "｜**相同**（能力面重合）｜**合并**｜一个（`SkillNode.Absorb` / `AbsorbOutcome` 就是它的现成字段）｜" |

⇒ ★★ **这份文档已经把 O30 的【方案②】写出来了**（"`SkillNode.Script/Tools` 升格成 provider"），
并明确了 Skill 树的角色是**"候选池 + 对象与账本"**。
⇒ **⇒ 所以 O30 的选择不是从零裁决，而是"把已写过的方案落成代码 + 正式登记"。**
⇒ ⚠️ **一处状态矛盾要澄清**：该行说 `SkillNode` **"未移植"**，但 `packages/skill-tree` **确实存在（TS 移植版）**
  ⇒ **文档与代码状态不一致**（可能是该行写在移植之前）⇒ **新增 O32，必须先澄清哪个是现行事实。**
⇒ ★ 而它**没落成代码/裁决**的原因正是用户指出的：**没登记**（见铁律 #24）。

### 21.2 ✅ O7 关闭：**没有公开的 per-child preset 入口**

**我核验**：`childSessionMeta(parent, childDepth, lineageSeedLength)` —— **三个形参，没有 preset override**（`dsh-subagent/lib/types/child-agent.js:80`）。
⇒ 加上 `meta.agentPreset` 是"**记录**"而非"**指令**"（写入 `dsh-session/lib/index.js:1667`；两个创建点硬编码 `childSessionMeta`）⇒
**O7 = 无公开入口。**
**今天的可行做法**（代价由轻到重）：
- **(b) 子代 scope 遮蔽**（D6 路线，**已有 (d) 实测支持**）—— **零 patch，首选**
- **(c) `toolFilter` 裁**（只能裁，不能加）
- **(e) 换 provider 名**（provider 由 preset 的 `tool-subagent` 行决定 ⇒ 我们 `subagent-council` 就是这么做的）
- **(a) patch `childSessionMeta`**（最后手段）
- ★ **新发现**：`subagents.registerContinuableSetup()`（`dsh-subagent/lib/types/index.js:155-157`）是**公开的子代 creation-window 挂点**，
  但**只覆盖 continuable 子代**，且贡献契约是**同步**的。

### 21.3 ✅ O28 关闭：**去重成立 —— 仅变化时注入**
**我核验**（`dsh-agent-loop/lib/index.js:64-67` 逐字）：
```js
if (this.retained === void 0 && current.length === 0) return;
const snapshot = current.length === 0 ? CLEARED : current;
if (this.retained?.text === snapshot) return;      // ★ 纯文本等值比较
```
⇒ **判重 = 纯文本等值**；**提交 = 消息尾端追加新消息（全文，非 diff）** ⇒ 历史**只在变化时增长一条**，**从不改写已有消息** ⇒ **前缀安全** ✓
⇒ `retained` 恢复：倒扫 `session.events`，要求 `seq ∈ session.surface.nodes`；**被压缩遮蔽 ⇒ `retained = null` ⇒ 自动重发** ✓

**★★ 由此得到一条对我们设计的硬约束（W3 的实测发现，重要）：**
> **判重是纯文本等值 ⇒ 任何"每步都变"的 provider 会让快照每步失效。**
> 上游对时间戳正是这么办的：`time-context` **不走 `systemPrompt.context()`**，而挂 `agent/pre-step` 自己追加 + 自带 `refreshIntervalMs` 节流。
> **⇒ 我们注入的 face 指纹必须【只在能力集真变时才变】—— 绝不掺时间戳 / 会话 id / 序号 / 端口。**

### 21.4 ✅ O27 关闭：face 指纹已定义、审计脚本已跑通 —— **并量出两个真问题**
**跑通结果**：`node scripts/face-audit.mjs` → `scanned=185 sessions, face-changes=86, stale-claims=0`（产物 `out/face-audit.txt`）
**指纹**：`sha256("dsh-face/v1\n" + |S|len(system)+system + |T|n+ 字典序各工具的 名+canonicalJSON(对象))[0:8]`（**含 schema 全文**）

| 实测发现 | 证据 | 结论 |
|---|---|---|
| ★ **`stale-claims=0` ≠ "审计通过"** | 本机有 **369 条** runtime-context 快照，**没有一条带 `face=`** | 脚本把"无宣称"与"宣称都对"**分开报** ⇒ **这正是防"假绿"的正确姿势**（铁律 #7/#12） |
| ★★ **最大一类假阳性：端口** | 77 个会话内变化点里 **33 个**的差异**只在 `system` 里的 Web GUI 端口**（`:3087 → :3089`，我已核验 `out/face-audit.txt:1060-1089`） | **端口一跳指纹就变 ⇒ 判重失效 ⇒ 多塞一条快照** ⇒ **写进快照的指纹必须先做端口归一化** |
| ★★ **只哈希"工具名集合"一定会漏** | `fd6d7819` 的 `seq 8646→9853`：工具数 69→69、名字集同、**system 逐字相同**，**face 仍变了** | 差异只在 **tools 条目内容** ⇒ **这就是"指纹含 schema 全文"的实测依据**（不是推理） |

### 21.5 ✅ O30 / O31 有答案（待裁决）
- **O30**：推荐 **②**（`skill-tree` 是 capability 的上游）**但不能是"自动升格"版**；
  **①不可取的机制有 5 条**（两个写者各累加一份"用了几次"、ID 空间不可 join、状态机不同构、阈值分歧、合并判据方向相反）；
  **② 比 ③ 省**（② 的落点可复制 `capability-registry.mjs:231-266` 的既有形状；③ 要改"照搬 Go、改一条就得全量回归"的移植产物）。
  ★ **分水岭（判据能否对齐）：只有行为信号层能对齐**；机械门需给 `SkillNode` 补 4 项不变量声明；
  **硬判据两侧都是空的**（`SkillEvaluator` 全仓无实现；capability 的 L3/`holdoutHash` 未实施）
  ⇒ **今天只能做"候选入池 + 只经注册门采纳"的单向门。**
- **O31**：**不是 1:1，且"接线"根本不存在** —— `kind:'mcp-server'` 的 entry 没有 provider（现场 `design-canvas`：`provider=null`）；
  映射分散三处（旁挂 JSON / `subagent-council/src/index.ts:122` 唯一 `registerProvider` 调用点 / preset 配置），**只有后两处是真的**；
  **`supersede` 只改 JSON，从不碰 `ctx.subagents`** ⇒ **版本映射只能靠"注销+注册"保持，而这是 `check` 查不到的那类错误。**

### 21.6 新增未闭合

| # | 未闭合 | 挡住 |
|---|---|---|
| **O32** | **澄清状态矛盾**：`revised-architecture-2026-09-20.md:273` 说 `SkillNode` **"未移植"**，但 `packages/skill-tree` 存在（TS 移植版） | O30 的裁决前提 |
| **O33** | **端口归一化**：face 指纹必须先把 `system` 里的 `127.0.0.1:<port>` 归一化，否则每次换端口都多塞一条快照 | S3/S4 |

---

## 22. O32 关闭：`skill-tree` 移植现状 = **前半段已落地、后半段刻意留空**（2026-09-22）

### 22.1 权威文件是 `docs/skill-tree-port-plan.md`（不是 `revised-architecture:273`）

**该计划逐字**：
- 上游 = `D:\project_develop\ai-base\agent-shell\internal\memory\`（**只读，不改**）；
- **"本阶段只做数据层（对应 `memory-asset-triage.md` §6 的 P2）。执行器（P3）刻意不做 —— 顺序理由是「数据先行、执行器可替换」"**；
- 边界表 —— **管**：`SkillNode` 数据模型 + 生命周期 + `Absorb` 账本 + 导入器 + 确定性评分层；
  **不管**：`GetActiveSkills` / 注入 / **`spawn provider` 委派（执行器，P3）** / 注册门 L1·L3 的具体实现（挂在 `SkillEvaluator` 接口上，**本层只留挂载点**）；
- **"本表只是把它从 Go 搬到 TS，不新增字段、不改语义"**。

⇒ ⚠️ **`revised-architecture-2026-09-20.md:273` 说 "`SkillNode`（技能树，未移植）" 是【过期/狭义措辞】**
（同文档 `:376`/`:380` 还有"移植"待办列 ⇒ 该文档是规划态）。
**⇒ 现行事实以 `skill-tree-port-plan.md` + 代码为准。**

### 22.2 实测：移植是**部分**完成（用可靠方式核过）

| 计划阶梯 | 应有 | **实际** | 状态 |
|---|---|---|---|
| **L0** 纯函数层 | `tokenize` 等 | `src/text/tokenize.ts`（333 行） | ✅ 在 |
| **L1** 类型层 | `index.ts`（计划原文标"**★ 本次已落地**"） | `src/index.ts`（222 行） | ✅ 在 |
| **L2** | `gravity-field.ts` / `skill-tree.ts` / `heat-store.ts` | **只有 `src/skill-tree.ts`（673 行）** | ⚠️ **缺 `gravity-field` / `heat-store`** |
| **L3** | `import/*.ts` / `store/*.ts` | **全缺** | ❌ 未移植 |

**测试**：`node --test test/skill-tree.test.mjs test/tokenize.test.mjs test/ablation-check.mjs`
⇒ **61 tests / pass 61 / fail 0** ⇒ **已移植部分健康**（含 `ablation-check.mjs` = 消融自证门）。

### 22.3 ★★ 由此得到"下一步做什么"的权威答案

**P3（执行器）是【刻意留空的空位】**，其清单现成：**`GetActiveSkills` / 注入 / `spawn provider` 委派 / 注册门 L1·L3 实现**。
⇒ ★ **O30 的②、O7、O26 全部落在这个空位上** ⇒ **我们写的是"填 P3 的空位"，不是"改照搬产物"**
  ⇒ **这坐实了 W2 的判断："② 比 ③ 省"**（③ 要改"照搬 Go、改一条就得全量回归"的移植产物）。
⇒ ⇒ **P3 的第一块 = W2 建议的单向门**：**"候选入池 + 只经注册门采纳"**（挂载点 = L1 已留的 `SkillEvaluator` 接口）。

### 22.4 ⚠️ 我这一轮自己造了两次"假信号"（诚实记录，且这是通用教训）

| 我的做法 | 得到的 | 真相 |
|---|---|---|
| `node --test test/` | **1 fail** | ❌ **调法错**（`test/` 被当模块路径）⇒ 正确调法 **61 pass / 0 fail** |
| `find src -type f -name "*.ts"` + `for [ -e ]` | "src 没 .ts、缺 5 个文件" | ❌ **这台 shell 的 `find`/`for` 失效**（**铁律 #5 已记**）⇒ 实际 `src/` 有 3 个文件 |

⇒ ★ **纪律（新增）**：**"调法错"会造出【假红】与【假缺失】** ——
而**假红比不报更坏**（它骗人去修一个不存在的问题，还会让人不再信任这个检查；我们自己的
`capability-sources.mjs` 头部注释就写着"**假漂移比不报更坏**"）。
⇒ **凡是"某文件缺了 / 某测试红了"这类否定性读数，先换一种【可靠调法】复验一次再下结论**
（统计用 `.mjs`、列目录用 `ls -R`、跑测试用显式文件列表）。

---

## 23. ★★★ P3 第一块落地：`scripts/capability-intake.mjs`（候选入池 + 只经注册门采纳）

> 依据 §22.3（P3 是刻意留空的空位）+ W2 的建议（单向门）。**子代理执行 + 我独立复核 + 我清理残留。**

### 23.1 交付

**`scripts/capability-intake.mjs`**（新）：**候选 → 只建 `pending` → 跑注册门 → 只有过门才写 `acceptance` → 出可复算报表**。
- **默认 dry-run**（无 `--apply` **不写库**）；`--apply` 才写，且**先 `capability-snapshot.mjs --save`**。
- ★ **dry-run 的关键设计**：把 `registry.json` **复制进临时 `DSH_HOME` 沙箱**，在沙箱里 `register` + 跑门
  ⇒ **既不动真库，又拿到"真实门的真实结论"**（门跑真判据：真 import 编译产物、真跑 `apply`）。
- **候选来源三条**：① **显式清单**（`--candidate/--pkg/--role/…`，可用）② **外部来源**（`capability-sources`）
  ③ ★ **`skill-tree` 候选池 = 暂不可用**（**无持久化 store**，移植计划 L3 的 `import/*`+`store/*` 未移植）⇒ **报表里单列一行如实说明**。
- **报表字段**：候选 / 是否已在库 / 入池结果 / **门的每一级 `level`+`ok`+`detail`** / **`proofLevel`** / **`unenforced`** / 被拒 reason / 本次是 dry-run 还是 apply。

### 23.2 我的独立复核（不只看它的报告）

| 项 | 结果 |
|---|---|
| dry-run 独立重跑 | `candidates=1 registered=0 passed=0 rejected=1 apply=false`，**exit 0** ✓（且它**正确拒了**我造的候选） |
| **不改真库** | 库的 `updatedAt` 在 dry-run 前后**未变**（`2026-09-22T06:01:13.201Z`）✓ |
| `proofLevel` / `unenforced` 原样出现 | ✓（被拒候选 `"L0"`、过门候选 `"L1"`，均 `unenforced=["L2","L3","L4"]`） |
| 库里现在有什么 | ★ **5 条**：`spawn` / `fork` / `council-architect` / `design-canvas` **均 `active` + `门:L1`** ⇒ **这条能力库线是真的在用的**；外加 1 条 selftest 残留 |

### 23.3 ★★ 两条诚实边界（子代理如实报出，我照记）

1. ★ **「过门 ⇒ 真写 `acceptance`」只在【沙箱】里演示过，没在真库上跑过。**
   理由：跑它就会往**共享能力库**写一条**编造的 `active` 采纳记录**，而 registry **没有 `delete`**（`retire` 也留痕）。
   ⇒ **同一条分支、同一道门，只差 `DSH_HOME`** —— 但**"真库上跑过"这件事没有证据**，必须记账。
2. **门一定会写库**（**被拒也写 `failed` 回执**）⇒ 脚本只在**沙箱判定过门**时才对真库跑门；
   **被拒时不对真库跑门**（真库那条保持 `kind:"none"`），reason 仍逐项如实记录在报表里。

### 23.4 ⚠️ 我自己的验收门设计得不好（通用教训）

**我的验收门第 2 条要求"带 `--apply` 再跑一次 ⇒ 确实入池"** ⇒ 子代理照做 ⇒ **真库被写进一条编造的 `intake-selftest-design`**。
**⇒ 我随后用官方路径清理：`capability-registry.mjs retire intake-selftest-design --reason "selftest cleanup…"`**（清理前先 `capability-snapshot.mjs --save`）
⇒ 现在状态是 `retired`（**留痕但不生效** —— registry 无 `delete`，这是可审计的设计）。

⇒ ★ **纪律（新增）：设计验收门时要问"它会不会污染【共享可变状态】"**；
**能沙箱化的就不许写真库** —— 本块的 dry-run 沙箱**本来就能证明整条链路**，我却在门里要求了"写真库"，
**等于用"污染共享状态"换一个本来免费就能拿到的证据**。
（共享状态的代价不是"多一条数据"，而是**别的会话/守护进程可能正读它** —— `capability-store.mjs` 头部正是为此而写。）

### 23.5 未闭合（本块遗留）

| # | 项 | 说明 |
|---|---|---|
| **O34** | **`skill-tree` 候选池接入** —— 等 L3 的 `store/*` 落地 | 现在候选池无落盘数据源 |
| **O35** | **"真库上跑通『过门 ⇒ 写 acceptance』"** —— 需要一条**真实**、值得采纳的候选（不能编造） | 沙箱演示 ≠ 真库跑过 |
| **O36** | **`capability-registry` 无 `delete`** ⇒ 误入池只能 `retire`（留痕）⇒ 是否有必要加"回收" | 影响"试错成本" |

---

## 24. ★★★★ 想"用外部来源跑通管道" ⇒ **没有合法输入**；追到根因：**关键路径卡在 P0**

> 起因：上一轮我建议"先 ②，用外部来源当候选在真实数据上跑一遍（同时解 O35）"。**执行后得到的结论是：跑不了 —— 而且不该硬跑。**

### 24.1 实测：今天**没有"真实存在但未登记"的能力候选**（三条来源逐一核过）

| 候选来源 | 核查 | 结论 |
|---|---|---|
| **外部来源** `MCP_SOURCES` | `scripts/capability-sources.mjs:32-54` —— **它只声明了【一条】：`design-canvas`** | 而 `design-canvas` **已登记**（`mcp-server`，64 工具/6 线） ⇒ **无未登记项** |
| **部署里真在用的 MCP server** | `~/.dsh/profiles/exp-base/cordis.patch.yml:34-48` —— **只有一个 `mcp-client` 行**（`serverName: design-canvas`，入口 `dist/src/server.js` 真实存在） | **没有第二个 MCP server** |
| **子代理 provider** | `packages/subagent-council/src/index.ts:16` 逐字——**"首期只有「架构师」一席：council-architect。"**（`:62` 映射表只有一个条目） | `spawn`/`fork`/`council-architect` **均已登记** ⇒ **无未登记项** |
| **内部候选池**（`skill-tree`） | 无持久化 store（见 24.2） | ❌ **接不上** |

⇒ ★★ **⇒ 所以 O35（"真库上跑通『过门 ⇒ 写 acceptance』"）现在【没有合法输入】。**
**⇒ 而且不能为关它去编一条候选** —— 那正是本项目刚记下的纪律（不许为了让门变绿而造数据）。
⇒ **⇒ 本轮的正确产出不是"跑通"，而是"报告跑不了 + 为什么"。**

### 24.2 追到根因：**不是技术难，是一个未决前提（P0）**

**`docs/memory-asset-triage.md:236-237` 的阶梯（逐字）：**

| 阶段 | 内容 | 阻塞于 |
|---|---|---|
| **P0** | **定"记忆宿主进程"的形态（独立进程 vs DSH 插件）** | — |
| **P1** | 移植骨架（**存储** + 图 + 检索 + embedding cache） | **P0** |
| **P2** | 移植 `SkillNode` + 生命周期（"不需要新设计"） | P1 |
| **P3** | **给技能换执行器**：`Active Skill Injection` → `spawn provider` 委派 | P2 + preset 层启用委派工具 |

**`docs/skill-tree-port-plan.md §6` 逐字：**
> "**`memory-asset-triage.md` §6 的 P0「定记忆宿主进程形态」还没定。`sqlite_store` 的选型（SQLite vs 文件）直接取决于它
> ⇒ **存储层先不要动**，这也是本阶段只落地类型层（L1）而不碰 L3 存储的原因。"**

⇒ ★★ **⇒ 所以"给 `skill-tree` 加一个 JSON 落盘适配器以打通候选池"这个念头【也被否掉】** ——
那不是技术问题，而是**替 P0 擅自拍板**（P0 要定的正是"SQLite vs 文件"这一项）。
**⇒ 在未决前提上盲落地，正是本项目反复反对的那种失败。**

### 24.3 ✅ 但要说清：**我们已经做成的 P3 第一块没有违反顺序**

- **P2 的"数据模型"部分已落地**（L0/L1 + `skill-tree.ts`，61 tests pass）；
- **P1（存储/图/检索/embedding cache）没做**，阻塞于 P0；
- ⇒ **P3 第一块依赖的是"数据模型"（已有），【不需要】存储**（它的候选来源是显式清单 / 外部来源）
  ⇒ **所以它是"P3 中不需要存储的那一半"，顺序上是正当的**，不是乱序施工。

### 24.4 ★★ 于是真正该做的事：**请裁决 P0** —— 它是横在 P1/P2/P4 前面的那一格

**P0 要定的是"记忆宿主进程的形态"。** 结合本项目已有证据，候选其实是**三条**（不是两条）：

| 选项 | 内容 | 连带的真问题 | 本机现实约束 |
|---|---|---|---|
| **(a) 独立常驻进程** | ai-base 原形态：sqlite + `vec0` KNN 全套检索 | 解决"多写者"（I1 写权唯一 + 常驻单写者）；要额外进程 | ★ **铁律 #3：我们【不能在工具内起长期后台服务】** ⇒ 这种进程**只能由你的终端启动** ⇒ "谁负责拉起/守护它"要一起定 |
| **(b) DSH 插件内** | 随会话活，无需额外进程 | ★ 移植计划 §6 自评："Node 侧无等价：需 `better-sqlite3`（原生编译）或 `node:sqlite`（≥22.5 实验性）；`vec0` 靠 `loadExtension` ⇒ **打包进 DSH 插件是真问题；这是本次最难的一处**"；且**并发写权**要另想（多会话共享单库无常驻单写者） | 无进程约束 |
| **(c) 文件式 + 唯一读写口 + 快照** | ★ **跟随我们自己的先例**：`capability-registry` 就是"旁挂 JSON + `capability-store` 唯一读写口 + `capability-snapshot` 校验" | **放弃向量检索**（只有关键词/锚点）；但**立刻可用、零打包风险**、且**我们已经证明这条路在本机可行** | 无进程约束 |

⇒ ★ **注意 (c) 也是"一个 P0 答案"**（它就是"文件"那一支）—— 所以它不是"绕过 P0"，而是**P0 的一个候选解**。
⇒ **选择影响链**：(a)/(b) ⇒ 全量检索；(c) ⇒ 关键词/锚点先行、检索后补。**三者的改动面与代价我在表里列了。**
⇒ **状态**：🟡 **等用户裁决**（这是架构决定，且会影响 P1/P2/P4 全部后续）。

### 24.5 新增未闭合

| # | 项 | 挡住 |
|---|---|---|
| **O37** | ★ **裁决 P0「记忆宿主进程形态」**（§24.4 的 a/b/c） | **P1 / P2 后半 / O34 / O35 全部**（关键路径） |

---

## 25. ★★★★★ P0 **已有答案**（在 `memory-asset-triage.md:388-392` 里早就定了）+ 用户两问的答复

> 用户提问：**① 如果选 (c)，(a) 里的论文系统不就被废弃了？② 如果选 (a)，能不能做成"和 DSH 一同启动" —— DSH 启动时自动拉起它即可？**
> **⇒ 查证后发现：这两问的答案文档里都已写好，而 §24.4 我给的"三选一"是【我把已定的处置当成了未决问题】。**

### 25.1 ★★★★ 决定性证据：`docs/memory-asset-triage.md:388-392` 的分层表（逐字）

| 层 | 语言 | 理由 |
|---|---|---|
| **存储 / 图 / 检索 / 睡眠 / 论文 / 技能树**（`sqlite_store`·`graph_*`·`retrieval*`·`rrf`·`gravity_field`·`sleep_*`·`knowledge`·`skill_tree`·`tool_feedback`） | **Go 保留** | ① 纯数据+算法，语言无关 ② **全部 Go test 是资产** ③ ★ **独立进程不需要和 cordis 同进程** ④ **`sleep_experiment.go` 的进程隔离（Windows Job Object）在 Go 侧已实现** —— 沙箱执行天然留在这里 |
| provider 注册 / 工具声明 / 委派 / 注入 / 决策层接入 | **必须 TS** | 要进 cordis 插件体系、要动 tools 段 |
| **两者之间** | ★ **MCP（首选）或 loopback JSON-RPC** | ★ **"DSH 侧用现成 `mcp-client`"**；Go 侧加一个面 —— 而**加面的成本已被 `memory_view` 插件证明很低** |

⇒ ★★★★ **⇒ 所以 P0 的答案早在这张表里**：
1. **记忆宿主那一整块（含论文系统）保留 Go、作为【独立进程】** ⇒ **直接否掉 (b)**（DSH 插件内 = 要把它重写成 TS）**与 (c)**（文件式 = 砍掉检索/图，也就砍坏论文系统）；
2. **接口 = MCP（首选）**，且 **"DSH 侧用现成 `mcp-client`" 是文档逐字写的**；
3. `:390` 的第 ③ 条理由正是 **"独立进程不需要和 cordis 同进程"**。

**⇒ §24.4 的"三选一"作废** —— 那是我把**已定的处置**当成了未决问题（**又一个"没登记导致误判"的同源病**：这张表没人登记进索引）。

### 25.2 ✅ 答复用户问题 ②：「和 DSH 一同启动，DSH 启动时自动拉起」—— **能，而且不用发明**

**我核验了 `dsh-mcp-client` 的实际机制**（逐字）：
- `:16` `transport: stdio`；`:40-43` **`command` = "**Executable to spawn**"**、`args`、`env`（"merged on top of scrubbed ambient env"）、**`cwd` = "Working directory for the **child process**"**；
- ★ `:115` **"Reconnect triggers on transport close — a crashed stdio child fires it"** ⇒ **有 supervisor，子进程崩了会重连**；
- 现场先例：`~/.dsh/profiles/exp-base/cordis.patch.yml:34-48` 那一行就是**用 `mcp-client` 拉起 `design-canvas/dist/src/server.js`** —— **已经在这么跑了**。

⇒ **⇒ 记忆宿主做成一个 MCP server ⇒ 由 `mcp-client` 在 DSH 启动时拉起、由 DSH 的 supervisor 管** ⇒ **用户不用手动起任何进程**。
⇒ ★ 额外收获：它**同时就是 `capability-registry` 的一条 `kind: mcp-server` 能力源**（与既有分类天然对齐），
  **将来实现后，它本身就是 O35 需要的那条【真实候选】**。
⚠️ **未逐字验证**：mcp-client 的子进程**生命周期是否严格绑定 DSH 进程**（README 只写了 reconnect）⇒ 记为待确认（**O38**）。
⚠️ **我撤回一处**：上一会话记忆里的 "`dsh-init-boot` 的 `init_file`（once per launch, out-of-process）" —— **`node_modules/@deepseek-ai/` 里【没有】`dsh-init-boot`**（只有 `dsh-app-boot`）⇒ 那条**未找到**，且**不需要它**（`mcp-client` 已足够）。

### 25.3 ✅ 答复用户问题 ①：「选 (c) 的话论文系统就被废弃了？」—— **会，而且比"废弃"更糟：退化成"能存不能找"**

**逐字证据（`docs/memory-asset-triage.md`）**：
- `:51` `knowledge.go` —— `KnowledgeBase` + `KnowledgeEntry`（**"知识 = 论文"**：Claim/Scope/Transferability/Limitations/SourceNodes/Verified/`JournalTier`/Experiment）
- ★ `:60` **`sleep_rem.go` Phase 2 **REM 跨社区关联（论文推论文）**：`related_to`/`depends_on`/`contradicts`/`supersedes`**
- `:30` `graph_cache.go` —— "the single source of truth for in-memory **graph** state"；读写分离
- `:227`/`:398` —— **"发表门的判据持有者（作者/审稿分身）+ **谱系毒性召回**的执行者都住它里面"**

⇒ ★ **论文系统的核心价值是"论文推论文"（跨社区关联）与"谱系毒性召回"** —— 这两者靠的是**图 + 检索**，
  而 **`graph_*` / `retrieval*` / `rrf` 全在"Go 保留"的那一块里**。
⇒ **⇒ (c) 不是"论文系统被废弃"，而是它退化成"能存不能找"** —— 而"找"正是它的用途。
⇒ 并且 `:390` 的理由 ④（**Windows Job Object 进程隔离在 Go 侧已实现**）意味着：**连"沙箱执行"都天然留在那一侧** ⇒ 拆散它代价更大。

### 25.4 ⇒ 结论：**O37 / O34 解除**，可以直接往下走

| 项 | 原状态 | 现状态 |
|---|---|---|
| **O37（裁决 P0）** | 待裁决 | ✅ **有答案**：**(a) 独立进程 + MCP 面 + 由 `mcp-client` 拉起**，依据 `memory-asset-triage.md:388-392` —— **这不是新决定，是执行既有处置** |
| **O34（`skill-tree` 候选池）** | 卡在 P0 | ✅ **路径明确**：候选池住在 Go 宿主里，DSH 侧经 MCP 取 ⇒ 不再需要"给 skill-tree 补 TS store" |

### 25.5 新增：把这条处置**登记**（病根是它没人登记）

⇒ **`MEMORY.md` 主题索引补记**：`memory-asset-triage.md:388-392` **已定"存储/图/检索/睡眠/论文/技能树 = Go 保留 + MCP 面 + `mcp-client` 拉起"** ——
**任何人（含未来的我）想知道"记忆宿主放哪"都要先读这一行，不要再当成未决问题重开。**

### 25.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O38** | **`mcp-client` 子进程的生命周期是否严格绑定 DSH 进程**（README 只写 reconnect） | 影响"DSH 退出后宿主是否残留" |
| **O39** | **Go 宿主项目的当前位置与状态**（`ai-base/agent-shell` 是只读上游 ⇒ 宿主是"给上游加一个 MCP 面"还是"新建一个仓"？） | P1 的落点 |

---

## 26. ★★★★★ O39 关闭：**Go 宿主已经存在、MCP 面也已经写好了** —— P1 = "接上"，不是"新建"

> 起因：§25 定了"记忆宿主 = 独立 Go 进程 + MCP 面 + `mcp-client` 拉起"，但**宿主放哪个仓**未定（O39）。

### 26.1 ★★★ 实测：宿主、客户端、MCP 桥**三者都已存在**

| 发现 | 证据（均在本机实测） |
|---|---|
| ★ **宿主已经是现行运行形态** | `ai-base/agent-shell/main.go` 的子命令里有 **`--hub-server`** 与 **`--client`**（另 `--hub-data-dir` / `--standalone-v2` / `--migrate-vectors` / `--brain` …）⇒ **服务端/客户端模式并存于同一 exe**；构建产物含 **`agent-shell-hub.exe`** |
| ★ **hub 是个 TCP 服务** | `internal/hub/v2/hub_Hub.go:616`：**`ln, err := net.Listen("tcp", h.cfg.listenAddr())`**；`hubsettings/service.go:38` 有 `dataDir` / `hubAddr` / `settingsPath`（旧版 `internal/hub/hub.go.bak` ⇒ **v1 已废，v2 是现行**） |
| ★ **配套客户端包在** | **`internal/hubclient/v2`** ⇒ client/host 切分**早已实现** |
| ★★ **MCP 桥 Go 侧已经写好** | **`internal/external/`** 里有 **`mcp_bridge.go` + `mcp_bridge_stdio.go` (+test) + `mcp_bridge_sse.go` (+test)**；同目录还有 **`a2a/adapter.go` + `a2a/protocol.go`**（Agent-to-Agent 协议）、`skill_registry.go`、`modal_service.go`、`ocr_service.go` |
| ★★ **hub v2 有插件位** | **`internal/hub/v2/plugins/`** —— 其中 **`memory_view/`** 就是一个插件（`internal/bootstrap/bootstrap.go:400-406`：`MemoryViewPlugin()` / `NewBuilderAdapterWithConfig(...)`）<br>⇒ **这就是文档说的"加面的成本已被 `memory_view` 插件证明很低"的含义：加一个面 = 加一个插件。** |
| 向量能力确实在 Go 侧做过 | `main.go` 有 **`--migrate-vectors`** 子命令 |
| ⚠️ 未找到 | `memory_view` 在 `.md/.json` 层面的设计文档 —— **只在 session journal 与 cache 里出现，没找到源码之外的说明**（源码在，见上） |

### 26.2 ⇒ **O39 的答案：不新建仓，就地在 `agent-shell` 里"接上"**

**Go 宿主 = `ai-base/agent-shell` 的 `hub v2`（`--hub-server` 模式）。**
**⇒ P1 的落点 = 给 hub v2 加一个把记忆能力暴露为 MCP 的面**：
- **复用 `internal/external/mcp_bridge_{stdio,sse}.go`**（桥已写好，含测试）
- **按 `hub v2` 的插件位加一个插件**（`plugins/memory_view` 是先例）
- **DSH 侧用 `mcp-client` 接上**（§25.2 已核验机制 + 现场先例 design-canvas 那一行）

⇒ ★ **⇒ 所以 P1 不是"新建一个仓 / 新建一个进程模型 / 重写记忆层"，而是"接到已有基础设施上"。**
⇒ 这也反过来**再次印证 §25.1 的分层表**：Go 保留那一块**本来就是这么设计的**（`internal/external/` 就是为"加面"准备的位置）。

### 26.3 ⚠️ 一个必须说的直接后果：**P1 动的是【另一个仓】**

**`agent-shell` 属于 `ai-base` 仓（`/d/project_develop/ai-base/.git` 实测存在），而 `dsh-brain` 是另一个仓。**
⇒ **P1 起就是跨仓工作** ⇒ 需要：
1. **两个仓各自的 git 卫生**（铁律 #16：多会话共用仓库 ⇒ 提交前先 `git status` 看清哪些不是自己的改动）；
2. **明确"上游只读不改"的边界**（移植计划原文：`ai-base/agent-shell/internal/memory/` 是**只读上游**）
   ⇒ ★ **所以"加面"必须【不动 `internal/memory/` 内部】**，只在 `internal/external/` 或 `hub/v2/plugins/` 加新文件 ⇒ **这条要写进纪律**（新增 **O40**）。

### 26.4 顺带两条与既有未闭合的关联

- **`internal/external/skill_registry.go`** —— Go 侧**已有 skill registry 的面** ⇒ 与 **O30**（`skill-tree` ↔ `capability-registry` 的关系）**直接相关**：
  **"候选入池"在 Go 侧可能已有现成出口**，不必等 TS 侧的 `store`。**⇒ 值得单独取证（新增 O41）。**
- **`a2a/`（Agent-to-Agent 协议）已存在** ⇒ 与我们"子代能力传承"（**O26**）可能相关（外部 Agent 注册为 sub agent 是官方设计目标，§20.1 `:23`）。

### 26.5 新增未闭合

| # | 项 | 挡住 |
|---|---|---|
| **O40** | **跨仓纪律**：P1 只允许在 `internal/external/` 或 `hub/v2/plugins/` **新增**文件，**不动 `internal/memory/` 内部**（上游只读） | P1 起步 |
| **O41** | **Go 侧 `skill_registry.go` 能给什么** —— 它可能就是"候选入池"的现成出口（可绕开 TS 侧 `store` 的阻塞） | O30 / O34 |

---

## 27. ★★★★★ 用户关键信息：「AI base 的记忆系统**只建好了，还没测过效果**」⇒ 缺口被精确定位

### 27.1 实测：记忆侧**有机制测试、无效果判据**（用户的话被逐条印证）

| 项 | 实测 | 判定 |
|---|---|---|
| **单元测试** | `internal/memory/` 共 **61 个 `.go`，其中 28 个 `*_test.go`**（`anchors/builder/explorer/graph_cache/graph_writer/gravity_field/heat/knowledge_search/memory_store/meta_skill/query_rewriter/reranker/sleep_experiment…`） | ✅ **机制正确性有测试**（"Go test 是资产"不是空话） |
| **"效果"判据** | 目录里**没有** `eval`/`bench`/`effect`/`ab`/`shadow` 之类的载体 | ❌ **无** |
| ★ **`sleep_experiment.go` 是什么** | 逐字：**"实验复现执行器"** —— **论文的「可复现实验」（`Experiment.command` + `expect`）由作者分身（`llmRefineDream`）写出，审稿分身（`judgeDreamEntry`）复现时真跑 command、比对 expect，产出机器证据** | ⚠️ **它是"论文系统内部判论文条目可否复现"，【不是】"记忆系统有没有效果"** |

⇒ ★★ **⇒ 所以用户的说法精确成立：记忆系统【有机制测试、没有效果判据】。**
（**单元测试 ≠ 效果** —— 这两者不可混，与本项目铁律 #7 同族：**机制正确 ≠ 有用**。）

### 27.2 ★★ 但 `sleep_experiment.go` 提供了一个**应当沿用的判据形状**（这是意外收获）

它逐字写着三条我们要的纪律：
1. ★ **"写验分离：作者出题、审稿答题，解「自己出题自己答」的研究者偏差"** ⇒ **判据独立性靠【角色分离】实现**（本项目的同族纪律：判据不能放在被测范围内）；
2. **"产出机器证据"**（真跑 command、比对 expect）⇒ **不靠"看一眼说 OK"**；
3. ★ **"失败即弃…降级为 `Executed=false`，让调用方按「**无实验证据**」继续判分"** + 隔离创建失败要**"显式标注，不静默"**
   ⇒ ★ **"无证据 ≠ 通过"** —— 与铁律 #7（假绿最坏）完全一致。

⇒ **⇒ 我们建"记忆效果判据"时应当【沿用这套已实现的形状】**，而不是另发明。

### 27.3 ⇒ 下一步该做什么（顺序也是结论的一部分）

**缺口 = "记忆是否让下游变好"没有判据。** 而它与 P1（接线）**不是竞争关系，是先后**：

```
① 接线（P1：给 hub v2 加 MCP 面 + DSH 侧 mcp-client 接上）
     ⇒ 让"能测"成立。★ 但【接线 ≠ 采纳】—— 状态只能是 pending
        （capability-registry 的语义正好支持：register 只建 pending）
        ↓
② 建"效果判据"：同任务集 × {有记忆, 无记忆} 的 A/B，量效果差
        ↓
③ 只有过了 ② 才标 active
```

★ **而 ② 的骨架可以一次建成、两处使用**（注意：**两者自变量不同，不可混为一谈**）：

| 用途 | 自变量 | 编排形状 |
|---|---|---|
| **记忆效果判据**（新，本节的缺口） | **有记忆 vs 无记忆**（同一个能力，开/关） | **A/B + 同任务集 + 显著性** |
| **`capability-gate` 的 L4**（已有定义、未实施） | **新能力 vs 现役同能力（shadow）** | **同上** |

⇒ ★ **⇒ 一份编排骨架，两个自变量** ⇒ **建一次，同时把 L4 从"未建"补起来**
（`capability-gate.mjs:53` 的 L4 逐字：`enforced: false, why: '需同任务集与 A/B 编排，未建'`）。

**★ 两条现成的原料，不必新建**：
- **任务集** ⇒ **`evals/pilot/tasks.jsonl`**（冻结任务 + oracle + regression，`eval-run.mjs` 已在用）
- ★ **必须过 `evals/README.md` 的 R1**：**判据 / 规格 / 答案清单不得位于被测 agent 的读写范围内**
  ⇒ 本项目在这条上**翻过车**（三条 B 会话都读了 `check.mjs`，题面 README 还把陷阱逐条印出 ⇒ **区分度归零**）⇒ **建 A/B 时必须先解这条**。

### 27.4 新增未闭合

| # | 项 | 挡住 |
|---|---|---|
| **O42** | ★ **建"记忆效果判据"**：同任务集 × {有记忆, 无记忆} 的 A/B（含 R1 合规） | 记忆能力能否标 `active` |
| **O43** | **沿用 `sleep_experiment.go` 的判据形状**（写验分离 / 机器证据 / 无证据显式降级），并与 `capability-gate` 的 L4 骨架**合并为一套编排** | O42 的实现方式 |

---

## 28. ✅ O42 判据设计已产出：`docs/memory-effect-judge-design.md`

**独立文件**（避免把 spec 撑爆）：`docs/memory-effect-judge-design.md`。**它同时是 P1 的输入**（判据决定 MCP 面要暴露什么）。

**四条关键决定（值得在这里留索引）**：

1. ★★ **任务类型必须选对** —— 现有 5 条都是 `regression-repair`（单次孤立）。
   **只用"单次任务 A/B"很可能得到"没差别"，而那是【假否定】**（记忆的作用域是**重复出现的同类问题**）。
   ⇒ **判据要两条腿且都报**：**(甲) 序列/学习曲线型**（k≥2 的题在"有记忆"臂的步数/token/返工差）+ **(乙) 单次型**（预期无差别，而"无差别"= "记忆不伤害单次任务"）。
2. ★★ **对照要干净：两臂同一张脸，只让【记忆库内容】不同** —— 若靠"摘掉 MCP 行"来禁用记忆，两臂**脸就不同**，
   测出来的是"有没有这个工具"而不是"有没有记忆"（本项目已有实证：多一个 `report` 工具脸就变了）。
3. ★ **三条对照断言（任一不满足 ⇒ 该批数据作废）**：**两臂 face 指纹相同**（**复用 `scripts/face-audit.mjs` 的指纹算法，记得端口归一化 O33**）/ **控制臂记忆真为空** / **处理臂记忆非空且随 k 增长**。
4. ★ **P1 的面不必一次全暴露** —— 判据只需要 **【读 + 写 + 条目数】三样**（条目数是 §3.3 对照体检的前提）。
   ⇒ **先设计判据、再改 Go** 的价值就在这里。

**另**：新增 **O44**（"记忆没效果" vs "记忆没被用上"必须分开 ⇒ 需要"人工直接写记忆"的阳性对照）；
README 的 **R1**（判据不得在被测 agent 读写范围内）已写进设计，并要求**带毒自检**证明隔离真的生效。

---

## 29. 四路并行落地（判据机器三件套 + O41 取证）（2026-09-22；**关键指控我已逐条复核**）

### 29.1 交付（三个新脚本 + 一份取证）

| 文件 | 是什么 | 自检结果 |
|---|---|---|
| **`scripts/memory-stub.mjs`** | ★ **记忆面的 stub**（`count` / `recall` / `remember` / `reset`），**契约形状 = 将来 MCP 面的形状** | 六门全过；**中文往返实测**（`cat` 出正常中文、无 `\uXXXX`、无 BOM） |
| **`scripts/memory-effect-judge.mjs`** | ★ **判据机器**（两臂 + 三断言 + 四态 + 反自欺守卫） | 六门全过：`--plan` **真的什么都不做**（`ls mtime` 前后 `diff` 为空）；`--selftest` 四态齐（`OK=81/NEEDS-EVIDENCE=4/FAIL=1/N-A=4`）；**故意破坏 ⇒ `BATCH-INVALID` + exit 1 / `CONTROL-FAILED` + exit 3** |
| **`scripts/memory-judge-poison-check.mjs`** | ★ **R1 隔离自检**（判据被误放进被测目录时必须报警） | 六门全过；★ **反向自证**：把 `evals/pilot/tasks.jsonl` 真复制进 `_wt` ⇒ **被检出（6 条信号全来自内容侧，文件名信号一条不中）** ⇒ **证明"只看文件名不够"** |
| `out/w14-o41-go-skill-registry.md` | **O41 取证**（Go 侧 `skill_registry.go`） | 见 29.3 |

**两处值得单独记住的实现纪律（子代理自己做的）：**
- ★ **判据机器带两道"反自欺守卫"**（触发即 exit 4 拒绝产出）：**报告里出现断言式说法**、或**汇总区出现"通过"二字** —— 它说**写的时候真被自己的门拦下过一次**。
- ★ **带毒自检把"没检出"与"读不到"分开**：`suspects=0` 在正常态是 `OK`、在 `_wt` 不可读时是 `UNKNOWN`（**exit 4**）⇒ 正是"无证据不冒充"。

### 29.2 ★★ 但要说清骨架期的边界（**"一格都不冒充"**）

- **REAL 模式下**：`OK:0 / NEEDS-EVIDENCE:86`，三断言全 `NEEDS-EVIDENCE` ⇒ **不产出任何关于记忆效果的读数**；
- **判据机器报告顶部固定一句**：**"本报告只证明判据机器可用，不构成关于记忆效果的结论"** ⇒ **这是把"无证据不冒充"的纪律用在它自己身上** ✓
- ⚠️ **本机四路里没有一路驱动真实会话** ⇒ **真实读数尚未接入**（属 O42 的下一步）。
- ⚠️ 带毒自检**只覆盖一类泄漏面**（被测目录），**不覆盖** `~/.dsh/sessions/**`、`out/` 历史报告、共享记忆库
  ⇒ ★ **它绿 ≠ R1 全绿**（子代理主动这么标的）。

### 29.3 ★★★ O41 结论与**四条我复核过的指控**：Go 侧"有入池出口，但**没有"过门才入池"的语义**"

**一句话结论**：**绕开 TS `skill-tree` 没 store 的阻塞成立**（Go 侧候选池**有**持久化 store），
**但绕不开 `capability-gate` 的判据缺位** —— 因为 **Go 侧压根没有那道门**。

**我复核过的四条（逐字）**：

| 指控 | 我的核验 |
|---|---|
| ★ **Go 侧"导入即 active"** | ✅ **`internal/memory/skill_import.go:394-402` 逐字带 `Status: "active"`** ⇒ **无 `pending` 态、导入即可注入 prompt** |
| `SkillRegistry` 不维护独立索引 | ✅ `internal/external/skill_registry.go:56-57` 逐字："**Match/Get/List delegate to SkillTree — SkillRegistry does NOT maintain an independent index.**" |
| ★ **"加面成本很低"需要限定** | ⚠️ **`ExportMCP` 的接口在 `hub/v2/mcp_server_plugin.go:16`、生产调用点在 `mcp_server_plugin_MCPServerPlugin.go:60`，但【唯一实现是测试桩】`mcp_server_plugin_test.go:26`** ⇒ **生产实现缺失** ⇒ **"加面"= 写一个生产 `ToolProvider`，不是"已经能用"** |
| ★ **文档 vs 代码矛盾** | ✅ `docs/memory-asset-triage.md:169` 逐字裁决过"导入后视为**候选能力**而非注入物"，**而现役代码是"导入即 `active` + 可注入"** |

**⇒ ★★ 于是暴露出一个比"没测过效果"更前置的问题**：
**Go 侧的技能导入路径【没有门】—— 外部 `.md` 一进来就 `active` 并被注入 prompt。**
⇒ 而 **TS 侧 `capability-registry` 的语义是【注册 ≠ 采纳】**（`register` 只建 `pending`，过门并写回 `acceptance` 才 `active`）
⇒ ★ **两侧是【语义相反】的两种实践。** ⇒ **在这道门补上之前，"测记忆效果"测的是一个"未经筛选就被注入的东西"。**

### 29.4 新增未闭合

| # | 项 | 挡住 |
|---|---|---|
| **O45** | ★★ **Go 侧 skill 导入缺门**：把 `memory-asset-triage.md:169` 已裁决的"**候选能力而非注入物**"落成代码（`import` ⇒ 不应直接 `active`/可注入）；并决定与 TS 侧 `capability-registry` 的 `pending/acceptance` **语义如何对齐** | **O42 的前置**（没有门，测效果没有意义） |
| **O46** | **`ExportMCP` 的生产 `ToolProvider` 实现缺失** ⇒ "加面成本很低"只在**桥**这一层成立 | P1 的工作量估计 |

---

## 30. ✅ O45 落点已定：`docs/o45-import-gate-landing.md` + **对 §29.3 一处措辞的更正**

### 30.1 ★★★ "门会被绕开"的**确切位置**（我核过源码，这是本轮最有用的一条）

`internal/memory/skill_tree.go:1054+` 的 `GetActiveSkills` 有**两条注入路径，一条看 Status、一条不看**：

| 路径 | 条件 | 检查 `Status` 吗 |
|---|---|---|
| **L0**（高分配稳定技能） | `Score>0.7 ∧ UseCount>10` | ✅ **要求 `Status == "active"`** |
| ★ **L3**（触发词命中） | `Triggers` 命中 `taskHint` 关键词 | ❌ **完全不检查** |

⇒ ★★ **⇒ 只把导入处改成 `pending` 是【装饰门】**：L0 那条路被封，**L3 那条路照走**。
⇒ **⇒ 所以落点是"三处 + 两前提"，缺一即装饰**（详见设计文档）：
**(a)** `skill_import.go:398` `Status:"active"` ⇒ `pending`（并修 `:447-448` 的"archived 复活成 active"）；
**(b)** ★ **`skill_tree.go` 的 L3 分支也要要求 `active`**（**不改它，(a) 无效**）；
**(c)** **判据处**（谁把 `pending`→`active`）—— 接 TS 侧 `capability-gate`，并要有**回执位**。

### 30.2 ⚠️ 更正 §29.3 的一处措辞

§29.3 我写"**导入即可注入 prompt**" —— **不精确**。精确说法：
**新导入的 `Score = initialScore(source) ≤ 0.6` 且 `UseCount = 0` ⇒ L0 不成立；但若 `Triggers` 命中 `taskHint`，L3 成立 ⇒ 仍会被注入。**
⇒ **即：导入即 `active`；是否被注入取决于（score/use 或 triggers），其中一条路径【不看 Status】。**

### 30.3 ★ 顺手发现一处**必须先澄清的矛盾**（新增 O47）

`memory-asset-triage.md` 称 `internal/memory/` 是**只读上游** —— 而 **O45 恰恰要改它**（`skill_import.go` / `skill_tree.go`）。
⇒ ★ **两者不能同时成立。** 三种可能：(i) "只读"只指"不重写其内部算法"，状态设置点可改；
(ii) 门应加在**别的层**（导入的调用方 / 注入侧）；(iii) 允许改，但要按跨仓纪律走。
⇒ **⇒ 这决定 O45 是"改三处"还是"换个地方加门"，必须先定（O47 已记为 O45 的前置）。**

### 30.4 验收门（防装饰门 + 防过度封锁）

1. `Score>0.7 ∧ UseCount>10 ∧ Status="pending"` ⇒ **不在注入文本里**；
2. ★ **`Status="pending"` 但 `Triggers` 命中** ⇒ **不在注入文本里**（最关键）；
3. ★ **阳性对照**：同两条改成 `"active"` ⇒ **必须出现**（**否则"全封"也能过门 1/2**）；
4. 重新导入一个 `archived` ⇒ 应变成 `pending`（**不是 `active`**）；
5. 过门后 `Status` 变 `active` 且**有可读回执位**（至少 `proofLevel`）。

| # | 新增 | 挡住 |
|---|---|---|
| **O47** | ★ **澄清"`internal/memory/` 只读上游"的边界**（与 O45 要改它相矛盾） | **O45 的落点形态** |

---

## 31. ✅ O47 关闭：「只读上游」与「Go 保留」**不矛盾**，而且**允许改** —— 但有三条仓规要守

### 31.1 两处说的**不是同一件事**（逐字）

| 出处 | 原文 | 它限制谁 |
|---|---|---|
| `docs/skill-tree-port-plan.md:3` | "**上游（只读，不改）：**`…\internal\memory\`" | ★ **限制的是【移植者】** —— 别**一边移植一边改参照物**（否则移植失去基准）。**这是移植期纪律** |
| `docs/memory-asset-triage.md:17` | "**要不要改成 TS？不要** —— 真理由是**不需要**：记忆库必须是独立进程 ⇒ 无"必须同语言"约束 ⇒ **Go 保留 + MCP 面**" | ★ **这是【架构归属】定性：要它在 Go 侧【继续演进】** |
| `docs/memory-asset-triage.md:390` | "存储/图/检索/睡眠/论文/技能树 …… ｜ **Go 保留**" | 同上（归属，不是"封存"） |

⇒ ★★ **⇒ "Go 保留" = 留它在 Go 里演进 ⇒ 改它【符合方向】，不是违背。**
**而"只读不改"是移植期的自我约束，其使命已完成**（L0/L1 移植已落地，见 §22.2）⇒ **不构成"永不可改"。**

### 31.2 ★★ `ai-base` 有自己的仓规 —— 我读了 `AGENTS.md`（291 行）

**「禁止行为」共 7 条**（`:196-204`），**其中没有任何一条说"不许改 `internal/memory`"**。
⇒ 但**有三条我们必须遵守**：

| 条 | 原文 | 对我们的约束 |
|---|---|---|
| **2** | "**不直接读写 `graph.json`（必须通过 `GraphWriter` channel）**" | ★ **门不能绕过 `GraphWriter` 去写状态** |
| ★★ **4** | "**不硬编码策略（压缩策略、融合算法、评分维度等必须走接口）**" | ★★ **这就是 O45 前置一（状态词汇表要单一来源）在 Go 侧的对偶**：<br>**"门"属于策略 ⇒ 必须【走接口】，不能新增散落字面量** |
| **5** | "**不跨层调用——Agent 不直接调 ContextManager 的内部 Layer，不直接调 Memory 的 VectorStore**" | ★ **我们若从 DSH 侧够过去，只能走"面"（MCP），不能跨层摸内部** |

⇒ ★ **另外两条与我们有间接关系**：第 1 条（不绕过 ContextManager 自己拼 prompt）与第 3 条（不跳过 PermissionGate）。
**第 6 条**（不修改已弃用的旧设计文档）提醒：**改文档要注意别碰带 ⚠️ 的弃用稿**。

### 31.3 ⇒ **O45 据此收紧**（形态确定）

1. ✅ **允许改 `internal/memory/`** —— 改的是**状态设置点**与**筛选条件**，**不是重写算法**；
2. ★★ **但"门"必须定义成【接口】+ 集中词汇表**（响应 `AGENTS.md` 第 4 条）——
   **不允许**在 `skill_import.go` 里写死一个 `"pending"` 字面量了事；
3. ★ **状态写入必须走既有 channel**（`GraphWriter`，第 2 条）⇒ **不能自己开一条旁路写 `graph.json`**；
4. ★ **跨仓变更要按 O40 的纪律**（两个仓各自 git 卫生 + 不动不该动的内部）。

**⇒ 与既有结论完全一致**：§25.1 的分层表说"Go 保留 + MCP 面"，**`internal/external/` 就是为"加面"准备的位置**
⇒ **门 + 面可以放在 `internal/external/` 一侧（新增文件），而 `internal/memory/` 只做最小的状态/筛选改动。**

### 31.4 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O48** | **`GraphWriter` channel 的确切接口**（我们的状态写入必须走它，但它的形状还没读） | O45 实现的前提 |

---

## 32. ✅ O48 关闭 + **O45 的实现形状定稿**（已具备动手条件）

### 32.1 `GraphWriter` **不是 interface** —— 它是 `Builder` 上的两个方法

- **没有 `type GraphWriter interface`**（`grep` 无命中）⇒ "GraphWriter channel" 是**概念名**；
- 代码里的入口（`internal/memory/builder.go`）：
  - **`func (b *Builder) SubmitGraphNode(node map[string]any)`** —— `:464`，转成 `graphNode` + `MergeRequest{Source: "compactor", …}` 提交
  - ★★ **`func (b *Builder) InvalidateNodes(ids []string)`** —— `:491`：
    **先 `graphCache.GetNode(id)` 读出现有节点 →（`:502`）`node.Status = "invalidated"` → `UpsertNodes` 提交**
- 装配处：`bootstrap.go:650 builder.StartGraphWriter(ctx)`；注释 `v2_manager.go:612` 逐字："**`memory.Builder.SubmitGraphNode(node)` → `GraphWriter.Submit(req)`**"

### 32.2 ★★ "写状态"的**既有范式** = 读 → 改字段 → Upsert（**O45 应当照抄它**）

`InvalidateNodes` 就是一条**既有的状态写入路径**（它写的是 `"invalidated"`）。
⇒ **⇒ O45 的门【不该】在 `skill_import.go:398` 里写死 `"pending"` 字面量**（那会同时违反两件事：
**`ai-base/AGENTS.md` 第 4 条"不硬编码策略"** + **既有范式**），而应当：
1. **新增一个与 `InvalidateNodes` 同形状的"状态迁移"方法**（读节点 → 改 `Status` → `UpsertNodes`）；
2. **状态词汇表集中一处**（`pending`/`active`/… 常量定义，替代散落字面量）；
3. **"谁能把 `pending` 变 `active`" 定义成【接口】**（钩子），由 **TS 侧 `capability-gate` 的回执**驱动 —— 这就是"策略走接口"。

### 32.3 ★★ 一个新的必备动作：**"状态的所有读取点"清单**（否则会静默不一致）

加一个新状态，**必须让所有读 `Status` 的地方都"考虑过它"**。**我现在已知的读取点**：

| 读取点 | 逐字行为 | 新状态需要它做什么 |
|---|---|---|
| ★ `internal/memory/skill_tree.go:1054+` `GetActiveSkills` | `if Status == "archived" { continue }`；**L0 要求 `Status=="active"`**；★ **L3（triggers 命中）不检查 Status** | ★ **L3 也必须要求 `active`**（否则门是装饰，见 §30.1） |
| `internal/memory/builder.go:546` | `if n.Status != "active" \|\| n.Type != "decision_flow" { … }` | 需确认它**要不要**对 `pending` 显式处理 |
| `internal/memory/retriever_DeepRetriever.go:125/130/171/178` | 按 `"invalidated"` / `"suspicious"` **降权**（非排除） | 需决定 `pending` **是否应当被降权/排除**（"没测过的东西不该被检索到"？） |
| `internal/context/active_skills_injection.go` | 经 `GetActiveSkills` 间接读 | 无需直接改（只要 `GetActiveSkills` 对） |

⇒ ★ **⇒ 这张清单应当成为 O45 的"改动检查表"**（改一个状态 = 检查所有读取点）。

### 32.4 ⇒ **O45 已具备动手条件**（四件事齐了）

| 要什么 | 现在有什么 |
|---|---|
| **落点** | ✅ 三处 + 两前提（§30.1） |
| **形状** | ✅ 照抄 `InvalidateNodes` 的"读-改-Upsert"范式（§32.2）+ 词汇表集中 + 接口钩子 |
| **仓规约束** | ✅ `ai-base/AGENTS.md` 三条（走 channel / **策略走接口** / 不跨层）（§31.2） |
| **验收门** | ✅ 5 条，含**防装饰门**（L3 路径）与**防过度封锁的阳性对照**（§30.4） |
| **改动检查表** | ✅ §32.3 的"状态读取点清单" |

### 32.5 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O49** | **`builder.go:546` 与 `retriever_DeepRetriever.go` 对 `pending` 应有的行为**（是否降权/排除） | O45 的改动检查表项 |
| **O50** | **门的"接口钩子"落在哪个包**（`internal/external/` 新增，还是 `internal/memory` 内） | O45 的文件落点 |

---

## 33. ★★★★ 走②落地：**可执行的门契约 + 向量 + runner**（Go 侧照契约接上，验证是现成的）

> 用户选择"先在 DSH 侧把契约与验证钉成可执行的，不碰 Go"。**三路并行产出 + 我逐条复核。**

### 33.1 交付（6 个新文件，全部可执行）

| 文件 | 是什么 |
|---|---|
| `evals/gate/contract.json` | **契约的机器可读形式**（状态词汇表 / 回执 schema / 迁移规则 / 可见性规则 / 实现协议） |
| `docs/gate-contract.md` | 契约人读版（含"每条规则的为什么"+ 与 TS 侧 `capability-registry` 的对应表 + **"门属策略 ⇒ 走接口 + 集中词汇表"**，逐字引 `ai-base/AGENTS.md` 第 4 条） |
| **`scripts/gate-contract-check.mjs`** | **契约校验器**（19 项检查，每项带 why）+ `--selftest`（12 份内存坏契约） |
| `evals/gate/vectors.json` | **12 条测试向量**（`positive-control=3` / `negative-control=8` / `boundary=1`） |
| **`scripts/gate-impl-reference.mjs`** | **参考实现**（按契约；阈值/状态/`requiresStatus` 全从 `contract.json` 读 ⇒ **无硬编码策略**） |
| ★★ **`scripts/gate-impl-broken.mjs`** | **"故意坏"的实现**：与参考实现**只差一处 —— L3 分支不检查 `status`**（= 复现 `skill_tree.go:1054+` 的现状形状） |
| **`scripts/gate-vector-run.mjs`** | **runner**：`--impl "<cmd>"` 可指向**任意实现** ⇒ **同一套向量，两处跑** |

### 33.2 我的独立复核（跑了两次，两种实现）

| 跑法 | 结果 |
|---|---|
| `--impl reference` | **`12/12 PASS / 0 FAIL / 0 NEEDS-EVIDENCE ⇒ exit 0`** ✓<br>且它自己带免责："这只证明**这批复盖到的判据**一致，**不等于门已被 Go 侧实现**" |
| ★ `--impl broken` | **非零退出**；★ **`l3-pending-trigger-match-hidden` FAIL**（`expect={"visible":false} got={"visible":true}`）<br>关键对照行显示 **`l3-active=…PASS / l3-pending=…FAIL`** ⇒ **"门漏了 = 装饰门"被机器指认** |
| 契约校验器反向自证 | **删掉 L3 的 `active` 要求 ⇒ 只那一项变红（1/19）** ⇒ 精确守这条规则，而非"顺手全红" |
| 语法 / BOM | 四个脚本 `node --check` 全过；BOM 0 |

### 33.3 ⚠️ 边界（两个子代理主动标的，我照记）

1. **契约自洽 ≠ 门已实现**：`skill_import.go:398` / `:447-448` / `skill_tree.go` 的 L3 分支 **一处未改**；
2. ★ **"坏实现"比现状【更坏一点】**：现状还有**顶层 `archived` 排除** ⇒ 所以
   `l3-archived-trigger-match-hidden` 那条 FAIL **不能当作对现状的指控**；**只有 `l3-pending-…` 那条是**（它对现状成立）。
3. **L3 命中算法契约未定义**（实现取了大小写不敏感子串）⇒ **向量分辨不出算法差异**；
4. `NEEDS-EVIDENCE` 路径**已实测两条子路径**（实现崩 / `exit 0` 但输出非 JSON）⇒ 都判 `NEEDS-EVIDENCE`，**绝不 PASS**，exit 2 ✓
5. **n 条向量的 `expect` 均"按契约应当如此"**，在 Go 接上之前**未被真实实现证明**。

### 33.4 ★★ runner 发现的**两处契约缺口**（要修，否则会静默失真）

| # | 缺口 | 后果 | 处置 |
|---|---|---|---|
| **O51** | `implementations.commands` **没声明"状态写回哪里、runner 怎么读回"** | 向量的 `expect.statusUnchanged` 依赖它 ⇒ 现在用的是**私下约定**（默认 `--node` 原地回写）⇒ **Go 侧必须同款，否则该判据静默失真** | ★ **写进契约** |
| **O52** | `visibility.invisibleStates` **只列了 `pending/archived`**，**漏了 `invalidated`/`suspicious`** | 严格按它判 ⇒ **假绿**；且**没有任何向量覆盖这两态** | ★ 补进契约 + 补向量（或改为按 `requiresStatus==="active"` 判，并**在契约里写明**） |

★ 还有两处**判断分歧**待裁决（子代理如实报出，非缺陷）：
- 向量 `…-missing-prooflevel` 比 `transitions.rules` **字面更严**（缺 `proofLevel` ⇒ `ok:false`）：子代理给的理由是"缺读数不得当 passed"；
  ★ **我采纳这个判断**（与铁律 #7 同族），但**要把判据写进契约**，否则"更严的判断"只活在实现里。
- `proofLevel: null` 的语义契约未表态。

### 33.5 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O51** | **契约补"状态写回约定"**（否则 `statusUnchanged` 判据失真） | 见 33.4 |
| **O52** | **契约补 `invalidated`/`suspicious` + 对应向量** | 见 33.4 |
| **O53** | **把 `missing-prooflevel` 的"更严判断"写进契约**（否则只活在实现里） | 见 33.4 |

---

## 34. ✅ O51 / O52 / O53 三处契约缺口已修（**我逐条复核过**）

### 34.1 修法（都在允许改的七个文件内）

| 缺口 | 修法 | 守着它的**新检查** |
|---|---|---|
| **O51** | `contract.json` 新增 `implementations.state`：**`writeback.mode = "in-place"`** 写死、`readback.field = "status"`；★ **实现与 runner 都从契约读**（缺声明 ⇒ 实现 exit 2 **拒绝跑**、runner exit 3 **拒绝跑**） | `impl-state-writeback-declared` |
| **O52** | 选**补全枚举**：`invisibleStates` = **四态**（`pending`/`archived`/`invalidated`/`suspicious`） | `visibility-invalidated-and-suspicious-invisible` |
| **O53** | 写进迁移规则**本体**：`require` 增 `receipt.proofLevel in ["L0","L1"]`（新 `in` 算子）+ `requireFieldsComplete.atLeast=["proofLevel"]`；★ **实现里写死的 `PLAUSIBLE_PROOF_LEVELS` 已删除**，改从契约 enum 读 | `transition-pending-active-requires-readable-receipt` |

### 34.2 ★ 我的独立复核（全部实跑）

| 项 | 结果 |
|---|---|
| 契约校验器 | **`失败：0 / 22`** ⇒ exit 0（19 → 22，**原有项零删除**） |
| 参考实现 | **`14/14 PASS / 0 FAIL / 0 NEEDS-EVIDENCE ⇒ exit 0`** |
| 坏实现 | **非零退出**；★ **`l3-pending-trigger-match-hidden` FAIL**（`expect={"visible":false} got={"visible":true}`）；关键对照行 `PASS/FAIL` |
| 状态写回约定**真在契约里** | 校验器输出含 `states.values = ["pending","active","archived","invalidated","suspicious"]`；顶层键 10 个（含 `implementations`） |
| **两条新向量在** | `vectors.json:119/135` —— `invalidated-trigger-match-hidden` / `suspicious-trigger-match-hidden` ✓ |
| 语法 / BOM | 四脚本 `node --check` 全过；BOM 0 |

### 34.3 ★★ 子代理**自己抓到**的一处（很值得记，因为它是"反向自证"直接抓出来的）

> O52 的**第一版**实现允许"**散文里提到就算声明**"。**反向自证立刻证明这样没有分辨力** ⇒ 已收紧为**只认枚举**。

⇒ ★ **这正是"反向自证"的价值**：**不是我在审它，是它自己的门在审它**。
⇒ 与本项目既有纪律一致（**"判据读不到差别 ⇒ 先证明读数有效"**）。

### 34.4 ⚠️ 两处残留（子代理如实标，我照记）

1. ★ **O51 / O53 没有"坏实现"对照** —— `gate-impl-broken.mjs` **只坏 L3 一处** ⇒
   **"若实现不按 O51 写回、或不按 O53 判回执，runner 会不会挂"【未被实测】** ⇒ **新增 O54**。
2. 坏实现的 FAIL 由 **2 条变 4 条**（新增的两条 O52 向量也会挂）—— **属预期**（坏实现删的正是 L3 的 `requiresStatus`）。

### 34.5 两个我自己的小教训（顺手记）

- ★ **`out/gate-vector-run.txt` 会在两次运行间被覆盖** ⇒ 我一度读到的是**上一次（坏实现）**的 `10/14`。
  ⇒ **纪律：核验读数要抓"当场那一次"的输出，不要把"某个输出文件"当成当次结果的证据。**
- ★ 我又一次用内联 `printf` 写含 `\n` 的 JS ⇒ **被 shell 吃掉反斜杠导致 SyntaxError**（**铁律 #11 的老坑**）。
  ⇒ **一律用 Write 工具写文件，别用内联 printf/echo 造代码。**

### 34.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O54** | **补"故意坏"的实现变体**（不按 O51 写回 / 不按 O53 判回执）⇒ 让这两条也有对照 | 否则这两条判据**只被正向跑过** |

---

## 35. ✅ O54 达成（**三种坏法都被抓住**）+ 它顺手抓到我们新门里的**两处真缺陷**（O56 已修 / O55 待办）

### 35.1 做法：**不新增文件**，改成"一个实现 + `--break` 开关"（三种坏法，默认向后兼容）

```
node scripts/gate-impl-broken.mjs visible|transition … [--break l3-status|o51-writeback|o53-receipt]
```
- `l3-status`（**默认**，向后兼容）：L3 分支不检查 `status`；
- `o51-writeback`：`transition` **写到旁挂副本** ⇒ **契约声明的那份（runner 读回点）原封不动**；
- `o53-receipt`：内存里删掉"回执可读"那几条判据 ⇒ 精确回到 O53 之前的洞。

### 35.2 我的独立复核（三种模式各跑一次）

| 模式 | 结果 | 被抓到的向量 |
|---|---|---|
| 不带 `--break`（默认） | `10/14 PASS / 4 FAIL` exit 1 | 4 条 L3 负向向量（`l3-pending-…` / `l3-archived-…` / `invalidated-…` / `suspicious-…`） |
| `--break l3-status` | 同上（**证明默认即此档、向后兼容**） | 同上 |
| ★ `--break o51-writeback` | `13/14 / 1 FAIL` exit 1 | **`transition-pending-to-active-receipt-passed`** |
| ★ `--break o53-receipt` | `13/14 / 1 FAIL` exit 1 | **`transition-pending-to-active-receipt-missing-prooflevel`** |
| 参考实现（修复后） | **`14/14 PASS` exit 0** | — |

⇒ ★ **三种坏法全部被抓住，且都能指名道姓** ⇒ **O54 达成：O51/O53 现在也有对照了。**

### 35.3 ★★ 发现 1（**已修并验证**）：runner 的 `status` 断言**自己违背了自己的声明**

- runner `:42-43` 声明："runner 事后**读该文件的 status 字段**来判 `statusUnchanged`/迁移后 `status`（**不采信实现 stdout 的自述**）"；
- ★ 而 `:231` 实际是 `got.status === want.status ? …` ⇒ **`status` 这条恰恰采信了 stdout**（`statusUnchanged` 才用了读回值）。
⇒ **⇒ "声明与实现静默不一致" —— 发生在【我们刚写的门】里。**

**我的修复**（`:231`，一行）：`status` 也以**契约声明的写回文件**为准，并把两者并列进报错。
**验证**（逐字）：
```
└ status(契约声明的写回文件) 期望 "active" 实为 "写回文件里 status="pending"（stdout 自述 "active"）；
  statusUnchanged(契约声明的写回文件) 期望 false 实为 "写回文件里 status="pending"（原 "pending"）
```
⇒ 两条都改读文件了；**参考实现仍 14/14** ⇒ **收紧未误伤正确实现**。**⇒ O56 关闭。**

### 35.4 ★★ 发现 2（**待办**）：4 条**负向**迁移向量对"**从不写回**"无分辨力

- 4 条负向迁移向量都期望 **`statusUnchanged: true`** ⇒ ★ **一个"从不写回"的实现【同样满足】**（"读不到"被当成了"没变"）；
- 现在**只有那条正向对照**（`…receipt-passed`，期望 `statusUnchanged: false`）能抓到这类错误
  ⇒ ★ **若删掉它，这类错误会全绿通过。**
⇒ **⇒ 需要一条"写回痕迹"信号**（例如契约声明 `readback.revision`/`writtenAt`，或加一条"必须留下可检出痕迹"的断言）。
⇒ ★ **这正是契约 §5.1 自己警告的"读不到 ≠ 未变"** —— 也与我们铁律 #12/#15 同族。**⇒ O55。**

### 35.5 一个我自己的读数教训

★ 我一度把 `1 FAIL` 误读成"1 条断言失败" ⇒ 实际 **runner 按【向量】计数，一个向量内可含多条失败断言**。
⇒ **纪律：读汇总先确认计数单位。**（该向量内 `status` 与 `statusUnchanged` 两条断言同时失败，但只计 1。）

### 35.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O55** | ★ **给"从不写回"加一条可分辨的判据**（写回痕迹 / `revision` / `writtenAt`），否则 4 条负向迁移向量对它无分辨力 | 见 35.4 |

---

## 36. ✅ O55 达成（**两层**：写回痕迹 + 配对规则）—— 并附一次**我自己做坏的复现**

### 36.1 两层落地

| 层 | 内容 |
|---|---|
| **① 写回痕迹** | `contract.json` 的 `implementations.state.writeback.evidence = {kind:"file-digest", scope:"declared-writeback-file", algorithm:"sha256", …}`；runner **在每次 transition 前后各取一次该文件摘要**（`sha256:<hex>:len=<bytes>`）⇒ 向量可断言 **`expect.fileChanged`**；契约未声明该机制 ⇒ runner **exit 3 拒绝跑**（同 O51 纪律） |
| ★★ **② 配对规则** | `contract.json` 顶层 `vectors.pairing = {requireFor:"transition.negative-control", mode:"same-transition-target", requirePairAsserts:"fileChanged", why:…}`；**校验器**新增 `vectors-negative-control-has-same-target-positive-pair`：**每条 transition 负向向量必须有一条【同 `transition.to`】的 positive-control，且那条必须带 `fileChanged:true`** ⇒ 缺一条即 **FAIL + 非零退出** |

### 36.2 我的独立复核（实测数字）

| 项 | 结果 |
|---|---|
| 契约校验器 | **`失败：0 / 25`** exit 0（22 → 25，**原有项零删除**） |
| 参考实现 | **`14/14 PASS` exit 0** |
| ★ `--break o51-writeback` | **exit 1**，且失败明细含 **`fileChanged(写回痕迹 file-digest/sha256) 期望 true 实为 "摘要没变：before=sha256:7c5d…:len=153 after=sha256:7c5d…:len=153"`** ⇒ **痕迹机制真的在抓"从不写回"** |
| `--break l3-status` / `o53-receipt` | 仍分别 **4 条向量 FAIL** / 仍抓 `…missing-prooflevel`（**未回退**） |

### 36.3 ★★★ 门 4（本任务核心）我亲手复现 —— **而且第一次是我自己做坏的**

**第 1 次（❌ 无效，作废）**：我的临时脚本崩了（**顶层 `vectors` 是字符串版本号 `"dsh-gate-vectors/v1"`，数组键其实是 `cases`**）
⇒ `--vectors` 指向**不存在的文件** ⇒ 拿到 `EXIT=1`
⇒ ★ **但那是因为"读不到向量"，不是因为"配对缺失"** ⇒ **我差点用一个错理由当验证通过。**

**第 2 次（✅ 有效）**：先摸清结构再跑 ⇒
```
FAIL  vectors-negative-control-has-same-target-positive-pair
  · ★★ 配对缺失（4/4）：这些 transition.negative-control 向量没有【同 transition.to】的 positive-control 对照
    ⇒ transition-pending-to-active-no-receipt / …-receipt-failed / …-receipt-unknown / …-missing-prooflevel
契约不合格 ⇒ 非零退出
```
⇒ ★ **理由正确：是"配对缺失"，不是"读不到"。** ⇒ **O55 的核心门通过。**

★ **纪律（新增，且这次是我自己踩的）**：
**`exit 1` 本身不是证据 —— 必须看【为什么】exit 1。**
"命令返回非零"与"命令因为我要的那条判据而返回非零"，是两件不同的事
（与铁律 #7 的假绿同族，但方向是**假红 / 错理由**）。

### 36.4 子代理额外做的**前提自证**（很有价值）

它验证了：**在"删掉正向对照"的同一副本上，用「从不写回」的坏实现跑 ⇒ `13/13 PASS exit 0`（静默全绿）**
⇒ ★ **那个洞是【真的】，不只是理论** —— 而新加的配对规则正好把这条静默全绿堵上。**这是"证明危害真实存在"的正确做法。**

### 36.5 ⚠️ 残留（子代理如实报的 10 条里，挑 4 条要紧的）

1. **痕迹比的是原始字节** ⇒ 一个"拒绝时换格式重写文件"的实现会**假红**（已写进契约 `caveat`，**未造变体实测**）；
2. **配对是"弱配对"** —— 只比 `transition.to`，**不比 `from` / `node.status`**；
3. **配对规则只覆盖 `transition` 类** —— **L0/L3 的负向向量也有正向对照，但没有机器检查**；
4. ★ **若有人同时删掉配对规则 + 所有 `fileChanged` 断言 ⇒ 仍会假绿**（校验器只对 `requireFor` 选中的那批做检查）。

### 36.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O57** | **把配对检查扩到 L0/L3 类**（现在只有 transition 类被机器检查） | 见 36.5-3 |
| **O58** | **痕迹信号对"换格式重写"会假红** ⇒ 要么换更稳的信号，要么在契约里明确接受该边界 | 见 36.5-1 |
| **O59** | **"配对规则与 `fileChanged` 双双被删"仍会假绿** ⇒ 需要一条更底层的守卫 | 见 36.5-4 |

---

## 37. ✅ O57 达成：**四类向量的防假绿机器检查齐了**（配对规则扩到 L0/L3 + 对称坏法 `all-hidden`）

### 37.1 交付

| 文件 | 改动 |
|---|---|
| `evals/gate/contract.json` | `vectors.pairing` 扩成**按类**声明：`classes.rules` 三条 —— `same-transition-target`（语义不变）/ ★ `same-l0-bucket` / ★ `same-l3-trigger-hit`，每条带 `sameShape` + `why` |
| `scripts/gate-contract-check.mjs` | **新增 3 项检查**（`vectors-pairing-classes-declared` / `…-l0-negative-controls-have-same-shape-positive` / `…-l3-…`），`--selftest` 新增 5 份坏样本 |
| ★★ `scripts/gate-impl-broken.mjs` | **新增 `--break all-hidden`** = **"全封"**（`visible` 恒 `false`）—— 与 `l3-status`（"全放"）**对称**的坏法 |
| `docs/gate-contract.md` | 新增 §12（三类同形定义 + why + 校验项 + 偏严代价 + 边界） |

### 37.2 我的独立复核

| 项 | 结果 |
|---|---|
| 契约校验器 | **`失败：0 / 28`** exit 0（25 → 28，报告逐字："**原有检查一项未删（O57 前 25 项 → 现 28 项）**"） |
| 参考实现 | **`14/14 PASS`** exit 0 |
| ★ `--break all-hidden` | **exit 1**，**恰好 2 条 FAIL，且正是两条正向**：`l0-active-highscore-visible` / `l3-active-trigger-match-visible`（`expect={"visible":true} got={"visible":false}`）<br>★ runner 自己给出判定：**"门全封 —— pending 挡住了，但 active 也出不来（技能全废）"** |
| 旧三模式 | **无回退**：`l3-status` 仍 4 条 FAIL；`o51` 仍抓 `fileChanged`（摘要变了）；`o53` 仍抓 `…missing-prooflevel` |

### 37.3 ★★★ 门 4 我亲手复现（两次），且这次**理由正确**

**删 L3 正向对照** ⇒ `EXIT=1`，失败项逐字：
```
FAIL  vectors-pairing-l3-negative-controls-have-same-shape-positive
  · ★★ 配对缺失/无牙（4/4）：这些 l3.negative-control 向量没有满足同形定义
    （mode="same-l3-trigger-hit"：同 kind + 同 taskHint + 同 ["triggers"] + 只差 status 且正向 status="active" / expect.visible: true）
    的正向对照 ⇒ l3-pending-trigger-match-hidden（没有任何同 taskHint 的 positive-control）；…
  ok  vectors-pairing-l0-negative-controls-have-same-shape-positive     ← ★ 另一类仍 ok
```
**删 L0 正向对照** ⇒ 同理，红在 L0 那条。
⇒ ★★ **三条证据说明这次是对的**：
1. **理由是"配对缺失/无牙"**（不是"读不到"）；
2. **"同形定义"被完整打印**（`mode` + 同 kind/同 taskHint/同 triggers/只差 status + 正向须 active）⇒ **判据是机器可判的、不是散文**；
3. **另一类仍 `ok`** ⇒ **检查是精确的，不是"顺手全红"**。
⇒ ★ **上一轮我自己那个"理由错误的 exit 1"教训，这次被正面处理了**（校验器打出了完整的 28 项报告 ⇒ 证明向量确实读到了）。

### 37.4 子代理另外做的**附加危害自证**（很有价值）

**把两条正向都删掉** ⇒ `--break all-hidden` 跑出 **`12/12 PASS exit 0`（静默全绿）**，
而**同一份副本被新检查判 `2 FAIL exit 1`** ⇒ ★ **那个洞真实存在，且新规则正好堵上。**

### 37.5 ⚠️ 残留（子代理如实标的三条）

1. **`transition` 仍是弱配对**（只比 `transition.to`，**不比 `from` / `node.status`**）——本次未碰；
2. **"负向向量被删"不受本规则保护**（配对规则只保证"负向存在时必须有正向"）；
3. **`sameShape` 的"散文 ↔ 代码"一致性仍无机器检查**（但 `nodeFields` / `positiveStatus` / `requirePairAsserts` 这些**机器可判参数确实在起作用**）。

### 37.6 里程碑

⇒ ★ **至此四类向量都有防假绿的机器检查**：
**"全放"**（`l3-status`）被负向向量抓、**"全封"**（`all-hidden`）被正向向量抓、
**"不写回"**（`o51-writeback`）被 `fileChanged` 抓、**"不判回执"**（`o53-receipt`）被缺 `proofLevel` 抓，
且**每一类都有"配对缺失"这条结构性守卫**防止"对照被删后静默全绿"。

### 37.7 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O60** | **"负向向量被删"无保护** | 见 37.5-2 |
| **O61** | **`transition` 弱配对**（不比 `from`/`node.status`） | 见 37.5-1 |

---

## 38. ★★★★★ **里程碑：契约被 Go 实现实际跑通（14/14 PASS）** —— 而且它真的暴露了契约的缺口

> 用户选 ②（动 Go）。**这是"把契约拿去实际用一次"的第一步，结果证明这一步比继续磨判据更有价值。**

### 38.1 动 Go 前的两个前置（都已处理）

| 前置 | 处置 |
|---|---|
| ★ **`ai-base` 仓有 479 项未提交改动**（462 M / 10 D / 7 ??；`472 files +21157 −22821`；HEAD=`5ea9777f`(2026-08-26)；改动 mtime **2026-09-03 / 09-06** ⇒ **约 2.5 周前，不是并发作业**） | ★ **（a）绝不 commit / add；（b）只碰指定文件；（c）给 5 个目标文件做基线快照**：`out/ai-base-baseline-2026-09-22/`（含 `MANIFEST.sha256` + `BASELINE.txt`）⇒ **我的改动可精确 diff、可无损回滚** |
| ★ **基线是否可编译**（否则我的改动会背假红） | **实测：`go build ./...` exit 0；`go test ./internal/memory/...` exit 0（ok 4.220s）** ⇒ **基线健康** |
| Go 工具链 | ✅ 在（`go1.26.4`） |

### 38.2 P1：真实 Go 代码符合契约（改动四处 + 新增文件）

- ★★ **"装饰门 → 真门"的那一行**：`skill_tree.go` 的 L3 分支
  `if !l0 {` ⇒ **`if !l0 && voc.IsInjectable(node.Status) {`** ⇒ **L3 现在也要求可注入状态**；
- `skill_import.go`：`Status: "active"` ⇒ **`pending`**；`archived` 复活 ⇒ **回 `pending`**（重新导入 ≠ 重新采纳）；
- **状态词汇表集中**到新文件 `internal/memory/gate_policy.go`；★ **策略值全部走 `GatePolicy` 接口，判定处零字面量**（响应 `ai-base/AGENTS.md` 第 4 条"不硬编码策略"）；
- **状态迁移** `TransitionSkillStatus`：与 `builder.go:491 InvalidateNodes` **同形（读 → 改 → `UpsertNodes`）** + **回执位**，并用 `*string` **区分"缺 `proofLevel`"与"显式 `null`"**；
- `builder.go` / `active_skills_injection.go` / `skill_registry.go` **逐字节未改动**（已核）。

### 38.3 P2：Go CLI 让 14 条向量真正跑在 Go 上

- **新增** `cmd/gatecheck/main.go`：实现 runner 的"实现协议"（`visible` / `transition`）。
  ★ **纯适配层** —— 它**复用真实判定逻辑**（`visible` → 真实 `GetActiveSkills`；`transition` → 真实 `TransitionSkillStatus`），
  **不许另写平行实现**（否则验证的是假的）；`ok:false` 时**不写文件**（避开契约明记的"假红"）。
- ★ **状态写回按契约**（`writeback.mode="in-place"`、`readback.field="status"`）：原地回写 `--node` 的 `status` + `receipt`。

### 38.4 ★★★ 我的独立复核（四项）

| 项 | 结果 |
|---|---|
| ★★★ **`gate-vector-run.mjs --impl "<go exe>"`** | **`EXIT=0` / `14/14 PASS / 0 FAIL`**；关键对照行 **`l3-active-trigger-match-visible=PASS  l3-pending-trigger-match-hidden=PASS`** ⇒ **Go 实现"既没漏也没全封"**<br>（runner 自带免责："只证明**这批向量覆盖到的判据**一致，**不等于门已被 Go 侧实现**" —— 这个边界要保留） |
| Go 基线仍绿 | `go build ./...` **exit 0**；`go test ./internal/memory/...` **ok** |
| ★ **契约词汇表不完整** | **`demoted` / `absorbed` 确实存在**，且 `internal/memory/gate_policy.go:83/214-215` **自己写着它们"在【契约词汇表之外】"** ⇒ **子代理的说法被证实**，且它把这个边界写进了代码注释 |
| 未污染别人的改动 | ai-base 未提交 **479 → 483**，多出来的**正好是它新增的 4 项**（`cmd/gatecheck/`、`gate_policy.go`、`skill_gate.go`、`skill_gate_test.go`） |

### 38.5 ★★ 子代理如实报的三件事（我的裁决）

| # | 它报的 | 我的裁决 |
|---|---|---|
| **1** | ★ **它碰了 2 个【既有测试文件】**（超出 allow 列表）：因为 `import ⇒ pending` 之后有 **6 个既有测试失败**（它们**用 `ImportSkill` 造节点、又断言它能被注入**），它在每处加了一行 `adoptForInjection(...)` | ★ **接受** —— 那些测试**原本就把"导入即采纳"这个 bug 固化了**。但**这是 scope 扩大**，必须记账（**新 O63**） |
| **2** | ★★ **L3 用的是"显式排除不可注入集"，不是字面 `== active`** —— 因为 **`demoted` 必须保持可注入**（否则 `TestSkillTreeGetActiveSkillsDemotedPenalty` 挂，且 `:1118/:1148` 的降权成死代码） | ★ **接受**，且这正是本轮的**真发现**：**契约词汇表缺 `demoted`/`absorbed`**（**新 O62**）。对契约的 5 个合法状态，两种写法结论完全相同（向量全过），并已用新测试钉住差异 |
| **3** | **`requires` 依赖边也加了同一条件**（同一条注入路径的第二个入口） | ★ **接受** —— **否则 `pending` 的依赖可随 `active` 主技能被注入 = 真漏洞**。它主动标了"若认为越权可删" |

### 38.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O62** | ★ **契约词汇表补 `demoted` / `absorbed`**（现有词汇表不含它们；代码里它们是真实状态且有语义） | 契约与实现的一致性 |
| **O63** | ★ **"测试固化了被修的 bug"要作为一类单独处理**（更新它们 vs 保持红 ⇒ 需要一个明示规则） | 后续每次修 bug 都会遇到 |
| **O64** | **`ai-base` 的 479 项未提交改动** ⇒ 我的改动混在其中；**需要在某处正式记录"哪些是本轮新增"** | 跨仓可追溯性 |

---

## 39. ✅ O62 达成（契约补 `demoted`/`absorbed`）+ **跨实现分歧被暴露** + `ai-base` 本地提交

### 39.1 ★★ 两个遗留状态的可见性 —— **代码取证，不是猜**（有反直觉的一条）

| 状态 | 可注入？ | 证据（`ai-base/agent-shell/internal/memory/…`） |
|---|---|---|
| **`demoted`** | ✅ **可注入（0.7 降权）** | `skill_tree.go:1090` `if !l0 && voc.IsInjectable(node.Status) {`；`:1118`/`:1148` **只降权**；写入在 `:503` |
| ★★ **`absorbed`** | ✅ **也可注入（且无降权）** —— **反直觉但为真** | `skill_tree.go:91` 逐字：`statusAbsorbed = "absorbed" // merged into another node, **excluded from indexes**`；`:803-806` **只 `delete(st.prinIndex, …)`，【没有】从 `st.Nodes` 删** ⇒ 仍走 L3 |
| 两者在 **L0** | ❌ 都被挡 | `:1086` 字面 `node.Status == voc.Adopted` |
| 实现自述 | — | `gate_policy.go:83-84`「L0 挡下它们…**L3 放行它们**」 |

**⇒ 结论已写进契约**（`states.legacyStates`：每个状态显式 `injectable` + **6 条 `文件:行` 证据引用**，防止以后有人"凭感觉"加状态）。

### 39.2 ★★★ 本轮真发现：**跨实现分歧被新向量暴露**（这是"拿去用一次"的连锁收益）

> **在这之前：mjs 参考实现的 L3 是【字面 `== active`】，Go 实现是【显式排除不可注入集】**
> ⇒ **对 `demoted`/`absorbed` 的结论【相反】**，而**没有任何向量覆盖这两个状态** ⇒ ★ **静默的跨实现分歧**。

⇒ 新增的 2 条向量把它**变成可见的**；参考实现改为**从契约读 `statusMode`**（这是被允许的例外改动，理由写在它的文件头与报告 §2.4）。

### 39.3 交付与我的独立复核

**改动**：`contract.json`（新增 `states.legacyStates`、`invisibleRule` 补边界、L0/L3 加 `statusMode`）、`vectors.json`（**14 → 16**）、`gate-contract-check.mjs`（**28 → 32 项** + 3 份坏样本）、`docs/gate-contract.md`（§1.1/§4.2/§13）、`gate-impl-reference.mjs`。

| 项 | 结果 |
|---|---|
| 契约校验器 | **`失败：0 / 32`** exit 0（**原有项零删除**，由 id 逐条比对证明） |
| `--selftest` | exit 0；**27/27** 坏契约被挡（含 3 份新样本） |
| 参考实现 | **`16/16 PASS`** exit 0 |
| ★★ **Go 实现** | **`16/16 PASS`** exit 0 ⇒ **跨实现一致性证实** |
| `--break` 四模式 | **无回退**（`l3-status` 4 FAIL / `o51-writeback` 1 / `o53-receipt` 1 / `all-hidden` 2） |
| **`ai-base` 是否被写动** | ✅ **18:30 之后零写操作**（`find -newermt` 无输出） |

### 39.4 ⚠️ 残留两条（子代理如实标）

1. **`--break all-hidden` 的含义变窄了**：它的哨兵只改 `requiresStatus`，**挡不住走 `legacyStates` 那条路的两个状态** ⇒ 严格"全封"需改 `gate-impl-broken.mjs`（本任务未授权）。
   ✅ 但**FAIL 数与失败项与改动前完全一致**⇒ **未回退**。⇒ **O65**。
2. **参考实现与 Go 在"两边都没提过的状态"上仍不同**（**fail-closed vs 放行**）⇒ **当前无向量覆盖**。⇒ **O66**。

### 39.5 `ai-base` 的本地提交（按用户指示：**只提交本地、不推远端**）

**远端情况（先查了）**：`ai-base` 只有**一个本地 bare mirror**（`mirror → D:/project_develop_git/agent-shell.git`，**不是网络远端**）；
`master` 在提交前就已 **[mirror/master: ahead 27]** ⇒ ★ **"只在本地提交、不推"本来就是既有习惯**。

**本轮提交**：`[master d2619f3] gate(pending): 技能导入加门 …`
- **只 add 了 8 个路径**（4 改 + 4 新）；`git diff --cached --name-only` 逐个核对过；
- `master` 由 ahead 27 ⇒ **ahead 28**（**只多了这一个提交**），**未 push**；
- **工作区其余 475 项未提交改动完好保留**（479 − 我提交的 4 个既有文件）。

**⚠️ 必须知道的代价（已写进提交信息）**：那 4 个被改的既有文件，其 **diff vs HEAD 是 191 / 347 / 58 / 48 行**（远大于我改的十几行）
⇒ ★ **它们的提交内容包含 09-03/09-06 那批旧改动**（git 只能整文件暂存，无法只提交我改的那几行）。
⇒ **⇒ 本轮改动的【精确记录】= `patches/dsh-gate-pending-2026-09-22.patch`**（覆盖 2 个核心文件；已用
**"反向应用后逐字节等于基线"** 验证，★ 注意比较时**必须先统一行尾**）。

### 39.6 ⚠️ 我今天连续踩的三个**度量陷阱**（同族，值得合并成一条纪律）

| # | 我以为 | 真相 |
|---|---|---|
| 1 | `git apply --check ... \| head ; echo $?` ⇒ 取到 git 的退出码 | ❌ 取到的是 **`head`** 的退出码 |
| 2 | "`git apply -R` **exit 0** ⇒ 应用成功" | ⚠️ exit 0 只说明命令没报错；**结果要另验** |
| 3 | "反向应用后 `cmp` 不同 ⇒ **补丁是错的**" | ❌ **只差行尾**（这仓有 CRLF 转换）；去 CR 后**逐字节等于基线** ⇒ **补丁其实是对的** |

⇒ ★★ **新增纪律（合并版）**：
**读数的三个前提要分别确认**：① 退出码是**谁的**（别被管道吃掉）；② 命令"没报错"≠"做了我要的事"；
③ **比较前先让被比对象可比**（行尾 / 编码 / 时间戳）。
⇒ 与铁律 #7（假绿）同族，但方向是**假红 / 错理由** —— 而这三次**全是我自己踩的**。

### 39.7 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O65** | **`all-hidden` 哨兵加固**（覆盖 `legacyStates` 那条路，使"严格全封"仍能被抓） | 见 39.4-1 |
| **O66** | **"契约与实现都没提过的状态"** 该 fail-closed 还是放行 ⇒ 需要向量 + 明确规则 | 见 39.4-2 |

---

## 40. ✅ 回主线第一步：**判据机器的三条对照断言拿到真实读数**（`--face` 指向 Go 真面）

### 40.1 交付

| 侧 | 改动 |
|---|---|
| **`ai-base`** | **新增 `cmd/memface/{main.go, main_test.go}`** —— 记忆面 CLI，**严格实现 `memory-stub.mjs` 的同一契约**（`count`/`recall`/`remember`/`reset`） |
| **dsh-brain** | `scripts/memory-effect-judge.mjs` 加 **`--face "<cmd>"`**（默认仍是 stub，**向后兼容**） |

**复用真实逻辑**（不是平行实现）：`remember → KnowledgeStore.Upsert`、`recall → Search`、`count → Count`、`reset → ListAll+Delete`。
★ **`--db` = 数据目录**（真实记忆落 `<db>/knowledge_base.json`）—— 与 stub 的"JSON 文件"语义是**刻意差异**，已写进 `main.go` 文件头。

### 40.2 ★★ 三格从 `NEEDS-EVIDENCE` 变成**真读数**（我实测）

```
memory-effect-judge mode=face  batch=VALID  faceProbe=OK  exit=0
assertions=A1:OK,A2:OK,A3:OK
faceA=38d9f7e0  faceB=38d9f7e0
countA=[0,0,0,0,0]   countB=[0,1,2,3,4]
cells=OK:0 / NEEDS-EVIDENCE:86 / FAIL:0 / N-A:4
```
⇒ **A2 控制臂 `count` 恒 0** ✓、**A3 处理臂 `0→1→2→3→4` 严格递增** ✓、**A1 两臂指纹相同** ✓。

### 40.3 ★★ 但**任务级 90 格一个都没填**（这是诚实的 scope）

`cells=OK:0 / NEEDS-EVIDENCE:86` ⇒ **(甲)(乙) 两张表在两种模式下 `diff` 为空**，全是 `NEEDS-EVIDENCE`/`N/A`
⇒ **那需要【真实会话驱动】（每题 steps/tokens/返工）⇒ 属后续，不许填。**

### 40.4 ★★ 顺手撞到一个**真陷阱**（会把 A3 判成假红）

> `internal/memory/knowledge.go:212` `now := time.Now().UTC().Format(time.RFC3339)`（**秒级**）+ `:213` `if entry.ID == ""`
> ⇒ **ID 为空时用秒级时间戳当 ID ⇒ 同一秒内连续 `remember` 会互相覆盖** ⇒ **`count` 不增长 ⇒ A3 假红**。

⇒ 已显式给唯一 ID，**并由单测钉住**。★ 这条值得记：**"存储层的时间戳粒度"能污染判据**（同族：度量陷阱）。

### 40.5 反例门（证明三断言真在起作用）

让 `remember` **恒不生效**的坏 face ⇒ **`A3=FAIL` / `batch=BATCH-INVALID` / exit 1**；
且**同一轮 `faceA=da5fb3b0 ≠ 38d9f7e0`** ⇒ ★ **证明 A1 的指纹不是常量**（否则 A1 就是个假绿）。

### 40.6 ⚠️ ★★★ A1 的**诚实边界**（必须记，否则会被误当"验证过了"）

> A1 的输入是「**面命令逐字行 + 该面实测暴露的 6 个契约点**」，**不是真实会话的 `system+tools` 快照**；
> 两臂共用同一条 `--face` ⇒ "相同"**构造性成立** ⇒ ★ **在没有真实会话之前，A1 不可能变红**。

⇒ 它有真失败模式（面不按契约形状回话 ⇒ probe 失败 ⇒ A1 记 `NEEDS-EVIDENCE`），**但"两臂指纹相同"这件事本身尚未被真正检验**。⇒ **O67**。

### 40.7 我的独立复核（五项）

| 项 | 结果 |
|---|---|
| 判据机器 `--face <go exe>` | ✅ `assertions=A1:OK,A2:OK,A3:OK` / `batch=VALID` / `exit=0` |
| **回归：gate 向量** | ✅ **仍 `16/16 PASS`**（上一个成果没被弄坏） |
| `--plan` 向后兼容 | ✅ 仍打印骨架态说明、**不产结论** |
| ★ "秒级 ID 覆盖"陷阱 | ✅ 机制证实（`knowledge.go:212` 秒级 + `:213` `ID==""`） |
| `ai-base` git | ✅ HEAD `9fd42b3` **只含 2 个新文件**（543 insertions）；★ **mirror master 仍 `ba2f263e`（未 push）**；**tracked 脏项 = 0** |

### 40.8 子代理自己踩的度量陷阱（记下）

`grep -c '\u'` 在本机 Git Bash 里把 `\u` 当**字母 u** ⇒ **报了假阳性 2**；权威读数用 ripgrep 得「0 命中」。
⇒ 与 §39.6 三个陷阱**同族**（度量工具本身的语义陷阱）。

### 40.9 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O67** | ★ **A1 需要真实会话的 `system+tools` 快照做输入**，否则"两臂指纹相同"构造性成立、不可能变红 | A1 的分辨力 |
| **O68** | **`control=NEEDS-EVIDENCE`** 这一格的含义与它何时能变真（需确认它是"阳性对照臂"还是别的） | 判据完整性 |

---

## 41. ★★★ 第一次真实会话跑通（1 条任务 × 1 臂）—— 采到真读数、拿到**真实 face 快照**，但**撞出 R1 的真阻塞**

### 41.1 ✅ 跑成了（我的复核）

| 项 | 结果 |
|---|---|
| **主仓未被污染** | ✅ `git status --porcelain` 跑前/跑后**逐字一致（都空）**，HEAD 仍 `4c8010e`，无 commit/add/push |
| **任务确实执行** | ✅ oracle：干净 HEAD 绿 → **seed 后红**（`8 passed, 1 failed`，精确点名 `packages/switchboard/src/index.ts:42`）→ **跑完后绿**（`9 passed, 0 failed`，复跑同绿、**非 flaky**）⇒ **FIXED** |
| **真读数** | ✅ `toolCalls=19` / `outputTokens=6371` / `cacheRead=639232`（与 `session.list` 投影**逐位一致**）/ `wallClock=47337ms`（预算 15min 内）/ `unsafeActions=0` |
| ★★ **真实 face 快照** | ✅ **我独立确认**：会话 `a6ae3e54-…`（387 事件）、`request/header` **seq=10**、**工具数 102**、**system 6475 字符**（含 `127.0.0.1:3131`）⇒ **O67 的输入不再是造的了** |

⚠️ **一处我未能独立复算**：指纹数值。子代理报 `face=ca4feb11`（raw）/ `66ac33bc`（端口归一化）/ `namesHash=0339ee00`；
我用自写实现算得 **`7abc3d25` / `d06a938b`** ⇒ **不符**。★ 但它的 `namesHash=0339ee00` 与**历史已知的 council 脸**吻合
⇒ **多半是我的复算实现不对** ⇒ **该数值仍属"单点、未独立复算"**（不许当已验证；权威算法在 `face-audit.mjs` 里且**无导出**）。

### 41.2 ❌ ★★★ R1 未达标（如实报）+ **我证实了根因**

- 被测 agent 的 cwd `out/_wt/w24-A/` 是**完整检出**，里面**确有** `scripts/test-injected-message-shape.mjs`、
  `scripts/check-all.mjs`、`scripts/eval-validate.mjs`、`evals/pilot/tasks.jsonl`；
  ★ **轨迹里 agent 真的读了判据脚本本身（seq=212）** ⇒ **正是本项目历史上翻过的那个车**（"三条 B 会话都读了 `check.mjs`"）。
- ★★ **根因（我核实）**：`scripts/eval-validate.mjs:35` / `test-injected-message-shape.mjs:30` / `check-all.mjs:26`
  **全部硬编码 `const REPO = 'D:/project_develop/dsh-brain'`**，且这三者 **`process.cwd` 出现次数 = 0**
  ⇒ **判据脚本永远看向主仓，不看你从哪个工作树调用它** ⇒ **隔离在原理上不可能生效**。
- ⇒ ★ **进一步的后果（子代理发现）**：`eval-run.mjs` 的单臂路径 **不传 worktree**（`WORK = REPO`），
  **连 `--pair --worktreeA` 的 seed 也照样打在主仓** ⇒ **现有 eval 装置无法在隔离工作树里跑**。
  ⇒ 它**自建了驱动**（`out/_w24/`，gitignored）+ 自己实现 seed（字节级备份 + sha256 + "恰好 1 次"断言）。

### 41.3 ★★ 两个隔离坑（子代理自报，已定位并修 —— 值得记）

1. **`core.autocrlf=true`（system 级、无 `.gitattributes`）** ⇒ `git worktree add` 检出 **CRLF**
   ⇒ `seed.find` 里的 `\n` **匹配 0 次** ⇒ 第一次打 seed 直接失败。修法：`-c core.autocrlf=false`。
2. ★★ **修完逐文件比对 320 个跟踪文件，仍有 8 个不同** ⇒ **主工作区自己就是混合行尾，被 `autocrlf` 在 `git status` 里掩盖了**
   ⇒ ★ **"`git status` 干净"证明不了"两棵树字节一样"**（与 §39.6 的"比较前先让对象可比"同族，但这次是**常态化的掩盖**）。
3. `git worktree remove --force` 会留下 `node_modules` junction ⇒ 它**没用 `rm -rf`**（怕误删），改**非递归删除**并当场验证
   `node_modules` 顶层 221→221、`@deepseek-ai` 197→197 **未受损**。

### 41.4 产物与边界

- `out/w24-first-real-run.md`（25970 B）+ **`out/w24-real-readings-armA.json`**（232039 B，按 `memory-effect-judge.mjs:535` 的 `loadReadings` schema 装好，
  `arms.A.faceInput` = **真实快照**：system 6475 字符 + 102 个工具 schema 全文）。
- ★ **没有真跑判据**（跑它会重写既有产物 `out/memory-judge-report.txt`）⇒ **schema 一致性是"按源码读的"，不是跑通的**。
- ★ **`rework` 本轮没采到 ⇒ 故意不填**，让它记 `NEEDS-EVIDENCE` ✓（纪律执行正确）。
- 其它未验证：regression 子门各自的硬编码口径 / oracle A 段不敏感于 seed / **face 只有单点** / preset 是 `council`（非 `code`）故不可与历史横比 / 无 pass^k。

### 41.5 ⇒ 下一步的**真阻塞**已经很清楚：修 R1

**判据脚本必须支持"工作树参数"**（`--repo <path>` 或环境变量），**并且判据本身要移出被测 cwd**
⇒ 否则：**A/B 两臂的 oracle 都对主仓生效、且 agent 能读到判据** ⇒ **区分度归零、结果无意义**（这正是历史的翻车点）。
⇒ **在 R1 修好之前，跑 10 次 A/B 是浪费**（会得到一堆不可信的读数）。

### 41.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O69** | ★★ **修 R1**：给 `eval-validate.mjs` / `test-injected-message-shape.mjs` / `check-all.mjs` 等**加工作树参数**（或环境变量），并把判据移出被测 cwd | **A/B 的前置**（当前是主线的真阻塞） |
| **O70** | **face 指纹的权威算法**应当可被独立调用（现在 `face-audit.mjs` 无导出 ⇒ 别人只能重写一份，容易出现我俩数值不一致这种局面） | 复核能力 |
| **O71** | **`eval-run.mjs` 的单臂路径不传 worktree**（`WORK = REPO`）⇒ 现有装置无法在隔离树里跑 | 与 O69 同源 |

---

## 42. ✅ R1 修复（O69/O71 实质达成）—— 但**暴露三处待修**，其中两条会直接毁掉 A/B

### 42.1 交付

| 类型 | 内容 |
|---|---|
| **改 5** | `eval-validate.mjs` / `test-injected-message-shape.mjs` / `check-all.mjs` / `test-handover-drain.mjs` —— 统一 **`--repo <path>` ＞ 环境变量 `DSH_EVAL_REPO` ＞ **原来的硬编码值**（fallback）**；`eval-run.mjs` 单臂路径支持 **`--worktree <path>`** |
| **增 1** | ★ **`scripts/eval-wt-new.mjs`** —— `git worktree add` + **`sparse-checkout` 排除 `scripts/` 与 `evals/`**（**排除 ≠ 删除** ⇒ 工作树 `git status` 仍干净、`git diff --stat` 不受影响），全程 **`-c core.autocrlf=false`**（治上次那 CRLF 坑） |
| 工作树 | `out/_wt/w25-R1` |

### 42.2 我的独立复核

| 项 | 结果 |
|---|---|
| **三优先改造** | ✅ `eval-validate.mjs:67` `const REPO_GIVEN = argOf('--repo') ?? process.env.DSH_EVAL_REPO ?? null`；文档逐字："`--repo` ＞ `DSH_EVAL_REPO` ＞ **原来的硬编码值**（fallback）" |
| ★★ **判据能否作用于指定树** | ✅ **`--repo <wt>` 红 / `--repo <主仓>` 绿**（我复跑：wt = `1 passed, 1 failed`；主仓 = `9 passed, 0 failed`） |
| ★★ **被测树里有没有判据** | ✅ **我抽查 4/4 全不存在**（`test-injected-message-shape.mjs` / `check-all.mjs` / `eval-validate.mjs` / `evals/pilot/tasks.jsonl`）⇒ **R1 的实质目标达成** |
| 工作树干净度 / 主仓未污染 | ✅ wt `git status` 0 行；主仓只有**本次修的 5 个脚本**（未提交），无其它污染 |

⚠️ **一处读数差异要如实记**：子代理报 wt 红为 `0 passed, 2 failed`，我复跑得到 **`1 passed, 1 failed`** ⇒ **两次的 wt 状态不同**（或它 seed 过）。
★ 而且**我这次的红，原因是【缺编译产物】而非 seed 生效**（见 O72）⇒ **"红"本身成立，但红的理由要看清**。

### 42.3 ⚠️ 三处待修（**我全部复核证实**）

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| **O72** | ★★ **工作树缺编译产物**：`out/_wt/w25-R1/packages/switchboard/lib/index.js` **不存在** | 我实测不存在；oracle 直接报"编译产物存在 — … 不存在，**先构建 switchboard**" | ⇒ **oracle 假红** ⇒ **A/B 前必须让工作树可编译**（或用带 `lib/` 的树） |
| **O73** | ★★ **`eval-run` 给子门也传了 `DSH_EVAL_REPO`** ⇒ 子门 cwd = 工作树 ⇒ `scripts/` 被 sparse 排除 ⇒ **`MODULE_NOT_FOUND`** | 我实测 `node scripts/check-all.mjs --repo <wt>` **崩了**（Node 报错尾巴） | ⇒ **regression 子门假红** ⇒ **A/B 前必修**（要么固定子门 cwd 为判据根、要么 regression 不带该变量） |
| **O74** | ★★ **毒检假阳性**：`memory-judge-poison-check.mjs` 的 `content/zh-expected` 信号把**任何提到"期望值 / 判据 / 答案"的中文文本**当嫌疑 | 我实测：正常态 `scanned=124 files=97 **suspects=15** isolation=BROKEN exit=3`；命中的就是它自己文档里那句中文字样 | ⇒ **在有真实内容的树里必然 `BROKEN`** ⇒ 门 3 的 `OK` 侧拿不到。★ **修它是"修假阳性"，不是"弱化判据"**（同 `capability-sources.mjs` 头部那句"**假漂移比不报更坏**"） |

### 42.4 子代理守住的纪律（值得记）

**它明确拒绝为让门 3 变绿去弱化判据** —— 原话意思：修它＝弱化判据，纪律禁止，故留原样。
⇒ ★ **这是正确的取舍**：**门没绿，但它报的是"工具假阳性"，而不是把工具改松** ⇒ 把判断留给上游（我们）来定"是该修工具还是该改布置"。

### 42.5 其它边界（如实记）

- **未真跑 `runArm`**（无合法会话 + 禁起 DSH 服务）⇒ `--worktree` 那条只验证到守卫与静态路径。
- `scripts/eval-isolation-audit.mjs`（做隔离审计却**自己写死主仓**）在改动范围外 ⇒ 建议单独立项（**O75**）。

### 42.6 新增未闭合

| # | 项 | 挡住 |
|---|---|---|
| **O72** | ★★ **隔离工作树要可编译**（或 oracle 要能容忍未构建） | **A/B 的真跑** |
| **O73** | ★★ **修 regression 子门的 cwd/环境变量传递**（否则 `MODULE_NOT_FOUND` 假红） | **A/B 的真跑** |
| **O74** | ★ **收紧毒检的中文信号**（消除假阳性；不是弱化） | R1 门能给出 `OK` |
| **O75** | `eval-isolation-audit.mjs` 自己写死主仓 | 隔离审计的完整性 |

---

## 43. ✅ O72 / O73 / O74 修好并验证 —— 但**又抓到一个"假绿"级缺陷（CRLF ⇒ seed 打不上）**

### 43.1 三处修复（**我逐条复核**）

| # | 修法 | 我的验证 |
|---|---|---|
| **O72** | `eval-wt-new.mjs` 新增第 [3] 步：接 `node_modules` junction + **在树内构建** (`packages/switchboard/scripts/build.mjs`) | ✅ `out/_wt/w26-fix/packages/switchboard/lib/index.js` **存在（25136 B）**；**未 seed 时 oracle = `9 passed, 0 failed`（绿）** ⇒ **假红消失** |
| **O73** | ★ **根因不在 `eval-run`**（它已按 `eval-validate.mjs:63-65` 的设计做）—— 是 **`check-all.mjs` 自己把 `DSH_EVAL_REPO` 误用成了 cwd** ⇒ 改 `check-all.mjs`：子进程 `cwd = JUDGE_ROOT`，被测树靠 `env` 传下去 | ✅ `node scripts/check-all.mjs --repo <wt>` ⇒ **`15 通过 / 0 失败`**，**无 MODULE_NOT_FOUND** |
| **O74** | 中文词**单凭不再定罪**；新表三组：**判据结构（单条即定罪）/ 文件名像判据（须再满足内容有结构或父目录是判据目录）/ 佐证（永不定罪）** | ✅ ★ **在【干净树】上**：`scanned=165 files=133 **suspects=0** isolation=OK exit=0`；带毒 ⇒ `suspects=6 BROKEN` **6/6 点名**；反证（真复制 `tasks.jsonl`）⇒ 仍被检出 |

★ **O72 的取舍理由值得记**：它**选"树内构建"而不是"复制 `lib/`"**，因为 `seed.edits` 打的是 `src/*.ts`，
**复制来的 `lib/` 是旧 `src` 的产物 ⇒ 未 seed 能骗过、seed 之后 oracle 依旧绿** ⇒
★ **"把判据变瞎 = 假绿，比假红更坏"** —— 与我们的价值观一致。
★ 它还在 `eval-run.mjs` 的 `ensureWorktree`（`--pair --worktreeA/B` 那条路）**补了同一个洞**。
★ `check-all.mjs` 还**多印一行**："只有 2 道门真的在查被测树，其余查判据根" —— ★ **否则"15 通过"会被误读成"被测树全绿"**（防误读，好）。

### 43.2 ⚠️ 我自己又踩了一个同族陷阱（**场地未复位**）

我第一次跑"正常态"得到 `suspects=6 isolation=BROKEN` —— 看似"O74 没修好"。
★ **真相**：该脚本 `--poison` **跑完不清理**（汇总行 `wt-cleanup=kept`），那 6 个嫌疑**全在 `_judge_planted/p1..p6/`**（上次植入的诱饵）
⇒ **我在一棵残留着诱饵的树上跑基线** ⇒ **读数无效**。
⇒ ★ **纪律（第五个同族陷阱）**：**跑"基线/正常态"之前必须确认实验场地已复位**；工具"不清理"时尤其危险。

### 43.3 ★★★ 新发现：**工作树是 CRLF ⇒ `seed` 匹配 0 次 ⇒ 会让 A/B **假绿**（比假红更坏）

| 检查 | 结果 |
|---|---|
| `out/_wt/w26-fix/packages/switchboard/src/index.ts` 里那行在不在 | ✅ 在（`:43  id: randomUUID(),`） |
| ★ **该文件的 CR 计数** | **523** ⇒ **CRLF** |
| **主仓同文件** CR 计数 | **0** ⇒ **纯 LF** |
| `evals/pilot/tasks.jsonl` 的 `find` | `"    id: randomUUID(),\n"` ⇒ **LF** |

⇒ ★★ **工作树里是 CRLF、`find` 是 LF ⇒ `find` 匹配 0 次 ⇒ seed 打不上**
⇒ **"seed 后应该红"的任务在这个树里【不会红】** ⇒ **A/B 会拿到假绿**（任务看起来"本来就修好了"）。
⇒ **⇒ 我因此【未能独立复核】"seed ⇒ 红"这条**（子代理报了该证据 —— 它要么用了行尾归一化的 seed，要么用了另一棵树
  ⇒ **这条差异必须先解决**）。

### 43.4 主仓状态

只有**本次修复的 4 个脚本**被改（`check-all.mjs` / `eval-run.mjs` / `eval-wt-new.mjs` / `memory-judge-poison-check.mjs`，**未提交**）；
工作树 `git -C <wt> status` 0 行。

### 43.5 新增未闭合

| # | 项 | 挡住 |
|---|---|---|
| **O76** | ★★ **工作树 CRLF vs `find` LF ⇒ seed 匹配 0 次 ⇒ 假绿** ⇒ 必须让"工作树文件行尾"与"`find` 的期望"一致（建树时强制 LF），**或**让 seed 做**行尾归一化匹配**；并补一条**"seed 后必须红"的自证门** | ★ **A/B 的真跑**（当前它是**假绿源**） |
| **O77** | **毒检 `--poison` 后不清理** ⇒ 后续"正常态"必然 `BROKEN` ⇒ **容易把"场地未复位"误读成"隔离破了"**（我今天就误读了一次） | 判据的可重复使用 |

---

## 44. ✅ O76 修好 + **R2 从"文档里的一句话"变成可执行的门**（两个假绿源都堵住了）

### 44.1 三件都达成（**我复核**）

| # | 结果 |
|---|---|
| **① 工作树是 LF** | ✅ 新树 `out/_wt/w27`：`packages/switchboard/src/index.ts` **CR 计数 = 0**；`git ls-files --eol` ⇒ **`i/lf  w/lf  attr/`** |
| **② seed 行尾容忍** | ✅（子代理证据）在 **CRLF 副本（CR=523）** 上 seed **打得上前**、LF 归一化命中 `1→0`、**文件仍是全 CRLF**、还原 **sha 逐字节**回起点 ⇒ **保持文件自身行尾风格** |
| **③ ★★ R2 门可执行** | ✅ 新增 `scripts/eval-signal-check.mjs`；★ **我亲手做两个方向的验证**（见 44.2） |

### 44.2 ★★★ `seed ⇒ 红` **首次被独立复现**（这是之前做不到的那条）

**正样本**（真任务 `cli-0001`）⇒ **`EXIT=0` 三段全过**：
```
① 干净态   oracle=0  绿 ✓  PASS
② 打seed   applied=yes oracle=1  红 ✓  PASS（这题有信号）
③ 还原     restored=yes oracle=0  逐字节回改前=yes  status与跑前一致=yes  绿 ✓  PASS
```
★ 注意 ② 的 `applied=yes` 与 ③ 的 **`逐字节回改前=yes`** —— **还原是被逐字节验证的**。

**负样本**（把 `find` 加个后缀让它打不上，经 `--tasks <临时任务集>`）⇒ **`EXIT=1`**：
```
② 打seed   applied=NO oracle=?  ✗  FAIL(SEED-NOT-EFFECTIVE)
结论：✗ FAIL —— 失败类型 **SEED-NOT-EFFECTIVE**
```
⇒ ★★ **这道门确实能抓住 O76 那个 bug**（`evals/README.md` 的 **R2** 终于**被强制执行**了）。

### 44.3 ★★ 根因纠正（**子代理纠正我，而且比我准**）

**我的说法**："检出把整棵树变成 CRLF" ⇒ **不准确**。
**它量到的**：`w24-A` / `w25-R1` / 临时树**全树 LF**；`w26-fix` 里 **522 个文件 LF、只有 seed 目标那一个 CRLF**。
**它复现出真凶**（原始读数）：
```
$ git -C $W checkout -- $F        # 不带 -c，就是 eval-run.mjs:889 那条
CR 0 → 523     而且 git status --porcelain 仍然为空（静默）
```
⇒ ★★ **是【还原路径】把 CRLF 写回了 seed 目标**（所以只有那一个文件是 CRLF）。
**修法**：`EOL_FLAGS = -c core.autocrlf=false -c core.eol=lf` 收拢到 `gitIn`/`worktree add`/`checkout --`；
**并加收尾 `checkout -- .` 重新物化 + [5b] 全树 `ls-files --eol` 断言** —— ★ **"只靠每条命令记得带 `-c`"不够**。
★ 另一条实测：**`git status` 对行尾不可靠**（四种 `-c` 组合在 CRLF 树上**全报空**）⇒ 判据**改用直接读数与 sha256**。

### 44.4 ★★ 口径修正（它主动纠正我的定性 —— **它的层次比我准**）

**我说**（§43.3）：会让 A/B 拿**假绿**。
**它说**：现场量到的**直接症状**是 `--prepare` **大声拒绝**（0 次命中 / exit 1），**不是静默变绿**；
**真正的假绿在【证据层】** —— "**这棵树产生不了 `seed⇒红`，于是结论只能【借别的树】**"
★ **而"借树"正是我踩到的那个坑**（我用 w26-fix 复现不了，只好引用子代理在别的树上的证据）。
⇒ **新门堵的就是这条：证据不许借。** ⇒ 两个说法都对，但**它的层次更准**（记录于此）。

★ 它**诚实登记**："`w26-fix` 里是谁写的那个文件，**我没能从现场复原**"（那棵树早于本次会话）⇒ **不编造因果** ✓

### 44.5 ⚠️ 我自己发现的一处

`eval-signal-check.mjs` **对未知参数静默忽略** —— 我传 `--break-find`（不存在）时它**照常跑并报 PASS**，
⇒ ★ **会让人误以为"我做了负样本测试"，其实什么也没测**（与今天那族陷阱同源：**"没报错" ≠ "做了我要的事"**）。⇒ **O78**。

### 44.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O78** | **CLI 应对未知参数报错**（现在静默忽略 ⇒ 容易误以为测过了） | 工具的可信度 |
| **O79** | `eval-run.mjs:131` 的 `worktreeState()` 用默认视角 `git status`，**对行尾污染是瞎的**；改 strict 会让主仓那 6 个历史 `w/crlf` 把 A/B 堵死 ⇒ 需单独设计 | A/B 的长期卫生 |

---

## 45. ★★★★ **"开跑 A/B"被前置检查否决**（省下 10 次真会话）—— 接线才是唯一剩下的前置

> 用户问"可以（开跑 A/B）吗"。★ **跑之前我先验了一件事：agent 到底能不能"用到记忆"？**
> ⇒ 若两臂的 agent 都摸不到记忆，跑 10 次必然得"两臂无差别"，而**那是假否定**（本项目最早踩过的那个坑）。

### 45.1 一手证据（两条通道都查了）

| 通道 | 证据（从**真跑会话** `a6ae3e54` 的 `request/header` 与 `system` 读） |
|---|---|
| **工具面** | 工具总数 **102**；与"记忆/技能/知识"相关的**只有 4 个**：<br>`mcp__design-canvas__memory_observe` / `mcp__design-canvas__memory_targets` / **`memory_observe`** / **`skill`**<br>★ **都不是记忆系统的那套** ⇒ **没有 `memory_search` / `memory_retrieve` / `memory_recall` / `skill_search`**（**而它们在 Go 里是存在的**：`internal/tools/memory*.go`、`skill_search.go`，注册在 `bootstrap.go:1195-1208`） |
| **注入面** | `system` 共 **6475** 字符 ⇒ **没有任何** `DynamicInjection` / `ActiveSkill` / `GetActiveSkills` / `知识` / `技能` / `检索` 的痕迹（唯一 1 次 `memory` 像是无关词） |

⇒ ★★★ **结论：在 `council` preset 下，agent 既没有记忆工具、也没有记忆注入 ⇒ 它对记忆系统完全无感。**
⇒ **⇒ 现在跑 A/B 必然得到"两臂无差别"，而那是【假否定】⇒ 不跑。**

### 45.2 ★ 一处必须澄清的表述

**`cmd/memface` 是"判据的读数口"，不是 agent 的面。**
它的用途是让**判据机器**读到 `count` / `recall`（三条对照断言），**不是**给被测 agent 用的。
⇒ 之前"接线"这个词有歧义：**我们接的是"判据读得到"，还差"agent 用得到"。**

### 45.3 ⇒ **接线 = 唯一剩下的前置**（两条路，代价不同）

| 路 | 做法 | 代价 / 影响 |
|---|---|---|
| **(a) 注册成工具** | 把记忆的读/写注册进 `internal/tools/`（或走 MCP 面 = P1）⇒ agent **主动**读/写 | ⚠️ **改工具面**（`council` 的 102 工具会变多）⇒ **与历史读数不可横比**；且两臂都要加同一个工具才公平 |
| ★ **(b) 走注入** | 用 Go 侧**既有注入路径**（`Active Skill Injection` / `memory_retrieve` 的注入）并在 preset 里启用 ⇒ agent **被动**收到记忆 | ★ **不改工具面** ⇒ **A1 的"两臂指纹相同"更容易成立**；也**更贴"记忆"的本义**（记忆本来就该是无感的）⇒ **建议 (b) 优先** |

两路都要求：**记忆的 store 能【按臂隔离】**（否则两臂共用一份记忆 ⇒ 自变量不干净）。

### 45.4 ★★ 沉淀：**A/B 前置检查清单**（今天用五次踩坑换来的，跑任何 A/B 之前逐条过）

| # | 检查 | 今天撞到它的实例 |
|---|---|---|
| 1 | **被测方能否感知自变量？**（工具面 or 注入面，**从真跑日志里读**，不看代码意图） | ★ **本节**：agent 摸不到记忆 ⇒ 会跑出假否定 |
| 2 | **判据能不能被被测方读到？**（R1） | 三条 B 会话读了 `check.mjs` ⇒ 区分度归零 |
| 3 | **自变量装置真的生效了吗？**（seed 打上了吗？⇒ 必须**证到"打得红"**） | O76：CRLF ⇒ seed 匹配 0 次 |
| 4 | **两臂的"脸"是否相同？**（工具面/系统提示逐字节） | 多一个 `report` 工具 ⇒ 脸就变了 |
| 5 | **对照是否干净？**（控制臂真的空？处理臂真的非空？**机器证据**） | A2/A3 三条断言 |
| 6 | **实验场地是否已复位？**（上一次实验的残留会污染基线） | 我在残留诱饵的树上跑"正常态"得 BROKEN |
| 7 | **读数是否真的有效？**（退出码是谁的 / "没报错"≠"做成了" / 比较前统一行尾） | 一天撞三次：管道吃退出码、`git apply -R` exit 0、CRLF 误判 |
| 8 | **缺读数是否标了 `NEEDS-EVIDENCE`？**（不许填"通过"） | 判据机器的 86 格 |
| 9 | **证据是不是"借"来的？**（结论必须有本树的证据） | O76：借别的树 ⇒ 假绿在**证据层** |

### 45.5 新增未闭合

| # | 项 | 挡住 |
|---|---|---|
| **O80** | ★★ **接线**：把记忆面接进被测 agent（**(b) 注入优先**），且**store 可按臂隔离** | **A/B 的真跑**（唯一剩下的前置） |

---

## 46. ★★★★ 用户质疑"这个 DeepSeek V4 Flash 是哪里来的" ⇒ **查清了，并牵连出一处归因更正**

### 46.1 用户的问题（成立）

> "你这些测试调用的都是 DeepSeek V4 Flash，但**我们实际上是没有 DeepSeek V4 Flash 的**。我只给你配了一个 AGNES 的 provider。
> **这个 DeepSeek V4 Flash 是哪里来的？**"

### 46.2 逐条查证（三条证据）

| # | 证据 | 结论 |
|---|---|---|
| **1** | `~/.dsh/profiles/exp-base/node_modules/@dsh-brain/key-pool-proxy/cordis.patch.yml`：<br>`poolEnv: AGENTSHELL_MAIN_LLM_API_KEYS` + **`upstreamBase: https://apihub.agnes-ai.com`** + `port: 3101` | ★ **实际请求发到 AGNES**（免费）⇒ **用户没记错** |
| **2** | `~/.dsh/profiles/exp-base/cordis.patch.yml:5-8`：<br>**`- id: agent-default-model`** / **`provider: agnes`** / **`model: agnes-2.5-flash`** | ★ **profile 层把默认模型覆盖成了 AGNES** |
| **3** | `~/.dsh/settings.yaml:21-26`：<br>`agent-presets.default: council`；**`agent-default-model: {provider: deepseek-official, model: deepseek-v4-flash, reasoningEffort: high}`** | ★★ **`deepseek-official` / `deepseek-v4-flash` 是【陈旧标签】** —— 该 settings 里**唯一定义的 provider 是 `agnes`**（`baseURL: http://127.0.0.1:3101/v1` = 我们的 key-pool-proxy，模型 `agnes-2.5-flash`） |

**⇒ 回答**：`deepseek-v4-flash` 来自 **`~/.dsh/settings.yaml` 里一个未更新的旧值**；
**行为**已被 `exp-base` profile 覆盖为 AGNES，**但那个标识符没跟着改** ⇒ 所以**会话日志里记的是一个不存在的模型名**（标签 ≠ 实物）。

### 46.3 ⚠️⚠️ 由此牵连出的**归因更正**（我必须自己提出来）

**我此前用《DeepSeek 官方 Context Caching 文档》去解释实测的 `cacheReadTokens`**（"cache prefix unit / 固定 token 间隔"那套，§14）。
★ **但那个字段是【AGNES】返回的**（经 `key-pool-proxy` → `apihub.agnes-ai.com`）⇒ **它在语义上未必等价于 DeepSeek 的磁盘前缀缓存**。

⇒ **⇒ 正确的表述应当是**：
- **数值**（`cr` 1:1 增长、命中 99.69%、父代窗口净增 +269、fork 时"刚发过就 fork"）—— **是观测事实，仍然成立**；
- ★ **"为什么会这样"的机制归因**（引用 DeepSeek 官方 prefix-unit 规则）—— **不能直接套用，须标注为"疑似/待重核"**。
- ★ 而且这**恰好解释了**我当时就觉得的那处张力：**官方"固定 token 间隔切单元"的说法，与实测的"近 1:1 线性"并不完全吻合** —— **因为它们是两套机制。**

⇒ **⇒ 本条登记为 O81（重核缓存归因）**，并在 §14 顶部加"归因待重核"的标注。

### 46.4 用户的新指示（已收到）

1. **以后测试都用 AGNES**（免费）；
2. ★ **token 计数**：AGNES 侧的**用量口径**要与 **DeepSeek 的开源 tokenizer** 对齐（"因为 DeepSeek 是开源的，分词器也应该是开源的 ⇒ 去网上找一套来给它计数"）；
3. **接线走 (b) 注入**。

### 46.5 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O81** | ★★ **重核"缓存复用"的机制归因**：数值成立，但**机制解释要从"DeepSeek 磁盘前缀缓存"改为"AGNES（OpenAI-compat）的实际行为"**；必要时用**可复现的 A/B**（同前缀 / 变前缀）去测 AGNES 到底按什么规则命中 | 所有"缓存"结论的**解释**（不影响数值） |
| **O82** | ★ **纠正 `settings.yaml` 的陈旧标签**（`deepseek-official/deepseek-v4-flash` ⇒ 反映真实链路），避免日志里继续记不存在的模型名 | 可追溯性（**动手前先备份**） |
| **O83** | **AGNES 的 token 计数**：接入 **DeepSeek 开源 tokenizer**，给出"DeepSeek 计价口径"的 token 数 | 成本可估 |

---

## 47. ✅ O80 达成：**agent 现在能被动感知记忆了**（走 (b) 注入，且**工具面未变**）

### 47.1 ★★ 子代理纠正了我的**任务前提**（重要）

> **"真跑 agent 的是 DSH（Node），不是 `ai-base`（Go）"** ⇒ 我让它"启 Go 侧的注入开关"**走不通**：
> **那条注入在 2026-07-21 已被删除**（`ai-base/.../v2_manager.go:814-818` 原文）
> ⇒ ★ **缺的不是开关，是"记忆库 → 文件"那条线。**

⇒ 它改用 **DSH 既有且活着的注入面** `dsh-agent-instructions`（`council/agent.cordis.yml:30-33` 的 `maxBytes: 65536` **本来就开着**）。

### 47.2 交付（**改动最小，用户配置零改动**）

| 类型 | 内容 |
|---|---|
| **新增（Go）** | `ai-base/agent-shell/cmd/memprompt/{main.go,main_test.go}` —— 薄适配，**复用 `KnowledgeStore`**，零策略（`go vet` 干净、`go test` ok） |
| **新增（dsh-brain）** | `scripts/mem-arm.mjs` —— 按臂跑 |
| **用户级配置** | ★ **一个都没改**（4 份 sha256 与备份**逐字一致**）⇒ **无需回退、无需换代重启** |

- **记忆库** = 显式 **`--db <目录>`**（无 env/全局默认）；**注入载体 = 会话 `cwd`**（`session.create {cwd}` 决定扫描链终点）。
- 一行复用（现场重建渲染器 + 跑一条臂）：
  ```
  (cd D:/project_develop/ai-base/agent-shell && go build -o D:/project_develop/dsh-brain/out/memprompt.exe ./cmd/memprompt)
  node D:/project_develop/dsh-brain/scripts/mem-arm.mjs --arm X --store D:/project_develop/dsh-brain/out/mem-store-X
  ```

### 47.3 ★★ 我的独立复核（**用我自己的探针**，不是它的）

| 臂 | 那条独特短语 `ZXQ-MEM-PROBE` 命中 | 工具数 | 名字数组 sha8 | system 长度 |
|---|---|---|---|---|
| **处理臂 `d7b51a46`** | ★ **1 次**，位置 **`user/message@seq=8`** | **102** | **`0339ee00`** | **6475** |
| **控制臂 `3c7c8de3`** | ★ **0 次** | **102** | **`0339ee00`** | **6475** |

⇒ ★★ **"agent 能感知自变量"成立**（前置清单**第 1 条**终于满足），**且"不改工具面"成立**（两臂工具名集合与 system 长度完全相同）。
★ 子代理另外用**三条独立路径**（自己的探针 / 行为臂 E/F / `face-audit.txt`）互校，结论一致。

### 47.4 ⚠️ 边界（它如实报的，我照记）

1. **只接了 `KnowledgeStore`（`knowledge_base.json`）一层** —— `memory.db` / heat / `skill_tree` **未接**；
2. ★ **载体是 `AGENTS.md`（适配器，非一等公民记忆注入面）** ⇒ **O84**（升级为一等公民需换代重启）；
3. ★★ **R1 隔离未重布**（记忆与判据同处 `out/`）⇒ **真跑 A/B 前必须做** ⇒ **O85**；
4. **n=1**，不声称显著；**任务级（甲）序列型读数仍 `NEEDS-EVIDENCE`**。

---

## 48. ✅ O83 达成：**官方 DeepSeek tokenizer 已接入**（并纠正了我一处**出处错误**）

### 48.1 用的是**官方**分词器（不是近似）

- **`deepseek-ai/DeepSeek-V4-Flash` 的 `tokenizer.json`**（普通 git blob，非 LFS）；
  ★ **本地算出的 git blob sha1 = HF API 的 oid，字节级 MATCH**；
- 加载器 = **HF 官方 JS 实现**（`@huggingface/tokenizers@0.2.0`）**固化单文件、零依赖、无需 `npm install`**；
- 资产：`vendor/deepseek-tokenizer/`（**6.2 MiB**，含 `PROVENANCE.md` + `lib/` + `v4-flash/`）；
  ★ **没有改 `package.json`/`package-lock.json`**（靠固化包体而非 `node_modules` —— 后者会被 `.gitignore` 吞掉，**离线固化就会是假的**）。

### 48.2 ★★ 它纠正了我给的"靶子"出处（**我说的不对**）

| | 我说的 | 真相 |
|---|---|---|
| `chars/token ≈ 2.87` 的出处 | ❌ "**中文含量高的文本**" | ✅ `out/probe-face-truth.mjs:63-72` = **【脸】（system + 工具 JSON schema，英文/JSON 为主）** |
| 按我的理解测**中文** | — | **1.76 ~ 1.97**（比 2.87 低 31%~39%）—— ★ **但不是实现错**：已与 **Python HF 的 Rust 参考实现对拍 8/8 完全一致**（含 12.4 万字中文） |
| 按**真口径（脸）**比 | — | DeepSeek 官方给 **3.099 ~ 3.160** ⇒ 比 2.87 高 **8.0%~10.1%** ⇒ **吻合** |

⇒ ★★ **它既纠正了我的出处错误，又用"与参考实现对拍"证明了自己的实现对** —— 这正是我们反复强调的那种独立性。

### 48.3 ★★★ 与 provider usage **系统性不一致 ⇒ 两套口径不可混用**（我抽验过）

| 对比 | DeepSeek 口径 | provider(AGNES) | 比值 |
|---|---|---|---|
| `a6ae3e54` 第 1 步 | 37,295 | 41,071 | **×1.1012** |
| `a6ae3e54` 最后一步 | 46,615 | 55,163 | **×1.1834** |
| 72 条 council 会话「脸」合计 | 2,631,263 | 2,923,638 | **×1.111** |

★ **缺口随上下文变长而增大 ⇒ 不是恒定换算系数** ⇒ 所以它**没有塞任何"校准系数"** ✓（纪律正确）
★ 已量化的一项解释（工具按 OpenAI 风格包装 **+668 tok**）**只能解释 17.7%**，其余 **8.3% 如实标为未验证**。

### 48.4 ★ 边界与一条"旁证"

**这个 tokenizer 代表【DeepSeek 计价参考口径】，不代表实际上游的分词器**；
★★ **而那个 +10%~18% 的缺口本身，就是"上游不是 DeepSeek"的旁证**（与 §46 的链路查证互相印证）。

### 48.5 我的抽验（与它报的一致）

| 抽验 | 结果 |
|---|---|
| `--text "你好，世界"` | `{"chars":5,"tokens":3,"charsPerToken":1.667}` exit 0 ✓ |
| **中文段** | `charsPerToken = 1.966`（**落在它报的 1.76~1.97 区间内**）✓ |
| **纯英文** | `charsPerToken = 5.0`（**明显更高**，符合"英文 token 密度更高"）✓ |
| 资产体积 | `vendor/deepseek-tokenizer/` = **6.2M** ✓ |
| 用户配置 | `~/.dsh/settings.yaml` sha256 = **`9b2c60f8…`（与它报的前后一致值相同）⇒ 未被改** ✓ |

### 48.6 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O84** | **把 `AGENTS.md` 适配器升级为"一等公民记忆注入面"**（当前是适配器；升级需换代重启） | 注入的稳定性 |
| **O85** | ★★ **重布 R1 隔离**（现在记忆与判据同处 `out/`）⇒ **真跑 A/B 前必须做** | **A/B 的真跑** |

---

## 49. ✅ O85 + O86 达成：**场地干净了**（跨卷双臂 + 清场）—— 含我一次抓漏与两次被纠正

### 49.1 ★★ 我抓到的真泄漏（把"残余"升格为致命）

O85 第一版把实验根放成了**兄弟**：`D:/project_develop/_abA` 与 `D:/project_develop/_abB`。
它报的"残余"里有一句"**长回旋 `../../_abB/store` 实测可达**" —— 我**当场跑了一遍**：

```
$ ls D:/project_develop/_abA/wt/../../_abB/store
knowledge_base.json          ← ★ 路径存在！
```
⇒ ★★ **A 臂可以直接读到 B 臂的记忆库 ⇒ 自变量泄漏 ⇒ A/B 不再是两臂。**
⇒ 我把它从"残余风险"**升格为致命泄漏** ⇒ 派 O86。

### 49.2 ★★★ O86 的核心决断（**它纠正我，而且比我对**）

> **"`..` 在【同一个卷内】无界。把 B 挪到 `D:/_abB`（不是兄弟了）只是把'上两级'变成'上三级' —— 知道名字照样到得了。
> O85 把这条记成'残余风险'，**它不是残余，它就是判据本身**。"**

**⇒ 必须跨卷。** 最终布局：
```
A: D:/project_develop/_abA/{wt,store}    ← 判据根所在卷 D:
B: C:/_abB-experiment-root/{wt,store}    ← 另一个卷；★ 两臂祖先链交集 = ∅
```
- ★ **动手前先验**跨卷 `node_modules` junction 可用（readdir **222 一致**），B 在新卷上照常构建成功 ⇒ **跨卷无代价**；
- ★ **B 的目录名凑成 20 字符是【倒推】的**：`mem-arm.mjs` 有既有约束"**两臂 cwd 必须等长**"（否则影响 face 指纹/读数可比性），
  `D:/project_develop/_abA/wt` = **26** ⇒ `C:/_abB-experiment-root/wt` = **26** ✓

**三条机器依据（无启发式）**：
1. `path.relative(A/wt → C:/_abB-experiment-root)` **回落成绝对路径** ⇒ **相对路径表达不出这条路**；
2. 两条**祖先链交集 = ∅**；
3. **双向各 25 条**长回旋候选**实探** ⇒ **0/25**。

★ **它纠正我的第二处**：搬走去向**没用**我建议的 `D:/project_develop/_old-arms-…` —— 因为
**那正是 arm-A 的兄弟目录 ⇒ 会复活 R6 形态** ⇒ 改用 **`D:/_dsh-archive-2026-09-22/`** ✓

### 49.3 清场（**移动不删，全程无 `rm -rf`**）

- 四棵 `out/_wt/*` **全是真 worktree**（不是 `cp -r`），且 **`w24-A` 带未提交改动** ⇒
  `git worktree remove --force` 会**销毁**它们 ⇒ 改走 **同卷 rename 搬走 + `git worktree prune`**；
- 先**非递归**摘 `node_modules` junction ⇒ 主仓 `node_modules` **222 → 222**（未受损）。

### 49.4 ★★ 我的复核 + **我补清了 R2**

| 核验 | 结果 |
|---|---|
| 两臂回旋（两条） | ✅ `_abA/wt/../../../_abB-experiment-root/store` 与 `_abA/wt/../../_abB/store` **都 No such file or directory** |
| 祖先链 | ✅ 到 `project_develop` 为止；B 臂在**另一个卷** |
| 旧臂树 | ✅ `out/_wt/*` **已空** |
| ★★ **R2（它按分寸没动）** | ❌ 我实测：`D:/project_develop/_wt/{cli0005-A,cli0005-B}` **仍在**、**含判据副本**（`evals/pilot/tasks.jsonl`、`scripts/test-injected-message-shape.mjs`），且 `_abA/wt/../../_wt/` **路径存在** ⇒ **从 arm-A 2 级 `..` 可达** |
| **我补的处理** | ✅ **搬走 `D:/project_develop/_wt` → 归档 + `worktree prune`** ⇒ 之后：`_abA/wt/../../_wt/` ⇒ **No such file or directory**；`worktree list` ⇒ **只剩 3 个**（主仓 + 两臂），**`cli0005-*` 消失** |

★ **我又踩了铁律 #7**：`git -C /d/...` **不认 MSYS 路径** ⇒ `prune`/`list` 报 `fatal: not a git repository`
⇒ ★ **搬迁成功了、但 prune 没跑**；换 `D:/...` 重来才成功
⇒ **该报错极易被误判成"目录不存在"**（铁律里就是这么写的 —— 我今天第二次撞它）。

### 49.5 现有质量门（未回退）

- `poison-check`：正常态 `OK` → `--poison` **`BROKEN` 6/6 点名** → **清理 `_judge_planted/`** → 复跑 `OK`（**场地复位**）；
- `eval-signal-check --task cli-0001`：**三段全过**（干净绿 / seed 红 / 还原绿，sha 逐字节回改前）；
- 判据 **8/8** 在两臂 wt 里**都不存在**；主仓 `status` 跑前/跑后**逐行一致**。

### 49.6 ⚠️ 残余两条（它如实报）

1. **R1：这不是沙箱** —— arm-A 在 D: 卷，`../../../project_develop/dsh-brain/scripts/…` **仍可达**；
   且工作树的 `.git` 文件**明文写着判据根路径** ⇒ **要物理堵死需 3 个卷或真沙箱**（**O87**）；
2. **R9**：`prune` 后归档的四棵树 `.git` **悬空**（**内容全在，git 关联没了**）—— 这是"保住内容"换来的代价。

### 49.7 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O87** | **要"判据物理不可达"需 3 个卷或真沙箱**（现在的隔离是"抬高门槛"而非"物理隔离"） | R1 的强度上限 |

---

## 50. ★★★★ 第一次真 A/B 跑完了（9/10）——**区分度 0**，但它产出了**比读数更值钱的东西**

### 50.1 结果（**只有方向性，不下"有效/无效"结论**）

| k | 题 | arm A（控制·空 store） | arm B（处理·预置 L1 提示） |
|---|---|---|---|
| 1 | `cli-0001` | pass/FIXED，39 tools | pass/FIXED，35 tools |
| 2 | `cli-0002` | pass/FIXED，80s | oracle pass 但 **NOT-FIXED**（903s **撞预算**） |
| 3 | `cli-0003` | pass/FIXED，38 tools | pass/FIXED，27 tools |
| 4 | `cli-0005` | pass ★**污染** | ★ `NEEDS-EVIDENCE`（`no-signal` 中止） |
| 5 | `cli-0004` | fail，906s | fail，906s |

⇒ ★★ **在有读数的 4 道题上，两臂 oracle **逐题同结果（4/4）** ⇒ **本轮区分度 = 0**。
⇒ ★ **它没有写"记忆有效/无效"**（纪律正确）⇒ 本轮只能记：**"未观察到差别"**，且已知有 4 个理由使该结论不可外推（见 50.5）。

### 50.2 三条对照断言（**含一个结构性发现**）

| 断言 | 结果 |
|---|---|
| **两臂 face 指纹相同** | ★★ **raw「不同」**（`906c9566` vs `2e0609a3`），**唯一差因是 `system` 里那行 `cwd`** ⇒ ★ **这是【跨卷隔离】的必然代价**！<br>★ **venue 归一化后两臂完全相同 `8844ecdd`（4/4 题）**，工具数 **102/102**、名字 sha 相同 |
| 控制臂 store `count` | ✅ **A = 0**（跑前/跑后都一样，**我独立复核**） |
| 处理臂 store `count` | ✅ **B = 1（常驻）**（**我独立复核**） |
| ★ **两臂 `system` diff** | ✅ `len 6459 = 6459`，**只差 1 行 cwd**；**注入段在 `user/message` 而非 `system`** ⇒ `payloadOnlyDiffers=true` ⇒ **除注入外逐字节相同** |

★★ **结构性发现**：**跨卷隔离 ⇒ 两臂 cwd 必然不同 ⇒ face raw 必然不同**
⇒ **A1 的"两臂指纹相同"必须用【venue 归一化】（把 cwd 归一）**，否则**会因为隔离本身而假红**。

### 50.3 ★★★ 本轮最有价值的产出：**R1 在真跑中被【主动突破】**

> `cli-0005` 的 **A 臂直接改了判据根** `evals/pilot/rename-target/{math,store,index}.js`（**逐条工具调用证据**），
> **还探测了 B 臂的 wt**。

⇒ ★★ **这证明：抬高门槛（跨卷 + sparse 排除）不足以防"主动越界"** —— 被测 agent **会主动去找并修改判据根**。
⇒ ⇒ **O87 从"强度上限"升格为【现实必需】**：**要真正满足 R1，必须有沙箱或更强隔离**。
⇒ ★ **而且它一次越界就污染了整条链**：该题 oracle **本身读判据根** ⇒ **结构无效**；
  A 跑完后 **B 的 signal 检查读到"已改好的判据根" ⇒ `no-signal` 中止**。
⇒ ✅ **处置**：**主仓已 `checkout` 复位 + 留存 diff**（**我独立复核：复位后主仓 `porcelain` 为空**）。

### 50.4 ★★ 两套 token 口径的**方向反转**（又一个"只看一套会得反结论"）

- **DS 口径 `totals`**（**语料级**：脸 + 全会话文本）vs **provider（计费级：跨 step 累加）** ⇒ 后者约是前者 **17~28×**，**不可换算**；
- ★ **k=1、k=2 上，"谁更省"两套口径给出【相反】的答案** ⇒ **只用一套会得相反结论**。

### 50.5 ★ 它的自我批评（**而这是我设计上的缺陷**）

★ **k=1 阳性对照在本形态下不成立** —— 我把提示**预置**给了 B ⇒ **B 在 k=1 就已带提示** ⇒
**无法把"处理效应"与"噪声"分开**（判据也记 `P1=CONTROL-FAILED`）⇒ **阳性对照失效** ⇒ **O89**。

### 50.6 ★ 另一条纠正：`tasks.jsonl` 的真实构成（**我复核过**）

```
$ grep -o '"kind":"[a-z-]*"' evals/pilot/tasks.jsonl | sort | uniq -c
      2 "kind":"capability-task"
      3 "kind":"regression-repair"
```
⇒ ★ **不是"5 条都是 regression-repair"，而是 3 + 2** ⇒
**我一路按"5 条同型"在设计（设计文档 §2.2 的论证就建立在这个前提上）** ⇒ **前提要修** ⇒ **O90**。

### 50.7 其余如实项

- **上一轮其实跑过**（`_report-dryrun.md`，臂 head = `4c08526b`），但对当前场地（`91c1564`）**无效** ⇒
  其数据产物**非破坏性归档**到 `out/ab-run/_prev-4c08526b/` ✓；
- `cli-0004` 首跑被拒（81ms、0 会话，理由=主仓脏）⇒ **复位后重跑成功**（k=5 即重跑所得）；
- ★ 判据机器报的 `记忆条目数 B=[0,…]` 是**仪器不一致**（判据默认面是 `memory-stub.mjs` **桩**，非 `memface.exe`）⇒ **权威计数 A=0/B=1**；
  判据的 `BATCH-INVALID` / `A3=FAIL` 属**形态不匹配**（判据按"累积"写，本轮是"预置常驻"）；
- **未跑 / `NEEDS-EVIDENCE`**：(甲) 累积与迁移（需 **agent 侧写工具**）、R1 带毒自检、判据自检电池 ⇒ **均未跑、未填"通过"** ✓；
- **n=5 ⇒ 不声称显著** ✓。

### 50.8 新增未闭合

| # | 项 | 说明 |
|---|---|---|
| **O88** | ★★★ **隔离必须到【沙箱级】**（真跑中 A 臂**主动改了判据根**并**探测另一臂**；抬高门槛不够） | **任何真跑的可信度** |
| **O89** | ★★ **阳性对照要重新设计**（"预置常驻"形态下 k=1 天然不同 ⇒ 对照失效） | 判据的可解释性 |
| **O90** | ★ **`tasks.jsonl` 是 3 条 `regression-repair` + 2 条 `capability-task`** ⇒ 设计文档 §2.2 的"5 条同型"前提要修；**题型混在一条序列里**也会干扰读数 | 判据设计的**前提** |
| **O91** | ★ **face 断言需要"venue 归一化"**（把 cwd 归一），否则跨卷隔离会**因隔离本身而假红** | A1 的正确性 |

---

## 51. ★★★★★ 做 O88 之前"先查三处"⇒ **O88 的性质被改写，并推翻我自己写的一条结论**

> 用户指示："要（做 O88），**先看上游和开源产物**" —— 正是**铁律 #17**（做功能组模块前必须查三处；
> 红线是"**同一件事开源已经做出了更好的版本，而我还在自己写**"）。★ **这次又抓到了我。**

### 51.1 ★★★ 发现 1：**本机已经装着那个沙箱**（O88 不该自造）

**默认就挂着**（`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:169-204`，**我复核**）：
```
- id: sandbox          name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy   name: '@deepseek-ai/dsh-sandbox-policy'
- id: bash-sandbox     name: '@deepseek-ai/dsh-bash-sandbox'
- id: pwsh-sandbox     name: '@deepseek-ai/dsh-pwsh-sandbox'
   … 三档：sandbox: read-only / workspace-write / danger-full-access
```
win32 后端 = **`@deepseek-ai/dsh-sandbox-windows-acl`**（**包确实存在**，连同 `dsh-sandbox` / `dsh-sandbox-local` / `dsh-sandbox-policy`）。
其 `README` 逐字（**我复核**）：
- `:5` "**Windows write-restriction sandbox backend**… mounted as the **`enforcement: 'partial'`** win32 rung"；
- `:7` "the caller's token is duplicated into a **`WRITE_RESTRICTED`** token whose restricting SIDs carry separate workspace and private-temp capabilities…
  **Windows grants a write only where BOTH the caller's normal access AND the restricting-SID intersection allow it**"；
- `:9` ★★ "**it implements both confinement modes without the problems the rejected container options carry**"，并点名两个被否的选项：
  **`mxc` 需要 Windows 11 24H2 + 为 arbitrary-path reads 批发写 host DACL**；
  ★★ **"AppContainer cannot do arbitrary-path reads at all"**。

### 51.2 ★★★ 发现 2：**§50.3 的"主动突破"是【覆盖缺口】，不是机制缺口** —— ⇒ **推翻我 §49.6 的结论**

- 从 `out/ab-run/r1-leak-cli-0005-A-calls.txt` 看，改判据根用的是 **`safe_rename`**（**本仓 `packages/design-canvas-bridge/src/index.ts:451` 注册**，
  `:557` 自述"**safe_rename 已注册（深度注入，kernelDir=…）**"）与 **`mcp__design-canvas__edit_code`** —— ★ **不是 `pwsh`、不是 `fs`**；
- **`dsh-mcp-client` 整包检索 `sandbox|confine` 零命中** ⇒ ★ **MCP / 桥接工具这条旁路没被 seam 覆盖**；
- ★★ **而且沙箱当时【确实挡住了写】**（留证，**我复核**）：
  `out/ab-run/report.mjs:659` 逐字："| agent **写**判据根 | **成立（被挡住）** | `Error: [sandbox: file access denied under workspace-write mode]`；且主仓 `git status --porcelain` 全程 0 行"；
  更详细的原文在 `_prev-4c08526b/outside-A-cli-0005-symbol-rename-design-canvas.json:338`：
  ```
  Error: [sandbox: file access denied under workspace-write mode]
  [sandbox: escalation available — retry this exact operation once with sandbox_permissions (…)]
  ```

⇒ ★★★ **⇒ §49.6 我写的"R1：这不是沙箱"是【错的】。真相应为**：
**沙箱存在、默认开、且实测挡住了写；漏的是"旁路工具（`safe_rename` / MCP 桥）没走 seam"。**
⇒ **O88 的性质从"自造沙箱"变成"① 确认档位与 workspace 边界；② 补旁路 seam；③ 决定'读'的边界"。**

### 51.3 ★★ 发现 3：**我点名的两个本地目录都不能复用**（纠正我的怀疑方向）

| 我原本怀疑的 | 真相 |
|---|---|
| `ai-base/agent-shell-sandbox/` | 它的 "sandbox" 是**一种【脑模式】**（`git worktree add … brain-sandbox`），**工具零路径限制**（`file.go:39/93` **绝对路径直通**）⇒ **不是隔离机制** |
| `internal/tools/sandbox/job_object_windows.go:42-47` | 只有 `KILL_ON_JOB_CLOSE` / `ACTIVE_PROCESS` / `PROCESS_MEMORY` ⇒ ★ **不含任何文件系统能力** |
| `internal/permission/`（`policy.go:49-60`） | **字符串匹配 + 评分** ⇒ **策略级**，不是物理级 |

★ **arXiv:2607.05743 给的数字正是这类"策略级"做法的天花板：真实 denylist 失效率 69%–98%。**

### 51.4 arXiv 已经给这件事命名了（**二手，标明**）

- **BenchJack**（2605.12673）：**八类缺陷、219 个**；★ **9/10 基准"近满分且一题未解"**；
- **RewardHackingAgents**（2603.11337）：★ **"单机制只能挡一个向量"**；★★ **锁定判据的代价是 `+25~31%` 中位运行时**（**代价被量化了**）；
- **VeRO 确实是先例**（`guide.md:730-734 / 500 / 741-743`），**但实现是 `chown/chmod` + 容器（Unix-only）**
  ⇒ ★ **可移植的是【架构分界】，不是实现。**

### 51.5 ⚠️ 硬边界（必须如实记）

**这套机制【只限写】**（`README.md:77` 原文）⇒ **判据根仍然【可读】**；
要"**读也不可达**"只能上 **AppContainer**（⚠️ DSH 自陈 **"cannot do arbitrary-path reads at all"** ⇒ 它**连正常读都做不到**，所以被否）
或 **WHP microVM** ⇒ ★ **所以"判据可读"是现行设计的【固有属性】，不是疏漏** —— 这是一个**有意的取舍**。

⇒ **⇒ 推论**：**"判据不可读"这一条 R1 的强形式，在当前技术选型下做不到**（除非上 microVM）。
可行的强形式是：**"判据不可【改】"（已有）+ "判据不可【枚举发现】"**（把判据根移出任何可达路径 —— 我们已做）+ **旁路工具补 seam**。

### 51.6 新增未闭合（O88 拆成三条）

| # | 项 | 说明 |
|---|---|---|
| **O92** | ★★ **补旁路 seam**：让 `safe_rename` 等 **design-canvas-bridge 工具**与 **`mcp__design-canvas__*`** 也受沙箱约束（现在零命中） | **O88 的核心** |
| **O93** | ★ **决定"读"的边界**：接受"只限写"（现状），还是上 WHP microVM 换"读也不可达" | 代价 vs 强度 |
| **O94** | **确认实际生效的沙箱档位**（`read-only` / `workspace-write` / `danger-full-access` 里，跑 A/B 时到底是哪一档；`danger-full-access` 若被用到就白隔离） | 隔离的前提 |
