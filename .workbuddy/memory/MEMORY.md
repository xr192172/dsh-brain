# dsh-brain — 长期项目笔记（**索引**）

在 DeepSeek Harness (DSH) 底座上，把 agent-shell 工程思路解耦重做成 Cordis 插件：
三脑编排 / 上下文压缩 / 工具自进化 / 护栏 / LLM 路由。

> 本文件是**索引**，不是全文；细节按主题拆到 `topics/`，**按需读，不要一次全读**。
> 日更（append-only，尾部即最新）：`2026-09-13.md`、`2026-09-14.md`、`2026-09-15.md`。
> **进度/未闭合/下一步一律看 `topics/current-status.md`**；本文件「交接」只留指针，不再复制细节。

## 环境约束（本机工具层，每次都要遵守）

1. **Bash 工具 PATH 被破坏**：调用开头先
   `export PATH="/c/Windows/System32:/c/Windows:/usr/bin:/bin:/c/Program Files/nodejs:/c/Program Files/Git/cmd"`。
2. **PowerShell stdout 被吞**：结果写文件再用 Read 读。
3. **不能在工具内起长期后台服务**（`schtasks`/`cmd start`/`Win32_Process.Create` 全被拦）
   ⇒ **switchboard 只能由用户终端启动**。
4. 排查会话内容**别**把 node stdout 重定向到文件（判为二进制）→ 让脚本自己 `fs.writeFileSync`。
5. `grep -oE` / `find` 在这台 shell 不可靠 ⇒ 提取/统计一律走 node 脚本。
6. **★ clone/fetch 必须用系统 git**：`& 'C:\Program Files\Git\cmd\git.exe'`。
   PortableGit 2.55 写嵌套 ref **静默失败** ⇒ **每次 clone/fetch 后验 `git branch -r` 非空**。
7. **`git -C` 不认 MSYS 路径**（`/d/xxx` → `fatal: cannot change to …`）⇒ 一律 `D:/…`；
   **该报错极易被误判成「目录不存在」**。
8. **工作区约定**：`D:\project_develop` 是唯一开发根；`_` 前缀 = 非项目；
   **远端是唯一真相源，本地只是可丢弃副本**（`D:\project_develop\README.md`；
   体检 `scripts/scan-workspace-root.mjs`）。
9. **Code Mode**：`DSH_TOOLS_MODE=code` 时模型只能直接调 `run_code`，其余工具须在 `run_code` 里
   `tools.<name>(...)` ⇒ persona 用「否定+禁止」式硬规则。
   **prompt 通用教训：否定+禁止 ＞ 说明+让它判断。**
10. **★ 同一文件的两个 Edit 并行发 ⇒ 后者按旧快照覆盖前者，且两边都报成功**
    （2026-09-15 连踩 2 次、静默丢改动）⇒ **同文件编辑必须串行，改完 grep 验证关键标记**。
11. **`node -e` 带正则/反引号/花括号会被 bash 抢插值** ⇒ **写 `.mjs` 文件再跑**（已固化多次）。

## 铁律（违反会立刻坏事）

1. **写 json/yaml/源码一律 node `fs.writeFileSync(p,s,'utf8')`（无 BOM）**；
   PS 5.1 的 `Set-Content -Encoding UTF8` 必加 BOM → DSH `JSON.parse` 崩 → **gen 起不来**。
   **★ 唯一反向例外：`.ps1` 必须【带】BOM**。`scripts/check-bom.mjs --fix` 双向修。
2. **profile 的 `cordis.patch.yml` 不得写包内已 `insert` 的同一 id** → `duplicate loader entry id`
   → 整棵插件树装配失败。
3. **改完 profile 跑** `npm run check:profile` + `npm run check:bom`。
   基线：exit 0 / stderr 空 / **582 行** / `pet` 0 / `duplicate loader entry id` 0。
   ⚠️ 但它**不校验插件 config** ⇒ 配置正确性看 `scripts/check-config-tolerance.mjs` 或真启动。
