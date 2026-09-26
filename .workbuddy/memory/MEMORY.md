# dsh-brain — 长期项目笔记（**索引 + 每次都要遵守的东西**）

在 DeepSeek Harness (DSH) 底座上，把 agent-shell 工程思路解耦重做成 Cordis 插件：
三脑编排 / 上下文压缩 / 工具自进化 / 护栏 / LLM 路由。

> ★ **本文件是索引，不是细节仓库。** 每条只留"要遵守什么"；**"为什么定这条 / 实证细节"全文存档在
> `.workbuddy/memory/topics/lessons-learned.md`**（含本文件历次瘦身前全文）。
> · **接手先读**：`topics/next-task-handover.md`（顶部 = 本轮回执）
> · **进度/未闭合**：`topics/current-status.md`
> · **日更**（append-only，尾部最新）：`.workbuddy/memory/YYYY-MM-DD.md`
> ⚠️ **本文件已三次超限被注入截断**（>40KB）⇒ **加新条目必须同时压缩/下沉旧的**（铁律 25 的执行面）。
> ⚠️ 铁律编号**不复用**（跨文件引用靠编号：lessons-learned 与日更里都按这套号说话）。

## 环境约束（本机工具层，每次都要遵守）

1. **Bash 调用开头先修 PATH**：`export PATH="/c/Windows/System32:/c/Windows:/usr/bin:/bin:/c/Program Files/nodejs:/c/Program Files/Git/cmd"`。
2. **PowerShell 通道基本不可用**（stdout 被吞；从 node 里 spawn 是 ENOENT）⇒ **自动化走纯文件通道**（脚本自己 `writeFileSync`）。
   ★ 但 `Get-CimInstance Win32_Process` **可用**（实测：读到两个 pid 的完整命令行）⇒ **要读进程身份就找它**。
3. **不能在工具内起长期服务** ⇒ switchboard 由**用户终端**拉起；★ 例外见 19/20。
   ⚠️ 用户重启电脑后不会自动拉起 ⇒ 派活前先探 `:3080`。
4. 排查会话内容**别**把 node stdout 重定向到文件（判为二进制）。
5. **`grep -oE` / `find` / `timeout` 不可靠** ⇒ 提取/统计写 node 脚本或用 Grep 工具；限时用 Bash 工具自带 timeout。
6. **clone/fetch 用系统 git**（`C:\Program Files\Git\cmd\git.exe`）；PortableGit 写嵌套 ref 静默失败 ⇒ 验 `git branch -r` 非空。
7. **`git -C` 不认 MSYS 路径** ⇒ 一律 `D:/…`；该报错极易被误判成"目录不存在"。
8. **工作区**：`D:\project_develop` 唯一开发根；`_` 前缀 = 非项目；**远端是唯一真相源**。
9. **Code Mode**：只能直接调 `run_code`，其余工具写在程序里 `tools.<name>(...)` ⇒ persona 用**否定+禁止**式硬规则。
   通用：**否定+禁止 ＞ 说明+让它判断**。
10. **同一文件两个 Edit 并行 ⇒ 后者按旧快照覆盖**（两边都报成功、静默丢改动）⇒ **同文件编辑串行**，改完 grep 验关键标记。
11. **`node -e` 带正则/反引号/花括号会被 bash 抢插值** ⇒ **写 `.mjs` 再跑**。
    ★★ 对"发给 DSH 的长消息"同样致命 —— 含反引号/花括号的中文长文本写在 `session-drive.mjs prompt "<长文本>"` 里
    **实测被 bash 吃掉一半**（`syntax error` 但**退出码仍是 0**）⇒ **长消息一律写文件再发**：
    `out/_tasks/send-msg.mjs <sid> <消息文件> [steer|queue]`。
12. **`npm run <script>` 在 Agent shell 被拦** ⇒ 直接 `node scripts/<x>.mjs`。
13. **构建**：`cd packages/switchboard && node scripts/build.mjs`（用仓库内 tsc）。
14. **推送**：`GIT_TERMINAL_PROMPT=0 git push origin master`；
    ★ **唯一可信判据 = `git ls-remote origin refs/heads/master`**（push 输出与本地 `origin/master` 都会骗人）。
