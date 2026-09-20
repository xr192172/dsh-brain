# 接手指南（**回执** + 下一项）—— 2026-09-20 15:15（§3.B **已实现并跑通第一对**；下一项 §3.D）

> **给新会话读的**：这是一份**自包含**的交接。读完它 + 它点到的文件就能接着干，不必回溯对话。
> 上一轮的交接文档就是本文件；本轮把「做完了什么 + 现在什么状态 + 下一项」重写在顶部，旧长尾留档在 §6。
>
> **★ 归属（2026-09-20 15:15 用户定）**：**本方向（M1 自进化判据 / 实验台）由「eval 子会话」全权负责** ——
> 即 `evals/`、`scripts/eval-*.mjs`、`docs/eval-*.md` 与本文件的 §3/§4 由它维护并推进；
> 主干会话只需在 §3.C 的排队项上协作（避免两个会话同时动同一批文件 —— 已经踩过一次）。

---

## ★ eval 子会话回执（2026-09-20 22:3x，合并前整理）

> 完整版：`docs/receipt-to-main-2026-09-20.md`。**git 与文档已整理干净**（本地=远端 `18cc948` 起）。

**状态**：判据层（实验台）机器**已就位并各自验证**——任务集（`cli-0005` 能力敏感题 + 空 seed 支持）、
**B1 每臂独立工作区**（`git worktree` + 每臂 `--cwd`）、**就绪闸**（真读工具面 + 家族 must/forbid）、
**臂自证**、**模型回读锁定**、**指标**（`callsTotalMs`/`slowestCalls`/`approvalWaitHits` + 索引冷热 + 痕迹清单 +
两臂隔离审计 + 换代污染判据）、**能力库快照还原**、M0 换代写入竞态、regression 假红真因。

**只差一次重启**才拿到第一对**可信** delta（能力开/关：A=`exp-base` / B=`exp-base-nodc`）。原因与绕法：

| 事项 | 现状 | 绕法（已就位） |
|---|---|---|
| `profiles/web` 引用**已删除**的 `@dsh-brain/conveyor-context`（用户有意删） | `dsh --profile web --dump-config` **exit=1** ⇒ 重启会失败 | **不动 P2**：用变体 `exp-base`（=web−conveyor，exit=0/575 行）起栈 |
| 换代端口撞保留端口 3101 | 已修（`c7ba4d4`，测试 16/0，构建 `b1789910762643`）| 待重启后真机验证：handover→`exp-base-nodc` 应 success、新代应为 **gen-3102** |
| `check-all` 基线 **12/3**（不是 15/0） | 3 项失败**全部**由 conveyor-context 被删引起 | `cli-0005` 因此暂判"前提不成立"（regression 红）⇒ **包恢复/替换后自动回到 5 题有效** |

**重建实验用 profile（仓库外，需一条命令）**：
```bash
node scripts/make-profile-variant.mjs --from web --to exp-base --drop @dsh-brain/conveyor-context --force
node scripts/make-profile-variant.mjs --from exp-base --to exp-base-nodc --drop @dsh-brain/design-canvas-bridge --drop-insert mcp-client --force
```
**起栈**（用户终端）：`set WEB_PROFILE=exp-base` + `node scripts\relaunch-switchboard.mjs`
**臂分离探针**：`node scripts/arm-probe.mjs exp-base exp-base-nodc`（换代 + 真读工具面）

⚠️ 我造的 `web-notev`/`web-nodc` 两个旧变体**已作废**（都引用被删的 conveyor-context）⇒ 已删；请勿再用。

---

## 0. 一句话

**换代写入竞态已修 + 真机验收通过（含"回合运行中换代"主路径），并在验收中抓到并修掉了我自己修复里的两个假信号。
M1-step-2 的「单臂基线」3/3 跑完（全 FIXED）、「挑战者定义」已定、**「成对 delta」也已实现并跑通第一对**
（`council` vs `code`：PTC 臂约 2.5–3.3× 成本、结果等价）。**
下一步 = **§3.D：`pass^k` 看方差 → 换更难的题/更极端的臂（`minimal`）让成功率重新有区分度**。

