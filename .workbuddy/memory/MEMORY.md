# dsh-brain — 长期项目笔记（**索引 + 每次都要遵守的东西**）

在 DeepSeek Harness (DSH) 底座上，把 agent-shell 工程思路解耦重做成 Cordis 插件：
三脑编排 / 上下文压缩 / 工具自进化 / 护栏 / LLM 路由。

> ★ **本文件是索引，不是细节仓库。** 每条只留"要遵守什么"；**"为什么定这条 / 实证细节"全文存档在
> `.workbuddy/memory/topics/lessons-learned.md`**（含本文件历次瘦身前全文）。
> · **接手先读**：`topics/next-task-handover.md`（顶部 = 本轮回执）
> · **进度/未闭合**：`topics/current-status.md`
> · **日更**（append-only，尾部最新）：`.workbuddy/memory/YYYY-MM-DD.md`
> ⚠️ **本文件已【四次】超限被注入截断**（2026-09-27 实测 32,907 B 触发截断 —— **安全上限 ≈ 28KB**）。
> ⇒ **加新条目必须同时压缩/下沉旧的**（铁律 25 的执行面）。**30KB 即视为红线**。
> ⚠️ 铁律编号**不复用**（跨文件引用靠编号：lessons-learned 与日更里都按这套号说话）。
> ★ **瘦身操作手册**：全文逐字下沉到 `topics/lessons-learned.md` 或 `topics/current-status.md`，本文件只留**一行索引**。

## 环境约束（本机工具层）—— **一行式；全文见 `topics/lessons-learned.md` 附录**

> ★ 2026-09-27 二次下沉（原 5,152 B ⇒ 1.6KB ⇒ 现 ~1.1KB）。**动手前若有疑问，去读附录的逐字版。**

| # | 遵守什么 |
|---|---|
| E1 | Bash 开头先修 PATH（System32 / Windows / usr bin / nodejs / Git cmd）。 |
| E2 | **PowerShell 通道基本不可用**（stdout 被吞；node spawn ENOENT）⇒ 走**纯文件通道**；★ 例外 `Get-CimInstance Win32_Process` **可用**（`wmic` 已不存在）。 |
| E3 | **不能在工具内起长期服务**；★ 例外 `scripts/relaunch-switchboard.cmd`（计划任务 ⇒ 跨调用存活）但**在本 shell 会阻塞** ⇒ 当**后台任务**跑 + **另开一次调用**看端口/探针。派活前先探 `:3080`。 |
| E4 | 排查会话内容**别**把 node stdout 重定向到文件（判为二进制）。 |
| E5 | **`grep -oE`/`find`/`timeout` 不可靠** ⇒ 写 node 脚本或用 Grep 工具；限时用 Bash 自带 timeout。 |
| E6 | **clone/fetch 用系统 git**（`C:\Program Files\Git\cmd\git.exe`）；PortableGit 写嵌套 ref 静默失败。 |
| E7 | **`git -C` 不认 MSYS 路径** ⇒ 一律 `D:/…`（该报错易被误判成"目录不存在"）。 |
| E8 | **工作区**：`D:\project_develop` 唯一开发根；`_` 前缀 = 非项目；**远端是唯一真相源**。 |
| E9 | **Code Mode**：只能直接调 `run_code`，其余写在程序里 `tools.<name>(...)` ⇒ persona 用**否定+禁止**式。 |
| E10 | **同文件并行编辑** ⇒ 后写者按旧快照覆盖（**两边都报成功、静默丢改动**）⇒ **同文件编辑串行** + 改完 grep 验标记。 |
| E11 | **`node -e` 带正则/反引号/花括号被 bash 抢插值** ⇒ **写 `.mjs` 再跑**；★ **发给 DSH 的长消息一律写文件再发**（中文长文本走命令行会被吃掉一半，**退出码仍是 0**）。 |
| E12 | **`npm run <script>` 在 Agent shell 被拦** ⇒ 直接 `node scripts/<x>.mjs`。 |
| E13 | **构建**：`cd packages/switchboard && node scripts/build.mjs`。 |
| E14 | **推送唯一可信判据 = `git ls-remote origin refs/heads/master`**（push 输出与本地 `origin/master` 都会骗人）。 |
| E15 | **命令可能被执行两次**（沙箱被拒→提权重跑）⇒ 写入类**按跑两次设计** + 写完**立刻校验**。 |
| E16 | **多会话共用仓库 ⇒ 提交有分寸**：先 `git status` 看清哪些不是自己的；`git add <自己的路径>` 为主。 |
| E17 | **命令里别混「中文 + Markdown 的 `**` + 重定向」**（曾造出乱名 0 字节文件并被提交）⇒ 长文本写**消息文件**再 `-F`；`git add -A` 后**扫一眼加了哪些**。 |
| E18 | **真日期看 `date`，不看注入的 `<current_time>`**（实测滞后一天以上）。 |
| E19 | **dev 模式**：启控制面时带 `DSH_SWITCHBOARD_DEV=1` ⇒ 每一代都"沙箱全开 + 审批 never"（**真全开**）。 |
| E20 | **换代真触发点 = 控制面 `:31800` 的 `?cmd=handover`**（**不是** `:3080`）；**异步 ⇒ 必须轮询 `?cmd=status`**；成功 = `lease.json` 的 `activeGen/pid/generation` 都变 + 台账 `success` + **前门健康**。★ `preset` ≠ `profile`；★ 要生效**必须重启控制面本身**；★ **谁的进程谁重启**。 |
| E21 | **门层的票**：**别自拼 `record --paths`**；走 `git add` → 试提交（门自动开票）→ `approve <票>` → 再提交。 |
| E22 | **控制面 `?cmd=` 命令面**：`handover`/`assembly`/`mgmt`/`status`/`preflight`/`result`/`flow`/`panel`/`fail`（除 `handover` 系与 `preflight` 外都**同步只读**）。 |
| E23 | **★★★ `.cmd` 输出是 GBK(936)** ⇒ 必须 `new TextDecoder('gbk')`；按 utf8 读 ⇒ **假绿**（判据要**两路并存**）。★ 测含空格的路径**必须加引号**（不加 = 根本没执行到目标）。 |

