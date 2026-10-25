# NOTES.md —— dsh 前门实测结论与 bridge 对接方式

> 勘察日期：2026-10-25。证据均来自本仓库代码（标注文件:行号），未跑通真实 dsh 实例的部分如实标注「未实测」。

## 1. dsh 前门实际接口（勘察结论）

### 1.1 端口分工（代码证据）

| 端口 | 角色 | 证据 |
|---|---|---|
| `:3080` | **前门**（主端，switchboard 代理到活跃 gen） | `packages/switchboard-mcp/server.mjs` 注释「`:31800` 是控制面，`:3080` 是前门（不要混）」；`docs/gen-port-prefix-invalidation.md` |
| `:31800` | **控制面**（`?cmd=` 动作） | `scripts/eval-run.mjs:1424`（`?cmd=status`）、`:1444`（`?cmd=handover&profile=...`） |

### 1.2 RPC 输入（★ 已被生产脚本实测，eval-run 每次实验都在用）

`POST {front}/api/{method}`，body：

```json
{ "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": {...} }
```

证据：`scripts/eval-run.mjs:85-97`（rpc 封装）。

已验证的方法（eval-run 实际调用）：

| method | payload | 响应 |
|---|---|---|
| `session.list` | `{}` | `result.value.items[]`，元素含 `sessionId` / `running` / `cwd` / `agentPreset` / `projections.values.sessionStats` / `projections.values.tokenUsage`（eval-run.mjs:99-117） |
| `session.prompt` | `{sessionId, mode:'steer', content:[{type:'text', text}]}` | HTTP 200 = 受理（eval-run.mjs:747-752） |
| `session.models` / `session.selectModel` / `agentPreset.select` | 见 eval-run | — |

包内另见（dsh-api-session-controller types）：`session.attachment` / `session.cancel` / `session.rename` / `session.updateQueue`。

### 1.3 事件输出（两条路）

1. **磁盘 journal（★ 已实测，eval-run 轨迹分析在用）**：
   - 路径：`C:/Users/Admin/.dsh/sessions/<profile>/<sessionId>/session.jsonl.zstd`（eval-run.mjs:438-443）
   - 解压：`fzstd`（dsh-brain 已有依赖），逐行 JSON。
   - 记录形状（eval-run.mjs:176-260 实测口径）：`{ seq, time, type, data }`；
     类型有 `tool/call`(data.name/arguments)、`tool/result`(data.callId/data.message.content[].isError)、
     `turn/end`(data.reason/data.turn)、`request/header`、`request/context`、`compaction/*`、
     `tool/code-dispatch`、`agent/inbox/spliced`、`agent-preset/selected`。
   - **未实测**：助手文本消息的确切 type（eval-run 不读它）。bridge 对 `message/*` 前缀的记录按
     `data.message.content[].text` 提取后转 `event.message`，属启发式，真实冒烟时须校准。
2. **SSE `/stream`（未实测）**：web UI 有 `EventSource('/stream')` 引用
   （`dsh-client-ui-sidebar-documentpreview/lib/client.excel.js:8787` 注释），服务端形状未勘察到，本轮不依赖。

### 1.4 dsh CLI（bin=dsh）

`@deepseek-ai/dsh` 的 bin 命令：`web` / `plugin` / `profile` / `desktop` / `user` / `wx` / `dump-config`（lib/bin.js 实测字符串）。
`dsh web` 起的即前门 web 实例；本 bridge **不起新通道**，全部走上面的 HTTP 面。

## 2. Hub 侧协议（已实测闭环，直接复用）

- WS `ws://127.0.0.1:15813/ws`（★ 实测 `server.ts` 默认端口是 **15816**，非 15813；`HUB_PORT` 可覆盖）。
- `session.hello{role,id,client_name,...}` → `session.welcome{client_id}`。
- envelope：`{protocol:'2.0', id, correlation_id?, type, from:{role,id?}, to:{role,id?,broadcast?}, timestamp, payload}`。
- `command.input{text, turn_id?, session_id?}` hub→脑；`event.*` 脑→hub；`permission.request/response` 透传（spike 已验证 correlation_id 单播回路）。
- 寻址是动态 role 表（`elv/dsh-hub/src/router.ts:20-22,54-56`），路由面任意 role 可达；
  **但握手有 role 白名单**（★ 实测：`hub.ts` DEFAULT_CONFIG.allowedRoles =
  `['ui','brain','left','right','sandbox']`，非白名单 role 在 hello 时吃
  `system.error ROLE_NOT_FOUND` 并被断连）。§15.11 的
  `secretary / review-board / executor-* / sentinel` 需要 hub 侧扩 `allowedRoles`
  （★ 冒烟已用 `new Hub({allowedRoles:[...]})` 类 API 验证可行，`server.ts` 未暴露该配置 ⇒ **hub 侧待办**）。
