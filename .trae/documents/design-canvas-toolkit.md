# design-canvas 工具包：本体 · 暴露机制 · 使用指引

> 整理日期：2026-09-14。本文件回答三个问题：① 电脑上散落的三个 design-canvas
> 各是什么、谁是真身；② 这个工具链是怎么"暴露"给 TRAE / dsh 的；③ 最新版该怎样用。

---

## 一、三个 design-canvas 目录现状

| # | 路径 | 定位 | 版本 / 提交 | 关键特征 |
|---|------|------|-------------|----------|
| ① **本体（kernal 真身）** | `D:\project_develop\design-canvas` | TRAE 与 dsh 共同使用的**活内核**，唯一被 MCP 拉起的仓库 | v0.1.3，commit `1d19e23`（2026-09-12 18:02） | 独立 git 仓库，远端 `https://github.com/xr192172/design-canvas`；`node_modules` 为真实目录（非 junction）；是 dsh 侧 `kernelDir` 深度注入 + stdio MCP 子进程的启动目标 |
| ② **开发 fork** | `D:\project_develop\dsh-brain\design-canvas-dev`（git-ignored） | dsh-brain 工作目录内的**开发副本** | v0.1.3 | 无独立 node_modules——`node_modules` 是指向 ③ 的 **junction**；在它里改源码→rebuild→把产物同步回 ① 才能生效（Write/Edit 受限于本工作区） |
| ③ **上游克隆** | `C:\Users\Admin\Downloads\Browsers\Microsoft Edge\design-canvas-main\design-canvas` | ② 依赖的 **node_modules 宿主** | v0.1.3，同 commit `1d19e23` | `design-canvas-dev\node_modules` 的 junction 目标是它底下的 node_modules；它与 ① 同 commit，可视为同版本上游镜像 |

**版本关系**：三个目录同版 v0.1.3，且 ① 与 ③ 都停在 commit `1d19e23`
(`fix(mcp): explore_code 平铺参数兼容 + semanticSearch degraded 降级`)。② 是纯开发工作副本。
结论：**改工具链的正道 = 在 ① 或 ② 里改 → 在对应目录 rebuild → 让 dsh/TRAE 重启新一代后加载新 `dist`**。
（ts 源码改动对 `dist/src/*.js` 不即时生效，需 `npm run build`；详见文末"生效规则"。）

---

## 二、暴露机制（这个工具链是怎么"上线"的）

### 2.1 单仓库 = 一个 MCP server

`D:\project_develop\design-canvas` 以 **stdio MCP server** 暴露，入口为 `dist/src/server.js`，
注册了约 **59 个 MCP 工具**（TRAE 侧快照当前收录 **58 个**，见 `c:\Users\Admin\.trae-cn\mcps\……\mcp_design-canvas\tools\*.json`；
另有代码翻译工具 `translate_go_ts` 也在注册列表中，但未进 TRAE 的这份裁剪快照，dsh 侧可通过 `mcp__design-canvas__*` 取到）。

### 2.2 暴露给 dsh（关键接线，本项目的实际消费方式）

dsh 侧通过两层把它装进 `ctx.tools`：

1. **MCP 桥**：`@deepseek-ai/dsh-mcp-client`（`dsh-mcp-client` 插件）以 stdio 拉起 `server.js`，
   把全部 MCP 工具注册为 **`mcp__design-canvas__<原名>`**（如 `mcp__design-canvas__import_project`）。
   接线配置在 **`C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml`（L32–50）**：

   ```yaml
   - id: mcp-client
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       transport: stdio
       serverName: design-canvas
       command: node
       args: [ D:\project_develop\design-canvas\dist\src\server.js ]
       env:
         DESIGN_CANVAS_HOME: D:\project_develop\dsh-brain\.design-canvas
         # translate_go_ts 的 LLM 池：指向 dsh key-pool-proxy(3101)，用 dsh 的 AGENTSHELL_MAIN_LLM_API_KEYS 池轮换
         AGNES_UPSTREAM_BASE: http://127.0.0.1:3101
         AGNES_MODEL: agnes-2.5-flash
       cwd: D:\project_develop\design-canvas
       toolCallTimeoutMs: 180000
       failOnStartupError: false
   ```

