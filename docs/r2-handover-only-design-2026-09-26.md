# R2 设计：起代一律走 `?cmd=handover`，`--force` 只留给"结构性变更"

日期：2026-09-26
状态：**设计已定，未实施**（含一处需用户裁决的分叉）
上位：`docs/handover-bypass-structural-diagnosis-2026-09-26.md` §4 的 R2
前置：R1 ✅ `06739e4`、R1.5 ✅ `92449dd`

---

## 1. R2 要拆的东西（一句话）

`arm-up.mjs:477` 现在这样起臂：

```js
spawnSync(NODE, ['.../isolated-instance.mjs', '--arm', armName, '--root', root,
                 '--port-base', String(ports.base), '--force'], ...)
```

★ 两个动作被**捆在一条命令**里：

| 动作 | 是否幂等 | 该多久做一次 |
|---|---|---|
| **准备训练场**（建 `<root>/dshhome`：profile / settings / 自建 preset / node_modules 符号链接） | ✅ 幂等 | **一次**（结构性变更时） |
| **起一代**（真的 spawn 一个 DSH 代进程） | ❌ 每次都是新进程 | **每次换代** |

⇒ 捆在一起 ⇒ 每次"起代"都被迫走"准备"那条路 ⇒ `--force`（"目标已存在且非空也覆盖"）
从"给结构性变更用的逃生阀"**长成了常规路径**（R1 盘查 §11.4 已诊断）。

## 2. ★★ R2 的正确形状（三层拆开）

```
① 准备   isolated-instance.mjs  （幂等；只在【结构性变更】时带 --force）
              ↓ 产出：<root>/dshhome 骨架 + [arm-env]（身份 + 端口）
② 起控制面 relaunch-switchboard.cmd（带该臂 env）—— 【一次性】
              ↓ 控制面带着 DSH_HOME=<该臂> 起来
③ 起新一代 :<SWITCH_ADMIN_PORT>/?cmd=handover   ← 【之后所有换代都走这条】
```

★ **为什么 ③ 就够了**（这是 R1/R1.5 刚挣来的能力）：
`?cmd=handover` 用**控制面自己的 config** 去 spawn 新代（`coordinator.ts` 的 `spawnGen`）。
R1 之后 `config.dshHome` = **控制面自己的 home**；R1.5 之后 `coordDir`/`workDir`/`genAssembly`
也都从同一个 home 派生 ⇒
**"控制面带着臂A的 home 起来" ⇒ 它每次换代产出的新代，自动就是臂A训练场里的一代。**
⇒ **不需要**每次换代都去 `isolated-instance --force` 重建一遍训练场。

## 3. `--force` 的新语义（R2 的核心裁决）

| 场景 | 用不用 `--force` | 判据 |
|---|---|---|
| 训练场**不存在**（`<root>/dshhome` 空/无） | 不用（本来就不冲突） | `!exists(dshhome) \|\| isEmpty(dshhome)` |
| 训练场**已存在**且要**重建骨架**（结构变更：换 profile / 换 preset / 换 node_modules 布局） | **用**（但要**显式**、要**记账**） | 调用方显式 `--rebuild` |
| 训练场已存在，只是**要起新一代** | **不用** —— 走 `?cmd=handover` | 控制面活着 ⇒ handover |
| 控制面**死了**（进程不在） | 不用 `--force`；重新 `relaunch-switchboard`（**不重建 home**） | `pidAlive` 判 + 端口探测 |

★ 关键变化：**"覆盖训练场"与"起代"解耦**。
`--force` 不再能被"我只是想重启一下"这种理由碰到 —— 它要么被 `--rebuild` 显式触发，
要么根本不出现。

## 4. 实施清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `scripts/arm-up.mjs` | ① 准备阶段：`--force` 改为**只在 `--rebuild` 时传**；否则不传（幂等路径） |
| 2 | `scripts/arm-up.mjs` | ② 起控制面：保持 `relaunch-switchboard.cmd`（一次性） |
| 3 | `scripts/arm-up.mjs`（新） | ③ **新增 `--gen`**（或 `--handover`）：控制面活着 ⇒ 打 `?cmd=handover`；**不碰 isolated-instance** |
| 4 | `scripts/arm-up.mjs` | 判据：控制面活着 + 要换代 ⇒ **拒绝**走"准备"路径（把今天的默认行为反过来） |
| 5 | `scripts/arm-up.mjs`（门） | 新判据 `--selftest` 里加：**"起代"路径不得出现 `--force`**（源码 + 行为双检） |