---

## 1. 本次回执（2026-09-20，可整段贴回）

### 1.1 修好了什么（M0 真机验收 **通过**）

| 项 | 结果 | 证据 |
|---|---|---|
| 空闲换代 | `verify-drain-after-swap.mjs` = **11 ok / 0 FAIL** | 流水 `freeze a … quiesced=true (canSeeAgents=true …)` + `seal: keep-old`；4.5s 落定 |
| **回合运行中换代**（主路径） | **全绿** | `drain quiesced=true lastSeq=1315 canSeeAgents=true canSeeSessions=true running=1→cancelled=1 stillBusy=[] flushFailed=[] sessions=1 (14ms)`；会话日志以 `turn/end {kind:aborted, reason:{kind:hook, reason:handover/freeze}}` + `end-seed` 收尾；`lastSeq` 恰好等于那条 `turn/end` 的 seq |
| 封口路径（旧代不肯停写） | 真机上跑过一次 | 13:24 流水：`seal: KILL-OLD` → `retire(seal) 强杀旧代` → `seal ok：旧代已确认消失`（**先杀旧代、后放前门锁**） |
| 离线门 | `test-handover-drain.mjs` **48 项**（并进 `check:all`） | 该红的红 / 该绿的不绿 / 封口顺序两方向自证 / 上游形状断言 |
| 全门 | `node scripts/check-all.mjs` = **15/15** | — |

### 1.2 ★ 真机验收顺手抓到我自己的两个 bug（本轮最有价值的部分）

1. **假红**：`stillBusy` 读的是"建 agent 列表那一刻"的 phase **快照** ⇒ 明明 cancel 成功了
   （会话日志里已有 `turn/end aborted(hook)`）却报 `quiesced=false`，进而触发 `KILL-OLD`。
   ⇒ 改成**实时** `DrainAgent.readPhase()`；门加 A8。
2. **假绿**：`ctx.sessions` **没有 inject**（真机上是 `undefined`）⇒ `sessions=0` / `lastSeq=-1` /
   **`flush` 一次都没跑过**；而**空闲场景照样报 `quiesced=true`** —— 即 13:15 那次"通过"其实是**空过**。
   ⇒ 与 agents 同款改走 `ctx.inject(['sessions'])`；新增 `sessionsObservable`（**看不到会话服务 ⇒ 必须报未停写**）；
   `liveMaxSeq` 改成接收服务对象。门加 A7 + B5。**门 41 → 48 项**。

### 1.3 顺手清掉的技术债：ready/追平门槛的最后一块假绿

`preseed.computeCaughtUpSeq()` 依赖 `sessionPersistence.listSessions()` —— **这个方法在上游不存在**
（服务名是真的、方法不是）⇒ `ids=[]` ⇒ 恒返回 0（**171 条 freeze 的 `lastSeq` 全是 0** 的真正原因）。
⇒ 改成 `liveMaxSeq(sessionsRef.current)`（只回答**能真答**的问题）；控制面的 ready 门槛同时从
"比 seq" 换成**结构性就绪** `waitReady()`，`waitCatchUp` 降级为 **1.5s 有界观测**（不得当门槛）。

### 1.4 另外三件（讨论产物，不是代码）

- `docs/upstream-drift-2026-09-20.md` + `npm run check:upstream`：上游 0.1.1-rc.2 → latest **0.1.5-rc.2**
  （alpha 0.1.6-alpha.2）。**竞态根机制未变**（上游没修）；但 0.1.5 给 persistence 加了**存储层单写者所有权**。
  我们的三个补丁靶子都还在、上游都没修 ⇒ 仍需要；BOM 从 3 处涨到 4 处。