- **event 路由**（★ 实测 `services/eventService.ts` + `router.ts`）：hub 对 `event.*` 按
  **`msg.to` 转发，发给 `{role:'hub'}` 等于发回 hub 自己**（没人收到）。
  bridge 的 event.* 默认投递 `{role: cfg.eventTo='ui', broadcast:true}`（spike 同款），
  可用 `--event-to <role>` 改指评审团/秘书席。
- **permission 路由**（★ 实测 `services/permissionService.ts`）：`permission.request` 一律
  **只广播给 `role:'ui'`** 客户端；`permission.response` 按 correlation 单播回发起者。
  ⇒ §15.11 若要评审团（review-board）接管审批，需 hub 侧扩审批路由，bridge 侧无法代劳。
  ★ 冒烟中观察到同一 `permission.request` 到达 ui 客户端多次（hub 侧重复投递，疑多插件
  重复 dispatch，未深究）；bridge 按 correlation 幂等处理（首个响应生效，其余记日志），不受影响。
- 复用 spike 客户端：`../spike/hubconn.mjs`（hello/welcome + send）。
  ★ 已知坑：`openHub` 在「hub 发 system.error 后干净 close」时 promise 永不落定
  （resolve 只认 welcome，reject 只认 error）——bridge 已用 welcome 超时竞速兜底。

## 3. bridge 对接方式

```
hub WS                          bridge（本文件同目录 hub-bridge.mjs）              dsh 前门
command.input  ────────────────►  会话映射(hub session_id ↔ dsh sessionId)  ────►  POST /api/session.prompt
event.thinking/tool_call/  ◄────  journal 轮询 .dsh/sessions/<p>/<sid>/*.jsonl ◄──  (dsh 写 journal)
  tool_result/turn_done/event.message
permission.request ◄── POST http://127.0.0.1:<bridgePort>/permission ──► 等 correlation 响应 ──► 原样返回
```

- **交接包**：`command.input` 的 text 若是交接包（`# 交接包`开头）或 payload 带 `handoff` 字段，
  先过 `handoff-contract.mjs` 校验（四段+depth/from/to），不合格发 `event.notice` 带问题清单；
  合格则作为 prompt 正文下发，payload 保留元信息。
- **断线重连**：指数退避（基值可配，默认 500ms，×2 封顶 15s），welcome 后重挂。
- **permission 透传**：payload 原样（不变形），correlation_id 由 bridge 生成并保留往返。
- **老三脑排除**：不接 left/right/sandbox、不接 gen.* / dsh.swap 业务（permission 通道保留但只做通用透传）。

## 4. 未实测清单（诚实）

- ~~真实 dsh 实例本轮未起~~ → **hub 侧全链已冒烟**（见下），dsh 前门（:3080）仍未起，
  RPC/journal 结论来自 eval-run.mjs（生产在用）+ 包内类型定义，**真实 dsh 冒烟仍待跑**。
- 助手文本消息的 journal type、SSE `/stream` 形状：未实测，见 §1.3。
- `session.prompt` 的 `mode:'steer'` 语义（插话 vs 新回合）未深究，bridge 沿用 eval-run 同款参数。

## 5. 真实冒烟读数（2026-10-25，hub=elv/dsh-hub @ :15817）

- 装置：`new Hub({port:15817, allowedRoles:[...§15.11 席位]})`（类 API，未碰源码）
  + bridge（role=executor-alpha, --bridge-port）+ smoke.mjs（role=ui 审批客户端）。
- 结果 5/5 绿：握手 welcome ✓ / `command.input` 下行到桥 ✓ / 回执
  `event.notice input_rejected`（dsh 前门未起，预期）✓ / `permission.request` payload
  原样到达 ui ✓ / ui 响应原样回到 bridge `/permission` 调用方 ✓。
- 过程中修掉的 bridge 缺陷（均由冒烟暴露）：
  ① hubconn.openHub 在「system.error+干净 close」时永不落定 → 加 welcome 超时竞速；
  ② event.* 发给 `{role:'hub'}` 无人收 → 默认改投 `{role:'ui',broadcast:true}`；
  ③ dsh 前门 fetch 失败会以未捕获 rejection 逃逸 → 已入 `input_rejected` 回执路径。
