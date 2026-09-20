# 换代 vs 重启 —— 蓝绿脑该留还是该删

> 日期：2026-09-14
> 触发：用户提出「蓝绿脑使用频率很低，甚至可能没必要了，重启应该能达到一样的效果」
> 结论：**不删。** 但要把它的适用面收窄到"机制改动"，日常替换走重启。
> 关键前提：**换代 = 重启 + 三道保险**，不是"另一种方案"。

---

## 1. 先把事实查清：到底有什么"自动更新机制"

用户的印象是「DSH 本身有自动更新机制，可能比蓝绿更好用」。实测结果比这个窄：

| 机制 | 状态 | 管什么 | 不管什么 |
|---|---|---|---|
| `@deepseek-ai/cordis-plugin-hmr`（chokidar + picomatch，`root: ['.']`） | **被禁用** | ——（若能启用，会热重载 host 侧插件模块） | 现状：**host 侧完全没有热更新** |
| `@deepseek-ai/dsh-client-hmr`（`id: client-hmr`） | **常驻挂载** | **浏览器侧** client bundle 的重载链 | 且"idle until a rebuild watcher (`pnpm run dev:web`) actually rewrites client bundles" —— 只在手工起 dev watcher 时才动 |
| npm 升级 `@deepseek-ai/dsh` | 常规 | 底座版本 | 仍需重启才生效 |
| switchboard 自动换代 | **不存在** | —— | 无 watcher、无自动检测 |

**HMR 被禁用的原始出处**（`node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:21-23`）：

```yaml
# TODO: Re-enable shared HMR for Web after its reload lifecycle is tested.
- id: hmr
  disabled: true
```

→ 是**上游自己关的**，理由是"Web 的重载生命周期还没测过"。所以"自动更新"目前**不覆盖 host 侧代码**，改插件代码的最小路径仍然是重启。

**换代的触发方式**只有一条（`packages/switchboard/src/main.ts:123`）：

```ts
if (cmd === 'handover' || cmd === 'apply') { ... }
```

即**只有 admin HTTP 命令能触发**。没有文件监听、没有"检测到新 build 就自动换"。`scripts/evolve.mjs` 是唯一把它自动化了一层的门面（build kernel → `?cmd=apply&kernel=` → verify → flip）。

---

## 2. 为什么"重启能替代换代"不成立

换代的状态机是 `idle→spawn→ready→freeze→promote→flip→verify→retire`。逐条对照重启：

| 维度 | 重启 switchboard | 换代（蓝绿） |
|---|---|---|
| 加载新代码 | ✅ | ✅ |
| **进行中的 turn** | **被杀死**（前门就是 switchboard 进程本身；`spawn` 用 `stdio:['ignore',logFd,logFd]`，非 detached，随进程树一起走） | **等它收尾** —— `coordinator.ts:167-176` 有 defer：`prepareSwitch(deferMs)`「注入挂起提示 + 等 `turn/end` 或 grace 兜底」，并记录 `waitedForTurnEnd` |
| **失败时的退路** | **没有**。新代码起不来 = 彻底没服务 | **`rollbackFlip`**（`:482`），旧代无损继续服务 |
| **承接流量前的真实校验** | 无 | probe（:292）+ verify gate（:319）+ 稳定期探测（:332）+ 本轮新增的**启动健康检查** |
| 停机窗口 | 有（前门端口短暂不可用） | 无（flip 是原子换向，旧代在 verify 后才 retire） |
| 复杂度 | 低 | 高（状态机 + catchup + freeze/promote/flip/retire） |

**一句话**：换代不是"另一个方案"，它是**带保险的重启**。
所以真正的问题不是「换代 vs 重启」，而是「**这次改动需不需要保险**」。

---

## 3. 但用户"觉得换代没用"是对的 —— 原因是三个 bug，不是设计

这是本文最重要的部分。回看 2026-09-13/14 修掉的三个 P0，**全部是换代引入或换代暴露的**：

