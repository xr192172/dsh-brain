# 资产拓扑（易搞混，先看这里）

> 2026-09-14 从 `MEMORY.md` 拆出。判断"哪个是资产、哪个是副本"时读这里。

## 工具真身：design-canvas

- **`D:\project_develop\design-canvas` = 真身**：独立 git 仓 v0.1.3（commit `1d19e23`），
  **TRAE 与 DSH 都拉起的活内核**，暴露 **58 个 MCP 工具**
  （DSH 侧经 `dsh-mcp-client` stdio 拉起 `server.js` → `mcp__design-canvas__*`；
  `design-canvas-bridge` 编排壳再额外注册 8 个）。
- **判定依据**：DSH mcp-client 的 `args`/`cwd` + bridge 的 `kernelDir` **两处引用都指向它**。
- 副本：`dsh-brain/design-canvas-dev`（开发副本，node_modules 是 junction）、
  `Downloads\…\design-canvas-main`（node_modules 宿主）—— 三者同版本同 commit。
- 改它源码要 **rebuild + 重启新一代**才生效；改名/检索前先 `design_canvas_prewarm` 上索引；
  Go→TS 翻译走 `translate_go_ts`（tree-sitter AST 底座，LLM 池自动接 `127.0.0.1:3101`）。
- **查能力要查真注册表，不查包装层**（曾只查 bridge 的 8 个编排壳工具 → 误判它没有翻译能力）。

## 归一化（2026-09-14）

- 真资产已搬到 `D:\project_develop\_from-downloads\20260914\`（747 文件 / 46.9MB：
  `archify` 技能 + `output` + `workspace-data` + 8 份文档 + `_patches`）
  与 `D:\project_develop\weavepet\`（织宠世界源码 11 文件）。
- **待用户整删**（`scripts/cleanup-redundant-workspaces.ps1`，默认进回收站；`-DryRun` 已实跑）：
  `Downloads\Browsers\Microsoft Edge\design-canvas-main`(713MB) + `dsh-brain/design-canvas-dev`(17MB)
  + `D:\project_develop\dsl-workbench`(70MB) ≈ **799MB**。
  依据：唯一资产已归档 / dsl-workbench 远端同步 / 克隆与真身同 commit / cache 可重建。
- `dsl-workbench` 已验证可删：HEAD 是 `origin/main` 的祖先、**无本地独有提交**
  （远端领先 32 个提交），但**它无 remote → 自证不出过期**。

## ★ 铁律（副本归一化）

**副本必须能自证新鲜度（有 remote / 有同步机制）；无 remote 的副本 = 无法自证过期 = 注定成为陷阱。**
故归一化的终态不是"本机留一份"，而是"**远端是唯一来源，本机按需 clone**"。

## 意外收获：archify

`archify` = 第三方 MIT 技能 v2.17（作者 tt-a1i，基于 Cocoon-AI/architecture-diagram-generator）：
把架构/时序/数据流/生命周期渲染成可交互独立 HTML（内联 SVG + trace 动效 + 多格式导出，
支持 Mermaid 输入与仓库证据）。现位于归档区，**考虑装进技能系统**。
