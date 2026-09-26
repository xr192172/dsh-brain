# 第二棒核验报告 —— 现役 DSH 经【管理面】发实验给训练场臂 A

日期：2026-09-26（15:25–16:05 UTC+8）
核验人：WorkBuddy（甲方），核验对象：现役 DSH 会话 `session-35198657-b4d4-43c6-8849-791188525f3b` 的交付
（报告原文 `out/_tasks/self-dev-second-leg-report.md`，原始响应 `out/_tasks/_mgmt-raw/`）

---

## 0. 一句话结论

**管理面（HTTP 长服务）这条通道本身是通的，且"现役 DSH 自己驱动它"这件事被做到了**
（它真的用 `curl` 走了 `brief`/`tasks`/`verdict`/`experiment`/`result` 五个动作，不是我替它起的 shell）。
**但实验没能跑完**，卡在 `arm-up` 自检 —— 而我逐条复核后认定：
**子 agent 给出的归因是错的**，真根因有 **三条**（两条我修复并做了消融自证，一条尚未闭合）。

---

## 1. 先核"读数"，再核"归因"（★ 本次最重要的方法论）

子报告给的**读数**（stderr 原文）**是可信的**；它给的**归因**（"现役 `:31800` 不稳"）**是错的**。
⇒ 新纪律：**子 agent 的诊断与它的读数必须分开验**。归因也是结论，也要证据。

### 1.1 它错在哪（两条硬伤）

| # | 它的说法 | 事实 | 证据 |
|---|---|---|---|
| ① | ⑦ 判的是"现役 `:31800`/`:3080`"，`:31800` 间歇超时 ⇒ arm-up 拒绝 | ⑦ **只探 `:3080`**，**根本不碰 `:31800`** | `scripts/arm-up.mjs:376`：`rpc('http://127.0.0.1:3080','session.list')` |
| ② | 它的报告列 `✓④两席 / ✓⑤池 / ✗⑥现役` | 真 stderr 是 `✅⑤两席 / ✅⑥池 / ❌⑦现役` —— 它**每条往后挪了一位**、还丢了 ④ | `evals/runs/_mgmt/t1-guard-1790407820208.json` 的 `stderr` 字段 |

### 1.2 它做对的地方（也要记）

- **五个动作全走通**：`brief-armA.json` / `tasks.json` / `verdict-t1-guard.json` / `experiment-t1-guard.json` / `result-t1-guard.json` 都在 `out/_tasks/_mgmt-raw/`，**时刻 15:29–15:38**，与派活时间对得上。
- **拿不到的读数如实写了"拿不到"**（3c 表 4 行），**没有写成 0**。这条纪律它遵守了。
- **它自己发现了** `key-pool-proxy` 关于 `3101 被占` 的警告（虽然归因没对准，但**观察是真的**）。
- **它多发了 v2**（经臂 A 自己的 `:33180`），这是一次合理的绕过尝试。

---

## 2. 三条真根因（★ 我复现/消融自证过）

### 根因 A：⑦ 的探针太脆 ⇒ **假红**（已修 + 消融自证）

**证据链**：
- 复现实验：造 30 并发压住 `:3080`，用**与 `arm-up.mjs` 一模一样**的探针探 6 次 ⇒ **5/6 次 `http:0`（TimeoutError）**。
- 自干扰：`run-experiment` → `arm-up` → 探 `:3080`，而**现役此刻正在跑"发起这次实验的那个会话"**
  ⇒ **越是来自我实验，越假红** ⇒ `不敢发题` ⇒ **整条链自锁**。
- 而当时现役**是健康的**：`:3080` pid 6816 未变、连测 10/10 成功（~750ms）。

**修法**（不许"重试到绿"——那是把假红直接转成假绿）：
`arm-up.mjs` 的 `rpc()`/`get()` 改为 **带超时（20s/次）+ 有界重试（5 次，间隔 2s）**，并把结果**分类**：
`ok` / `slow`（探到了但答不对）/ `unreachable`（一次都没探到）。⑦ 的 `detail` **分辨**这两者。

**消融自证**（同一次负载，单因子）：
```
修复前（无超时/无重试）: ok=false err=TimeoutError   ⇒ ⑦ ★红（假红）
修复后（超时+重试）    : ok=true kind=ok tries=1     ⇒ ⑦ 绿
```
`arm-up.mjs --selftest` 另加两条**真消融**：`liveOk=false` ⇒ ⑦ 红（两种 kind 都红）；
且 detail 必须**分辨**"探不通"与"答不对"。**PASS**。

### 根因 B：管理面派子进程时 `DSH_HOME` 泄漏 ⇒ **拒跑**（已修 + 归因反证）

