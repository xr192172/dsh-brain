# dsh-brain — 长期项目笔记（**索引**）

在 DeepSeek Harness (DSH) 底座上，把 agent-shell 工程思路解耦重做成 Cordis 插件：
三脑编排 / 上下文压缩 / 工具自进化 / 护栏 / LLM 路由。

> **本文件是索引，不是全文。** 细节按主题拆到 `topics/`，**按需读，不要一次全读**。
> 原始日更记录（append-only）：`2026-09-13.md`、`2026-09-14.md`。

## 环境约束（本机工具层，每次都要遵守）

1. **Bash 工具 PATH 被破坏**：任何 Bash 调用开头先
   `export PATH="/c/Windows/System32:/c/Windows:/usr/bin:/bin"`，否则 `dirname/grep/head` 全 not found。
2. **PowerShell 工具 stdout 会被吞**：一律把结果写文件再用 Read 读。
3. **不要在工具内启动长期后台服务**：进程会在调用结束时被回收；`schtasks`、`cmd start`、
   `Invoke-CimMethod Win32_Process.Create` 全被安全策略拦。**⇒ switchboard 只能由用户终端启动。**
4. 排查会话内容时**不要**把 node 的 stdout 重定向到文件（会被判为二进制）——让脚本自己 `fs.writeFileSync`。
5. `grep -oE` / `find` 在这台 shell 不可靠 → 提取文本用 node 脚本，别用 grep 的正则扩展。
6. **★ git 有两份，clone/fetch 必须用系统 git**：`~/.workbuddy/binaries/PortableGit`
   （`2.55.0.windows.3`）**写嵌套 ref 路径时静默失败** —— `git fetch` 报
   `* [new branch] main -> origin/main`，但 `git branch -r` 是空的、ref 根本没落盘，
   且 `update-ref` **rc=0 不报错**。系统 git `C:\Program Files\Git`（2.45.2）正常。
   ⇒ **clone/fetch 显式用 `& 'C:\Program Files\Git\cmd\git.exe'`**，
   且**任何 clone/fetch 之后必须验 `git branch -r` 非空**。
7. **`git -C` 不认 MSYS 路径**：写 `/d/xxx` 会报 `fatal: cannot change to '...': No such file
   or directory` —— **这个报错极易被误判成"目录不存在"**（我踩过，据此下了错误结论）。
   一律用 `D:/...` 或 `D:\...`。
8. **工作区目录约定**：`D:\project_develop` 是唯一开发根；**`_` 前缀 = 非项目**
   （`_archive` 待删 / `_scratch` 一次性 / `_from-downloads` / `_research`）。
   原则：**远端是唯一真相源，本地只是可丢弃的工作副本**；详见 `D:\project_develop\README.md`。
   工作区体检：`scripts/scan-workspace-root.mjs`。

## 铁律（违反会立刻坏事）

1. **写 json/yaml/源码一律用 node `fs.writeFileSync(p, s, 'utf8')`（不加 BOM）。**
   PowerShell 5.1 的 `Set-Content -Encoding UTF8` **必加 BOM** → DSH `JSON.parse` 崩 → **gen 起不来**。
   **★ 唯一反向例外：`.ps1` 必须【带】BOM** —— PS 5.1 不按 UTF-8 读无 BOM 的 `.ps1`，而是按 ANSI(GBK)
   解码 → 中文乱码 → GBK 双字节吃掉引号 → **语法错误**（实测报 12 处）。`scripts/check-bom.mjs`
   已做**双向**检查（剥数据文件 BOM + 给 `.ps1` 补 BOM，跳过 0 字节文件），`--fix` 一次修两侧。
2. **profile 的 `cordis.patch.yml` 不得写包内已 `insert` 的同一 id** → `duplicate loader entry id`
   → 整棵插件树装配失败（细节见 `topics/profile-and-gen-integrity.md`）。
3. **改任何 profile 配置后**跑 `npm run check:profile`（组合插件树后直接退出）+ `npm run check:bom`。
   健康基线：exit 0 / stderr 空 / **571 行** / `pet` 0 条 / `design-canvas-bridge` 1 条。