4. **改完 `node_modules/@deepseek-ai/*` 立刻重建 patch**（`patch-package` 只能在 PowerShell 工具里跑）。
5. **外置化 / 缩减必须在「写入时」append-only**，事后 `replace` 必击穿 prompt 前缀。
6. **`disabled` ≠ 移除**：在 `bundles` 里就仍会被 loader 装配；有 `dsh.client` 的包目录还在就可能被前端加载。
7. **判据与信号不可混**：裸满意度评分应被**丢弃**；采纳只认可执行 `acceptance` + 隐藏 holdout。
   **★ 未实施的判据级不得计作通过。** 假信号按**有没有坐标**排：
   **假绿/空过（无处可查、且以为查过了，最坏）> 无门（诚实的无知）> 假红（给了坐标，相对最好）**。
   **见假红 → 先证明判据错了，再改判据；绝不为消红去改被检对象**（那等于把假红转成假绿）。
8. **压缩后端契约**：产出 summary 的路径必须携带 `measurement` +
   `start/end/shadowedSeqs/selectedNodes` → `scripts/check-compaction-fallback-shape.mjs`。
9. **插件 `Config`**：6 个 zod 包已套 `z.preprocess(v => v ?? {}, schema)` ⇒ **漏写 `config:` 不再崩**；
   显式写仍推荐。**别用 `.default({})`**（返回字面量 `{}`、短路内层解析 = 静默坏，比崩更隐蔽）。
10. **★ 不追上游版本**（2026-09-15 用户定）：DSH 上游是移动靶 ⇒ **只按需合并对我们有利的改动**，
   不为"追新"而升级。**上游自身的问题暂不处理**（HMR 被上游 `disabled`、boot 重构、BOM 防护不全等）。
   **边界**：只管 `@dsh-brain/*` 与我们自己的 profile（`~/.dsh/profiles/web/`）；
   `@deepseek-ai/*` 从 `profiles/node_modules/` 那条**上游共享树**解析，不归我们管。
   归属逐项清单见 `docs/upstream-defects.md`。

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
| 资产拓扑 | `topics/asset-topology.md` | 分不清资产/副本、design-canvas 真身与副本、归一化、archify |
| **接手指南（下一项任务）** | `topics/next-task-handover.md` | **新会话接手时先读这个**（自包含：任务/证据/要读的文件/纪律/验证命令） |
| **当前状态 / 下一步** | `topics/current-status.md` | 接手前看进度：到哪了、未闭合项、工具层纪律增补 |

**入口级**：`docs/ideas-spec.md`（实现无关的思路规格，**改架构前先读**）。
**上游缺陷归属清单**：`docs/upstream-defects.md`（我们改过的东西哪些是 DSH 官方 bug —— 官方**不接受外部 PR**，只收 GitHub Discussions）。

## ⏭ 交接

> **★ 新会话接手 → 先读 `topics/next-task-handover.md`**（自包含的接手指南：
> 下一项任务、已破的案、要读的文件、操作纪律、验证命令、今晚踩过的坑）。
> 本文件只放**每次都要遵守**的东西；进度与细节不进这里。

**一句话现状（2026-09-15 深夜）**：
- P3 注册门 ✅、P4 能力通知（含真机换代验证）✅、方案 B（preset 回切 Native）✅
- **长期 flake「交接后 `reading 'kind'`」已破案并修复** ✅（上游 `isOwned` 不保护 `message.source`）
- **下一项 = 修换代的 hard-switch 写入竞态**（两代并发写同一份会话 ⇒ seq 回退/重叠）
- ⚠️ **操作纪律**：不确定有无回合在跑时用 `?cmd=handover`，**别用 `restart`**（fast 跳过"等活跃代收尾"，
  正是该竞态的温床）；`stage==='idle'` ≠ 没有回合在跑
- ⚠️ **换代前先跑** `node scripts/check-session-integrity.mjs`（坏会话能让整代起不来）

**实践纪律**：跑探针前必须重建 dist；改 `~/.dsh` 下的文件先备份。
