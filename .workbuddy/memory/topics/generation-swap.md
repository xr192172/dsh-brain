# 换代 vs 重启（代际替换）

> 上级索引：`../MEMORY.md` ｜ 相关：`profile-and-gen-integrity.md`、`self-evolution-design.md`
> 完整文档：`docs/handover-vs-restart.md`

## 核心命题

> **换代 = 重启 + 三道保险，不是替代方案。**
> 问题永远是「**这次改动需不需要保险**」。

| 维度 | 重启 switchboard | 换代（蓝绿） |
|---|---|---|
| 进行中的 turn | **被杀死**（前门就是 switchboard 进程；gen 非 detached） | **等它收尾**（`coordinator.ts:167-176` defer / `prepareSwitch`） |
| 失败退路 | **无**（起不来 = 彻底没服务） | **`rollbackFlip`**（`:482`）旧代无损继续 |
| 流量前校验 | 无 | probe（`:292`）+ verify gate（`:319`）+ 稳定期探测（`:332`）+ 启动健康检查 |
| 停机窗口 | 有（秒级） | 无（flip 原子换向，verify 通过后才 retire） |

## 触发口径

换代**只有** `main.ts:123` 的 admin HTTP 命令（`cmd === 'handover' || cmd === 'apply' || cmd === 'restart'`）
—— **无 watcher、无自动检测**。`scripts/evolve.mjs` 是唯一自动化门面
（`?cmd=apply&kernel=<out>` 是判据阶梯的执行器）。

```bash
curl "http://127.0.0.1:31800/?cmd=handover"        # 非阻塞，立即返回 stage=started
curl "http://127.0.0.1:31800/?cmd=restart"         # fast 换代（见下）
curl "http://127.0.0.1:31800/?cmd=status"          # stage + lastHandoverResult
curl "http://127.0.0.1:31800/?cmd=result"          # 最近一次结果
curl "http://127.0.0.1:31800/?cmd=flow"            # state.jsonl 阶段流水
curl "http://127.0.0.1:31800/?cmd=panel"           # 只读 HTML dashboard
```

流水：`ready(defer grace) → spawn → freeze → promote(resume-session) → flip → verify → retire`。
**坑**：`?cmd=status` 里也含 lease 自己的 `stage` 字段，写轮询正则时别误匹配。

## 三级替换策略

判据只有一句：**这次改动坏了，会不会被立刻发现？**

| 档 | 适用 | 手段 | 中断 | 回滚 |
|---|---|---|---|---|
| **L1** | 反复调 UI / client bundle | `pnpm run dev:web` + `client-hmr`（已常驻） | 无 | — |
| **L2** | **日常插件业务代码改动** | `?cmd=restart`（fast 换代） | 有（秒级） | ✅ |
| **L3** | **内核机制 / 插件树组合 / profile 配置 / 判据自身** | `?cmd=handover` / `scripts/evolve.mjs` | 无 | ✅ |

## `?cmd=restart`（fast 换代，2026-09-14 加）

**跳过三样耗时的**：
① defer（`SWITCH_DEFER_MS` 默认 **20s**，换代最贵的一环，等当前轮收尾）
② verify-gate（实验脑白名单脚本）
③ flip 后稳定观察窗（`SWITCH_VERIFY_STABLE_MS` 默认 2s）

**保留三样几乎不花时间、却决定成败的**：
probe + **启动健康检查** + **`rollbackFlip`**（旧代尚在，**回滚是免费的**，没有理由关掉）

`fast` ≠ 重启：它是"快速换代"，仍可回滚。
落点：`coordinator.ts handover()` 第 5 参数 `fast` / `main.ts`（`cmd === 'restart'` 或 `&fast=1`）。
`state.jsonl` 会记 `fast 模式：...` 与 `已快速切换 → gen-xxxx`，可审计。

## host 侧没有热更新（事实核查）

- `@deepseek-ai/cordis-plugin-hmr`（chokidar + picomatch，`root:['.']`）**被 `dsh-web-app/cordis.patch.yml:21-23`
  置 `disabled: true`**，上游注释：
  「TODO: Re-enable shared HMR for Web after its reload lifecycle is tested.」