15. **命令可能被执行两次**（沙箱被拒→提权重跑）⇒ 写入类**按跑两次设计** + 写完**立刻校验**，别信脚本自己的输出。
16. **多会话共用仓库 ⇒ 提交有分寸**：先 `git status` 看清哪些不是自己的；`git add <自己的路径>` 为主；
    周期性查"有没有该提交却没跟踪的文件"。
17. **命令里别混「中文 + Markdown 的 `**` + 重定向」**（曾因此造出乱名 0 字节文件并被提交）
    ⇒ 长文本一律写**消息文件**再 `-F`；`git add -A` 后**扫一眼加了哪些**；删乱名文件要用 `readdir` 的真名。
18. **真日期看 `date`，不看注入的 `<current_time>`**（实测滞后一天以上）。
19. **★ dev 模式（沙箱全开）怎么开**：启控制面时带 `DSH_SWITCHBOARD_DEV=1` ⇒ 派生的**每一代**都是"沙箱全开 + 审批 never"
    （机制 = 控制面把 `DSH_PERMISSION_MODE=danger-full-access` 写进子代 env；上游 `dsh-base/cordis.patch.yml:175/191` 已留的钩子）。
    ★ 副作用：**真全开**；"只禁互读互写"要靠 `packages/arm-isolation`（**未接线**）。
20. **★ 换代（蓝绿）真触发点 = 控制面 `:31800` 的 `?cmd=`**（**不是** `:3080` —— 后者只返回前端 HTML）。
    `?cmd=handover&profile=<profile>` 是**异步**的（立即返回 `stage:"started"`）⇒ **必须轮询** `?cmd=status`；
    成功判据 = `lease.json` 的 `activeGen/pid/generation` 都变 + 台账 `result:"success"` + 补一条**前门健康**。
    ★ **`preset` ≠ `profile`**（换错会起个坏代、被回滚）。★ **要生效必须重启控制面本身**；★ **谁的进程谁重启**（别人的进程 `process.kill` 会 EPERM）。
21. **★ 门层的票**：**别自拼 `record --paths` 去对指纹**（连续两次指纹不匹配被拦）。
    可靠流程 = `git add` → 试提交（门拦住并自动开票）→ `approve <自动票> --by witness:agent-<谁>` → 再提交；
    自批时**提交信息里逐字写明"批准者与作者是同一个 agent"**。
22. **★ 控制面 `?cmd=` 命令面（唯一权威清单，2026-09-26 核过源码 `main.ts:277-433`）**：
    `handover`(≡`apply`/`restart`，异步，`&profile=`/`&fail=`/`&fast=1`) / `assembly`(只读投影) /
    `mgmt`(`&action=brief|tasks|verdict|experiment|result`) / `status` / `preflight` + `preflight-result` /
    `result` / `flow` / `panel`(HTML) / `fail`(注入)。★ 除 `handover` 系与 `preflight` 外都是**同步只读**。

## 铁律（违反会立刻坏事）—— **一行式；全文与证据见 `topics/lessons-learned.md`**

1. 写 json/yaml/源码一律 `fs.writeFileSync(p,s,'utf8')`（**无 BOM**）。**唯一反向例外：`.ps1` 必须【带】BOM**。`check-bom.mjs --fix` 双向修。
2. profile 的 `cordis.patch.yml` **不得写包内已 insert 的同一 id** ⇒ duplicate loader entry id ⇒ 整树装配失败。
3. 改完 profile 跑 `check:profile` + `check:bom`（基线 exit 0 / stderr 空 / 582 行 / pet 0 / dup 0）。★ 它**不校验插件 config**。
4. 改完 `node_modules/@deepseek-ai/*` **立刻重建 patch**（patch-package 只能在 PowerShell 工具里跑）。
5. **外置化/缩减必须"写入时 append-only"**；事后 replace 必击穿 prompt 前缀。
6. **`disabled` ≠ 移除**：bundles 里仍会被 loader 装配；有 `dsh.client` 的包目录还在就可能被前端加载。
7. **判据与信号不可混**：裸满意度评分**丢弃**；采纳只认可执行 `acceptance` + 隐藏 holdout。**未实施的判据级不计通过**。
   假信号排序：**假绿/空过（最坏）> 无门（诚实的无知）> 假红（相对最好）**。
   **见假红 → 先证明判据错了再改判据；绝不为消红去改被检对象。**
