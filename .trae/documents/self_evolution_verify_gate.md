# 自进化·验证闸：switchboard 蓝绿交接 verify 升级为「测试 + 指标」门槛

## Context（为什么做）
自进化的核心链路要能"实验 → 验证 → 才切生产"。switchboard 的蓝绿交接已有
`spawn staging gen → waitCatchUp → freeze → promote → flip → verify → retire`，`verify` 目前
只对 staging 做 HTTP `probe` 探活（+ 可选 `verifyStableMs` 二次探活），过不了就 `rolled-back` 回滚。
问题：探活只证明"进程活着"，不证明"功能没坏 / 没变糟"。本 plan 把 verify 升级成一个**可选的
测试+指标闸**：staging 代除了存活，还要"目标测试通过 + 内存等指标不差于 active 基线"，才 flip；
否则回滚。这就把自进化的"验证环"接上了，默认关闭、不影响现有交接行为。

边界：switchboard 与 design-canvas 是**独立仓库/进程**，coordinator 不能 import design-canvas 内核。
因此验证闸 = **外部可配置命令（脚本）**：脚本在 staging 上跑 `run_tests` + 用 `memory_observe`
采内存，输出 JSON 交给 coordinator 判定。coordinator 只负责 spawn、读结果、按阈值判 flip/回滚。

## 方案
### 1. CoordinatorConfig 扩展 —— `packages/switchboard/src/coordinator.ts`
在现有 `CoordinatorConfig`（含 `verifyStableMs` 等）上加：
- `verifyCmd?: string`（验证命令；留空=维持现有 probe-only 行为）
- `verifyCwd?: string`（命令工作目录，缺省 staging genDir）
- `verifyTimeoutMs?: number`（spawn 命令超时，默认 120_000）
- `verifyMetrics?: { rssDeltaMb?: number; heapDeltaMb?: number; passRateMin?: number }`
  （可选指标阈值；未配置则由命令返回的 `ok` 一票定夺）

### 2. 验证闸实现 —— `coordinator.ts` 的 verify 阶段（L255 附近）
- 在现有 `probe` 之前/并行，若配置了 `verifyCmd`：
  - `spawn`（复用 spawner 同款惰性启动方式，`cwd=verifyCwd??b.inst.genDir`，env 注入
    `STAGING_INSPECT_PORT`（b.inst 的 inspect）、`ACTIVE_INSPECT_PORT`（active 的 inspect）、
    `STAGING_PORT`；超时 `verifyTimeoutMs`）。
  - 读 stdout JSON：`{ ok: boolean; passRate?: number; metrics?: { rssMb?: number; heapUsedMb?: number }; reason?: string }`。
  - 判定（AND）：
    - `verifyCmd` 脚本自身 `ok === true`（内含测试通过/内存采到）；
    - 若配置 `verifyMetrics.passRateMin` → `passRate >= min`；
    - 若配置 `rssDeltaMb`/`heapDeltaMb` → `metrics.rssMb - activeBaselineRss <= rssDeltaMb` 等。
  - 不满足任一 → 走现有 `swapActive(old)` + `recordResult(rolled-back)` 回滚（已存在的非破坏回滚代码），并把 verify 结果记入回滚备注。
- 否则保持现有 probe/verifyStableMs 行为（向后兼容，verifyCmd 为空即跳过闸）。
- 把 `{ ok, passRate, metrics, reason }` 并进 `recordResult` 笔记，落 `handover-status.jsonl` —— 这就是"自进化记录"第一版：每次 apply 留一条{实验→验证→采纳/回滚}。

### 3. env → config —— `packages/switchboard/src/main.ts`
在现有 env 组装 CoordinatorConfig 处（L170-189）加：
- `VERIFY_CMD` / `VERIFY_CWD` / `VERIFY_TIMEOUT_MS` / `VERIFY_PASS_RATE_MIN` / `VERIFY_RSS_DELTA_MB` / `VERIFY_HEAP_DELTA_MB` → 注入 config。
（与 `SWITCH_VERIFY_STABLE_MS` 同风格。）

### 4. 示例验证脚本（供接线，放 docs 或 scripts）
- `scripts/verify-gate.example.mjs`：示例——用 design-canvas 的 `run_tests` 跑目标套件、用
  `memory_observe` 采样 staging 的 `STAGING_INSPECT_PORT`，输出 `{ ok, passRate, metrics }` JSON。
  （供集成自测用；真实测试命令由使用者替换。）

### 不做（保持克制/第二棒）
- **不做实验隔离 + 分支合并**（改的是生产仓库还是实验仓库——归"实验隔离"第二棒）。
- **不做 DSH 改自己代码的编排**：本 plan 只提供"验证这关怎么过"，"谁来改、改成什么样"由外部驱动。
- **不做内存基线自动存库**：active 基线由 verifyCmd 脚本自行携带/采样，或通过 env 给脚本传 active 端口让它对比，coordinator 不再管基线持久化。

## 关键文件
- `packages/switchboard/src/coordinator.ts`（CoordinatorConfig 扩展 + verify 闸实现 + 回滚并联）
- `packages/switchboard/src/main.ts`（env → config 映射）
- `packages/switchboard/src/spawner.ts`（确认 staging 已带 inspectPort，可复用；不强制改）
- `scripts/verify-gate.example.mjs`（示例验证脚本；design-canvas 的 `run_tests` + `memory_observe` 复用）

## 验证
- `packages/switchboard` build 通过（产物 out/<id>/main.js）。
- 单测（若 switchboard 有 vitest）：verify 判定——用构造的 verifyCmd 输出判定 flip vs rolled-back；含
  阈值（passRateMin / 内存差）与"verifyCmd 为空→绕过闸"。
- 集成（脚本 e2e）：
  1) 起控制面（scripts/start-switchboard.ps1），设 `VERIFY_CMD` 指向一个"成功"脚本 → 触发 `apply`
     → 观察交接 success（handover-status.jsonl 记 ok=true）。
  2) `VERIFY_CMD` 指向"失败"脚本 → `apply` → 观察 rolled-back（旧 active 继续服务，日志/status 记回滚+原因）。
  3) 不设 `VERIFY_CMD` → `apply` → 行为与现有一致（probe-only），回归无破坏。
- 重启控制面生效；记录到文档/主回答。

用户已确认第一棒范围（验证闸；实验隔离放第二棒），仅需审批本计划后实现。