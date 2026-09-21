# fork 的归属：ai-base 的提案 vs DSH 的实现（2026-09-21 核验）

> 触发（用户）：「Agent fork 那一项真的是上游的，而不是我之前写过的吗？我之前写过一个一样的东西，
> 是从 **AI base 项目下的 agent 项目**里就存在的一个提案，当时是为了做**记忆系统的论文系统**，
> 以及**最大化利用前缀缓存**提出来的。」
>
> 结论先行：**两个说法都对，只是说的不是同一层。**
> **实现归属 = 上游的**（我们现在跑的那份不是我们写的）；
> **设计归属 = 你的更早**（ai-base 的 `agent-shell` 在 **2026-07-14** 就有 "SubagentTool — fork 上下文"，
> 且 **2026-08-04** 就做了"按是否依赖前缀缓存区分"的凭据轮换），而 **DSH 公开发布是 2026-08-13**。

---

## 1. 实现归属：**是上游的**（四条证据）

| 检查 | 结果 |
|---|---|
| 我们的 `packages/` 里有 fork provider 吗 | **没有**（只有 `capability-bridge`/`conveyor-context`/`design-canvas-bridge`/`key-pool-proxy`/`skill-tree`/`subagent-council`/`switchboard`/`tool-evolution`；`subagent-council` 注册的是 `council-architect`） |
| 运行的那个包的 `package.json` | `@deepseek-ai/dsh-subagent-fork-in-process@0.1.1-rc.2`，**`repository` = `git+https://github.com/deepseek-ai/deepseek-harness.git`，`directory: packages/subagent/subagent-fork-in-process`**；`@deepseek-ai/dsh-tool-subagent` 同 |
| 它是不是我们 link 过去的本地代码 | **不是**：`node_modules/@deepseek-ai/…` 里是**真实目录**（非 symlink）；profile 树里的 symlink 只是**指回我们仓库的 node_modules**（pnpm 共享树的做法） |
| 我们 patch 过它吗 | **没有**。`patches/` 里**只有一条**：`@deepseek-ai+dsh-compaction-basic+0.1.1-rc.2.patch` |

⇒ **运行态的 fork 代码是上游的，且未被我们 patch。** 我说的"上游的"= **实现归属**，这点没错。

---

## 2. 设计归属：**ai-base（你的 `agent-shell`）更早，而且是独立实现**

`D:\project_develop\ai-base` 是**你的项目**（Go，537 个提交，最后提交 2026-08-26）。它的 git 历史：

| 提交 | 日期 | 内容 |
|---|---|---|
| **`193eb26a`** | **2026-07-14** | `ch19 §3: SubagentTool — **fork 上下文** + ReAct Loop 执行文档整理任务`（`agent-shell/internal/tools/subagent.go` **+283 行**） |
| **`567db9fe`** | **2026-07-18** | `fix(tools): SubagentTool fork 时**清理尾部未配对 assistant(tool_calls)** 避免 OpenAI 400`（+33 行 +**132 行测试**） |
| `2186e45b` | — | `diag(subagent): 每轮 LLM 调用打印 **cache hit/miss** + messages 摘要` |
| **`f8d6a80f`** | **2026-08-04** | `API 池轮换策略：**按是否依赖前缀缓存区分**（缓存敏感保守轮换 / 无缓存限流即轮换）`（8 文件 ~280 行，含 `credential_pool.go`/`deepseek.go`） |

**★ 命名不同 ⇒ 不是抄来的**：ai-base 自己那份里 **`completedTurnPrefix` 命中 0**、**`prefix reuse` 命中 0**
（那两个"精确标识符"的命中**全在 `ai-base/references/deepseek-harness-master/` 与 `_archive/` 里**
—— 那是**你存放的上游源码副本**，不是你的实现）。

**时间线**：你的 fork 上下文 = **2026-07-14**；DSH **公开发布 = 2026-08-13** ⇒ **早约一个月**。
（⚠️ 但 DSH 在开源前是内部开发的 ⇒ **只能确认"你的更早"，不能推断"上游抄了你"**。两者的交集是
**"fork 父代上下文以省前缀缓存"这个洞察本身** —— 这是**收敛**，不是谁抄谁。）

