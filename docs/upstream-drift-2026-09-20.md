# 上游漂移体检（2026-09-20）

> 触发：用户机器维修停摆几天，"唯一可能有异动的是上游"⇒ 查上游动没动、对我们有没有影响。
> 复检命令：`node scripts/check-upstream-drift.mjs [版本]`（手动跑，需要网络；**不在** `check:all` 里）。

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 本地装的 | `@deepseek-ai/dsh 0.1.1-rc.2`（`node_modules/` 与 `~/.dsh/profiles/node_modules/` 两棵树**一致**，无本地漂移） |
| registry latest | **0.1.5-rc.2**（2026-09-10 发布）；alpha 通道 **0.1.6-alpha.2**（09-17） |
| 为什么没自动跳 | 根 `package.json` 写的是 `^0.1.1-rc.2`；npm 的 caret 对**预发布**只匹配同一个 `[major.minor.patch]` 的预发布 ⇒ 永远是 `0.1.1-rc.x`。要跳必须**显式**改。 |
| 要不要升 | **不需要**（沿用「不追上游」的既定口径）。但体检结果里有一条**值得单独关注**（§2）。 |
| 竞态是否已被上游修掉 | **没有。** 根机制三条原样都在（§3）⇒ 我们 09-16 的修法仍然是对的那一个。 |

## 1. A 组：我们依赖的上游形状 —— 6/6 命中（升级不会打破我们的机制）

`scripts/check-upstream-drift.mjs` 的 A 组，逐条对 0.1.5-rc.2 验过：

- `agents.list()` 仍返回**活的 agent 本体**（`drain.ts` 枚举在跑的 agent 靠它）
- `agent.phase.kind` 仍在（"有没有活在跑"的唯一可靠判据）
- `agent.cancel(cause, options)` / `async whenIdle()` 仍在（停回合 + 等它真停）
- ★ `session.seq` **仍由 `log.length` 派生**，但**写法变了**：
  `get seq() { return SessionLogOffset(this.log.length) }` —— 包了一层名牌类型（nominal typing）。
  ⇒ **语义没变、写法变了**。这当场把 `test-handover-drain.mjs` 里那条字面量正则打成了**假红**；
  已改成语义判据（`/get seq\(\)\s*\{\s*return [^;{]*log\.length[^;]*;\s*\}/`），两代写法都命中。
- `sessions.flush(session)` 仍是可 await 的落盘入口

## 2. ★ 唯一值得单独关注的变化：persistence 拿到了「单写者所有权」

`dsh-session-persistence` 在 0.1.5 从"只有一个 `abstract create(header)`"升级成了**句柄 + 所有权**模型：

```ts
abstract create(header, options?): Promise<SessionHandle>   // 建会话并**取得写所有权**
abstract open(id, access: 'read' | 'write', options?): Promise<SessionHandle>
   //  "`write` atomically claims single-writer ownership; an existing active owner rejects"
abstract flush(): Promise<void>   // 一次 durability barrier：本实例所有写句柄一起落盘（可 await）
abstract stat(id) / list()        // 不读日志、不取所有权的观测
```

错误面也明确了：`SessionAlreadyOwnedError`、`SessionOwnershipLostError`、`SessionHandleClosedError`、`SessionReadOnlyError`。

**这正是我们 09-15 事故里缺的那一块**：当时两代能同时追加同一份会话，是因为"谁能写"只存在于**我们自己的协议**里
（`freezeSeq` / `writerToken`，而且实测全是空转）；存储层本身没有任何栅栏。现在上游把栅栏放进了存储层。

两点含义（都不要夸大）：

1. 我们自己的 `freeze` + `sealPlan` 是把"两个写者"变成"**不会同时写**"（靠停写 + 强杀 + 前门锁）；
   上游这条是让"两个写者"**不可能存在**（第二个 `open(write)` 直接抛 `SessionAlreadyOwnedError`）。
   两者是**不同层次**的保险 —— 叠加才完整；但**我们不升级就拿不到它**。
2. 升级时 `drain.ts` 的落盘用法要重写：现在调的是 `dsh-session` 的 `sessions.flush(session)`，
   新的 persistence 有**服务级** `flush()`（一次刷掉本实例所有写句柄）。这是升级的第一处适配点。

## 3. 竞态的根机制**没有**变（所以我们的修法仍然是对的）

在 0.1.5-rc.2 里逐条确认仍在：

- `get seq()` 仍 = `log.length`（见 §1）
- `dsh-session/lib/types/repair.js` 仍用 `let seq = last.seq + 1`、`time = last.time` 合成 `step/end` / `turn/end(interrupted)`
- 构造函数仍会补 `session/end-seed`（新增了 `isSeeded` 分支，但那只是把"继承式种子"与普通种子区分开）