| P0 | 与换代的关系 | 状态 |
|---|---|---|
| **端口击穿**：system prompt 里嵌 gen 实例端口（3082~3089），换代迁移 → 端口变 → 首轮命中率 **0%**（`28f50f57` 迁移 13 次） | 换代**引入**的代价 | 已修（`DSH_PUBLIC_WEB_URL` → 固定为前门 3080） |
| **插件树部分加载失败** → 工具少 25 个、Code Mode 静默回落 native、模型要靠试探发现环境 | 换代把会话**搬到坏实例** | 已修（单一来源化 + verify 启动健康检查）<br>⚠️ 其中健康检查于 **2026-09-15 二次修复**：09-14 那版是**假修复** —— 判据对但**读日志太早**（崩溃文本比 `success` 晚 637ms 落盘），gen-3083 仍被放行。现改为 `boot-health.ts` 的有界等待 + 正向完成信号要求，见 `docs/gen-plugin-tree-partial-failure.md` §0.1 |
| **BOM 崩 gen**：`SyntaxError: Unexpected token` → 新 gen 起不来 | 换代时新代起不来 | 已修（4 处解析统一防护 + 守卫） |

**所以"换代不好用"的感受，主要来自"换代的保险没装好"**——而不是"换代这件事没价值"。
在端口固定 + 启动健康检查 + 单一来源化都到位之后，换代的**实际成本才第一次接近它的设计意图**。

一个反直觉的推论：**这两个 P0 之所以能藏一两天，恰恰因为换代不常发生**。
频率低不是"没用"的证据，而是"**发现能力不足**"的证据 —— 也让今天补的 verify-boot-health 更有必要。

---

## 4. 建议：三级替换策略（保留换代，但降级为"罕见且必备"）

| 档 | 适用 | 手段 | 中断 | 可回滚 | 前置校验 |
|---|---|---|---|---|---|
| **L1 热重载** | 反复调 UI / client bundle | `pnpm run dev:web` + `client-hmr`（已常驻） | 无 | —— | 无 |
| **L2 重启** | **日常插件业务代码改动** | 重启 switchboard（可做成一条命令） | 有（秒级） | 靠 git | 无 |
| **L3 换代** | **内核机制 / 插件树组合 / profile 配置 / 判据自身**的改动 | `?cmd=handover` 或 `scripts/evolve.mjs` | 无 | ✅ `rollbackFlip` | probe + 启动健康检查（有界等待 + 正向信号）+ verify 闸 |

> **★ fast 与"启动健康检查"是两条独立防线（2026-09-15 澄清）**：
> fast 跳过的是**稳定观察窗**（`verifyStableMs`），而稳定窗只重探 `probe`（"进程还活着吗"）——
> 它**不覆盖"日志落盘了吗"**。gen-3083 事故恰好发生在 **fast 路径**上：进程当时确实还活着
> （probe 会通过），崩溃文本 637ms 后才落盘。⇒ 健康检查的有界等待与 `verifyStableMs` **正交**，
> fast 模式**不得跳过**（现实现亦未跳过；另有 `SWITCH_BOOT_HEALTH_TIMEOUT_MS` 可调窗口）。

**分工的判据只有一句**：**这次改动坏了，会不会立刻被发现？**

- 会立刻发现（UI 报错、跑不起来）→ L2 就够，保险是浪费
- **可能静默劣化**（工具少了 25 个不报错、命中率掉了、能力退化了）→ **必须 L3**

而 L3 覆盖的那几类，恰好就是用户说的「整个 Agent 需要换代、里面有什么机制要被改动、或者离线验收通路需要被修改」——**用户的直觉是对的，而且正是因为它覆盖高危险改动，才更不该删**。

### 为什么不删

1. **删掉安全网不降低风险，只把"可回滚"换成"不可回滚"。** 上面三个 P0 已经演示了静默劣化能活多久（一天以上）。
2. **边际成本≈0**：已经建好、今天刚修完、且是 opt-in（只有显式命令才跑）。日常完全不占资源。
3. **删了它，`scripts/evolve.mjs` 这条自进化闭环就断了**——而 `?cmd=apply&kernel=<out>` 正是"实验内核 + verify 才 flip"的唯一落点，也是《自进化总纲》§5 判据阶梯的执行器。
4. **频率低不是缺陷。** 换代该发生在"要动机制"时；如果它天天跑，说明我们把替换当常态了——那才是问题。

---

## 5. 可选的两个小动作（都不急）

1. **把"重启"也做成一等公民**：现在重启要手打 `start-switchboard-ascii.ps1`。可加 `?cmd=restart` 或一个 `scripts/restart-switchboard.mjs`，
   语义明确为「不保证不中断、不校验、不回滚」的快速路径。**让 L2 变便宜，L3 才不必被滥用。**