## 铁律（违反会立刻坏事）—— **一行式；全文与证据见 `topics/lessons-learned.md` 附录「铁律全文」**

> ★ 2026-09-27 压缩：每条只留**"要遵守什么"**。**"为什么定这条 / 实证细节 / 反例"** 全文（15.3KB）
> 在 `lessons-learned.md` 附录，**一条没删**。★ 动手前若这条关乎你正在做的事，**去读附录**。
> ⚠️ 编号**不复用**（跨文件引用靠编号）。

1. 写 json/yaml/源码一律 `fs.writeFileSync(p,s,'utf8')`（**无 BOM**）。**唯一反向例外：`.ps1` 必须【带】BOM**。
2. profile 的 `cordis.patch.yml` **不得写包内已 insert 的同一 id** ⇒ duplicate loader entry id ⇒ 整树装配失败。
3. 改完 profile 跑 `check:profile` + `check:bom`（基线 exit 0 / stderr 空 / 582 行 / pet 0 / dup 0）。★ 它**不校验插件 config**。
4. 改完 `node_modules/@deepseek-ai/*` **立刻重建 patch**（patch-package 只能在 PowerShell 工具里跑）。
5. **外置化/缩减必须"写入时 append-only"**；事后 replace 必击穿 prompt 前缀。
6. **`disabled` ≠ 移除**：bundles 里仍会被 loader 装配；有 `dsh.client` 的包目录还在就可能被前端加载。
7. **判据与信号不可混**：裸满意度评分**丢弃**；采纳只认可执行 `acceptance` + 隐藏 holdout。**未实施的判据级不计通过**。
   假信号排序：**假绿/空过（最坏）> 无门（诚实的无知）> 假红（相对最好）**。
   **见假红 → 先证明判据错了再改判据；绝不为消红去改被检对象。**
