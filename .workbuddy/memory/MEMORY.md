# dsh-brain — 长期项目笔记（**索引 + 每次都要遵守的东西**）

在 DeepSeek Harness (DSH) 底座上，把 agent-shell 工程思路解耦重做成 Cordis 插件：
三脑编排 / 上下文压缩 / 工具自进化 / 护栏 / LLM 路由。

> 本文件**只放每次都要遵守的**（环境约束 / 铁律 / 主题索引）—— 不复制细节、不复制进度。
> · **实证细节与"为什么定这条"** ⇒ `topics/lessons-learned.md`（**本节两节的全文存档**，要引用证据时读它）
> · **进度 / 未闭合 / 下一步 / 操作纪律** ⇒ `topics/next-task-handover.md`（顶部=回执）+ `topics/current-status.md`
> · 日更（append-only，尾部即最新）：`.workbuddy/memory/YYYY-MM-DD.md`
> ⚠️ 本文件曾被注入**截断**（>40KB）⇒ 2026-09-24 瘦身；**加新条目要同时压缩旧的**。

## 环境约束（本机工具层）

1. **Bash 工具 PATH 被破坏** ⇒ 调用开头先
   `export PATH="/c/Windows/System32:/c/Windows:/usr/bin:/bin:/c/Program Files/nodejs:/c/Program Files/Git/cmd"`。
2. **PowerShell 通道本机基本不可用**：stdout 被吞；从 node 里 `spawnSync('powershell')` 是 `ENOENT`，
   命令里出现 `WindowsPowerShell\v1.0` 还会被安全策略拦 ⇒ **自动化一律走纯文件通道**（脚本自己 `writeFileSync`）。
3. **不能在工具内起长期服务**（`schtasks`/`cmd start`/`detached+unref` 全被拦或回收；判据是"**谁拉起的**"）
   ⇒ switchboard 只能由**用户终端**拉起：`cd D:\project_develop\dsh-brain && node scripts\relaunch-switchboard.mjs`
   （日志 `out/switchboard-run.log`）。⚠️ 2026-09-24 实测：**用户重启电脑后不会自动拉起** ⇒ 派活前先探 `:3080`。
4. 排查会话内容**别**把 node stdout 重定向到文件（判为二进制）。
5. `grep -oE` / `find` / `timeout` 在这台 shell 不可靠（`timeout` 实为 `TIMEOUT.EXE`）
   ⇒ **提取/统计一律写 node 脚本**；要限时用 Bash 工具自带的 timeout 参数。
6. **★ clone/fetch 用系统 git**（`C:\Program Files\Git\cmd\git.exe`）：PortableGit 写嵌套 ref **静默失败**
   ⇒ 每次 clone/fetch 后**验 `git branch -r` 非空**。
7. **`git -C` 不认 MSYS 路径** ⇒ 一律 `D:/…`；该报错极易被误判成"目录不存在"。
8. **工作区约定**：`D:\project_develop` 是唯一开发根；`_` 前缀 = 非项目；**远端是唯一真相源**。
9. **Code Mode**：模型只能直接调 `run_code`，其余工具须写进 `run_code` 程序里 `tools.<name>(...)`
   ⇒ persona 用「否定+禁止」式硬规则。**通用教训：否定+禁止 ＞ 说明+让它判断。**
10. **★ 同一文件的两个 Edit 并行发 ⇒ 后者按旧快照覆盖前者，两边都报成功**（静默丢改动）
    ⇒ 同文件编辑必须**串行**，改完 grep 验证关键标记。
11. **`node -e` 带正则/反引号/花括号会被 bash 抢插值** ⇒ **写 `.mjs` 再跑**。
12. **`npm run <script>` 在 Agent shell 里被拦** ⇒ 直接 `node scripts/<x>.mjs`。
13. **构建**：`cd packages/switchboard && node scripts/build.mjs`（用仓库内 tsc）。
14. **★ 推送**走 `GIT_TERMINAL_PROMPT=0 git push origin master`；**判断推没推上去唯一可信的是
    `git ls-remote origin refs/heads/master`**（push 输出与本地 `origin/master` 都会骗人）。
15. **★ 命令可能被「执行两次」**（沙箱被拒→提权重跑）⇒ 凡"追加/写入"都要**按跑两次设计**，
    写完**立刻校验**（关键标记计数 / 查重复标题），别信脚本自己的输出。
16. **★ 多会话共用一个仓库 ⇒ 提交要有分寸**：**先 `git status`** 看清哪些改动不是自己的；
    `git add <自己的路径>` 为主 + **周期性查"有没有该提交却没跟踪的文件"**（`-A` 的兜底作用不能丢）。
17. **★ 命令里别混「中文 + Markdown 的 `**` + 重定向」**：曾因此造出 3 个乱名 0 字节文件并被提交。
    ⇒ 长文本一律写**消息文件**再 `-F`；`git add -A` 后**扫一眼到底加了哪些文件**；
    **提交后 `git status` 干净 ≠ 没提交垃圾**；删乱名文件要用 `readdir` 拿到的真名（含私有区字符 U+F02A）。
18. **★ 真日期看 `date`，不看注入的 `<current_time>`**（实测滞后一天以上）⇒ 写日更前先 `date`。
19. **★ dev 模式（沙箱放开）怎么开**：启动控制面时带 **`DSH_SWITCHBOARD_DEV=1`**
    （`relaunch-switchboard.mjs` 会透传 env）⇒ 它派生的**每一代**都是"沙箱全开 + 审批 never"。
    机制：控制面把 `DSH_PERMISSION_MODE=danger-full-access` 写进子代 env
    —— **那是上游 `dsh-base/cordis.patch.yml:175/191` 已预留的钩子**，我们只负责传。
    ★ 副作用：**全开**（能写 `~/.dsh`/别的臂）；"只禁互读互写"由 `packages/arm-isolation` 那一层担，
    **但它还没接线**，且它拦不住符号链接/间接访问/系统调用。
20. **★ 换代（蓝绿）怎么真触发**：**`?cmd=` 听在控制面 `:31800`**（**不是** `:3080` —— 后者只返回前端 HTML）。
    `GET :31800/?cmd=handover&profile=<profile>` 是**异步**的（立即返回 `stage:"started"`）
    ⇒ **必须轮询** `?cmd=status` 或读 `~/.dsh/switchboard/handover-status.jsonl`；
    成功判据 = `lease.json` 的 `activeGen`/`pid`/`generation` 都变 + 台账 `result:"success"`，
    再补一条**前门健康**（`session.list` 仍应答）。★ **`preset` ≠ `profile`**，换错名字会起个坏代（会被回滚）。
21. **★★ 门层的票怎么留（实操）**：**别自己拼 `record --paths` 去对指纹**（我连续两次指纹不匹配被拦）。
    可靠流程：**`git add` → 试提交（门拦住并自动开票）→ `approve <自动票> --by witness:agent-<谁>` → 再提交**。
    自批时要**在提交信息里逐字写明"批准者与作者是同一个 agent"**。

## 铁律（违反会立刻坏事）

1. **写 json/yaml/源码一律 `fs.writeFileSync(p,s,'utf8')`（无 BOM）** —— PS 5.1 加 BOM ⇒ DSH `JSON.parse` 崩
   ⇒ gen 起不来。**★ 唯一反向例外：`.ps1` 必须【带】BOM**。`scripts/check-bom.mjs --fix` 双向修。
2. **profile 的 `cordis.patch.yml` 不得写包内已 `insert` 的同一 id** ⇒ `duplicate loader entry id` ⇒ 整树装配失败。
3. **改完 profile 跑** `check:profile` + `check:bom`（基线 exit 0 / stderr 空 / 582 行 / pet 0 / dup 0）。
   ⚠️ 它**不校验插件 config** ⇒ 配置正确性另看 `check-config-tolerance.mjs` 或真启动。
