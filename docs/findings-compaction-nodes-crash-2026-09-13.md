# 压缩崩溃排查记录：`Cannot read properties of undefined (reading 'nodes')`

日期：2026-09-13 ｜ 目标会话：`session-28f50f57-61e4-434e-a8eb-7e7544c71a70`（约 462K tokens / 14.9 MB）
运行时：switchboard 3080 / 31800，gen A 3082，key-pool 3101，DSH_HOME `C:\Users\Admin\.dsh`

---

## 1. 结论速览

| 问题 | 状态 |
|---|---|
| **崩溃根因** | ✅ **已确认并修复**（见 §9）——兜底对象漏了 `measurement` 字段 |
| 崩溃代码行 | `dsh-compaction-basic/lib/index.js:722:94` `prepared.measurement.nodes` |
| 触发条件 | LLM 摘要失败 → 走 `deterministicFallbackPrune` 兜底 → 下一行必崩 |
| 是否是瞬时失败 | **否**。摘要重试 8~9.5 分钟后放弃，兜底随即崩溃 |
| safeMeasure 补丁是否修好了 | **否**。失败那次已加载该补丁（但它改错了地方） |
| 换代 catchup（任务 c） | **已不复现**，多次换代成功 |
| 任务 b（三脑真接入） | 前置事实纠正：15813 是 Go Hub，**elv/dsh-hub 根本没在跑** |
| 附带发现的第二个问题 | 缺 `AGENTSHELL_MAIN_LLM_API_KEY` → `llm-pi-ai: no credential for provider route "agnes"`（见 §10） |

**一句话根因**：`deterministicFallbackPrune()` 返回的摘要对象**没有 `measurement`**（也没有 `selectedNodes`），
而它紧接着被当作 `prepared` 传给 `assertWholeSurfaceUnchanged()`，后者读 `prepared.measurement.nodes`
→ `TypeError: Cannot read properties of undefined (reading 'nodes')`。
这条兜底路径是 09-13 **01:09** 随"6 项修复"引入的，**首次崩溃出现在 01:11:31**（seq 306452）——时间完全吻合。

---

## 2. 时间线实证（推翻"瞬时失败"判断）

从会话 jsonl 解出的原始时间戳（字段 `time`，毫秒）：

```
seq 416920  compaction/start   t=1789290596412   17:09:56.412
seq 416921  compaction/end     t=1789291089507   17:18:09.507   ERROR "…reading 'nodes'"
                                    Δ = 493,095 ms ≈ 8 分 13 秒

seq 416928  compaction/start   t=1789291108535   17:18:28.535
seq 416929  compaction/end     t=1789291681561   17:28:01.561   ERROR "…reading 'nodes'"
                                    Δ = 573,026 ms ≈ 9 分 33 秒
```

- 失败**成对出现**（`compaction/start` 紧邻 `compaction/end`），间隔约 330 seq 重试一轮。
- 失败后本轮请求**仍然继续**（`seq 416925 request/header` → `seq 416926 assistant/chunk`，inputTokens 16 万+），
  即压缩失败不会中断 turn，只会让上下文一直压不下来 → 继续 400。

全会话共 99 次 `compaction/start`、98 次 `compaction/end`、64 次 `compaction/summary`、35 次 `compaction/prune`，
其中 33 次 `compaction/end` 带 error：早期是 `"Stream ended without finish_reason"` /
`"summarization produced no text summary content"` / `"Request was aborted"`；
从 `seq 306452`（09-13 01:11）起一律变成 `"Cannot read properties of undefined (reading 'nodes')"`。

---

## 3. 为什么能断定"崩在提交/校验阶段"

`@deepseek-ai/dsh-llm/lib/index.js:313-332` 的 `errorChain()` **会拼接 cause 链**：

```js
const causeText = current.cause === undefined || current.cause === null ? "" : render(current.cause);
return `${message}${members}${causeText === "" || causeText === message ? "" : `: ${causeText}`}`;
```