2. **bridge 编排壳**：`@dsh-brain/design-canvas-bridge`（注册于
   `packages/design-canvas-bridge/cordis.patch.yml`，`kernelDir=D:\project_develop\design-canvas`）。
   它在 dsh 侧**额外注册**一组自定义工具（不进 `mcp__` 命名空间，直接叫原名）：

   | 工具 | 作用 |
   |------|------|
   | `design_canvas_index` | 列出已预热工作区 + 能力导航地图（capability_map），轻量化定位 |
   | `design_canvas_prewarm` | 对某 `project_dir` 跑 `import_project` 全量建 AST/符号/import 索引（动作前必做） |
   | `design_canvas_prewarm_scan` | 扫描已知路径列出候选项目 + 索引状态，供改名/检索前选目录 |
   | `symbol_edit` | 深度注入的符号级精准编辑（见 §三） |
   | `safe_rename` | 符号层跨文件重命名 + 文本字面量引用一并处理的编排壳 |
   | `move_symbol` | 跨文件移动模块级符号并自动重定向 import |
   | `self_evolve` | 自进化·单指令闭环（建实验核→验证闸→flip，见 §三） |
   | `memory_observe` | 内存基线/追踪/强制GC/heap snapshot 一体化观测 |

**双通道注意**：编译/改名/影响面走深度注入原生 kernel（不经 stdio），其余走 stdio MCP 子进程；
深度注入绕开了"工具内再调其它 MCP 工具"的嵌套调度坑。

### 2.3 暴露给 TRAE（本 IDE 会话）

同仓库被本 IDE 注册为 `mcp_design-canvas`，工具快照在
`c:\Users\Admin\.trae-cn\mcps\s_dsh-brain-……\solo_agent_lite\mcp_design-canvas\tools\*.json`。
本会话能直接 `run_mcp(server_name="mcp_design-canvas", …)` 调到的就是这批工具
（get_dsl / explore_code / edit_code / rename_symbols / find_references / impact_analysis / capability_map ……）。

---

## 三、最新版使用方式指引

> 核心纪律：**改名/检索/精准编辑类操作，先 `design_canvas_prewarm` 上索引，再动作**；
> 未预热大仓会让 `find_references`/`safe_rename` 回退到即时全闭包扫描（慢 + 爆内存），工具会直接拒绝并提示先预热。

### 3.1 前置：选工作区 / 建索引

1. `design_canvas_prewarm_scan` → 拿到候选项目与 `suggestion`（ready/prewarm/empty）。
2. 对 `suggestion=prewarm/empty` 的目标：`design_canvas_prewarm({ project_dir })` 全量预热。
3. 之后 `find_references` / `safe_rename` / `symbol_edit` 都走索引。

### 3.2 精准编辑 `symbol_edit`（替代裸 edit，推荐日常）

`project_dir + file + op`，`op` 选择指引：
- 小改一行/片段 → `replace_text(old_text,new_text)`（要求 old_text 全文件唯一，带语法门）；
- 改函数/方法体 → `replace + sub=body`（code 只给新体含大括号，自动缩进，引用外部符号无需自包含）；
- 新增 → `insert(code, symbol?=锚点)`；删除 → `delete(symbol)`；多行大改 → `range(start,end,code)`。
- 所有 op 均支持 `dry_run:true` = 只出 diff 预览 + 语法门，不写盘；确认后再落地。
- **坑**：`replace`(整符号) 的 `code` 必须**自包含**（只含目标符号定义，勿重复定义文件内已有的类型/函数，否则报"重复定义")。

### 3.3 安全重命名 `safe_rename`

`file(定义文件)+symbol(旧名)+to(新名)`；默认 `dry_run:true` 先预览符号层 + 文本层字面量
分组（code/docs/test 自动、contract 需人审、历史/冻结行保留），确认后
`dry_run:false (+ apply_literals:true)` 落盘。**任一处被阻断则整体不落盘**；未预热会拒做。

### 3.4 代码翻译 `translate_go_ts`（代码翻译工具本体能力）

> 本工具在 dsh 侧以 `mcp__design-canvas__translate_go_ts` 暴露；LLM 池已接 dsh
> key-pool-proxy（3101），**无需任何额外 key**。

