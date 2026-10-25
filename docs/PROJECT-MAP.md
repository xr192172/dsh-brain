# 项目现状地图（2026-10-25，寄风批准 §15.11 后整理）

> 目的：一眼看清「什么是活的、什么是存档参考的、什么是待建的」——终结浆糊状态。
> 维护纪律：新组件落位时更新本文件；组件存档时迁到「存档参考」节并写明原因。

## 一、活体系（新 · 全部在役）

| 组件 | 位置 | 角色 | 状态 |
|---|---|---|---|
| **agent-memory** | `D:\project_develop\agent-memory` | 记忆图谱服务（:7870）：叙事提取/阈值拒答/因果链/交接包规格来源 | ✅ 在役（结构化重写毕） |
| **小鲸 QQ 实例** | `_design-canvas-labs/ai-companion-kit/packages/companion` | 秘书席的 QQ 入口：人设+记忆注入+反问舞步 | ✅ 在役 |
| **席位定义（九席）** | `dsh-brain/seats/library/` | council-{architect,dev,review,secretary,scout,dispatch,acceptance,sentinel,review-board} | ✅ gen-roster 全绿 |
| **席位工具链** | `dsh-brain/scripts/seats/` | gen-roster / seat-contract / **handoff-contract（交接包契约）** / gen-seat-registry / validate-seat-output | ✅ |
| **provider 注册** | `dsh-brain/packages/subagent-council/src/seat-registry.generated.ts` | 九席编入 DSH 工具面（gen-seat-registry 生成） | ✅ |
| **WS 桥（bridge）** | `dsh-brain/bridge/` | hub↔dsh 协议翻译（command.input↔session.prompt、event、permission 透传、交接包 fail-closed） | ✅ 单测 9/9+冒烟 5/5 |
| **agent-io（底座）** | `design-canvas` 仓（MCP :agent-io） | 设计册（decision/expectations）+ 任务两段式 + 写闸 + 判据对拍 | ✅ |
| **wb2api** | `secretary/wb2api`（:7863） | 模型网关（国内账号池） | ✅ |
| **NapCat** | `secretary/napcat` | QQ 协议网关（小鲸 QQ 3512668998） | ✅ |
| **keeper** | `secretary/keeper.bat` | 服务守护（wb2api/memoryd 巡逻拉起） | ✅ |
| **council-hub** | `dsh-brain/packages/council-hub` | 评审团编排基座（council-hub/1）：六基角色白名单（hub/ui/secretary/review-board/executor/sentinel）+ 五通道 + 队列与 `config.maxConcurrent` + 交接包 fail-closed 校验（复用 handoff-contract.mjs） | ✅ 骨架（2026-10-25：5 文件/21 用例全 PASS，tsc 0 错） |

## 二、存档参考（旧 · 不接入，仅设计思路）

| 组件 | 位置 | 参考价值 | 为何存档 |
|---|---|---|---|
| **elv/dsh-hub** | `elv/dsh-hub`（tag: archive/elv-dsh-hub） | WS Hub 结构 / permission 换代审批闭环交互（L7 参考）/ hubconn 握手时序 | 老三脑时代产物（left/right/sandbox 角色）；新体系嫁接其上=打补丁（寄风裁定存档） |
| **ai-base/agent-shell** | `ai-base/agent-shell/internal/hub/v2/` | 老 Go Hub 源头（protocol/router/builtin_services） | 同上 |
| **老构建计划文档** | `dsh-brain/dist/dsh-hub-handoff/`、`dsh-hub-wire-handoff/` | 协议契约思路 / bridge shim 设计 | 其"三实例+fork 判断"部分已被 §15.10/15.11 取代 |

## 三、待建（按依赖序）

| # | 组件 | 规格 | 依赖 |
|---|---|---|---|
| 1 | **council-hub**（评审团编排基座） | ✅ 已落位（见「一、活体系」）：骨架 + 五通道 + 交接包校验完成；**待接**：task.verdict 的语义判定（归评审席）、REST 只读管理面 | — |
| 2 | 队列+并发上限 | ✅ 已内建于 council-hub：`TaskQueue`（优先级 + 同优先级 FIFO + dependsOn 依赖序）+ `config.maxConcurrent` 硬闸（含端到端与单元两组用例） | 1 |
| 3 | 编号自动化 | agent-io claim 机制 + 启动自动分配 agent:席名-序号 | 1 |
| 4 | 预授权额度 | 调度席下发 {N 步/M token/禁区}，sentinel 抽验 | 1,3 |
| 5 | L6 回写通路 | 子代理产物→判据→记忆图谱 | 1 |
| 6 | L7 安全换代 | 参考 elv/dsh-hub 的 permission 闭环设计（资金化阶段） | 1,5 |

## 四、council-hub 规格 v1（评审团编排基座，从零实现）

**单一职责**：席位实例的注册/寻址/任务下发/产物回收/交接包通道/队列与并发——**评审团流水线的运行时**。

**协议（信封思路沿用，role 集=新席位，零历史角色）**：
- 信封：`{protocol:"council-hub/1", id, correlation_id, type, from, to, ts, payload}`
- role 集：`hub / ui / secretary / review-board / executor / sentinel`（白名单=此六，**无老角色**）
- 握手：`session.hello → welcome`（沿用 hubconn.mjs 语义——bridge 无缝对接）
- 通道：
  - `task.assign`（hub→席位：任务+预授权额度+完成预期）
  - `handoff.submit`（席位→hub：交接包，handoff-contract 校验）
  - `task.result`（席位→hub：产物+证据）→ `task.verdict`（评审团判定回执）
  - `sentinel.alert`（监督席→hub：越界/跳审警报）
  - `permission.request/response`（保留通道，L7 时启用换代场景）
- **内建队列+并发上限**：`config.maxConcurrent`（全局）；任务按优先级+依赖序排队；额度用尽/越界自动回闸口
- **位置**：`dsh-brain/packages/council-hub`（TS，独立 package，vitest）
- **非目标**：无 left/right/sandbox、无 genService、无 dsh.swap 业务、无前端（管理面用 REST 只读）

**与 bridge 的关系**：bridge 协议翻译层不变（它对接 hub 的握手与信封语义）——council-hub 的协议与老 hub 信封同形，bridge 只需改 role 白名单与 type 映射。