4. **改完 `node_modules/@deepseek-ai/*` 立刻重建 patch**（`patch-package` 只能在 PowerShell 工具里跑）。
5. **外置化/缩减必须在「写入时」append-only**，事后 `replace` 必击穿 prompt 前缀。
6. **`disabled` ≠ 移除**：在 `bundles` 里仍会被 loader 装配；有 `dsh.client` 的包目录还在就可能被前端加载。
7. **判据与信号不可混**：裸满意度评分**丢弃**；采纳只认可执行 `acceptance` + 隐藏 holdout。
   **★ 未实施的判据级不得计作通过。** 假信号按"有没有坐标"排：
   **假绿/空过（最坏）> 无门（诚实的无知）> 假红（相对最好）**。
   **见假红 → 先证明判据错了再改判据；绝不为消红去改被检对象**（那等于把假红转成假绿）。
8. **压缩后端契约**：产出 summary 的路径必须携带 `measurement` + `start/end/shadowedSeqs/selectedNodes`
   → `scripts/check-compaction-fallback-shape.mjs`。
9. **插件 `Config`**：6 个 zod 包已套 `z.preprocess(v => v ?? {}, schema)` ⇒ 漏写 `config:` 不再崩；
   **别用 `.default({})`**（返回字面量、短路内层解析 = 静默坏，比崩更隐蔽）。
10. **★ 不追上游版本**（用户定）：上游是移动靶 ⇒ 只按需合并对我们有利的改动。
    **边界**：只管 `@dsh-brain/*` 与我们自己的 profile；`@deepseek-ai/*` 上游自身的问题暂不处理。
    版本漂移体检 `npm run check:upstream`（升之前先跑，有一红就别动手）+ `docs/upstream-drift-2026-09-20.md`；
    归属逐项清单 `docs/upstream-defects.md`。
11. **★ 判"某机制有没有在工作"，不许读注释、不许读代码意图 ⇒ 去历史记录里数「判据为真的次数」**。
    曾有 3 个"保险"**全都从未为真**。**一个从未为真的判据 = 假绿**，比"没有门"更糟。
    推论：写门时**同时报"判据为真的历史次数"，为 0 就报警**。
12. **★ "看不到" ≠ "没有"**：服务缺失 / 列表为空 / 读数拿不到，**一律不得**当正向判据
    （`drain` 的 `agentsObservable` 看不到 ⇒ `quiesced` 必须 false）。
13. **★ 否定命题必须带一个与自变量【正交】的阳性对照**：选对照先自问「我动自变量时它会不会跟着变？」；
    把正交性写成断言（对照在**任一臂**为 0 ⇒ 前面判语**全部作废**）；对照要可换（`--control`）；
    **否定读数至少两条正交通道 —— 矛盾时不许下结论，矛盾本身就是发现**。
14. **★ 通道"不可用" ≠ 读数"为 0"**：调不到就返回 `null`，**不许当 0 参与判定**。
    且 **append-only 日志（`boot.log`）必须只读末段**（分隔符 `===== BOOT … =====`）。
15. **★ "判据读不到差别" ≠ "没有差别"**：**先证明读数本身有效，再拿它下结论**。
    **一条读数长期"稳定不变"就是红线** ⇒ 先问"它到底有没有在量东西"。
16. **★ 判据 / 规格 / 答案清单【不能放在被测 agent 的读写范围内】**：实测三条 B 会话都读了 `check.mjs`
    ⇒ 陷阱被降级成"照抄规格" ⇒ 区分度归零。违反 `evals/README.md` **R1**；**配新题前必须先解这条**。
17. **★★ 做任何"功能组模块"之前先查三处，否则不许自造**：① **本地**（含 `_research/` 的完整 DSH 源码，
    **以及我们自己的 `docs/` 与 `scripts/`** —— 且要能回答"这是谁写的、什么状态"）；② GitHub；③ arXiv。
    判据是「**造格子还是造房子**」；红线：*同一件事，开源已有更好的版本而我还在自己写*。
    **证据必须分级**（直接读过/二手/推断），**二手不许当结论**。
    ★★ **先搞清"这东西是谁的"，再谈"谁错了"**：判定"是不是我们改坏的"之前先做**归属核验**
    —— ① `packages/` 里有没有这个实现？② 我们那份配置与上游 shipped 那份是否**逐字相同**？
    否则会把**上游的矛盾**写成**自己的罪状**（方向反了，代价是去改不该改的地方）。
18. **★ "回读成功" ≠ "生效的是你以为的那份"**：**配置发现是多根"先到先得" ⇒ 同名即遮蔽**
    （随附只读 preset 会静默压过你建的同名那份，HTTP 200 + 回读都显示你的名字）。
    ⇒ 判据要用**比名字更强的指纹**（工具集合 / `toolSetSize` / `systemChars` / 信任级别）。
    · **工具面 = `profile` 底板 + `preset` 增量** ⇒ **只换 preset 压不到 1–2 个工具；要压低必须换 profile**。
    · **"回读"本身也会跨代漂**（`session.list.agentPreset` 换代后漂回默认）⇒ 判据落在
      **持久事件（`agent-preset/selected`）+ 面指纹**上，而不是按名字回读。
19. **★ 长文档插入禁止用"标题行"当锚点**（已犯 6 次，两边都报成功但标题被吃掉）
    ⇒ 锚定标题**之后的正文**，或**把标题原样写进 new_string**；**改完立刻 `grep -n '^## \|^### '` 复核标题序列**。
20. **★ 数"份数/规模"必须说明口径**（条目数 / `.md` 数 / 章节数 分开说），否则以讹传讹。
21. **★ 判据要证明"修复真的在起作用" ⇒ 用【消融自证】：撤掉修复，判据必须变红**。
    光"测试通过"不够（可能是测试与被检对象一起错）。**不许为让测试变绿而改测试**；
    修 bug **必须先复现**（复现不出就只标注，别硬改）。
22. **★★ 改子代/新会话的"脸"，只有【追加】安全；覆盖与"插进列表中段"的代价是【全损】**：
    代价**不来自"多一个工具"，来自"与父代不同"**。⇒ 脸必须是父代脸的**逐字前缀扩展**
    （人格走尾部不走 order 0；新工具排到列表末尾）。仪器 `scripts/measure-delegation-reuse.mjs`。
    ⚠️ **agnes 不是严格 LCP** ⇒ 别把 deepseek 的结论直接套给 agnes。
23. **★★ 判断"某功能该由谁做"之前，先确认那个组件【有没有那个对象】**：先答"这个对象在谁的视野里"，
    再答"该扩哪个组件"（例：压缩器只见「会话事件」，`system` 是每步装配的派生物 ⇒ 改 prompt 的钩子只在装配层）。
    **用户的设计直觉可能是对的，但机制归属要重新找。**
24. **★★★ 别用"把自变量调到最小端"的样本去否定一个关于"大端"的命题 —— 那是【假否定】**。
    纪律：① 先问「**我的自变量取在哪一档？被检主张说的是哪一档？**」；② **凡"只有 X%"必须同时报
    【分母】与【自变量取值】**；③ 与铁律 13 同族反向（13 是"对照选错"，本条是"自变量取值选错"）。
    配套：**"脸"（`system`+`tools`）是每次请求重发的说明书** ⇒ 谈"省 token"必须先说清**省的是脸还是历史**。
25. **★★★ 做完一件实质东西【必须当场登记】进本文件索引**（写明**在哪 / 是什么 / 什么状态 / 与谁有关系**）。
    **索引里没有 = 不存在**；下次会话会把它当"陌生先例"甚至重新设计一遍。
26. **★★ 给 DSH 写新脚本前，先对照同族现成脚本抄协议形状**：
    `session.prompt` 的正确形状是 `{sessionId, mode:'steer'|'queue', content:[{type:'text',text}],
    clientTimeZone}` —— 传 `{sessionId, text}` 会 **HTTP 200 但什么都不做**；
    前门 RPC 一律 `POST /api/<method>` + `{type:'client-request', rpcId, method, payload}`，值在 `result.value`。
    **完成判据必须叠加 `asOfSeq 前进`**，不能只看 `running===false`（否则"还没起跑"就判 settled）。
    ⇒ **派活后必须核验"真的发了指令"**（`accepted===true` + 事件数增长 + toolCalls>0），**别只看退出码**。

## 主题索引（**按需读**）

★★ **子 Agent / 分身机制：施工一律从 `docs/skill-as-agent-spec.md` 开始**（**自足施工规格**：
不变量 I1–I4 / 裁决 D1–D10 / 计划 S0–S7 与验收门 / 未闭合 O1–O31 / 反模式清单）。
它是**结论固化**；`docs/skill-as-agent-feasibility.md` 是讨论过程（只在追溯"为什么这么定"时读）。