参数（见 `src/translate/tool.ts`）：
- `file=<单个 .go>`：翻译单文件（机械骨架 + 验证闸，默认）;
- `projectDir=<Go 项目目录>`（可配 `outDir`）：一次翻译整个项目，跨文件 import、镜像落盘;
- `fill:true`：用 AGNES 池 LLM **逐孔填函数体**（不填则只有骨架）;
- `verify:true`：对已填纯函数跑 Go↔TS **行为对拍**（需装 go 工具链）;
- `tscVerify:true`：项目模式对内存模块树跑 TS preEmit，错误入诊断（纯项目应 0 错）;
- `batchSize`（默认 5）/ `maxRetries`（默认 2）：一批函数一次 LLM 调用、纠错重试次数。

**方法论提示（经验）**：翻译失误多为"对着翻译后的 TS 壳猜语义"，根因是 Go 原文没有被
tree-sitter 索引、模型只能读壳猜。做法：先 `import_project`/`design_canvas_prewarm` 把目标工程建索引，
再对具体符号 `explore_code` 取 Go 原文，再让 `translate_go_ts` 做骨架+填孔。已支持"源代码即取即读"。

### 3.5 自进化 `self_evolve`

把一组改动 `patch=[{file,content}]` 建进独立实验核产物，让 staging 单独加载并跑验证闸，
通过才 flip、失败回滚且生产无损。入参：`patch`（源在 `src` 下）、`src`（缺省 kernelDir）、
`verify`（须在控制面 `VERIFY_ALLOW` 白名单内）、`admin`（默认 31800）。不确定 patch 结构先：
`self_evolve({ example: 'modify-tool' | 'add-tool' | 'adjust-config' })` 取模板照抄。
（由 `scripts/build-experiment-kernel.mjs` + `scripts/evolve.mjs` 驱动。）

### 3.6 通用能力导航

- `capability_map({ lane? })` —— 6 条能力线（design/refactor/observe/harvest/cross/meta），
  开工前先定位再进具体工具；高频工具（get_dsl/explore_code/rename_*）可直接用。
- `get_dsl({view:'design'|'live'})` / `edit_dsl(operations)` / `diff_views` —— 活文档读写与设计/实际对比。
- 运行时验证 `observe_instrument → observe_trace → observe_judge → reconcile_chain`、
  确定性改造 `edit_code / rename_symbols / remove_dead_imports / refactor_pipeline`、
  迁移 `impact_analysis / cross_repo_symbol_index / hybrid_precheck` 等，均见 README「MCP 工具参考」。

---

## 四、生效规则（改了源码怎么才在 dsh 里起效）

1. **dsh 侧 MCP 是拉 `dist/src/*.js`**：ts 改后必须 `npm run build`（版本化 junction → `out/<id>`），
   否则运行时加载旧 dist。改完 `dist` 需**重启新一代/控制面**（bundle 集合变更仅重启反映，看新 gen boot.log）。
2. **TRAE 侧**走 `mcp_design-canvas` 快照，需对应 IDE/服务刷新才能看到新工具。
3. **三目录同步**：在 `design-canvas-dev`（②）改完，把产物同步回本体（①）再 rebuild + 重启；
   ② 的 node_modules 由 ③ 提供（junction）。四者改动都要各自 rebuild/重启才生效。
4. 新增 MCP 工具若要 dsh 看到，走 bridge 的 `mcp__design-canvas__*` 通道，无需改 profile——
   只要 `server.js` 注册了新工具、mcp-client 会透传。
5. 插件装配纪律（防呆）：`design-canvas-bridge` 配置**只**在包内
   `packages/design-canvas-bridge/cordis.patch.yml` 定义，**勿**再往
   `profiles/web/cordis.patch.yml` 写 `- id: design-canvas-bridge` 覆盖块，否则
   `duplicate loader entry id` → 整棵插件树装配失败（工具少 25 个、Code Mode 回落 native、prompt 前缀全失效）。

---

## 五、关键文件索引

- 本体：`D:\project_develop\design-canvas`（`src/` 源码，`dist/src/server.js` MCP 入口，`README.md` 全工具参考）
- dsh 接线：`C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml`（L32–50 mcp-client；上移注释 L52–58）
- bridge 编排壳：`D:\project_develop\dsh-brain\packages\design-canvas-bridge\`（`src/index.ts` 是自定义工具总表）
- 翻译引擎：`D:\project_develop\design-canvas\src\translate\`（tool.ts 入口 / pairs / fill / llm / verify_behavior）
- TRAE 侧工具快照：`c:\Users\Admin\.trae-cn\mcps\s_dsh-brain-0cd251ca\solo_agent_lite\mcp_design-canvas\tools\`