- `docs/two-service-custody-review.md`：主脑/子脑拆服务的评审 —— 能替掉"部署"层、**替不掉"判据"层**；
  对称代持 = 2-回路（踩无环原则）；§8 给出"同时开 2 号进程做实验"的三条件（写权互斥 / 副作用隔离 / 判据非环）。
- `docs/agent-eval-arenas.md` + `evals/` + `npm run eval:validate`：M1 的**判据地基** ——
  冻结任务集（首批 3 题 = 把修过的回归反向打回去，oracle 就是我们已有的门）；
  校验器证明"打上 seed 后 oracle **必须变红**"，否则是**假题**（字节级 sha256 还原；3 题有效 / 0 题有问题）。

### 1.5 提交与推送状态 —— ✅ 已推送完成

- **远端 `origin/master` = 本地 HEAD**（14:19 复核；依据 `git ls-remote origin refs/heads/master`
  —— **直接问服务器**，不看本地 remote-tracking 引用），未推送提交数 = 0。
- 原先的阻塞（代理 `127.0.0.1:7890` 未启动）**已解除**：实测 7890 在监听。
- ⚠️ **坑（记下来）**：本环境下裸 `git push` 会报
  `fatal: could not read Username for 'https://github.com': terminal prompts disabled`
  —— 那是**推行需要认证而终端提示被禁用**，**不代表内容没上去**。
- ✅ **可用的推送方式**（实测成功）：

  ```bash
  GIT_TERMINAL_PROMPT=0 git push origin master
  ```

  即**显式禁用终端提示**，让凭据助手（`credential.helper=manager`）走它自己的缓存凭据。
  实测输出：`89a7d8c..663c3ad  master -> master`。
- **核验"推没推上去"的唯一可信方式**是 `git ls-remote origin refs/heads/master`
  （直接问服务器）—— **不是** `git push` 的输出、也**不是**本地 `origin/master`
  （后者可能被本地推断更新，会骗人）。

---
### 1.6 ★ M1-step-2 的**真跑路径第一次跑通**（2026-09-20 14:24，cli-0001）

`node scripts/eval-run.mjs --task cli-0001 --session <专门的空会话>` ⇒ **FIXED / 预算内**。

| 项 | 读数 |
|---|---|
| ① 题目有信号 | `seededOracle.hasSignal = true`（seed 打上 ⇒ oracle **变红** ⇒ 不是假题） |
| ② 发题面 | `outcome=settled`，`wallMs=126398`（126s），`steps 0→10`，`turns 0→1` |
| ③ 记账 | `outputTokens 2667` / `uncachedInputTokens 48979` |
| ④ 判据 | `oracleAfter.pass=true`（红→绿）+ `regression.pass=true`（check:all 全绿） |
| ⑤ 它改了什么 | `packages/switchboard/src/index.ts \| 2 +-`（**只 1 文件 1 行**，正是那道不变量） |
| ⑥ 还原 | 已 byte 级还原；`git status` 干净；`HEAD` 未变；**无 commit / 无 push / 无越界改动** |
| 结论 | `verdict = FIXED`，`budgetOk = true` |

报告：`out/eval-run-cli-0001-injected-message-identity-1789885471541.json`

**会话是用 `session.create`（空载荷即通）现建的专门空会话**
——顺带证实返回值里 `agentPreset: "council"`，即**方案 B 的 preset 在生效**。
（`session.create` / `session.fork` / `session.list` / `session.prompt` 等都是前门 RPC，
见 `scripts/session-drive.mjs` 的 `describe|list|prompt` 用法。）

> ★ **这次真跑的价值不只是"跑通"**：它证明了 `eval-run` 的**三条判据同时可机验**
> —— 题目有信号（红）、修好（绿）、没弄坏别的（regression 绿）。
> 也就是 **M1 的判据地基从此有了"活体"证据**，不再只是离线校验。


## 2. 当前系统状态（怎么确认它还活着）

