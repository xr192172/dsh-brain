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
| **插件树部分加载失败** → 工具少 25 个、Code Mode 静默回落 native、模型要靠试探发现环境 | 换代把会话**搬到坏实例** | 已修（单一来源化 + verify 启动健康检查） |
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
| **L3 换代** | **内核机制 / 插件树组合 / profile 配置 / 判据自身**的改动 | `?cmd=handover` 或 `scripts/evolve.mjs` | 无 | ✅ `rollbackFlip` | probe + 启动健康检查 + verify 闸 |

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