★★ **训练场 + Agent 工厂（2026-09-25 用户裁决）：`docs/training-ground-and-skill-sieve-2026-09-25.md`**
- ★ **「臂」的语义改为「训练场」** = ① 隔离的数据（`DSH_HOME`）② **记录整条流程的消耗+结果** ③ **锚定参与者是谁**。
  ⇒ **取消了"臂=自变量容器 ⇒ 每臂要有不同 profile"的假设** ⇒ **没有"profile 上要变什么"这回事**。
  ⇒ 由此 `arm-isolation` 的 `self` = **训练场身份**（`--arm`/台账注入），**不需要 profile 差异，现在可做**。
- ★ **`node_modules` 共享不是隔离问题**（实测：那层是指向仓库 `packages/*` 的符号链接 ⇒ 共享的是**同一份代码**；
  要隔离的**状态**在 `DSH_HOME`，那层是独立的）⇒ **"不是完全隔离"那条已撤销**。
- ★★ **O30 裁决**：`skill` = **配方/工艺清单**（`skill-tree` 数据层：类型+生命周期+Absorb 账本，**不含执行器**）；
  **它是【筛网】** ⇒ 链路 = **外部/自生长 skill → 筛 → Agent 工厂（按配置实例化）→ 新子 agent → skill 退役**。
  **不是二选一，是两段**。待定义的是**接缝**（谁读字段/谁判"好"/谁实例化/退役怎么记）。
- ★★ **筛的口径（§7，用户口述逐字固化）**：**三级公民** ——
  **一等**（所有字段齐全／或「有工具+有指引」）⇒ **构建子 agent**；
  **二等**（内置代码片段+描述，无 `Tools`）⇒ **也能建 agent**（★"代码片段**我们也可以自己手动将其做成工具**" ⇒ 升格 = 人工包成 `ToolDef`）；
  **三等**（只有指导）⇒ **不建 agent**，用来**优化同类型【已有】agent 的提示词**。
  · ★ 判据框架（用户原话）= **"skill 与 agent 一一对应，缺多少"**：
    **一等 = 三样内容齐（`Principle`指导 ∧ `Script`脚本 ∧ `Tools[]`内嵌片段）**；
    **二等 = 少一项或需我们自己补**（常见：有脚本但 `Tools` 空 ⇒ **人工**把脚本包成 `ToolDef`）；
    **三等 = 只有一段提示词**（只有 `Principle`）⇒ 用来优化**同方向已有 agent** 的提示词。
    ★ 谱系/来源类字段（`MergedFrom`/`AbsorbedBy`/`Source*` 等）**不参与**（作者裁定）；
    ★ **"内嵌片段"在 schema 里没有严格字段**（TS/Go 两侧 33 字段逐字一致）⇒ 暂用 `Tools[]` 承载，补字段是**待办**。
  · 纪律① **"有副作用就不优化"** ⇒ 复用 `SuccessRate` + **`skill-tree.ts:623` 的 `Demoted` 规则**；
    纪律② **"用过的打标记、后续不再碰"** ⇒ 复用现成 **`UseCount`/`LastUsedAt`**（不新增字段）。
- ★★★ **自进化的定义（用户原话，全局性）**：**进化是在【子 agent】上进化**；
  **一个方向的子 agent = 多个同方向的 skill 投料 + 迭代优化的结果** ⇒ 三等的优化改的是 **agent 侧 `persona`**。
- ★★★ **完整流程（用户原话）**：**取到 skill → ①【安全审批】是否安全 → ②做成子 agent →
  ③若该方向已有 agent ⇒ 与它【对比：哪个工具更好更实用】⇒ 择优/迭代**。★ **来源驱动，不是定期全量**。
- ★★ **接线现状**：(a1) `gen-assembly.ts` 按 **`DSH_ARM_SELF`+`DSH_ARM_DENY`** 插 `arm-isolation` overlay（R0 已进主仓）；
  (a2) `isolated-instance.mjs` 给身份 + **自己的 `node_modules`（真目录+逐项符号链接）**让插件能解析（已进主仓）。
  ⇒ **接线层闭环；端到端（真起一代看 guard 拦跨训练场）未做** —— 起服务**只能用户终端**。
- ★★ **筛已落成代码**：`scripts/skill-sieve.mjs` —— 纯函数 `classifySkill(node) ⇒ 一等/二等/三等/跳过`
  （跳过含 `used`/`retired`/`duplicate`防重回/`no-guidance`；★ **判定顺序=纪律优先**）；
  自测 **10/10** + **消融自证通过**。★ **它只判定 + 记账，绝不删任何东西**。
- ★★ **退役留存规则（§8）**：退役/吸收后**本地只留** ① **来源定位（`SourceFile` = GitHub 链接）**
  ② **去重哈希（`SourceHash`）**；**本体不留**；吸收后**不再重新使用**；哈希用于**去重防重回**。全部现成字段。
- ★ **实测待办**：本机**没有任何 `*skill*` 文件** ⇒ **真实 skill 数据取不到**（Go 侧 `dataDir/skill_tree.json` 无实体）
  ⇒ 筛**只能跑自测**；**要让这条链跑起来得先确认 skill store 的真实落点**。
- ★★★ **能力源不限于 skill（§9）**：**外置 MCP 走同一条流水线**（`源 → ToolDef → 绑进 skill → 升格成 agent`）；
  MCP 天然自带 `Description`+`Schema` ⇒ **几乎逐字段对上 `ToolDef`**；★ 但纯 MCP 来源**缺"指导"** ⇒ 按 §7 判据**是二等**。
- ★★★ **元工具 vs 链路工具（用户点出的原则，实测对上）**：
  **元工具** = `design-canvas-bridge` 的 55 个 `mcp__design-canvas__*`（**零件**，让 agent 自己组织 = 把编排负担丢给模型）；
  **链路工具** = 同文件自写的 **`safe_rename`**（`:558-671`）+ `move_symbol`（`:673`）⇒ **一个工具 = 一整条链路**。
  ⇒ **能力的粒度是【链路工具】不是【元工具】**；绑 agent 的粒度应是链路工具。
  ⇒ **目标形态（原话）**：像 SAFE RENAME 那样的、一个工具包含整个链路、不需要 agent 自己组织。
  ★ 判据缺口：§7 只数"有没有工具"、**数不出元/链路** ⇒ "55 元工具+指导+脚本"会被判一等（**恰是不要的形态**）；
    口径（怎么判"是不是链路工具"）**等用户给**，我不自己发明。
- ★★★ **脚本本身可改、可融合（§10）**：`Script` 不只能包成工具，**本身可替换/可融合**（两层：脚本融合 / 设计融合）；
  择优形容词 = 更合理/更科学/更兼容 ⇒ ★ **我提议的可测代理**（文档标明"我提的"）：更兼容=同输入同输出 /
  更合理=同功能用例通过更多；★★ **融合验收 = 必须通过【原先两者】的全部用例**（否则是退步）。
  落到现成字段：**`MergedFrom[]` + `AbsorbedBy` + `SuccessRate`/`Score`/`UseCount`**（不新增）。
- ★★ **`scripts/skill-sieve.mjs` 现状**（**已可跑，判据含消融**）：
  `classifySkill`（分级 10/10）+ `suggestMerges`（融合候选 6/6）+ **两个消融都通过**；
  CLI：`--in` / `--json` / `--emit-seen` / `--suggest-merge [--min-trigger-overlap N]` / `--selftest`。
  ★★★ **只判定 + 记账，绝不自动融合/删除**。