2. **HMR 值得做一次小实验**：上游留了 TODO（web 重载生命周期未测）。我们现在有 A/B 方法论
   （`measure-context-efficiency.mjs --snapshot/--compare`）和 `--dump-config` 离线验收，正好可以补上他们缺的那一步测试。
   若通过，L1/L2 的边界会大幅前移。**但这是独立课题，不阻塞任何事。**

---

## 6. ★ 换代的副作用：它会主动"接手"用户会话（2026-09-14 实测）

这是最容易忽略、也最需要知道的一条：**换代不只是换代码，它会改变用户会话的状态。**

### 实测证据

换代后，被交接的会话里出现了**两条**自动注入的提示：

| seq | 来源 | 文案 |
|---|---|---|
| 5339 | `coordinator.ts` 的 `reissuePrompt`（控制面 flip+verify 后） | 「交接完成（代际切换已成功）。请直接继续你刚才正在进行的任务，无需重新说明背景。」 |
| 5342 | `index.ts:320` 的 `scheduleResume`（**新代 promote 时**，由 switchboard 插件自己） | 「【自动续跑】…请在**无需用户再次确认**的前提下，把该任务自主续跑并执行到完成为止…**本次续跑视为用户已预先批准，不要再停下来征询用户或等待确认。**」 |

**⇒ 两层叠加，一次换代注入两条 prompt，并且真的驱动了一轮 LLM 执行。**

触发条件（`src/index.ts:307-325`）：

```ts
if ((patch.resumeOnPromote !== false) && req.resumeSessionId) {
  scheduleResume(agentsRef, req.resumeSessionId, ['【自动续跑】…'], 4, cfg.genDir)
}
```
即**默认开启**（仅当显式 `resumeOnPromote: false` 才关）。

### 两个问题

**① 两条 prompt 是重复的**（一次换代一次就够），而且第二条的语气更强
（"视为用户已预先批准"）——**换代不应该替用户预先批准任何事**。

**② 更有害的：如果被接手的 turn 卡在等人类输入，再换代会让会话卡住未 attach。**

实测链路（2026-09-14 02:05 / 02:07 两次 fast 换代）：

```
02:05:49  第 1 次换代 → 注入 prompt → turn 3 跑起来 → 产生 ask_user_question（等用户回答）
02:07:48  第 2 次换代 → 该 turn 的 turn/end 永不会来
          → resume 到新代失败（result.ok=false, code=internal）
          → 会话变成未 attach（host.describe → attachedSessions: 0）
```

**关键**：这不是 fast 模式独有的问题。正常情况下 `prepareSwitch(deferMs)` 等的是 `turn/end`，
而**卡在 `ask_user_question` 的 turn 永远等不到 `turn/end`** → defer 只能靠 grace 超时兜底
（默认 20s）→ 然后照样 flip。**所以快慢换代都会中招，fast 只是把它提前了 20 秒。**

### 建议 —— ✅ 已实施（2026-09-14，build `b1789323453051`）

**实现方式（比原建议更细：保留两层，但重新划分职责）**

原建议是"两层只留一层"。实际实现改成**保留两层、职责分离**，因为 `scheduleResume` **不只是注入** ——
它同时做 attach（`agents.resume`），删掉它会让后续 reissue `session-not-found`：

| 层 | 改动 | 落点 |
|---|---|---|
| **gen 侧 `promote`** | `scheduleResume(..., [], ...)` —— **只 attach，不注入任何文本** | `index.ts` |
| **gen 侧 `prepareSwitch`** | 加 `turn/start` 监听 + **空闲短路**：无未收尾回合时**不注入 steer、不等 grace**，立即返回 `reason:'idle'` | `index.ts` |
| **协议** | `PrepareReply.turnInFlight`：**"调用时有没有活"**，与 `waitedForTurnEnd`（**"活干完没"**）区分开 | `handover-protocol.ts` |
| **coordinator** | `resumeInject = (prep.waitedForTurnEnd === true)`；否则**记录跳过原因**；**fast 模式一律不注入**（未探针） | `coordinator.ts` |
| **coordinator** | reissue 响应截断 `120 → 800` 字符，非 200 另打 stderr（原先内部错误被砍成 `"code":"internal"` 就没了） | `coordinator.ts` |

**注入判据（最终）**：**`waitedForTurnEnd === true`，即"确有活、且已干净收尾"。**