**证据**（v2 的 stderr 原文，逐字）：
```
[失败] 当前 shell 里的 DSH_HOME 指向的就是【本隔离实例自己】（D:\project_develop\_arms\a\dshhome）⇒
  本脚本要拿【现役】当源，这样会把隔离实例当现役（空转/搞乱）。
```

**机制**：`packages/switchboard/src/mgmt.ts:123`
```ts
const r = spawnSync(argv[0], argv.slice(1), { encoding:'utf8', timeout:900_000, cwd: wt })
//                                                   ↑ 默认继承 process.env
```
臂模式起的控制面，自己 env 里就有 `DSH_HOME=<该臂>/dshhome` ⇒ 泄漏进
`run-experiment.mjs` → `isolated-instance.mjs` ⇒ 它**正确地**拒跑
（`scripts/delegation/isolated-instance.mjs:120`）。

★ **那道拒绝是对的** —— 它拦的正是"拿隔离实例当现役源"这种搞乱 ⇒
**修法不是放宽它**，而是**在派生时把"臂身份"变量剔除**。

**修法**：`mgmt.ts` 新增
- `ARM_IDENTITY_ENV_KEYS`（8 个：`DSH_HOME` / `DSH_ARM_SELF` / `DSH_ARM_DENY` / `SWITCH_PORT` / `GEN_PORT_BASE` / `SWITCH_ADMIN_PORT` / `HANDOVER_ADMIN_PORT_BASE` / `DSH_PUBLIC_WEB_URL`）
- 纯函数 `childEnv(base = process.env)` ⇒ 返回剔掉上述键的副本
- `execAction(...)` 传 `env: childEnv(env)`

**测试门**：`scripts/delegation/test-mgmt-surface.mjs` 新增 **⑨ / ⑨b / ⑨c** ⇒ **19/19 + 消融 PASS**
（⑨ 8 个全剔；⑨b PATH/凭据保留；⑨c 消融"不剔就红"）。

**归因反证（★ 关键）**：修完后重发实验（v4），stderr **不再出现 DSH_HOME 拒跑**，
而是**真的进到了 `arm-up` 自检并读到了 boot.log**：
```
[失败] 起一代没过自检 ⇒ 不敢发题
  ✅ ⑤ 自进化两席已注册 — evo-dev + evo-review
  ❌ ⑥ 池端口在本段内 — 期望 33101
  ❌ ⑦ 现役仍健康 — ★ 探不通（通道不可用）—— 不等于现役坏了；先别下结论
```
⇒ 根因 B **确实被修掉了**（拦路虎从"env 拒跑"变成了"自检红"），且我新写的 ⑦ 措辞按设计生效。

### 根因 C：`arm-up` 对**已在跑的臂**每次都重新绑端口 ⇒ **僵尸 lease**（★★ 未闭合，本棒真拦路虎）

**证据（三路交叉）**：
1. `_arms/a/dshhome/switchboard/lease.json` 写 `activeGen = gen-33082 / **pid 9224**`
2. `tasklist /FI "PID eq 9224"` ⇒ **"没有运行的任务匹配指定标准"**（**进程不存在**）
3. `netstat`：`:33082` / `:33101` / `:33191` 实际持有人是 **pid 16520**（另一个还活着的 gen）
4. `gen-33082/boot.log` 第 6 段（`07:48:21Z`）：
   ```
   [key-pool-proxy] 33101 被占（多半是**上一代还没退**）⇒ 退避重试（每 1.5s，最多 8 次）
   [key-pool-proxy] ⚠️ 33101 连续 9 次拿不到 ⇒ **本代没有池**（旧代可能没退干净）
   ```
   ⇒ ⑥ 这次**是真的红**（新代没拿到池），不是假红。

**机制**：
- `arm-up.mjs` 走 `isolated-instance.mjs ... --force`（`--force` = **强制覆盖 `<root>/dshhome`**）⇒ 每次都**重新准备 + 重新起代**；
- 但**旧代进程从不被停**（16520 一直握着端口）⇒ 新代绑不上池 ⇒ 新代死；
- **而 lease 已经被改写成新代（死掉的）pid** ⇒ 从此 `lease` 指向**尸体**；
- `arm-up.mjs:314-322` 的 `rootHasLease` **只检查 `lease.activeGen.gen` 是不是非空字符串**，
  **不检查那个 pid 是否活着** ⇒ 僵尸 lease 被当成"这是我的实例 ⇒ 安全"。

**后果**：臂 A 进入**永久卡死**状态 —— 第一次 arm-up 成功（当时端口没人占），之后**每次**都红。
这正是本棒实验反复失败的真原因。