而 `compaction/end` 里落盘的 error **就是纯粹的** `Cannot read properties of undefined (reading 'nodes')`，没有前缀。
→ 它是**顶层异常**，不是被 `SurfaceChangedError("…", { cause })` 包装过的内层错误。

（反证：若来自 `assertSelectedSpanStable` 里 `validateSurfaceRegion` 的 catch，落盘会是
`"compaction: the selected span is no longer a valid replacement target: …reading 'nodes'"`。）

`compactSurfaceRegion`（`dsh-compaction-basic/lib/index.js:468`）的 try 块中，能抛出顶层异常的只有 4 处：

| 行 | 位置 | 说明 |
|---|---|---|
| 496 | `prepareCompaction(deps, session, selection)` | 内含已加固的 `safeMeasure` + `buildSummarizationInput` |
| 506 | `assertStable(deps, session, summarized)` | `assertWholeSurfaceUnchanged` / `assertSelectedSpanStable` |
| 508 | `commitCompactionBody(session, startEvent, summarized)` | 两次 `session.append`，含 `surfaceOp: replace` |
| 510 | `session.append("compaction/end", lifecycle)` | 同上 |

**排除摘要器**：`summarizeCompaction`（499）的异常被 500-504 行 catch 并回退到 `deterministicFallbackPrune`，
不会冒泡；且 `summarizeWithLlm`（284-333）**不含任何 `.nodes` 读取**。

---

## 4. 已经排除的假设

### 4.1 safeMeasure 不是（完整的）修复

- `dsh-compaction-basic/lib/index.js` 在 17:08:26 被写入（含 `safeMeasure`，patch 文件可证）。
- gen-3084（pid 11340）**启动于 17:09:08** → 该 gen **已加载 safeMeasure**。
- 它仍在 17:18:09 抛出 `reading 'nodes'`。
- 结论：崩溃点**不在** `dsh-compaction-basic` 里那批已被 try/catch 包住的 `meter.measure(...)` 解引用。

> 注意一个**误报**：`grep '\.measure\(session\)\.nodes'` 会命中，但那是 `safeMeasure` 文档注释里
> 引用的旧代码文字，不是活代码。

### 4.2 `dsh-compaction` 的 `balanceCache` 只可能因"非 Session 对象"而崩

```js
// @deepseek-ai/dsh-compaction/lib/index.js:52-54
function balanceCache(session) {
    const surface = session.surface;
    const seqs = surface.nodes;        // ← TypeError 候选
    const generation = surface.replaceGeneration;
```

但要让它崩，必须 `session.surface === undefined`。而：

- `session.surface` 在**整个 `@deepseek-ai` 树里从未被赋值**（全树 grep `\.surface\s*=[^=]` 只命中
  `dsh-token-meter` 内部 state 字段，与 session 无关）；
- `dsh-session/lib/index.js:1310-1314` 里它是 getter，恒返回构造期初始化的 `this.surfaceManager`；
- `SurfaceManager._state = createFoldState()` 有默认值 `{ nodes: [], replaceGeneration: 0 }`，
  `get nodes()` 也不会返回 undefined。

**更强的反证**：`compactSurfaceRegion` 第 470 行的 `validateSurfaceRegion`
（`if (!session.surface || !Array.isArray(session.surface.nodes)) throw …`）在 `compaction/start`（487）**之前**执行，
而失败案例里 `compaction/start` **确实被写入** → 那一刻 `session.surface` 是**真值**。

→ 所以 TypeError 要么来自 `balanceCache` 之外的 `.nodes` 读取点，要么来自 `surface.nodes` getter 内部
（已逐行核对 `SurfaceManager._processDelta/applySurfaceEvent/planSurfaceEvent`，`state` 恒有定义）。

### 4.3 全树 `.surface.nodes` 读取点清单（已逐一核对）

