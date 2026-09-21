# 现有子代模型 · 复述（2026-09-21）

> 用途：给用户比对我（本次会话）对"当前子代机制"的理解是否与设计者一致。
> **凡带 `file:line` 的都是逐字读过的；凡是推测的一律标 ⚠️。** 不确定的集中在 §11。

---

## 0. 一句话

**父代看到的是几条"名字不同的委派工具"；每条工具 = 一个（provider × 人格 × 工具面 × 出身）都固定死的子代角色。**
子代一旦创建，它的**脸**（人格 + 工具面）就在它自己的 scope 里装配好，**父代与兄弟看不到**；
它的**上下文**要么空（spawn）要么继承父代已完成回合（fork）。**中间步骤永不回父代，父代只拿到最终文本。**

---

## 1. 我们**实际挂了几条**委派工具（权威 = preset 文件，不是文档）

来源：`~/.dsh/.agent-presets/council/agent.cordis.yml`（当前默认 preset = `council`，`~/.dsh/settings.yaml:21-22`）

| preset 里的行 id | `provider` | 模型看到的工具名 | `backgroundMode` | 状态 |
|---|---|---|---|---|
| `tool-subagent` | `spawn` | `subagent` | **continuable** | 启用 |
| `tool-subagent-fork` | `fork` | `subagent_fork` | **one-shot** | 启用（2026-09-21 从 continuable 改） |
| `tool-subagent-council-architect` | `council-architect`（**我们注册的**） | `council_architect` | continuable | 启用 |
| `tool-subagent-codex` | `codex` | `subagent_codex` | one-shot，`maxDepth: provider-managed` | **`disabled: true`** |
| `tool-subagent-claude-code` | `claude-code` | `subagent_claude_code` | one-shot，`maxDepth: provider-managed` | **`disabled: true`** |

另外挂了：`tool-subagent-control`（含 `list-agents`）、`workflow-worker-thread`（provider `spawn`）、`tool-workflow`、`tool-ralph`（`subagentProvider: spawn`, `maxRounds: 64`）。

`~/.dsh/.agent-presets/` 下的 preset：`council`（默认）、`code-council`、`council-tf`、`council-tf0`、`council-tfd`、`g0`。
其中三个 `*tf*` 是**子代工具面裁剪实验**：`allow: [read, glob]` / `allow: []` / `deny: [pwsh, write, edit, subagent, web_search]`。

★ **关键结构性事实（来自 `dsh-tool-subagent/README.md:82`）**：
> "**Child policy is fixed per instance** — another model, persona, tool filter, or depth cap **requires another distinctly named tool**."

⇒ **子代角色 = 一条工具行。** 现在加一个专项子代，就要在 preset 里加一行，
而父代**每个请求**都要多付那一行 schema（`README.md:44`："Fixed schema cost per parent request; each provider instance adds one schema,
and **each continuable instance adds one short system-prompt section**"）。

★ 还有一条：**模型看不到 provider 选择器**（`README.md:9`）："the model receives **no provider selector**. Load another distinctly named instance to expose another transport."
⇒ 所以"派生一个专项子代"对模型而言，**等价于"多了一个名字不同的工具"**，不是"给同一个工具传参数选角色"。

---

## 2. 一次委派的完整生命周期

1. **父代调用**：传 `prompt` / `description`，可选 `persona`、`toolFilter`、`outputSchema`（`README.md:26-27` 的参数表）。
   `persona` / `toolFilter` **要求 provider 声明对应 capability**；我们议事厅席位两者都声明了（`packages/subagent-council/src/index.ts:76-80`）。
2. **创建窗口（未发布）**：`AgentCreationTransaction` 观察取消信号 → 可回滚；**策略（沙箱 + 审批钉）在这个窗口内写入**，
   位置在 **fork 历史之后、会话发布之前**（`dsh-subagent-in-process-driver/README.md:23`）。
3. **装脸**：`applyChildComposition(childCtx, parent, composition)`（`dsh-subagent/lib/types/child-agent.js:126-135`）：
   - `agentPresets.composeFrom(childCtx, parent.ctx)` —— 子代**加入父代的 preset**（继承，不是替换）
   - `systemPrompt.context({name:'subagent:delegation', order:120, …})` —— 委派声明，
     ★ 是 **runtime-context（落在消息面）**，**不是 system 段**（`child-agent.d.ts:68-72` 明文）
   - `if (persona) systemPrompt.section({name:'deployment:persona', order:0, text})` —— ★ **覆盖 order 0**
   - `if (toolFilter) tools.restrict(toolFilter)`
   - 注释：这些 "all owned by the child's scope and therefore **invisible to its parent and siblings**"