## 5. ★★ 用户裁决（2026-09-26，**已定，不再重开**）

| 问题 | 裁决 |
|---|---|
| `arm-up A` 的语义 | **保持原义**（"确保这个臂可用"：不在就建+起，已跑就只自检，**不覆盖**）<br>★ **换代新开动词 `arm-up A --gen`**（只打 `?cmd=handover`）⇒ 只加不覆盖（铁律 22） |
| `--force` 的触发 | **只由显式 `--rebuild` 触发**；且**每次使用记账留痕**。日常"起代/重启"永远碰不到它 |

★ 用户原话（第一轮）*"我不能理解，我不知道现在有哪些命令，起什么效果"*
⇒ **教训（已固化）**：**问设计岔路之前，必须先把「当前命令面」摆出来**（有哪些动词、各起什么效果），
否则用户没法裁决。这属于"问问题的方式"而不是"问题的内容"。见铁律 35。

### 5.1 拆开后的命令面（目标态）

| 命令 | 含义 | 会不会碰训练场 |
|---|---|---|
| `arm-up --live` | 起现役（无参） | 不适用（现役不复制骨架构） |
| `arm-up A` | **确保**训练场 A 可用 | 只在**不存在**时建 |
| `arm-up A --gen` | **换一代**（走 `?cmd=handover`） | **绝不**（不碰 isolated-instance） |
| `arm-up A --rebuild` | **结构变更**：重建骨架（唯一允许 `--force` 的路径） | 会覆盖（**记账留痕**） |
| `arm-up --selftest` | 跑判据 | 不碰 |

## 6. 验收

- `arm-up A` 在臂已跑时：**不**触碰 `isolated-instance`，**不**出现 `--force`（可在日志里核）。
- `arm-up A --gen`：只发 `?cmd=handover`，轮询到 `success`，新代 pid 变、lease 前进。
- `arm-up A --rebuild`：才出现 `--force`，且**台账留痕**。
- 消融：把 `--force` 硬编码回准备路径 ⇒ 门必须变红。

## 7. 诚实清单

1. **本文只做设计，未改代码。**
2. ★ **`arm-up.mjs` 的判层是"可争议为 R1"**（分类器自己标注的）⇒ 实施要按 R0 走见证流程。
3. ★ **R2 依赖 R1/R1.5 已落地**（否则 ③ 起出来的新代看不见臂A的会话）——
   这两条今天**已落地**，所以 R2 现在**可以**做（若在 R1 之前做，会把中继器拆坏）。
4. ★ **R2 依赖 R1/R1.5 已落地**（否则 ③ 起出来的新代看不见臂A的会话）——
   这两条今天**已落地**，所以 R2 现在**可以**做（若在 R1 之前做，会把中继器拆坏）。
   ★★ **前置已补验（2026-09-26）**：臂A 控制面经 `?cmd=handover` 产出的 `gen-33083`，
   它**自己的 boot.log** 把 capability registry 解析到
   `D:\project_develop\_arms\a\dshhome\capabilities\registry.json`
   ⇒ **确实是一代"落在臂A home 里"的代**，且 `resume.jsonl` 两条 `ok:true`（日更 §13.3）。
   ⇒ **"控制面服务它自己那个训练场"这条在 `?cmd=handover` 上是通的**。
   ⚠️ 仍需注意：这条只证了"**同一个** home 内的换代"；"一个协调器去服务**另一个** home"
   （即 `WORK_DIR` 与 home 不同源）仍受 R1.5 §6-1 的类型层缺口约束 ⇒ **R2 不依赖后者**。
5. `--force` 目前**只在 `arm-up.mjs:477` 一处**出现（已 grep 确认），没有别的调用者。