| 文件:行 | 是否有守卫 |
|---|---|
| `dsh-compaction-basic:398` | ✅ `session.surface && Array.isArray(...)` |
| `dsh-compaction-basic:645` | ✅ 同款守卫 |
| `dsh-compaction-basic:675/676` | ✅ 先 `if (!session.surface \|\| !Array.isArray(...)) throw` |
| `dsh-compaction:54` | ❌ 无守卫（但需 `session.surface === undefined`，见 4.2） |
| `dsh-token-meter:624` | ✅ 上游 `if (surface !== void 0)`；且 `measure()` 已被 safeMeasure 包住 |
| `dsh-session:1545`（`deriveMessages`） | getter 恒有值 |
| `dsh-agent-loop:35` | `session.surface.nodes` |
| `dsh-agent-instructions:811/1062/1200` | `agent.session.surface.nodes` |
| `dsh-compaction-tool-result-pruner:138` | `[...session.surface.nodes]` |
| `dsh-tool-skill:310` | `agent.session.surface.nodes` |

后 5 处都在 `agent/pre-step` 的 **`next()` 之后**（即压缩 try 块之外），其异常不会落进 `compaction/end`。

### 4.4 摘要器不是崩溃点

`summarizeWithLlm`（`dsh-compaction-basic:284-333`）只做：取 target → 拼 messages → `ctx.llm.stream()` →
`assembler.finish` → `summaryText`。**没有 `.nodes`**。且其异常被 500-504 行兜底。

---

## 5. 已部署的诊断（关键动作）

**问题**：gen 进程的 stdout/stderr **不被 switchboard 日志捕获**，所以 `console.error` 看不到堆栈。

**对策**：在 `compactSurfaceRegion` 的 catch 块写入**持久化文件**
`D:/project_develop/dsh-brain/out/compaction-fail.log`（`appendFileSync`），字段包括：

```
stage, errorName, errorMessage, errorStack,
sessionCtor, sessionKeys, surfaceType, surfaceIsUndefined, surfaceCtor,
surfaceNodesIsArray, surfaceNodesLen, eventsIsArray, eventsLen, hasAppend,
selection, ownerKind, agentSessionSameAsSession
```

已用 patch-package 重建补丁：
`patches/@deepseek-ai+dsh-compaction-basic+0.1.1-rc.2.patch`（17:34，24007 字节，含 `compaction-fail.log`）。

`errorStack` 会直接指出崩溃的**具体文件:行**，一次复现即可收口。

---

## 6. 复现步骤（需要用户执行）

> **前提**：本环境里工具无法维持后台服务（见 §7），必须在**用户自己的终端**启动。

```powershell
# 1. 启动 switchboard（沿用既有启动器）
powershell -ExecutionPolicy Bypass -File C:\Users\Admin\AppData\Local\Temp\start-switchboard-ascii.ps1

# 2. 在 Web UI 打开 session-28f50f57，随便发一句（例如「继续」）
#    压力压缩会在 agent/pre-step 触发，约 8~9 分钟后失败

# 3. 读取诊断
Get-Content D:\project_develop\dsh-brain\out\compaction-fail.log -Tail 60
```

也可用本轮新增的脚本自触发（无需 UI）：

```powershell
cd D:\project_develop\dsh-brain
.\.tools\node\node.exe scripts\session-drive.mjs list
.\.tools\node\node.exe scripts\session-drive.mjs prompt session-28f50f57-61e4-434e-a8eb-7e7544c71a70 "继续"
```

---

## 7. 环境约束（本轮踩坑，后续必读）

| 约束 | 表现 | 绕过 |
|---|---|---|
| Bash 工具 PATH 被破坏 | `dirname: command not found`，`grep/head/cat` 缺失 | 命令开头 `export PATH="/c/Windows/System32:/c/Windows:/usr/bin:/bin"` |
| PowerShell 工具输出被吞 | 命令成功但无 stdout | 结果写文件 → 用 Read 读 |
| 无法维持后台服务 | `Start-Process`、`detached+unref` 起的进程在工具调用结束即被回收；`schtasks` 被安全策略黑名单禁用 | **只能由用户终端启动 switchboard** |
| 跨 shell 启动被拦 | 从 Bash 调 `cmd.exe` 做 `start`、或调 `powershell.exe` | 均被安全策略阻止 |
| `Start-Process` 环境字典冲突 | `-PassThru`/`-RedirectStandardOutput` 报 `HTTP_PROXY`/`http_proxy` 重复键 | 用不带这些参数的 `Start-Process`（但仍会被回收） |
| 会话文件不是纯事件流 | 存储层用 `packChunkRuns` 打包连续 chunk：65220 条记录里仅 51379 条带 `seq`，seq 不连续 | 离线复现需先解包，或改走 §6 的在线复现 |