```bash
curl.exe "http://127.0.0.1:31800/?cmd=status"     # 控制面（PowerShell 里必须写 curl.exe）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/   # 前门，应 200
node scripts/verify-drain-after-swap.mjs          # R0 会告诉你：栈在不在、换没换代、跑的是哪版
```

- 栈由**用户终端**启动（Agent 侧起的进程会被回收）：`node scripts/relaunch-switchboard.mjs`。
- ⚠️ 现在跑着的**控制面**是 13:14 那个进程（**旧 build**）⇒ `state.jsonl` 里暂时看不到 `canSeeSessions`
  字段（那行由控制面拼）；gen 侧 `boot.log` / `resume.jsonl` 已经能看到 ✓。重启一次即对齐，**不急**。

**13:42 复核结果（本轮回执）**：

| 项 | 读数 |
|---|---|
| 控制面 | `stage=idle` / `locked=false` / `activeGen=gen-3086` / **`freezeSeq=1315`**（真值，不再是 0）/ `lastFencingSeq=5833` |
| 前门 | `http://127.0.0.1:3080/` → **200** |
| `verify-drain-after-swap.mjs` | **R0a/R0b/R0c + R1–R7 全绿**；最近一次 freeze `13:30:00 gen-3085`：`quiesced=true canSeeAgents=true running=1→cancel=1 stillBusy=[] flushFailed=[] 14ms`；`seal: keep-old` |
⇒ **栈活着，drain 修复在真机上确实生效。**

---

## 3. 下一项（**eval 子会话全权负责**）：M1-step-2 收尾 —— 挑战者臂 + 成对 delta

> 2026-09-20 15:15 更新：**§3.A（单臂 3/3）✅、Step 0（挑战者定义）✅、§3.B（成对 delta 第一对）✅**。
> 现在只剩 **§3.D**（让判据重新有区分度）。

### 3.A 先做完：3 题单臂基线（**零设计，纯执行，先跑**）

```bash
node scripts/session-drive.mjs list                      # 找一个空会话；或
node scripts/eval-run.mjs --plan --task cli-0002         # 先看计划
node scripts/eval-run.mjs --task cli-0002 --session <专门的空会话>
node scripts/eval-run.mjs --task cli-0003 --session <专门的空会话>
```

- 会话可以现建：`session.create`（**空载荷即通**，走前门 RPC）。
  ⚠️ **别拿在用的会话试** —— 题面会发进去、会消耗 token、会往那份会话写记录。
- 每题记下：`hasSignal / outcome / steps / outputTokens / wallMs / oracleAfter / regression /
  diffStat / verdict / budgetOk`（都在 `out/eval-run-*.json`）。
- **产出**：一张 3 题的单臂基线表（这就是后面一切比较的**对照**，没有它后面都没意义）。

**✅ §3.A 已完成（2026-09-20 14:45，子会话执行）**：**3/3 FIXED**，全部预算内、危险动作 0；
成表在 **`docs/eval-baseline-single-arm.md`**（含三题的墙钟/steps/tokens/toolCalls 分布）。
★ **重要发现：这批题已饱和**（三题都是"恢复一行不变量"，一次全过）⇒ **两臂的成功率将无区分度**，
§3.B 的**主判据必须换成"成本与路径"**（`toolCalls` 7/17/20、tokens 1910–2667、墙钟 70–126s，
同 preset 内就有 1.7–3× 波动），成功率只当"地板"。详见该文档 §最重要的一条发现。

### 3.B 主任务：加**挑战者臂**，产出「现行 vs 挑战者」成对 delta

**目标**：让 `eval-run` 能跑**两条臂**（现行 / 挑战者）并对同一批题给出 delta：
成功率 / 工具调用数 / token / 墙钟 / **危险动作**。

**⚠️ Step 0（必须先做的设计决定）**：**"挑战者"到底指什么？**
可选形态：换**模型**（`llm.providers` / `session.selectModel`）／换 **agent preset**
（`agentPreset.list` / `select`）／换**生长基质**（改 P0：能力库 / persona / 技能，最贴项目初衷也最难隔离）。
⇒ 不先定这个，delta 没有意义（两臂不可比）。

