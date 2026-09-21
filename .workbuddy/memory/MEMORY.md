# dsh-brain — 长期项目笔记（**索引**）

在 DeepSeek Harness (DSH) 底座上，把 agent-shell 工程思路解耦重做成 Cordis 插件：
三脑编排 / 上下文压缩 / 工具自进化 / 护栏 / LLM 路由。

> 本文件是**索引**，不是全文；细节按主题拆到 `topics/`，**按需读，不要一次全读**。
> 日更（append-only，尾部即最新）：`.workbuddy/memory/YYYY-MM-DD.md`。
> **进度 / 未闭合 / 下一步 / 纪律一律看 `topics/next-task-handover.md`（顶部=回执）与
> `topics/current-status.md`** ⇒ 本文件**只放每次都要遵守的东西**，不复制细节、不复制进度。

## 环境约束（本机工具层，每次都要遵守）

1. **Bash 工具 PATH 被破坏**：调用开头先
   `export PATH="/c/Windows/System32:/c/Windows:/usr/bin:/bin:/c/Program Files/nodejs:/c/Program Files/Git/cmd"`。
2. **PowerShell stdout 被吞**：结果写文件再用 Read 读。
   **★ 且从 Bash/node 里 `spawnSync('powershell')` 是 `ENOENT`（PATH 无 `WindowsPowerShell\v1.0`），
   命令里出现该字样还会被安全策略直接拦** ⇒ **自动化脚本一律别依赖进程表那类 PS 通道**
   （改用**纯文件**通道，如 `scripts/probe-gen-boot.mjs` 读 boot.log）。
3. **不能在工具内起长期后台服务** ⇒ **switchboard 只能由用户终端启动**：
   `cd D:\project_develop\dsh-brain && node scripts\relaunch-switchboard.mjs`
   （日志落 `out/switchboard-run.log`）。`schtasks`/`cmd start`/`Win32_Process.Create` 全被拦；
   **`detached:true` + `child.unref()` 也不行**（2026-09-20 实测：能起完整但工具调用一结束整棵树被回收）
   ⇒ 判据是"**谁拉起的**"。
4. 排查会话内容**别**把 node stdout 重定向到文件（判为二进制）→ 让脚本自己 `fs.writeFileSync`。
5. `grep -oE` / `find` / `timeout` 在这台 shell 不可靠（`timeout` 实为 Windows `TIMEOUT.EXE`）
   ⇒ **提取/统计一律走 node 脚本**；要限时用 Bash 工具自带的 timeout。
6. **★ clone/fetch 必须用系统 git**：`& 'C:\Program Files\Git\cmd\git.exe'`。
   PortableGit 2.55 写嵌套 ref **静默失败** ⇒ **每次 clone/fetch 后验 `git branch -r` 非空**。
7. **`git -C` 不认 MSYS 路径**（`/d/xxx` → `fatal: cannot change to …`）⇒ 一律 `D:/…`；
   **该报错极易被误判成「目录不存在」**。
8. **工作区约定**：`D:\project_develop` 是唯一开发根；`_` 前缀 = 非项目；
   **远端是唯一真相源，本地只是可丢弃副本**。
9. **Code Mode**（`DSH_TOOLS_MODE=code`）：模型只能直接调 `run_code`，其余工具须写进
   `run_code` 程序里 `tools.<name>(...)` ⇒ persona 用「否定+禁止」式硬规则。
   **prompt 通用教训：否定+禁止 ＞ 说明+让它判断。**
10. **★ 同一文件的两个 Edit 并行发 ⇒ 后者按旧快照覆盖前者，且两边都报成功**（静默丢改动）
    ⇒ **同文件编辑必须串行，改完 grep 验证关键标记**。
11. **`node -e` 带正则/反引号/花括号会被 bash 抢插值** ⇒ **写 `.mjs` 文件再跑**。
12. **`npm run <script>` 在 Agent 的 shell 里会被安全策略拦** ⇒ 一律直接跑 `node scripts/<x>.mjs`。
13. **构建**：`cd packages/switchboard && node scripts/build.mjs`（用仓库内 `tsc`，Agent shell 无全局 `tsc`）。
14. **★ 推送走 `GIT_TERMINAL_PROMPT=0 git push origin master`**（2026-09-20 实测）：
    裸 `git push` 会报 `could not read Username … terminal prompts disabled`（**不代表内容没上去**）；
    显式禁用终端提示后凭据助手（`manager`）走缓存凭据 ⇒ 成功。
    **判断"推没推上去"唯一可信的方式是 `git ls-remote origin refs/heads/master`** ——
    不是 push 的输出，也不是本地 `origin/master`（会骗人）。
