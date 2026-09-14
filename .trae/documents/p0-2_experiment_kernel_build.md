# P0-2 · 实验脑构建链路：改动 → 独立内核产物 → 实验 gen 加载测试 → 通过合并

## Context（为什么做）
自进化要让"生产脑改内核代码 → 实验脑加载改动后的内核做验证 → 通过才合并"，但现役 gen 加载的是
**共享** design-canvas dist（bridge `kernelDir` 指向它）——直接改会污染现役。用户已拍板**轻量 diff-apply**、
不 fork 两套 DSH。本 plan 打通「实验内核产物」这条最小编链：把一个改动建成**独立内核产物目录**，
再让一个实验 gen 让它做 `kernelDir` 加载它、跑验证、通过后合并回生产。它是三脑（three-brain-evolution.md
§5.2）与验证契约（I1/I2/I3）落地的代码层第一块。

结论已探明：gen 加载内核 = bridge `loadKernel(kernelDir)` 动态 import `<kernelDir>/dist/src/tools/*.js`
（`design-canvas-bridge/src/index.ts:177-192`）；kernelDir 默认空、从配置读。所以"实验脑加载改动后内核" = 
让实验 gen 的 kernelDir 指向一份**独立** dist 产物。

## 方案（最小可行：先测 design-canvas 内核改动）
### 1. 让 bridge 的 kernelDir 可被逐 gen env 覆盖 —— `packages/design-canvas-bridge/src/index.ts`
- 在解析 `config.kernelDir` 处加 env 兜底：`process.env.DESIGN_CANVAS_KERNEL_DIR` 非空则优先用它。
  → 这样 switchboard 可用 `GEN_ENV_EXTRA` 给某个（实验）gen 单独注入 `DESIGN_CANVAS_KERNEL_DIR=<独立产物>`，
  而不影响其它（生产）gen 的共享内核。

### 2. 新增"实验内核产物"构建脚本 —— `scripts/build-experiment-kernel.mjs`
- 输入：`--src <production src dir>`（如 design-canvas）、`--base dist`、`--patch <diff 文件或 .mjs>`、`--out <EXPT_ROOT>`。
- 做法（依赖"改动如何给"）：
  - A（改 TS 源，推荐）：复制 src → 应用 diff 到副本 src → `tsc --outDir <EXPT_ROOT>/dist` 建出独立 dist。
  - B（只改产物 .js）：复制 `<base>/dist` → 用 diff 直接改 `<EXPT_ROOT>/dist/src/tools/*.js`（改动仅是产物时更快）。
- 产出：一个含 `dist/src/tools/*.js` 的 `EXPT_ROOT`，即为"实验内核产物"。

### 3. 触发"实验 gen + 验证" —— 复用 switchboard
- 复用 `spawnGen`（`switchboard/src/spawner.ts`），为该实验 gen 注入 env：`DESIGN_CANVAS_KERNEL_DIR=<EXPT_ROOT>`（经 GEN_ENV_EXTRA）。
- 用 §1 的 env 覆盖，实验 gen 即加载实验内核；跑 `verifyCmd`（复测 run_tests + memory_observe）做 I2 判定。
- 通过 → 把该 diff 并入生产内核（收 diff），再正常 flip。不通过 → 丢弃 EXPT_ROOT，现役不变（I3）。

### 4.（可选，P0-3 合并到同一批）verifyCmd 白名单
- 本轮可顺带加 `verifyAllowList`（只允许已知路径脚本），避免 spawn 任意命令；不动则留 P0-3 单独做。

## 关键文件
- `packages/design-canvas-bridge/src/index.ts`（kernelDir 加 `DESIGN_CANVAS_KERNEL_DIR` env 兜底）
- 新增 `scripts/build-experiment-kernel.mjs`（复制/diff-apply/tsc 出独立 dist）
- 复用：`switchboard/src/spawner.ts`（spawnGen + GEN_ENV_EXTRA）、`design-canvas-bridge loadKernel`

## 验证
- `build-experiment-kernel`：对一个设计画布 TS 改动（如给一个工具加一行日志），产出 EXPT_ROOT/dist → 断言含改动后产物且 `tsc` 无错。
- 冒烟：一个实验 gen 以 `DESIGN_CANVAS_KERNEL_DIR=<EXPT_ROOT>` 起，`memory_observe`/`symbol_edit` 等因素从 EXPT_ROOT/dist 加载（可通过给改动产物加可辨识标记验证"吃的是实验产物"）。
- 回归：不设 env 时，普通 gen 仍加载共享内核（行为不变）。
- 端到端：走一次"改动→实验内核→实验 gen 测试→ok→合并"，再走一次"改错→测试不过→现役不变"。

## 待确认/风险
- 自进化当前"生产脑改代码"的具体改动对象是 design-canvas 内核还是 dsh-brain 包？本 plan 先聚焦 design-canvas 内核改动（最小、最快）；dsh-brain 包（bridge/switchboard）的改动产物机制偏 P0-3。
- diff 的"给法"先定为文件/patch 路径；若最终由脑自行产出，则把它接到某个 apply 工具上（设计时留扩展点）。