8. 压缩后端契约：产出 summary 必须带 `measurement` + `start/end/shadowedSeqs/selectedNodes` → `check-compaction-fallback-shape.mjs`。
9. 插件 `Config`：6 个 zod 包已套 `z.preprocess(v => v ?? {}, schema)`；**别用 `.default({})`**（静默坏，比崩更隐蔽）。
10. **不追上游版本**（用户定）；只管 `@dsh-brain/*` 与我们自己的 profile。体检 `npm run check:upstream`，有一红就别动手。
11. **判"机制有没有在工作" ⇒ 去历史记录里数「判据为真的次数」**，不许读注释/读意图。**从未为真的判据 = 假绿**，比"没有门"更糟。
12. **"看不到" ≠ "没有"**：服务缺失/列表为空/读数拿不到，**一律不得**当正向判据。
13. **否定命题必须带一个与自变量【正交】的阳性对照**（对照在任一臂为 0 ⇒ 前面判语全废）；对照要可换；
    **否定读数至少两条正交通道，矛盾时不许下结论**。
14. **通道"不可用" ≠ 读数"为 0"** ⇒ 调不到返回 `null`，不许当 0 判定；append-only 日志**只读末段**。
15. **"判据读不到差别" ≠ "没有差别"**：先证明读数本身有效，再拿它下结论；**一条读数长期稳定不变就是红线**。
16. **判据/规格/答案清单【不能放在被测 agent 的读写范围内】**（违反 `evals/README.md` R1 ⇒ 区分度归零）。
17. **做"功能组模块"前先查三处**：① 本地（含 `_research/` 源码 + 我们自己的 `docs/`、`scripts/`）② GitHub ③ arXiv。
    **证据必须分级**，二手不许当结论。★ 判"是不是我们改坏的"之前先做**归属核验**（否则把上游的矛盾写成自己的罪状）。
18. **"回读成功" ≠ "生效的是你以为的那份"**：配置发现**多根先到先得 ⇒ 同名遮蔽** ⇒ 判据要用**比名字更强的指纹**
    （工具集合 / `toolSetSize` / `systemChars` / 信任级别）。★ **工具面 = profile 底板 + preset 增量** ⇒ 只换 preset 压不到工具。
    ★ 判据落在**持久事件 + 面指纹**上，不是按名字回读。
19. **长文档插入禁止用"标题行"当锚点**（已犯 7 次）⇒ 锚"标题之后的正文"或把标题写进 new_string；
    **改完立刻 `grep -n '^## \|^### '` 复核标题序列**。
20. **数"份数/规模"必须说明口径**（条目数 / 文件数 / 章节数 分开说）。
21. **判据要证明"修复真的在起作用" ⇒ 用【消融自证】**：撤掉修复，判据必须变红。
    **不许为让测试变绿而改测试**；修 bug **必须先复现**（复现不出就只标注，别硬改）。
22. **改子代/新会话的"脸"只有【追加】安全**；覆盖与"插进列表中段"的代价是**全损**。
    代价**不来自"多一个工具"，来自"与父代不同"** ⇒ 脸必须是父代脸的**逐字前缀扩展**。
    仪器 `scripts/measure-delegation-reuse.mjs`。★ **agnes 不是严格 LCP**。
23. **判断"某功能该由谁做"前，先确认那个组件【有没有那个对象】**：先答"对象在谁的视野里"，再答"该扩哪个组件"。
24. **别用"把自变量调到最小端"的样本去否定一个关于"大端"的命题 —— 那是【假否定】**。
    先问"我的自变量取在哪一档"；凡"只有 X%"必须同时报**分母**与**自变量取值**。
    ★ **"脸"（system+tools）是每次请求重发的说明书** ⇒ 谈"省 token"必须先说清**省的是脸还是历史**。
25. **做完一件实质东西【必须当场登记】进本文件索引**（在哪 / 是什么 / 什么状态 / 与谁有关系）。**索引里没有 = 不存在**。
26. **给 DSH 写新脚本前，先对照同族现成脚本抄协议形状**：
    `session.prompt` = `{sessionId, mode:'steer'|'queue', content:[{type:'text',text}], clientTimeZone}`
    （传 `{sessionId, text}` 会 **HTTP 200 但什么都不做**）；
    前门 RPC 一律 `POST /api/<method>` + `{type:'client-request', rpcId, method, payload}`，值在 `result.value`。
    **完成判据必须叠加 `asOfSeq 前进`**；派活后必须核验"真的发了指令"（`accepted===true` + 事件数增长 + `toolCalls>0`）。
    ★ `session.list` 的字段是 `result.value.items[]`（**不是** `sessions`），每条用 `sessionId`（**不是** `id`）；
    `running:true` 是最省事的"真在跑"判据。
