# 换代机制的结构性诊断：为什么 `retire` 写得好却从没生效过

> **状态**：结构性诊断（依据 = 代码 + 历史台账实测），**未改任何代码**。
> **起因**：用户 2026-09-26 的判断 ——
> *"只要把这个蓝绿面板做成启动器的形式，并且能够控制哪一代只映射到端口 3080 ……
> 每一代起来，然后又能够去发一个小任务去测试下一代是否有反应、是否真实起来了 ……
> 然后让下一代去跑上一代开发它的那一代的任务。很简单的一个逻辑。"*
> **结论：用户是对的，而且机制【早就写好了】—— 问题是有一条旁路绕过了整台机器。**

---

## §1 机制是完整的，而且**被验证过在工作**

`coordinator.ts` 的状态机逐字（`coordinator.ts:4`）：

```
idle → spawn → ready → freeze → promote → flip → verify → retire
```

这**就是**用户描述的那个流程，而且每一层都有实现：

| 用户说的 | 机制里的名字 | 位置 | 状态 |
|---|---|---|---|
| 「新代起来」 | `spawn` + `waitReady` | `coordinator.ts:215` | ✅ 有（含 pid 存活 + admin 可达 + gen 名一致） |
| 「发个小任务测试下一代是否有反应」 | `probe` + `runVerifyGate` | `coordinator.ts:612` | ✅ 有（还支持 `&fail=spawn\|catchup\|freeze` 注入失败来**自证**） |
| 「控制哪一代映射到 3080」 | `swapActive()` → `front.setActive()` | `coordinator.ts:201-206` | ✅ 有（**原子换 active**，返回被换下的旧代） |
| 「下一代跑上一代的任务」 | `reissuePrompt()` + `resumeSession` | `coordinator.ts:559` | ✅ 有（换代后自动补发 prompt） |
| **「旧代退场」** | **`retire`** | **`coordinator.ts:568-597`** | ✅ **有，且带强杀闭环** |
| 「失败要能回去」 | `abort` 回滚 | `coordinator.ts:518` | ✅ 有 |

**`retire` 的实际实现**（`coordinator.ts:568-597`）—— 写得比我预期的好：

```js
this.stage = 'retire'
if (seal.killNow) {
  // 旧代未确认停写 ⇒ 必须在【释放前门锁之前】把它杀到 PID 消失
  const stopRes = await old.spawned.stop(1500)
  if (stopRes.pidGone) this.record('seal ok：旧代已确认消失 …')
  else {
    // ★ 绝不静默：落盘现场 + 大字告警
    writeFileSync(join(cfg.coordDir, 'unfenced-old-gen.txt'), …)
    console.error('[switchboard] ⚠ 旧代未能确认停止写：…')
  }
} else {
  setTimeout(() => void old.spawned.stop(), cfg.retainMs)   // 保留窗口后退场
}
```

★ **它有"确认消失"判据**（`pidGone`）、**有升级告警**（`unfenced-old-gen.txt`）、
**有"绝不静默"的取舍说明** —— 这不是半成品。

### §1.1 实测：它**真的在跑**（铁律 11：数判据为真的次数）

`_arms/a/dshhome/switchboard/handover-status.jsonl` 全文（5 条，**全部 success**）：

```
{"t":…,"result":"success","note":"已切换 → gen-33083","gen":"gen-33083","resumeSession":""}
{"t":…,"result":"success","note":"已切换 → gen-33084",…}
{"t":…,"result":"success","note":"已切换 → gen-33085","gen":"gen-33085","resumeSession":"session-5802a87f-…"}
{"t":…,"result":"success","note":"已切换 → gen-33086","resumeSession":"session-978cbdb9-…"}
{"t":…,"result":"success","note":"已切换 → gen-33087","resumeSession":"session-b947544b-…"}
```

`state.jsonl` 的 stage 频次（实测）：

```
ready 15 / spawn 10 / freeze 10 / promote 9 / verify 8 / retire 6 / flip 5
```