---

## 8. 附带确认的两项待办状态

**任务 c —— 换代 catchup：已不复现。**
`%TEMP%\switchboard-nodes.log` 记录多轮 `✅ 切换成功 → gen-3083 / gen-3084`，均带
`resume=session-…`，未见 `b-catchup-failed`。

**任务 b —— 三脑真接入：前置事实需纠正。**
- 15813 占用者仍是 **Go Hub**：`agent-shell.exe --hub-server localhost:15813 --no-spawn --project-root …\hub-spike`
  （pid 25184，起于 09-11 17:10）。
- **elv/dsh-hub 根本未运行**（只有 15817 一个 mock）。
- 所以 bridge 接入 15813 目前对接的是 Go Hub，其 `/api/brains` 状态不会被 bridge 的 `session.hello` 改写。
  要推进任务 b，需先把 elv/dsh-hub 起在 15813（或另择端口并改前端指向）。

---

## 9. 根因确认与修复（18:30，含真实堆栈）

持久化诊断成功抓到堆栈：

```
===== 2026-09-13T10:24:38.997Z compaction-fail =====
stage=summary
errorName=TypeError
errorMessage=Cannot read properties of undefined (reading 'nodes')
errorStack=TypeError: Cannot read properties of undefined (reading 'nodes')
    at assertWholeSurfaceUnchanged (…/dsh-compaction-basic/lib/index.js:722:94)
    at compactSurfaceRegion (…/dsh-compaction-basic/lib/index.js:507:3)
    at async BasicCompactionEngine.compactIfNeeded (…/dsh-compaction-basic/lib/index.js:1174:13)
    at async Object.<anonymous> (…/dsh-compaction-basic/lib/index.js:939:20)
    at async Object.<anonymous> (…/dsh-plan-mode/lib/index.js:134:21)
    at async Object.<anonymous> (…/dsh-tool-skill/lib/index.js:182:20)
    at async Object.<anonymous> (…/dsh-tool-skill/lib/index.js:147:20)
    at async Object.<anonymous> (…/dsh-agent-instructions/lib/index.js:1272:20)
    at async SessionReferenceResolver.ctx.on.prepend (…/dsh-session-reference/lib/index.js:360:22)
    at async ReactLoopAgent.preStep (…/dsh-agent-loop/lib/index.js:501:20)
sessionCtor=Session            surfaceCtor=SurfaceManager      surfaceIsUndefined=false
surfaceNodesIsArray=true       surfaceNodesLen=587            eventsIsArray=true
eventsLen=416937               hasAppend=function             agentSessionSameAsSession=true
selection=356589..408993 idx 0..479        ownerKind=turn:current-turn
```

### 定位

`:722` 第 94 列逐字符数下来，正好落在 **`prepared.measurement.nodes` 的 `.nodes`** 上：

```js
// index.js:721-723
function assertWholeSurfaceUnchanged(dependencies, session, prepared) {
    if (!isDeepStrictEqual(safeMeasure(dependencies.meter, session).nodes, prepared.measurement.nodes)) throw new SurfaceChangedError(…);
}
```

而 `compactSurfaceRegion` 里传给它的 `prepared` 实参其实是 `summarized`：

```js
// index.js:496-507
const prepared = prepareCompaction(dependencies, session, selection);
let summarized;
try {
    summarized = await summarizeCompaction(…);          // 成功路径：{...prepared, ...summaryResult, checkpointMessage}
} catch (summaryError) {
    …
    summarized = deterministicFallbackPrune(prepared, compactionId);   // ← 兜底路径
}
assertStable(dependencies, session, summarized);        // ← :507，崩在这里
```