| 场景 | 结果 |
|---|---|
| 有回合且正常收尾 | ✅ 注入续跑（这才是该机制存在的理由） |
| 会话空闲 | ❌ 不注入（`prepareSwitch` 直接短路，**顺带省掉原先必然白等的 20s grace**） |
| grace 超时（有活但没收尾，**常见于卡在 `ask_user_question`**） | ❌ 不注入，记录"可能在等人类输入" |
| fast 模式 | ❌ 不注入（跳过 defer 未探针，保守处理） |

**顺带收益**：正常 handover 在**空闲会话**上不再白等 20s —— 因为空闲会话永远等不到 `turn/end`。
即"20s 等待"实际只在**真有活**时才发生。

**⚠️ 生效条件**：`coordinator` 的改动在 **switchboard 进程**里 → **需重启 switchboard**；
gen 侧改动（`index.ts`）随下一次换代 spawn 的新 gen 生效。

### 6.1 ★ 注入规则：应该按会话状态分**三类**（用户 2026-09-14 提案，已细化）

用户提案的规则：**「如果 turn 正在跑 → 让它自行继续；如果本身就是停的 → 不要再注入」**。
方向对，而且**判据是现成的** —— `prepareSwitch` 的返回值里就有。

```ts
// packages/switchboard/src/index.ts:333-373（原文要点）
prepareSwitch: async (graceMs) => {
  if (state.mode !== 'active') return { ok:false, ..., reason:'not-active' }
  const agent = agents?.get(state.lastActiveSessionId)
  agent?.steer?.({ role:'user', content:'【系统通知】环境即将热重载。请把当前任务收尾…' })  // ← 对 idle 会话也注入
  // 等一个"晚于本次调用发起点"的 turn/end，或 grace 兜底
  p.timer = setTimeout(() => resolve({ ok:true, waitedForTurnEnd:false, reason:'grace' }), graceMs || 20_000)
}
```

**两个关键事实**：

- **`waitedForTurnEnd` 就是"当时有没有 turn 在跑"的代理判据**：
  - `waitedForTurnEnd === true` → 等到了 `turn/end` ⇒ **有 turn 在跑**
  - `waitedForTurnEnd === false && reason === 'grace'` → **没等到** ⇒ **idle**（或卡住）
- **⚠️ 它现在对 idle 会话也注入 steer，并白等满 grace（默认 20s）** ——
  因为 idle 会话不会产生新的 `turn/end`。
  ⇒ **这给 fast 模式补上了最硬的理由**：正常 handover 那 20s 在**多数情况下是纯浪费**，
  不是"牺牲不中断换速度"，而是"那个等待本来就等不到东西"。

**应该分三类（用户提的两类 + 一类漏掉的）**：

| 状态 | 判据 | 换代时怎么办 |
|---|---|---|
| **running**（有 turn 在跑） | `waitedForTurnEnd === true` | ✅ **注入续跑**（"继续你刚才的活"）—— 这正是该机制存在的理由 |
| **idle**（没有未完成 turn） | `reason === 'grace'` 且无挂起问答 | ❌ **不注入**（用户提的：白跑一轮没意义，还会污染会话） |
| **blocked**（等人类输入） | `reason === 'grace'` **且** 最近是 `tool/call ask_user_question` 无对应 `tool/result` | ❌ **不注入，并标记"不宜交接"**；理想情况是**延后换代** |

**第三类是实测出来的（不是推的）**：只分两类的话，`blocked` 会被归进 `running` → 注入 →
而它的 `turn/end` **永不到来** → 再换代 resume 失败 → 会话未 attach。见上文实测链路。

**DSH 侧待确认**：是否有比"扫最近事件"更直接的挂起状态信号
（`agent` 代理上可能已有类似 `pendingUserQuestion` 的东西）。
若没有，就在 `prepareSwitch` 里加一个轻量探测（读最近事件），由控制面消费。

### 6.2 ★ 但"审批层自己变动"是个例外 —— 无环原则

用户的追问：**「主 A（顶层）如果审批层那边要变动怎么办？还能继续完成这个自动化吗？」**

**答案：能自动化，但要在"需要外部见证"那一步停下来。**

**根本原因**：自动续跑 = **系统替用户批准了继续**。
- 换代的是**能力** → 自动继续合理（低风险、可撤回、坏了会被立刻发现）
- 换代的是**判据 / 审批层本身** → **自动继续 = 被改的判据自己批准了自己的部署**