⇒ **`retire` 执行过 6 次、`KILL-OLD` 1 次、5 次切换全成功、`resumeSession` 也真的带上了**
（"下一代跑上一代的任务"这条**被验证过**）。

**⇒ 结论：换代机制不是瓶颈，它是好的。瓶颈是有人绕过了它。**

---

## §2 真正的根因：一条**绕开整台机器**的旁路

### §2.1 旁路在哪

`scripts/arm-up.mjs:477`：

```js
const r = spawnSync(NODE, [path.join(HERE, 'delegation', 'isolated-instance.mjs'),
  '--arm', armName, '--root', root, '--port-base', String(ports.base), '--force'], …)
```

`isolated-instance.mjs:13` 对 `--force` 的定义**逐字**：

> `--force`：当目标 `<root>/dshhome` 已存在且非空时**强制覆盖**。

### §2.2 它绕过了什么

| 步骤 | 正常换代（`handover`） | `arm-up` → `isolated-instance --force` |
|---|---|---|
| 谁持有/改端口映射 | 协调器 `front.setActive()` | **没人**（直接重写 `<root>/dshhome`） |
| 新代自证 | `waitReady` + `probe` + `verifyGate` | ❌ 无 |
| 切流量 | `flip` | ❌ 无（它不走前门） |
| **旧代退场** | **`retire` + `spawned.stop(1500)`** | ❌ **无** |
| 失败回滚 | `abort` | ❌ 无 |
| dshhome | 复用（不动） | **推倒重建** |

⇒ **`--force` 重建 `dshhome` 时，旧代进程还活着、还占着端口。**
新代于是绑不上端口、当场死，而 `lease.json`（在刚被重建的 dshhome 里）已被写成
**刚死掉的 pid** ⇒ **自我延续**（§3 有因果链）。

### §2.3 为什么当初会有这条旁路（不是谁的恶意，是一个真实约束）

`packages/switchboard/src/spawner.ts:76-86` 起新代时：

```js
const env = { ...process.env, ...opts.envExtra, HANDOVER_GEN: …, HANDOVER_ADMIN_PORT: … }
```

★ **它【不设】`DSH_HOME`**（`grep DSH_HOME spawner.ts` = 无）⇒ **新代继承控制面的 `DSH_HOME`**。

而 `isolated-instance.mjs:111` 的意图是「**拿现役当源**」：

```js
const DSH_HOME_ACTIVE = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
```
（它的拒绝文案还说得很清楚：*"当前 shell 里的 DSH_HOME 指向的就是【本隔离实例自己】⇒ …会把隔离实例当现役"*）

⇒ **一个协调器只能服务一个 `DSH_HOME`** ⇒ 臂的 `_arms/a/dshhome` **不在**协调器能起的范围里
⇒ `arm-up` 只好自己重写 `dshhome` 再拉起 ⇒ **顺手绕过了全部机制**。

**这才是为什么它"从没生效过"：不是没人写，是那条路径够不着协调器。**

---

## §3 所有症状都从这一条长出来

| 症状 | 从旁路怎么长出来 |
|---|---|
| `EADDRINUSE` | 新代起来时旧代还占着端口（没人执行 `retire`） |
| 僵尸 `lease.json`（死 pid + 新时间戳） | `--force` 重建 dshhome 时改写了 lease，旧代没退 ⇒ 写进去的 pid 立刻死 |
| `ensureActiveLease()` 复活死 pid | `main.ts:183` 刚 `clear()`，`main.ts:191` 又用**刚从文件读到的死 pid** `grant()` ⇒ 清理瞬间被撤销（净零） |
| 现役也在撞 `EADDRINUSE`（`generation` 到 15） | 同一条旁路也用在现役重建上（`main.ts` 的启动序列在 err.log 里重复 10+ 次） |
| ⑦ 假红 | 判据去探 3080，而探针**与被查者共用那条被 `spawnSync` 堵住的循环**（另一个独立缺陷，见 `docs/arm-a-experiment-loop-still-open-2026-09-26.md`） |
| `poolPort=none` | 旁路不经过 `gen-assembly` 的端口分配 ⇒ 这一代没拿到池端口 ⇒ 只能去抢别人的 `33101` |