`deterministicFallbackPrune` 的返回体**只挑了 10 个字段**，`measurement` 与 `selectedNodes` 都不在其中：

```js
// 修复前
return { start, end, shadowedSeqs, shadowedTokenCount, summary, provider, model, maxTokens, usage, checkpointMessage };
```

`summarizeCompaction` 是靠 `{...prepared, ...summaryResult}` 把 `measurement` / `selectedNodes` 带过去的，
兜底函数改为手工挑字段时**漏掉了这两个**。

### 完整因果链

1. 摘要器失败（本机是缺凭据，见 §10；历史上也出现过 `Stream ended without finish_reason` / 无文本输出）；
2. 进入 `deterministicFallbackPrune` 兜底；
3. 下一行 `assertStable` 读 `prepared.measurement.nodes` → **TypeError**；
4. `compaction/end` 落盘错误、surface 一次都没缩 → 请求继续带 46 万+ tokens → **继续 400**。

### 修复（两处，均已写入 patches/）

**① 兜底对象补齐字段** —— `deterministicFallbackPrune` 增加：

```js
measurement: prepared.measurement,
selectedNodes: prepared.selectedNodes,
```

**② 兜底路径放宽稳定性规则** —— `const assertStable = …` 改为 `let`，并在兜底分支切换：

```js
assertStable = assertSelectedSpanStable;
```

理由：确定性裁剪不依赖模型输出，无需"整条 surface 与摘要开始时逐字节一致"；
它只需要**自己的区间**仍是 present / 连续 / balanced 的合法替换目标。
沿用 `whole-surface` 会让摘要重试期间尾部的任何新增都作废兜底 —— 那正是兜底要打破的死锁。
区间完整性（`validateSurfaceRegion` + `shadowedSeqs` 相等 + `selectedNodes` 相等）仍然强制。

### 回归守卫

新增 `scripts/check-compaction-fallback-shape.mjs`：静态对照"断言读哪些字段"与"兜底给哪些字段"，
缺字段即非零退出。当前输出：

```
OK   assertWholeSurfaceUnchanged: 兜底对象已含其读取的全部字段 (measurement)
OK   assertSelectedSpanStable: 兜底对象已含其读取的全部字段 (start, end, shadowedSeqs, selectedNodes)
OK   compactSurfaceRegion: 兜底路径已切到 assertSelectedSpanStable
结果: PASS
```

补丁：`patches/@deepseek-ai+dsh-compaction-basic+0.1.1-rc.2.patch`（18:32，25695 字节，含上述两处）。

---

## 10. 附带问题：`llm-pi-ai: no credential for provider route "agnes"`

本轮新出现的报错：

```
llm-pi-ai: no credential for provider route "agnes"; its profile resolves
AGENTSHELL_MAIN_LLM_API_KEY, which is not set — store AGENTSHELL_MAIN_LLM_API_KEY
through the credentials service (the web Models page writes it) or export it…
```

### 配置现状

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    agnes:
      apiKeyEnv: AGENTSHELL_MAIN_LLM_API_KEY
      baseURL: http://127.0.0.1:3101/v1        # 指向同进程的 key-pool-proxy
```

```yaml
# ~/.dsh/profiles/candidate/…/key-pool-proxy/cordis.patch.yml
config:
  poolEnv: AGENTSHELL_MAIN_LLM_API_KEYS
  fallbackEnvs: [AGENTSHELL_MAIN_LLM_API_KEY]
  upstreamBase: https://apihub.agnes-ai.com
  port: 3101