**修法方向（尚未实施，列为下一步）**：
1. `rootHasLease` 增加**活体检查**（`lease.activeGen.pid` 是否在跑）；
2. `arm-up` 在"已在跑"时**真的跳过**（而不是重跑 `isolated-instance --force`）；
3. 起新代前**先确认旧代已退**（或先优雅停旧代再起）；
4. `run-experiment` 里 `arm-up` 的**失败信息要能分辨**"端口被旧代占"与"隔离层/席位缺失"。

---

## 3. 副作用事故：现役控制面曾僵死（已恢复，机制未闭合）

**现象**：`:3080` 与 `:31800` **双双 HTTP 000**（进程 6816 活着、`netstat` 仍 `LISTENING`、**却不答**）；
而**臂 A（33080/33180）与 gen（3082）全程 200** ⇒ **只有现役控制面这一个进程僵了**。
**旁证**：`lease.json` 的 `expiresAt=1790407828504`（= `07:30:28Z`）**已过期**，且它 **15:30 被改写**
（正是 experiment 在跑 `arm-up` 的同一时刻）。

**恢复**：`cmd //c scripts\relaunch-switchboard.cmd`（后台跑）⇒ 复测 `:3080`/`:31800` **双双 200**、
`session.list` ok=true（369 会话）；**换代成功**（lease `generation` 15→16，gen-3082 pid 22512→12752）。

**未闭合的怀疑**：管理面用 **`spawnSync`** 串行跑 `arm-up`/`dsh-delegate`（`timeout: 900_000`）
⇒ **控制面自己的事件循环被同步 spawn 堵死** ⇒ 连 `:3080` 都不答。
⚠️ 若成立 ⇒ **管理面不能用 `spawnSync`**（要异步 + 队列）。**列为下一件要证的**。

---

## 4. 我改了什么（清单）

| 文件 | 改动 | 自证 |
|---|---|---|
| `scripts/arm-up.mjs` | `rpc()`/`get()` 加**超时+有界重试+结果分类**；⑦ 的 `detail` 分辨 `unreachable`/`slow`；`judgeSelfCheck` 加 `liveKind` 参；selftest 加 2 条真消融 | `--selftest` PASS；消融自证 PASS |
| `packages/switchboard/src/mgmt.ts` | 新增 `ARM_IDENTITY_ENV_KEYS` + `childEnv()`；`execAction` 传 `env: childEnv(env)` | 已 rebuild |
| `scripts/delegation/test-mgmt-surface.mjs` | 新增 ⑨/⑨b/⑨c | **19/19 + 消融 PASS** |

---

## 5. 诚实清单（我可能错在哪）

**没做成的**
- 本棒的**目标（经管理面跑完一次实验）没有达成** —— 卡在根因 C（僵尸 lease），我**只定位了、还没修**。
- 根因 C 的修法**只写了方向，没有实施、没有自证**。
- 控制面僵死的机制（`spawnSync` 堵塞事件循环）**是怀疑，不是结论** —— 我没做复现实验。

**拿不准的**
- 我判定"根因 A 是假红"依据的是**复现实验**（30 并发下探针 5/6 红）+ 当时现役实测健康。
  但**我没有当时（v1 失败那一刻）的并发快照** ⇒ "v1 那次到底是 A 还是 C 造成的红"，
  我只能说**两者都成立、且 C 是持续性的**。
- v4 的 ⑥ 红我判为"**真红**"（新代没拿到池）—— 依据是 boot.log 第 6 段。但同一份 boot.log
  **有 6 段 BOOT**，我读的是**最后一段**；如果"最新"的判据（`activeGen`）本身是尸体的名字，
  那么"最后一段"是不是**当前那一代**的日志，**我无法完全排除**。

**顺手做的（任务书没要求）**
- 把现役控制面**从僵死状态恢复**了（`relaunch-switchboard.cmd`）。
- 修了根因 A / B 并写了消融自证（任务书只要求"发实验+收卷+如实标注"）。
- 重发了 v4 以**反证根因 B 已修**。

**它的报告里我认同的部分**
- "管理面 HTTP 通道确实可用"（`brief`/`tasks`/`verdict`/`experiment`/`result` 都通）—— **属实**。
- "拿不到的读数如实标注"—— **做到**。

**它的报告里我否定的部分**
- "现役 control face（`:31800`）不稳导致 arm-up 拒绝" —— **端口归因错**（⑦ 只探 `:3080`），
  且真正持续的原因是**根因 C 的僵尸 lease**，与 `:31800` 无关。
- 自检**编号整体错位一位**（`④⑤⑥` vs 真值 `⑤⑥⑦`）。
