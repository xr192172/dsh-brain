# 分身规格 · 施工用（2026-09-21 定稿）

> **本文件是自足的施工依据**：不依赖任何对话历史、不依赖 `skill-as-agent-feasibility.md` 的上下文。
> 那份 feasibility 文档是**讨论过程记录**（§1–14，含每一次更正），**本文件是它的结论固化**。
> **压缩上下文后如需恢复工作，只读本文件 + `out/` 下的实测输出即可继续。**
>
> 证据格式：`包/lib/...:行` 或 `docs/子路径:行`（克隆在 `D:\project_develop\_research\deepseek-harness\deepseek-harness-master\`）。

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

### D6 若要让"脸"由我们掌控：**必须自写一套 presentation**
- **依据**：`dsh-system-prompt/README.md:20` —— **"Duplicate names within one layer … throw"**；
  而 `tools:sdk` 已由 preset 的 `tool-presentation` 行在**子代自己的 scope**注册一份（子代继承 preset ⇒ 重跑那行）。
- **可用的实现位**：`dsh-tools/lib/index.js:2635` —— `PromptSection.text` **可以是 `(context) => string`**，
  且该段**按调用 scope 求值**（`:2625` 注释 "registered globally … **and per scope by `presentAs`**"、
  "**The body regenerates from the CALLING scope**"）⇒ **冻结 = 在函数里返回同一缓存串；压缩点 = 让缓存失效。**
- **状态**：✅ 定（**细节见 O1**）。

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

---

## 3. 术语（施工统一口径）

| 词 | 定义 |
|---|---|
| **脸** | 一次请求里 `system` + `tools` 字段的合称（**模型看到的全部能力面**） |
| **投影** | 脸中的能力描述（code 模式 = `tools:sdk` 段；native 模式 = `tools` 字段里的 schema 列表）。**可替换、可冻结** |
| **桥** | 注册表里**唯一一个、schema 永不变**的入口工具；它把我们内部的能力集暴露给模型 |
| **尾部目录** | 往**消息尾端**追加的能力清单（skill catalog 形态） |
| **native / code** | `dsh-agent-tool-presentation/README.md:5`："`native` (every schema)" / "`code` (only `run_code` plus a generated TypeScript SDK)" / `both` |
| **压缩点** | 一次 `compaction/end`（无 error）或 `compaction/prune`。**唯一可以免费动车的地方** |

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

| # | 未闭合 | 挡住 | 下一步怎么查 |
|---|---|---|---|
| O1 | `text` 是纯函数，**它怎么知道"已经过了一次压缩"** | S5 | 用 S1 的信号翻一个闭包标志（**首选**）；次选读压缩计数 |
| O2 | **桥的接口形状** + 运行时解析怎么接进 `run_code` 的 binding 管线 | S2 | 读 `docs/tool-catalog.md` 的 `run_code` 段 + `dsh-code-runtime-worker-thread` README |
| O3 | `session/event` 订阅的**确切签名**（生成区） | S1 | 读 `docs/subsystems/session.md` 的 `#ctxsessions--sessionstore` 段 |
| O4 | `compaction/end` **带 `error`** 时刷不刷 | S5 | 需要一次受控实验（故意让压缩失败） |
| O5 | 全局注册 vs per-scope 注册在**遮蔽/重复抛错**上的准确边界 | D6 | 一次最小实验：同 scope 同名 section 两次声明 |
| O6 | 内层能力要不要**补回**上游的调度契约与 `tools/result` 观察者 | S6 | 产品决定 + 一次 A/B |
| O7 | 子代能否声明与父代**不同的 presentation** | D7/S3 | 未验证 |

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
