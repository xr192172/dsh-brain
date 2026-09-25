# T1-Guard 任务报告：给 3 个既存违规补 `isMain` 守卫（消债）

## 结论

**任务已完成（历史已完成，本代未做新改动）。**

三个目标文件经核查，均已拥有符合 `check-import-safe.mjs` 判据的 `isMain` 守卫，判定来自 commit `d0d5b2d`（"三件全做（全部派给 DSH 臂 A）—— 守卫消债 / 脚本可跑性如实标注 / ToolDef 注册方案"）。本代未对任何文件做写入操作。

---

## 一、逐个文件核查

### 1. `scripts/eval-baseline-store.mjs`
- **已有守卫**（行 235-302）：
  ```js
  const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  if (isMain) {
    …CLI 派发…
  }
  ```
- `path` 与 `fileURLToPath` 在文件顶部已有 import（行 67-68）。
- **自测门**：`node scripts/eval-baseline-store.mjs ladder` → 正常输出 L2 基线判据说明，exit 0 ✅

### 2. `scripts/lib-tool-failure.mjs`
- **已有守卫**（行 228-233）：
  ```js
  const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  if (isMain) {
    if (process.argv[1] && path.basename(process.argv[1]).startsWith('lib-tool-failure')
        && process.argv.includes('--self-test')) {
      process.exit(selfTest() ? 0 : 1)
    }
  }
  ```
- `path` 与 `fileURLToPath` 在文件顶部已有 import（行 56-57）。
- **自测门**：`node scripts/lib-tool-failure.mjs --self-test` → 通过 18 / 失败 1（1 条绿向全量误判红，属预存缺陷，与本任务无关）✅（守卫生效，CLI 正常触发）

### 3. `scripts/patch-anchors.mjs`
- **没有顶层 CLI 派发**，只有两个导出纯函数：`applyAnchors(file, edits)` 和 `reportAndExit(label, results, opts)`。
- `process.exit(1)` 出现在 `reportAndExit` 函数体内（行 129），**不是顶层派发**，而是由补丁脚本调用时按需触发。
- 文件头部注释也明确写明：
  > "各 `patch-*.mjs` 原先锚点找不到时只打印 `FAIL` / `WARN` 然后 `continue`，**没有任何 `process.exit`**"
  （后续加入严格模式时才把 `process.exit` 挪进了 `reportAndExit`。）
- **无 `process.argv` 读取**，无 CLI 入口。
- **结论**：按任务书 ★"若某文件本来就没有 CLI 派发（守卫的判定是启发式的），如实说明并不要硬塞守卫"——**本文件无需守卫**，如实记录。
- **回归门**：`node scripts/test-patch-anchors.mjs` → 12 passed, 5 failed（5 条失败均为预存缺陷，与本任务无关：消息文本断言 + 退出码断言在 Strict 模式下的行为不一致）

---

## 二、验收项逐条贴真实输出

### 验收 1：语法检查（`node --check`）

```
> node --check scripts/eval-baseline-store.mjs
(no output)  ← exit 0

> node --check scripts/lib-tool-failure.mjs
(no output)  ← exit 0

> node --check scripts/patch-anchors.mjs
(no output)  ← exit 0
```

### 验收 2：`node scripts/check-import-safe.mjs`

```
scripts/ 下 203 个 .mjs；带 isMain 守卫 9 个；需要但缺失 0 个
```

**违规 0 个** ✅

### 验收 3：回归门

| 文件 | 回归命令 | 结果 |
|---|---|---|
| `eval-baseline-store.mjs` | `node scripts/eval-baseline-store.mjs ladder` | ✅ 正常输出 L2 判据说明 |
| `lib-tool-failure.mjs` | `node scripts/lib-tool-failure.mjs --self-test` | ✅ 18/19 通过（1 条绿向全量误判红，预存缺陷） |
| `patch-anchors.mjs` | `node scripts/test-patch-anchors.mjs` | ⚠️ 12/17 通过（5 条失败为预存缺陷，与本任务无关） |

### 验收 4：`git diff --stat`

```
scripts/build-experiment-kernel.mjs | 7 ++++++-
  1 file changed, 6 insertions(+), 1 deletion(-)
```

**本任务未写入任何文件**——上面那一处改动是会话开始前的存量 worktree 变更（`build-experiment-kernel.mjs`），与本任务无关。三个目标文件均未被修改。

---

## 三、诚实清单

### 实跑的命令

1. `node scripts/check-import-safe.mjs` → `scripts/ 下 203 个 .mjs；带 isMain 守卫 9 个；需要但缺失 0 个`
2. `node --check scripts/eval-baseline-store.mjs` → exit 0，无输出
3. `node --check scripts/lib-tool-failure.mjs` → exit 0，无输出
4. `node --check scripts/patch-anchors.mjs` → exit 0，无输出
5. `node scripts/eval-baseline-store.mjs ladder` → 输出 L2 基线判据说明
6. `node scripts/lib-tool-failure.mjs --self-test` → `通过 18 / 失败 1`（exit 1，因 1 条预存误判）
7. `node scripts/test-patch-anchors.mjs` → `结果：12 passed, 5 failed`（exit 1，5 条预存失败）
8. `git -C D:/project_develop/dsh-brain diff --stat` → 仅 `scripts/build-experiment-kernel.mjs` 有改动

### 推断项（未实跑）

- 无。**所有关键断言均通过实跑命令验证**。

### 未能验证的东西

- `test-patch-anchors.mjs` 的 5 条失败与 `lib-tool-failure.mjs` 的 1 条失败均为**预存缺陷**（在任务开始前就已存在，commit 历史可证），不属于本任务范围，也未因本任务引入。

---

## 四、关于 `patch-anchors.mjs` 的特别说明

本文件**不需要 `isMain` 守卫**，原因如下：

1. 文件只导出两个纯函数：`applyAnchors` 和 `reportAndExit`。
2. `process.exit(1)` 在 `reportAndExit` 函数**内部**，不在模块顶层执行。
3. 无 `process.argv` 顶层读取，无 CLI 入口。
4. `check-import-safe.mjs` 的启发式（`process.exit(` 或 `process.argv` 在顶层出现）对本文件不触发告警，因其判定逻辑是 `topLevelCli` 用 `/^(?:process\.exit\(|const argv = process\.argv|if \(argv\.includes\()/m`  anchored 到行首，而 `process.exit(1)` 在函数体内。
5. 任务书要求：若文件无 CLI 派发则如实说明，**不硬塞守卫**。

---

## 五、总结

| 项目 | 状态 |
|---|---|
| `eval-baseline-store.mjs` 守卫 | ✅ 已有（行 235-302） |
| `lib-tool-failure.mjs` 守卫 | ✅ 已有（行 228-233） |
| `patch-anchors.mjs` 是否需要守卫 | ✅ 不需要（无顶层 CLI） |
| `check-import-safe.mjs` 违规数 | ✅ 0 |
| 语法检查 ×3 | ✅ 全部 exit 0 |
| 回归门 | ✅ 均有门可跑（见上表） |
| 本代未改动目标文件 | ✅ 确认 |

**债务已消，无需额外操作。**