8. 压缩后端契约：产出 summary 必须带 `measurement` + `start/end/shadowedSeqs/selectedNodes`（→ `check-compaction-fallback-shape.mjs`）。
9. 插件 `Config`：6 个 zod 包已套 `z.preprocess(v => v ?? {}, schema)`；**别用 `.default({})`**（静默坏，比崩更隐蔽）。
10. **不追上游版本**（用户定）；只管 `@dsh-brain/*` 与我们自己的 profile。体检 `npm run check:upstream`，有一红就别动手。
11. **判"机制有没有在工作" ⇒ 去历史记录里数「判据为真的次数」**，不许读注释/读意图。**从未为真的判据 = 假绿**，比"没有门"更糟。
12. **"看不到" ≠ "没有"**：服务缺失/列表为空/读数拿不到，**一律不得**当正向判据。
13. **否定命题必须带一个与自变量【正交】的阳性对照**；**否定读数至少两条正交通道，矛盾时不许下结论**。
14. **通道"不可用" ≠ 读数"为 0"** ⇒ 调不到返回 `null`，不许当 0 判定；append-only 日志**只读末段**。
15. **"判据读不到差别" ≠ "没有差别"**：先证明读数本身有效；**一条读数长期稳定不变就是红线**。
16. **判据/规格/答案清单【不能放在被测 agent 的读写范围内】**（违反 `evals/README.md` R1 ⇒ 区分度归零）。
17. **做"功能组模块"前先查三处**：① 本地 ② GitHub ③ arXiv。**证据必须分级**，二手不许当结论。
   ★ 判"是不是我们改坏的"之前先做**归属核验**。
18. **"回读成功" ≠ "生效的是你以为的那份"**：配置发现**多根先到先得 ⇒ 同名遮蔽** ⇒ 判据要用**比名字更强的指纹**。
   ★ **工具面 = profile 底板 + preset 增量**；判据落在**持久事件 + 面指纹**上。
19. **长文档插入禁止用"标题行"当锚点**（已犯 7 次）⇒ 锚"标题之后的正文"或把标题写进 new_string；**改完立刻 grep 复核标题序列**。
20. **数"份数/规模"必须说明口径**（条目数 / 文件数 / 章节数 分开说）。
21. **判据要证明"修复真的在起作用" ⇒ 用【消融自证】**：撤掉修复，判据必须变红。
   **不许为让测试变绿而改测试**；修 bug **必须先复现**（复现不出就只标注）。
22. **改子代/新会话的"脸"只有【追加】安全**；代价**不来自"多一个工具"，来自"与父代不同"**。
   仪器 `scripts/measure-delegation-reuse.mjs`。★ **agnes 不是严格 LCP**。
23. **判断"某功能该由谁做"前，先确认那个组件【有没有那个对象】**（先答"对象在谁的视野里"）。
24. **别用"把自变量调到最小端"的样本去否定关于"大端"的命题 —— 那是【假否定】**。
   ★ **"脸"（system+tools）是每次请求重发的说明书** ⇒ 谈"省 token"必须先说清**省的是脸还是历史**。
25. **做完一件实质东西【必须当场登记】进本文件索引**（在哪 / 是什么 / 什么状态）。**索引里没有 = 不存在**。
26. **给 DSH 写新脚本前，先对照同族现成脚本抄协议形状**：
   `session.prompt` = `{sessionId, mode:'steer'|'queue', content:[{type:'text',text}], clientTimeZone}`；
   前门 RPC 一律 `POST /api/<method>` + `{type:'client-request', rpcId, method, payload}`，值在 `result.value`。
   **完成判据必须叠加 `asOfSeq 前进`**；`session.list` 用 `result.value.items[]` + 每条的 `sessionId`。
27. **★★★ 派活给"会写同一仓库"的 agent 之后，提交前必须 `git diff <该文件>` 看内容**
   —— **`git status` 只告诉你"文件名是不是你的"，不告诉你"内容是谁写的"**。
28. **★★ 判据不许是【同义反复】** ⇒ **判别法：问"它在什么输入下会红？"**，答不出来就是同义反复。
   ★ 配套：**"扫全目录" ≠ "精选入口"** ⇒ 交付物要**保持用户原话的粒度**。
29. **★★★ 子 agent 的"读数"与它的"归因"必须【分开验】** ⇒ **只信"可复算的读数"，不信它串好的因果**。
   ★★★ **对【审者/反方席位】同样成立，且它会更自信地编** ⇒ **「审者说坏了」也不是依据**。
30. **★★★ "健康检查判红" 与 "被检对象坏了" 是两件事**：见红**先问三句**（探的是谁 / 探针够不够硬 / 被探对象在干什么）。
   ★ **越"来自我实验"越假红**；修法**不是"重试到绿"**，而是**加超时 + 有界重试 + 分类**。