- 常驻的 `client-hmr` 只管**浏览器侧 client bundle**，且 idle until `pnpm run dev:web`。
- ⇒ **改 host 侧代码的最小路径仍是重启/换代。**

## 为什么"换代感觉没用"是错的（2026-09-14 定案）

2026-09-13/14 修掉的**三个 P0 全部是换代引入或暴露的**：
端口击穿 / 插件树部分加载失败 / BOM 崩 gen。

⇒ "换代不好用"的体感来自「**保险没装好**」，不是"换代没价值"。
**频率低不是无用，是发现能力不足** —— 也正因如此，它服务的恰好是最危险的改动，**不能删**。
不删的理由：① 删安全网只把"可回滚"换成"不可回滚"；② 边际成本≈0（已建好、opt-in）；
③ 删了 `evolve.mjs` 的自进化闭环就断了；④ 它服务的恰是最危险的改动。

## ★ 换代有副作用：它会主动"接手"用户会话（2026-09-14 实测）

**换代不只是换代码，它会改变用户会话的状态。** 一次换代注入**两条**提示并真的驱动一轮 LLM 执行：

| 来源 | 文案要点 |
|---|---|
| `coordinator.ts` `reissuePrompt`（flip+verify 后） | 「交接完成（代际切换已成功）。请直接继续你刚才正在进行的任务…」 |
| `index.ts:320` `scheduleResume`（**新代 promote 时**） | 「【自动续跑】…请在**无需用户再次确认**的前提下…**视为用户已预先批准，不要再停下来征询用户或等待确认。**」 |

触发条件（`src/index.ts:307-325`）：`patch.resumeOnPromote !== false && req.resumeSessionId` → **默认开启**。
控制面侧 `SWITCH_REISSUE_MS` **默认 800ms**（`main.ts:228`）→ **也是默认开启**。

**两个问题**：
1. **重复注入**（一次换代两条 prompt），且第二条含"视为用户已预先批准" ——
   **换代不应替用户预先批准任何事**（与"人批不得降级为事后知情"冲突）。
2. **★ 卡死路径**：若被接手的 turn 停在 `ask_user_question`（等人类输入），`turn/end` **永不到来** →
   `prepareSwitch(deferMs)` 只能靠 grace 超时兜底 → 照样 flip →
   **再换代时 resume 到新代失败（`ok:false, code:internal`）→ 会话变成未 attach
   （`host.describe` → `attachedSessions: 0`）**。
   **注意：这不是 fast 模式独有** —— 正常 handover 也会中招，fast 只是把它提前 20 秒。

**建议修法 —— ✅ 已实施（2026-09-14，build `b1789323453051`）**

**保留两层、职责分离**（原建议是"只留一层"，但 `scheduleResume` **不只是注入** ——
它同时做 attach（`agents.resume`），删掉会让后续 reissue `session-not-found`）：

| 层 | 改动 |
|---|---|
| **gen 侧 `promote`** | `scheduleResume(..., [], ...)` —— **只 attach，不注入文本** |
| **gen 侧 `prepareSwitch`** | 加 `turn/start` 监听 + **空闲短路**：无未收尾回合时**不注入 steer、不等 grace**，立即返回 `reason:'idle'` |
| **协议** | `PrepareReply.turnInFlight` = **"调用时有没有活"**（区别于 `waitedForTurnEnd` = **"活干完没"**） |
| **coordinator** | `resumeInject = (prep.waitedForTurnEnd === true)`；否则记录跳过原因；**fast 一律不注入** |
| **coordinator** | reissue 响应截断 `120 → 800` + 非 200 打 stderr（原先内部错误被砍成 `"code":"internal"` 就没了） |

**注入判据（最终）：`waitedForTurnEnd === true`，即"确有活、且已干净收尾"。**
有活且正常收尾 ✅ 注入｜空闲 ❌｜grace 超时（常见于卡在 `ask_user_question`）❌｜fast ❌。

**顺带收益**：正常 handover 在**空闲会话**上不再白等 20s（空闲会话永远等不到 `turn/end`）
⇒ "20s 等待"实际只在真有活时才发生。

