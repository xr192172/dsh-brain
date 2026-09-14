# 下一步开发：三脑真实接入 Hub（让 15813 变成统一管理入口）

> 读者：开发窗口（elv/dsh-hub 实现者）
> 目的：目前 Hub(15813) 已运行、前端与 gen.* 换代状态机已就绪，但**三台真 dsh 都没接入**，导致用户仍"各用各的页面"。本文给出把三台真 dsh 桥接到 Hub、让其在单一页面统一管理的开发任务。

## 现状（已核实）

- **Hub 在跑**：`http://127.0.0.1:15813/`（"Agent-Shell Hub" React 前端），pid 25184。
- **真脑为 0**：`GET /api/brains` → `[{left,running:false,pid:0},{right,...},{sandbox,...}]` 全 offline。
- **gen.* 已实现**：`src/services/genService.ts`（6 状态 idle→requested→executing→testing→passed→flipped，角色权限：right 才能 request/verify/flip，left 才能 execute，sandbox 才能 test_done）。
- **mock 侧全绿**：`scripts/three-brain-bridge.mjs`（15817 假大脑）跑通握手/permission/gen 循环 —— 但从未接真 dsh。
- **被记录但未执行的"下一步"**（见 docs/step3-three-brain-cycle.md）："接入真实 dsh brain 实例"，让 `hub-gen-bridge.mjs` 连真 dsh 而非 mock，"三个真实 dsh brain 实例各承担 left/right/sandbox 角色跑完整循环"。

## 目标（验收口径）

1. 三台真 dsh（每台独立进程、独立 workspace/页面）通过 bridge 连到 `ws://127.0.0.1:15813/ws`，各归 `left` / `right` / `sandbox`。
2. Hub 前端 `/api/brains` 显示三台 **running:true + 真实 pid**；用户**只需开 15813 一个页面**即统一管理三脑（任务下发、审批、换代状态）。
3. 在 Hub 页面上对一个脑发起 `command.input` → 桥接到该 dsh 的 `session.prompt` → 执行事件流（`event.thinking/tool_call/turn_done`）回流 Hub。
4. 换代审批：`permission.request[dsh.swap]` → Hub 面板人批 → 回传给发起脑（闭环已 mock 验证，需真脑复验）。

## 开发任务

### T1. 真脑 bridge 成熟化（`scripts/hub-gen-bridge.mjs` → 生产化）
现状是"可独立运行的 shim"，需加固为真脑接入器：

- **连接**：`node scripts/hub-gen-bridge.mjs --role <left|right|sandbox> --hub ws://127.0.0.1:15813/ws`。
- **上行（Hub→脑）**：收 `command.input` → 转发到该 dsh 真进程的入口（`session.prompt` 或 admin 端口 `?cmd=`）。需明确：**每台脑 bridge 各自绑定一个真实的 dsh 进程/端口**（见 T2 的实例分配）。
- **下行（脑→Hub）**：dsh 事件流 → `event.thinking/tool_call/turn_done`；换代用 `permission.request/response`。
- **心跳与断线重连**：bridge 到 Hub WS，以及 bridge 到 dsh 两条链路都要：心跳、重连、`peer_update` 同步（Hub 需在 brain 掉线时把 `running` 置 false，重连后恢复 true）。
- **要求 mock 的 `three-brain-bridge/cycle.mjs` 在 15813 上对真脑跑通**（不是 15817 mock）。

### T2. 三台真 dsh 实例分配（开发窗口需与用户确认跑法）
当前只有一台独立 dsh gen（port 3084）。三脑至少两种跑法，产出择一：

- **方案 A（轻，推荐先点亮）**：一台 dsh gen 同时桥接 → 但**三脑是三个进程实例**更加贴近 D-110（故障隔离）。建议：起 3 台 `dsh web`（各自工作区：`dsh-left` 主源码 / `dsh-right` 只读审计 / `dsh-sandbox` 可弃实验），各自给 bridge。
- **方案 B**：复用 switchboard 已有 gen 实例作三脑来源。
- 产物：一份"如何起三台、端口怎么分、各自 role 对谁的 bridge"的脚本/文档。

### T3. Hub 前端补"统一管理"视图
- 现在 BrainsView 只列状态。需补：点某脑 → 可对该脑**发 `command.input`**、看**其实时事件流**、看到**换代审批队列**。
- 让"各用各的页面"收敛成"hub 一页管三脑"。

### T4. 换代 catchup 阻塞（已知问题，写文档/适当处理）
真实 `?cmd=handover` 换代被 switchboard catchup 卡：`b-catchup-failed`（active gen 的 `caughtUpSeq`!=0，staging 追不平，gen-3090~92 屡败）。影响"点击换代真正换"。
- **不阻塞 T1-T3**（脑连上 hub 就能管，审批能走）。
- 若要在 hub 里真正驱动换代，需 dsh-brain 侧修 catchup —— 单独列出，与接入并行或排后。

## 文件 / 复用点

| 文件（elv/dsh-hub） | 作用 |
|---|---|
| `scripts/hub-gen-bridge.mjs` | 真脑 bridge shim（T1 在其基础上生产化） |
| `scripts/three-brain-bridge.mjs` / `three-brain-cycle.mjs` | mock 验证，改指向真脑 |
| `src/services/genService.ts` | gen.* 状态机（已实现） |
| `src/brain_registry.ts` / `src/brain_manager.ts` | 脑注册/管理（T1 心跳+上下线落这里） |
| `src/web/` | React 前端（T3 加统一管理视图） |
| `src/server.ts` / `src/hub.ts` | WS 接入把口 |

## 验收 checklist（开发窗口提交时核对）

- [ ] 3 台真 dsh 各自 `running:true,pd` 显示在 `/api/brains`。
- [ ] 只在 `15813` 一个页面：能对 left 发任务、看到 right/sandbox 状态与事件流。
- [ ] `permission.request[dsh.swap] → 面板批 → 回传` 在真脑上闭环。
- [ ] 杀掉某脑 bridge → hub 标记该脑 offline、其它两脑不受影响（fault-isolation）。
- [ ] mock 的 `three-brain-cycle` 脚本改为对真脑在 `15813` 全绿。
- [ ] 换代 catchup 问题：如阻塞则写明"限接入之外"。

## 备注
- 参考接线设计：`d:\project_develop\dsh-brain\.trae\documents\wire-elv-hub-with-dsh.md`（尤 §3 bridge 契约、§3b effect、§2B 换代状态机、§5 三脑承载 A/B）。
- 用户偏好：统一管理 = **一个 hub 页面管三脑**，不接受"三台各开各的页面"作为交付。