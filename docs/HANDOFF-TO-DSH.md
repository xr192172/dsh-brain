# HANDOFF —— 秘书席递归体系开发交接（2026-10-25，主控 → DSH）

> 读者：DSH 里的开发 agent（你）。本文假设你**零上下文**——所有路径/规格/验收标准/纪律都在这里。
> 你的工具：agent-io（MCP，已挂载）。你的工作方式：本文第 6 节的全套流程。

---

## 1. 项目愿景（寄风批准，§15.11）

**秘书席 → 评审团（三细席）→ 执行子代理（含监督席 sentinel）的递归体系，接入 agent-io 底座。**

```
秘书席（council-secretary，统筹起点，共享记忆图谱 memoryd :7870）
  ▼ 派发
评审团子代理（council-review-board，内嵌三细席：侦察 scout / 调度 dispatch / 验收 acceptance）
  —— 所有子代理交接的必经闸口：评审 / 拆分 / 选执行器 / 额度下发 / 验收
  ▼ 排队派发（并发有上限）
执行子代理 ×N（按工具面：dev / 爬虫 / 剪辑……）
  —— 其中【sentinel 监督席】：不干活，专门监察其他子代理（额度/越界/跳审抽验）
      ▼ 到上下文阈值 → 交接包（不许压缩上下文，只许任务接力）
  ▼ 回评审团：验交接包 → 重拆 → 派下一程
  ▼ ……递归向下直到最深完成 → 逐层向上每层过评审 → 回秘书席 → 结果还寄风
```

**排除项（明确不带）**：ai-base 老 Hub 的 left/right/sandbox 三脑角色、dsh.swap 换代审批业务（L7 另立项，资金化阶段做）、老传送带及 ai-base 其他机制。**旧件一律存档参考，不接入**（吸收原则：新能力优先合并进既有子代理，立新席前先查可吸收）。

**寄风的四大件全景**：自进化（插件安全拆装+子代理自更新）｜agent-io（开发稳定性与简单性）｜记忆系统+实验室（可靠性）｜数据和论文系统（知识复用）。

## 2. 项目现状地图

**必读**：`D:\project_develop\dsh-brain\docs\PROJECT-MAP.md` —— 活体系 10 组件 / 存档参考 3（elv/dsh-hub 已 tag 存档+ARCHIVED）/ 待建 6。