这正好撞上我们的铁律：**判据不能被被判定者自证**。

**⇒ 引入"无环原则（acyclic approval）"**：

> 把"谁批准谁"画成一堆箭头，**只要出现回路就是漏洞**。
> 「被改的审批层自动批准它自己的部署」就是一个环。

| 变动对象 | 见证方 | 换代后自动续跑？ |
|---|---|---|
| **R2 能力层**（tool / skill / prompt / 子 agent / 普通代码） | 判据阶梯（自动） | ✅ **自动** |
| **R1 判据层**（评测集 / holdout / 权限声明 / 配额上限 / 审批逻辑） | **外部（人 / 独立见证）** | ❌ **不自动续跑** —— 留一条待批记录，等外部确认后再续 |
| **R0 自举层**（启动 / 恢复 / 回滚路径） | 外部 + **自举性检验** | ❌ 同上 |

**两点必须写死**：

1. **层级标签不能由发起者自己填**（否则它会把自己标成 R2）。
   由**变更的实际路径**推断，且**推断逻辑放在控制面**：
   改到 `guard.ts` / 判据文件 / holdout / 权限声明 → R1；其余 → R2。
2. **控制面自身属于 R1，agent 不可写它。**
   即：**决定"能不能自动批准"的那段代码，不能被"被批准的东西"改写。**
   （我们现在能改它，是因为"我们"站在 agent 之外 —— 这个内外边界必须显式写清。）

**这是"契约式授权"能成立的前提**：人批**一次**「标准 + 预算」，之后的执行全自动；
只有"标准本身要改"时，才回到外部见证。所以**自动化不会被这条打断，它只是不能被自己破环**。

---

## 7. 一句话

**换代不是"要不要用"的问题，是"该不该给它上保险"的问题。
今天做的三件事（端口固定、启动健康检查、单一来源化）不是给换代加复杂度，而是终于把它的保险装上了。
在那之前，你付的是保险费却拿不到理赔；在那之后，它才开始净为正。**

---
## 8. ★★ 换代的写入竞态：**freeze 从来没让人停过写**（2026-09-15 实测，2026-09-16 修复）

> **本节 2026-09-16 00:40 重写**。初版（2026-09-15 深夜）把成因写成
> 「`hard-switch` 省去静态冻结 ⇒ 两代并发写」。**那是错的** —— 现场日志显示
> `freeze a lastSeq=0`（旧代**有响应**，没走强切）。真因更基础、也更容易复现：
> **`freeze` 本身不停写**，硬切只是其中最坏的一种情形。
> 错判的代价很具体：如果按初版去修（只改硬切分支），**常规换代每次都仍然会重叠**。

### 8.1 症状

会话日志出现 **seq 回退 + 区间重叠** ⇒ 读取时 `seq gap in committed region` ⇒ 该会话历史打不开。

### 8.2 现场重建（`session-3d8ea18d`，cwd `D:\project_develop\elv`）

按**物理行顺序**从 zstd 里解出来（`out/probe-hsw-race.mjs` 的产物）：

```
#58..#61  seq=623..626  tool/call(tool_apply) → tool/result → step/end → step/start   t=22:30:37.462~
#62..#64  seq=627..629  step/end, turn/end(interrupted), session/end-seed             closers 复用 626 的 t；end-seed t=22:30:45.424
#65..#78  seq=627..912  assistant/chunk…assistant/message…turn/end(completed)          t=22:30:45.503 ~ 47.642
#79..#    seq=630..     下一轮（turn 3）的 agent/inbox/spliced…                        t=22:42:50
```

同时段控制面流水（`~/.dsh/switchboard/state.jsonl`，本地时间）：

```
22:30:37.474  defer: 请活跃代 gen-3086 先收尾本轮 (grace=20000ms)
22:30:37.479  defer done: ok=true agent=true turnInFlight=false waitedTurnEnd=false reason=idle   ← ★ 谎报空闲
22:30:37.489  spawned gen-3087
22:30:39.006  freeze a lastSeq=0                                                                  ← ★ 冻结"成功"，但读数是 0
22:30:39.007  resume-session=session-02a1a38b… (via-gen)                                          ← ★ resume 指向了另一个会话
22:30:39.012  flip to gen-3087
22:30:41.304  retire gen-3087（旧代 gen-3086 的 pid 直到 22:31:11 才退出）
```

