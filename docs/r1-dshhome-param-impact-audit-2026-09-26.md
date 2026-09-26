# R1 影响面盘查：把 `DSH_HOME` 变成 spawn 的显式入参

> **状态**：盘查完成（**未实施**）。本文只回答"改了会动到什么、动了以后哪条不变量会变"，不写改动代码。
> **前置**：`docs/handover-bypass-structural-diagnosis-2026-09-26.md`（结构性诊断，R1–R5 定义在 §4）。
> **用户授权**：*"可以开始盘查吧"*（2026-09-26）。
> **用户的设计约束（逐字，必须被本文证明而不是断言）**：
> *"我当时这么做是因为 DSH 换代之后可以继续，但是现在本身这样它也是可以继续的吧，只需要在里面
> 再加一个参数，指定当前会话控制的页面关闭之后，下一个会话的页面自动中继，就是像中继器一样自动
> 在下一代里面……开始这个会话，效果和现在也是一样的吧，依旧能够做到跨代，然后继续同一个会话的内容吧。"*
> ⇒ 盘查必须回答：**`DSH_HOME` 变成入参之后，中继器（跨代继续同一会话）是否还成立。**

---

## §0 结论先行（三条）

| # | 结论 | 依据 | 强度 |
|---|---|---|---|
| **A** | **中继器（跨代续同一会话）不依赖"`DSH_HOME` 是继承的"**，它依赖的是 **"同一训练场内的所有代共用同一个 `DSH_HOME`"** | `coordinator.ts:704 reissuePrompt(port, sessionId, text)` 只收端口与 sessionId；实测 arm A 的三次跨代中继全部 `ok:true` | ★ 直接实证（§3） |
| **B** | R1 之后的**语义必须精确定义为**："控制面把**它自己的** `DSH_HOME` 作为**显式值**传给子代"，**不是**"每个代拿一个不同的 `DSH_HOME`" | 会话存储 `$DSH_HOME/sessions/<cwd-encoded>/<sessionId>/` 实测存在；若各代 `DSH_HOME` 不同 ⇒ 新代**看不到**旧代的会话 ⇒ **中继器当场失效** | ★ 结构性推论 + 实测（§2.3） |
| **C** | **R1 的真正收益**不是"让中继器能工作"（它已经能工作），而是 **"让一个协调器能服务**别的**训练场"** ⇒ 这才使 `arm-up` 的旁路（`isolated-instance --force`）**可以整条删掉** | `spawner.ts:77-86` 不设 `DSH_HOME` ⇒ 继承控制面自己的 ⇒ "一个协调器 = 一个训练场" | ★ 直接读码（§2.2） |

**净判断**：用户的设计直觉（"再加一个参数就够了"）**方向正确**，但"参数"的**语义**必须钉死为
**"控制面把自己的 home 显式传下去"**（而非"每代一个 home"）—— 否则会**静默毁掉**中继器
（表现为：换代成功、会话列表变空、用户以为会话丢了）。这正是本项目铁律 18/23 那一族
（"回读成功 ≠ 生效的是你以为的那份"／"先确认那个组件有没有那个对象"）的又一次落点。

---

## §1 盘查方法（可复现）

| 动作 | 命令 / 文件 | 用途 |
|---|---|---|
| 读 spawn 唯一出口 | `packages/switchboard/src/spawner.ts:76-131` | 确认 `DSH_HOME` 是否被显式设置 |
| 三个调用点 | `main.ts:95`、`coordinator.ts:334`、`preflight.ts:143` | 确认入参结构（都是 `SpawnOptions`） |
| 控制面自己怎么解析 home | `main.ts:378/392` | 确认 `home`/`coordDir`/`workDir`/`genAssembly` 的推导链 |
| 管理面剔 env 名单 | `mgmt.ts:137-153` | 确认 `DSH_HOME` 已在一张"身份变量"名单里 |
| 中继器实现 | `coordinator.ts:704-733` | 确认它收什么参数 |
| 中继器台账 | `~/.dsh/switchboard/gen-*/resume.jsonl`、`/d/project_develop/_arms/a/dshhome/switchboard/gen-*/resume.jsonl` | ★ **数"判据为真的次数"**（铁律 11） |
| 会话实体 | `~/.dsh/sessions/`、`/d/project_develop/_arms/a/dshhome/sessions/` | ★ 证明 sessionId 落在哪个 home |
| 臂身份清单 | `scripts/delegation/isolated-instance.mjs:187-198, 820-823` | 确认旁路那条链怎么把 home 传下去 |