```

`dsh-credentials` 从**进程环境**、凭据库、`.env` 三处解析。而启动器
`start-switchboard-ascii.ps1` 原本**只把 key 塞进 `GEN_ENV_EXTRA`（给 gen 的 JSON），
没有放进自己的进程环境** —— 一旦不经启动器启动（或 gen 未合并该 JSON），就必然缺凭据。

### 处理

启动器已加固为**双通道注入**（`GEN_ENV_EXTRA` + 直接 `$env:`），
`scripts/relaunch-switchboard.mjs` 同样处理：

```powershell
foreach ($k in $extra.Keys) { Set-Item -Path ("env:" + $k) -Value $extra[$k] }
```

`ai-base/agent-shell/.env` 里两个 key 都在、形态正常（51 / 103 字符、无引号）：
`AGENTSHELL_MAIN_LLM_API_KEY`、`AGENTSHELL_MAIN_LLM_API_KEYS`。

> 注意：**即使凭据仍缺，修复 ① ② 也已能打破死锁** —— 摘要失败会走兜底并在 `compaction/end` **无 error** 地落盘，
> surface 照样收缩（本次 selection 要丢 480/587 个节点）。补上凭据则是恢复正常摘要质量。

### 已执行的修复（18:40，运行中验证）

`credentials.describe` 给出了决定性证据：

```
修复前：AGENTSHELL_MAIN_LLM_API_KEY   configured=false  writable=true   source=-
        AGENTSHELL_MAIN_LLM_API_KEYS  configured=true   writable=false  source=env
```

**复数 key（key-pool 池）进去了，单数 key 没进去** —— 而 `agnes` provider 的 `apiKeyEnv` 要的正是单数那个。
于是经凭据服务持久化（`credentials.set`，值与 web Models 页写的是同一条通路）：

```
  AGENTSHELL_MAIN_LLM_API_KEY: len=51 status=200 ok=true
修复后：AGENTSHELL_MAIN_LLM_API_KEY   configured=true   source=file
        AGENTSHELL_MAIN_LLM_API_KEYS  configured=true   source=env
```

`source=file` = 已落进 `~/.dsh/.credentials.yaml`，**与启动方式解耦**，重启也不丢。
（`AGENTSHELL_MAIN_LLM_API_KEYS` 写入返回 `ok=false` 是因为 `writable=false`（由 env 托管），但它本就 `configured=true`，无需写。）

### 免重启热加载修复

用项目自带蓝绿换代把修复代码装进新 gen：

```
POST http://127.0.0.1:31800/?cmd=handover
  → ready  : defer 请活跃代 gen-3082 先收尾本轮 (grace=20000ms)
  → spawn  : spawned gen-3083
  → freeze : freeze a lastSeq=0
  → promote: resume-session=session-874d25b4-1b5f-4f4d-a932-6e61a530e60d (via-gen)
  → flip   : flip to gen-3083
  → verify : resume-reissue: HTTP 200 {"accepted":true}
  → retire : retire gen-3082
  result = {"result":"success","note":"已切换 → gen-3083"}
```

换代后运行态：

| 端口 | 角色 | pid |
|---|---|---|
| 3080 / 31800 | 前门 / 控制面 | 21128（未重启） |
| **3083** / 3101 | **gen-3083（已加载修复）** | 25436 |
| 3082 | gen-3082（已 retire，等 30s retain 退出） | 27132 |

`host.describe` → `ok:true, attachedSessions:1, provider:agnes`；
`credentials.describe` → 两个 ref 均 `configured=true`。

> 为什么换代能加载新代码：gen 由 `spawnGen` 拉起，重新 `import` 包文件；
> 而 `node_modules/@deepseek-ai/*` 是 junction 指向 dsh-brain，所以磁盘上的补丁立即生效。

### 仍需人工确认的一步

`session-28f50f57`（那个 462K 的大会话）当前**未挂在前门上**（前门 resume 的是 `session-874d25b4`）。
请在 Web UI 打开它并随便发一句，预期看到：

- `compaction/summary` 出现，带 `shadowedTokenCount` 与 `provider: agnes`；
- `compaction/end` **不带 error**；
- 之后请求的 `inputTokens` 明显回落，不再 400。

若仍失败，`out/compaction-fail.log` 会记下新的堆栈（诊断埋点保留着）。

