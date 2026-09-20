# 接手指南：下一项 —— **真机验收 drain 修复**，然后接 M1（实验/判据）

> **给新会话读的**。自包含：读完它 + 它列出的文件就能接着干，不必回溯前面的对话。
> 写于 2026-09-20 12:30（上一项 = hard-switch 写入竞态，已修完待验收；M1 已开工）。

---

## 0. 一句话

1. **上一项已修完并全门通过**：换代写入竞态的**真因**被更正为「`freeze` 从来没让人停过写」，
   已在 `drain.ts` / `coordinator.ts` / `index.ts` 修好（`docs/handover-vs-restart.md` §8，已重写）。
2. **本次（09-20）新增**：真机验收脚本、上游漂移体检、两服务架构评审、M1 的实验地基（见 §4）。
3. **下一项 = 真机验收**（§1），验收通过后按 §4 继续 M1。

---

## 1. 首要：真机验收（~~未做~~ → **M0 已通过 2026-09-20 13:15**）

**已通过的**（用户终端启动 + 一次非 fast 换代）：`verify-drain-after-swap.mjs` = **11 ok / 0 FAIL**，
流水 `freeze a lastSeq=-1 quiesced=true (canSeeAgents=true running=0→cancel=0 …)` + `seal: keep-old`，
全程 4.5s；gen 侧 `resume.jsonl` 有 `{"phase":"drain"}`、boot.log 有 drain 行。

**仍未验的两个分支（不许当已通过）**：
1. `running>0 ⇒ cancel 回合并等 whenIdle` —— 那次是**空闲**发起的（`running=0→cancel=0`）；
2. "真 `lastSeq` 非 0" —— 那次**没有任何 live 会话**（`max(∅) = -1`，是诚实值）。

⇒ **要在回合运行中发一次换代**才能覆盖这两条：在 GUI 里（或 `node scripts/session-drive.mjs prompt <id> "…"`）
发一条**不调用工具**的长回答请求，然后立刻 `curl.exe "http://127.0.0.1:31800/?cmd=handover"`，
再看流水应出现 `running=1→cancel=1` 与**非负的 lastSeq**。

### 步骤（一条命令，以后要重跑时）

为什么必须：门是"假件 + 源码"级的，**没有在活的 switchboard 上跑过一次换代**。
`gen 侧接线在真机可用` 目前只有三条间接证据（既有生产证据 `resume.jsonl` 里 `agents:true`、
上游形状门、假件单测），不等于实测。


```bash
# 0) 启动/重启 switchboard —— **必须在用户终端跑**（Agent 侧即使 detached 也会被回收，2026-09-20 实测）
cd D:\project_develop\dsh-brain
node scripts\relaunch-switchboard.mjs                  # 分离式；日志 → out\switchboard-run.log
node scripts/check-session-integrity.mjs --all          # 换代前：坏帧契约会让整代起不来
curl.exe "http://127.0.0.1:31800/?cmd=handover"         # 非 fast；空档时发（PowerShell 里 curl 是别名，写 curl.exe）
node scripts/verify-drain-after-swap.mjs                # 或 npm run verify:drain
```

`scripts/verify-drain-after-swap.mjs`（= `npm run verify:drain`）把验收做成了判据表：R1 有 `quiesced=` 读数 / R2 `quiesced=true` / R3 `canSeeAgents=true` / R4 `stillBusy=[] flushFailed=[]` /
R5 `seal: keep-old` / R6 catchup 观测项 / R7 `resume-session` / R8 旧代 `resume.jsonl` 有 `phase:"drain"` /
R9 会话体健 / **R9b 没有新增 seq gap（本 bug 的直接指纹，靠 `out/drain-acceptance-baseline.json` 基线对比）**。
它自带 `--selftest`：真·修复前日志必须红（7 FAIL）、合成修复后必须全绿 —— 判据自身两方向自证过。
**注意**：它**不在** `check:all` 里（换代前本来就该红；与 `verify:p4` 同理）。

输出为 `FAIL 0`（且 `R9b` 不是红）即验收通过；红在哪一条，就按下面的嫌疑表查。

### 验收失败时的第一嫌疑（按顺序）

1. `canSeeAgents=false` ⇒ `ctx.inject(['agents'])` 或 `agents.list()` 不可用 ⇒ 看
   `toDrainAgents()`（`packages/switchboard/src/index.ts`）与 `drain.ts` 的 `agentPhase`。
2. `quiesced=false` 且 `stillBusy` 非空 ⇒ `cancel()` 没能让回合停下，或 `phase` 读错位
   （上游形状变了 → 门 §C 会先报红）。
3. `flushFailed` 非空 ⇒ `SessionStore.flush` 抛错（多半是会话已不在 live 列表里）。

---

## 2. 这次改了什么 / 别踩回去