- ★★★ **三脑流水线 + 工具商城（§11）—— 用户问"有没有做"，实测答复：**
  · **设计早就在**：`docs/revised-architecture-2026-09-20.md` §7 = **进化脑发现 → 评审团把关 →
    开发脑动手（含融合与测试）→ 回传 → 按数据再迭代**；别名 **"开发脑"="生产脑"**、**"评审团"="专家团"**；
    ★ §7.0 已订正：**"融合"是开发脑的活**（⇒ 与 §10 对齐：筛只出候选，融合的执行者是开发脑）；
    ★ §218 防串供：**产变更方不能与审批方同源**（这是两脑必须分开的理由）。
  · ★★ **实现几乎为零**：council 席位表只有 `{architect:'council-architect'}`（自述"首期只有架构师一席"）；
    `评审团/专家团/生产脑` 在 packages+scripts+evals **零命中**；`进化脑` **只在 switchboard 的
    `deploy.ts`/`coordinator.js` 注释里**（= 控制面 `tool_apply` 验证闸**代行**它，不是独立子 agent）；
    能力库 active 仅 4 个（spawn/fork/council-architect/design-canvas）。
  · ★★ **工具商城 = 三处零命中（连文档都没有）** ⇒ §11.3 是它的**第一份落档**；闭环 =
    **开发脑编排(原工具+目标任务)→产出回值→写回商城→两脑按回值迭代工具链**。
    ★ **链路工具就是这两个脑【编排】出来的产物**（不是人手写）。
  · 三条待定（我不自己发明）：商城存储形状 / 回值字段 / 迭代触发。
- ★★★ **自进化的两个固定子 agent 已落地（commit `5bf3a16`）**：`packages/subagent-council` 新增两席 ——
  **开发脑 `dev` / provider `evo-dev`**（= 文档"生产脑"）与 **审批脑 `review` / provider `evo-review`**（= 文档"评审团/专家团"）。
  · dev：只施工；把【原工具+目标任务】**编排成一个工具**（★不是列一堆元工具）；**融合也是它的活**；
    六段产出（链路图/编排产物/融合说明/**自证**/回值/我可能错在哪）。
  · review：只裁"值不值得"；五段产出（被审对象/**独立复算**/裁决/下一步/我可能错在哪）；
    ★★ **防串供写进人格**（"产变更方不能与审批方同源"）。
  · 机制：`Config.seats[]` 一次挂多席；**留空 ⇒ 只挂 `seat`（向后兼容）**；未知席位**跳过**（不降级成 architect）。
  · ★★ **仍未接线**：两席**没被挂上**（profile 未设 `seats`）⇒ **代码在、没上线**；且防串供实质要求
    两席**各自不同**的 provider/model ⇒ 要**两次挂载、各给路由**。
  · 判据 `packages/subagent-council/test/seats-check.mjs`：**7/7 + 消融通过**。
- ★★★ **Agent 工厂第一段已落地（`scripts/skill-factory.mjs`，commit `3c9cecd`）**：
  `skillToAgentSpec(skill) ⇒ agent 规格`（**纯函数**）：`Principle`+`Fix`→**persona** / `Tools[].Name`→**toolFilter**（窄脸）/
  **`provider:'spawn'`（★不是 fork，D10）** / `outputSchema` 默认不给 / `depthLimit` 默认不收窄 / `source` 留痕；
  ★ **只有一等才建**（判据**复用 `skill-sieve.classifySkill`，不重写**）；**只出规格，不注册不启动**。
  判据 **13/13 + 单因子消融**。
- ★★ **`scripts/` 下的脚本必须 import-safe**：`skill-sieve.mjs` 曾在**模块顶层派发 CLI**
  ⇒ 被 import 时**拿 import 方的 argv 跑自己的 CLI + `process.exit`** ⇒ 把工厂的判据**截断**（**假绿**）。
  ⇒ 一律 `const isMain = …; if (isMain) { …CLI… }`。
- ★★ **消融必须【单因子】**：要挑"**只有被撤那条守卫适用**"的样本 ——
  "二等（缺 Tools）"被两道守卫同时满足 ⇒ 撤一道不翻（多因子）；"二等（缺 Script）"才翻得动。
- ★★ **ai-base 里"工具商城"的现状（用户说那边有实现）**：`工具商城`/`toolMall`/`回值` 等词**全零命中**；
  ★ 最接近的是 **`internal/hub/v2/friends/`**（**friend registration + remote Brain transports**：
  `FriendConfig` 持久化在 `.agent/friends/{id}/`、`FriendRegistry` CRUD+落盘、`FriendService` REST `/api/v1/friends/*`、
  **C 方案 Remote Brain 通过 `POST /api/v1/friends` 动态加入**，transport = ws/a2a/mcp）
  ⇒ **这就是"上架/货架"**；**但只有骨架**：`FriendConfig` **无任何"回值/评分"字段**，且 **`.agent/friends/` 是空的**。
- ★★★ **更正（§11.8，**取代**上面那条的方向）**：**DSH 侧不做商城、不做检索** ——
  ai-base 的 `hub/v2/friends/` 是**旧 AI Base 方向的产物，不移植**。
  ★★ **只做两件**：一个**工具池** + 对池里的工具做**回值（= 评分 + 反馈）**；
  **回值作者 = 用它的那个子 agent 自己**（自评；工具面本就是它自己的 `toolFilter` 那层，**无需检索**）；
  **读者 = 开发脑 + 进化脑**。
  ★ 已落地 `scripts/tool-pool.mjs`（append-only JSONL + **幂等** + **fail-closed 校验** + **读不写盘**；
  `aggregate` **均分低的排前面**；默认 `~/.dsh/tool-pool/pool.jsonl`，`--file` 可覆盖）——判据 **8/8 + 消融**。
  ★ **整条链现在纸面齐了**：筛 ✅ → 工厂 ✅ → 两脑 ✅（隔离实例已挂）→ 工具池/回值 ✅；
  缺的只有**真跑一次**（起隔离实例**只能用户终端**）。
  · ★★ **已挂进隔离实例**（commit `401108f`）：`isolated-instance` 给隔离 profile 追加**两条 insert**
    （`evo-dev`/`evo-review`，id 互异、可各给路由）；`--no-evo-seats` 可关；幂等。
    判据 `scripts/delegation/test-evo-seats-mount.mjs`：**9/9 + 消融**（含"现役 sha+mtime 一字未动"）。
    ★★ 但**只有一个 provider/model** ⇒ 独立性**只到【跨会话】档、未到【跨模型】档**；且**还没真跑过**（起服务只能用户终端）。
- ★★★ **"串供/同源"的真实含义 = 【不能自批】（**不是**"私下通气"）**（用户 2026-09-25 追问，我读了文档才说准）：
  `revised-architecture-2026-09-20.md:227-231` —— 「串供」是口语版，对齐
  `self-evolution-design.md` **§0.5 无环原则**（被改的审批层不能自动批准自己的部署）与
  **§6「封驳权 = 独立否决权，且与中书省【不同机构】」**（"不同机构"落成"不同 agent"）。
  ★★ 且 **§6 逐字：评分者独立性 = 跨模型 > 跨会话 > 同会话换 prompt** ⇒ **三级阶梯、不是二值开关**；
  两个独立 provider（各自 session）= **跨会话档 = 已算独立**，只是弱于跨模型。
  ★★ **能强制独立性的地方是【编排层】**（谁派活/派给谁/路由是否跨模型），**人格层自证不了** ——
  我曾把"审者若在审自己的产出就拒绝"写进人格，那是**装饰**，已改成"没给作者信息就必须写【独立性无法核对】"。
- ★★ **persona 是模板字符串 ⇒ 里面【不能用反引号】**（会提前结束模板 ⇒ TS1005，实测踩过）。
- ★★★ **`- id: <同名>` 覆盖块里的 `config:` 是【整体替换】，【不是深合并】**（2026-09-25 实测，我栽了）：
  只给一个键 ⇒ **该条目原有 config 全被冲掉** ⇒ 插件拿到**默认值**（实测：`key-pool-proxy` 只给 `port`
  ⇒ 丢了 `poolEnv/fallbackEnvs/upstreamBase` ⇒ `empty key pool: poolEnv=AGNES_KEY_POOL` ⇒ **整树装配失败**、前门 502）。
  ⇒ **要覆盖 config 必须【重述完整配置】**（照包内 `cordis.patch.yml` 逐字抄，只改要改的那一项）；
  ⇒ 若只想改**一个值**且对象是**我们自己拷贝的文件** ⇒ **就地替换那行**，别用覆盖块（无替换语义风险）。
