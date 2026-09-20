# 三脑演化循环 · Three-Brain Evolution（规格草案，固化文档）

> ⛔ **顶层结构已作废（2026-09-20）** —— 用户修正：**三脑不再是顶层**，而是**降入子 agent 层**，
> 变成"**三个用来调控其他子 agent 的脑**"；顶层改为「**专家评审团**」（多模型讨论）。
> **当前架构以 [`revised-architecture-2026-09-20.md`](./revised-architecture-2026-09-20.md) 为准。**
> 本文件中**仍然有效**的部分：会话治理、实验隔离、`tool_apply` 的 verify 闸（§3、§4）。
> ⚠️ 另：新架构下"三个调控脑"的**具体成员尚未确定**（见新文档 §5.1）⇒ 本文件 §1 的分工表
> **不可直接当作新的三脑定义**。

> 接续 `verification-contract.spec.md`（验证契约：五要素 + 三条不变量 I1 写权唯一 / I2 通过才采纳 / I3 无死路线）。
> 本文件把三脑职责、会话治理、实验隔离策略固化下来，作为"自进化"落地依据。
> 对齐来源：ai-base/agent-shell 迁移路线图思路 #2（三脑）；DSH 宿主落点 `subagent/plan/workflow`。

## 1. 三脑职责（固定分工）
| 脑 | 角色 | 职责 | 身份 |
|---|---|---|---|
| **生产脑** | 在役 · Ser | 日常写代码/做任务，维持现役稳定；**提出对实验脑的修改**（产 diff） | 现役 gen（稳定内核） |
| **进化脑** | 主控 · 验证者 | 管蓝绿交接（spawn/freeze/flip/retire/回滚）+ **指挥实验脑测试** + 判定"稳定" | switchboard coordinator（独立进程，独立于生产/实验） |
| **实验脑** | 隔离 · 被测 | 拿生产脑的修改，在隔离环境接受测试；稳定则被提升为新生产，失败则丢弃 | staging gen（fresh 启动 + 隔离内核产物） |

关键身份约束（呼应验证契约）：
- 生产脑**不当自己替换者**的验证者（利益相关，自报 ok 不可信）。
- 进化脑是**唯一验证者**，且独立存续——它挂了系统仍留现役（I3）。
- 实验脑**验证通过前不得获得生产写权**（I1）；不自证 ok。

## 2. 会话治理（生产档 / 实验档，不 merge）
- **物理天然分离**（已确认）：DSH 会话存 `~/.dsh/sessions/<工程>/<session-id>/session.jsonl.zstd`，按 **session-id 分文件**。不同脑用不同 session-id 即天然两档，无合并/污染问题（不在一个文件里）。
- **生产档**：生产脑固定用一个「生产 session-id」，一条连贯、受控的正式履约史（seq/commit 连续——防 `seq gap`）。提升时新脑用 `ctx.agents.resume` 续接的**是生产档**。
- **实验档**：实验脑用独立（实验）session-id，测试/试跑独立留痕，**供自进化回溯**（对应补 diff/指标/验证结果 → 补齐 DSH 审计吐槽的"自进化记录缺历史"）。
- **规则**：两档不 merge；验证通过只转移"生产档写权/续接"，实验档保留为审计（可隔档归档/清理，参考 `~/.dsh/sessions_backup_*`）。

## 3. 实验隔离策略（"水到渠成"的落地）
目标：实验脑天生是一次隔离实体，测坏绝不波生产。
- **运行时隔离（已具备）**：switchboard `spawnGen` 每代一个独立 node 进程 + 独立 `genDir`/overlay（已钉各自 `query.sqlite`）→ 进程/库隔离。
- **会话隔离（天然）**：见 §2，实验脑用独立 session-id，验证前不 resume 生产档（I1 已解）。
- **代码/构建隔离（P0-2，待打通）**：这是"fork 两次"购买的核心——实验脑必须加载**改动后独立 build 出的内核产物**，而非共享/改现役内核。两种做法：
  - **轻量（推荐先做）**：生产脑产 diff → 进化脑将其 apply 到一个**隔离工作区/内核产物**（如 `*.experiment` dist）→ 实验 DSH 进程加载该产物跑测试 → 通过后再把结果并入生产内核。不新建整套安装。
  - **重（若要最彻底）**：真 fork 一份 DSH 内核/源码作为"实验基线"，改动全程在实验 fork 上 build+测，稳定后再合并/提升到生产。
  - 取舍：重方案隔离最彻底但维护两份构建/同步成本高；轻方案先用现有"独立 dist + 独立进程"把链路跑通，隔离已够（结合 §2 会话独立 + §3 进程独立）。
