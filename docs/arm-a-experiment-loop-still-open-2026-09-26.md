# 臂A 自实验链路的第三个卡点：⑦ 假红（2026-09-26 第三棒核验）

> **本文件是【我（WorkBuddy 主控）的独立核验】**，不是 DSH 的自述。
> 目标（用户口径）：**让现役 DSH 自己（经 `:31800` 管理面）去发一道实验题给 A**。
> 结论先行：**链路仍未闭合**，但**卡点已从 ⑥ 收敛到 ⑦**，且 **⑦ 经单因素消融证明是【假红】**。

---

## §1 本次实际动作与读数

```
GET http://127.0.0.1:31800/?cmd=mgmt&action=experiment&task=t1-guard&arm=A
→ 200 {"ok":true,"cmd":"mgmt","action":"experiment","stage":"started","runId":"t1-guard-1790411194926"}   (0.0s)
GET …&action=result&runId=t1-guard-1790411194926
→ 91.7s 后 {"stage":"done","code":1,"ok":false}
```

台账 `evals/runs/_mgmt/t1-guard-1790411194926.json` 的 `stderr`：

```
[失败] 起一代没过自检 ⇒ 不敢发题
  ✅ ⑤ 自进化两席已注册 — evo-dev + evo-review
  ✅ ⑥ 池端口在本段内 — 期望 33101
  ❌ ⑦ 现役仍健康 — ★ 探不通（通道不可用）—— 不等于现役坏了；先别下结论（见 rpc 的超时/重试）
```

⇒ ★ **它连"发题"那一步都没走到**（`run-experiment.mjs` 在①自检失败时**正确地拒绝发题**）。
第二次（`…1790411476806`）**完全复现**：⑤✅ ⑥✅ ⑦❌。

---

## §2 ★★★ 决定性证据：⑦ 是假红（单因素消融）

**判据**（`scripts/arm-up.mjs:552-558`）：
```js
const live = await rpc('http://127.0.0.1:3080', 'session.list')   // 5 tries × 20s + 2s gap
liveOk: live.http === 200 && live.ok, liveKind: live.kind ?? null
```

**自变量只有一个：arm-up 是被谁拉起的。** 其余（机器/探针/代码/臂A状态）全同。

| 路径 | 拉起者 | ⑦ | 全表 |
|---|---|---|---|
| **出带** `node scripts/arm-up.mjs A` | 我的 shell | **✅ 前门 200** | **7/7 全过，exit 0** |
| **入带** 经 `:31800` `action=experiment` | **现役控制面 `spawnSync`** | **❌ 探不通** | ⑤✅⑥✅⑦❌ |

出带那次逐条读数（16:29）：
```
✅ ① 端口段不撞现役 — base=33080 pool=33101
✅ ② 前门应答 — HTTP 200
✅ ③ 控制面应答 — HTTP 200
✅ ④ 隔离层 apply 且 deny ≥ 1 — apply=true denyRoots=2
✅ ⑤ 自进化两席已注册 — evo-dev + evo-review
✅ ⑥ 池端口在本段内 — 期望 33101
✅ ⑦ 现役仍健康 — 前门 200
===== ✅ 起来了（自检全过） =====
```

### §2.1 机制：`spawnSync` 阻塞事件循环 ⇒ 探针被拖死（并发实测）

一边以 0.2s 间隔持续打 `:3080 session.list`，一边经 `:31800` 发**非 dry** 的 `experiment`：

```
n = 90    ok = 83    err = 7（全部 "timed out"）
p50 = 0.52s    p95 = 0.66s    ★ max = 8.23s
```

- `mgmt.ts:159`：`spawnSync(argv[0], argv.slice(1), { …, timeout: 900_000 })` —— **同步**。
- 它在控制面的事件循环里跑 ⇒ 期间控制面的代理转发**被拖住**（实测 8s+ 卡顿窗口）。
- arm-up 的探针（5×20s）若落进这个窗口 ⇒ 5 次全 `http:0` ⇒ `kind='unreachable'` ⇒ ⑦ ❌。
- **旁证**：我自己的轮询器在同一时段连续 3 次 `timed out`（≈90s）—— 同一机制、不同观察者。