---

## 3. ★ 同一个坑，两种机制（这里我纠正了自己 5 分钟前的假设）

ai-base 在 **2026-07-18** 修的坑（提交信息原文）：
> 主 agent 调用 subagent 工具时，`messages` 末尾会有一条 `assistant(tool_calls=[subagent_xxx])`，
> **但对应的 tool result 还没产生**（本工具还在执行中）。
> OpenAI/DeepSeek 严格要求 `assistant(tool_calls)` 后必须跟对应的 `tool` 消息，
> 否则 **400: "insufficient tool messages following tool_calls message"**。
> 修复：抽 `stripTrailingUnpairedToolCalls(...)`，fork 后立即清理尾部未配对（含"尾部多条"的防御性处理），**7 个用例**。

**我一度以为这就是上游 issue #2124（重开条件 = "子代的 system prompt 与 tool schemas 能与其父代逐字节相同"）缺的那块拼图。**
**但我核过 DSH 的写法，它不是缺的**：

```js
// packages/subagent/subagent-fork-in-process/src/index.ts:50-53
const lastEnd = events.findLast(e => e.type === 'turn/end')
if (lastEnd === undefined) return []
return events.slice(0, lastEnd.seq + 1)   // ← 只取到【最后一次 turn/end】为止
```

⇒ **DSH 的 `completedTurnPrefix` 已经从机制上排除了"在飞行中的未配对 tool_calls"**
（它只切到最后一个 `turn/end`，之后的都不要）。**两种机制解同一个要求**：
- **ai-base**：保留全部历史，**剥掉尾部未配对**；
- **DSH**：**只取到最后一个完成回合**（更干净，一次切到位）。

⇒ **所以我不该把 ai-base 那条说成"#2124 缺的拼图"** —— 那是又一次"没读完就归因"。**已作废。**

---

## 4. ★ 但 ai-base 里有**两样对我们直接有用、且上游没有**的东西

1. ★★ **"前缀缓存敏感的凭据轮换"**（`f8d6a80f`，2026-08-04）：
   按**是否依赖前缀缓存**区分轮换策略（缓存敏感 ⇒ 保守轮换；无缓存 ⇒ 限流即轮换）。
   **上游的架构笔记只讲了"请求头增量会作废复用"，没讲"换凭据/换池也会"。**
   ⇒ **对我们的实验是一条硬纪律**：**臂间与轮内都别轮换凭据/池** —— 否则**前缀缓存被清，成本面读数会漂**，
   而**成本面正是我们实验的一根主轴**。我们已有 `key-pool-proxy(pool=3)`（见 boot.log），
   **必须确认它在实验期间不轮换**，并把"轮换次数"记进成本面的元数据。
2. **一份可对照的实现先例 + 测试**：`stripTrailingUnpairedToolCalls` 的 **7 个用例**
   （单条/多条/无 `tool_calls`/user/tool/空切片/**不污染源**）——
   在我们要写"子代请求头逐字节相同"的判据时，**"不污染源"与"尾部多条"这两个边角**值得照抄。

---

## 5. 结论（一句话）

**设计是你的、更早；实现是上游的、未被我们 patch。两者是收敛关系。**
**而我们该从 ai-base 拿的，不是 fork 的实现（上游有更好的），而是① 前缀缓存敏感的凭据轮换这条实验纪律；
② 那 7 个用例里的两个边角（尾部多条 / 不污染源）。**

---

## 6. 未核实 / 没把握

1. **无法判断上游是否借鉴了你的方案**（DSH 开源前内部开发，无可查证据）⇒ 本文只陈述"你的更早"。
2. `ai-base` 里是否还有 `ch18/ch19` 那份**成文的设计提案**（"记忆系统的论文系统"）**我没去找** ——
   只从提交标题看到 `ch19 §3`；**若要引用，应把那份文档找出来读**。
3. ai-base 的 `agent-shell` 是否**仍在维护**、其 fork 实现是否被后续重构替换 —— **未查**。
4. 本文对 `ai-base` 的结论只覆盖 `agent-shell/`、顶层 `*.md` 与 `docs/`；
   `_archive/` 与 `references/` 里的命中**已排除**（那是上游副本）。