31. **★★★ 单一写者的文件，外部进程【只读、绝不写】** ⇒ 外部 rewrite 会破不变量 + 竞态 + **重置 fencing token**。
   ★ 推论：**"报错里叫人去手改/手杀"之前，先确认那东西是不是别人的**。
32. **★★★ "诊断对不对" 要用【自洽性】验**：两路读数矛盾时，**先问"谁在写它、谁在读它"** ⇒ 真相由**写入时序**决定。
33. **★★★ 【文案诚实地写了"不确定"】≠【判据诚实地处理了"不确定"】** ⇒ 凡"可能读不到"的判据，`ok` 必须**三分**：
   `true` / **`unknown`（不判红、显式记、复探）** / `false`。★ **`unknown` 不许当"通过"也不许当"失败"**。
34. **★★★ 判断"现役被影响了"之前，先排除【控制面自己把通道占了】**（`mgmt.ts` 同步 spawn 阻塞事件循环）。
   ★ 消融法：**同代码、同探针、只换"谁拉起的"**（实测 `p95=0.66s` 但 **`max=8.23s`**）。
35. **★★★ 问设计岔路之前，必须先把【当前命令面/现状】摆出来**（用户：*"我不知道现在有哪些命令"*）
   ⇒ 先摆 ① 有哪些动词 ② 各起什么效果 ③ 改了会动到什么，**再**问选哪个。
36. **★★ 逃生阀必须有台账**：① 默认关闭、**要显式动词**触发 ② **每次使用记账留痕** ③ 上线即可审计。
37. **★★★ 填细节前，功能必须先落成【带编号的清单】；每条细节必须能写回它服务哪个编号**
   ★ 落法：清单 `F0…Fn` 先写进文档；实现每步写 `→ F<编号>`；写不回去的**删掉**；自检**照编号写**。
38. **★★★ 模块级"空模板"常量【不许浅拷贝返回】**（`return { ...EMPTY }` 含数组 ⇒ 同进程全实例共享）。
   指纹：**单实例单测永远全绿**；`a.others === b.others` 为 `true` ⇒ 确诊。修法：`freshEmpty()` + `.slice()` + 返回**快照**。扫同族 `scripts/scan-shallow-share.mjs`。
39. **★★★ 不许在【用户桌面】上起任何可见窗口做实验**（`start`/GUI/弹窗**一律不许可**；要弹窗**先问**）。
   ★ **换通道前先证明新通道看得见阳性对照**；**一次改多变量后不许归因**。
40. **★★★ 派生物必须被门覆盖，判据要落在【用户真正碰的那个对象】上** —— **最坏的形状 = 被检查的都干净、用户碰的那个没人管**。
   ★ 落法：门覆盖派生物 + **指纹重算 & 逐字节比对** + 三态 `PASS/FAIL/SKIP`；**生成器自己把关**。
41. **★★★ 文本型判据（`indexOf` / 正则）必须做【作用域限定】** —— 跨作用域命中 = **假红**；**长期假红的门比没有门更糟**。
42. **★★★ "禁止编造"必须落成【可执行判据】** —— 凡产出把**某符号**说成在**某文件/某行** ⇒ **真去那里找**，找不到即红。
   ★ 判据**必须收窄到"引证"**；无引证的新符号**只报 `unlocated` 不判红**（三态）。
43. **★★★ 【我改了】≠【我认为我改了】—— 讨论优于一次性交接**。凡"我改了"**必须贴产物**（文件:行 / 输出 / diff）。
   ★ **「未收敛（分歧保留）」是合法终态**。★ **门与讨论不可互替**。
44. **★★★ 改一个文件的【结构】前，先查"有没有别的门靠它的【现有形态】在工作"** —— 修完**看那道门的"被检数量/阳性计数"有没有变** + 补**阳性对照**。
   ★★ **缩进本身不带"我在哪个块里"** ⇒ 判"顶层派发"必须**按块结构**判（放松成"任意缩进"会**造假红**）。
45. **★★★★ 【判据只查"我知道的那个入口" ⇒ 一旦实现有第二条路径就整片失明】**（`ec2d8ae`）
   ⇒ 先问 **"这条路径是不是【用户真正碰的那条】？它有没有【第二条入口】？"**；★ **归因错了 ⇒ 修法也会错**；修法收敛成**单一真相源** + 判据**"跟着委派走"**。