⇒ 「旧代的内存计数器恒领先于磁盘前缀，任何第二个加载同一会话的实例都从它即将写的位置排号 ⇒ 必然重叠」
这条推理**依然成立**，上游没有动它。

## 4. B 组：我们打过的补丁 —— 靶子都还在（升级后仍能打）

| 补丁 | 0.1.5 里靶子在？ | 上游已自行修好？ | 结论 |
|---|---|---|---|
| U1 web-app 公开 URL（救 prompt 前缀缓存） | 在（`function localWebUrl(ctx) {` + `const port = ctx.get("webServer")?.port;` 逐字相同） | **没有**（仍不认 `DSH_PUBLIC_WEB_URL`） | 补丁仍必要 |
| U3 agent-loop `isOwned` 不保护 `message.source` | 在（仍是 `message.source.kind` 裸读） | **没有** | 补丁仍必要 |
| BOM app-boot 裸 `JSON.parse(readFileSync(` | 在，**4 处**（旧版 3 处） | **没有** | 补丁仍必要，且升级要**按处数重新定位**（上游把 boot 拆过文件，见 `docs/upstream-defects.md`） |

好消息：我们的锚点应用器是**严格模式**（`patch-anchors.mjs`：两态都不在 ⇒ `postinstall` 非 0 退出）
⇒ "上游一变补丁静默失效"这条老坑已经被堵住；本脚本的价值是**升级前**先看会不会喊。

> 体检脚本自己踩过一个坑并已修：第一版把"文件不存在"当 skip 不算红，又没给 tarball 去掉 `package/` 前缀，
> 于是解出空目录还打印"所有断言仍成立" —— 一次**自家假绿**。现在：下载 <1KB 直接抛错、`--strip-components=1`、
> 文件不存在**必须算 red**。

## 5. C 组：上游新增的能力（对架构决策有用的部分）

`dsh@0.1.5-rc.2` 比 0.1.1-rc.2 多 10 个依赖（无删除，其余全是版本串上调）：

| 新模块 | 它是什么 | 对我们可能的用处 |
|---|---|---|
| `dsh-acp-app` / `dsh-sdk-app` / `dsh-sdk-minimal` | ACP / SDK profile bundle：**把 dsh 当子进程用 JSON-RPC(stdio) 驱动**，含进程生命周期 | ★ 「Agent 与子 Agent 拆成两个服务」的**现成通信底座**（另见 registry 上的 `dsh-sdk-protocol` / `dsh-sdk-client`） |
| `dsh-webhook` / `dsh-webhook-github` | 外部事件 → 创建 Workspace 会话的规则运行时 | 让"外面"能触发脑工作（跨服务编排的另一种入口） |
| `dsh-http-proxy` | 进程级出站 HTTP 代理策略（从启动环境解析） | 与我们的 key-pool-proxy 同层，可参照 |
| `dsh-hooks-codex` / `dsh-hooks-claude-code` | 在 dsh 的拦截缝上跑 Codex / Claude Code 的 hooks.json | 外部工具链桥接 |
| `dsh-tool-present` | 显式的"交付物"声明工具 | 无关紧要 |

另外在 registry 上（未进 `dsh` 的直接依赖）：`dsh-subagent-codex`、`dsh-subagent-claude-code`
（**一次性外部子代理** provider：走 Codex app-server / Claude Agent SDK）、`dsh-tool-subagent-control`
（全局命名的 `send_message` / `interrupt_agent` / `list_agents`）、`dsh-subagent`（`ctx.subagents` 命名 provider 注册表）。

⇒ 值得注意：**子代理后端目前全是 in-process**（`dsh-subagent-in-process-driver` / `-spawn-in-process` / `-fork-in-process`），
外部 provider 是**一次性**的（起一个 CLI 干完就退）。**"长驻、能在主脑挂了以后继续跑、还能反向代持主脑"的子代理服务，上游没有** ——
那是我们要自己造的东西（见 `docs/two-service-custody-review.md`）。

## 6. 建议动作

1. **不升级**（沿用既定口径）。把本文件当"下次要升时的第一张清单"。
2. 若将来要升：先 `node scripts/check-upstream-drift.mjs 0.1.5-rc.2`（A/B 两组有一红就别动手），再按 §2/§4 逐条适配。
3. 若只想**取一条对我们有利的**：只需 `dsh-session-persistence`（§2 的单写者所有权）——它让"两代并发写同一会话"
   从"我们保证不发生"升级为"存储层不允许发生"。但要先解决它与 `drain.ts` 的落盘用法差异。
4. 想走"两服务代持"路线时，先读 `docs/two-service-custody-review.md` 的口径（尤其是**判据层不能互相代持**那一条）。
