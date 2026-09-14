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

## ⏭ 交接（2026-09-14 15:42，用户因上下文过长换新窗口）

**两边工作区都干净**：dsh-brain 6 个提交；design-canvas 1 个提交（`b1b2bc6`）。

**用户最后提的三件事**：

1. ✅ **已完成（15:55–16:05）**：`capability_map` 的能力线目录**改为由注册表 `TOOL_DEFS` 派生**
   （`LANE_OF` 只写归属，`when` 取描述首句；漏标 → 输出显式「未归线」段 + 测试红）。
   **60/60 归线**，design-canvas 提交 `91a57ea`。
   **已换代（gen-3084）并用真 MCP stdio 探针端到端验证通过**（工具 60 / 6 线 / 5 个曾漏网工具全可见）。
   细节见 `topics/current-status.md` 与 `docs/capability-registry-evolution.md` §3.6.1。
2. **改名：★ 待定** —— 用户拍板**先挂 working name `agentio`**（"那就 agent 的 IO 吧"），
   正式定名保持待定；已排除「管家/代理」角色派（好看的全被占 + `proxy` 与网络代理撞义）。
   详见 `docs/rename-design-canvas.md`；同类怎么命名/怎么做见 `docs/agent-code-io-landscape.md`
   （★ 校准：Serena ★29.3k 用的就是**零相关**的意象美名 ⇒ **"零相关"不是问题，被占用才是**；
   硬指标只有 **唯一 + 好念 + 好记**）。影响面 **179 文件** ⇒ 分「品牌层 / 机器契约层」两次原子走。
3. ★ **愿景：读写编辑统一入口（AST 内核）** —— **设计稿已出：`docs/ast-io-entry.md`**。
   要点：**内核已有，缺口只有「冷启 bootstrap」**（`ensureFreshIndex` 只保鲜不冷启）；
   三入口 `code_read`/`code_filter`/`code_edit`；**N3 模型无感靠工具层默认实现，绝不写 system prompt**
   （否则击穿前缀，违反铁律 5）。待拍板 5 项见文档 §11。

**未闭合**：P2-b 重启验证（`list_capabilities` 是否进模型工具清单）｜P3 注册门｜上述 2 待定名 / 3 待拍板。

> 本轮全部细节见 `.workbuddy/memory/2026-09-14.md`（append-only 日更，**尾部即最新**）。
