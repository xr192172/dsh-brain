# 臂 A「僵尸 lease」的**完整因果链**（发起方独立核验，2026-09-26）

> ★ 本文是**独立核验**，不是转述。每一行都指到具体文件/命令行输出。
> ★ 本文的结论**修正了我自己先前两次判断**（第一次只有一半对，第二次也不完整）。

## 0. 结论（先说最要紧的）

**根因 = `arm-up` 每次都重跑 `isolated-instance --force`（重新起代），但旧代从不停** ⇒
新代绑不上旧代手里的端口 ⇒ **新代当场 crash** ⇒ 而 **lease 已被改写成新代的 pid** ⇒
**lease 从此指向尸体，且没有任何东西会再检查它** ⇒ **臂永久卡死**。

⇒ 我先前的"僵尸 lease"判据**方向是对的**（"旧代从不停"确实成立）。
但我中途改口的第二版判断（"只是文件陈旧、实例其实健康"）**是错的** —— 见 §3 的证据。

## 1. 现场读数（三路交叉）

| 读数 | 值 | 来源命令 |
|---|---|---|
| `lease.json`（文件） | generation=9, gen=`gen-33082`, **pid=9224**, expiresAt=1790409942737 | `cat D:/project_develop/_arms/a/dshhome/switchboard/lease.json` |
| `:33180/?cmd=status`（活着的控制面） | generation=**8**, gen=`gen-33082`, **pid=16520**, expiresAt=1790408316844 | `curl -s http://127.0.0.1:33180/?cmd=status` |
| `netstat` | `:33080`+`:33180` → pid **8876**；`:33082`+`:33101`+`:33191` → pid **16520** | `netstat -ano \| findstr LISTENING` |
| `tasklist` | 8876 **在**；16520 **在**；**9224 不在** | `tasklist /FI "PID eq <n>"` |
| 进程命令行 | 8876 = `packages\switchboard\out\b17904…\main.js`（控制面）；16520 = `@deepseek-ai\dsh\lib\bin.js --profile web --patch …\gen-33082\arm-isolation-overlay.yml --port 33082 --no-open`（代） | `Get-CimInstance Win32_Process` |

## 2. ★★ 决定性证据：控制面自己的日志（`D:/project_develop/_arms/a/dshhome/logs/switchboard-run.log`）

逐字照抄，**行号即文件行号**：

```
3: [switchboard] lease recovery OK: gen=gen-33082 port=33082 pid=16520 alive     ← ① 健康那次
4: [switchboard] front door http://127.0.0.1:33080 -> gen A :33082
5: [switchboard] control admin http://127.0.0.1:33180
8: [switchboard] lease recovery OK: gen=gen-33082 port=33082 pid=9224 alive      ← ② 又起一代：新代 9224
9: [switchboard:spawn] gen EXIT gen=gen-33082 pid=9224 code=1 signal= runtimeStopped=false   ← ③ 9224 当场死了
```

**这三行就是全部真相**：

1. **①** ⇒ 一开始有个**健康**的 gen **16520**，lease 指向它。
2. **②** ⇒ 又一次 `arm-up` ⇒ 控制面**又起了一代 9224**，并把 lease **改写成 9224**。
   ★ 注意它写的是 `lease recovery OK … alive` —— **控制面认为 9224 是活的**。
3. **③** ⇒ 但 **9224 立刻以 `code=1` 退出**。
   ⇒ **lease 从此指向 9224（尸体），而且再没有任何一步会回头复查它。**
   ⇒ 而 **16520 还活着**（它才是真正在服务的那个）⇒ 端口全在它手里。

### 2.1 9224 为什么死？—— 同一台机器上另一份日志给了答案

`D:/project_develop/_arms/a/dshhome/switchboard/gen-33082/boot.log` 最后一次 BOOT 段（`2026-09-26T07:48:21.867Z`）逐字：

```
[key-pool-proxy] 33101 被占（多半是**上一代还没退**）⇒ 退避重试（每 1.5s，最多 8 次）
Error: listen EADDRINUSE: address already in use 127.0.0.1:33191
    at Server.setupListenHandle [as _listen2] (node:net:2324:16)
[key-pool-proxy] ⚠️ 33101 连续 9 次拿不到 ⇒ **本代没有池**（旧代可能没退干净）⇒ 这一代的 LLM 路由会退化，请查上代是否残留进程
```