★ **一条旁路，六个症状。** 这解释了为什么逐个修症状越修越多。

---

## §4 干净的做法（**不是补丁**）

### 核心原则：**两个操作必须分开，"准备"是罕见的，"起代"是每次的**

现在被混成一件：
```
arm-up = 准备训练场 + 起一代        ← 错（准备是罕见操作，被高频执行）
```

正确：
```
准备训练场（罕见）：isolated-instance --force     ← 只在【臂不存在】或【结构性变更】时
起一代（每次）：     走协调器的 handover          ← 不碰 dshhome
```

### 落地：让协调器能服务训练场（**根因修法**）

| # | 改什么 | 为什么这是"根因" |
|---|---|---|
| **R1** | `spawner.ts` 把 `DSH_HOME` 变成**显式入参**（而不是继承 `process.env`） | 这是唯一让"一个协调器只能服务一个训练场"这个约束消失的改动。改完，`arm-up` **不再需要**自己重建 dshhome ⇒ **旁路可以整条删掉** |
| **R2** | `arm-up` 的 `--force` 只保留给"臂不存在/结构变更"；**起代一律走 `?cmd=handover`** | 把"准备"与"起代"分开 |
| **R3** | `main.ts:191` 的 `ensureActiveLease()` 加前置断言：`if (!pidAlive(this.active.inst.pid)) return`（**我不给死进程发票**） | 把不变量写进函数自己，不依赖调用点顺序 |
| **R4** | 管理面 `mgmt.ts:159` 的 `spawnSync` 改**异步 spawn + 轮询** | 否则任何在管理面里跑的检查都会把被检查的服务拖死 |
| **R5** | ⑦ 的 `ok` 三分：`true` / **`unknown`（不判红、复探）** / `false` | 见铁律 33 |

★ **R1 是那条"干净"的关键**：不修它，就只能继续在旁路上打补丁（比如给 `arm-up` 加一个
"先停旧代"的动作 —— 那是让**外部脚本**去管协调器的职责，是把补丁摞在病根上）。

### 附带需要用户裁决的两条策略问题
- `evals/runs/**`（运行产物）是否该排除在 `R1-EVALS-FROZEN` 之外（现规则用 `evals/**` 一把抓）。
- `arm-up.mjs`（含自检判据）现在是 R2，分类器自己标注了"可争议为 R1"。

---

## §5 本次诊断的边界（诚实清单）

1. **本文件只做诊断，未改任何代码。** §4 的五条都是**待实施的方案**，不是已完成。
2. **§1.1 的 `retire` 6 次**是 `_arms/a` 的历史台账读数。
   ★ **本次已补验"resumeSession 真的存在"**（铁律 29：不止读台账）：那 3 个 session id
   **都在臂A当前的 `session.list` 里**（共 9 个会话），且 `blank=false`（有真实内容），
   `updatedAt` 依次为 `1790335826263 → 1790340737499 → 1790344422343`
   ⇒ **确实是同一批会话被一代代交接下去、并且在交接后继续被使用**。
   ⇒ "下一代跑上一代的任务"这条**不只是台账说的，我验过了**。
   ⚠️ 仍未验：**我没有读那几条会话的正文**去确认"任务内容真的延续"（只验到
   "会话对象跨代存在且非空"）。这是两个不同强度的判据，别把它们混为一谈。
3. **R1（`DSH_HOME` 显式化）的影响面我没测**：我只证明了 `spawner.ts` 不设它，
   **没测**"设了之后会不会影响别的路径（如 `HANDOVER_CONTROL`、owner 判定、日志落点）"。
   ⇒ 实施前必须先做**影响面盘查**，不能直接动。
4. **旁路"当初为什么这么做"我只从代码注释推断**（`isolated-instance.mjs:111` +
   `README`），**没有找到设计讨论记录**。若属误读，请以 `docs/` 里的原始裁决为准。
5. 用户说的「把蓝绿面板做成**启动器**」这一条，**本次没有处理** —— 它属产品形态
   （桌面一键启动），与本文的换代机理是**两个独立问题**。