4. **发布 & 运行**：子代有自己的 session、自己的 turn/step。
5. **结果边界**：`README.md:54` —— "Success contains **only the child's final text**; other outcomes become `Error: <stop reason>` …
   **Intermediate child steps stay out of the parent.**"
6. **持久化**：`README.md:58` —— "**The prompt and result remain in parent history until compaction**; child working context remains in the child."
7. **善后**：`dispose()` → 终止 loop、移除 agent 与 session、回卷 scoped 注册（driver `README.md:29`）；
   批量的用 `drainContinuableDescendants(parents)`（`dsh-subagent/README.md:24`）。

---

## 3. 子代的"脸"由四层决定（决定的顺序）

| 层 | 谁定 | 能否 ≠ 父代 |
|---|---|---|
| ① 基础面 | 子代 **加入父代的 preset**（`composeFrom`） | 默认 = 父代；⚠️ 机制上 `CreateAgentOptions.meta.agentPreset` 可指定成另一份（**我们没用过**） |
| ② 人格 | `persona`（**order 0 覆盖** deployment persona） | 能（议事厅席位就在用） |
| ③ 工具限制 | `toolFilter`（allow / deny） | 能，**只能裁**（`ToolRestriction`） |
| ④ 子代 scope 内注册的工具 | 子代自己 scope 的 `tools.register(...)` | 能**加**（上游范式 = `attachStructuredRuntime` 注册 `structured_output`） |

**★ 你的"父代 + 增加"落在第 ④ 层**，而现成钩子是 `registerContinuableSetup(contribution)`
（`dsh-subagent/README.md:23`："Compose an optional deployment capability into **each continuable child's unpublished scope**"）。

**硬阻断工具面外的调用：能，且是硬的（四路一起）** ——
`dsh-subagent-in-process-driver/README.md:55`："restricts global **tool schemas, lookup, execution, and Code Mode SDK bindings**"。

**⚠️ 但 `toolFilter` 不是权限天花板**（`dsh-tool-subagent/README.md:15`）：
> "`toolFilter` changes the child's global tool layer but **is not a parent-derived authority ceiling**."
> （并链到 `.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals`）
⇒ 它是**面**的收缩，不是**权**的收缩。**"安全/授权不是目标"**是上游明确的设计立场。

---

## 4. 上下文继承：fork vs spawn

- `InProcessRunOptions = { seed?: SessionEvent[] }`；**`spawn` 不传 seed，`fork` 传一段"平衡的已完成回合前缀"**
  （driver `README.md:33`）；fork 还会记下 seed 长度，避免把父代消息误当子代产出。
- ★ `dsh-subagent/README.md:58`（**这句最重要**）：
  > "`inheritsParentContext` is **descriptive rather than enforceable**. It says only whether the child sees completed parent conversation history
  > (`fork` does; `spawn` and the out-of-process one-shot providers do not), **not whether it inherits tools, services, or authority**."
  ⇒ **fork 给的只有"看得见父代已完成对话"，不含工具、服务、权限。**
- 工具描述会**随这一点变化**（`dsh-tool-subagent/README.md:9`）：
  "fresh children require standalone prompts, while **forked children already see completed parent turns**."

---

## 5. 深度与责任链

- **持久化的 `SessionHeader.delegationDepth` 是权威且单调**：运行时 `AgentOptions.subagentDepth` **只能加深、不能降**
  ⇒ 冷唤醒的子代不会被打回顶层（`dsh-subagent/README.md:56`；driver `README.md:35`）。
- 实测：`delegationDepth` 落在 **session 事件顶层**（`evs[0].delegationDepth`），**不在 `data` 里**；实测到 0/1/2/3 四层。
- 默认 `maxDepth = 3`；**depth 4 在运行时被拒**（`Error: subagent depth 4 exceeds maxDepth 3`，`isError=true`）。
- 不可表示的深度（超安全整数域）报 `RangeError`。

---

## 6. 权限与沙箱（子代一出生就被钉死）