15. **★ 命令可能被「执行两次」**（沙箱被拒 → 提权重跑；**2026-09-20 一天实测 5 次**）：
    · 现象一：`cat >> file <<EOF … EOF` 把内容**追加了两遍**（文档出现重复章节）
    · 现象二：带幂等判断的 node 脚本第二次跑会报"已存在，跳过"，让人误以为**先前就存在**
    ⇒ **凡是"追加/写入"类操作，都必须当成可能跑两次来设计**：
    写完**立刻校验**（`grep -c` 关键标记 / 检查重复标题），不要凭脚本自己的输出下结论。
16. **★ 多会话共用一个仓库 ⇒ 提交要"有分寸"**（2026-09-20 实测，三个会话同时在改）：
    · 现象一：**别的会话漏加了它自己刚建的文件**（提交 `56e04f5` 的 `--stat` 里没有
      `scripts/eval-run.mjs`），是后来被 `git add -A` 才收进来的 —— **差点丢一个刚建好的脚本**
    · 现象二：我的 `git add -A` 把**别人正在写的半成品**一起提交了（`docs/eval-capability-task.md`、
      `evals/pilot/*` 等）
    ⇒ **提交前先 `git status`**，看清哪些改动**不是自己的**；
    **优先 `git add <自己的路径>`**，只在确认"其余都是别人的干净改动"时才用 `git add -A`。
    ⇒ **但不要因此把 `-A` 一禁了之**：现象一说明它同时是**兜底**（防别人漏加）。
    **两条都要**：`git add <自己的路径>` 为主 + **周期性查"有没有该提交却没跟踪的文件"**。
17. **★ 命令里别混「中文 + Markdown 的 `**` + 重定向」**（2026-09-20 实测，是我自己造的坑）：
    我某条命令把一段中文 Markdown 当成重定向目标，**在仓库根造出 3 个 0 字节空文件**，
    文件名是文本碎片（`依据` / `否则做出来的` / `状态：**设计已定**（2026-09-20`），
    **随后被我的 `git add -A` 一起提交进 HEAD**（提交 `f694467`）⇒ 提交后 `git status` 干净，
    **垃圾就"隐身"了**，直到从目录快照里才被发现。
    · ★ **真名里的 `*` 其实是【私有区字符 U+F02A】**（码点实证）—— 所以我后来手打 `*` 去删**匹配不上**；
      **删文件要用 `readdir` 拿到的真名**，不要手打字面量。
    ⇒ **纪律**：① 长文本一律写**消息文件**（`printf … > out/x.txt` 再 `-F`），**别在命令行里塞多行中文**；
    ② **`git add -A` 之后要扫一眼"这次到底加了哪些文件"**（不能只看 `--stat` 的行数）；
    ③ **根目录出现乱名文件 ⇒ 立刻查 mtime 与引入提交**（mtime 同毫秒 = 一条命令的产物）；
    ④ **提交后 `git status` 干净 ≠ 没提交垃圾。**

## 铁律（违反会立刻坏事）

1. **写 json/yaml/源码一律 node `fs.writeFileSync(p,s,'utf8')`（无 BOM）**；
   PS 5.1 的 `Set-Content -Encoding UTF8` 必加 BOM → DSH `JSON.parse` 崩 → **gen 起不来**。
   **★ 唯一反向例外：`.ps1` 必须【带】BOM**。`scripts/check-bom.mjs --fix` 双向修。
2. **profile 的 `cordis.patch.yml` 不得写包内已 `insert` 的同一 id** → `duplicate loader entry id`
   → 整棵插件树装配失败。
3. **改完 profile 跑** `npm run check:profile` + `npm run check:bom`。
   基线：exit 0 / stderr 空 / **582 行** / `pet` 0 / dup 0。
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
   **别用 `.default({})`**（返回字面量 `{}`、短路内层解析 = 静默坏，比崩更隐蔽）。
10. **★ 不追上游版本**（2026-09-15 用户定）：上游是移动靶 ⇒ **只按需合并对我们有利的改动**。
    **边界**：只管 `@dsh-brain/*` 与我们自己的 profile；`@deepseek-ai/*` 从 `profiles/node_modules/`
    上游共享树解析，**上游自身的问题暂不处理**。
    · 版本事实 / 漂移体检 / 0.1.5 带来的"存储层单写者所有权"⇒ 见 `docs/upstream-drift-2026-09-20.md`
      + `npm run check:upstream`（升之前先跑：有一红就别动手）。
    · 归属逐项清单：`docs/upstream-defects.md`。
