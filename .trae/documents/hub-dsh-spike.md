# Spike：验证老 Hub 能否接入 dsh 实例（方案 A）

## Context（为什么做这个 spike）
用户想复用老项目（`ai-base/agent-shell` 的 Hub，Go）作为「三脑编排基座 + 前端面板」，把 DSH 的三个脑（left/right/sandbox）换成三个 dsh 实例来接。监督面**只保留"换代申请审批"**——对 `agent-shell` 自带的通用 permission/工具审批一律不用（dsh 自己的审批更好，未来接别的不缺）。

本 spike 只验证一个最小闭环，成本最低地回答："老 Hub 到底能不能接住一个 dsh 实例，并承担那唯一保留的换代审批网关？" 若通了，再决定是否投入把桥做成可复用产品级；若某些假设不成立，省下后面所有返工。

关键地形结论（已探明）：
- 老 Hub 启动：`agent-shell --hub-server`，默认监听 `localhost:15813`，WS 端点为 `/ws`（与 DSH switchboard 端口 3080/31800 不冲突，15813 当前 closed）。
- 脑接入：向 `/ws` 发 `session.hello`（`protocol:"2.0"` + `role/brain_mode/project_root/model/client_name`）→ Hub 回 `session.welcome`（含 `client_id`）。协议见 `hub/v2/protocol.go`。
- dsh 侧无需新 spawn：运行中的 switchboard（pid 22208）前门 `3080`、控制面 `31800`（`?cmd=status/result/apply`）直接可用。
- 复用通道：老 Hub 里唯一能把"人类决策"推给面板并取回的现成机制是 `permission.request/response`（路由到 UI）。本 spike 用该通道承载"换代审批"，但**不碰 dsh 的工具/权限审批**。
- 桥接语言：TS + `ws` 依赖（DSH switchboard 已依赖 `ws@^8.21.3`）。

## Spike 目标（验收标准）
在一个可复现的最小闭环里证明三件事：
1. **Hub 可引导一个 dsh 实例**：dsh(shim) 以 role=brain 连上 Hub `/ws`，握手 `session.hello→welcome` 成功。
2. **Hub 可见/可路由该脑**：第二个最小客户端（role=ui）能收到该脑发出的 `peer_update`（证明 Hub 侧已注册并可投递）；shim 能读到发往它（role=brain）的 `command.input`。
3. **换代审批往返**：该脑经 Hub 发一条"换代申请"（复用 `permission.request/response` 通道），ui 客户端收到后回 `approved`，脑端收到 `permission.response.approved`（证明"人类面板批换代"这条链路老 Hub 能跑通）。

不做：真正的 dsh 任务执行事件流翻译、换代后实际 flip、通用审批、仲裁 UI、把桥做成正式模块。这些是 spike 之后的决策。

## 落地步骤

### Step 1：启动老 Hub（Go）
用预编译 `agent-shell.exe` 或 `go build`：
```
cd d:\project_develop\ai-base\agent-shell
.\agent-shell.exe --hub-server        # 默认 localhost:15813；必要时加 --hub-data-dir <临时目录> --project-root <占位目录>
```
验证：`Get-NetTCPConnection -LocalPort 15813 -State Listen` 出现即可。
> 若 `--hub-server` 需要 `--project-root`，传一个临时空目录即可（spike 不做真实代码评审）。

### Step 2：写 TS shim（新文件，放 dsh-brain 下独立位置，spike 用）
新建 `d:\project_develop\dsh-brain\scripts\spike\hub-bridge.ts`（Node/TS + `ws`）：
- 用 `ws` 连 `ws://127.0.0.1:15813/ws`。
- 发 `session.hello`：`{protocol:"2.0", role:"brain", id:"dsh-1", brain_mode:"left", project_root: process.cwd(), model:"dsh", client_name:"dsh-brain-spike"}`。
- 收 `session.welcome` → 打印 `client_id`（证明句柄 1）。
- 上线广播：发 `system.status` 或 `peer_update`，让其他连接可见（句柄 2 的 ui 端据此判定）。
- 订阅 `permission.request`（模拟 Hub 端把我们的申请定向回来），收到含 `type==="permission.request"` 且 `payload.tool_name==="dsh.swap"` 时，回 `permission.response {approved:true, reason:"spike-human-approve"}`。
- 对外暴露一个测试入口：模块导出时接受「触发换代申请」，主动发 `permission.request {tool_name:"dsh.swap", tool_args:"{\\"gen\\":\\"gen-3090\\",\\"reason\\":\\"spike\\"}"}` 给 Hub（to role ui）。

### Step 3：写最小 ui 客户端取暖器（新文件，spike 用）
`d:\project_develop\dsh-brain\scripts\spike\hub-ui.ts`：
- 以 `role:"ui"` 连同一 `/ws`，握手 `session.hello`。
- 收 `peer_update` / `permission.request`；收到 `permission.request{tool_name:"dsh.swap"}` 时，打印并向 Hub 回 `permission.response {approved:true}`。
- 这模拟"人类在面板点通过"。

### Step 4：跑通往返
- 先跑 `hub-ui.ts`（角色 ui），再跑 `hub-bridge.ts`（角色 brain）。
- bridge 触发一次"换代申请" → 断言 ui 收到 `permission.request` 且 bridge 收到 `permission.response approved`。
- 顺带（证明是真的 dsh 而非空壳）：bridge 里 `fetch(http://127.0.0.1:31800/?cmd=status)` 把活动 gen 状态包进一条 `event.message` 发回 ui，ui 打印出来（证明桥确实触到了活着 dsh）。

### Step 5：收尾
- 打印结果为 Green/Red。
- 关掉两个 spike 客户端；老 Hub（15813）可留着或按 `Ctrl+C` 停。不动运行中的 dsh switchboard（3080/31800 & pid 22208）。

## 关键文件
- 新建：`d:\project_develop\dsh-brain\scripts\spike\hub-bridge.ts`、`hub-ui.ts`（spike 专用，非正式模块）
- 新增/仅引用：`ws`（已在 dsh switchboard 依赖中）
- 只读参照：`ai-base\agent-shell\hub\v2\protocol.go`（HelloPayload/WelcomePayload）、`hubclient/v2/client.go`（Dial 握手时序）、`main.go`（--hub-server）
- 不改 `ai-base` 任何代码；不改 dsh switchboard 生产代码。

## 验证（端到端）
1. Hub 起：`15813 LISTENING`。
2. `hub-ui` + `hub-bridge` 各自打印 `session.welcome` 的 `client_id`。
3. bridge 触发换代申请 → ui 控制台出现 `permission.request [dsh.swap]`；bridge 控制台出现 `permission.response approved=true`。→ 三件验收全过。
4. bridge 回发的 `event.message`（含 dsh 活动 gen 状态）在 ui 端打印成功 → 证明桥确实触到了 dsh switchboard。

## Out of scope（spike 后）
- 完整 event.thinking/tool_call/turn_done 流的真实翻译、command.input→dsh 实际执行。
- 把 verify 闸升级成"走 Hub 面板的人肉换代审批"正式实现。
- 决定 B 方案（TS 重制 Hub）是否必要。