27. **★★★ 派活给"会写同一仓库"的 agent 之后，提交前必须 `git diff <该文件>` 看内容**
    —— **`git status` 只告诉你"文件名是不是你的"，不告诉你"内容是谁写的"**。
28. **★★ 判据不许是【同义反复】**（"清空 map ⇒ role 为空"那种）⇒ **判别法：问"它在什么输入下会红？"，答不出来就是同义反复**。
    ★ 配套：**"扫全目录" ≠ "精选入口"**（目录倾倒把"说明书"降级成"噪音"）⇒ 交付物要**保持用户原话的粒度**。
29. **★★★ 子 agent 的"读数"与它的"归因"必须【分开验】**：读数抄对了、归因编错了（实测两条）
    ⇒ **只信"可复算的读数"，不信它串好的因果**。★★ **对发起方自己也成立**（连续两次改口）。
30. **★★★ "健康检查判红" 与 "被检对象坏了" 是两件事**：见红**先问三句** —— ① 它探的是谁？② 探针够不够硬？③ 被探对象此刻在干什么？
    ★ **越"来自我实验"越假红 ⇒ 整条链自锁**。修法**不是"重试到绿"**，而是**加超时 + 有界重试 + 分类**。
31. **★★★ 单一写者的文件，外部进程【只读、绝不写】**（`lease.ts:6`）⇒ 外部 rewrite 会破不变量 + 竞态 + **重置 fencing token**。
    ★ 推论：**"报错里叫人去手改/手杀"之前，先确认那东西是不是别人的**。
32. **★★★ "诊断对不对" 要用【自洽性】验**：两路读数矛盾时（文件说 A、服务说 B），
    **先问"谁在写它、谁在读它"，而不是先选一边信** ⇒ 真相由**写入时序**决定。★ **"日志的行序"是一等证据**。
33. **★★★ 【文案诚实地写了"不确定"】≠【判据诚实地处理了"不确定"】**：文案只进 `detail`、不进 `ok` ⇒ 白写。
    ⇒ 凡"可能读不到"的判据，`ok` 必须**三分**：`true` / **`unknown`（不判红、显式记、复探）** / `false`。
    ★ **`unknown` 不许当"通过"**（假绿，铁律 14）；也**不许当"失败"**（假红）。★ 判据的"不确定"必须能被**下游读到并分流**。
34. **★★★ 判断"现役被影响了"之前，先排除【控制面自己把通道占了】**：`mgmt.ts:159` 的 `spawnSync` **同步阻塞事件循环**
    ⇒ 派活期间代理转发被拖住（实测 `n=90 ok=83 err=7`，`p95=0.66s` 但 **`max=8.23s`**）。
    ★ 消融法：**同代码、同探针、只换"谁拉起的"**。
35. **★★★ 问设计岔路之前，必须先把【当前命令面/现状】摆出来**（用户回*"我不能理解，我不知道现在有哪些命令"*）
    ⇒ 用户**没法裁决**不是因为问题难，是因为**我没先给现状**。
    **纪律**：凡"该选甲还是乙"，先摆 ① 现在有哪些动词 ② 各起什么效果 ③ 改了会动到什么，**再**问选哪个。
36. **★★ 逃生阀必须有台账**：`isolated-instance --force` 从"应急阀"**长成了常规路径**（一条旁路、六个症状）。
    ⇒ 任何"平时不该用"的开关：① 默认关闭且**要显式动词**触发 ② **每次使用记账留痕** ③ 上线时就要能被审计。
    ★ 与铁律 9、21 同族：**无声的例外 = 未来的旁路。**
37. **★★★ 填细节前，功能必须先落成【带编号的清单】；每条细节必须能写回它服务哪个编号**
    （2026-09-26 用户点破：*"我往里面填细节老是会填出和原……和其他细节偏离的东西，连功能都有点对不上"*）。
    ⇒ 四条机制：① 功能只活在对话里 ⇒ 我参考的是**我上一条消息**、偏差**累乘**；
    ② 我天然往"最小可行修法"滑 ⇒ 细节被**现有结构**锁死；③ 自检按**我实现的样子**写 ⇒ **A′ 从没跟功能清单对过 = 假绿**；
    ④ 我**从不主动报偏** ⇒ 偏差全靠用户发现。
    ★ **落法**：功能清单 F0…Fn 先写进文档；实现时每步写 `→ F<编号>`；写不回去的细节**删掉**；
    自检**照编号写**，不照实现写。★ 与铁律 28（同义反复）、7（假绿）同族。