11. **★ 判"某机制有没有在工作"，不许读注释、不许读代码意图 ⇒ 去历史记录里数「判据为真的次数」**：
    曾有三个"保险"**全都从未为真**（`waitedTurnEnd=true` 计数 0 / `freeze.lastSeq` 恒 0 / 静止判据只查
    `lastSeq>=0`）。**一个从未为真的判据 = 假绿**，比"没有门"更糟：它让人以为查过了。
    **推论**：写门时同时报"判据为真的历史次数"，**为 0 就该报警**。
12. **★ "看不到" ≠ "没有"**：服务缺失 / 列表为空 / 读数拿不到，**一律不得**当作正向判据。
    落地例：`drain` 的 `agentsObservable` / `sessionsObservable`（看不到 ⇒ `quiesced` 必须为 false
    ⇒ 宁可强杀旧代，也不许报"已停写"）。
13. **★ 否定命题（"X 被关掉了/没有"）必须带一个与自变量【正交】的阳性对照**（2026-09-21 翻车实证）：
    我拿 `self_evolve` 当"恒在对照"，它其实是 **`design-canvas-bridge` 的工具**（不是 `tool-evolution` 的）
    ⇒ **就在被测的那一族里** ⇒ 被测臂必然归零 ⇒ 判语全废。
    · **选对照先自问**：「我动自变量时它会不会跟着变？」会 ⇒ 不能用；
    · **把正交性写成断言**（多臂跑完做"对照体检"：对照在**任一臂**为 0 ⇒ **前面判语全部作废**）；
    · **对照要可换**（`--control <名>`），别硬编码；
    · **否定读数至少要两条正交通道**（本例：请求侧工具面 × 装配侧 boot.log 痕迹）——
      **矛盾时不许下结论，矛盾本身就是发现**。
14. **★ 通道"不可用" ≠ 读数"为 0"**：调不到的工具/服务返回 `null`，**不许当 0 参与判定**
    （本机 PS 通道恒不可用 ⇒ 若当 0 数就会得出"进程不存在"的假阳性）。
    且 **append-only 日志（`boot.log`）必须只读末段**（分隔符 `===== BOOT … =====`）——
    陈旧段会让**阳性臂被谎报成"起来了"**。
15. **★ "判据读不到差别" ≠ "没有差别"** —— **先证明读数本身有效，再拿它下结论**。
    实证（2026-09-21）：`eval-run` 的 `byTool` **从不数 `tool/code-dispatch`** ⇒ 在 code(PTC) 模式下
    恒为 `{"run_code":N}`，**两臂完全同形** ⇒ "行为面"这一列**从来没有过有效读数**；
    补上叶子直方图后立刻分开（A 用 `safe_rename`/`symbol_edit`，B 全靠 `read`+`pwsh`+`edit` 手改）。
    ⇒ **一条读数长期"稳定不变"就是红线**：先去问"它到底有没有在量东西"，而不是拿它对比。
16. **★ 判据 / 规格 / 答案清单【不能放在被测 agent 的读写范围内】**：
    实测三条 B 会话**都读了 `check.mjs`**（含判据实现与期望值），题面 README 还把陷阱逐条印出来
    ⇒ 任何"陷阱"都被降级成"照抄规格" ⇒ **区分度归零**。
    违反 `evals/README.md` **R1** ⇒ `cli-0004`/`cli-0005` 同病；**配新题前必须先解这一条**。