**✅ Step 0 已完成（2026-09-20 14:45，子会话执行）→ `docs/eval-challenger-arm.md`**：
定义 = **只换 preset**（同模型/同仓库/同题面/同预算）；首版 **A=`council`（现行）vs B=`code`（PTC/Code Mode）**；
机制**实测确认**：`agentPreset.select {sessionId, agentPreset:'<id>'}` ✅ 生效，
而 `{preset:…}` / `{name:…}` 是 **HTTP 200 的静默 no-op** ⇒ **必须回读 `session.list.<sid>.agentPreset` 才算数**；
主判据 = `toolCalls`/`tokens`/`wallMs`/`dangerous`，成功率当地板；两臂**严格串行 + 各用新建空会话**。
实现计划：给 `eval-run.mjs` 加 `--pair --task X --armA council --armB code`（**别另写脚本**）。

**已有可复用**（别重造）：
- 起挑战者：`packages/switchboard/src/spawner.ts`；
  只读沙箱：profile 已有 `sandbox: read-only`（`out/profile-dump.txt:114`）+ `dsh-fs-sandbox` / `dsh-sandbox-windows-acl`。
- 把结论接成闸：`tool_apply(verify=…)` + `VERIFY_ALLOW`（**M2 就是它**，已存在）。
- 驱动会话：`scripts/session-drive.mjs prompt <id> "<text>"`；建会话：`session.create`；
  分叉：`session.fork`；列会话：`session.list`。
- 单臂驱动与判据：**直接扩** `scripts/eval-run.mjs`（别另写一个）。

**必须守住的实验卫生**（否则 delta 不可信）：
- **同一起点**：两臂都从**同一 HEAD + 干净工作区**出发；打 seed / 还原走 `eval-validate.mjs --prepare|--restore`
  （字节级 + sha256）。跑完必须 `git status` 干净。
- **隔离**：Agent 会改文件 ⇒ 两臂**不得共用工作区**（或严格串行 + 每次还原）。
- **别把期望答案放进 Agent 够得到的地方**（判据要在它够不到的位置）。
- **记账要成对**：两臂同一题、同一预算；只报单臂数字没有意义。
- **危险动作要记**（它调 `tool_apply` / 改 profile / 杀进程都算）——这是"值不值得换"的关键一列。

**验收**：一条命令能跑完两臂并打印成对 delta 表；对 `cli-0001`（已知 FIXED）两臂都跑得通；
报告里能看到上面五列。

**✅ §3.B 已完成（2026-09-20 14:56，eval 子会话）**：
`--pair` 已实现（`runArm()` 单臂/成对**共用一条路径**；每臂新建空会话 + `agentPreset.select` **回读验证**；
两臂严格串行；打印 **地板 + 成本/路径 + 安全列** 的 delta 表；产物 `out/eval-pair-*.json`）。
**第一对实测（cli-0003，两臂都 FIXED、地板通过）**：

| 指标 | A=`council`（现行） | B=`code`（PTC） | Δ(B−A) |
|---|---|---|---|
| toolCalls | **10** | 25 | +15 |
| outputTokens | **1343** | 3963 | +2620 |
| uncachedInput | **16873** | 54995 | +38122 |
| wallMs | **45.5s** | 114.2s | +68.7s |
| dangerous | 0 | 0（更正后） | 0 |

⇒ 初步结论（n=1 题 / k=1）：**PTC 臂同结果、约 2.5–3.3× 成本**；小任务上现行更划算，
PTC 的价值要在**多步组合的难题**上验。完整记录 + 实验卫生 + 两个自家假信号的复盘见
**`docs/eval-challenger-arm.md` §7**（含：并发写者被误诊成"seed 打错题"、`dangerous` 假报 13 条）。