---

## §2 影响面逐项

### §2.1 三个 spawn 调用点 —— 全部是"加一个字段"，无结构阻力

| 调用点 | 现状 | R1 后 |
|---|---|---|
| `main.ts:95`（bootstrap 代 A） | 不传 home ⇒ 继承 | 传 `config.dshHome` |
| `coordinator.ts:334`（换代 staging） | 不传 home ⇒ 继承 | 传 `cfg.dshHome` |
| `preflight.ts:143`（预演代） | 不传 home ⇒ 继承 | 传 `this.cfg.dshHome` |

★ **三处同形**，`satisfies SpawnOptions` 会在漏传时报错（若字段为必填）⇒ **漏传是编译期红，不是运行期静默**
—— 这正是我们要的形状（铁律 7：宁可红，不要假绿）。

### §2.2 `spawner.ts` —— 一行式改动，但**必须显式覆盖而不是"不设置"**

现状（`spawner.ts:77-86`）：
```ts
const env: NodeJS.ProcessEnv = {
  ...process.env,                          // ← DSH_HOME 从这里漏进去
  ...opts.envExtra,
  HANDOVER_GEN: opts.gen,
  ...
}
```

★ **关键点**：`envExtra` 是**后**展开的，所以**理论上**调用方今天就能用
`envExtra: { DSH_HOME: '...' }` 覆盖它 —— **但这条路径是不可靠的**，因为：
1. `resolveGenSpawnSpec` 在 `envExtra` 里塞了清单 env + dev 模式覆写（`gen-assembly.ts:530-562`），
   顺序上**清单可能压掉**调用方意图；
2. 没有任何类型约束保证"调用方记得传"（当前 `SpawnOptions` 里没有这个字段 ⇒ 编译器不说话）；
3. 语义上是"碰巧能覆盖"，不是"契约要求覆盖"。

⇒ R1 的正确形状是 **`SpawnOptions` 增加必填字段 `dshHome: string`**，并在 `spawner.ts` 里
**显式写进 env（放在 `envExtra` 之前或之后都行，但必须在函数内有唯一一处显式赋值）**，
让"传 home"成为一个**契约**而不是一次运气。

### §2.3 ★★ `DSH_HOME` 到底控制什么 —— 这是 R1 的语义必须钉死的原因

实测（可复现）：

```
$ ls ~/.dsh/sessions/ | wc -l
23
$ ls ~/.dsh/sessions/ | head -3
--C-Users-Admin-Downloads-...--
--D-project_develop--
--D-project_develop-_abA-wt--

$ ls /d/project_develop/_arms/a/dshhome/sessions/
--D-project_develop-_abA-wt--
--D-project_develop-dsh-brain--
```

⇒ **会话存储 = `$DSH_HOME/sessions/<cwd 编码>/<sessionId>/session.jsonl.zstd`**。

**推论（决定性）**：
- `DSH_HOME` **是"这个 gen 能看到哪些会话"的根**。
- 若 R1 被误解成"给每个代一个独立的 home" ⇒ 新代的 `sessions/` 里**没有**旧代那个 sessionId
  ⇒ `reissuePrompt` 发过去会 **HTTP 200 但 resume 到空**（`resumed persisted session` 变成
  `no such session`）⇒ **中继器静默失效**。
- ⇒ **R1 的语义 = "控制面把自己那一份 `DSH_HOME` 显式传下去"**。这恰好就是今天的**实际行为**，
  只是从"继承"变成"显式" —— 也就是说 **R1 对现役是行为保持（behavior-preserving）的**。

★★ **副产品**：这条同时解释了 §0-C —— 要服务**别的**训练场（arm A），控制面必须能把自己
**换成** arm A 的 home 传下去。**"显式入参"正是让这件事成为一次调用参数、而不是一次进程重启。**

### §2.4 `WORK_DIR` / `coordDir` / `genAssembly` —— **未被 R1 覆盖，是 R1 的"影子依赖"**