### §2.2 ★★ 教训：文案诚实地写了"不确定"，判据却没把不确定当不确定

`arm-up.mjs:208-210` 的 `detail` 写得非常清醒：

> `★ 探不通（通道不可用）—— 不等于现役坏了；先别下结论（见 rpc 的超时/重试）`

**但** `ok` 仍取 `liveOk === true` ⇒ ⑦ **红**。于是：

```
[失败] 起一代没过自检 ⇒ 不敢发题
```

⇒ **整条链路被一个"通道抖动"掐死**。这是**铁律 14**（通道"不可用" ≠ 读数"为 0"）
的一次**当场实证**：作者知道要区分，`kind` 也分出来了，**但没让 `kind` 参与裁决**。

**修法方向（未实施，待批）**：⑦ 的 `ok` 应三分 ——
`ok=true`（200）/ **`unknown`（`unreachable` ⇒ 不判红、显式记 `unknown` 并继续）** / `ok=false`（探得通但答错）。
★ 关键：**`unknown` 不能算"通过"**（那是假绿），而应当**升级为一次带重试的复探**，
并在**最终仍 unknown 时**把这一步标成"未能判定"而不是"失败"（此时"不敢发题"是**过度保守**，
因为它把一个**与被检对象无关的通道问题**当成了**被检对象的错**）。

---

## §3 ★★ 新发现：现役控制面【自己】也在被 `EADDRINUSE` 打死

`out/switchboard-run.err.log`（**这是现役的日志**；行序 = 一等证据，铁律 32）：

```
L22  [switchboard] stale lease detected: gen=gen-3082 port=3082 pid=14424 is dead — clearing lease
L23  [switchboard] uncaughtException: listen EADDRINUSE: address already in use 127.0.0.1:3080
L24  [switchboard] uncaughtException: listen EADDRINUSE: address already in use 127.0.0.1:31800
...
L96  [switchboard] stale lease detected: gen=gen-33082 port=33082 pid=19172 is dead — clearing lease
L97  [switchboard] uncaughtException: listen EADDRINUSE: address already in use 127.0.0.1:33080
L98  [switchboard] uncaughtException: listen EADDRINUSE: address already in use 127.0.0.1:33180
L179 [switchboard] uncaughtException: listen EADDRINUSE: address already in use 127.0.0.1:3080
L180 [switchboard] uncaughtException: listen EADDRINUSE: address already in use 127.0.0.1:31800
```

⇒ ★★ **"旧代谁来停"不只打臂A，也打现役自己**：换代时**新控制面起不来**（3080/31800 被旧代占死），
现役启动序列在日志里重复 10+ 次、`generation` 已到 **15**。
⇒ 这把那条"未闭合"的**严重级别从「臂卡住」抬到「现役也在反复自杀重建」**。
⇒ 与 §2 的 `spawnSync` 阻塞**同源**（都是"控制面自己不干净地让位"）。

---

## §4 复用台账：今天经管理面发的 5 次（+我发的 2 次）

| runId | 时间 | 红在哪 | 签名 |
|---|---|---|---|
| `…1790407820208` | 15:35 | ⑦ | ★ 现役受影响（这绝不该发生） |
| `…1790408307494` | 15:48 | ① | `DSH_HOME` 泄漏（`isolated-instance` **正确拒跑**） |
| `…1790408685226` | 15:52 | ⑥+⑦ | `DSH_HOME` 泄漏 |
| `…1790408915386` | 15:53 | ⑥+⑦ | 池端口不在本段内 |
| `…1790409352801` | 15:57 | ⑥+⑦ | 池端口不在本段内 |
| **`…1790411194926`** | **16:26（我）** | **仅 ⑦** | ★ 探不通（通道不可用） |
| **`…1790411476806`** | **16:31（我）** | **仅 ⑦** | ★ 探不通（通道不可用） |