⇒ **22:30:37 这次换代是常规路径**（defer + freeze 都"成功"）。重叠发生在旧代还在写、
新代已经开始服务**同一份会话**的窗口里。

### 8.3 机制：`seq` 就是 `log.length`，而"载入一个会话"= 用磁盘前缀重建计数器

`dsh-session` 里：

```js
get seq() { return this.log.length }          // dsh-session/lib/index.js:1406
// 从磁盘载入（resume / 懒加载）→ 用存储事件当种子 → 立刻补一条 end-seed
if (seed !== void 0 && this.log.at(-1)?.type !== 'session/end-seed') this.append('session/end-seed', {})
```

`dsh-session/lib/types/repair.js` 在载入时还会合成"收尾事件"补掉悬空的回合：

```js
let seq = last.seq + 1                        // 从磁盘最后的 seq 往后排
closers.push({ type: 'step/end',  seq: seq++, time })                                  // time = last.time
closers.push({ type: 'turn/end',  seq: seq++, time, data: { turn, reason: { kind: 'interrupted' } } })
```

**关键推论**：旧代的内存计数器**永远领先于已落盘的日志前缀**（它写着但还没 flush）。
因此任何**第二个加载同一会话**的实例（新代懒加载、或同进程内另一个 Session 实例）
都会从旧代**即将要写**的那个 seq 开始排号 ⇒ **不是小概率竞态，是必然重叠**。
现场完全对得上：closers 的 `time` 是 626 的时间戳（正是"复用 last.time"），
`end-seed` 落在 629（磁盘前缀 628 + 1）——而旧代那一轮从 **627** 一路写到 **912**。

### 8.4 于是真正要问的是：**谁让旧代一直有写权？** 四个答案，都在我们自己的代码里

| # | 机制 | 实测事实 | 后果 |
|---|---|---|---|
| 1 | `drain.ts` 的 `evaluateStatic` | 判据是 `armed && lastSeq >= 0` —— **没有任何"停"动作**；注释里那句"在下一次边界不再发起新请求"从未实现 | freeze 恒返回 `static:true`，旧代照写 |
| 2 | `lastSeq`（`computeCaughtUpSeq`） | 依赖 `sessionPersistence.listSessions` + `projectionCache.coldSnapshot`，拿不到就归 0。**171 条 freeze 记录，全部 `lastSeq=0`** | 租约 `freezeSeq=0`、追平门槛形同虚设 |
| 3 | defer 的 `turnInFlight` | 靠 `ctx.on('turn/start'\|'turn/end')`。**204 次 defer，`waitedTurnEnd=true` 出现 0 次**；22:30 那次明确有回合在跑却报 `reason=idle` ⇒ **监听从未触发** | "先请活跃代收尾本轮"从来没生效过 |
| 4 | `retainMs`（默认 30s） | flip 后旧代继续活着，它**正在跑的那一轮**会写到自然结束（实测 flip 后 8.6s 才写完） | 重叠窗口 = 30s（且新代随时可服务该会话） |

补充事实：`resumeId` 的挑法把**前门嗅探**放在最前，而前门嗅探到的是最后一次请求过前门的会话
——那次它指向 `session-02a1a38b`（一个**没在跑**的会话），于是新代 attach 错了人，
真正的活跃会话 `3d8ea18d` 反倒没人管，等浏览器重新连上时被新代懒加载 ⇒ 撞上旧代的写。

### 8.5 修的两侧（2026-09-16）

**A. gen 侧：`freeze` 变成"真的停"（`packages/switchboard/src/drain.ts` 重写）**

- 直读 `agents.list()` 里每个 agent 的**真实阶段**（`agent.phase.kind`），不再听跨插件事件；
- 对**正在跑回合**的 agent 调 `cancel({kind:'hook',reason:'handover/freeze'})`，然后 `whenIdle()` **有界等待**；
- **维护型活动（压缩）等结束、不 cancel**（半途中断可能留下悬空 compaction 标记）；
- 落盘改用官方 **`sessions.flush(session)`**（可 await），逐会话记录失败；
- `lastSeq` = live 会话 `seq-1` 的**最大值**（真实读数），并上报**全部** live 会话 + `primarySessionId`
  （= 开工时**有回合在跑**那个 agent 的会话）；
- 新判据 `quiesced`：**回合全停 + 落盘无失败 + 能看到 agent**。**看不到 agent 时一律 false**
  ——"看不见"不是"没在跑"的证据（这是最容易长出来的假绿）。