- **建议**：不直接下载安装两份完整 DSH（版本/管理繁重）；以「独立内核产物 + spawnGen 独立进程」做物理隔离，把"改动 → build 实验内核产物 → 实验脑加载测试 → 通过并入"这条 P0-2 链路打通，即达成。

## 4. 与验证契约的对齐
- I1（写权唯一且延迟）：实验脑 fresh 起不 resume 生产档（§2+3）；验证通过后才把生产档写权交给新脑。
- I2（通过才采纳）：任何提升必经进化脑验证闸。
- I3（无死路线）：生产脑验证期如常服役；进化脑独立可决策、可回滚。

## 5. 落地路径（自进化优先级）
1. **[已解] I1 会话写权唯一**：DSH resume 是启动配置驱动（`resumeSessionId`/`sessionId`，默认 fresh）→ 实验脑 fresh、验证后 `resume`。需把 switchboard 当前"直接传 resumeSessionId"改成"验证前 fresh / 通过后 resume"。
2. **[待办] P0-2 构建链路**：打通"生产脑 diff → build 实验内核产物 → 实验 DSH 加载测试 → 通过并入"。
3. **[已解] P0-3 verifyCmd 安全**：已加 `verifyAllowList`（白名单目录前缀），非白名单命令被安全拒绝并回滚；`tool_apply` 的 `verify` 参数即走此闸（详见 §7）。
4. **[已解] tool_apply 进化脑管控（2026-09-11）**：`tool_apply` 支持 `verify` 参数，控制面验证闸通过才 flip、拒绝/失败回滚（见 §7）。

## 6. 待 DSH 审
1. "独立内核产物 + spawnGen 独立进程"的轻量隔离，是否足够替代"fork 两份 DSH"；有无坑。
2. 实验档会话保留粒度（全程逐字 / 只留摘要+指标）—— DSH audit 偏好哪种，成本如何。
3. §5 三条落地路径的依赖顺序与风险。

## 7. tool_apply 的 verify 用法（进化脑管控切换 · 已实现 2026-09-11）

`tool_apply` 是把三脑职责落到自进化激活层的正式通道。**生产脑改完 P0 内容后调用它，向控制面(进化脑)提交"切换申请"；进化脑按下述 verify 闸判定后决定 flip 还是回滚。**

### 为什么是"进化脑管控"，而非脑自己无脑换代
- 三脑分工（§1）：生产脑"提出修改"，进化脑"验证 + 判定"，实验脑"隔离被测"。
- 现在 tool_apply 默认是裸 `?cmd=apply`（仅 probe 就 flip），等于生产脑自报 ok 就切——违背"生产脑不当自己替换者的验证者"。
- 升级后：脑可随本次切换**提交一个 verify 验证脚本**，控制面(进化脑)先跑该闸，**通过(输出 JSON `{ok:true}`)→ flip；拒绝/失败 → 回滚**。决策在控制面，不在某颗心跳脑。

### 参数
```
tool_apply(note="改动简述", profile="web", verify="<验证命令>")
```
- `verify`：可选。形如 `node C:\...\verify.mjs`（解释器 + 脚本绝对路径，**路径勿带空格/引号**）。
- 脚本须输出一行 JSON：`{ ok: true }`（或 `{ ok: false, reason? }`）。
- 脚本须落在控制面启动 env 的 `VERIFY_ALLOW`（白名单目录前缀）内；否则**安全拒绝本次切换并回滚**。
- 不传 `verify` → 退化为普通 apply（仅探活后 flip），向后兼容。

### 控制面侧
- 启动脚本 `scripts/start-switchboard.ps1` 已设 `VERIFY_ALLOW = C:\Users\Admin\AppData\Local\Temp\verifyout`。
- 单次 apply 的 verify 命令由 `?cmd=apply&verify=<命令>` 透传（`main.ts` → `coordinator.handover(..., verifyOverride)`），优先于控制面固定 `VERIFY_CMD`。

### 验证记录
- 通过：state.jsonl `verify-gate ok: ...（本次 apply 指定）` → `flip` → `已切换 → gen-<N>`。
- 拒绝：`(verify-gate 失败) 已回滚旧代 gen-<N>：...不在白名单(...)→安全拒绝` → 现役保持。
- 结果落 handover-status.jsonl / `?cmd=result`。

### 与 self_evolve 的分工
- **self_evolve**（design-canvas bridge）：面向 **design-canvas 内核源码改动**——build 独立实验内核产物 → staging 加载实验核 → verify 闸 → 通过才 flip。管"内核实验"。
- **tool_apply(verify=...)**：面向**业务改动（settings/插件/技能/记忆/工具行为）**的边缘判据验证，复用同一套控制面 verify-gate。管"业务上线决策"。
- 二者互补，都是"进化脑管控"；不造第三个并行的"实验脑"进程（避免与"生命周期不绑在同一事件循环"的教训冲突）。