- ★★★ **装了 ≠ 在工作（2026-09-25 实测）**：护栏 boot 里打了「apply running; denyRoots=2 条」、**看着完全正常**，
  而它**放行**了跨臂读取（臂 A 的 agent 读到了臂 B 的 store）⇒ 根因是**路径识别被引号绕过**：
  正则不排除引号 ⇒ 提取出的路径带结尾单引号 ⇒ 全等/前缀两种比较都不匹配 ⇒ 放行（已修 + 判据 10/10）。
  ⇒ **判某机制有没有在工作，别读它的日志，要真去碰那条路 / 数「判据为真」的次数**（与铁律 11 同族）。
- ★★ **隔离层的威胁模型必须含 shell**：护栏走的是 tool.guard（对全部工具）+ 从 command 字段提取路径；
  ⇒ **任何新工具/新字段若把路径藏在别处，都可能再绕** ⇒「通道要逐条验」是常驻待办。
- ★★★ **训练场唯一入口 = `node scripts/arm-up.mjs <臂名>`**（commit `8f832c7`）：
  **只吃一个自变量（臂名）**，端口段由**臂序号**派生（`33080 + idx*40`；池端口 `= base+21` **必须在段内**）
  ⇒ 外部**不再给任何端口变量**。流程＝准备 → 起（派生 env，不经人手）→ 等前门 → **自检**。
  ★★ **"起来了"的定义 = 自检全过**：① 端口段不撞现役 ② 前门 200 ③ 控制面 200
  **④ 隔离层 apply 且 deny ≥ 1（deny=0 = 不拦）** ⑤ 两席注册 ⑥ 池端口在本段内 ⑦ **现役仍健康**。
  ★ 起之前先探前门：**已在跑就跳过启动**（否则 EADDRINUSE + 自检读旧代日志 ⇒ **假绿**）。
- ★★★ **"启动"曾被拆到 6 处（用户 2026-09-25 质疑的根因）**：手抄 env ／ profile 的 `bundles` ／
  patch 的覆盖块 ／ `settings.yaml` default ／ `.agent-presets/` ／ switchboard 自己的 lib
  ⇒ **没有任何一处对"整体能不能起来"负责** ⇒ 每次踩到不同的那一处。
  ★★ 而**派生机制本来就在 Switchboard 内部**（`gen-assembly.poolPortOf()`）——**是"裸 env + 无清单"绕过了它**
  ⇒ 结论：**不是缺机制，是绕过机制**。
- ★★ **日志必须按 `DSH_HOME` 分家**（原来硬编码仓库 `out/switchboard-run.log` ⇒ 现役与隔离实例
  **共用一份日志**，两套 banner 挤在一起 ⇒ 我据此**误判过两次**）。
- ★★ **"最新一代"不许靠猜 mtime**：按**目录** mtime 会选中旧代（追加写不改目录 mtime）⇒ 报**假红**。
  ⇒ 正解 **问控制面要 `activeGen`**（唯一权威），退化才按 `boot.log` **文件** mtime。
- ★★ **实例的端口段必须把【池端口】算进去**：`key-pool-proxy` 包内 patch **硬编码 `port: 3101`**，
  而池端口**只在「装配清单声明了 pool」时**才由 gen 端口派生 ⇒ **无清单的实例会用 3101 = 现役的池端口**
  ⇒ 实测**抢掉现役的池端口、现役前门整个掉**。⇒ `LIVE_PORTS` 必须含 `3101`；隔离实例用 `33101`。
- ★★ **探 DSH 前门一律 `POST /api/<method>`**（`{type:'client-request',rpcId,method,payload}`）：
  **GET 会返回 404**（不是"服务坏了"）—— 我因此误判过一次。
- ★★★ **独立性口径（用户 2026-09-25 裁决，覆盖"要不要跨模型"）：开发期一律 AGNES；**
  **独立性的主要来源 = 【出发点不同】（输入不同 ⇒ 采样分叉），不是模型不同**；跨模型只是**可选加强**。
  ★ 可执行落地 = **让两席输入不同**：**审者不给生产者的推理过程**（只给 目标+产物+判据）。
  ★ 边界：若两席拿到**同一份输入**，"投骰子"差异**接近零** ⇒ 弱的是【**出发点相同**】不是【模型相同】
  ⇒ **该核的是"两席输入是否真的不同"**。★ 实测支撑：这一周**同模型**的主/子代理**互相**发现了大量缺陷。
- ★★ **`git commit` 别用 `-m` 带反引号**：`-m "…\`--flag\`…"` 会被 shell 当**命令替换**执行，
  内容**静默消失**而提交照样成功 ⇒ **一律写消息文件 + `-F`**（本项目铁律已收录同类）。

★★ **能力库线（我们自己写的，2026-09-22 补登）**：
- `docs/capability-registry-evolution.md`（设计文档 62KB）+ `scripts/capability-{registry,gate,sources,store,snapshot}.mjs`
  = 能力库 **P2 数据层 + P3 注册门**。核心论断（`:7` 逐字）：**「sub agent 就是它的能力；这比自己给自己改好得多。」**
- `:30` 判定：**`ctx.subagents` 已是「能力库」**（进程单例、注册名全局唯一、自带 `listChildren`/`followup`）
  ⇒ **不需要新建存储**。旁挂账本 `~/.dsh/capabilities/registry.json`；
  lineage `{id,version,source,acceptance,holdoutHash,registeredAt,supersededBy}`；四动作 注册/升级/合并/淘汰。
  ★ **注册 ≠ 采纳**（`register` 只建 `pending`，过门写回 `acceptance` 才算）。
- ★ 它与 `packages/skill-tree`（**孤儿包**，未挂载）**双向零引用、关系未裁决 ⇒ O30**。
- ★ **★ 判据阶梯 L0–L4 现状：门只跑到 L1**（`scripts/capability-gate.mjs:21` 逐字
  "回执写 `proofLevel:'L1'` 且 `unenforced:['L2','L3','L4']`"；`:22` "把 L2~L4 标成'通过'就是假绿"）。
  **G1（补 L2/L3/L4）是 P0**，见 `docs/self-evolution-gap-analysis.md`（缺口 G1–G8）+ 2026-09-24 施工进度。

★★ **记忆宿主的形态【已定，别再当未决问题重开】**：`docs/memory-asset-triage.md:388-392` 逐字定过——
**存储/图/检索/睡眠/论文/技能树（`sqlite_store`·`graph_*`·`retrieval*`·`rrf`·`gravity_field`·`sleep_*`·
`knowledge`·`skill_tree`·`tool_feedback`）= 【Go 保留】**；**provider 注册 / 工具声明 / 委派 / 注入 / 决策层接入 = 必须 TS**；
**两者之间 = 【MCP 首选】或 loopback JSON-RPC**。
⇒ **"记忆宿主" = 独立 Go 进程 + MCP 面，由现成 `mcp-client` 在 DSH 启动时拉起**；
**P1 落点 = 给上游 Go 加一个 MCP 面**。⚠️ 别把"DSH 插件内重写"或"TS 文件式"当候选 —— 会砍坏论文系统。