`main.ts:392-395`：
```ts
coordDir:     envStr('WORK_DIR', join(home, 'switchboard')),
workDir:      envStr('WORK_DIR', join(home, 'switchboard')),
genAssembly:  envStr('GEN_ASSEMBLY', join(envStr('WORK_DIR', join(home, 'switchboard')), 'gen-assembly.json')),
```

★ `WORK_DIR` 的**默认值**从 `home` 推出来。所以：
- 若 R1 只把 `DSH_HOME` 变成参数、**不同时把 `WORK_DIR` 变成参数**，那么"换训练场"会变成
  **半个动作**：子代的 `DSH_HOME` 指向 arm A，但控制面的 `genDir` 仍在 `C:\Users\Admin\.dsh\switchboard\`
  ⇒ **代把 boot.log/lease/assembly 落在现役目录，把会话落在 A 臂目录** —— 一种极难查的**混合态**。
- ⇒ **R1 必须与 `WORK_DIR` 一起参数化**（或明确定义 `WORK_DIR` 由 `DSH_HOME` 派生，并且**两边一起换**）。

★★ 这是本次盘查**最有价值的一条**：它是一个**如果不查就会被漏掉**的耦合
（读 `spawner.ts` 一处是看不出来的，必须把 `main.ts` 的配置推导链一起读）。

### §2.5 `HANDOVER_CONTROL` —— **不受影响，但存在一个既有的隐式默认**

`spawner.ts:85`：
```ts
HANDOVER_CONTROL: process.env.HANDOVER_CONTROL || 'http://127.0.0.1:31800',
```
`deploy.ts:15` 同样写法。

★ 它**不是**从 `DSH_HOME` 推的，而是从 `process.env` 来（缺省硬编码 `:31800`）。
⇒ R1 不必碰它。但★ **它有一个既有隐患**：若一个非现役实例（如 arm A，控制面在 `:33180`）
忘了传 `HANDOVER_CONTROL`，子代会去问**现役的** `:31800` 要交接 ⇒ **跨场串线**。
实测 arm A 的起法（`arm-up.mjs:524`）把 `ports.env` 一起传了，所以**当前是对的**；
但这条**没有断言保护**（没有"子代必须向本控制面报到"的一致性检查）。
⇒ **记为 R1 的附带观察项**（不属于 R1 范围，但应登记为未闭合）。

### §2.6 `mgmt.childEnv` —— 与 R1 **方向一致**，不冲突

`mgmt.ts:137-146` 已经从子进程 env 里**剔掉** `DSH_HOME`（含 `DSH_ARM_SELF/DENY` 与四个端口变量），
理由（逐字）：*"子进程不许继承控制面的 `DSH_HOME`（以及其它"臂身份"变量）"*。

★ 与 R1 的关系：**同一条原理的两个应用面**。
- `mgmt.childEnv` 处理的是"控制面 → **脚本**"（**要**剔，因为脚本要回"现役语境"去当源）；
- R1 处理的是"控制面 → **代**"（**要**显式给，因为代必须与自己的控制面同 home）。
⇒ **不冲突，且可以共用同一张 `ARM_IDENTITY_ENV_KEYS` 名单**做文档化。
★★ **但要小心**：如果有人"为了统一"把 `childEnv` 也用在 `spawnGen` 上 ⇒ **代会失去 home**
（落回 `~/.dsh`）⇒ **隔离实例的代会写进现役的会话库** ⇒ 这正是最坏的那种串场。
⇒ **R1 实施时必须在新字段旁写这条禁令**（本项目铁律 2 是同族：相邻的两件事必须显式分开）。

### §2.7 端口分配 / `gen-assembly` 池口 —— **不受影响**

`coordinator.ts:307-310`、`main.ts:77-79`、`preflight.ts:120-121` 全部走
`allocGenPort(cfg.portBase, slot)`，`portBase` 来自 `GEN_PORT_BASE` env，**与 `DSH_HOME` 无耦合**。
`poolPort` 由 `resolveGenSpawnSpec` 的 `poolPortOf(a.pool, genPort)` 算，同样不吃 home。
⇒ **R1 不触碰端口面**（保持现状即正确）。

### §2.8 日志落点 —— **已经按 home 分家，R1 后自然正确**

`relaunch-switchboard.mjs:89`：
```js
const isLiveHome = !process.env.DSH_HOME || path.resolve(process.env.DSH_HOME) === path.resolve(LIVE_HOME)
const logDir = isLiveHome ? path.join(root, 'out') : path.join(process.env.DSH_HOME, 'logs')
```
★ 它判的是**启动器自己的** `DSH_HOME`（不是子代的）⇒ **与 R1 正交**。
唯一注意点：R1 之后"控制面能服务多个训练场"这个能力**不改变启动器**（启动器仍一进程一 home）
⇒ 日志分家逻辑**不需要改**。

### §2.9 臂间隔离（`arm-isolation` overlay）—— **不受影响，但暴露一个"半个身份"通道**

`gen-assembly.ts:574-595` 读 `process.env.DSH_ARM_SELF` / `DSH_ARM_DENY`
⇒ **这两个变量必须是"控制面级"的**（一进程一身份），不是 per-gen 的。
★ 与 R1 的关系：R1 若把 home 变成 per-spawn 参数，会**诱发一种错误类推**
——"那身份也应该 per-spawn"。**不行**：`renderArmIsolationOverlay` 是**代装配**的一部分，
而装配清单本身也是 home 级的（`<WORK_DIR>/gen-assembly.json`）。
⇒ **R1 的边界写清：per-spawn 的只有 `dshHome`（以及必须同行的 `workDir`）；
身份（`DSH_ARM_SELF/DENY`）保持控制面级。**

---

## §3 ★★ 中继器是否仍然成立 —— 用"判据为真的次数"回答（铁律 11）

用户的要求是"**证明**，不是断言"。判据 = `resume.jsonl` 里 `phase:"resume"` 且 `ok:true` 的条目。

**A 臂（隔离训练场，自己的 home `/d/project_develop/_arms/a/dshhome`）实测：**

| 代 | 台账条目（`resume.jsonl`） | 判定 |
|---|---|---|
| `gen-33084` | `drain … primarySessionId:"session-5802a87f-…"` | 冻结时点出主会话 |
| `gen-33085` | `resume session-5802a87f-… ok:true "scheduled (attach-only…)"`<br>`resume session-5802a87f-… ok:true "resumed persisted session"` | ★ **跨代续接成功** |
| `gen-33085` | `drain … primarySessionId:"session-978cbdb9-…"` | 第二次 |
| `gen-33086` | `resume session-978cbdb9-… ok:true "resumed persisted session"` | ★ **成功** |
| `gen-33086` | `drain … primarySessionId:"session-b947544b-…"` | 第三次 |
| `gen-33087` | `resume session-b947544b-… ok:true "resumed persisted session"` | ★ **成功** |

⇒ **判据为真的次数 = 3 / 3（100%）**，且发生在**同一个 home 内的三次连续换代**上。

**会话实体核对（证明"resume 到的是真会话，不是空转"）：**
```
/d/project_develop/_arms/a/dshhome/sessions/--D-project_develop-_abA-wt--/session-5802a87f-….jsonl.zstd   62,885 B
/d/project_develop/_arms/a/dshhome/sessions/…/session-978cbdb9-….jsonl.zstd   137,679 B  (0x.37 B)
/d/project_develop/_arms/a/dshhome/sessions/…/session-b947544b-….jsonl.zstd   254,360 B
```
⇒ **三个 id 三个实体，且体量递增**（62KB → 137KB → 254KB）= 会话**在跨代中持续增长**，
不是"续了个空壳"。（★ 这条就是本项目铁律 12 要的"阳性对照"：若中继器只是"发了个 200"，
这里应该看到三个 0 字节或同一个文件。）

**结论（回答用户）**：
> ✅ **效果和现在一样，依旧能跨代继续同一个会话的内容。**
> 而且它之所以成立，**恰恰是因为同一训练场内的所有代共用一个 `DSH_HOME`** ——
> R1 把这件事从"继承来的"改成"显式传的"，**语义不变**，因此中继器**不受影响**。
> ★ **但前提是 R1 的语义按 §2.3 钉死**；若误解成"每代一个 home"，中继器**立刻失效**。

---

## §4 影响面汇总表

| 面 | 是否被 R1 触及 | 方向 | 备注 |
|---|---|---|---|
| `SpawnOptions` / 三个 spawn 调用点 | ✅ **要改** | 加必填字段 | 漏传 = 编译期红 |
| 会话可见性（中继器的根） | ✅ **语义必须钉死** | 显式传"控制面自己的 home" | ★ 不这么定 ⇒ 中继器静默失效 |
| `WORK_DIR` / `coordDir` / `genAssembly` | ⚠️ **必须一起参数化** | ★ **本次盘查新发现** | 只改 home ⇒ 代的数据与日志分家 |
| `HANDOVER_CONTROL` | ➖ 不触及 | — | ★ 附记：子代向哪报到无断言保护（既有隐患） |
| `mgmt.childEnv` | ➖ 不冲突 | 同原理另一应用面 | ★ 必须写"禁止用在 spawnGen 上" |
| 端口分配 / `poolPort` | ➖ 不触及 | — | `allocGenPort` 不吃 home |
| 日志落点（`relaunch-switchboard.mjs:89`） | ➖ 不触及 | — | 判的是启动器自己的 home |
| `arm-isolation` 身份（`DSH_ARM_SELF/DENY`） | ➖ 不触及 | 保持**控制面级** | ★ 写清"per-spawn 的只有 dshHome" |
| `preflight` 预演代 | ✅ 要改 | 同形加字段 | 预演代必须与真代同 home，否则预演不算数 |

**改动形状（供实施参考，本文不落地代码）**：
1. `SpawnOptions` + `dshHome: string`（必填）+ 若 `workDir` 也应显式，一并加；
2. `spawner.ts` 在 `env` 构造里**唯一一处**显式写 `DSH_HOME: opts.dshHome`；
3. `main.ts` 的 `CoordinatorConfig` + `dshHome: home`（`home` 已是 `main.ts:378` 的局部量）；
4. 三个调用点各加一行；
5. **不碰**端口、不碰 `HANDOVER_CONTROL`、不碰身份变量、不碰日志落点。

---

## §5 未闭合（诚实清单）

1. **R1 只做"显式化"仍不足以删掉旁路** —— 要删旁路还需要 R2（`arm-up` 起代改走 `?cmd=handover`）。
   本文只盘查 R1，**R2–R5 的影响面未盘查**。
2. **"一个控制面服务多个训练场"这条能力，本文只证明它**可表达**（参数化），
   **没有证明**它在并发（同时服务两个 home）下是安全的** —— 例如 `LeaseStore` 的
   `lease.json` 在 `coordDir` 下，若两场共用一个 `coordDir` ⇒ 租约互踩。**未测量。**
3. **§2.5 的 `HANDOVER_CONTROL` 无断言**：只观察到"当前 arm A 是对的"，没有设计门去保证。
4. **本文未改任何代码**，因此 §3 的中继器实证来自**既有历史台账**（`resume.jsonl`），
   不是"R1 之后跑出来的"。⇒ R1 实施完**必须重跑一次真换代**来复验（消融自证，铁律 21）。
5. **已查并已定性（不是串场）**：现役 home 的 `~/.dsh/sessions/` 里**确实**有
   `--D-project_develop-_abA-wt--` 分片（52 个会话，mtime 全在 **Sep 23**）。
   一度疑为"R1 那个洞造成的串场"，**核对后否定**：
   - `evals/arms.json:17` 定义 arm A 的 `cwd` = `D:/project_develop/_abA/wt` ⇒ 编码正是 `_abA-wt`；
   - 该分片在**两个 home 里都有**：现役 home（Sep 23）+ A 臂 home（Sep 25+）；
   - `D:/project_develop/_abA/wt` **目录本身已不存在**。
   ⇒ 正确解释 = **同一个 cwd 路径在不同时间被不同 home 用过**（Sep 23 是现役语境，Sep 25 起改挂 A 臂 home），
   ★ **不是**"A 臂的会话写进了现役库"。
   ★ 但这条留下一个**真问题**：`$DSH_HOME/sessions/` 的分片键**只有 cwd**，**不含 home 身份**
   ⇒ 两个 home 用同一个 cwd 时，**"这是谁的会话"在目录名上不可辨**。若将来 R1/R2 让一个控制面
   真的去服务另一个训练场，**必须保证 cwd 也不同**，否则仍会撞同一个分片。**记为待办。**