要点：
- **席位定义（九席，全部就绪）**：`D:\project_develop\dsh-brain\seats\library\` —— council-{architect,dev,review,secretary,scout,dispatch,acceptance,sentinel,review-board}.md（各自带职责边界/Red Flags/Output Contract，过 seat-contract 校验）
- **provider 注册**：`dsh-brain\packages\subagent-council\src\seat-registry.generated.ts`（9 席已编入，由 `scripts/seats/gen-seat-registry.mjs` 生成）
- **交接包契约（已实现）**：`dsh-brain\scripts\seats\handoff-contract.mjs` + `test-handoff.mjs`（双向自证 5/0）——四段：已完成(含证据)/未完成(带原因)/关键发现与坑/下一步建议，元信息 depth/from/to
- **WS 桥（已实现）**：`dsh-brain\bridge\`（hub-bridge.mjs，单测 9/9+冒烟 5/5）——hub↔dsh 协议翻译
- **设计全稿**：`D:\project_develop\_design-canvas-labs\议事厅-递归子代理-构想评审.md` §13-§15.11（多平台三层/总纲七层栈/流水线/闸口分级/编号继承/吸收原则/三席重构/单体系定稿）

## 3. 服务与凭据（全部在役）

| 服务 | 端口/位置 | 用途 |
|---|---|---|
| wb2api | :7863，key 见 `secretary/wb2api/config.json`（仓库外，不进 git） | WorkBuddy 模型网关（OpenAI 兼容 /v1）——DSH 模型已配 deepseek-v4.1-flash 走它 |
| memoryd | :7870 | 记忆图谱（/recall /remember /health，env MEMORYD_LLM_API_KEY 同上 key） |
| agent-io MCP | `design-canvas/dist/src/presentation/mcp/server.js`（stdio） | 设计册+任务闸（**你的主工具**） |
| NapCat | 小鲸 QQ 3512668998（QQ 网关） | 秘书席 QQ 入口 |
| keeper | `secretary/keeper.bat` | 服务守护（wb2api/memoryd 掉线自动拉起） |

模型池（wb2api /v1/models）：cn:deepseek-v4.1-flash（小鲸本命）/ cn:minimax-m3.1-flash / cn:glm-5.3 / cn:kimi-k3.1-pro-highspeed / cn:hy4-preview 等。

## 4. agent-io 底座使用（你的工作方式）

- **MCP 接入**：agent-io 已在 ~/.workbuddy/mcp.json（stdio，AGENT_IO_HOME=D:\project_develop\dsh-brain\.agent-io）——**feature "dsh-brain" 已建册**（317 文件/362 节点/1063 符号，基线锚定 226 文件）
- **全套流程（每张卡都走）**：
  1. **写设计**：`edit_dsl` type=decision（挂到相关文件路径；data 只用已知键：summary/rationale/consequences/acceptance/thread/evidence_source/status/author/note——**id 走顶层 operations[].id，不放 data**）
  2. **挂卡**：`edit_dsl` type=todo op=add（data.summary）
  3. **接任务**：实施前 update 登记；（task 型卡走两段式 claim/start，todo 型直接做）
  4. **补源码**：按设计写代码（新文件/新包均可——council-hub 建议落 `dsh-brain/packages/council-hub`）
  5. **对拍验收**：跑测试/编译，**改前改后对比**（如 tsc 错误数），readings 留档
- **写闸纪律**：`actor: "agent:workbuddy-glm5"`（或你的编号）与 claim 的 owner 一致；authorize 按文件范围
- **已知坑**：decision data 里放 id 会被拒；HANDOFF_SECTIONS 短名/全名口径要一致；TS 7.0.2（tsgo）对 `(expr as X).field = v` 语句形态有解析 bug（拆两行绕开）；github.com 直连间歇断（重试）

## 5. 待建队列（按依赖序，规格都在）

1. **council-hub**（评审团编排基座，从零）：规格见 `dsh-brain\docs\PROJECT-MAP.md` 第四节——信封 `{protocol:"council-hub/1", id, correlation_id, type, from, to, ts, payload}`；role 集 hub/ui/secretary/review-board/executor/sentinel；通道 task.assign / handoff.submit / task.result→task.verdict / sentinel.alert / permission（保留通道）；内建队列+config.maxConcurrent；位置 `dsh-brain/packages/council-hub`；**无老角色/无 genService/无 dsh.swap/无前端**
2. **队列+并发上限**：内建于 council-hub（任务按优先级+依赖序；额度用尽/越界自动回闸口）
3. **编号自动化**：启动自动分配 `agent:席名-序号`；编号不符不让接任务（可继续自己的）；任务继承制（子可接父未完成，同级不可互接）
4. **预授权额度**：调度席随任务下发 {最多 N 步/M token/不许动 X}；额度内直连，越界回闸口；自判跳审→sentinel 强制抽验+信誉降级
5. **gen-roster 结构化**：三处硬编码表（UNIQUE_OF/SEAT_SCOPE_NOTE/循环列表）→ frontmatter 驱动扫描 seats/library（新席=新 md 零代码）
6. **L6 回写通路**：子代理产物→agent-io 判据验证→稳定知识写回记忆图谱
7. **L7 安全换代**（资金化阶段）：参考 elv/dsh-hub 存档的 permission 闭环设计

## 6. 纪律（寄风裁定，违反即返工）

- **每张卡走全套流程**（第 4 节），不许绕闸
- **吸收原则**：新能力优先合并进既有子代理（底层自动切换逻辑），立新席前先查可吸收；评审三席（scout/dispatch/acceptance）恒定不可新增第四席
- **任务中不许压缩上下文**——到阈值产出交接包（任务接力）
- **自审不能替代验收**——验收席对照完成预期逐条判定，证据不足判未完成
- **旧件存档参考不接入**——发现自己在改老文件凑功能，停下来重写
- **产物住仓库**——不放临时目录
- **诚实清单**——没验证的明说，接不上的明说，不假装

## 7. 第一张卡（建议从这里开始）

**实现 council-hub 骨架**（第 5 节 #1 规格）：
- `dsh-brain/packages/council-hub/`：package.json（type:module, deps: ws）+ src/{server.ts, protocol.ts, queue.ts, registry.ts} + test/（hello→welcome、task.assign 下发、handoff.submit 校验（复用 handoff-contract.mjs）、队列并发上限、sentinel.alert 路由）
- 验收：单测全 PASS + tsc 0 新增错误（对照改前改后）
- 走全套：decision 写设计 → todo/task 挂卡 → 实施 → 对拍