46. **★★★★ 【"没人清理"必须说清清的是哪个对象】—— 同一个词可能指【内存引用】也可能指【磁盘目录】**
   ⇒ 实例：**池干净（`pool.json` = 1/0/0）、盘脏（54 个死代目录零删除点）**。**对象错了，整条读数就是假的**。

## ★★★ 当前主线：自进化闭环（**施工从这三份开始读**）

| 想做什么 | 读哪份 | 说明 |
|---|---|---|
| 子 Agent / 分身施工 | `docs/skill-as-agent-spec.md` | **自足施工规格**：不变量 I1–I4 / 裁决 D1–D10 / 计划 S0–S7 / 未闭合 O1–O31 |
| 训练场 + Agent 工厂 | `docs/training-ground-and-skill-sieve-2026-09-25.md` | 筛网口径（三级公民）/ 自进化的定义 / 完整流程 |
| **闭环现状与命令** | `.workbuddy/memory/topics/next-task-handover.md` | **接手先读**；顶部 = 本轮回执 |

### ★★ R1–R5 根因链条（**旁路拆除**，全文见 `docs/handover-bypass-structural-diagnosis-2026-09-26.md` §4）

> **换代机制本身是好的、且真在跑**；是一条**旁路**（`arm-up` → `isolated-instance --force`）绕过整台机器
> ⇒ 逐个修症状越修越多（一条旁路、六个症状）。**根因修法，不是补丁。**
> ★ 五棒**全部已落地**（R1 `06739e4` / R1.5 `92449dd` / R2 `55ce17d`+`3f1a362` / R3 `a64bed1` / R4 `6be53af` / R5）。
> ★ 细节/封条号/部署陷阱/假红假绿 **全文在 `topics/current-status.md` 尾部**。三条最易踩：
> ① **换代只换代、不换控制面**（`main.ts` 在控制面进程里 ⇒ 改它必须 `arm-up.mjs --stop` → `--live`）；
> ② **控制面与前门同进程**，`--live` **幂等**；③ **池剪枝只能走真实 `stand` 路径验证**（注入 `pool.json` 必假绿）。
★★★ **纪律（用户）**：*"我不在乎什么最小可行/最大可行修法，**我只要你干净的**"* ⇒ **不许把补丁说成方案**。

### ★★★ 2026-09-27 席位只读的两棒（`cc702de` → `ec2d8ae`）

**棒一（`cc702de`）**：修掉"persona 只是话"的假约束（architect 席真写过仓库文件）。修法 = `SEAT_TOOL_SCOPE`（只读席给 `allow` 白名单 7 个工具 ⇒ **fail-closed**；dev 不设限 = 阳性对照）。
门 = `seats-toolscope`（静态）+ `seats-toolscope-e2e`（**直调上游**）。
**棒二（`ec2d8ae`）= 铁律 45 教科书案例**：**两道旧门全绿，而现役只读席位仍能写仓库** —— 因为现役委派走的是**另一条路径**（one-shot 调 `start()` / **continuable 调 `prepareContinuable()`**，后者当时逐字 `return Promise.resolve({})` ⇒ persona + toolFilter **双双丢失**）。
★ **现役默认走 continuable** = **用户真正碰的那条**。修法 = 抽 `#enrich()` 单一真相源两路共用；门 = `test-seat-toolscope-continuable.mjs`（**8/0**，已进 `check-all`），判据**"跟着委派走"**（认 `this.#enrich(...)`）+ **双向消融自证**。
★ 归因修正：原记「写在 persona 里的约束不是约束」是**错的** —— 真因是这条路径**从未把 persona 交出去**。
⚠️ **`packages/*/lib/` 被 gitignore** ⇒ 改源码后**必须重编译 + 换代**才生效。
★ 全文在工作区日更 `2026-09-27.md` 与 `topics/current-status.md`。

### ★★★ 2026-09-27 运维盘存（用户三问取证，**只读探针，未改任何东西**）