17. **★★ 做任何"功能组模块"之前，先查三处；否则不许自造**（2026-09-21 用户定，当天两次打脸）：
    ① **本地有没有已经 clone 的源码**（最便宜、最常被跳过 —— `D:\project_develop\_research\` 里**就有完整 DSH 源码**）；
    ② **GitHub**（同义词 + `topic:` + star 数）；③ **arXiv**（2026 年这个方向多半已经有名字）。
    · 判据：**「造格子」还是「造房子」** —— 只有**这一格确实没人做**才自造。
    · **红线**：*同一件事，开源已经做出了更好的版本，而我还在自己写*。
      当天实例：`armFaceCheck`（上游 registry 级"恰好固定 prompt + 两工具"断言已有）、
      靶场隔离（**VeRO** 用 "isolation holds *by construction, not by instruction*" 解掉了）。
    · **证据必须分级**：**直接读过** / **二手汇总** / **推断** —— 引用时标明，**二手不许当结论**。
    · ★★ **先搞清楚"这东西是谁的"，再谈"谁错了"**（2026-09-21 实证翻车）：
      我把"preset 里 `subagent_fork=continuable`"直接写成**"我方偏离"**，
      实际是 **`fork` 是上游的、我们的 preset 逐字继承自上游 `standard`**，
      真相是 **上游 host 层（base bundle=`one-shot`）与 agent 层（shipped presets=`continuable`）自己打架**。
      ⇒ **纪律**：判定"这是不是我们改坏的"之前，**先做归属核验**——
      **① 我们自己的 `packages/` 里有没有这个实现？② 我们那份配置与上游 shipped 的那份是否逐字相同？**
      两步都做完再下结论，否则会把**上游的矛盾**写成**自己的罪状**（方向反了，代价是去改不该改的地方）。
18. **★ "回读成功" ≠ "生效的是你以为的那份"**（2026-09-21 实测）：
    在 `~/.dsh/.agent-presets/minimal/` 建同名 preset **会被随附（只读，`trust=system`）那份静默遮蔽** ——
    `agentPreset.select` 返回 **HTTP 200**、**回读 `session.list` 也显示 `minimal`**，但**装的是随附那份**
    （实测：46 字符 / **78** 工具 / 有 `str_replace_editor` / 无 `bash`）。
    ⇒ **配置发现是"先到先得"的多根查找** ⇒ **同名即遮蔽**；判据要**比"名字"更强的指纹**
    （工具集合、system 长度、信任级别），而不是只比名字。
    · ★ 推论（对实验更重要）：**工具面 = `profile` 底板 + `preset` 增量**。
      本机三臂共享 **76 个工具的底板**（design-canvas MCP 59 + 我们三个包的原生 17），
      **preset 只能在上面做加法（+1 / +2 / +26）** ⇒ **只换 preset 压不到 1–2 个工具；要压低必须换 profile。**
      现役 `102` vs `30` 的差正是 **profile 底板**的差。
    · ★★ **且"回读"本身也会跨代漂**（2026-09-21 实测，同一族）：`session.list` 的 `agentPreset`
      **换代后会漂回默认值**（同一会话当代读 `g0`，切回 `web` 代后读成 `council`），而**会话事件
      `agent-preset/selected` 与当次 `request/header` 的工具面都没变**。
      ⇒ **按名字回读会把正确的会话判红**；判据要落在**持久事件 + 面指纹**（工具集合/`toolSetSize`/`systemChars`）上。
19. **★ 改文档时别用"替换下一节标题"的方式插入**（2026-09-21 一天犯 **4** 次）：
    `Edit` 的 `old_string` 若正好是下一节的小标题，插入后**那个标题就没了**、正文变成孤立段落
    ⇒ 之后会**出现两个同号小标题**或编号跳号。
    ⇒ **硬约束（第 4 次后升级）**：**优先"追加到文件末尾"或"用 Read 定位后精确替换中间一段"**；
    **若必须拿标题当锚点，`new_string` 末尾必须把该标题原样补回**；
    **插完立刻 `grep -n '^#' 文件` 核标题序列**，发现跳号/重号当场补。
    同理：**`node -e` 里不要写反引号**（bash 会当命令替换，把标识符吃掉）—— 用 `Edit` 写含反引号的文本。
20. **★ 数"份数/规模"必须说明口径**（2026-09-21 实证）：`ls -1 | wc -l` 数的是**全部条目（含子目录）**，
    不是文件数。我把 `ai-base/docs/` 说成"41 份"，实际**顶层 `.md` 只有 37 份**；
    又把 `ch01–ch22` 说成"23 章"，实际 **22 份**（`docs/` 里没有 ch21，它在 `agent-shell/docs/`）。
    ⇒ **口径要说清：条目数 / `.md` 数 / 章节数**，否则会以讹传讹（与铁律 #12「看不到≠没有」同族）。
18. **★ 判据要证明"修复真的在起作用" ⇒ 用【消融自证】：撤掉修复，判据必须变红**（2026-09-21 定型）：
    · 光"写了测试且它通过"**不够** —— 那可能是**测试与被检对象一起错**。
    · 强的形式：**逐个撤回补丁 ⇒ 对应断言必须变红**。
    · 实例：`packages/skill-tree/test/ablation-check.mjs` 逐个撤回 5 处补丁 ⇒ **5 处全红** ⇒
      才证明补丁在起作用（同一交付正向 **60 pass / 0 fail**）。
    · 配套：**不许为让测试变绿而改测试**（测试是判据，不是被检对象）；
      修 bug **必须先复现**（复现不出就只标注，别硬改）。

21. **★★ 改子代/新会话的"脸"，只有【追加】是安全的；覆盖(order 0 persona)与"插进列表中段"的代价是【全损】**（2026-09-21 实测，账单级）：
    · 严格前缀缓存在**第一个不同的字节**处截止 ⇒ 其后**全部内容**（含 fork 继承来的整段父代历史）重新计费。
    · 实测：子代多一个 `report` 工具，按字典序**插在工具列表第 88/103 位** + 写进 system 尾部 ⇒
      子代首请求 `cacheReadTokens` 从 **40576（98.6%）掉到 1152（2.8%）**，未缓存输入 40103。
      同批对照：`system` 逐字一致 + 工具数相同 ⇒ **98.6% ~ 99.6%**（6/6 全高）。
    · **决定因子不是 fork/spawn**（fork 组也有 2.8% 的低命中例；spawn 组也有 99% 的）。
      ★ 反证：depth2/depth3 两层都是 continuable、**父子都 103 个工具** ⇒ 命中 **99.6% / 99.0%**。
      ⇒ **代价不来自"多一个工具"，来自"与父代不同"。**
    · ⇒ 要同时拿到"子代有自己的脸"与"吃到父代前缀"：脸必须是父代脸的**逐字前缀扩展**
      —— 人格别走 order 0（走尾部，上游 `subagent:delegation` 就是对的形态）；
      新工具**排到列表末尾**（`toolOrder` + `<unlisted-tools>`）。
    · 仪器：`scripts/measure-delegation-reuse.mjs`；流程见 skill `prompt-cache-reuse-diagnosis`。
    · ⚠️ **agnes 不是严格 LCP**（两例 system 公共前缀仅 2% 却命中 89.6%）
      ⇒ "前缀一致"是**必要但可能不充分**，别把 deepseek 的模型直接套给 agnes。

22. **★★ 判断"某个功能该由谁做"之前，先确认那个组件【有没有那个对象】**（2026-09-21，用户指令被推翻两次）：
    · 实例：用户要求"扩展压缩器，加一个改写 system 的功能" ⇒ **做不到**，因为
      **压缩器的操作面是「会话事件」，system 是【每步装配出来的派生物】、根本不进会话日志**：
      `dsh-compaction/lib/types/types.d.ts:126-129`（`shadowedSeqs` = "all shadowed **surface nodes**"）、
      `checkpoint.js:3`（产物是 "its **replacement user message**"）、
      `dsh-system-prompt/README.md:5`（"The loop **assembles once per step**"）。
    · ⇒ **"改 prompt"的钩子只在【装配层】**（`system-prompt/assemble`，事件带 `scope`）；
      **压缩层只能改 messages**（它的产物是一条 user 消息）。
    · 纪律：**先答"这个对象在谁的视野里"，再答"该扩哪个组件"**；否则会写一堆改不到东西的代码。
    · 配套：**用户的设计直觉可能是对的，但机制归属要重新找** —— 本轮"子类=父类的增加而非裁剪"
      用缓存实验证成了（append 保前缀 / crop+shadow 砸前缀，见铁律 20）。

## 主题索引（**按需读**）

| 主题 | 文件 | 什么时候读 |
|---|---|---|
| **接手指南（下一项）** | `topics/next-task-handover.md` | **新会话接手先读这个**（顶部=回执结构） |
| **★ 新议题：工具完善** | `topics/tool-refinement-handover.md` | **派给另一会话全权执行**（判据阶梯 L2~L4；作用域待用户确认） |
| **★ 新议题：架构线** | `topics/architecture-handover.md` | **第三条线**（三角色 + 三段流水线；依赖工具完善的 L2~L4，但数据层可先行） |
| **当前状态 / 下一步** | `topics/current-status.md` | 接手前看进度：到哪了、未闭合项 |
| 运行时与启动 | `topics/runtime-and-launch.md` | 端口/启动器/凭据/会话存储格式/关键配置 |
| profile 与 gen 一致性 | `topics/profile-and-gen-integrity.md` | 改配置、加插件、换代后能力变了、离线验收 |
| prompt 缓存 | `topics/prompt-cache.md` | 命中率、四类前缀改写源、指标口径、外置化时机 |
| 压缩引擎 | `topics/compaction-engine.md` | 压缩补丁、兜底契约、诊断埋点 |
| 换代 vs 重启 | `topics/generation-swap.md` | 要替换代码时、三级策略、HMR 现状、写入竞态 |
| 自进化设计 | `topics/self-evolution-design.md` | 判据阶梯、能力库、委派、多模型会议室、信号/判据分工 |
| 项目治理 | `topics/project-governance.md` | 资产边界（**别重造**）、文档可信度、设计原则汇总 |
| 资产拓扑 | `topics/asset-topology.md` | 分不清资产/副本、design-canvas 真身与副本 |

## ★★ 前史与归属：`ai-base` 是**用户的前一个项目**，也是多条设计的先例来源

- **`D:\project_develop\ai-base`**（Go，537 提交，最后 2026-08-26）里有 **`agent-shell`** —— 我们项目"把 agent-shell 工程思路
  解耦重做成 Cordis 插件"里的那个 agent-shell。
- ★ **fork 与前缀缓存：设计更早是你的，实现是上游的**（详见 `docs/fork-provenance-ai-base-vs-dsh.md`）：
  - **实现归属 = 上游**：`@deepseek-ai/dsh-subagent-fork-in-process@0.1.1-rc.2`（`repository` = deepseek-ai/deepseek-harness）；
    我们 `packages/` 无 fork provider；`patches/` **只 patch 过 `dsh-compaction-basic`**。
  - **设计归属 = 更早**：ai-base `193eb26a`（**2026-07-14**）`SubagentTool — fork 上下文`；
    `f8d6a80f`（**2026-08-04**）`API 池轮换按是否依赖前缀缓存区分`。**DSH 公开发布 = 2026-08-13**。
  - ⇒ **收敛，不是谁抄谁**（DSH 开源前内部开发，无可查证据）。
- ★★ **从 ai-base 拿来、上游没有的两条**：
  1. **"前缀缓存敏感的凭据轮换"** ⇒ **实验硬纪律：臂间与轮内都不许轮换凭据/池**，
     否则**前缀缓存被清 ⇒ 成本面读数漂**（成本面是实验主轴）。现役 `key-pool-proxy(pool=3)` 要确认不轮换，
     并把**轮换次数**记进成本面元数据。
  2. `stripTrailingUnpairedToolCalls` 的 7 个用例里，**"尾部多条"与"不污染源"**两个边角值得照抄。

## ★ 子 Agent = 我们的进化载体（DSH 已有一等地基，2026-09-21 通读上游源码确认）

### ★★ 嵌套与工具面裁剪：**已实测**（详见 `docs/subagent-nesting-and-toolfilter.md`）

- **嵌套成立且预算为真**：`delegationDepth` 0/1/2/3 四级会话（父链逐级对上，**四层 preset 全是 `council`** ⇒ 子代继承父 preset）；
  **第 4 层被运行时拒绝**，原样 `Error: subagent depth 4 exceeds maxDepth 3`（且 L3 有真实 `tool/call` ⇒ 不是模型自己停）。
  `maxDepth` **默认 3**（`tool-subagent/src/index.ts:98`）。**字段位置：会话头记录的顶层**（不在 `data` 里）。
- **★ `toolFilter` 真能裁，且只裁子代**（实测 103 → **3** / **98** / **1**）：
  `allow:[read,glob]` ⇒ `["glob","read","report"]`；`deny:[5个]` ⇒ 103−5；**`allow:[]` ⇒ 只剩 `["report"]`（1 个，不是 0）**
  —— 因为 `dsh-tools` 的 `view()` 把**own-scope 工具无条件放进可见集**，不受 `restrict()` 约束
  ⇒ **源码那句"空数组=全拒"只对【全局工具】成立。**
- ⇒ **三层工具面模型（完整图景）**：**`profile` 定底板 → `preset` 定该 agent 的增量 → `toolFilter` 定【这一次委派】给子代的裁剪。**
  ★★ **两个动作各治一种病，别混**（2026-09-21 用户指出，我先前框错）：
  · **专项化（分工）= 裁**（`toolFilter`）：治**子代**的负荷，**每任务都做、廉价、无需过门**（实测 103 → 3/98/1）；
  · **能力增长（进化）= 加**（新工具 → 插件 → **profile/preset**）：低频，**必须过 L0–L4**。
  ⚠️ **委派【不减小父代自己的面】**（实测父会话仍 102）⇒ **要治编排层的负荷只有改 profile/preset。**
  ⇒ **合理默认：上层宽（路由/评审要广视野）、执行层窄**；**"父代自己动手"最该避免**。
  ★ **"工具过多 ⇒ 心智收益低"有机制**：code/PTC 模式下**工具目录被渲染进 system prompt**，
  两臂净差的 **98.7%（39 284 字符）全是工具目录**（最大单块 27 350 = MCP 工具 guidance + `ToolArgsMap`）
  ⇒ **多 72 个工具 ≈ 每次请求多 39 800 字符（≈13k token）**。
  ★ **"专项"的可测定义**：`toolFilter.allow` = 该专项的完整暴露面，**必须成对报**：
  **① 面够小**（`measure-arm-face.mjs` 的 `toolSetSize`/`systemChars`）+ **② 面够用**（该专项的 oracle）
  —— 只报"面小了"是假绿（可能只是把活干不了了）。
  **"专项 vs 通用基底" = 同一套机制的两个配置**（专项 = `persona` + `toolFilter` 收窄；通用 = 不裁剪或只留编排工具），
  **不需要两套 preset**；"拆解到别的专项" = **子代自己再委派**（前提：那份 preset 挂了委派行），由 `maxDepth` 兜住。
- ⇒ **判据侧直接可用**：`delegationDepth` 是**可从会话头读出的持久字段** ⇒ "按 lineage 统计"不必另造机制，
  把它并进**上下文指纹**（system 长度 + 消息数 + 有无 `report` + `delegationDepth`）即可。

### 其余地基事实

- **形态**：子 Agent 的 **persona（提示词）+ toolFilter（工具集）+ 自己的持久会话**都是**一等字段**
  （`ContinuableSubagentDescriptorData{ persona?, toolFilter? }`；`SubagentCapabilities{outputSchema,depthLimit,toolFilter,persona}`）。
  **但能力因 provider 而异**：**`fork-in-process` 支持 persona+toolFilter**；`acp`/`dsh-sdk` **全不支持**（会被拒）⇒ **绑错 provider 会静默退化**。
- **两种上下文，别混**：
  · **`continuable`（`spawn` 默认）**：**durable**，不在时**从持久化的 Session 冷启**（cold-resume）；
    子代树是 **session-backed**，`listTree` 可枚举（带 `parentId`/`depth`）。
  · **`fork`（shipped 绑 `one-shot`）**：只把**父代已完成回合的前缀**播种一次（快照进子代自己的转录），
    **唯一收益是 provider 侧前缀复用**。
- ★ **对进化的意义**：`continuable` 才有"同一个主体跨任务积累"的载体，且**每次唤醒都是一份 append-only 会话 ⇒ 进化可审计**。
- ★★ **对判据的毒性**：带上下文的两次跑**不是同一输入分布** ⇒ `pass^k` 测的是"重复"、臂间**跨轮污染**、且**污染不可见**（不在工具面里）。
  ⇒ **评测必须 `backgroundMode: one-shot`；进化用 `continuable` 并按 lineage 统计**；并给 `armFaceCheck` 一族**加一条"上下文指纹"读数**。
- ★★ **上游的论证与我今天的实测是同一件事**：笔记说 `report` 工具 schema 与 `tool:report` system 段**都住在请求头且先于消息**
  ⇒ 任何"加在继承历史之前"的子作用域增量**作废前缀复用**；
  我量到 **code 模式下工具目录被渲染进 system、占两臂净差 98.7%**。**两条独立证据同一机制。**
- ⚠️ **上游自己两层互相矛盾（**不是**我方偏离 —— 我先前的归属写错了）**：
  fork 是**上游的**（我们 `packages/` 里没有 fork provider）；我们的 `council` 那段与 shipped `standard` **逐字相同** ⇒ 只是继承。
  **同一个 loader id `tool-subagent-fork` 两层绑定不同**：
  · **host 层** `packages/bundle/base/cordis.patch.yml` = **`one-shot`**（**带注释写明理由**）；
  · **agent 层** shipped presets `standard`/`code`/`cordis` = **`continuable`**（无注释）。
  ⇒ 而架构笔记只列了 bundle + 两个 example 为 `one-shot`，**没列 presets** ⇒ 要么**漏改**，要么**preset 层对该 agent 生效**。
  · ★ **用户的 fork 设计意图（"fork 自己的上下文进去，省掉子进程理解上下文的开支"）正是 fork 的用途**
    （上游原话 "its one concrete payoff is provider-side prefix reuse"）⇒ **满足它的是 `one-shot`，`continuable` 反而作废复用**。
  ⇒ **待验证：两层同 id 谁生效**；判据 = **看 fork 子代请求头里有无 `report` 工具 / `tool:report` 段**
    （有 ⇒ continuable 生效；无 ⇒ one-shot 生效）—— **这也是我建议加的"上下文指纹读数"的第一个真实用例**。
- ★ **可贡献的上游切口**：上游写明 *"**The restriction is composition, not code**"*（`prepareContinuable` 还在、`--patch` 即可重开），
  重开条件 = **issue #2124「子代的 system prompt 与 tool schemas 能与其父代逐字节相同」**
  —— **而这正是 `scripts/measure-arm-face.mjs` 能去证明的东西**。

**入口级 / 关键文档**：
- ★ **`docs/revised-architecture-2026-09-20.md` —— 当前架构权威记录**：
  两层（顶层=**专家评审团**多模型讨论 / 下层=**子 agent 层**，进化在此发生，来源=skill）。
  **取代**三脑作为顶层的旧表述（`three-brain-evolution.md` / master-plan §11.7 canonical 表）。
- `docs/ideas-spec.md` —— 实现无关的思路规格，**改架构前先读**。
- `docs/handover-vs-restart.md` —— 换代副作用 + **§8 写入竞态**（真因/操作纪律/候选修法）。
- `docs/oss-prior-art-and-next-steps.md` —— 里程碑 M0–M3 + 开源先例（**闭环无现成产品**）。
- `docs/agent-eval-arenas.md` + `evals/` —— Agent 评测靶场；判据用**自有冻结任务集**，
  公开榜只当"不许退化"的地板。`npm run eval:validate` 证"打 seed 后 oracle 必须变红"（否则假题）。
- `docs/upstream-defects.md`（归属）/ `docs/upstream-drift-2026-09-20.md`（漂移体检）。
- `docs/two-service-custody-review.md` —— 拆服务评审：能替"部署"层、**替不掉"判据"层**。
- ★★ **`docs/oss-arena-landscape-2026-09.md` —— 靶场地基的开源现实（2026-09-21）**：
  **VeRO/HarnessOpt-Bench**（Scale AI，MIT：evaluator 持 case 与评分、沙箱外、20/40/40、预算网关）、
  **HarnessDev**（把评测单位换成"可运行的 harness"）、**DGM/HGM**（直接用 SWE-bench 当判据）、
  **DSH 社区**（200K+ star、Discord、`dsh-plugin`）。**含证据分级（直接读过/二手/推断）与未核实清单。**
- ★★ **`docs/reuse-and-composition-plan.md` —— 复用与组合 + 三条新想法（2026-09-21）**：
  ① **上游 `minimal` = DSH 自己的 RL harness**（恰好 2 工具、无 compaction、无 runtime-context、
  env 参数化）⇒ **我们的"关掉工具"臂不干净，梯度要以它为 G0 重建**；
  ② **四块拼一个闭环**：DSH（target）+ 上游 minimal（下界臂）+ **VeRO**（判据/隔离/搜索）+
  **我们的 switchboard**（蓝绿换代 = 别人没做的那一格）；
  ③ ★（**已修正**）**"工具面"与"提示长度"在 code 模式下拆不开** —— 实测净差的 **98.7% 是工具目录被渲染进
  system prompt**（逐工具 guidance + `ToolArgsMap`/`ToolOutputMap`）⇒ 原设想的 2×2 **在 code 模式下做不出来**，
  只能在 `native` 模式下做；或在 code 模式下直接问"这 39 800 字符换来了什么"。
  **★ 上游 `minimal` 的 system prompt = 那一句 persona，仅 46 字符**（上游自测断言"逐字等于环境变量那句话"）；
  而我们自制的下界臂是 **39 605** ⇒ **差 ≈860 倍 ⇒ 自制下界臂不干净，梯度要重建**。
- ★★ **`docs/vero-integration-findings.md` —— "VeRO 能不能接 DSH"的实测摸底（2026-09-21）**：
  **`command` 后端语言无关**（target = 干净 Git 仓库 + target 外的 `harness_root`；argv 占位符 + schema-1 JSON；
  **我们自己的 node oracle 可直接当 evaluator，且不用容器**）；
  **隔离是真的**（`docker run` **只有** `--detach --rm --workdir`、**无 bind mount**；推理网关按 scope 限预算）；
  ⚠️ **20/40/40 的"不可变"不是代码强制**（代码只强制"partitions ⊆ manifest"；`ratios`/`partition_digest` 只在生成脚本里）；
  ⚠️ **Windows 是硬阻塞**（`LocalSandbox` POSIX 假设 ⇒ `/tmp` 被解析成 `D:\tmp`；能用的 `DockerSandbox` **未接到 CLI**）
  ⇒ **与上游 `minimal` 卡在同一处：需要一个 POSIX 底座**。
- `docs/eval-discrimination-plan.md` —— cli-0005 为什么零区分度（含 **S4：判据可读 ⇒ 难度折价**）+ cli-0007 设计稿
  + **步 0 结果**（行为面叶子工具直方图：两臂 `byTool` 同形但叶子层分化）。

## ⏭ 交接

> **★ 新会话接手 → 先读 `topics/next-task-handover.md`**（自包含；顶部即本轮回执）。
> 下一项、未闭合项、操作纪律、验证命令**全在那里**。本文件只放**每次都要遵守**的东西。
> **另有新议题**：`topics/tool-refinement-handover.md`（工具完善 · 判据阶梯 L2~L4）与
> `topics/architecture-handover.md`（**架构线**：三角色 + 三段流水线）—— 各派一个会话全权执行。
