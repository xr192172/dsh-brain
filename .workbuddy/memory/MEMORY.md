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
   ★ **2026-09-20 实测补强**：`detached: true` + `child.unref()` **也不行** —— 从工具层拉起后
   switchboard + gen 都**完整启动到就绪**（gen boot.log 有完整启动段、控制面能应答），
   但**工具调用一结束整棵树就被回收**（无错误日志、stderr 时间戳未变）⇒ 判据是"谁拉起的"。
   **启动命令**（Temp 里那个 ps1 在机器维修后已被清掉，别再照旧路径走）：
   `cd D:\project_develop\dsh-brain && node scripts\relaunch-switchboard.mjs`（分离式，日志落 `out/switchboard-run.log`）。
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
12. **`npm run <script>` 在 Agent 的 shell 里会被安全策略拦**（命中 wsl.exe 黑名单，且不可绕过）
    ⇒ 一律直接跑 `node scripts/<x>.mjs`（等价；`check-all.mjs` 里各道门本来就是 `node …`）。
13. **构建不再依赖全局 `tsc`**：`packages/switchboard/scripts/build.mjs` 现在优先用仓库内
    `node_modules/typescript`（Agent shell 里没有全局 `tsc`，报错长得像配置问题）⇒ 直接
    `cd packages/switchboard && node scripts/build.mjs` 即可。

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
   · **版本事实（2026-09-20 实测）**：本地两棵树都是 `0.1.1-rc.2`；registry `latest=0.1.5-rc.2`、
     `alpha=0.1.6-alpha.2`。根 `package.json` 写 `^0.1.1-rc.2` —— **caret 对预发布只匹配同一
     [major.minor.patch]** ⇒ 不显式改就永远不会跳（所以"没自动升"是设计，不是故障）。
   · **要升之前先跑** `npm run check:upstream`（=`scripts/check-upstream-drift.mjs`）：
     A 组验"我们依赖的形状还在不在"、B 组验"补丁靶子还在不在"、C 组列新增能力。有一红就别动手。
   · ★ **0.1.5 值得单独记住的一条**：`dsh-session-persistence` 引入**存储层单写者所有权**
     （`open(id,'read'|'write')` 原子占用 / `SessionAlreadyOwnedError` / 服务级 `flush()`）
     —— 正是 09-15 事故缺的那块栅栏。但**竞态根机制未变**（`seq===log.length`、repair 的 `last.seq+1`、
     构造补 `end-seed` 都还在）⇒ **上游没修这个竞态**，我们自己的 `drain`+`sealPlan` 仍是主力。
11. **★ 判"某机制有没有在工作"，不许读注释、不许读代码意图 ⇒ 去历史记录里数「判据为真的次数」**
   （2026-09-16 定，来自换代竞态案子）：那次三个"保险"机制全都**从未为真** ——
   `waitedTurnEnd=true` 计数 **0**（204 次 defer）、`freeze.lastSeq` **恒 0**（171 条）、
   `drain` 的静止判据只查 `lastSeq>=0`。**一个从未为真的判据 = 假绿**（最坏的一类），
   它比"没有门"更糟：它让人以为查过了。**推论**：写门时同时报"判据为真的历史次数"，为 0 就该报警。
12. **★ "看不到" ≠ "没有"**（同上）：服务缺失 / 列表为空 / 读数拿不到，**一律不得**当作正向判据。
   新代码里已按此落地：`drain` 的 `agentsObservable`（看不到 agent ⇒ `quiesced` 必须为 false ⇒
   宁可强杀旧代，也不许报"已停写"）。

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
**上游漂移体检**：`docs/upstream-drift-2026-09-20.md` + `npm run check:upstream`（手动/需联网）。
**架构评审**：「主脑/子脑拆两个服务 + 互相代持」见 `docs/two-service-custody-review.md`
（结论：能替掉"部署"层，**替不掉"判据"层**；对称代持 = 2-回路，踩无环原则）。
**§8 追加**：「同时开 2 号进程做实验、成功才退役」——可行，且今天的 handover 已是这套流程的骨架；
缺的是"实验"（今天只验"活着"不验"更好"）+ 判据（上游 `eval` 类 0 命中，必须自建）；
副作用隔离**今天就有**（profile 已装只读沙箱，`sandbox: read-only` 在 `out/profile-dump.txt:114`）。
**下一步 + 开源先例**：`docs/oss-prior-art-and-next-steps.md`（M0 真机验收 → M1 影子实验 → M2 接进
`verifyCmd` 闸 → M3 才拆服务；先例：fencing token / SBR「终止陈旧持有者」/ OTP 监督 / Envoy 影子流量 /
durable execution 的 journal+幂等 / promptfoo 式本地评测门；**闭环无现成产品**）。
**Agent 评测靶场调研**：`docs/agent-eval-arenas.md`（怎么测/用什么数据/2026 四条教训；
**判据用自有冻结任务集**，公开榜只当"不许退化"的地板）。
**实验地基（M1-step-1，已开工）**：`evals/`（任务集 + 格式）+ `scripts/eval-validate.mjs`
（`npm run eval:validate`：每题必须证明"打 seed 后 oracle 变红"，否则是假题；**不进 check:all**）。

