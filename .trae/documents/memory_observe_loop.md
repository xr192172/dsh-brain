# memory_observe 闭环：自动托管（持续采样 → 阈值判定 → 主动提醒）

## Context（为什么做）
gen 进程偶发内存暴涨（曾 10GB），现有 `memory_observe` 是被动的（要人/agent 手动调）。用户要"自动托管"：
**持续运行、出问题直接提醒**，而不是等出问题再查。架构沿用已定结论——**观测放 design-canvas 侧**（外部 CDP 看 gen 的
`--inspect`），不内置到 DSH。

关键复用件已探明：
- `memory_observe.ts`：`memoryObserveHandler`（target 经 CDP 采样 RSS/heapUsed/external + track 增量/泄漏方向判定）。
- `daemon.ts`：已是常驻进程，`setAlertListener((a) => srv.broadcast('watch-alert', a))` → SSE `/api/events` 实时广播。
- `alert_inbox.ts`：`pushAlert(...)` 入箱 + 触发 listener（SSE）+ **下一次任意 MCP 工具响应自动附带未读提醒**（`appendPendingAlerts`）——"gen 下次调工具自己看到内存告警"即真正的自动托管自提醒。

## 方案（闭环 = 常驻采样循环 + 阈值 + pushAlert 双通道提醒）
### 1. 抽象可复用采样函数 —— `design-canvas-dev/src/tools/memory_observe.ts`
- 从 `memoryObserveHandler` 抽出纯函数 `sampleRemote(target): Promise<RemoteSample>`（连接 `--inspect` 端口 ws，`Runtime.evaluate` 内存表达式，返回 `{ rss, heapUsed, heapTotal, external, arrayBuffers, t }`），供工具与 daemon 循环共用（不重复实现 CDP 连接）。

### 2. 阈值判定 —— 新增 `design-canvas-dev/src/daemon/memory_watch.ts`
- 纯函数 `judgeLeak(series: RemoteSample[]): 'ok' | 'suspicious-native' | 'leak' | 'grow'`：
  - `grow`：RSS 相对首个 baseline 增幅 ≥ `memory_watch.rss_delta_mb`（默认 1024MB）。
  - `leak`：`heapUsed` 连续 `memory_watch.leak_runs`（默认 3）个采样单调上升，且末次采样对比基线不复低。
  - `suspicious-native`：RSS 涨但 heapUsed 基本平稳（external/arrayBuffers 主导）——提示查 native。
  - 其余 `ok`。
- `startMemoryWatch(opts)`：`setInterval(intervalMs)` 循环：
  - target 自动来自 `memoryTargets()`（扫描带 `--inspect` 的 node 进程，可能多个 gen），或显式 `opts.targets`。
  - 每个 target 维护 `baseline` + 滚动序列；`judgeLeak` 命中非 ok → `pushAlert({ project_dir: <'gen@'+target>, seq, line: <内存告警文案>, created_at })`。
  - 告警防抖：同 target 命中置 `lastAlertAt`，`memory_watch.min_alert_gap_ms`（默认 5min）内不再重复压箱。

### 3. daemon 接入 —— `design-canvas-dev/src/daemon/daemon.ts`
- `main()` 里（在 `setAlertListener` 桥之后）按环境变量启动：
  - `DESIGN_CANVAS_MEMORY_WATCH=0` 关闭（默认开）；
  - `MEMORY_WATCH_INTERVAL_MS`（默认 60000）、`MEMORY_WATCH_RSS_DELTA_MB`（1024）、`MEMORY_WATCH_LEAK_RUNS`（3）、`MEMORY_WATCH_MIN_GAP_MS`（300000）。
- 复用已有 `setAlertListener(a => srv.broadcast('watch-alert', a))` → 告警经 SSE `/api/events` 实时推给订阅端；同时入 alert_inbox → 下一次 MCP 工具响应自动附带（DSH gen 自己收到）。

### 4. 工具补全（观察/定位）
- `memory_observe` 的 `snapshot` 已有；补一条提示：告警文案里指向"可对该 target 跑 `memory_observe(action=snapshot)` 落堆快照定位泄漏对象"。不新增动作，只丰富告警可操作性。

### 不做（保持克制）
- 不自动杀进程/自动 GC/自动重启（只提醒，不动手——避免误判误伤）。
- 不做 DSH 内置自查（沿用"外部观测"架构）。
- 不做复杂机器学习趋势预测（阈值判定够用）。

## 关键文件
- `design-canvas-dev/src/tools/memory_observe.ts`（抽 `sampleRemote`；复用现 CDP 连接）
- 新增 `design-canvas-dev/src/daemon/memory_watch.ts`（`judgeLeak` + `startMemoryWatch`）
- `design-canvas-dev/src/daemon/daemon.ts`（main 启动 memory watch，环境变量控开关/间隔/阈值）
- 复用：`alert_inbox.pushAlert/setAlertListener`、daemon `srv.broadcast`、`memoryTargets()`、`appendPendingAlerts`

## 验证
- 单测（vitest，新 `tests/daemon/memory_watch.test.ts`）：`judgeLeak` 对构造的采样序列断言 grow/leak/suspicious-native/ok 四态；含防抖（同 target 短间隔不重复告警）。
- 集成：起一个临时 `node --inspect=<端口>` 进程并刻意堆增，启动 daemon → 观察：
  1) `POST /api/alerts?since=` 出现该告警（游标可拉）；
  2) `GET /api/events`（SSE）收到 `watch-alert` 事件；
  3) 对 daemon 触发一次任意 MCP 工具响应，尾部自动附带该内存提醒（`appendPendingAlerts` 生效）。
- 回归：现有 `memory_observe` 工具（status/baseline/track/gc/snapshot）不回归。
- 同步 fork→live、`npm run build`（live 缺 gen_*.mjs 的构建问题用 tsc 出 dist），测试全绿后提交。

用户已确认方向（design-canvas 侧、自动托管、出问题直接提醒），仅需审批本计划后实现。