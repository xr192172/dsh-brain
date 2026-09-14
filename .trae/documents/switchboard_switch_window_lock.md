# 蓝绿交接切换窗口：遮罩 + 拒写（消除不稳定态 kind 报错）

## Context（为什么做）
用户在蓝绿交接进行中的"不稳定窗口"里往前门发会话消息，会收到
`Cannot read properties of undefined (reading 'kind')`，且切换自身也会报一条。
根因不在本仓库代码：`packages/conveyor-context` 的 `.kind` 已全部防护
（`src/index.ts:144` 为唯一的 `.kind`，已写 `reason?.kind ?? 'end'`）；本仓库 `packages`
下仅此与 switchboard 的 `b.kind`（非 undefined）。真正的抛错发生在 DSH 核心在切换
恢复旧会话时折叠摘要，属外部包、不可改。

**可治本的，是从源头封住那个不稳定窗口**：交接期间让前门把用户"写操作"挡在门外
（返回明确"正在切换中"的遮罩提示，不转发到正在退役/未就绪的 gen），从而杜绝
"不稳定态里并发写入 → kind 竞态"。这正是用户要的"遮罩 + 切换完成前别操作"。

## 方案（最小可行：后端口令锁 + 遮罩文案，不改前端）
不依赖 DSH web 前端（外部包不可改）。改为在 switchboard 前门层加锁：
交接进行中，写请求与新建连接一律被挡，返回明确提示；切换完成后自动放行。

### 1. FrontDoor 加"交接锁定"标志 —— `packages/switchboard/src/proxy.ts`
- 加字段 `private locked = false`，方法：
  - `setLocked(v: boolean): void`
  - `get locked(): boolean`
- `onRequest(req, res)`：在 `const g = this.active` 取出后、转发前加一闸：
  - 写方法（`POST/PUT/DELETE/PATCH`）且 `this.locked` → 不转发，回
    `503` + `content-type: text/plain`，
    body：`503 switchboard 交接切换中：正在切换 DSH 代际，请稍候重试重发（本次消息未处理）。`
  - 读方法（`GET/HEAD`）与未锁定 → 照旧转发（读更安全，且保留会话嗅探逻辑）。
- `onUpgrade(req, socket, head)`：在现有 `if (!g)` 502 之后加：
  - 若 `this.locked` → `clientSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')`，
    不建立到不稳 gen 的 WebSocket（避免切换中新建流式连接触发 kind）。

### 2. coordinator 在整个交接窗口持锁 —— `packages/switchboard/src/coordinator.ts`
- `handover()`（或交接入口，含生成 staging 起，到 flip+verify 或 abort/失败回滚止）全程：
  - 入口 `this.front.setLocked(true)`
  - 用 `try / finally` 确保每个出口（成功 recordResult、abort、catch、回滚）都
    `this.front.setLocked(false)`，杜绝交接异常导致永久锁死。
- 现有 `stageName` / admin `?cmd=status`（`main.ts`）不变量：前端/运维可轮询该状态观察窗口；可选在 admin status 里附带 `locked` 字段便于排查。

### 不做（保持克制）
- 不缓冲/暂存用户写入后重放（增加 split-brain 风险，且 DSH 会话续接已能接住后续消息——切完重发即可）。
- 不根治 DSH 核心那条"切换自身 kind"（外部包，无法改；锁窗口 + 缩短切换已足够压低其诱发面，作为已知 quirk 记录）。
- 不改前端 DSH web（外部包）；遮罩以"503 + 明确文案"形式由前端展示（若前端透出 5xx 正文）。

## 关键文件
- `packages/switchboard/src/proxy.ts`（FrontDoor 加锁 + onRequest/onUpgrade 闸）
- `packages/switchboard/src/coordinator.ts`（handover 入口锁 / finally 解锁）
- （可选）`packages/switchboard/src/main.ts`（admin status 附带 locked 便于观察）

## 验证
- 控制面编译通过（`packages/switchboard` build，产物 out/<id>/main.js）。
- 手工/脚本：驱动一次交接，在交接进行中发一条 `POST /api/session.prompt` 到前门 3080，
  断言收到 503 + "交接切换中"文案、且未打到 gen（日志无转发）；交接完成后同一条可正常
  通过（返回 gen 的正常响应）。
- 回归：正常 idle 状态下写请求照常转发、WebSocket 连接正常（不受锁影响）。
- 重启控制面（`scripts/start-switchboard.ps1`）使改动生效（switchboard 控制面进程重启即加载新 main.js）。