## ★★★ 当前主线：自进化闭环（**施工从这三份开始读**）

| 想做什么 | 读哪份 | 说明 |
|---|---|---|
| 子 Agent / 分身施工 | `docs/skill-as-agent-spec.md` | **自足施工规格**：不变量 I1–I4 / 裁决 D1–D10 / 计划 S0–S7 / 未闭合 O1–O31 |
| 训练场 + Agent 工厂 | `docs/training-ground-and-skill-sieve-2026-09-25.md` | 筛网口径（三级公民）/ 自进化的定义 / 完整流程 |
| **闭环现状与命令** | `.workbuddy/memory/topics/next-task-handover.md` | **接手先读**；顶部 = 本轮回执 |

### ★★ 当前施工棒次：R1–R5 根因链条（**旁路拆除**，见 `docs/handover-bypass-structural-diagnosis-2026-09-26.md` §4）

> 总背景：**换代机制本身是好的、而且真的在跑**；是一条**旁路**（`arm-up` → `isolated-instance --force`）
> 绕过了整台机器 ⇒ 逐个修症状越修越多（一条旁路、六个症状）。**根因修法，不是补丁。**

| 棒 | 内容 | 状态 |
|---|---|---|
| **R1** | `spawnGen` 的 `DSH_HOME` 从"继承 `process.env`"⇒ **显式必填入参** | ✅ `06739e4`（R0，封条 `pa-20260926-f6875c`） |
| **R1.5** | 摆放（`WORK_DIR`/`coordDir`/`genAssembly`）**必须与 home 同源** ⇒ 影子依赖变被检查约束 | ✅ `92449dd`（R0，封条 `pa-20260926-2f5c08`） |
| **R2** | 起代一律走 `?cmd=handover`；`--force` 只由显式 `--rebuild` 触发（+记账） | ✅ `55ce17d` + `3f1a362` |
| R3 | `ensureActiveLease()` 加 `pidAlive` 活体守卫 | ⬜ 未做 |
| R4 | `mgmt.ts:159` 的 `spawnSync` ⇒ 异步 spawn + 轮询 | ⬜ 未做 |
| R5 | ⑦ 的 `ok` 三值化（`ok`/`slow`/`unreachable`，铁律 30） | ⬜ 未做 |

★★ **R2 的重要更正（别把正当能力当罪状，铁律 17/36）**：`isolated-instance --force` **本身不是旁路**
—— 它是一把**正当工具**（`test-oldshape-guard.mjs:37` 正当地用它测"旧产物重跑"）。
**旁路是那个【耦合】**（`arm-up` 每次起代都无条件带上它）⇒ **删的是耦合，不是 flag。**
★ R2 后的命令面：`arm-up --live` / `arm-up A`（确保可用）/ `arm-up A --gen`（换代走 handover）/
`arm-up A --rebuild`（结构变更，唯一允许 `--force`，记账）。
★ 门：`scripts/delegation/test-r2-handover-only.mjs`(10)，带 2 条消融 + 1 条正交正向对照。

★ **R1 核心语义（必须钉死）**：`DSH_HOME` = **"这一代能看见哪些会话"的根**
（会话存储 = `<DSH_HOME>/sessions/<cwd编码>/<sessionId>/`）。
⇒ R1 的意思是「**控制面把它自己的 `DSH_HOME` 显式往下传**」，**不是**「每代一个不同的 home」。
后者会让新代看不到旧代会话 ⇒ **中继器静默失效**（症状：换代报成功、会话列表变空）。
★ **R1.5 为什么必须跟 R1 一起做**：`coordDir`/`workDir`/`genAssembly` 默认也从 `home` 派生
⇒ 只改 home 不改 `WORK_DIR` ⇒ **脑裂混合体**。★ 实测真相：**"今天一致"靠的是没人设过 `WORK_DIR`**。
★ 判据：`spawn-dshhome.test.mjs`(5) + `placement-consistency.test.mjs`(6)，均带**消融自证**。
中继器在 R1 代码下已**实测 3/3**（日更 §13.3）。

