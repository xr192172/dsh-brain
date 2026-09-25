# 任务 T1：给 3 个既存违规补 `isMain` 守卫（消债）

## 背景（确凿事实）
`scripts/check-import-safe.mjs` 是一道**常驻守卫**，它报出 3 个违规文件：
```
❌ scripts/eval-baseline-store.mjs   （被 scripts/capability-gate.mjs import）
❌ scripts/lib-tool-failure.mjs      （被 make-g0-preset.mjs / measure-arm-face.mjs 等 import）
❌ scripts/patch-anchors.mjs         （被 7 个脚本 import！）
```
**这为什么危险**：这些脚本在**模块顶层**就派发 CLI（`process.argv` + `process.exit()`）。
被别的脚本 `import` 时，**它们会拿 import 方的 argv 跑自己的 CLI，然后 `process.exit()`** ——
把调用方的程序**静默截断**（看起来成功，实际后面一行没跑）。本项目今天已经在 `skill-sieve.mjs`、
`skill-factory.mjs` 上各栽过一次。

## 要做什么
给这 3 个文件各加**同形**的守卫（照 `scripts/skill-sieve.mjs` 或 `scripts/skill-factory.mjs` 的写法）：
```js
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  …原有的 CLI 派发整段…
}
```
- `path` 与 `fileURLToPath` 若没 import，就补上（`import path from 'node:path'` / `import { fileURLToPath } from 'node:url'`）。
- ★ **只加包裹，不改逻辑**：当这些文件**作为主模块运行**时，行为必须与改之前**完全一致**。
- ★ 若某文件**本来就没有 CLI 派发**（守卫的判定是启发式的），**如实说明**并**不要**硬塞守卫。

## 可判定的验收（必须逐条贴真实命令输出）
1. `node --check scripts/eval-baseline-store.mjs`（同 3 个文件）⇒ 全部 exit 0
2. `node scripts/check-import-safe.mjs` ⇒ **违规 0 个**（把这一行原样贴出来）
3. 这 3 个文件里**有的**那些自测/回归脚本，改前后**都要跑**并贴输出（例如
   `node scripts/test-patch-anchors.mjs`、`node scripts/check-*` 之类；**你自己找它们各自的回归入口**）
   —— 若某文件没有回归入口，**如实说明"没有可跑的门"**，不要编。
4. `git diff --stat` 的输出（证明只动了这 3 个文件）

## 硬约束
- 只动 `scripts/eval-baseline-store.mjs`、`scripts/lib-tool-failure.mjs`、`scripts/patch-anchors.mjs` 三个文件。
- **不要**碰 `scripts/check-import-safe.mjs`（它是判据，改它等于改考试）。
- **不许** `git commit`、不许 `git push`、不许起服务、不许杀进程。
- 不确定就写「不确定」，**禁止编造**命令输出。

## 诚实清单（最后必须写）
- 你**实跑**了哪些命令（逐字贴输出）
- 哪些是**推断**（没跑过）
- 有没有你**没能验证**的东西
