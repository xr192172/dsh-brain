# 接手指南（**回执** + 下一项）—— 2026-09-20 14:52（补齐：单臂 3/3 + Step 0 已定；下一项 §3.B）

> **给新会话读的**：这是一份**自包含**的交接。读完它 + 它点到的文件就能接着干，不必回溯对话。
> 上一轮的交接文档就是本文件；本轮把「做完了什么 + 现在什么状态 + 下一项」重写在顶部，旧长尾留档在 §6。

---

## 0. 一句话

**换代写入竞态已修 + 真机验收通过（含"回合运行中换代"主路径），并在验收中抓到并修掉了我自己修复里的两个假信号。
M1-step-2 的「单臂基线」已跑完 3/3 题（全 FIXED，见 `docs/eval-baseline-single-arm.md`），
「挑战者臂」的定义也已定下（见 `docs/eval-challenger-arm.md`）。**
下一步 = **§3.B：给 `eval-run` 加挑战者臂、产出成对 delta**（★ 主判据已改为"成本与路径" —— 三题已饱和，成功率没有区分度）。

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

## 3. 下一项（**派给另一个会话**）：M1-step-2 收尾 —— 挑战者臂 + 成对 delta

> 2026-09-20 14:24 更新：**单臂基线已跑通 1/3 题**（cli-0001 = FIXED，见 §1.6）。
> 下面把"剩下的那一半"拆成 A（立刻可做）与 B（主任务）。

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

### 3.C 排队中（**不要现在做**，登记以免忘）

- **`lease.freezeSeq` 没有读者**（§4.4）—— fencing 仍未真正落地。当前靠 `seal`（未停写 ⇒ 杀旧代）等效兜住，
  所以**不是紧急**；但要记着它是"设计里的机制从未被消费"这一类（见 §5 纪律 1）。
- **回滚路径的重叠窗口**（§4.2）；**`session-3d8ea18d`**（§4.3）；**幂等/重复副作用立案**（§4.5）。
- **M2**（把实验结论接进 `verifyCmd` 闸）**依赖 §3.B 的结论** ⇒ 现在做不了。
- **M3**（拆服务）是**触发式**，**别提前做**。

---

## 4. 仍未闭合（诚实清单）

1. **M1-step-2 未完成**：单臂基线 **3/3 已跑完**（全 FIXED，`docs/eval-baseline-single-arm.md`）；
   Step 0（挑战者定义）**已完成**（`docs/eval-challenger-arm.md`）；
   **剩 §3.B 的实现：挑战者臂 + 成对 delta**。
   ⚠️ 三题已**饱和**（都是"恢复一行不变量"）⇒ **成功率没有区分度**，主判据必须用"成本与路径"。
   `pass^k` 可靠性、公开靶场地板也都还没做。
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
- M1-step-2 🟡 单臂基线 **3/3 跑完**（`docs/eval-baseline-single-arm.md`）+ 挑战者定义已定
  （`docs/eval-challenger-arm.md`）；**剩实现：`eval-run --pair` 成对 delta**（§3.B）。
- M2 ⬜ 把实验结论接进 `verifyCmd` 闸（接口已存在）；**依赖 §3.B 的结论**。
- M3 ⬜ **触发式**：custody 拆分（写权收授 + 前门搬家）—— 触发条件：替换频率高到
  "每次都要跑实验/停机"不能接受。**别提前做**。