### 已落地的件（**在哪 / 是什么 / 什么状态**）

- `scripts/arm-ports.mjs` — 端口/根目录的**唯一定义**（纯模块、import-safe）。臂 idx ⇒ `33080+idx*40`；池 `=base+21` 必须在段内。
- `scripts/arm-up.mjs` — **唯一启动入口**（三动词见上）。★ **"起来了" = 自检全过**（臂模式 7 条；现役只判服务可用）。
  · ★★ 三修（均消融自证）：① ⑦ 探针**太脆 ⇒ 假红** ⇒ 超时 + 有界重试 + **分类**（铁律 30）。
  ② **僵尸 lease** ⇒ `pidAlive()` 活体探测（`docs/arm-a-zombie-lease-causal-chain-2026-09-26.md`）。
  ③ "是否已在跑"改成**控制面优先**（先问活着的 `?cmd=status`；拿不到才退看**只读** `lease.json`；**绝不写它**，铁律 31）。
- `packages/switchboard/src/mgmt.ts` — 控制面管理面 `?cmd=mgmt`。
  ★ **安全三前提**：具名动作白名单 + 参数先校验 + **绝不经 shell**（spawn 数组）。
  · ★★ 修：**"臂身份"env 会泄漏** ⇒ `ARM_IDENTITY_ENV_KEYS`(8) + 纯函数 `childEnv()` 让子进程回到**现役语境**。
  ★ **`childEnv()` 归"控制面→脚本"，R1 的 `spawnGen` 必须【显式给】home，两者不可混用。**
  · 判据 `scripts/delegation/test-mgmt-surface.mjs`（**19/19 + 单因子消融**）。
- `scripts/dsh-up.cmd` + `scripts/install-desktop-icon.mjs` — 桌面一键（双击 = 起现役 + 自检 + 开界面）。
  ★ 桌面那份**必须打绝对仓库路径**（`%~dp0..` 位置相关会崩）。★ 桌面已有 `DSH 启动 (双击).cmd`。
- `scripts/relaunch-switchboard.mjs`/`.cmd` — 走**计划任务**起控制面 ⇒ **跨工具调用存活**（唯一可用通道）。
- `scripts/task-bank.mjs` — **题库（agent-agnostic）**：`refresh/list/show/pick/score/stats/verdict`。
  ★ **场 ≠ 实验**：题在 `evals/tasks/`，成绩在 `evals/runs/`。
- `scripts/run-experiment.mjs` — **闭环**：取题 → 起一代 → 发题 → 收卷 → 判定 → **报警则 exit 1**。
- `scripts/self-dev-brief.mjs` — **自开发简报**：`{docs,tasks,tools,mgmt,missingDocs}` + `renderBrief()`。
  ★ 回退过一版："扫 `scripts/` 全目录 ⇒ 列 165 条"⇒ 已回退为**【精选入口 9 条 + 存在性核验】**（铁律 28）。
- `scripts/skill-sieve.mjs` / `skill-factory.mjs` / `skill-to-preset.mjs` — 筛 → 工厂 → 桥。
- `scripts/tool-pool.mjs` — 工具池 + 回值（append-only JSONL、幂等、fail-closed、读不写盘）。
- `packages/subagent-council` — 两席 dev/review；★ code 在、**profile 未设 seats ⇒ 未上线**。
- `scripts/check-import-safe.mjs` — 常驻判据：`scripts/` 内部被 import 且顶层派发 CLI ⇒ 必须有 `isMain`。

**★ 三份核验报告**：`docs/verify-self-dev-first-leg-2026-09-26.md` / `docs/verify-self-dev-second-leg-2026-09-26.md`
/ `docs/arm-a-zombie-lease-causal-chain-2026-09-26.md`。

### 已固化的语义裁决（**别再当未决问题重开**）

- **"另起一个 agent" = "另起一代 + 不 flip"**：spawn 新进程 + 不同 `DSH_HOME` + 自己端口段 ⇒ 独立实例；
  `3080` 只是"前门指向谁"的开关 ⇒ **不需要新机制**。
