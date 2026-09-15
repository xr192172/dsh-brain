# 资产拓扑（易搞混，先看这里）

> 2026-09-14 从 `MEMORY.md` 拆出。判断"哪个是资产、哪个是副本"时读这里。

## 工具真身：design-canvas

- **`D:\project_develop\design-canvas` = 真身**：独立 git 仓 v0.1.3（commit `1d19e23`），
  **TRAE 与 DSH 都拉起的活内核**，暴露 **58 个 MCP 工具**
  （DSH 侧经 `dsh-mcp-client` stdio 拉起 `server.js` → `mcp__design-canvas__*`；
  `design-canvas-bridge` 编排壳再额外注册 8 个）。
- **判定依据**：DSH mcp-client 的 `args`/`cwd` + bridge 的 `kernelDir` **两处引用都指向它**。
- **★ 2026-09-15 实证：在 `D:\project_develop` 根上 Glob/Grep 搜不到真身**（`*/src/tools/*.ts` 只命中
  dev 副本；原因未明，疑似搜索工具默认忽略规则）⇒ 定位资产**只信本文件**，动工前在候选仓 grep
  本轮特有符号（如 firstContactBackfill）二次验明真身，别拿第一个命中当真身。
- 副本：`dsh-brain/design-canvas-dev`（开发副本，node_modules 是 junction）、
  `Downloads\…\design-canvas-main`（node_modules 宿主）—— 三者同版本同 commit。
- 改它源码要 **rebuild + 重启新一代**才生效；改名/检索前先 `design_canvas_prewarm` 上索引；
  Go→TS 翻译走 `translate_go_ts`（tree-sitter AST 底座，LLM 池自动接 `127.0.0.1:3101`）。
- **查能力要查真注册表，不查包装层**（曾只查 bridge 的 8 个编排壳工具 → 误判它没有翻译能力）。

## 归一化（2026-09-14）

- 真资产已搬到 `D:\project_develop\_from-downloads\20260914\`（747 文件 / 46.9MB：
  `archify` 技能 + `output` + `workspace-data` + 8 份文档 + `_patches`）
  与 `D:\project_develop\weavepet\`（织宠世界源码 11 文件）。
- **★ 用户拍板（2026-09-15）：手动删，脚本不再执行**。脚本实跑中断在 Step 2
  （PS 5.1 `Remove-Item -Force` 删 Junction 抛异常 + EAP=Stop 终止，三目标未删）；
  Junction 后用 `.NET [System.IO.Directory]::Delete(path, $false)` **安全解链**（只删重解析点，
  目标验证存活）⇒ ①② 手动删除已互不影响。手动删清单（建议进回收站）：
  `Downloads\Browsers\Microsoft Edge\design-canvas-main`(713MB/17434 文件) +
  `dsh-brain/design-canvas-dev`(17MB，已解链) + `D:\project_develop\dsl-workbench`
  （现仅残余 63 文件/2MB，.git 已不在；未提交改动 patch 在归档区）。
  清单外顺带可删（均验证无独有内容）：Downloads 的 `archify/`（上游公开仓可再 clone）、
  `weavepet/`（空壳）、`design-canvas-main.zip`（8/27 过期 zip）。
  依据：唯一资产已归档 / dsl-workbench 远端同步 / 克隆与真身同 commit / cache 可重建。
- `dsl-workbench` 已验证可删：HEAD 是 `origin/main` 的祖先、**无本地独有提交**
  （远端领先 32 个提交），但**它无 remote → 自证不出过期**。

## ★ 删除前内容级验证（2026-09-15，blob 级铁证）

- **dev 副本 vs 真身**：47 个差异/独有文件中，**43 个的 dev 版本 blob 全部存在于真身 git 对象库**
  （`git hash-object` + `cat-file -e` 逐个验证）⇒ dev = 纯旧快照，**没有需要合并的改动**。
  仅 4 个 dev 独有 = 一次性诊断小文件（`_diag.mjs` 68B / `_scan_diag.mjs` 514B /
  `tests/_diag.test.ts` / `tests/_sigfix.test.ts` 各 522B）；其中 `_sigfix` 守护的
  "buildSignature 双冒号"修复已实测存在于真身 dist（签名输出无 `: :`）⇒ 4 个皆可弃。
- **方法可复用**：证明"副本没有独有内容"不要比 mtime，要 `hash-object` 副本文件 →
  `cat-file -e` 查真身对象库；blob 在 = 该内容可随时从真身历史恢复。
- **Downloads 残留（不在清理脚本目标内）**：`archify/` = 带上游 .git 的完整仓库，
  归档区 `.agents/skills/archify/` = 其**内层 `archify/` 目录的字节级副本**（0 个文件内容差异），
  上游为公开 GitHub 仓可再 clone ⇒ 可删但脚本不含它；`weavepet/` = 空壳
  （package.json 0 字节、其余文件是 D:\project_develop\weavepet 的子集）⇒ 无价值；
  `design-canvas-main.zip`(1.5MB, 8/27) = 过期 zip。dev 的 `.design-canvas` 仅 68K cache，无成果数据。

## ★ 铁律（副本归一化）

**副本必须能自证新鲜度（有 remote / 有同步机制）；无 remote 的副本 = 无法自证过期 = 注定成为陷阱。**
故归一化的终态不是"本机留一份"，而是"**远端是唯一来源，本机按需 clone**"。

## 意外收获：archify

`archify` = 第三方 MIT 技能 v2.17（作者 tt-a1i，基于 Cocoon-AI/architecture-diagram-generator）：
把架构/时序/数据流/生命周期渲染成可交互独立 HTML（内联 SVG + trace 动效 + 多格式导出，
支持 Mermaid 输入与仓库证据）。现位于归档区，**考虑装进技能系统**。
