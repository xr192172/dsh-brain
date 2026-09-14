# dsh-brain — 长期项目笔记（**索引**）

在 DeepSeek Harness (DSH) 底座上，把 agent-shell 工程思路解耦重做成 Cordis 插件：
三脑编排 / 上下文压缩 / 工具自进化 / 护栏 / LLM 路由。

> 本文件是**索引**，不是全文；细节按主题拆到 `topics/`，**按需读，不要一次全读**。
> 日更（append-only，尾部即最新）：`2026-09-13.md`、`2026-09-14.md`。
> 2026-09-14 瘦身：资产拓扑 → `topics/asset-topology.md`；进度/下一步 → `topics/current-status.md`。

## 环境约束（本机工具层，每次都要遵守）

1. **Bash 工具 PATH 被破坏**：调用开头先 `export PATH="/c/Windows/System32:/c/Windows:/usr/bin:/bin"`。
2. **PowerShell stdout 被吞**：结果写文件再用 Read 读。
3. **不能在工具内起长期后台服务**（进程随调用结束被回收；`schtasks`/`cmd start`/`Win32_Process.Create`
   全被拦）⇒ **switchboard 只能由用户终端启动**。
4. 排查会话内容**别**把 node stdout 重定向到文件（判为二进制）→ 让脚本自己 `fs.writeFileSync`。
5. `grep -oE` / `find` 在这台 shell 不可靠 → 提取文本用 node 脚本。
6. **★ clone/fetch 必须用系统 git**：`& 'C:\Program Files\Git\cmd\git.exe'`。
   PortableGit 2.55 写嵌套 ref **静默失败**（报 `* [new branch]` 但 `git branch -r` 为空、
   `update-ref` rc=0 不报错）⇒ **每次 clone/fetch 后验 `git branch -r` 非空**。
7. **`git -C` 不认 MSYS 路径**（`/d/xxx` → `fatal: cannot change to …`）⇒ 一律 `D:/…` 或 `D:\…`；
   **该报错极易被误判成"目录不存在"**（据此下过错误结论）。
8. **工作区约定**：`D:\project_develop` 是唯一开发根；`_` 前缀 = 非项目；
   **远端是唯一真相源，本地只是可丢弃副本**（详见 `D:\project_develop\README.md`；
   体检 `scripts/scan-workspace-root.mjs`）。
9. **Code Mode**：`DSH_TOOLS_MODE=code` 时模型只能直接调 `run_code`，其余工具必须在 `run_code`
   里用 `tools.<name>(...)` ⇒ persona 用「否定+禁止」式硬规则写死。
   **prompt 通用教训：否定+禁止 ＞ 说明+让它判断。**

## 铁律（违反会立刻坏事）

1. **写 json/yaml/源码一律 node `fs.writeFileSync(p,s,'utf8')`（无 BOM）**；
   PS 5.1 的 `Set-Content -Encoding UTF8` 必加 BOM → DSH `JSON.parse` 崩 → **gen 起不来**。
   **★ 唯一反向例外：`.ps1` 必须【带】BOM**（否则按 ANSI(GBK) 解码 → 语法错误）。
   `scripts/check-bom.mjs --fix` 双向修（剥数据文件 BOM + 给 `.ps1` 补 BOM）。
2. **profile 的 `cordis.patch.yml` 不得写包内已 `insert` 的同一 id** → `duplicate loader entry id`
   → 整棵插件树装配失败。
3. **改完 profile 跑** `npm run check:profile` + `npm run check:bom`。
   健康基线：exit 0 / stderr 空 / **579 行** / `pet` 0 条 / `design-canvas-bridge` 1 条。
4. **改完 `node_modules/@deepseek-ai/*` 立刻重建 patch**（`patch-package` 只能在 PowerShell 工具里跑）。
5. **外置化 / 缩减必须在「写入时」append-only**，事后 `replace` 必击穿 prompt 前缀。
6. **`disabled` ≠ 移除**：在 `bundles` 里就仍会被 loader 装配；有 `dsh.client` 的包目录还在就可能被前端加载。
7. **判据与信号不可混**：裸满意度评分应被**丢弃**；采纳只认可执行 `acceptance` + 隐藏 holdout。
8. **压缩后端契约**：任何产出 summary 对象的路径必须携带 `measurement` +
   `start/end/shadowedSeqs/selectedNodes` → 跑 `scripts/check-compaction-fallback-shape.mjs`。
9. **★ 插件 Config 是 `z.object` ⇒ 其 `cordis.patch.yml` 的 insert 必须显式写 `config:`**
   （哪怕全用默认值）。漏写 → loader 传 `undefined` → zod `expected object, received undefined`
   → **gen 启动即 EXIT code=1**；**而换代接口仍报 `success`（静默失败！）**。
   ⇒ 换代后别只看 `?cmd=result`，必须看 `~/.dsh/switchboard/gen-*/boot.log` 与 `crash-investigation/`。
   （2026-09-14 实测：`capability-bridge` 漏 config，gen-3083 崩溃；7 个 `@dsh-brain/*` 包现已全部显式写。）

## 主题索引（**按需读**）