★★ **`ai-base` 仓规（跨仓，动它之前必读）**：`D:\project_develop\ai-base\AGENTS.md`「禁止行为」7 条
（`:196-204`）与我们相关的三条：① 不直接读写 `graph.json`（走 `GraphWriter` channel）；
② ★★ **不硬编码策略**（压缩/融合/**评分维度**必须走接口）⇒ **"门/判据"属于策略 ⇒ 必须走接口 + 集中词汇表**；
③ **不跨层调用** ⇒ 从 DSH 侧够过去**只能走"面"（MCP）**。
★ **`internal/memory/` 允许改**（"只读不改"是移植期纪律，使命已完成），但只做**最小的状态/筛选改动**，
门与面优先放 `internal/external/` 新增文件。

| 主题 | 文件 | 什么时候读 |
|---|---|---|
| **接手指南（下一项）** | `topics/next-task-handover.md` | **新会话接手先读这个**（顶部=回执结构） |
| 本次教训全文（环境约束+铁律的证据） | `topics/lessons-learned.md` | 要引用实证细节 / 追"为什么定这条" |
| 当前状态 / 下一步 | `topics/current-status.md` | 接手前看进度：到哪了、未闭合项 |
| 运行时与启动 | `topics/runtime-and-launch.md` | 端口/启动器/凭据/会话存储格式 |
| profile 与 gen 一致性 | `topics/profile-and-gen-integrity.md` | 改配置/加插件/换代后能力变了 |
| prompt 缓存 | `topics/prompt-cache.md` | 命中率、四类前缀改写源、指标口径 |
| 压缩引擎 | `topics/compaction-engine.md` | 压缩补丁、兜底契约、诊断埋点 |
| 换代 vs 重启 | `topics/generation-swap.md` | 要替换代码时、三级策略、写入竞态 |
| 自进化设计 | `topics/self-evolution-design.md` | 判据阶梯、能力库、委派、多模型会议室 |
| 项目治理 | `topics/project-governance.md` | 资产边界（**别重造**）、文档可信度 |
| 资产拓扑 | `topics/asset-topology.md` | 分不清资产/副本、design-canvas 真身与副本 |
| 工具完善（新议题） | `topics/tool-refinement-handover.md` | 派给另一会话全权执行（L2~L4） |
| 架构线（新议题） | `topics/architecture-handover.md` | 第三条线（三角色 + 三段流水线） |

## ★ 归属与前史：`ai-base` 是**用户的前一个项目**，也是多条设计的先例来源

- `D:\project_develop\ai-base`（Go，537 提交，最后 2026-08-26）里有 **`agent-shell`** —— 就是我们说的那个。
- ★ **fork 与前缀缓存：设计更早是用户的，实现是上游的**（`docs/fork-provenance-ai-base-vs-dsh.md`）：
  实现属上游 `@deepseek-ai/dsh-subagent-fork-in-process`；设计更早在 ai-base `193eb26a`（2026-07-14）；
  DSH 公开发布 = 2026-08-13 ⇒ **收敛，不是谁抄谁**。
- ★★ **从 ai-base 拿来、上游没有的两条**：① **"前缀缓存敏感的凭据轮换"** ⇒
  **实验硬纪律：臂间与轮内都不许轮换凭据/池**（否则前缀缓存被清 ⇒ 成本面读数漂），
  并把**轮换次数**记进成本面元数据；② `stripTrailingUnpairedToolCalls` 的"尾部多条""不污染源"两个用例。

## ★ 子 Agent = 我们的进化载体（DSH 已有一等地基，2026-09-21 通读上游源码确认）

- **嵌套与预算为真**：`delegationDepth` 0/1/2/3 四级可查（字段在**会话头记录的顶层**，不在 `data` 里）；
  第 4 层被运行时拒（`Error: subagent depth 4 exceeds maxDepth 3`；`maxDepth` 默认 3）。
- **★ `toolFilter` 真能裁，且只裁子代**（103 → 3 / 98 / 1）；**`allow:[]` 只剩 `["report"]`**（own-scope 工具不受约束）。
- ★ **三层工具面模型**：`profile` 定底板 → `preset` 定该 agent 增量 → `toolFilter` 定**这次委派**的裁剪。
  ★★ **两个动作各治一种病**：**专项化（分工）= 裁**（`toolFilter`，每任务都做、廉价、无需过门）；
  **能力增长（进化）= 加**（新工具→插件→profile/preset，低频，**必须过 L0–L4**）。
  ⚠️ **委派不减小父代自己的面** ⇒ 要治编排层负荷只能改 profile/preset。合理默认：**上层宽、执行层窄**；
  **"父代自己动手"最该避免**。★ **"专项"必须成对报**：① 面够小（`measure-arm-face.mjs`）+ ② 面够用（该专项的 oracle）
  —— 只报"面小了"是假绿。
- ★ **"工具过多 ⇒ 心智收益低"有机制**：code/PTC 模式下**工具目录被渲染进 system**，
  两臂净差 **98.7% 全是工具目录** ⇒ **多 72 个工具 ≈ 每次请求多约 13k token**。
- **能力因 provider 而异**：`fork-in-process` 支持 persona+toolFilter；`acp`/`dsh-sdk` **全不支持**（会静默退化）。
- **两种上下文别混**：`continuable`（durable、可冷启、session-backed）vs `fork`（只播种**已完成回合的前缀**，
  **唯一收益是 provider 侧前缀复用**）。★ 对判据的毒性：带上下文的两次跑**不是同一输入分布**
  ⇒ **评测必须 `backgroundMode: one-shot`**；进化用 `continuable` 并按 lineage 统计。
- ⚠️ **上游自己两层互相矛盾**（**不是**我方偏离）：同一 loader id `tool-subagent-fork`
  host 层（base bundle）= `one-shot`、agent 层（shipped presets）= `continuable` ⇒ **待验证谁生效**；
  判据 = 看 fork 子代请求头里有无 `report` 工具 / `tool:report` 段。

**入口级 / 关键文档**：
- ★ `docs/revised-architecture-2026-09-20.md` —— **当前架构权威记录**（两层：顶层=专家评审团 / 下层=子 agent 层，
  进化在下层发生，来源=skill）。**取代**三脑作为顶层的旧表述。
- `docs/ideas-spec.md`（改架构前先读）/ `docs/handover-vs-restart.md`（§8 写入竞态）/
  `docs/oss-prior-art-and-next-steps.md`（M0–M3）。
- `docs/agent-eval-arenas.md` + `evals/` —— 评测靶场；`npm run eval:validate` 证"打 seed 后 oracle 必须变红"。
- ★★ `docs/oss-arena-landscape-2026-09.md`（VeRO / HarnessDev / DGM / DSH 社区，含证据分级与未核实清单）/
  `docs/reuse-and-composition-plan.md`（上游 `minimal` = DSH 自己的 RL harness；四块拼一个闭环）/
  `docs/vero-integration-findings.md`（**Windows 是硬阻塞**；`command` 后端语言无关）。
- `docs/eval-discrimination-plan.md`（cli-0005 为何零区分度，含**判据可读 ⇒ 难度折价**）/
  `docs/eval-challenger-arm.md`（**成对实验**：RPC 形状 + 回读才算数 + 实验卫生）/
  `docs/eval-metrics.md`（三处"会骗人"的地方）。
- `docs/main-chain-ledger.md`（主线账本）/ `docs/where-we-are.md`（给用户看的一页）/
  `docs/self-evolution-gap-analysis.md`（缺口 G1–G8）/ `docs/prior-art-council.md`（议事厅先例）。

## ⏭ 交接

> **★ 新会话接手 → 先读 `topics/next-task-handover.md`**（自包含；顶部即本轮回执）。
> 下一项、未闭合项、操作纪律、验证命令**全在那里**；本文件只放**每次都要遵守**的东西。
- ★★★ **"跑过了"必须问"跑的是哪条支路"**（2026-09-25 实测）：用户跑 `arm-up A` 全绿，但那次走的是
  **"已在跑 ⇒ 跳过启动"的短路支**；**"从零起"的长路支从没跑过** ⇒ 补跑（`arm-up B`）立刻抓出 3 个真 bug：
  ① **臂序号静默退化**（`indexOf` 恒 0 ⇒ base 永远 33080 ⇒ **撞别的臂的端口段**）⇒ 修成"**读不到注册表就拒跑**"；
  ② **只传 `DSH_ARM_SELF` 没传 `DSH_ARM_DENY`** ⇒ 护栏走"显式 no-op ⇒ **什么都不拦**"（★ **被自检 ④ 抓到**）；
  ③ **lease 路径找错**（在 `switchboard/lease.json`，不在 `<gen>/lease.json`）⇒ **误拒自己**。
  ★ 教训：身份/端口/deny **只能有一处算法** —— `isolated-instance` 吐 `[arm-env] {json}`，启动器**消费**它。
- ★★★ **一键启动（`scripts/dsh-up.cmd`，commit `7d77cb5`）**：**双击** = 起现役 + 自检 + **自动开界面**，**零参数**。
  ★ 前提纠正：**Electron 的"启动体验"不是 Electron 给的** —— 它给的是
  ① 一个**固定入口** ② 入口**自己备好环境** ③ 起完**直接开界面**；**三样都跟 Electron 无关**，`.cmd` 就够。
  ⇒ 所以**不打包 Electron、也不新增第二个启动器**（新增才是"每回不一致"的来源）。
  · `arm-up.mjs` = **唯一入口**，两个模式：`--live`（现役，零参）／`<臂名>`（训练场）；`--open` 起完开界面。
    ★ **模式感知自检**：现役模式只判"服务可用"（前门/控制面/池 3101 在听/前端可取）——
    **不硬套臂专属那几条**（隔离层/两席/池在本段内对现役不适用 ⇒ 硬套会**造假红**）。
  · **桌面图标**：`scripts/install-desktop-icon.mjs`（默认 dry-run，`--yes` 才写）。
    ★ **不生成 `.lnk`**（要 COM，本机 PS/脚本宿主都不可靠）⇒ **把 `.cmd` 拷到桌面**（纯文件、可撤）。
  · `.cmd` 一律 **ASCII-only**（cmd/Task Scheduler 在非 ASCII 代码页会乱码）。
- ★★★ **`scripts/arm-ports.mjs` = 端口/根目录的【唯一定义】**（纯模块、**无副作用、可安全 import**）：
  谁要用"臂名 → front/DSH_HOME"就 import 它（`arm-up.mjs` 与 `dsh-delegate.mjs` 共用）。
  ★ 为什么单独一个文件：`arm-up.mjs` **有顶层主流程** ⇒ **一 import 就真去起服务**
  ⇒ 凡"要被多处共用的推导"都放纯模块里（**脚本必须 import-safe**）。
- ★★★ **派活给隔离实例必须用 `--for-arm <臂名>`**（它同时定 `front` 与 `DSH_HOME`）。
  ★ 起因：**我两次把成功的派活误判成"空跑"** —— 因为只传了 `--front` 没传 `--home` ⇒
  去**现役的库**找 sid ⇒ 找不到 ⇒ `toolCalls` 报 **0**。⇒ 已改 **fail-loud**（`missing:true` ⇒
  `toolCalls: null` + 提示；"疑似空跑"只在 `!missing` 时才允许触发）。**看不到 ≠ 没有**。
- ★★★★ **端到端演练第一棒跑通（commit `7463b85`）**：`skill→筛→工厂→派活→spawn子agent→干活→自评回值→池→聚合`
  七段**全有真读数**（筛=一等1；工厂出规格；派活 `toolCalls:24`；`subagent` 真被调用3次；子agent 返回 AAA/exit=0；
  `tool-pool` 真写出2条并聚合出 `0 shell工具 / 0.3 subagent`）。
  ★ 样本：`evals/fixtures/demo-skill/`（最小「一等」skill + 真能跑的 `first_line.sh`）。
  ★★ **三个真缺口**：① **规格↔可执行面缺一层桥**（规格用 `provider:spawn`+`persona`+`toolFilter`，
     而 worker 手上是 **`subagent` 工具**、吃 `{description,prompt,run_in_background}` ⇒ 起"带人格+窄工具面"的子 agent
     **不是一次工具调用能做的**，得落成 **preset/编排**）② **⭐ shell 脚本在 worker 里跑不了**
     （沙箱 `E_ACCESSDENIED` + 编码 ⇒ 子agent 只好"改用 Node.js 等价实现"）⇒ **"Script 是 shell"这条假设不成立**
     ③ **`toolFilter` 指向不存在的工具**（**没有任何东西把 `ToolDef` 注册进运行时**）。
  ★ 对比：同一条派活路径，改 `--for-arm A` 前是 `toolCalls: 0`（**假**），现在是 **24**（真）。
- ★★★★ **桥：`scripts/skill-to-preset.mjs`（规格 → preset）**（commit `49eab11`）：
  `preset.yml` 只是元数据，**人格与工具面都在 `agent.cordis.yml`**（loader 条目列表）。
  桥产出 `- id: persona`（**逐字**来自规格；照 `g0` 用 `complete:true`+`includeRuntimeContext:false`）
  + **平台 gate 的 shell 组**（★ `g0` 注释里的血泪教训：只写 `tool-bash` ⇒ win32 上"壳子名字对了但跑不动"）。
  ★ **诚实边界**：`ToolDef` 在运行时**不存在** ⇒ 对未注册工具**如实标注，不假装可用**。
  ★ 判据 6/6 + 消融；默认 dry-run，`--yes` 才写，`--dest` 可指定。
  ★★ **真跑验证**：落成到臂 A 的 `.agent-presets/` ⇒ **换代后 `agentPreset.list` 10→11**，出现 `skill-demo-first-line`
  ⇒ **运行时真认桥产出的 preset**。
- ★★★ **常驻守卫 `scripts/check-import-safe.mjs`**（同一族今天踩了**三次**：skill-sieve / arm-up / skill-factory）：
  判据 = **被 `scripts/` 内部 import 且顶层有 CLI 派发迹象 ⇒ 必须含 `isMain`**；并报**阳性计数**防判据空转。
  ★★ **首次运行就抓到 3 个既存违规**（不是我写的）：`eval-baseline-store.mjs`、`lib-tool-failure.mjs`、
  **`patch-anchors.mjs`（被 7 个脚本 import！）** ⇒ **任何 import 它们的脚本都可能正被静默截断**（只报告未改）。
- ★★ **写"消融"时，探针必须测【被撤掉的那段真正影响的东西】**：我曾测**无条件**算出的数组 ⇒ 撤了也"ok" = **假消融**；
  要测**产物内容**才翻得动。（判据写错缩进 ⇒ 假红，也要当同一类防。）
- ★★★★ **"判据要先自证有效，再拿它判人"（2026-09-25 三次同族，最重）**：
  ① "最新一代"按**目录 mtime** 选到旧代 ⇒ **假红**；② 消融探针测**无条件算出的数组** ⇒ **假消融**；
  ③ `check-import-safe` 两处**假阳性**（全文正则 / 只查字符串 `isMain`）+ **假消融**（断言字符串写错）
     ⇒ ★ **我据此向用户报错了"3 个既存违规"，还据此派错了一个任务**。
  ⇒ **拿一把尺子去判别人的活之前，先跑尺子自己的 `--selftest`（含消融）**。本轮它真的挡下了事故。
- ★★ **派活给 DSH 的标准参数**：`dsh-delegate --for-arm A --cwd D:/project_develop/dsh-brain --prompt <任务书>`
  （`--for-arm` 同时定 front 与库 ⇒ 读数可信；`--cwd` 指仓库 ⇒ 沙箱里能改文件）。
  ★ 任务书里**必须写逃生门**（例："若本来就没有该问题 ⇒ **如实说明，不要硬塞**"）—— 本轮 T1 正是靠它才没白改。
- ★★★ **123 批次（commit `d0d5b2d`）全部派给 DSH 臂 A 并逐件核验**：T1 消债（★ 它自己发现 `lib-tool-failure` 的守卫是**弱校验**
  并升级；且按任务书逃生门**如实跳过** `patch-anchors`；还**主动报了一条预存在 FAIL** 18/19）；
  T2 脚本可跑性标注（★ 真实测：`spawnSync('bash')`=**EPERM** ⇒ `not-runnable-here`；两个自测 15/15、9/9 + 各 2 消融）；
  T3 `docs/tooldef-registration-plan.md`（抽查引用 **4/4 准确**；要点：**装插件走 `ctx.inject(['tools'])`**、
  **win32 ConstrainedLanguage ⇒ shell 脚本工具跑不了 ⇒ 优先 Node 内联**）。
- ★★ **派活产物目录的真实位置** = **`<任务书所在目录>/_delegate-<tag>/`**（不是 `out/_delegate-<tag>`；我找错过一次）。
- ★★ **"我的判据错" ≠ "被派的人无价值"**：本批里我派 T1 的依据（坏尺子的 2 个假阳性）是错的，
  但 T1 在那 2 个文件里**真的找到一处弱点**（弱守卫）⇒ **两者分开记账**。
- ★★★★ **训练场 = 题库（agent-agnostic）**（commit `0048a4c`，结论见 `docs/training-ground-as-exam-bank-2026-09-25.md`）：
  **场**（题：正文/难度/判据 → `evals/tasks/`，★ **不认识 agent**）‖ **实验**（谁考/什么身份/能否碰别的臂 → `evals/runs/`，**认识**）。
  ★★ **它暴露的现存耦合**：**「训练场 = 臂」**（实例带 `DSH_ARM_SELF/DENY`）⇒ **"场"里混进了"谁在场"**
  ⇒ `arm-isolation` 的语义该从"场"挪到"**实验**"。
  ★ 工具 `scripts/task-bank.mjs`：`refresh`(一键刷新题目,幂等)/`list`/`show`/`pick`(选题)/`score`(★写 runs 不写题目)/`stats`；
  判据 8/8+消融，含 **④b 报告不入库**（用内容判据「`## 可判定的验收`」认题）与
  **⑥ agent-agnostic 否定式判据**（题库里不许有 `agent/arm/by/…`；塞一个 `by` ⇒ 变红）。
- ★★★ **"蓝绿换代当启动器"✗ / "当前代启动并指挥实验"✓**（用户 2026-09-25 提问）：
  换代 = 同一实例内换进程（**同 DSH_HOME/端口/数据** ⇒ **部署语义**、**不是隔离**）⇒ 拿它当实验场会把
  "部署"与"隔离"混成一件（**今天踩过**：两世界共用 `:3101` 池端口 / 共用一份日志）。
  ★ 但**"由当前代发起实验"是对的、也更容易实现**：把"起场/发题/收卷/记分"做成 **DSH 侧的工具**
  （= 用户一贯主张"**用 DSH 当子 agent**"的架构化）。**第 3 步：把发起者从 shell 搬进 DSH。**
- ★★★★ **"另起一个 agent" = "另起一代 + 不 flip"，不需要新机制**（用户 2026-09-25 纠正，他对）：
  换代就是 **spawn 新进程**，而 **`DSH_HOME` 是进程 env** ⇒ 给它不同的 `DSH_HOME` + 自己的端口段
  = **独立实例**；`3080` 只是**"前门指向谁"**的开关 ⇒ 不 flip = 另起一个 agent 但不当现役。
  ★★ **原语我们早就有**：**`arm-up <臂名>`** 正是"另起一代 + 自己的 DSH_HOME + 自己端口 + 不映射到 3080"。
  ★ 我上一轮说的"换代换不了隔离"**是错的**（漏了 spawn 可带不同 env）。
- ★★★ **题 = 【目标】+【环境】**（用户 2026-09-25）：`meta.env`（默认 `{inherit:true}`）；
  `checkExecutable()` 缺 env ⇒ **不可执行**；判据 9/9 + 消融 2/2。
  ★★ 且 agent-agnostic 判据要**把"谁"与"在哪"分开**：禁 `agent/by/model/preset`，
  **允许 `env{arm,dshHome,ports,isolate,profile}`** —— 题面**该**说"在什么条件下做"，**不该**说"谁来做"。
- ★★ **下"做不到"这种否定结论前，先去看那条链路是怎么实现的**：我两次凭"机制推理"下否定结论
  （换代不能隔离 / 池端口必须外部给）都被事实推翻。**结论要建立在读到的事实上。**
- ★★★ **池在连续换代后会"静默消失"**（2026-09-25 实测 + 修，commit `e1ce2a7`）：
  `key-pool-proxy` 撞 `EADDRINUSE` 时**只打一句 reused 然后永不再试**，且 `bindProxy()` **在真绑上前就置
  `listening=true`**；换代是"新代先绑、旧代后释放" ⇒ 新代一撞就放弃 ⇒ 旧代退出后**池无主**。
  ⇒ 修：**只有真绑上才置 listening** + **退避重试**（1.5s×8）+ 到顶**响亮报警**。
  ★ 验证：换代后 `:33101 LISTENING` + `pool=3` ✓（**但"重试"那条路本次没撞上，仍未走通**）。
  ★ 该包 `tsc` 另有既有错误（`src/test.ts` TS2835 缺 `.js`）⇒ **构建不干净**。
- ★★★★ **"判据拦住了"才是它有价值的时候**：`run-experiment` 第一次真跑就在第一道门
  （`arm-up` 自检⑥「池在段内」）**拒跑** ⇒ **没发题、没产生假成绩**，还顺带挖出了一个真 bug。
  ⇒ 与今天三次"假判据走弯路"对照：**判据的价值在拦住时体现，不在放行时体现。**
- ★★★★ **`Number(null) === 0` 这一族**（2026-09-25 第二次栽）：`recordScore` 里 `Number(rec.score)`
  把"**未判分**"写成 "**0 分**" ⇒ **污染题库均分**（实测 0.5833 vs 正确 0.875）。
  ⇒ **凡是"没有值"的语义（未判/未测/拿不到），一律保持 `null`，不许经过 `Number()`**。
- ★★★ **题需要生命周期**：同一道题被解决后再考，考的是"**认出已做**"而不是"做题" ⇒
  **数据点不可比** ⇒ 已解决的题应**退役 / 换难度 / 加 delta**。
- ★★ **实现要跟得上自己刚立的原则**：立了「**场 ≠ 实验**」之后，`run-experiment` 却把派活产物
  写进**题目录**（因为 prompt 指向题面、产物落在 prompt 同级）⇒ 改成**题面拷到证据区再发**。
  ⇒ **立原则之后要回头 grep 一遍实现**。
- ★★★★ **题 = 回归基准（不是考卷）；不设"退役"**（用户 2026-09-25 否掉我的"生命周期"提议）：
  用法是**下一代对自己重放**；判据是**功能正确 + 分数不相差太大 + 在预期范围内**，
  ★ 且**允许"为扩展功能面（加工具等）牺牲性能"导致的暂时退步**。
  ⇒ ★★ **但"可以理解"必须落成可测条件**：`verdict()` 里
  **分数降 ∧ 功能面变大 ⇒ `tolerable-regression`（不报警）** ‖
  **分数降 ∧ 功能面不增 ⇒ `regression`（报警）**；出预期范围 ⇒ `out-of-expect`（硬边界优先）。
  · **功能面**的可测代理 = **该臂 DSH_HOME 下能力库条目数**（读不到 ⇒ **null 不是 0**）；
  · `task-bank verdict <id>` 出一整条 **重放轨迹**（含判定与报警数）；判据 **17/17 + 消融 3/3**
    （★ **消融③**：撤掉"功能面"条件 ⇒ 真退步不再被放过 ⇒ 判据变红）。
- ★★★★ **判据的松紧写在【题】里，机器不推断**（用户 2026-09-25）：出题者**知道**这刀是"性能换功能"还是"功能换性能"。
  · **`expect.mode='functional-only'`（默认）**：★ **小更新只看能不能跑成功**（`fail⇒报警`；**`ran`⇒unjudged，未判≠通过**），
    **分数照记但不判升降**（"加个插件这种跟性能没关系"）。
  · `expect.mode='score-band'`（**大改动显式写** + `score:[lo,hi]`）：分数带判定（含"降∧功能面变大⇒tolerable"）。
  ★ **不许强制一刀切**（用户："完全可以灵活应变，不一定要做这种强制"）。
- ★★★★ **闭环已完整**：`题 → 起一代(arm-up 不 flip) → 发题 → 收卷 → 判定 → 报警/放行`
  （`run-experiment` §⑤：报警 ⇒ **exit 1 不放行**；打印该题**重放轨迹**与报警数）。
  判据：`task-bank` **21/21 + 消融 3/3**、`run-experiment` **5/5**。
- ★★★★ **控制面管理面（`?cmd=mgmt`，commit `c4430d1`）**：绕开 Shell，用**长服务**管理 DSH。
  · 动作：`tasks` ／ `verdict&task=` ／ **`experiment&task=&arm=[&dry=1]`（异步：started+runId）** ／ `result&runId=`
  · ★★ **安全三前提**：① **具名动作白名单** ② **参数先校验**（题在题库、臂有实例、名字 `[a-zA-Z0-9._-]`）
    ③ ★★ **绝不经 shell**（`spawnSync(node,[脚本,...参数])` **数组**）
  · 判据 `scripts/delegation/test-mgmt-surface.mjs` **9/9 + 单因子消融**（7 个恶意题名全拒、argv 零元字符）
  · ★★ **要生效必须重启控制面**（switchboard 进程要重载代码 ⇒ **换代不够**）。★ 且**谁的进程谁重启**：
    我拉起的（arm-up B）我能停能起；**用户终端拉起的（arm A / 现役）我 `process.kill` 会 EPERM**。
