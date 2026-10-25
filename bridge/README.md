# hub-bridge —— dsh-hub ↔ dsh 前门 的 bridge shim

一个进程 = 一个席位（role）接入 [elv/dsh-hub](../../../..) WS Hub（`/ws`），背后通过 HTTP 面驱动一个 dsh 实例（前门 `:3080`）。目标拓扑见 §15.11（秘书席 → 评审团 → 执行席/sentinel，交接包必经评审闸口）。

```
hub WS（command.input ↓ / event.* ↑ / permission 透传）
   │
bridge（本目录 hub-bridge.mjs，role 可配）
   │  session.prompt（mode=steer）      journal 轮询（.dsh/sessions/<profile>/<sid>/session.jsonl[.zstd]）
   ▼
dsh 前门 http://127.0.0.1:3080（/api/session.list|prompt|cancel）+ 控制面 :31800（?cmd=，本轮未接业务）
```

## 启动

```bash
# 环境要求：node >= 22；在 dsh-brain 仓内运行（依赖 ws / fzstd）
node dist/dsh-hub-handoff/bridge/hub-bridge.mjs \
  --hub ws://127.0.0.1:15813/ws \
  --role executor-alpha \        # secretary | review-board | executor-* | sentinel（任意 role，Hub 动态注册）
  --name dsh-alpha \
  --front http://127.0.0.1:3080 \
  [--session <dsh sessionId>] \  # 缺省 = 首条 command.input 时从 session.list 自动挑（优先空闲会话）
  [--bridge-port 15900] \        # 开本地 HTTP 面：GET /health、POST /permission
  [--poll-ms 1000]               # journal 轮询间隔
```

env 等价：`HUB_URL` / `BRIDGE_ROLE` / `BRIDGE_NAME` / `DSH_FRONT` / `DSH_SESSION_ID` / `DSH_JOURNAL_ROOT` / `BRIDGE_PORT` / `POLL_MS`。
附加开关：`--replay-journal`（重放 journal 全史；默认跳过挂接前历史）、`--no-handoff-enforce`（交接包不合格也放行，仅回 notice）。

## 翻译规则

| 方向 | 来源 | → hub |
|---|---|---|
| 下行 | `command.input{text,session_id,turn_id}` | `POST /api/session.prompt{sessionId,mode:'steer',content:[{type:'text',text}]}`；受理后回 `event.notice{code:'input_accepted'}` |
| 上行 | journal `tool/call` | `event.tool_call{tool_name,tool_args}` |
| 上行 | journal `tool/result` | `event.tool_result{call_id,is_error,snippet}` |
| 上行 | journal `turn/end` | `event.turn_done{turn_id,reason}`（turn_id 优先用最近受理的 hub turn_id） |
| 上行 | journal `message/*` | `event.message{role:'assistant',content}`（启发式，见 NOTES §1.3） |
| 透传 | `POST :<bridgePort>/permission {tool_name,tool_args,tier}` | `permission.request`（payload 原样 + correlation_id）→ 等 `permission.response` 原样返回；超时回 `{allowed:false,reason:'timeout'}` |
| 透传 | hub 来的 `permission.response` | 按 correlation_id 唤醒等待者 |
| 下行 | `command.cancel` | `POST /api/session.cancel` |

**交接包闸口**：`command.input` 的 text 以 `# 交接包` 开头（或 `payload.handoff===true`）时，先过
`scripts/seats/handoff-contract.mjs` 四段校验；不合格 fail-closed——只回
`event.notice{code:'handoff_invalid',problems:[...]}`，不下发 dsh。

**断线重连**：ws close/连接失败 → 指数退避（500ms ×2^n，封顶 15s）→ 重握手恢复收发。

## 单测

```bash
node dist/dsh-hub-handoff/bridge/test-bridge.mjs
# 装置：mock hub（hello/welcome + command.input）+ mock dsh（session.list/prompt/cancel + 明文 journal）
# 覆盖：握手 / 下行翻译 / 上行翻译 / permission 透传不变形+超时 / 交接包拦截与放行 / cancel / 断线重连
```

## 真实冒烟（已跑通）

```bash
# hub 默认白名单只有 ui/brain/left/right/sandbox（hub.ts DEFAULT_CONFIG），§15.11 席位 role 需扩：
#   server.ts 未暴露 allowedRoles ⇒ 冒烟用类 API 起（hub 侧待办：把 allowedRoles 暴露成 env/CLI）
node --input-type=module -e "import {Hub} from '<elv>/dsh-hub/dist/hub.js'; \
  await new Hub({port:15817, allowedRoles:['ui','brain','secretary','review-board','sentinel','executor-alpha']}).start()"
node dist/dsh-hub-handoff/bridge/hub-bridge.mjs --hub ws://127.0.0.1:15817/ws --role executor-alpha --name dsh-alpha --bridge-port 15901 &
node dist/dsh-hub-handoff/bridge/smoke.mjs   # HUB_URL=ws://127.0.0.1:15817/ws BRIDGE_PERM=http://127.0.0.1:15901/permission
```

冒烟读数（2026-10-25 实测）：握手 ✓；`command.input` 下行到桥 ✓（dsh 前门未起 → `event.notice input_rejected`，预期）；
`permission.request` 经 hub 路由到 **role:'ui'** 审批者 ✓（permissionService 只广播给 ui）→ 原样响应回桥 ✓。

注：真实 dsh 前门（:3080）未起时，下行会在 `session.list/session.prompt` 处失败并回
`event.notice{code:'input_rejected'}`——这是预期行为，链路其余部分（握手/上行/透传）不受影响。

## 边界与已知限制

- 本轮按 §15.11 **排除**老三脑角色（left/right/sandbox）与 dsh.swap 换代业务；permission 通道保留为通用透传。
- dsh 事件源用 journal 轮询（已实测的形状）；SSE `/stream` 未实测，未接。
- 事件只发往 `{role:'hub'}`，由 hub 决定再分发（与 spike 语义一致）。