4. **改完 `node_modules/@deepseek-ai/*` 必须立刻重建 patch**（`patch-package` 只能在 **PowerShell 工具**里跑）。
5. **外置化 / 缩减必须在「写入时」（append-only），不能「事后」`replace`** —— 事后改写必击穿 prompt 前缀。
6. **`disabled` ≠ 移除**：在 `bundles` 里就仍会被 loader 装配；声明了 `dsh.client` 的包目录还在就可能被前端加载。
7. **判据与信号不可混**：裸满意度评分应被**丢弃**；采纳只认可执行 `acceptance` + 隐藏 holdout。
8. **压缩后端契约**：任何"产出 summary 对象"的路径都必须携带 `measurement` 与
   `start/end/shadowedSeqs/selectedNodes` —— 改后跑 `scripts/check-compaction-fallback-shape.mjs`。

## 主题索引（**按需读**）

| 主题 | 文件 | 什么时候读 |
|---|---|---|
| 运行时与启动 | `topics/runtime-and-launch.md` | 端口/启动器/凭据/会话存储格式/关键配置 |
| profile 与 gen 一致性 | `topics/profile-and-gen-integrity.md` | 改配置、加插件、换代后能力变了、离线验收、BOM、host plane vs preset plane |
| prompt 缓存 | `topics/prompt-cache.md` | 命中率、四类前缀改写源、指标口径、外置化时机 |
| 压缩引擎 | `topics/compaction-engine.md` | 压缩补丁、兜底契约、诊断埋点、会话驱动脚本 |
| 换代 vs 重启 | `topics/generation-swap.md` | 要替换代码时、三级策略、`?cmd=restart`、HMR 现状 |
| 自进化设计 | `topics/self-evolution-design.md` | 判据阶梯、能力库、单前脑委派、**多模型会议室**、**子脑记忆（tier+发表门）**、信号/判据分工、subagent 机制 |
| 项目治理 | `topics/project-governance.md` | 资产边界（**别重造**）、文档可信度、`docs/` 索引、设计原则汇总 |

**入口级**：`docs/ideas-spec.md`（实现无关的思路规格，**改架构前先读**）。

## 资产拓扑（易搞混，先看这里）

- **`D:\project_develop\design-canvas` = 工具真身**：独立 git 仓 v0.1.3（commit `1d19e23`），
  **TRAE 与 DSH 都拉起的活内核**，暴露 **58 个 MCP 工具**（DSH 侧经 `dsh-mcp-client` stdio 拉起
  `server.js` → `mcp__design-canvas__*`；再由 `design-canvas-bridge` 编排壳额外注册 8 个）。
  `dsh-brain/design-canvas-dev`（开发副本，node_modules 是 junction）与
  `Downloads\…\design-canvas-main`（node_modules 宿主）是其分支/宿主，**三者同版本同 commit**。
  **改它源码要 rebuild + 重启新一代才生效**；改名/检索前先 `design_canvas_prewarm` 上索引；
  Go→TS 翻译走 `translate_go_ts`（tree-sitter AST 底座，LLM 池自动接 `127.0.0.1:3101`）。
