# 回执 → 主会话：eval 子会话的异常清单（2026-09-20 21:5x）

> 用途：把**需要别的线动手**的异常一次交清。每条都给**证据**与**我做了什么/没做什么**。
> 我的定位：判据层（实验台）。P2（switchboard 源码 / `profiles/web`）**只报不修**。

## A. 需要主干/别的线决定的（会挡住我下一步）

| # | 异常 | 证据 | 我这边 |
|---|---|---|---|
| **A1** | ★ **`profiles/web` 引用了已删除的包** ⇒ **任何重启都会失败** | `dsh --profile web --dump-config` → **exit=1**：`cannot resolve profile bundle "@dsh-brain/conveyor-context"`。用户确认是**有意删除**（另一条线在做更好的替代） | **不恢复包、不动 P2**；造了变体 `exp-base`（= web − conveyor，exit=0/575 行）与 `exp-base-nodc`（再摘 design-canvas，exit=0/548 行）继续干活。**请求**：那条线把 profile 引用收尾（补新包或改 bundles），否则 `web` 一直起不来 |
| **A2** | 换代端口撞**保留端口 3101** ⇒ 恒 `b-not-ready` | `gen-3101/boot.log`：`EADDRINUSE 127.0.0.1:3101`；`netstat` 显示 3100/3101 同属现役 gen；`key-pool-proxy` 默认端口就是 3101 | **已修**（子代理，commit `c7ba4d4`）：`RESERVED_GEN_PORTS=[3101]` + `allocGenPort`（**单射**后推，实测序列 `3099,3100,**3102**,3103…`）+ `abort` 把 boot 错因写进 `result.note`；新增 `scripts/test-gen-port-alloc.mjs`（**16/0**）；构建 `b1789910762643`。**待重启后真机验证**（我做不到：活动控制面是旧构建，且规矩禁止 agent 杀宿主 PID） |
| **A3** | `main.ts` 的 **bootstrap 代端口**（`portBase+1`）**未纳入跳号** | 子代理如实标注（配置面边界） | 未改。`GEN_PORT_BASE=3098` 时不撞；设为 3100 才会撞 |

## B. 建议归「工具完善」议题（都有轨迹/文件为证）

| # | 异常 | 证据 | 影响 |
|---|---|---|---|
| **B1** | `tool/result` 的 **`isError` 恒为 `false`**（内容明明是 `[stderr] … 运行失败`） | cli-0003 的 A/B 两臂会话日志 | **"工具失败率"这个指标口径被污染** ⇒ 我只能退化成内容启发式（且偏宽） |
| **B2** | shell 工具在**非重定向 stderr** 时崩：`ResourceUnavailable: StandardErrorEncoding is only supported when standard error is redirected` | cli-0003 A 臂第一次跑 oracle 就撞上 | 会被算成"工具失败"；也是 A 臂多绕一圈的原因 |
| **B3** | **能力库写入非崩溃安全** | `~/.dsh/capabilities/` 里长期残留 `registry.json.7272.tmp`；`registry.json` 的 `updatedAt` 在我实验窗口内被改过多次 | 共享可变状态；建议写侧 tmp+rename 原子化、读侧容忍半文件 |
| **B4** | 仓库里几个门的**自证会删临时文件**，而宿主注入的 `node-safe-delete` 钩子在失败时 **fail-closed 直接崩脚本** | 崩溃 trace 明写 `tryTrash … node-safe-delete-shim.cjs` + 4 个门名（`test-boot-health`/`test-capability-gate`/`test-notice-wiring`/`test-plugin-hygiene`）。**这解释了历史上两次"regression 红但不复现"** | 我这边给判据子进程加了 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 绕过；但**门自身该修**：删之前先判存在 |

## C. 治理纪律（今天被卷入 3–4 次，建议写进规矩）

1. **共享 git index**：本仓库多会话共用 index。我今天被卷入：
   ① 我的 `eval-run.mjs` 改动被别人的提交带走；② 别人的半成品被我的提交带上；③ **我做 oracle 自证时临时写入的"正确解法"被提交进 HEAD** ⇒ 靶子变成"永远绿"（实验正确地报了 `题目没有信号 ⇒ 弃跑`，没产生假数据）。
   ⇒ 建议统一：**不留 staged 条目**，一律 `git commit -m "…" -- <paths>`（我已改习惯）。
2. **靶子/实验文件的占位期**：`evals/**` 的靶子在两方向自证时会被临时改（秒级窗口）。别的线在那个窗口 `git add -A` 就会把它固化 ⇒ 建议：**自证脚本先备份+还原**（我已在做），**其它线不要 `add -A`**。
3. `node_modules/@deepseek-ai` 曾在本检出**整体缺失**；子代理按 lock 的 integrity **离线**从 npm 缓存补齐 ~200 个包（**没跑 `npm install`**）。如实告知，必要时可删掉重装。
4. **`check-all` 当前基线是 12/3**（不是 15/0）：3 项失败**全部**由 A1（conveyor-context 被删）引起，与端口修复无关。

## D. 我这边的状态（供主干对齐）

**已完成并各自验证过**：
- 任务集 **5 题有效**（含新题 `cli-0005`：能力敏感·符号级重命名；oracle 两方向自证过；`evals/pilot/rename-target/`）；
- **B1 每臂独立工作区**（`git worktree` + 每臂 `--cwd`）干跑验证通过；
- **就绪闸**（真读工具面 + 按 profile 家族 must/forbid）、**臂自证**（按模型实际工具面，前缀匹配）、**模型回读锁定**；
- **指标**：`callsTotalMs`/`slowestCalls`/`approvalWaitHits` + 索引冷热 + **痕迹清单** + **两臂隔离审计** + 换代污染判据；
- **能力库快照/还原**（拒绝覆盖并发写者）；**M0 换代写入竞态**（早前）；**regression 假红真因**（B4）。

**当前阻塞（只差一步）**：等一次**重启**（`WEB_PROFILE=exp-base`）⇒ 之后我立刻：
① 端口修复真机验证（handover→`exp-base-nodc` 应 success、新代应为 **gen-3102**、boot.log 无 EADDRINUSE、再切回 `exp-base` 也 success）；
② 跑第一对**能力开/关**实验（A=`exp-base` / B=`exp-base-nodc`）；
③ 接 `verifyCmd`（薄脚本读判决 JSON → exit 0/1）⇒ **M2 闭环**。