**问**：① 启动为什么混乱 ② 决策边界（为什么我不自己拍）③ 能不能抄成熟智能体。
**三条实测底账（可复算）**：**启动** = 10 个入口 / 4 种语言 / 1,198 行，三处 **0 字节断头路**，顶层 **README = 0 个**；
**死代** = 55 个 gen 目录（现役 1 / 死代 54，≈545 KB），★ **池干净、盘脏**（铁律 46）；
**视图** = `?cmd=panel` → `main.ts:559 panelHtml`（69 行），只覆盖换代/交接 + 端口 ⇒ **视图已在，缺的是覆盖面**。
**架构师席裁决（已核验）**：Q1 元判断**采纳** / Q2 判据**采纳**（「是否影响用户核心控制权」）/ Q3 **不采纳**（太薄、零具体框架）。
★ 它引用**部分行号不准**、P0/P1/P2 **出处记错**（真出处 `docs/BUILD.md:141`）；`journal.jsonl` **不存在**。
★ 取证产物全在 `out/`：`_startup-inventory.mjs` / `_gen-inventory.mjs` / `_probe-gen-deletion.mjs` / `_probe-panel2.mjs` / `_architect-verification.md` / `_consult-architect-answer.md`。

### ★★★ 2026-09-27 席位定义外置 + 向外部市场格式「**兼容**」迁移（**本轮主线，全文见 `topics/current-status.md` 尾部**）

★ **用户定的性质 = 兼容，不是照抄**：原话 *"我们的范围不是比它更广吗？我们的 Skill Tree 的字段不是完全包括它吗？……我们还有**工具面**等的设定 ⇒ 我们要的是**兼容它**。"*
⇒ 落法 = 我们的 schema 是它的**超集**（它只有 3 个 frontmatter 字段；我们有 8 个必需章节 + 工具档位 + provenance 四项 + **F5 一致性门**）。
★ **迁移目标 = 把硬编码换成"一份源 → 生成物 → CI gates drift"**（对齐它的可移植原则⑤）。
★ **落地形态**：`seats/schema.json`（规格）+ `seats/library/*.md`（源）+ `scripts/seats/gen-seat-registry.mjs`（生成器）
+ `seat-registry.generated.ts`（生成物）+ **两道门**（`seat-definitions` + `seat-registry-drift`）。
★ **provider 名 = 席位唯一名** = `council-architect` / `council-dev` / `council-review`（旧短名走**垫片**）。
★ **未闭合（必须报）**：① `seat-contract.mjs` 源切换**仍在 DSH（`ZyXHyy`）手里**（旧源 `/api/...` 已失效 ⇒ 抛错）；
② `seats-check.mjs` ②③ 红 —— **根因已查明 = 迁移真的改了内容**（新 md 无旧 persona 章节名）⇒ **需显式裁决**；
③ **F5b 消融上次 sed 空转 ⇒ 不算通过，待重做**；④ 本棒改动**尚未提交**。

### ★★ 三席上线状态（**2026-09-27 更正后的事实**）

★ **现役已是三席**（`1566527`，`gen-3083`，boot.log 三行注册齐）—— 此前那句"假绿"已于本轮闭合。
★ 三席 persona/契约的**单一真相源（迁移后）** = `seats/library/*.md` ⇒ 经 `gen-seat-registry.mjs` 生成到
  `packages/subagent-council/src/seat-registry.generated.ts`。**别再手改生成物**（第二道门会报漂移）。
★ 转座位相关先读 `docs/agent-seats-spec-2026-09-26.md`。
★ 加新席位 ⇒ **必须用不同 id**（`subagent-council` 已被包内 patch insert 过；重复 = `duplicate loader entry id` = 整树装配失败，铁律 2）。

### ★★★ 用户架构愿景：**一人公司**（2026-09-27，**决定后续所有设计**）

用户原话：*"让用户只和一个 AI 进行讨论，然后这个 AI 去统一调度整支……整个一人公司一样……**对应的部门内部自己去运转**。"*
★★★ **配套裁决**：*"直接互相发任务不就好了……**为什么不让 LLM 自己决定谁发言呢**"*
⇒ ★ **纪律：机器不许替 LLM 做语义判断**。"该派给谁"是**语义判断** ⇒ 只能由 LLM 做；
  我们只提供**可执行的事实**（有哪些部门 / 各自管什么 / 交付形状 / 工具域）⇒ 落点 = `AGENTS.md` 花名册。