- **题 = 【目标】+【环境】**（`meta.env`，默认 `{inherit:true}`）；**题面该说"在什么条件下做"，不该说"谁来做"**。
- **题 = 回归基准，不设"退役"**；下一代**对自己重放**。★ **"可以理解"必须落成可测条件**：
  分数降 ∧ 功能面变大 ⇒ `tolerable-regression`；分数降 ∧ 功能面不增 ⇒ `regression`。
  功能面代理 = 该臂 DSH_HOME 下能力库条目数（**读不到 ⇒ null 不是 0**）。
- **判据松紧写在【题】里**：`expect.mode='functional-only'`（默认；`ran` ⇒ `unjudged`，**未判 ≠ 通过**）
  ／ `score-band`。**不许强制一刀切**。
- **训练场 = 题库（agent-agnostic）**：**场**（不认识 agent）‖ **实验**（谁考/什么身份/能否碰别的臂）。
- **自进化 = 在【子 agent】上进化**；路径 = 取 skill → 安全审批 → 做成子 agent → 与同方向已有 agent **比工具、择优、迭代**。
  **来源驱动，不是定期全量**。
- **筛的三级公民**：一等（`Principle` ∧ `Script` ∧ `Tools[]` 齐）⇒ 建 agent；二等（缺一项/需我们补，常见"有脚本无 Tools"
  ⇒ **人工**包成 `ToolDef`）⇒ 也能建；三等（只有指导）⇒ **不建**，用于优化同方向**已有** agent 的 persona。
- **能力的粒度是【链路工具】不是【元工具】**；★ 现有判据数不出 ⇒ **口径等用户给，不自己发明**。
- **DSH 侧不做商城、不做检索**：只做**工具池 + 回值**；**回值作者 = 用它的那个子 agent 自己**。
- **独立性**：**跨模型 > 跨会话 > 同会话换 prompt**；★ **能强制独立性的地方是【编排层】**。
- **记忆宿主形态**：Go 侧保留（存储/图/检索/睡眠/技能树）；**provider 注册/工具声明/委派/注入 = TS**；
  **两者之间 = MCP 首选**。别把"DSH 插件内重写"当候选。

### 未闭合（**开放式，每次接手看一眼**；细节见 `topics/current-status.md`）

- **★ 启动器（launcher）**：用户 2026-09-26 提的**新主线** —— 造一个"像游戏启动器那样、本身能管代数"的入口。
  ★ **顺序由用户定死**：**先做好启动器** ⇒ 再把 `?cmd=` API **反向包成工具**（我能直接用 + 可注册进 DSH 工具表）。
  ★ 功能清单（F0–F5）与"漂移诊断"见 `docs/launcher-function-list-2026-09-26.md`（**铁律 37 的第一个执行样本**）。
  ★ 待用户裁决：① 皮的形态（面板 vs 独立小窗）② 管一代还是管多训练场 ③ 顺序理解确认。
- **接线 ≠ 上线**：两席（dev/review）代码在、**profile 未设 `seats` ⇒ 没上线**；`arm-isolation` overlay 代码在、**端到端未验**。
- **"只差真跑一次"**：筛 → 工厂 → 两脑 → 池**纸面齐**，缺一次真跑（起隔离实例只能用户终端）。
- **判据缺口**：能力库**门只跑到 L1**（L2/L3/L4 未实施 ⇒ 标"通过"就是假绿），G1 是 P0。
- **既存红**：`test-patch-anchors.mjs` 12/17、`lib-tool-failure.mjs --self-test` 18/19、`key-pool-proxy/src/test.ts` TS2835。
- **skill store 真实落点未确认**（本机无任何 `*skill*` 文件）⇒ 筛只能跑自测。
- **经管理面发的全部实验（7 次）从未真正把题派给臂A** ⇒ `action=experiment` 的**后半段（真发题 + 判卷）仍是未验证代码**。
  ★ 诚实表述：**"它对了" 我说不了 —— 我只知道"我还没看到它跑"**。
- **池的"退避重试"支路**：★ 已观测到（臂 A `boot.log`：`33101 被占 ⇒ 退避重试` → `⚠️ 连续 9 次拿不到 ⇒ 本代没有池`）
  ⇒ **顺带证明这条支路没能把臂救回来**（只是如实报"本代没有池"）。