driver `README.md:23`：创建前**捕获**父代的显式沙箱覆盖与 **`'never'` 审批钉**，并在未发布窗口写入子代会话。
实测子代 system 里能看到："**Approval prompts are disabled in this session** … do not request sandbox escalation …
**You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session**"。
⇒ **子代不能自己提权**；缺权限时应当**陈述限制**而不是重试（同一段原文就是这样要求的）。

---

## 7. 结果通道与"子代自己的上下文"

- **one-shot**：前台等结果，或显式 `run_in_background: true` → 拿到 `jobId`，用通用任务工具 `job_output` / `job_kill` 收（`README.md:13,40`）。
- **continuable**：默认后台；子代**拥有自己后续的 turn**；父代靠 `send_message`（全局工具）继续派活；
  子代 Activation 结束时**投递一次 settlement notice**（含结果与最终 assistant 文本），**与 `report` 无关**（`README.md:13`）。
- ★ **`report` 是"host plane"注册的"续接设置"（continuable setup），不是普通工具**：
  `council/agent.cordis.yml:169-176` 解释：它 "registers a **CONTINUABLE SETUP** on that singleton rather than a tool this agent calls,
  and the setup list is not scope-aware — one copy per mounted preset means **every child gets `report` registered once per live session, which throws on the second**"
  ⇒ 所以它必须挂在 host plane，**不能**进 preset。
  **后果**：continuable 子代比 one-shot 子代**多一个 `report` 工具 + 一段 `tool:report` system 段** ⇒ **脸与父代不同**（见 §9 实测）。
- **结构化结果**：`attachStructuredRuntime(childCtx, schema)` 装整套契约（`structured_output` 工具 + order-190 段 + `tools/result` 观察者 + 单调守卫 + `concludeTurn()`）；
  ★ 并且：**若我们用自己的 `system-prompt/assemble` listener 替换了子代 system，就要自己负责保住这个协议**（driver `README.md:43`）。

---

## 8. 成本与缓存（本轮实测，只认 DeepSeek 读数）

**前提（用户裁定 2026-09-21）**：agnes 是**本地网关**（`~/.dsh/settings.yaml:5-14`，`http://127.0.0.1:3101/v1`），
**免费、只跟次数有关** ⇒ **它的命中率没有经济意义，不能当判据**；我们的结论只取 **`deepseek-v4-flash`** 的样本。

**实测（181 会话 / 15 对父子；剔除非 DeepSeek 后 n=10）**：

| 因子 | DeepSeek 样本上 |
|---|---|
| 子/父**工具数相同** | **高命中 5 / 低命中 0** |
| 子/父**工具数不同** | **高命中 0 / 中 2 / 低 2** |
| **`system` 逐字完全一致** | **高命中 5 / 低命中 0**（缓存读 40448–41088） |
| `system` 不一致（公共 25%~90%） | 高命中 **0** |
| `provider = fork` | 3 高 / **1 低** ⇒ **不是干净分割** |
| `provider = spawn` | 2 高 / 2 中 / 2 低 ⇒ **不是干净分割** |

**字节级因果（`out/probe-tools-insert.mjs`）**：`436fde97`（continuable）子工具 103 vs 父 102，
多出的 `report` **按字典序插在第 88/103 位**（`read_image` 与 `safe_rename` 之间），
同时写进 system（断点原文即 "Deliver your result with the `report` tool before you finish…"）。
⇒ 该子代首请求：缓存读 **1152**、未缓存输入 **40103**（命中 **2.8%**）。
对照 `1df6c839`（one-shot，102 = 102，system 100% 一致）：缓存读 **40576**（命中 **98.6%**）。

**⇒ 规则：`[system + tools]` 是父代的逐字前缀 ⇒ 吃到 ~98–99%；出现任一差异字节 ⇒ 从该处起全部重算（含 fork 继承来的整段历史）。**
**append 保前缀；crop / shadow 砸前缀。**

**⚠️ 三个因子在本样本内共线**（工具面一致 / system 一致 / `mode=one-shot` 的样本是同一批）⇒ **谁是真因尚未分离**；
但 **provider 名字（fork/spawn）已被排除**（组内既有高又有低）。

---

## 9. 我们自己这一层做了什么