★ **⑥ 已修**（我 16:20 重起臂A后池端口就位，出带/入带都 ✅）；
★ **剩下的唯一卡点 = ⑦**。

### §4.1 `DSH_HOME` 泄漏那条修复【只在源码里，没进 bundle】

- `packages/switchboard/src/mgmt.ts`（mtime **16:04**）已含 `childEnv()` + `ARM_IDENTITY_ENV_KEYS`。
- 但 `packages/switchboard/out/*/main.js` **逐个 grep `childEnv` / `ARM_IDENTITY` = 0 命中**。
- 现役控制面 pid 6816 跑的是 `out/b1790403532379/main.js`（**14:19 起**）⇒ **不含该修复**。
- ⇒ 15:48/15:52 那次 `DSH_HOME` 泄漏**被修复解释**；但
  **修好的代码没有被构建进任何在跑的 bundle** ⇒ 这是一个**"修了但没部署"的独立缺陷**。

---

## §5 更正我自己的一条旧读数（诚实清单）

我在第二棒写过"`out/switchboard-run.log` 里混进了臂A的行（`self=A`）"。
**这条在当时是对的（历史事实），但现在已不成立**：

`scripts/relaunch-switchboard.mjs:89`
```js
const logDir = isLiveHome ? path.join(root, 'out') : path.join(process.env.DSH_HOME, 'logs')
```
⇒ 臂A的日志现在写在 `D:\project_develop\_arms\a\dshhome\logs\`（我实测确认）。
`out/switchboard-run.log` 里那些 `self=A` 行是**该修复之前**写下的**历史段**。

★ **规则**：引用"日志混杂"这类缺陷前，**先看修没修**（读代码 + 看新产物落在哪），
否则会把**已修的历史**当成**现存的缺陷**报上去。

---

## §6 已验证的环境事实（16:24–16:35）

```
现役：5560(控制面 bin) → 6816(out/b1790403532379, 听 3080 + 31800) → 22512(gen-3082, 听 3082 + 3101)
臂A：21312(控制面 bin, 16:20 由计划任务拉起) → 1252(out/b1790409854487, 听 33080 + 33180)
                                             7284(gen-33082, 听 33082 + 33101 + 33191)
```
- 两棵树**完全不相交**（逐 pid 核过）。
- 臂A 前门 `:33080` session.list ⇒ **9 会话**；管理面 `brief` ⇒ `ok=true code=0`。
- 现役 `:3080` session.list ⇒ **370 会话**（0.7s）；`:31800 ?cmd=status` ⇒ 0.0s 应答。
- 臂A `lease.json`：`gen-33082 pid=9224 generation=9`（**死 pid**，`ensureActiveLease` 复活的指纹）；
  控制面 `?cmd=status`：`gen-33082 pid=7284 generation=1` ⇒ **两者依然不一致**（旧缺陷仍在）。

---

## §7 诚实清单（本棒未做的事）

1. **⑦ 假红的修复【未实施】**（我只做了证明 + 给出修法方向）。本棒**没改任何源码**。
2. **`ensureActiveLease` 复活死 pid 未修**（第二棒已证明，`docs/stale-lease-resurrected-by-ensureActiveLease-2026-09-26.md` §4 给了 A/B 两个方案，我倾向 B）。
3. **`childEnv()` 修复【未构建】** ⇒ 现役控制面仍在跑不含该修复的 bundle。
4. **现役控制面的 `EADDRINUSE` 自杀未修**（§3）。
5. **"旧代谁来停"仍无机制**（我的主张：**修在控制面里**，别让 `arm-up` 去杀别的东西）。
6. **实验从未真正被派给臂A** ⇒ `action=experiment` 的**后半段（真发题 + 判卷）在本棒仍是未验证代码**。
   ★ 用一句可判的话说：**这条链路的"后半段有没有错"我现在回答不了 —— 不是"它对了"，是"我还没看到它跑"。**