| 文件 | 改动要点 |
|---|---|
| `packages/switchboard/src/drain.ts` | **重写**：`drainForHandover()` 真停（cancel 回合 + 有界 `whenIdle` + 官方 flush + 真 `lastSeq` + `primarySessionId` + `quiesced`）；`agentPhase()`；`sealPlan()` |
| `packages/switchboard/src/index.ts` | freeze 走 drain；`prepareSwitch` 改用**真实 phase**（旧的跨插件 `turn/start` 监听是死代码，已删）；reply 带 `quiesced/primarySessionId/drain` |
| `packages/switchboard/src/coordinator.ts` | 记录真读数；`resumeId` 优先 `primarySessionId`；`sealPlan` ⇒ **释放前门锁之前**强杀未停写的旧代（失败落盘 `unfenced-old-gen.txt`）；`waitCatchUp` 支持超时（freeze 后追平 → 1.5s 观测项） |
| `packages/switchboard/src/handover-protocol.ts` | `FreezeReply` 增 `quiesced?` / `primarySessionId?` / `drain?` |
| `packages/switchboard/scripts/build.mjs` | 不再依赖全局 `tsc`（用仓库内 `node_modules/typescript`） |
| `scripts/test-handover-drain.mjs` | **新门**（36 项）：红/绿双向 + 封口顺序**两方向自证** + 上游形状断言 |
| `scripts/check-all.mjs` | 收进新门（15 道） |

**构建**：`cd packages/switchboard && node scripts/build.mjs`（会翻 `lib` junction，并重写 `bin.cjs`）。
**运行中进程不受影响** ⇒ 改完要先构建，再换代/重启才生效。

---

## 3. 纪律与坑（本次新增的两条）

1. **判"某机制有没有在工作"不许读注释、不许读代码意图** —— 去历史记录里**数"判据为真的次数"**。
   本案就是靠「`waitedTurnEnd=true` 计数 = 0 / `lastSeq=0` 计数 = 171」破的。**从未为真的判据 = 假绿。**
2. **"看不到" ≠ "没有"**：服务缺失 / 列表为空 / 读数拿不到，一律**不得**当作正向判据
   （`drain` 的 `agentsObservable` 就是这个原则的落地）。
3. `npm run check:all` 在 Agent 的 shell 里**会被安全策略拦**（wsl.exe 在黑名单）⇒ 直接用
   `node scripts/check-all.mjs`（等价）。
4. `tsc` 不在 Agent 的 PATH 上 —— 已修进 `build.mjs`，不要再写依赖全局 `tsc` 的脚本。

---

## 4. 验收之后的候选（按建议优先级）

> **口径已定（2026-09-20）**：下一步不是拆服务，而是补**判据那一半**。
> 完整论证：`docs/oss-prior-art-and-next-steps.md`（含 M0–M3 里程碑 + 开源先例）；
> 靶场调研：`docs/agent-eval-arenas.md`（公开榜怎么测、用什么数据、2026 的四条教训）。

### M1-step-1 ✅ 已开工（本轮）= 实验的**判据地基**

- `evals/README.md` —— 任务集格式 + 两条不许破的规则（**判据必须在 Agent 够不到的地方**；
  **每题必须证明有信号**）。
- `evals/pilot/tasks.jsonl` —— 首批 3 题，全部是**把我们的回归反向打回去**：
  `cli-0001` 注入消息缺 id/source（oracle = `test-injected-message-shape.mjs`）、
  `cli-0002` 封口顺序（oracle = `test-handover-drain.mjs`）、
  `cli-0003` defer 直读真实 phase（同门）。
- `scripts/eval-validate.mjs`（`npm run eval:validate`）—— **有效性校验**：
  ①干净态绿 ②打 seed 后 oracle **必须红**（否则是**假题**）③字节级 sha256 还原 + 复绿。
  实测 **3 题有效 / 0 题有问题**；它**不在** `check:all` 里（会临时改工作区文件，理由写在 check-all 注释里）。
  `--prepare <id>` / `--restore` 给下一半（跑 Agent）复用。

### M1-step-2 ⬜ 未做 = 跑 Agent 的那一半

把 `task.invariant` 当题面交给**只读沙箱/分叉会话**里的挑战者 → 收轨迹 → 跑 oracle + `regression`
→ 产出**现行 vs 挑战者的 delta 报告**（成功率 / 工具调用数 / token / 延迟 / **dangerousActions**）。
依赖运行时起来（M0），所以先在 step-1 把"题目真的有效"这半边钉住。
★ 复用点：`tool_apply(verify=…)` + `VERIFY_ALLOW` 就是现成的验收闸（M2）。

### M3（触发式，别提前做）

custody 拆分（写权收授 + 前门搬家）——**触发条件**：替换频率高到"每次都要跑实验/停机"不能接受。
设计口径见 `docs/two-service-custody-review.md`（含 §8 的"同时开 2 号进程"三条件：
写权互斥 / 副作用隔离 / 判据非环）。

### 另外两项技术债（不阻塞）

1. **让 ready / 追平门槛不再惰性**（或正式废弃它）：
   `computeCaughtUpSeq`（`src/preseed.ts`）依赖 `sessionPersistence.listSessions` +
   `projectionCache.coldSnapshot(id).asOfSeq`，实测恒 0。现状：已降级成 1.5s 观测项。
   要真修先搞清这两个服务在 gen 里为什么取不到（`--dump-config` + 在 gen 里打印 `Object.keys(ctx)`）。
2. **回滚路径的重叠窗口**：`quiesced=false` 时若 flip 后 verify 失败并回滚，两代仍可能碰同一会话。
   备选修法：verify 全部前移到 flip 之前，flip 与"杀旧代"变成原子的一步（动最安全攸关的顺序，需真机数据打底）。

**其他未闭合**：`session-3d8ea18d` 的 seq gap（截断丢 59%，需用户决定）；
`lease.freezeSeq` 现在有真值了但**没有任何读者**（fencing 仍未落地）；
"重复副作用/幂等"建议单独立案（durable execution 的教训：`checkpoint ≠ durable`）。
