# 自进化·验证闸 —— 待 DSH 评审的计划

> 用途：这份文档是给 DSH（DeepSeek Harness）做技术评审用的。审完请把意见带回来，
> 我们据以修订后再实现。评审请聚焦：方案是否成立、有没有漏掉的坑、指标与安全账是否算对。

## 1. 目标（一句话）
让蓝绿交接的 `verify` 阶段不只"探活"，而是能验证"功能没坏 + 指标没变差"，通过才切生产——这是
**系统自进化**闭环里的"验证环"（实验 → 验证 → 才 flip 生产）。

## 2. 背景与现状
- switchboard（`packages/switchboard`）做蓝绿交接：`spawn staging gen → waitCatchUp → freeze →
  promote → flip → verify → retire`。
- `verify` 目前只对 staging 做 HTTP `probe`（+ 可选 `verifyStableMs` 二次探活），过不了就走
  `rolled-back` 回滚（`swapActive(old)` + `recordResult` 已存在）。
- 问题：探活只证明"进程活着"，不证明"功能/性能没退化"。

## 3. 方案（验证闸 = 外部可配置命令钩子）
关键约束：**switchboard 与 design-canvas 是两个独立仓库/进程**，coordinator 无法 import design-canvas
内核，所以验证闸做成一个**外部命令脚本**（coordinator 只 spawn、读 JSON、按阈值判 flip/回滚）。

- 扩展 `CoordinatorConfig`：`verifyCmd?`、`verifyCwd?`、`verifyTimeoutMs?`、`verifyMetrics?`。
- verify 阶段（`coordinator.ts` 现有 probe 处）：
  - 若配置 `verifyCmd` → spawn（cwd=staging genDir；env 注入 `STAGING_INSPECT_PORT`/`ACTIVE_INSPECT_PORT`/`STAGING_PORT`；超时）→ 读 stdout JSON `{ ok, passRate?, metrics?{rssMb,heapUsedMb}, reason? }`。
  - 判定（AND）：`ok===true` 且（若配 `passRateMin`→`passRate>=min`）且（若配 `rssDeltaMb`/`heapDeltaMb`→ 相对 active 基线不超）。
  - 任一不过 → 走现有 `rolled-back` 回滚；结果并入 `recordResult`，落 `handover-status.jsonl`（这就是自进化"实验→验证→采纳/回滚"记录第一版）。
  - `verifyCmd` 为空 → 维持现有 probe-only（向后兼容）。
- env→config（`main.ts`）：`VERIFY_CMD`/`VERIFY_CWD`/`VERIFY_TIMEOUT_MS`/`VERIFY_PASS_RATE_MIN`/`VERIFY_RSS_DELTA_MB`/`VERIFY_HEAP_DELTA_MB`。
- 示例验证脚本（复用 design-canvas 的 `run_tests` + `memory_observe` 采样，输出上述 JSON）。

## 4. 指标"怎么算"（请 DSH 重点审这个）
建议的判定集，先抓"不能更差"：
1. 存活：probe（已有）
2. 回归：`run_tests` 通过率 ≥ active 基线，且关键套件全绿（`RunTestsResult { ok, passed, failed }`）
3. 内存：`memory_observe` 采 staging RSS/heapUsed，相对 active 基线不超阈值
4. 判定：`测试过 且 指标不差于基线` → flip；否 → 回滚
- 待审问题：这个"指标集合 + 阈值 + 基线来源"是否合理？基线由 verifyCmd 脚本自行采集/对比是否可行？
  有没有更简单却更可靠的"变好了/没变坏"判定？

## 5. 风险与边界（请 DSH 审）
- **实验隔离是第二棒**：本计划只加"验证这关怎么过"，不解决"DSH 改自己代码改到哪 / 如何并入生产仓库"。
- **安全**：verifyCmd 是显式配置、由 coordinator spawn——需确认对"任意命令由配置驱动执行"可接受。
- **回滚兜底已有**，但若 staging 已 flip 后才发现 stale，是否够？verifyStableMs 二次探活是否要保留。
- **自进化记录的完整性**：目前只把 verify 结果落 handover-status.jsonl；"改了哪些 diff"、"指标历史"是否要一并落，供 DSH 回溯。

## 6. 验证方式
- switchboard build 通过。
- 集成 e2e：`VERIFY_CMD` 设"成功"脚本 → apply → success 记录；设"失败"脚本 → apply → rolled-back；
  不设 → 行为不变。
- 重启控制面生效。

## 7. 请 DSH 明确回答的问题
1. 方案整体是否成立？有无更轻/更稳的替代？
2. "验证闸"作为自进化第一棒，范围切得对不对（实验隔离是否必须同批做）？
3. 指标集合/阈值/基线怎么定最务实？
4. 把验证结果落 handover-status.jsonl 够不够当"自进化记录"？
5. 有无未覆盖的失败路径或安全坑？