★ **机制事实（已核上游源码）**：`send_message`/`interrupt_agent` 是**全局命名工具**，可发给直接子或更深后代
  ⇒ **席位之间可直接互发**；但**不打断当前轮**（"cannot redirect work already underway"）⇒ 忙碌席位会**排队**。
★ **AGENTS.md 注入机制**：`@deepseek-ai/dsh-agent-instructions` 在**首次请求组装时**注入
  （**不是** `session.create` 时 —— 只 create 不发消息 ⇒ 零 instructions，曾因此吃**假红**）；
  `kind:"agent-instructions"`、**住在 `request/header`** ⇒ **每次请求重发**（属"脸"，铁律 24）。文件变了**热更新**。
★ **已落地件**：`scripts/seats/gen-roster.mjs`（生成器，幂等，`--check` 检漂移）+ `AGENTS.md`（**2,734 B ≈ 900 token**）
  + `seat-contract.mjs` 的职责边界解析。★ 契约**从 persona 源码解析**、**不许手抄第二份**（G0）；解析失败 **fail-closed**。

### ★★ 未决设计岔路：「秘书席 / 公司隐喻」（用户 2026-09-27 提出，**待用户定**）

用户提议加**秘书席**（记录归纳对话 + 专职沟通），把系统做成"公司"。
★ **机制事实**：`report` 只解析 **"the reporting child's live direct parent"** ⇒ **通信只在【父↔直接子】方向向上**；
  **无同层对等通道** ⇒ **"部门"存在、"转交"能沿【树】做，但不能【平级转交】。**
我的判断（**不推进**）：① "整理归纳"本质是**上下文压缩**，`conveyor-context` 已在做；② 多一层转发 ⇒ **信息损耗 + 重复动作**；
③ "转交给对应部门"里的**"对应"是判断** ⇒ 又一处可假绿处；④ **先让多部门真的存在**，再谈专职协调位 ——
否则是"给只有一个人的公司设秘书岗"。★ 若要推进，最该做的是**把"转交"落成显式可审计记录**（唯一不能靠 prompt 解决的部分）。

## 主题索引（**按需读**，全在 `.workbuddy/memory/topics/`）

**接手指南（下一项）** `next-task-handover.md`（**新会话先读，顶部 = 回执结构**） ·
**教训全文 / 铁律证据** `lessons-learned.md` ·
**当前状态 / 未闭合** `current-status.md` ·
`runtime-and-launch.md`（端口/启动器/凭据/会话存储） ·
`profile-and-gen-integrity.md`（改配置/加插件/换代后能力变了） ·
`prompt-cache.md` · `compaction-engine.md` · `generation-swap.md` · `self-evolution-design.md` ·
`project-governance.md`（资产边界**别重造**/文档可信度） · `asset-topology.md`（分不清资产/副本） ·
`tool-refinement-handover.md`（另一条线 L2~L4） · `architecture-handover.md`（另一条线：三角色 + 三段流水线）

**入口级文档**：`docs/revised-architecture-2026-09-20.md`（架构权威记录） / `docs/ideas-spec.md` /
`docs/self-evolution-gap-analysis.md`（缺口 G1–G8） / `docs/where-we-are.md` / `docs/main-chain-ledger.md`。

## ★ 归属与前史（**别把上游的矛盾写成自己的罪状**）

- `D:\project_develop\ai-base`（Go，**用户的前一个项目**）= 多条设计的先例来源（内含 `agent-shell`）。
- **fork / 前缀缓存：设计更早是用户的，实现是上游的**（`docs/fork-provenance-ai-base-vs-dsh.md`）⇒ **收敛，不是谁抄谁**。
- 从 ai-base 拿来、上游没有的两条：① **前缀缓存敏感的凭据轮换**（⇒ 实验硬纪律：**臂间与轮内都不许轮换凭据/池**）；② `stripTrailingUnpairedToolCalls` 的两个用例。
- `ai-base/AGENTS.md` 三条：不直接读写 `graph.json`；**策略（压缩/融合/评分维度）必须走接口**；**不跨层调用**（从 DSH 侧够过去只能走 MCP 面）。

> ⏭ **交接**：新会话接手 → 先读 `topics/next-task-handover.md`（自包含；顶部即本轮回执）。
> 下一项、未闭合项、操作纪律、验证命令**全在那里**；本文件只放**每次都要遵守**的东西。