## ⏭ 交接

> **★ 新会话接手 → 先读 `topics/next-task-handover.md`**（自包含的接手指南：
> 下一项任务、已破的案、要读的文件、操作纪律、验证命令、今晚踩过的坑）。
> 本文件只放**每次都要遵守**的东西；进度与细节不进这里。

**一句话现状（2026-09-16 00:50）**：
- P3 注册门 ✅、P4 能力通知（含真机换代验证）✅、方案 B（preset 回切 Native）✅
- 长期 flake「交接后 `reading 'kind'`」已破案并修复 ✅（上游 `isOwned` 不保护 `message.source`）
- **换代写入竞态：真因已更正 + 已修**（不是 hard-switch，是 **`freeze` 从来没让人停过写**；
  机制= `dsh-session` 的 `seq === log.length` + 用磁盘前缀载入 ⇒ 必然重叠）。
  修法：`drain.ts` 真停（cancel 回合 + 有界 `whenIdle` + 官方 flush + 真 `lastSeq` + `quiesced`）
  + 控制面 `sealPlan`（未停写 ⇒ **释放前门锁之前**强杀旧代）。门：`test-handover-drain.mjs`（36 项）。
  完整记录见 `docs/handover-vs-restart.md` §8（已按真因重写）。
- **真机验收：M0 已通过**（2026-09-20 13:15，用户终端启动 + 一次非 fast 换代 ⇒
  `verify-drain-after-swap.mjs` = **11 ok / 0 FAIL**；流水有 `quiesced=true canSeeAgents=true seal: keep-old`；
  全程 4.5s）。
  ★ **13:30 又把"回合运行中换代"这条主路径补验了，并在过程中抓到我自己修复里的两个 bug（已修）**：
  ① **假红**：`stillBusy` 读的是建列表时的 phase 快照 ⇒ cancel 明明成功了仍报 `quiesced=false`
  （证据：会话日志已有 `turn/end aborted(hook)`）⇒ 改成**实时** `readPhase()`；
  ② **假绿**：`ctx.sessions` 没 inject ⇒ `sessions=0` / **`flush` 从没跑过** / `lastSeq=-1`，
  而空闲场景照样报 `quiesced=true`（13:15 那次"通过"其实是空过）⇒ 改走 `ctx.inject(['sessions'])` +
  新增 `sessionsObservable`（看不到 ⇒ 必须 false）。
  修后同一实验：`quiesced=true lastSeq=1315 canSeeSessions=true running=1→cancelled=1 sessions=1 (14ms)`
  + `seal: keep-old` + 会话以 `turn/end aborted(hook)` + `end-seed` 收尾 ✓。门 41→48 项。
  顺带：**封口路径（KILL-OLD）也在真机上跑过一次**（13:24 的假红触发的），确认"先杀旧代再放前门锁"有效。
- ⚠️ **操作纪律**：不确定有无回合在跑时用 `?cmd=handover`（非 fast），**别用 `restart`**
  （fast 跳过 defer；虽然他修完后危险路径会自己封口，但强杀旧代 = 放弃该段回滚网）
- ⚠️ **换代前先跑** `node scripts/check-session-integrity.mjs`（坏会话能让整代起不来）

**实践纪律**：跑探针前必须重建 dist；改 `~/.dsh` 下的文件先备份。
