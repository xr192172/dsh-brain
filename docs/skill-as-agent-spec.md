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
