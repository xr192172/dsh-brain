# 构建计划：用 TS 重制老 Hub 为三脑编排基座（dsh-hub）

## Context（为什么做）
老 Go Hub（`ai-base/agent-shell`）有稳定可复用的编排能力（WS Hub + 前端 + 审批路由），但要接 DSH 三脑、且后续要维护，用户决定**用 TS 仿写一版**（方案 B）。
- **线协议**沿用老 v2 协议（与 spike 兼容，dsh 脑可无缝连 Go Hub 或 TS Hub）。
- **前端**移植老 React web，但**砍掉"设计画布" canvas 视图**。
- **网关类**（A2A/MCP/完整会话持久化/group 三脑比拼）**后续再配**，本轮不做。
- spike 已验证最小闭环可行：`session.hello→welcome` 握手 + `permission.request/response` 承载换代审批（`dsh.swap`）+ `event.message` 广播到 ui。

**分工**：
- **本份计划文档**：定义要建什么、文件结构、分步怎么做、验收。（本会话产出）
- **数据契约**：由你切到另一个窗口，用 **Design Canvas** 从 `ai-base/agent-shell/internal/hub/v2/` 代码里自行提取（本会话不产契约，避免越权/不一致）。

## 目标产物
一个独立 TS 项目 `dsh-hub`，启动一个 WS Hub（默认 `localhost:15813`）：
- 三个 dsh 实例以 `role=brain` 接入；
- 前端（`role=ui`）展示在线脑 + 换代审批队列，人对 `dsh.swap` 申请点批/否；
- REST 提供管理面（列脑、审批查询/响应、健康检查）。

## 非目标（本轮不做）
A2A / MCP transport、完整 session 持久化与 transcript、group 三脑比拼编排、多 Hub 联邦、前端主题/彩蛋。
（这些对应"网关什么的后续配齐"。）

## 从哪提取数据契约（给 Design Canvas / 另一窗口的输入）
让另一窗口以这些文件为契约来源（我不逐字段抄，由它提取）：
- 协议：`internal/hub/v2/protocol.go`（Message/Address/各 payload/构造器）
- 握手与 WS 入口：`internal/hub/v2/hub.go`（handleWS、hello/welcome/peer_update）、`hubclient/v2/client.go`（Dial 时序）
- 寻址：`internal/hub/v2/router.go`（ResolveTargets）
- 审批路由：`internal/hub/v2/builtin_services.go` 的 `permissionService`
- REST 参考：`internal/hub/v2/builtin_services.go` 的 APIEndpoints（`/api/brains` 等）
- 前端移植源：`internal/hub/v2/web/src/`（React；须剔除 canvas 视图）
- 已有 spike 客户端（免重写）：`dsh-brain/scripts/spike/hubconn.mjs`（role=brain/ui 的 WS 客户端）

## 项目结构与文件（建议）
```
dsh-hub/
├─ package.json        # type:module; deps: ws, react, react-dom; dev: typescript, vite
├─ tsconfig.json
├─ vite.config.ts      # 前端 dev 代理 /api、/ws → Node Hub
├─ src/
│  ├─ server.ts        # Node http 入口：/ws 升级 + /api 路由 + 静态面板
│  ├─ hub.ts           # 连接注册表、上下线广播、生命周期
│  ├─ router.ts        # 寻址（role 单播/广播、按 ID、exclude_roles）
│  ├─ services/
│  │  ├─ sessionService.ts    # hello/welcome/peer_update/goodbye
│  │  ├─ permissionService.ts # 换代审批路由（dsh.swap）
│  │  └─ eventService.ts      # event.* 广播、command.* 到脑
│  ├─ persistence.ts    # approvals.jsonl 审批留痕（MVP 文件追加）
│  ├─ protocol.ts       # 类型 + 构造器 + 校验（字段从 Design Canvas 契约来）
│  └─ web/              # React（移植老 web，去 canvas）
│     ├─ src/store.ts
│     ├─ src/features/sidebar/
│     ├─ src/components/MainContent.tsx
│     └─ src/App.tsx
└─ README.md
```

## 分步计划
1. **脚手架**：`dsh-hub` 初始化（ESM + TS + vite + ws + React）。
2. **协议层**：按 Design Canvas 契约实现 `protocol.ts` 的 Envelope/Address/payload 类型与构造器。
3. **Hub 内核**：`server.ts` + `hub.ts`（/ws 升级、握手、连接注册表、peer_update 广播）。
4. **服务**：`sessionService`、`permissionService`（换代审批往返）、`eventService`（广播/命令到脑）。
5. **REST + 持久化**：`/api/brains`、`/api/approvals(/:corr)/respond`、`/api/hub/health`；审批落 `approvals.jsonl`。
6. **前端移植**：老 React web 去 canvas → 在线脑 + 审批队列 + 审批操作。
7. **自测对照**：用 spike 客户端跑通握手/peer_update/换代审批/event 广播（见验收）。

## 验收（实现方自测）
1. `node server.ts` → `GET /api/hub/health` ok。
2. 起 `role=brain` + 一个 `role=ui`（用 spike `hubconn.mjs`）：
   - 双方收到 `session.welcome`（有 client_id）。
   - ui 收到 brain 上线的 `peer_update`。
   - brain 发 `permission.request[dsh.swap]` → ui 收到并回 `permission.response{allowed:true}` → brain 收到。
   - ui 收到 brain 广播的 `event.message`。
3. 前端 `/`：左侧**无"设计画布"**导航；可见在线脑；审批队列可点"通过"→ pending→resolved。

## 收尾/交接（本会话在计划之后负责）
- 把本计划 + Design Canvas 契约来源清单整理成压缩包，供你带到另一窗口。
- 你重制完 TS Hub 后，回来让我**接线**：dsh 脑端用 spike 的 `hubconn.mjs` 连 TS Hub；`permission` 换代审批挂 dsh `coordinator.runVerifyGate`/flip 前。