- **`@dsh-brain/subagent-council`**（`packages/subagent-council/`）：注册 `council-architect` 席位 provider。
  ★ 注册在 **host plane**（包内 `cordis.patch.yml`），因为 `subagents` registry 是进程单例、provider 名全局唯一 ⇒ preset 只挂工具行。
  席位人格写在代码里（`SEAT_PERSONAS.architect`），`start()` 里 `next.persona = this.#persona`（`src/index.ts:99-100`）；
  `capabilities = { toolFilter: true, persona: true }`；`src/index.ts:72` 有注释：**"若某席位要限制子代理的工具集，可在 start() 里补 toolFilter"（尚未用）**。
- **`subagent_fork` 绑 `one-shot`**（2026-09-21）：preset 里的注释写明理由 ——
  "fork 相对 spawn 的唯一回报是 provider 侧前缀复用；而 continuable 子代的 `report` schema 与 `tool:report` system 段**都住在请求头、先于所有消息**
  ⇒ continuable 的 forked child 在第一个继承回合之前就作废了复用"。
  ★ **本轮实测把这个推理量化了：40576 → 1152（98.6% → 2.8%）。这是它的独立验证。**

---

## 10. 与你的构想逐条对照（**这一节是"看理解一不一样"的核心**）

| 你的构想 | 现状 | 差在哪 |
|---|---|---|
| 子代理即 skill（渐进披露） | ❌ **不是** | 每个子代角色是**常驻工具行**：父代每个请求都付 schema +（continuable 时）一段 system 段。**席位数一多，父代的脸就膨胀** |
| 父代像调 skill 一样调子代 | ⚠️ 半成立 | 调用形态像（一条工具 → 一个角色），但**没有"渐进披露"**：不是"读到时才知道有什么能力"，而是"一直在 face 上" |
| 子代 = 父代 + 专有工具（增加而非裁剪） | ⚠️ 半成立 | 机制在（子代 scope `tools.register` + `registerContinuableSetup`），**我们一条都没用** ⇒ 目前"专有"是靠**另起工具行/preset**，不是"从父代脸上长出来" |
| 子代知道自己当前工具面 | ✅ 成立 | 四条同时生效：schemas / lookup / execution / Code Mode SDK bindings；调用点还能传 `persona`、`toolFilter` |
| 子代能唤起子代 | ✅ 成立且已实测 | depth 0/1/2/3；**depth 4 被拒**；深度持久化在 session header 且单调 |
| fork 复用父代上下文省一笔 | ✅ 成立（**有前提**） | 实测首请求吃到 40576/41024 缓存读（98.6%）——**前提是脸逐字一致**；一旦脸不同，省的全吐回去还倒亏 |
| 动态注入 + 压缩时合并/清除 | ❌ **对象不存在** | "前面的脸"不在 messages 里（system/tools 是**每步装配的派生物**），压缩器只能改 messages ⇒ 无物可清 |
| 子代有自己的持久上下文 | ✅ 成立 | `continuable`（durable + `send_message` 继续派活 + `report`）；`fork` 我们绑了 `one-shot` |

---

## 11. 我不确定的（诚实清单）

1. **本样本内三因子共线**（工具面 / system / mode）⇒ 真因未分离。要定论必须做**受控 A/B**（同父同题，只改一个变量）。
2. **"新增工具排到工具列表末尾"能否保住前缀**：机制上应当能（LCP 只断在尾部），**但没实测**。
   `dsh-system-prompt/README.md:14` 的 `toolOrder` + `<unlisted-tools>` rest entry 是可用杠杆。
3. **`agentPreset` 能不能给子代指定成"另一份专属 preset"**：`childSessionMeta` 写的是父代 composed preset（`child-agent.js:82-85`），
   `applyChildComposition` 是"加入父代 preset" ⇒ **我没找到"给子代换一份 preset"的公开入口**，可能要靠定制 provider。
4. **`registerContinuableSetup` 只能用于 continuable 子代**（名字即如此，`README.md:23`）⇒ 若要给 one-shot 子代加专有工具，入口**未找到**。
5. **`toolOrder` 是否对"子代 scope 新增的工具"也生效**（它由 `knownNames` 全集驱动）—— 未验证。
6. **我们没有用过 `subagent_control` / `list_agents` / `send_message`**，它们的实际行为我没读。
7. **`dsh-tool-subagent-report` 的 host-plane 行**我只从 preset 注释里读到，**没去 profile 里核对它是否真的挂着**。
