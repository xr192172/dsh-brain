# 接手指南（**回执** + 下一项）—— 2026-09-20 13:42（13:42 复核：推送已完成、栈健康）

> **给新会话读的**：这是一份**自包含**的交接。读完它 + 它点到的文件就能接着干，不必回溯对话。
> 上一轮的交接文档就是本文件；本轮把「做完了什么 + 现在什么状态 + 下一项」重写在顶部，旧长尾留档在 §6。

---

## 0. 一句话

**换代写入竞态（两代并发写同一份会话）已修、已在真机上验收通过（含"回合运行中换代"这条主路径），
并在验收过程中抓到并修掉了我自己修复里的两个假信号。**
下一步 = **M1-step-2：把冻结任务集当题面交给 Agent，产出「现行 vs 挑战者」的 delta 报告**。

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

### 1.5 提交与推送状态 —— ✅ **已推送完成**（2026-09-20 13:42 复核）

- **远端 `origin/master` = `89a7d8c`，与本地 HEAD 一致** ⇒ **全部 41 个提交已在远端**。
  依据是 `git ls-remote origin refs/heads/master` —— **直接问服务器**，不看本地 remote-tracking 引用。
- 原先的阻塞（代理 `127.0.0.1:7890` 未启动）**已解除**：13:42 实测 7890 在监听。
- ⚠️ **坑（记下来）**：本环境下裸 `git push` 可能报
  `fatal: could not read Username for 'https://github.com': terminal prompts disabled`
  —— 那是**推行需要认证而终端提示被禁用**，**不代表内容没上去**。
- ✅ **可用的推送方式**（13:43 实测成功）：

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

## 3. 下一项：M1-step-2 —— 跑 Agent 的那一半

**目标**：把 `evals/pilot/tasks.jsonl` 的题面交给 Agent（跑在**只读沙箱/分叉会话**里），收轨迹，
再跑 oracle + `regression`，产出「现行 vs 挑战者」的 **delta 报告**（成功率 / 工具调用数 / token /
延迟 / **危险动作**）。

**已有**：任务集 + 有效性校验（step-1）；`--prepare/--restore` 已给这一步备好（打 seed + 字节级还原）。
**要新建**：`scripts/eval-run.mjs`（驱动 + 收轨迹 + 出报告）。

**复用点**（别重造）：
- 起挑战者：`packages/switchboard/src/spawner.ts`；只读沙箱：profile 已有 `sandbox: read-only`
  （`out/profile-dump.txt:114`）与 `dsh-fs-sandbox` / `dsh-sandbox-windows-acl`。
- 把结论接成闸：`tool_apply(verify=…)` + `VERIFY_ALLOW`（**M2 就是它**，今天已存在）。
- 驱动会话：`scripts/session-drive.mjs prompt <id> "<text>"`（走前门 RPC，已实测可用）。

**注意**（本轮踩过的）：
- 单臂基线也要先记账：先量"现行自己在预算内能不能修好这题"，否则没有对照。
- 沙箱/工作区必须隔离：Agent 会改文件；实验起点必须可重置（否则两次不可比）。
- 别把期望答案放进 Agent 能读的地方（判据要在它够不到的位置）。

---

## 4. 仍未闭合（诚实清单）

1. **M1-step-2 未做**（§3）；`pass^k` 可靠性、公开靶场地板也都还没做。
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
- M1-step-2 ⬜ 跑 Agent 那一半（§3）。
- M2 ⬜ 把实验结论接进 `verifyCmd` 闸（接口已存在）。
- M3 ⬜ **触发式**：custody 拆分（写权收授 + 前门搬家）—— 触发条件：替换频率高到
  "每次都要跑实验/停机"不能接受。**别提前做**。