⇒ **死因坐实**：
- **池端口 `33101` 被占**（日志自己都写了"**多半是上一代还没退**"）；
- **管理端口 `33191` 也 `EADDRINUSE`** ⇒ `Unhandled 'error' event` ⇒ **进程 crash**（exit 1）；
- ⇒ 这正是 §0 说的"**旧代从不停 ⇒ 新代绑不上端口 ⇒ 新代死**"。

### 2.2 ★ 两个附带的真问题（同一次 boot 里暴露）

| 行 | 读数 | 含义 |
|---|---|---|
| `gen assembly: source=none profile=web poolPort=none patches=1 envKeys=0` | **`poolPort=none`** | 控制面**没有给这一代派池端口** ⇒ 它只能去抢 `33101`（别人手里的）⇒ 这才让"池被占"从"可退避"变成"致命"。★ 这是**独立于我改的那条**的第二个缺陷。 |
| `Starting inspector on 127.0.0.1:32811 failed: address already in use` | 调试端口也撞 | 同一现象的第三个面（非致命）。 |
| `TypeError: duplicate loader entry id: arm-isolation`（boot.log 第 9/16/27 行，**更早的段**） | 装配失败 | ★ 这是**本项目铁律 2** 记过的那个坑，在这次事故的**历史段**里也出现过（说明它曾被踩过，后来修好了 —— 最近一次 BOOT 段里没有它）。 |

## 3. ★★ 我自己的判断错在哪（如实披露）

| # | 我说过的话 | 对错 | 证据 |
|---|---|---|---|
| 1 | "**僵尸 lease**：lease 指向的 pid 已死 ⇒ 若继续起一代会又留一个尸体 ⇒ **先收拾干净再跑**（把占端口的进程停掉）" | **方向对，但处方有害** | 方向对：§0/§2 坐实"旧代从不停"。 处方错：它叫用户去**手停 16520** —— 而 16520 是**唯一在正常服务的那个**（§1：端口全在它手里，`:33180` 也答 200）。**按那条处方做 = 亲手打死健康实例。** |
| 2 | （中途改口）"真相**不是**旧代从不停；真相是**文件陈旧**，活着的控制面内存里是对的" | **错** | §3 的 ① ② ③ 三行：**旧代确实没退**（`33101 被占` 是它写的），**新代确实死了**（`gen EXIT … code=1`）。"文件陈旧"只是**结果**之一，不是根因。 |
| 3 | （我在**第三棒任务书初版**里）"② **修复这个文件**（把 lease.json 清成无活跃代）" | **错，已撤回** | `lease.ts:6` 逐字："**仅 Switchboard（协调器）持有并写本文件 —— 这就是"单一写者"的物理锚点**"。叫外部进程去 rewrite 它 = 破坏单一写者不变量 + 与活进程 read-modify-write 竞态 + 重置 `writerToken`/`lastFencingSeq`（**防 split-brain 的 fencing token**）。 |

★ **第 1 条与第 2 条的方向相反，说明我连续两次都没把"读数"与"归因"分开**——
  这正是**铁律 29**（子代理的读数与**它的归因**要分开验）**对我自己同样成立**的实例。
  §1 的读数**两版都一样、都是对的**；变的**只是我对它的解释**。⇒ 记录为 **铁律 29 的自用版本**。

## 4. 修法（正确的那一份）

**必须分成两件事做，且顺序不能颠倒：**

### 4.1 `arm-up`（本棒交给 DSH 做的，**只改这一个文件**）
1. **先问活着的控制面**（`GET <admin>/?cmd=status` 拿 `lease.activeGen.{gen,pid}`）——
   ★ **它是权威**，因为 `main.ts:178-189` 已经做过 stale-lease recovery，控制面**内存里的**才是真的。
   - 拿得到 + `pidAlive` ⇒ **视作"本实例已在跑"** ⇒ 走既有的"② 起（跳过）"，
     **绝不**再跑 `isolated-instance --force`（那正是砸坏健康实例的动作）。
2. **控制面拿不到** ⇒ 才看 `lease.json`（**只读！**）：
   - 文件里 pid 活着 ⇒ 同上（跳过启动）；
   - 文件里 pid 死了 ⇒ 判定"本段当前无活实例" ⇒ **打印说明 + 继续正常准备流程**，
     ★ **绝不自己写 lease.json** —— 让**新起的 control plane** 在 `main.ts:178-189`
     用 `coord.getLease().clear()` 走**唯一合法的清 lease 通道**。
3. 端口段被占 + 控制面拿不到 + 无 lease ⇒ **维持原拒跑**（那才是"别人占着这段"）。