### 3.C 排队中（**不要现在做**，登记以免忘）

- **`lease.freezeSeq` 没有读者**（§4.4）—— fencing 仍未真正落地。当前靠 `seal`（未停写 ⇒ 杀旧代）等效兜住，
  所以**不是紧急**；但要记着它是"设计里的机制从未被消费"这一类（见 §5 纪律 1）。
- **回滚路径的重叠窗口**（§4.2）；**`session-3d8ea18d`**（§4.3）；**幂等/重复副作用立案**（§4.5）。
- **M2**（把实验结论接进 `verifyCmd` 闸）**依赖 §3.D 把判据做出区分度** ⇒ 现在做不了。
- **M3**（拆服务）是**触发式**，**别提前做**。

---
### 3.D 下一项（**eval 子会话负责**）：让判据重新有区分度

> ★ **2026-09-20 17:0x 方法论更正（用户指正，已落地）**：测的是**我们这一层（DSH/dsh-brain）的极限与不同版本**，
> **不是模型能力**。⇒ ① 模型钉成受控常量且**回读证明**（ 两臂模型不同即弃跑； 两方向自证）
> —— 实测两次 dry-run 之间模型自己变了（agnes→deepseek-v4-flash），所以必须每次回读；
> ② **臂的定义改了**：上游 preset（//，即 §10 那两对）只作**参照/地板**；
> **主臂 = 我们这一层的变体** —— 先做 **profile 变体（压缩开 vs 压缩关）**，再考虑按 build 换代（不同版本）。
> ③ 任务也要选**与模型弱相关**的：难度应来自我们这层的弱项（长上下文/工具面/门/自进化），不是解谜。
> 详见  §11。

**✅ 第一步已完成（2026-09-20 15:22）：`pass^k` 实测**（`docs/eval-challenger-arm.md` §9）
—— cli-0003 × council × **3 次全 FIXED**；同臂噪声：`toolCalls` ±15% [9–12]、`outputTokens` ±11%、
`wallMs` ±9%、**`uncachedInput` ±36%**（最飘）、`steps` 恒定 6（太粗，别当主判据）。
两个结论：
1. **第一对"PTC 更贵"是稳的** —— 那个差是 +150%/+195%/+151%，远大于同臂噪声，不是抖动；
2. ★ **修正原建议**：**别把预算收到 8–12**（那正好卡在噪声带上 ⇒ 同一臂时过时不过 = 抛硬币）。
   要么把预算设到**明显高于噪声上界**（如 ≤15），要么保持"成功率只当地板"、
   **只在差异 ≥ 2× 噪声时**才下结论（`toolCalls` ≥ ~4 次 / `outputTokens` ≥ ~300 / `wallMs` ≥ ~12s）。

剩下（按序）：
1. **`minimal` 臂**（只有 bash + `str_replace_editor`）：`--pair --task cli-0003 --armA council --armB minimal`。
2. **加难度**：写一道**多文件 / 无现成门当 oracle** 的题（成功率才会真正分化）。
3. 真要下"换不换"的结论时用 `--pair … --repeat 3`（交替 A1B1A2B2…），别用 k=1。
4. 之后才谈 **M2**（把结论接进 `verifyCmd` 闸）—— 先只做**报告**，不自动拦。


## 4. 仍未闭合（诚实清单）

1. **M1-step-2**：单臂基线 **3/3 已跑完**（全 FIXED，`docs/eval-baseline-single-arm.md`）；
   Step 0（挑战者定义）**已完成**；**成对 delta 已实现并跑通第一对**（`docs/eval-challenger-arm.md` §7）。
   **剩**：`pass^k` 方差、难度/预算调整、`minimal` 臂（§3.D，eval 子会话负责）；公开靶场地板也没做。
   ⚠️ **三题已饱和**（都是"恢复一行不变量"，单臂 3/3 一次过）⇒ **成功率在两臂间没有区分度**，
   所以主判据是"成本与路径"；若连成本都无差异，就必须先加难度/收预算再比（见 §3.D）。