- `prepareSwitch` 同样改用真实阶段：现在**真的会**对在跑的回合注入"请收尾"并等它结束。

**B. 控制面侧：交出前门之前必须封口（`coordinator.ts`）**

- `resumeId` 顺序改为 `primarySessionId`（冻结时在跑的那个）→ 前门嗅探 → seq 最大者；
- 新增 `sealPlan(quiesced)`：
  - `quiesced=true` ⇒ 旧代确认停写 ⇒ 保留 30s 优雅退役（**回滚网仍在**）；
  - `quiesced=false`（强切 / drain 超时 / 落盘失败 / 看不到 agent）⇒ **在 `finally` 放锁之前
    强杀旧代并等 PID 消失**。锁期间前门对 WS 升级与非 GET 一律 503 ⇒ 浏览器无法在旧代还活着时
    把同一份会话加载到新代上。杀不干净就**落盘 `unfenced-old-gen.txt` + 大字告警**，绝不静默。
- `waitCatchUp` 支持自定义超时；freeze 后的追平改为 **1.5s 有界观测项**（旧实现拿恒 0 的读数当门槛，
  既是假绿、又会把每次换代拖成 40s）。

**代价与取舍（写清楚，别事后惊讶）**：`quiesced=false` 时旧代被强杀 ⇒ 这一段**没有非破坏回滚**
（`rollbackFlip` 指不回一个已死的代）。这是有意的：回滚丢的是几十秒可用性，
重叠丢的是**该会话的全部历史**（永久、且事后难判）。`quiesced=true` 的常规路径不受影响。

### 8.6 判据：怎么知道它修好了

- 单测/接线门：`node scripts/test-handover-drain.mjs`（36 项，已并入 `check:all`）——
  红方向（卡住的回合 / maintenance / flush 失败 / 看不到 agent 都不许报"已停写"）、
  绿方向（真停住必须报 true）、以及**封口顺序的两方向自证**（去掉强杀、把强杀挪到解锁之后，都必须报红）。
  另含**上游形状断言**：`agent.phase/cancel/whenIdle`、`session.seq===log.length`、
  `sessions.flush` 一旦被上游改掉就报红（否则 drain 会**静默退化**成每次都强杀）。
- 真机验收（**每次换代后**看一眼）：
  1. `state.jsonl` 里该次交接应有 `freeze a lastSeq=<非0> quiesced=true (canSeeAgents=true running=N→cancel=N …)`
     —— 若 `quiesced=false` 或 `canSeeAgents=false`，说明 gen 侧接线没上，**必须查**；
  2. `~/.dsh/switchboard/gen-<最新>/resume.jsonl` 里有 `{"phase":"drain",...}`；
  3. `node scripts/check-session-integrity.mjs --limit 12` 无新增 seq gap；
  4. 换代窗口内**不应**在会话日志里看到"同一 seq 出现两次"或"seq 回退"
     （复扫工具：`node out/probe-hsw-race.mjs <会话目录> …`，只看"回退点数/重复 seq"两节）。

### 8.7 仍未闭合（**别当成已修**）

- **真机换代还没跑过**：本节的修复已构建（`packages/switchboard/lib`）+ 全门通过，
  但**没有在活的 switchboard 上做过一次换代**。"gen 侧接线在真机可用"目前只有三条间接证据
  交叉支持（既有生产证据 `resume.jsonl` 里 `agents:true`、上游形状门、假件单测），
  **不等于**已实测。⇒ 下次空档换代时按 §8.6 的 1–4 逐条看。
- `readCaughtUpSeq`（`computeCaughtUpSeq`）依旧可能返回 0（服务缺失即归零），
  于是 staging 的 ready / 首段追平门槛仍然是**惰性的**。它不在这条损坏路上（已加有界观测），
  但要修就得先搞清 `sessionPersistence.listSessions` / `coldSnapshot.asOfSeq` 为什么拿不到。
- **回滚路径的重叠风险**：`quiesced=false` 时若 flip 后 verify 失败并回滚，
  旧代（未停写）与新代（已经被 flip 服务过一小会儿）仍可能碰同一个会话。
  窗口小得多，但没有被消除。
- **`session-3d8ea18d` 本身的 seq gap 仍在**（截断会丢 59%）。见 `topics/current-status.md`。