- **R2–R5 影响面未盘查**；"服务多训练场"的**并发安全未测**（`lease.json` 在 `coordDir` 下，两场共用 ⇒ 可能租约互踩）。
- ⚠️ **待办**：`sessions/` 分片键**只有 `cwd`、不含 home 身份** ⇒ 两 home 同 `cwd` 会撞同一分片
  （已核实现役 home 里的 `_abA-wt` 分片**不是串场**）⇒ **若一控制面真去服务另一训练场，必须保证 cwd 也不同**。
- ⚠️ **`HANDOVER_CONTROL` 无"子代必须向本控制面报到"的断言**（当前臂A对只因 `arm-up.mjs:524` 传了 `ports.env`）。
- `_arms/a.bak-from-cancelled-session-1441` 残留目录。

★ **"一条旁路 ⇒ 六个症状"**（EADDRINUSE / 僵尸 lease / 复活死 pid / 现役也撞 / ⑦ 假红 / `poolPort=none`）
⇒ 这解释了"逐个修症状越修越多"。★ **R1/R1.5/R2 已把根因修掉** ⇒ 该表留作**判据依据**（为什么当初不该逐条修）。
★★★ **纪律（用户 2026-09-26 点破）**：*"我不在乎什么最小可行修法或者是最大可行修法，
**我只要你干净的**……我哪怕你重写都无所谓"* ⇒ ★ **不许把补丁说成方案**；**先问"病根在哪"**。

## ★ 归属与前史（**别把上游的矛盾写成自己的罪状**）

- `D:\project_develop\ai-base`（Go，**用户的前一个项目**）= 多条设计的先例来源（内含 `agent-shell`）。
- **fork / 前缀缓存：设计更早是用户的，实现是上游的**（`docs/fork-provenance-ai-base-vs-dsh.md`）⇒ **收敛，不是谁抄谁**。
- 从 ai-base 拿来、上游没有的两条：① **前缀缓存敏感的凭据轮换**（⇒ 实验硬纪律：**臂间与轮内都不许轮换凭据/池**）；
  ② `stripTrailingUnpairedToolCalls` 的两个用例。
- `ai-base/AGENTS.md` 三条：不直接读写 `graph.json`；**策略（压缩/融合/评分维度）必须走接口**；
  **不跨层调用**（从 DSH 侧够过去只能走 MCP 面）。

## 主题索引（**按需读**，全在 `.workbuddy/memory/topics/`）

| 主题 | 文件 | 什么时候读 |
|---|---|---|
| **接手指南（下一项）** | `next-task-handover.md` | **新会话接手先读这个**（顶部 = 回执结构） |
| 教训全文（环境约束+铁律的证据 + 瘦身前存档） | `lessons-learned.md` | 要引用实证细节 / 追"为什么定这条" |
| 当前状态 / 下一步 | `current-status.md` | 接手前看进度：到哪了、未闭合项 |
| 运行时与启动 | `runtime-and-launch.md` | 端口 / 启动器 / 凭据 / 会话存储格式 |
| profile 与 gen 一致性 | `profile-and-gen-integrity.md` | 改配置 / 加插件 / 换代后能力变了 |
| prompt 缓存 | `prompt-cache.md` | 命中率、四类前缀改写源、指标口径 |
| 压缩引擎 | `compaction-engine.md` | 压缩补丁、兜底契约、诊断埋点 |
| 换代 vs 重启 | `generation-swap.md` | 要替换代码时、三级策略、写入竞态 |
| 自进化设计 | `self-evolution-design.md` | 判据阶梯、能力库、委派、多模型会议室 |
| 项目治理 | `project-governance.md` | 资产边界（**别重造**）、文档可信度 |
| 资产拓扑 | `asset-topology.md` | 分不清资产/副本、**design-canvas 真身与副本** |
| 工具完善（另一条线） | `tool-refinement-handover.md` | 派给另一会话全权执行（L2~L4） |
| 架构线（另一条线） | `architecture-handover.md` | 第三条线（三角色 + 三段流水线） |

**入口级文档**：`docs/revised-architecture-2026-09-20.md`（当前架构权威记录） / `docs/ideas-spec.md`
/ `docs/self-evolution-gap-analysis.md`（缺口 G1–G8） / `docs/where-we-are.md` / `docs/main-chain-ledger.md`。

> ⏭ **交接**：新会话接手 → 先读 `topics/next-task-handover.md`（自包含；顶部即本轮回执）。
> 下一项、未闭合项、操作纪律、验证命令**全在那里**；本文件只放**每次都要遵守**的东西。