| 主题 | 文件 | 什么时候读 |
|---|---|---|
| 运行时与启动 | `topics/runtime-and-launch.md` | 端口/启动器/凭据/会话存储格式/关键配置 |
| profile 与 gen 一致性 | `topics/profile-and-gen-integrity.md` | 改配置、加插件、换代后能力变了、离线验收、host plane vs preset plane |
| prompt 缓存 | `topics/prompt-cache.md` | 命中率、四类前缀改写源、指标口径、外置化时机 |
| 压缩引擎 | `topics/compaction-engine.md` | 压缩补丁、兜底契约、诊断埋点、会话驱动脚本 |
| 换代 vs 重启 | `topics/generation-swap.md` | 要替换代码时、三级策略、`?cmd=restart`、HMR 现状 |
| 自进化设计 | `topics/self-evolution-design.md` | 判据阶梯、能力库、单前脑委派、多模型会议室、子脑记忆（tier+发表门）、信号/判据分工 |
| 项目治理 | `topics/project-governance.md` | 资产边界（**别重造**）、文档可信度、`docs/` 索引、设计原则汇总 |
| **资产拓扑** | `topics/asset-topology.md` | 分不清资产/副本、design-canvas 真身与副本、归一化、archify |
| **当前状态 / 下一步** | `topics/current-status.md` | 接手前看进度：P1/P2/P3 到哪了、未闭合项 |

**入口级**：`docs/ideas-spec.md`（实现无关的思路规格，**改架构前先读**）。

## ⏭ 交接（2026-09-14 00:40 更新）

**索引层的目标已定成一句不变量**（见 `design-canvas/docs/index-freshness-extreme.md`）：
> **任何时刻，LLM 通过工具读到的索引内容，要么与磁盘一致，要么明确标注它可能旧/不全。**（= 绝不撒谎）

失败分两种，只值得为第二种花钱：**报错/说不知道**（低危）vs **静默给旧答案**（高危，LLM 无从察觉）。
⇒ "极致"不是更快更全，而是**把"读到错东西却不知道"的概率压到零**。

**五层保障（全部已落地）**：
L1a 写穿 `write_gate.writeSourceFiles`（185ms/次，`rename_symbols` 已接）｜
L1b 自写登记 `recordSelfWrite`（同步签名工具走这条，`remove_dead_imports` 已接）｜
L2 watch（含拼图边界闸 `scopeToIndex`，默认关）｜
L3① `ensureFreshIndex`（精确、异步）｜ **L3② `staleIndexWarning` 响应注入（覆盖全部 60 个工具，5s 缓存 + 只在状态转变报一次）**｜
L4 `reconcileProject`。

**★ 实测（`scripts/probe-dc-write-through.mjs`，靶子 = 102 条入边的 `storage.ts#getDSL` 改名）**：
经闸 185ms ⇒ 未保鲜 0 / 旧名入边 0 / 陈旧断言 0；绕过闸 ⇒ 未保鲜 1 / **旧名入边 102**（LLM 会被指向已不存在的旧名）。
★ 指标口径别混：`not_fresh`＝索引**落后于磁盘**；`stale_resolved`＝索引**自身内部**不一致
（只在"重同步删了旧节点却没重开引用"时出现，见 `probe-dc-watch-refresh.mjs`）。

**新工具 `index_integrity`**（meta 线）：把**可信度当结果返回**（陈旧断言/覆盖度/未保鲜/自写登记/修复建议）；
`refresh:true` 顺手**修复**陈旧引用（只有它能修 —— 保鲜路径靠 `symbol_diffs`，而那些文件内容没变）。
真身自检：390 文件 / 4887 节点 / 9434 边 / **陈旧断言 0**。

**★ 本轮踩到的 3 个真 bug（已修，教训可复用）**：
1. `scanLiteralOccurrences` 的 SKIP_DIRS 缺 `.design-canvas` ⇒ 扫到 `code-snapshots/` 的**旧文本副本**，
   既虚增命中数又把**可撤回的快照本身改写掉**。⇒ **我们自己的派生物目录必须排除在"扫源码"之外**。
2. `index_backfill` 写 `const indexedSet = indexedRelativeSet`（模块级别名）撞上
   `index_backfill ⇄ index_freshness` 循环 import ⇒ 别名捕获成 `undefined`。⇒ **循环的两个模块间不要建模块级别名**。
3. 落盘工具不经闸 ⇒ 改完索引不知情。⇒ 新写工具一律接 `writeSourceFiles`（async）或 `recordSelfWrite`（同步）。

**★ 既有测试失败必须对照证明，别自认**：全量 2040 项有 18 失败（9 文件）。
方法：`git checkout <parent>`（工作区必须干净）跑同一批 → 与 HEAD 对比。已证 `find_references` 3 项与
`server_registry.stale_build` 1 项在父提交上**完全一致**；其余是 Go/网络/git 环境类。

**未闭合 / 下一步**（详见 extreme 文档 §5）：① L3② 从"标注"升级为"精确"（TTL 保鲜守卫，或先给
`diff_impact` 单独接保鲜 —— 它给的是**行动建议**，读旧图最危险）② 可信度自动附到 `impact_analysis`/`rename_*`
③ **边界扩展**（`noExpand` 终点复用 + 新文件并入相邻块）④ 能力自述（按语言标注可解析粒度，P10）
⑤ 预热 `parseFileFull` 让同步工具直连 L1a ⑥ 写入闸收编 `edit_code`/`rename_files`/`symbol_move`/
`code_workbench`/`refactor_pipeline`/`scaffold`。

**其他待拍板**：`scopeToIndex` 是否给 MCP 工具 `watch_project` 默认开（现 false）｜改名 working name `agentio`（正式待定）｜
P2-b 重启验证｜P3 注册门。**实践纪律**：**换代由用户自己发**；跑探针前必须 `tsc` 重建 dist。

> 本轮全部细节见 `.workbuddy/memory/2026-09-14.md`（append-only 日更，**尾部即最新**）。

> 本轮全部细节见 `.workbuddy/memory/2026-09-14.md`（append-only 日更，**尾部即最新**）。