### 4.2 仍**未闭合**的那一半（本棒**不做**，登记为待办）
★ **"旧代谁来停"** 仍然没有答案：
- 现有代码里**有**强杀闭环（`packages/switchboard/src/spawner.ts:55-75`：
  `SIGTERM → SIGKILL → (win32) taskkill /T /F → 确证 PID 消失`），**但 `arm-up` 没有用它**；
- `isolated-instance.mjs` 里 **grep 不到任何 stop/kill**（我验过）。
⇒ **要么**给 arm-up 加"起新代前先按 lease 里的 pid 停旧代"（但★依赖 lease 可信，
   而 lease 恰恰是不可信的那个），**要么**先在**控制面内部**修（让控制面在
   `spawn EXIT` 之后**立刻复查并清 lease**，并且在装配时**给新代派池端口**而不是 `poolPort=none`）。
⇒ **我倾向后者**：因为 §2.2 显示 `poolPort=none` 是让"池被占"变致命的直接原因，
   而"清 lease"按 4.1 的纪律**本来就该在控制面里做**。

## 5. 诚实清单

- **实测**：§1 全部读数、§2 全部日志行、§2.1 的 EADDRINUSE、§2.2 的 `poolPort=none`、进程命令行。
- **推断（未实测）**：§4.2 里"应当在控制面内部修"是**设计建议**，我**没有**动手改 `packages/switchboard/**`，
  也**没有**验证"清 lease + 派池"两步能否真的让新代起来 —— **那要靠下一次真实 arm-up 来证**。
- **没查出来**：那个**陈旧 lease 文件的确切写入时机**（是 9224 起之前写、还是之后写）——
  我只能从 §2 的三行顺序**推出**"先写 lease、后 EXIT"，**没有**拿到写那一刻的独立证据（没有写日志）。
- **未闭合**：§4.2 全部；`evals/arms.json` 与 `_arms/` 不一致（见另文）。

## 6. ★ 附：核验时发现的额外缺陷（都不是本棒的题）

### 6.1 `evals/arms.json` 的 `cwd`/`store` 指向**旧实验目录**（实证）

`evals/arms.json` 的 A/B 两条：
- A：`cwd: D:/project_develop/_abA/wt`，`store: D:/project_develop/_abA/store`
- B：`cwd: C:/_abB-experiment-root/wt`，`store: C:/_abB-experiment-root/store`

而 `arm-ports.mjs:denyForArm()` / `isolated-instance.mjs:188-195` 正是**用 `cwd`+`store` 拼 `DSH_ARM_DENY`**。
我实测（`loadArmsRegistry('evals/arms.json')` + 同名算法）得到臂 A 的 DENY 实际值：

```
臂A 实际拿到的 DSH_ARM_DENY = C:\_abB-experiment-root\wt,C:\_abB-experiment-root\store
```

⇒ **它不包含臂 B 的真实训练场 `D:/project_develop/_arms/b`。**

★ **但要精确说**（我第一版说重了，这里更正）：
按 `docs/training-ground-and-skill-sieve-2026-09-25.md:20/32`，
**真正承担"臂间隔离"的是 `DSH_HOME`**（`_arms/a/dshhome` vs `_arms/b/dshhome`，**那层确实是分开的**），
`cwd`/`store` 的定位是「**参与者锚定**」（字段保留，从旧语义继承）。
⇒ 所以准确的结论是：

| 说法 | 判定 |
|---|---|
| "臂间隔离完全没生效" | **❌ 说重了** —— `DSH_HOME` 那层是真的分开了 |
| "`DSH_ARM_DENY` 里挡的是**两个过期的参与者**，**跟当前臂 B 无关**" | **✅ 实证成立**（见上面的实测值） |
| "`denyRoots=2 条` 这个数字为真 ⇒ 但**不代表它挡对了东西**" | **✅ 这是铁律 11 的变体**（数字非零 ≠ 判据有效） |

⇒ **待办**（未做）：把 `cwd`/`store` 更新为训练场口径（或明确 `DSH_ARM_DENY` 该挡什么），
**并且**在文档里写清"`DSH_ARM_DENY` 与 `DSH_HOME` 各自负责哪一层隔离" —— 现在这两件事混在一起。

### 6.2 其他
- `_arms/a.bak-from-cancelled-session-1441` 残留目录。
- `_arms/a` 下**只有 `dshhome` + `verifyout`**，**没有 `wt`/`store`**
  ⇒ 印证 6.1：注册表里的那两个路径**本来就不指向训练场**。