**⚠️ 生效条件**：coordinator 改动在 switchboard 进程里 → **需重启 switchboard**；
gen 侧改动随下次换代 spawn 的新 gen 生效。

## 层级与换代需求的对应（新架构下的推论）

**换代唯一不可替代的位置 = 持有连续会话的那一层**（如"单前脑"架构的顶层脑）。
理由：不能重启（打断对话）／不能"下次任务生效"（它一直活在同一个会话里）／
失败最难发现（做判断与路由，坏了表现为"一切正常但一直在做错事"）。

**任务级上下文隔离的层（子代理 / 委派执行者）不需要换代** ——
「下一次委派」天然就是蓝绿（in-flight 委派已绑定旧 provider，新委派走新注册表）。
详见 `self-evolution-design.md`。
### ★★★ 新 seq gap 的真因：**freeze 从来没让人停过写**（2026-09-16 更正；初版误判为 hard-switch）

> **更正**：本节初版（09-15 深夜）写成「hard-switch 省去静态冻结 ⇒ 两代并发写」。**错了**。
> 现场 `state.jsonl` 是 `freeze a lastSeq=0`（旧代有响应），且历史上**只有 1 次** hard-switch（09-14 08:28:48）。
> 真因更基础：`freeze` **本身不停写**；硬切只是其中最坏的一种情形。
> **完整记录（现场重建 / 机制 / 修法 / 验收清单）→ `docs/handover-vs-restart.md` §8（已重写）。**

#### 机制一句话

`dsh-session` 的 `seq` **就是 `log.length`**；从磁盘载入会话时用**存储事件当种子**
（`repair.js` 合成 closers：`let seq = last.seq+1`、`time = last.time`；构造函数再补 `session/end-seed`）。
旧代的内存计数器**恒领先于磁盘前缀**（写而未 flush）⇒ **任何第二个加载同一会话的实例都从旧代即将写的位置排号**
⇒ **必然重叠**。所以只要"旧代还在写 + 新代已能服务同一会话"，就一定会坏，跟 fast/handover 无关。

#### 四个"让旧代一直有写权"的机制（全部实测无效）

| 机制 | 实测 |
|---|---|
| `drain.evaluateStatic` | 判据 `armed && lastSeq>=0`，**无任何"停"动作** |
| `computeCaughtUpSeq`（喂 freeze 的 lastSeq） | **171 条 freeze，全部 `lastSeq=0`** |
| defer 的 `turnInFlight`（`ctx.on('turn/start')`） | **204 次 defer，`waitedTurnEnd=true` 出现 0 次** ⇒ 监听从未触发 |
| `retainMs=30s` | flip 后旧代继续写到本轮结束（实测 +8.6s） |

#### 已修（2026-09-16，**待真机验收**）

- gen 侧 `freeze` = 真停：`agent.phase.kind` → `cancel({kind:'hook'})` → 有界 `whenIdle()` →
  官方 `sessions.flush()` → 真 `lastSeq` + 全量 live 会话 + `primarySessionId`；新判据 **`quiesced`**
  （**看不到 agent 一律 false**）。
- 控制面 `sealPlan`：`quiesced=false` ⇒ **在释放前门锁之前强杀旧代并等 PID 消失**（前门锁期间 WS/非 GET 一律 503）。
  ⇒ 操作纪律随之更新：**不再需要靠"用 handover 不用 restart"来避险** —— 危险路径现在自己封口了，
  但**仍然**建议在空闲时换代（强杀旧代 = 放弃这一段回滚网，且会打断在跑的回合）。
- `prepareSwitch` 改用真实阶段 ⇒ defer 从"从未生效"变成真会等在跑的回合（grace 超时=卡在等人类输入时仍不注入续跑）。
- 门：`scripts/test-handover-drain.mjs`（36 项，含封口顺序两方向自证 + 上游形状断言），并入 `check:all`。

#### 仍开放

- **真机换代未跑**：按 `docs/handover-vs-restart.md` §8.7 的 1–4 条验收。
- `readCaughtUpSeq` 的 ready/追平门槛仍惰性（不在这条损坏路上）。
- 回滚路径的重叠窗口仍在。
- `session-3d8ea18d` 的 seq gap 仍在（截断丢 59%）。