- **查能力要查真注册表，不查包装层**（曾因只查 bridge 的 8 个编排壳工具而误判 design-canvas 无翻译能力）。
- **归一化（2026-09-14）**：真资产已搬到 **`D:\project_develop\_from-downloads\20260914\`**
  （747 文件 / 46.9MB：`archify` 技能 + `output` + `workspace-data` + 8 份文档 + `_patches`）
  与 **`D:\project_develop\weavepet\`**（织宠世界源码 11 文件）。
  **待用户整删**（`scripts/cleanup-redundant-workspaces.ps1`，默认进回收站；`-DryRun` 已实跑）：
  `Downloads\Browsers\Microsoft Edge\design-canvas-main`(713MB) + `dsh-brain/design-canvas-dev`(17MB)
  + `D:\project_develop\dsl-workbench`(70MB) ≈ **799 MB**。
  依据：唯一资产已归档 / dsl-workbench 远端同步 / 克隆与真身同 commit / cache 可重建。
  其中 **D 盘 `dsl-workbench` 也已验证可删**：其 HEAD 是 `origin/main` 的祖先、
  **无本地独有提交**（远端领先 32 个提交），但**它无 remote → 自证不出过期**。
- ★ **铁律（副本归一化）**：**副本必须能自证新鲜度（有 remote / 有同步机制）；
  无 remote 的副本 = 无法自证过期 = 注定成为陷阱。**
  故"归一化"的终态不是"本机留一份"，而是"**远端是唯一来源，本机按需 clone**"。
- **★ 意外收获**：`archify` = **第三方 MIT 技能 v2.17**（作者 tt-a1i，基于
  Cocoon-AI/architecture-diagram-generator），把架构/时序/数据流/生命周期渲染成可交互独立 HTML
  （内联 SVG + trace 动效 + 多格式导出，支持 Mermaid 输入与仓库证据）。现位于归档区，
  **考虑装进技能系统**。
- **design-canvas 真身 = `D:\project_develop\design-canvas`**（DSH 的 mcp-client `args`/`cwd` + bridge
  `kernelDir` 都指向它）；两处引用一致性是判断"真身"的依据。

## 当前状态 / 下一步（2026-09-14）

- **已修并复测通过**：压缩兜底崩溃、gen 端口击穿（boot 段见 `dsh web: ...:3080`）、
  插件树部分加载失败 + 启动健康检查、BOM、桌宠移除、**`?cmd=restart` fast 换代（2.6s）**、
  插件树离线验收=基线（571 行）、BOM 守卫=0、凭据 configured。
- **★ 换代副作用（P1）—— 已修并复测通过**（build `b1789323453051`）：曾一次注入**两条** prompt
  （含「视为用户已预先批准」）；且若 turn 卡在 `ask_user_question`，`turn/end` 永不来临 →
  再换代 resume 失败 → 会话变未 attach。现为**条件注入**：`scheduleResume(...,[],...)` 只 attach
  不注入；`prepareSwitch` 加 `turn/start` + **空闲短路**；coordinator 判据 = **`waitedForTurnEnd === true`**；
  fast 不注入。**实测**：直调 prepareSwitch 在空闲时 **4ms** 返回 `reason=idle`（旧必等 20s）；
  正常 handover 在空闲会话上 **4.6s** 落定、defer 同秒完成 —— 顺带省掉白等的 20s grace。
  细节见 `docs/handover-vs-restart.md` §6。
- **未闭合**：换代后首轮命中率仍 0%，与"3 小时空闲"混淆 → 需在 header 稳定在 3080 后做单变量复测。
- **新增设计**：`docs/per-subagent-memory.md`（每个子脑的记忆：三档 tier + 发表门）；
  `docs/memory-asset-triage.md`（记忆资产处置：**`SkillNode` 就是能力库，只缺执行器**；
  睡眠需常驻宿主 ⇒ **记忆库必须是独立进程**）。上轮 5 项拍板项用户已全部同意。
- **★ P0' 结论反转（2026-09-14 实测）**：委派工具**本来就可用**。不是"被上游禁用"，而是
  「**host plane 出 registry，agent plane（preset）出工具行**」的分工：
  `dsh-base` 提供 `subagent` + spawn/fork backends；`dsh-web-app` 的 patch 只在 host plane
  `disabled` 那四个工具行；而 **`code` preset 又把它们挂了一遍（未 disabled）**。
  实测模型手里确实有 `subagent` / `subagent_fork` / `list_agents` / `interrupt_agent` / `send_message`。
  ⚠️ **踩坑点**：只看 host plane 的 `--dump-config` 会看到 `disabled: true` → 误判为"被禁用"。
  **权威口径**：`scripts/dump-request-tools.mjs`（读会话 `request/header` 事件里的 tools + system）。
- **P1-b 已完成并验收（2026-09-14）**：`packages/subagent-council/` —— 第一个自定义
  `SubagentProvider`（议事厅 · 架构师 `council-architect`）。重启后真实委派全通过：
  preset=`code-council`、`council_architect` 进 system、`code-dispatch-start` 派发成功、
  persona 五段式生效。装配基线 **576 行**。流程见 `docs/subagent-provider-howto.md`；
  改 preset / 写 persona 见 skill **`dsh-agent-preset-authoring`**。
  **回滚**：`~/.dsh/settings.yaml` 的 `agent-presets.default` 改回 `code`。
- **P2 数据层已完成**：`scripts/capability-registry.mjs` + `~/.dsh/capabilities/registry.json`
  （schema = lineage + acceptance + holdoutHash + 行为信号；动作 = register/supersede/merge/retire）。
  已登记 `spawn` / `fork` / `council-architect`。★ `check` 抓出：**存量能力都缺 acceptance 引用**
  → P3 注册门必须连存量一起补。
- **★ Code Mode 铁律（实测）**：`DSH_TOOLS_MODE=code` 时模型只能直接调 `run_code`，
  其余工具必须写在 `run_code` 里用 `tools.<name>(...)`。**已在 `code-council` 的 persona 里
  用「否定+禁止」式硬规则消除**（踩坑 1~2 次 → **0 次**）。
  **prompt 通用教训：否定+禁止 ＞ 说明+让它判断。**
- **P2-b 已完成（待重启验证）**：`packages/capability-bridge/` 给模型两个**只读**工具
  `list_capabilities` / `capability_report`。**工具走 host plane 的全局层 → 不需要改 preset**
  （先例：tool-evolution 的 `tool_score`）。装配基线 **579 行**；工具逻辑已离线单测
  （`scripts/test-capability-bridge.mjs`，mock ctx 直接调 execute）。
  ⚠️ `defineTool()` 返回裸对象 `{name,description,parameters,output,execute,presentCall}`，可脱离 DSH 单测。
  ⚠️ 重启后**首轮 cache 命中率 0% 是预期的**（tools 段变了一次）。
- **★ 能力库必须覆盖两层（2026-09-14 用户提醒后补）**：原设计只登记**委派层**
  （`subagent-provider`），漏掉**工具层** —— 而模型手里大部分工具来自 MCP（design-canvas 一家 60 个）。
  已补：`capability-registry.mjs` 的 `MCP_SOURCES` + `scanMcpSource()`；design-canvas 登记为
  `kind: mcp-server`（60 工具 / 6 能力线 / 导航工具 `capability_map`）；`list_capabilities` 分层输出。
  **对接而非重复造**：跨源总览归我们的 `list_capabilities`，线级导航归它的 `capability_map`。
  ★ 首次抓到真问题：`capability_map` 是**手工同步**的静态表，**4 个工具没进任何能力线**
  （`go_originals` / `memory_observe` / `memory_targets` / `move_symbol`）→ 靠它导航的 agent 看不见，
  含记忆系统两个入口。设计文档见 `docs/capability-registry-evolution.md` **§3.6**。
- **下一步 P3**：注册门（L0~L4 判据阶梯）+ 给存量 `spawn`/`fork`/`design-canvas` 补 acceptance；
  **验收对象必须含 `kind: mcp-server`**（工具层）。

## ⏭ 交接（2026-09-14 15:42，用户因上下文过长换新窗口）

**两边工作区都干净**：dsh-brain 6 个提交；design-canvas 1 个提交（`b1b2bc6`）。

**用户最后提的三件事（均未展开，新窗口优先接）**：

1. **`capability_map` 的能力线目录要「自动生成」，不要手工同步** —— 他早前提过但未被实现。
   ⇒ `design-canvas/src/tools/capability_map.ts` 的 `LANES` 应由**单一真相源**生成
   （工具注册信息 + lane 标注，或直接由 `capability-registry` 生成）。
2. **给 design-canvas 改名** —— 他问我「你应该知道吧」，但我**没查到那次提案**
   （`conversation_search` 两次 0 命中）。**需向他确认名字**，或去
   `design-canvas/docs/`、`.trae/documents/`、git log 找线索。改名动机见下条。
3. ★ **愿景**：design-canvas 成为 agent 的**读写编辑统一入口**，且**模型无感** ——
   原话「以后所有的读写编辑都用这个…agent 要自己遇到一个项目就自发地去解析，让模型无感」。
   ⚠️ **张力**：**「模型无感」与 prompt 前缀稳定性冲突** —— 若把默认路径写进 system prompt，
   每次调整都击穿缓存。应靠**工具层的默认实现（同名工具换底层）**，而非 prompt 指令。

**未闭合**：P2-b 重启验证（`list_capabilities` 是否进模型工具清单）｜P3 注册门｜上述 1 / 2 / 3。

> 本轮全部细节见 `.workbuddy/memory/2026-09-14.md`（append-only 日更，**尾部即最新**）。
