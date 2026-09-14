# symbol_move —— 跨文件模块级符号移动（语义重构 第一棒）

## Context（为什么做）
你在系统性地重构乱码（safe_rename、边界不追外、prewarm 都是这条「屎山代码重构」路上的地基）。`symbol_edit` 完成了**单文件符号编辑**（原地增删改/改名）。下一步是把能力从「原地改符号」提升到「依赖图感知的结构变换」——**把符号从 A 文件挪到 B 文件**，并自动重定向所有引用。`move` 是重构族里最干净、复用现成闭包/引用定位基础最多的一棒，`extract`/`inline` 留后续。

## 方案（独立工具 `symbol_move`，不放 edit_code）
多文件原子写（源删 + 目标加 + 每个 importer 改 import source），与 `edit_code` 的单文件事务模型不同，故独立 `src/tools/symbol_move.ts`，与 `rename_symbol.ts`（重构族）同族。

**输入** `{ project_dir?, file, symbol, to_file, to_symbol?, dry_run? }`，返回 `MoveSymbolResult`（ok/source/target/redirects/externalRefs/blocked/filesWritten/dryRun）。

**主流程**
1. 路径/根/alias 解析（复用 `resolveProjectRoot`/`loadAliasConfig`）；`analyzeModuleSource` 确认 `symbol` 是模块级声明（`kind` 为 import/reexport/exported 则拒并提示去定义文件发起）。
2. **取整条定义块** `findTopLevelDeclRange`：用 `parseAstRoot` 走 module 顶层 statement 节点（`export_statement` 或各 declaration），匹配名字，返回 `startIndex..endIndex`（含 `export` 前缀与完整体）。删源文本 = 该区间。
3. 目标文件：不存在→创建（content=definition+尾换行）；存在→`analyzeModuleSource` 查撞名阻。
4. 闭包 `expandClosureDetailed(sourceAbs, root, aliasCfg)` → `{files, externalRefs}`（复用，只扩工作区、外部仅反馈）。
5. **import 重定向**：对闭包内每个 importer，用 `parseAstRoot` 定位顶层 `import_statement`/`export_statement` 的 `source` 节点；若该语句只引入目标符号（具名/默认/别名/re-export），把它 `source` 的字节区间改写为「importer → to_file」的相对路径；本地名/用法/远程名**不动**。namespace import / 一条语句同时引入其它符号 / 星号转发 → 阻断并提示分割。
6. 原子门：任一阻断 → 整体不落盘返回 `blocked`。
7. dry_run → 全预览（含源删除 diff、目标插入、每条旧→新 import）；否则逐文件写盘 + 对源/目标/受改 importer `syncFile` 重建索引。

**复用点**（不重写）：`analyzeModuleSource`/`resolveRel`/`buildNoExt`/`stripQuotes`/`applyEdits`（`rename_symbol.ts`）；`expandClosureDetailed`/`loadAliasConfig`/`resolveAliasedImport`/`resolveProjectRoot`（`project_root.ts`）；`squeezeBlankRuns`/`leadingWhitespaceOfLine`/`detectEol`/`splitKeepEnds`（`edit_code.ts`）；`syncFile`（`db/symbols.ts`）。

## v1 明确不做
- 非 TS/JS 语言（Go/Python/C#/Java/C 留后仿 rename*Symbol）。
- 声明上方 `/** */` 文档注释剥离（v1 会残留孤儿注释，v1.2 再并入）。
- `to_symbol` 改名（v1 只移动，若传入置 `toSymbolDeferred` 提示走 rename）。
- 目标文件反向 import 源文件其它符号、同源一条 import 含多符号自动拆（均阻断提示手动）。

## 关键文件
- 新增 `design-canvas-dev\src\tools\symbol_move.ts` + `design-canvas-dev\tests\tools\symbol_move.test.ts`
- 同步到 live `D:\project_develop\design-canvas`
- bridge `packages\design-canvas-bridge\src\index.ts`：`loadKernel` 暴露 `moveSymbol`，仿 `safe_rename` 注册 `move_symbol`（project_dir 兜底 + externalRefs 边界输出 + 默认安全预览）
- MCP `design-canvas-dev\src\server_registry.ts` 加 `move_symbol` 条目

## 验证
- 新增 vitest（照 `rename_external.test.ts` 骨架，仅 TS/JS）：
  - 移动定义 + 重定向 importer（源符号没了、目标有了、`import './c'` 指向目标、`analyzeModuleSource` 认出目标符号）。
  - dry_run 不落盘。
  - 阻断：目标撞名 / statement 混入其它符号 / namespace import / 星号转发 / 对非模块级符号发起 / 跨工作区外部（externalRefs 含 `ext.js` 且外部盘态不变）。
- fork `tsc` + 跑 `symbol_move.test.ts`、确认既有 edit/rename 套件不回归；同步 live + build；写完后合并成一到两个 commit 提交。

用户已确认支持该方向，仅需最终批准本计划后开始实现。