2. **回滚路径的重叠窗口**：`quiesced=false` 且 flip 后 verify 失败、走到 `rollbackFlip` 时，
   旧代（未停写）与新代（已服务过一小会儿）仍可能碰同一会话。窗口小但未消除。
   候选：把 verify 全部前移到 flip 之前，flip 与"杀旧代"原子化（动最安全攸关的顺序）。
3. **`session-3d8ea18d` 的 seq gap**（截断会丢 59%）—— 等用户决定。
4. `lease.freezeSeq` 现在有真值了，但**没有任何读者**（fencing 仍未真正落地）。
5. **"重复副作用/幂等"** 建议单独立案（durable execution 的教训：`checkpoint ≠ durable`）。
6. 测试残留：`session-853b751c-…` 的历史里有两条测试请求（蜂群/珊瑚礁说明文）+ 两次 aborted 回合。

---

## 5. 纪律与坑（累积，**必读**）

1. **判"某机制有没有在工作"，不许读注释、不许读代码意图** ⇒ 去历史记录里**数"判据为真的次数"**。
   （本轮之前那次破案靠的就是「`waitedTurnEnd=true` 计数 = 0 / `lastSeq=0` 计数 = 171」。）
2. **"看不到" ≠ "没有"**：服务缺失 / 列表为空 / 读数拿不到，一律不得当正向判据
   （`agentsObservable` / `sessionsObservable` 就是这个原则的落地）。
3. **判据读旧数据（快照）或读注释都是假信号源**：文本断言先 `stripComments()`；阶段/状态一律**实时读**。
4. **Agent 侧启动不了长期服务**（`detached+unref` 也不行，实测）⇒ switchboard 必须用户终端启动。
5. `npm run <script>` 在本机 shell 会被安全策略拦 ⇒ 直接 `node scripts/<x>.mjs`。
6. 构建：`cd packages/switchboard && node scripts/build.mjs`（用仓库内 tsc；会翻 `lib` junction）。
   **改完必须构建 + 换代/重启才生效**。
7. 换代前跑 `node scripts/check-session-integrity.mjs --all`；换代用**非 fast**（除非刻意测 fast 路径）。
8. 改 `~/.dsh` 下的文件先备份；`.ps1` 必须带 BOM（`node scripts/check-bom.mjs --fix`）。

---

## 6. 旧长尾（留档）

### 6.1 已通过的验收步骤（原清单，M0 已完成）
```bash
cd D:\project_develop\dsh-brain
node scripts\relaunch-switchboard.mjs          # 用户终端；日志 → out\switchboard-run.log
node scripts\check-session-integrity.mjs --all
curl.exe "http://127.0.0.1:31800/?cmd=handover"
node scripts\verify-drain-after-swap.mjs
```

### 6.2 逐文件改动说明
见 §1.1；"为什么这么改"的完整记录在 `docs/handover-vs-restart.md` §8（**已按真因重写**）
与 `docs/oss-prior-art-and-next-steps.md`（里程碑 M0–M3 + 开源先例）。

### 6.3 里程碑状态
- M0 ✅ 真机验收通过（含回合运行中换代）。
- M1-step-1 ✅ 判据地基（`evals/` + `eval-validate.mjs`）。
- M1-step-2 ✅ **单臂 3/3 + 挑战者定义 + 成对 delta 第一对**（`council` vs `code`：同结果、PTC ≈2.5–3.3× 成本）；
  剩 `pass^k` / 难度预算 / `minimal` 臂（§3.D）。
- M2 ⬜ 把实验结论接进 `verifyCmd` 闸（接口已存在）；**依赖 §3.D 把判据做出区分度**。
- M3 ⬜ **触发式**：custody 拆分（写权收授 + 前门搬家）—— 触发条件：替换频率高到
  "每次都要跑实验/停机"不能接受。**别提前做**。
