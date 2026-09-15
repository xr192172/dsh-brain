# 当前状态 / 下一步（更新至 2026-09-14 15:44）

> 2026-09-14 从 `MEMORY.md` 拆出。**只记还在生效的状态**；完整过程见 `.workbuddy/memory/2026-09-14.md`。

## 已修并复测通过

压缩兜底崩溃｜gen 端口击穿（boot 段见 `dsh web: ...:3080`）｜插件树部分加载失败 + 启动健康检查｜
BOM｜桌宠移除｜`?cmd=restart` fast 换代（2.6s）｜插件树离线验收=基线｜BOM 守卫=0｜凭据 configured。

## 换代副作用（P1）—— 已修并复测通过（build `b1789323453051`）

曾一次注入**两条** prompt（含「视为用户已预先批准」）；且若 turn 卡在 `ask_user_question`，
`turn/end` 永不来临 → 再换代 resume 失败 → 会话变未 attach。现为**条件注入**：
`scheduleResume(...,[],...)` 只 attach 不注入；`prepareSwitch` 加 `turn/start` + **空闲短路**；
coordinator 判据 = **`waitedForTurnEnd === true`**；fast 不注入。
**实测**：直调 prepareSwitch 闲置时 **4ms** 返回 `reason=idle`（旧必等 20s）；
正常 handover 在空闲会话上 **4.6s** 落定、defer 同秒完成。细节见 `docs/handover-vs-restart.md` §6。

**未闭合**：换代后首轮命中率仍 0%，与"3 小时空闲"混淆 → 需在 header 稳定在 3080 后做单变量复测。

## 委派链（P0' → P1-b）

- **★ P0' 结论反转（2026-09-14 实测）**：委派工具**本来就可用**，不是"被上游禁用"。
  分工是「**host plane 出 registry，agent plane（preset）出工具行**」：`dsh-base` 提供
  `subagent` + spawn/fork backends；`dsh-web-app` 的 patch 只在 host plane `disabled` 那四个工具行；
  而 **`code` preset 又把它们挂了一遍（未 disabled）**。实测模型手里确有
  `subagent` / `subagent_fork` / `list_agents` / `interrupt_agent` / `send_message`。
  ⚠️ **踩坑**：只看 host plane 的 `--dump-config` 会看到 `disabled: true` → 误判"被禁用"。
  **权威口径**：`scripts/dump-request-tools.mjs`（读会话 `request/header` 事件的 tools + system）。
- **P1-b 已完成并验收**：`packages/subagent-council/` —— 第一个自定义 `SubagentProvider`
  （议事厅 · 架构师 `council-architect`）。重启后真实委派全通过：preset=`code-council`、
  `council_architect` 进 system、`code-dispatch-start` 派发成功、persona 五段式生效。
  装配基线 **576 行**。流程见 `docs/subagent-provider-howto.md`；改 preset / 写 persona 见
  skill **`dsh-agent-preset-authoring`**。**回滚**：`~/.dsh/settings.yaml` 的
  `agent-presets.default` 改回 `code`。

## 能力库（P2 / P2-b）

- **P2 数据层已完成**：`scripts/capability-registry.mjs` + `~/.dsh/capabilities/registry.json`
  （schema = lineage + acceptance + holdoutHash + 行为信号；动作 = register/supersede/merge/retire）。
  已登记 `spawn` / `fork` / `council-architect`。★ `check` 抓出：**存量能力都缺 acceptance 引用**
  → P3 注册门必须连存量一起补。
- **P2-b 已完成（待重启验证）**：`packages/capability-bridge/` 给模型两个**只读**工具
  `list_capabilities` / `capability_report`。**工具走 host plane 全局层 → 不需要改 preset**
  （先例：tool-evolution 的 `tool_score`）。装配基线 **579 行**；逻辑已离线单测
  （`scripts/test-capability-bridge.mjs`，mock ctx 直接调 execute）。
  ⚠️ `defineTool()` 返回裸对象 `{name,description,parameters,output,execute,presentCall}`，可脱离 DSH 单测。
  ⚠️ 重启后**首轮 cache 命中率 0% 是预期的**（tools 段变了一次）。
- **★ 能力库必须覆盖两层**（用户提醒后补）：原设计只登记**委派层**（subagent-provider），
  漏掉**工具层** —— 而模型手里大部分工具来自 MCP（design-canvas 一家 60 个）。
  已补 `MCP_SOURCES` + `scanMcpSource()`；design-canvas 登记为 `kind: mcp-server`
  （60 工具 / 6 能力线 / 导航工具 `capability_map`）；`list_capabilities` 分层输出。
  **对接而非重复造**：跨源总览归 `list_capabilities`，线级导航归它的 `capability_map`。
  ★ 首次抓到真问题：`capability_map` 是**手工同步**的静态表，**4 个工具没进任何能力线**
  （`go_originals` / `memory_observe` / `memory_targets` / `move_symbol`）→ 靠它导航的 agent 看不见，
  含记忆系统两个入口。设计见 `docs/capability-registry-evolution.md` **§3.6**。

## 下一步 P3

注册门（L0~L4 判据阶梯）+ 给存量 `spawn` / `fork` / `design-canvas` 补 acceptance；
**验收对象必须含 `kind: mcp-server`**（工具层）。

## ★ 已完成（2026-09-14 下午）：`capability_map` 目录由注册表派生

- **旧**：`capability_map.ts` 手写 `LANES`（55 条）+ 测试自带手抄 55 工具清单（第三份副本）
  → 漏了 4 个工具静默消失。
- **新**：工具集合 = `server_registry` 的 `TOOL_DEFS`（唯一权威），由
  `makeCapabilityMapHandler(() => TOOL_DEFS)` **注入**（capability_map 不 import 注册表，防循环 import）；
  `LANE_OF` 只写「工具 → 线」，`when` 缺省取注册描述首句；漏标 → 输出单列「⚠ 未归线工具」+ 校验报错。
  **60/60 归线**；补了 `memory_observe` / `memory_targets`（observe）、`go_originals`（cross）、
  `move_symbol`（refactor）、`capability_map`（meta）。design-canvas 提交 `91a57ea`。
- `scripts/diff-dc-capability-map.mjs` **重写**：不再正则解析源码 → import 编译产物 + `validateLanes`
  + 真调 handler + 与 `registry.json` 的 `tooling` 块对账，`--fix` 回填（已刷成 60/0 漂移）。
  另留 `scripts/dump-dc-tool-catalog.mjs`（导出真目录含描述，定 `when` 文案时用）。
- ✅ **运行时已生效（2026-09-14 16:29）**：fast 换代成功 → **gen-3084 / 3084 / pid 31004**。
  对 design-canvas MCP stdio server 做真实握手 `tools/list` 实测 **60 个工具、含 `capability_map`**
  （dist mtime `08:00:31Z`）；新 gen `[capability-bridge] apply running` + `[design-canvas v0.1.3] MCP server started`。
  ⚠️ 首次换代（→ gen-3083）**换崩了**：见下节 P0。

## 其他未闭合

- **读写编辑统一入口（AST 内核）：P0 + P0-b 已完成** → `docs/ast-io-entry.md` / `docs/agent-code-io-adoption.md`。
  **P0**：空库就地静默建索引（有界 2000 文件 + 诚实 `state/truncated`）。
  **P0-b**：新增 `ensureProjectIndex(root)` 单一入口；已接线 `semantic_search` / `explore_code(diff_impact)` /
  `diagnose` / `extract_contracts` / `harvest_closure` / **`find_references`（缺索引自建重试）**；
  改 7 处前置文案。**旁证**：`find_references.test.ts` **7 红 → 3 红**（剩 3 项为既有跨语言闭包缺口）。
  探针 `scripts/probe-dc-zero-setup-mcp.mjs` **6 项断言 PASS**。
  **残余**（已记档）：`analyze_monolith`/`language_concepts`/`query_feature`（同步内核或非 agent 路径）、
  `function_outline`（feature 级缓存）；`diff_views` 等属**领域前置不该动**。
- **P0-1 智能报错（Did you mean）已完成**：`src/tools/arg_suggest.ts` + `registerAllTools` 注入；
  ★ 关键：**inputSchema 必须换 loose object**（否则 SDK 严格 object 静默丢未知键，提示不出现）。
  探针 `scripts/probe-dc-arg-suggest-mcp.mjs` 4 项 PASS。
- **P0-5 可撤回已完成**：`src/tools/file_snapshot.ts`（影子副本，不用 git）+ 新工具
  `list_snapshots`/`rollback_snapshot`；落盘前自动快照已接 `edit_code`/`rename_files`/`move_symbol`
  （`rename_symbols` 待接）。⚠️ 与既有 `snapshot.ts`（DSL feature 快照）同名不同职 → 目录分开
  `code-snapshots/`。探针 `scripts/probe-dc-snapshot-mcp.mjs` 5 项 PASS。
  **四根 MCP 探针（snapshot/arg-suggest/zero-setup/capability-map）一起 exit 0**。
  全量 vitest **1974 passed / 11 基线失败**（readme 工具数门禁已自愈 60→62）⇒ 无新增回归。
  **下一步**：~~P0-4 模糊编辑级联~~（✅ 09-15，commit `2db7aae`：fuzzy_match.ts 四级级联
  只做 replace_text，歧义即停+诚实回执，测试 7 项+全量 2100 与基线一致）
  → **P1「修复→规则沉淀」（当前下一项，最差异化）**。
- **★ 换代分工（2026-09-14，用户纠正后定案）**：**我的宿主是 WorkBuddy，被换代的是 DSH**
  （`dsh web` 那套 gen/switchboard）——两者是不同系统 ⇒ **我天然是外部观察者**，
  不会再"吐槽自己不能被重启"（此前那条理由是错的）。
  真正要守的纪律只有两条：① **换代报 `success` ≠ 新代可用**（必须查 `boot.log` 最新 BOOT 段 +
  `crash-investigation/`，铁律 9）；② **换代由用户发**（他的偏好；已确认 16:50 / 17:16 两次
  fast 换代都成功：→ gen-3085 / gen-3086，boot 段干净、MCP server 已拉起）。
- **design-canvas 改名：推荐 `agentio`**（主推，5/5 闸）／`agentbase`（备选，最对位）／`astbase`（机制向）。
  命名策略：**机器名走基建系直白词（`*base`/`*io` npm 多空闲），意象词降级为中文外号**
  （事实依据：canopy/lexis/scalpel/silva 全被同语义真项目占）。
  影响面 179 文件 + DSH profile/bridge/能力库；文档 `docs/rename-design-canvas.md` §6–§7（两段式迁移）。
- **换代闭环**：`capability_map` 改造**已生效**（gen-3084）—— 真 MCP stdio 探针
  `scripts/probe-dc-capability-map-mcp.mjs` 4 项断言 PASS（60 工具 / 6 线 / 5 个曾漏网工具可见）。
- P2-b 重启验证（`list_capabilities` 是否进模型工具清单）：**已具备证据但未做会话级复核**
  —— gen-3084 启动日志 `[capability-bridge] apply running; registry=~/.dsh/capabilities/registry.json`，
  说明插件已成功装载（`list_capabilities`/`capability_report` 走 host plane 全局层）；
  若要拿"模型真看到的清单"，仍应跑 `scripts/dump-request-tools.mjs <会话相对路径>` 看 `request/header`。
- **observe（原 camera）线：体检完成 + ★ 推荐器 v1 已实现** ——
  数据：944 次调用里 observe_* 采纳 **0 次**；体量 3159(TS)+1895(tool)+~7000(Go) 行 / 20+ 测试 / 9-08 起冻结。
  ★ 结论修正：C（验收）覆盖不了"因果解释"⇒ 走 **D（语义观测点 + 采集前判定 + 预算）**，
  而 D 唯一缺的"推荐器"**已落地**：`src/tools/observe_points.ts` + 工具 `recommend_observe_points`
  （key 取自插桩器 dry-run 站点 ⇒ 零漂移；`focus` 任务定向；多样性配额）。
  **实测**：不传 focus 时缓存/压缩相关推荐 = 0 条；传 `focus=conveyor|spill|cache|...` 后
  **前 8 条全落 `packages/conveyor-context/src/index.ts`** ⇒ 命中用户当初动机。
  ★ 顺带修掉 `instrument.ts` 一个**真源码注入 bug**（`IO_CALLS[callee]` 原型链误判 →
  `x.toString()`/`new Foo()` 被当 IO 调用，注入垃圾探针）。
  文档：`design-canvas/docs/observe-line-triage.md` §5.5–5.6、`docs/observe-point-recommender.md`。
  **待用户**：手写 ≈10 个"真正想看的点"作 holdout → 命中率 ≥80% 才算推荐器成立；
  再跑两轮 A/B 与 `cache-ab-experiment-log.md` 比，决定这条线生死。
- "读写编辑统一入口 + 模型无感"愿景（详见日更 2026-09-14 尾部）。

## ★ P0（2026-09-14 16:25 发现并已修）：capability-bridge 缺 config → 换代即换崩

- **症状**：`?cmd=restart` 返回 `result:success`、流水 `verify-boot-health ok: 本次启动无装载失败`、
  `retire gen-3082` —— 但新 gen `EXIT code=1`（`lifecycle.log` `runtimeStopped=false`），
  端口 3083 无监听 → **前端门 3080 返回 `502 upstream ECONNREFUSED`，整套服务全下线**
  （旧代已 retire，`rollbackFlip` 因假阳性健康检查未触发）。
- **根因**：`packages/capability-bridge/cordis.patch.yml` 的 `insert` **没写 `config:`**，
  而插件 `Config = z.object({...})` 不接受 `undefined` →
  `failed to apply loader entry capability-bridge: invalid config: expected object, received undefined`。
  其余四个 `@dsh-brain` 插件都显式写了 `config`，**本包是唯一漏的**。
- **修法**：patch 补 `config: { registryPath: '', maxRows: 50 }`；`check:profile` 由 **579 → 582 行**
  （+3 行），exit 0 / stderr 空。**注：改 patch 不需要 rebuild**（YAML 在装载时读）。
- **★ 两个更值得修的上游问题**（尚未动）：
  ① `verify-boot-health` **漏判启动失败**（gen 崩了仍报 ok）—— 这是保险本身失效，比这次事故更危险；
  ② 插件 schema 应对"无配置"健壮（doc 明写"留空 = 默认路径"），否则任何新插入都可能崩整个 harness。

## 2026-09-15 增补

- **① verify-boot-health 漏判 ✅ 已修**（2026-09-15 下午）：抽成 `packages/switchboard/src/boot-health.ts`。
  根因**不是判据错、是读得太早**（崩溃文本比 `result:success` 晚 **637ms** 落盘；旧实现读一次就定论）。
  修法 = **有界等待重读**（6s）+ **要求正向完成信号** `dsh web: http://127.0.0.1:<port>`
  （实测 10 个真实启动段 9 个有它，唯一没有的正是崩溃段 ⇒ 零误报的精确判别器）；
  三态 `healthy/fatal/unknown`，**`unknown` 同等回滚**；新增 3 条裸根因模式 +
  确定性死亡信号 `proc.exitCode !== null`（无竞态）优先于 `kill(pid,0)`。
  **关键澄清**：`fast` 跳过的稳定窗只重探 probe（崩溃前进程确实还活着），
  **不覆盖"日志落盘了吗"** ⇒ 健康检查与 `verifyStableMs` 正交，fast 不得跳过。
  验证：`scripts/test-boot-health.mjs` 32 项全通 + `scripts/verify-boot-health-on-real-3083.mjs`
  在真实日志上跑（落盘前 → unknown 拦截；完整 → fatal 早退）；
  对照实验：**旧判据=健康放行，新判据=回滚**。文档 §0.1 已诚实化（原"已修"是假修复）。
- **② 插件 schema 无配置健壮性 ✅ 已修**（2026-09-15 傍晚）：6 个 zod 包的 `Config`
  套上 `tolerantConfig` = `z.preprocess(v => v ?? {}, schema)` ⇒ **缺 `config:` 块不再炸插件树**
  （`subagent-council` 用 schemastery，原生容忍，未改）。
  三个反直觉点：裸 `z.object` + undefined ⇒ **抛 ValidationError**（gen-3083 原事故，真机复现 2 REJECT）；
  `.default({})` 是**更坏的假修复**（返回字面量 `{}`、短路内层解析、全字段变 undefined，静默降级）；
  `preprocess` 才是正解（默认值生效 **且类型错仍拒绝**）。
  ★ **认知修正**：`npm run check:profile`（`--dump-config`）**不校验插件 config** ——
  删掉 `config:` 仍 EXIT=0/579 行（它只组装打印文本，不实例化插件、不调 `resolveConfig`）。
  产物：`scripts/check-config-tolerance.mjs`（**56 项**，经 **cordis 真实 `resolveConfig`**）
  + `scripts/probe-config-resolveconfig.mjs`（真机探针）；门禁已**回归自证非空过**
  （换回裸 z.object ⇒ EXIT=1 指名 `缺 config（undefined）`）。
  写门禁踩到两个"空过"坑：`.default({})` 返回的 `{}` **没有值为 undefined 的字段**（须做**键集合比对**）；
  `z.preprocess` 编成 **pipe**、内层在 `def.out`（内省须下钻，否则 zod **忽略未知键** ⇒ 假通过）。
- **下一项：P3 注册门** → 之后 ④ 边界扩展（拍板缓）。

- **P0-4 模糊编辑级联 ✅**（commit `2db7aae`）：`src/tools/fuzzy_match.ts` 四级定位
  （L1 逐字 → L2 空白归一 → L3 缩进弹性 → L4 省略号占位），**只做 `replace_text`**
  （其余 op 走 AST/显式行号天然不模糊）；纪律=歧义即停+唯一才动；诚实回执（级别进消息）。
- **CI 三平台全红已修 ✅**（commit `235bf5b`）—— ★ **不是** C/C# 环境问题（这是纠错）：
  122 次 run 全失败，唯一真因 = `readme_tools_gate --check`（README=63 vs 真实=64），
  其 dogfood 测试断言 `changed===false` ⇒ 三平台一致失败（与平台无关）。
  另修：behavior 测试的 `PY` 探测（CI windows runner 无 python）→ `describe.skipIf(!hasPython)`。
  **C/C# 只是能力矩阵里的"声明项"，从不编译**；Go job 一直是绿的。
- **archify 仓内 vendor ✅**（commit `aa944e8` + `02a1df6`）：
  `third_party/archify/`（69 文件/2.18MB，选 third_party 因 `.gitignore:58` 忽略 `vendor/`）；
  `resolveArchifyRoot` 三级优先级 = **显式参数 > `ARCHIFY_ROOT` > 仓内默认**
  （默认根用 `import.meta.url` 上溯，不依赖 cwd）；CI 加 `archify doctor` 自检。
  ⇒ **修掉了两个长期病灶**：CI 永远验不到这条链路 + 宿主环境变量污染测试。
- **★ R5 诊断修正：`sequence`/`dataflow`/`lifecycle` 三类不合格**（不是早先说的两类 ——
  那次数的是 Downloads 陈旧副本）。溢出：sequence 1586(+76%) / dataflow 1302(+45%) /
  lifecycle 1245(+38%)，全部 `viewer/viewport-overflow`。
- **★ R5 已挂起 ✅**（commit `dbd7e6a`，用户拍板「保留在仓内、暂不开发、别影响后续」）：
  处置 = **挂起**（不删、不屏蔽）；单点开关 `DC_R5_SKIP=1`（默认**照跑**，保留回归保护）；
  4 个 R5 测试文件 28 项接入 `r5Describe`；`test:main`/`test:r5` 脚本；CI `doctor` 加 `if`。
  **挂起 ≠ 免责**：`view_inputs.test.ts`（中性层，主线资产）与 `contract.test.ts`+`contract.ts`
  的 `archify-demo`（对外契约）**仍受 CI 保护**，没挂。文档 `docs/r5-archify-hung.md`。
  ⇒ **R5 手尾已处理干净，可以放心回主线**。
- **纪律沉淀**：**用"仓外副本 + 环境变量"做基线诊断 ⇒ 诊断结论本身不可信**；
  本机 `find` 不可信（报错后返回 0）⇒ 统计走 node；`node -e` 里反引号会被 bash 抢 ⇒ 写文件再跑；
  **design-canvas 的 `docs/*` 被 gitignore（发布划界）⇒ 新文档必须 `git add -f`**。


---

## 2026-09-15 傍晚：P3 注册门 ✅

**P3 已完成**（`docs/capability-registry-evolution.md` §5.4.1 + §9）。

- **`scripts/capability-gate.mjs`**（新）：L0/L1 硬门。L0 对 subagent-provider **真跑**
  `apply(mockCtx, config)` 捕获 provider → 接口 5 成员齐（`name`/`capabilities`/
  `inheritsParentContext`/`start`/`prepareContinuable`）+ `capabilities` **键集合**与声明一致；
  对 `kind:mcp-server` 检验入口/工具面可扫/有工具有线索/能力线目录与实际注册一致。
  L1 = `role`·`writeScope`·`credentials`·`budget` **必须显式声明**（缺 ⇒ fail-closed）；
  **设计类角色（scout/designer/reviewer）不得有 `production` 写权**。
  **L2~L4 未实施**，回执写 `proofLevel:'L1'` + `unenforced:['L2','L3','L4']`。
- **注册 ≠ 采纳**：`capability-registry.mjs` 的 `register`/`init` 只建 `pending`；
  **只有门能把状态改成 `active`**；`acceptance.kind` 只认 `'gate'`。
  存量 4 条原为「未经门的 active」已**如实降级**，过门后重新 active。
- **存量 4 条全部过门**：spawn / fork / council-architect / **design-canvas（`kind:mcp-server` 工具层）**。
- **自证** `scripts/test-capability-gate.mjs`（29 项，两方向）：6 种坏法各自被挡在**正确的级与检查项**上，
  **且完好的能力必须被放行** —— 只证前者不够（"一律 blocked"的门同样无用）。

### 本轮一并修掉的两个真问题

1. **★ 扫描器过期 ⇒ 假漂移**：`capability-registry.mjs` 的 `scanMcpSource` 还在用
   design-canvas 2026-09-14 改造**之前**的正则（找 `{ name: '...' }`），
   报出「67 个工具全部未归线」。实为假漂移（权威值 64 工具、全部归线）。
   **假漂移比不报更坏**：骗人修不存在的问题，还让人不再信任这个检查。
   已抽成 `scripts/capability-sources.mjs`（**单一实现**），与 `diff-dc-capability-map.mjs`
   走同一权威路径（import 编译产物 + `validateLanes`/`buildLanes`）。
2. **★ 我自己的判据错了 ⇒ 假红**：我加的交叉校验「`inheritsParentContext=false` 且
   `credentials=inherit` ⇒ 违反凭据边界」是错的 —— 两者不是一个维度
   （前者=**会话上下文**，后者=**凭据**；in-process 子代理同进程，共用凭据是架构事实）。
   它当场产生假红，而过门只能把声明改成 `own` = **往注册表里写假话**。
   **会误报的门最终会被绕过去，于是什么也保护不了。** 已删除（L1 对凭据只判"已显式声明"）。
   ⇒ **判据做错方向有两面：假绿（漏放行）与假红（误拦）同等有害。**

## 未闭合 / 下一步（2026-09-15 起）

- **P4**（核心角色一工具名，长尾走 `delegate_capability` + `list_capabilities`）与
  **P5**（外部 Agent adapter，把"接入版本"纳入注册门）—— 前置 P3 已解除。
- **L2/L3/L4 判据阶梯**未实施（需基线口径 + 独立评测集/holdoutHash + A/B 编排）。
- design-canvas 侧：**④ 边界扩展**（拍板缓）；**R5 挂起**（`docs/r5-archify-hung.md`，
  `DC_R5_SKIP=1`，默认照跑）。
- 其他待拍板：`scopeToIndex` 对 MCP `watch_project` 是否默认开｜改名 working name `agentio`。

## 工具层纪律增补（自 MEMORY.md 迁入）

- **★ 同一文件的两个 Edit 并行发 ⇒ 后者基于旧快照覆盖前者，且两边都报成功**
  （本轮连踩 2 次、丢改动：`KNOWN` 数组、`list`、`check` 三处被静默回滚）。
  ⇒ **同文件编辑必须串行；改完 grep 验证关键标记**。
- **写含反引号的 markdown 时别用 JS 模板字符串**（反引号会截断字面量，本轮踩到）
  ⇒ 用 Write 写纯文本文件再 `cat >>` 追加。
- 参考项目（自进化「多模型会议室」）：`dsh-flow`（仓未核实）、`dsh-collaboration`、
  `dsh-agent-team-gui`、`dsh-ha-orchestrator`。

## 2026-09-15 夜：P4 进度 —— 补丁严格化 ✅ + 折叠内核 ✅（接线待做）

### ✅ 上游补丁锚点严格化（提交 `4d9feb6`）

`scripts/patch-*.mjs` 原先**没有任何 `process.exit`**：锚点找不到只打印 `FAIL`/`⚠️` 后继续，
而挂在 `postinstall` ⇒ **上游一变补丁静默失效、无人被告知**（与"假绿"同类）。

- 新增 `scripts/patch-anchors.mjs`：**三态判定**（already / pending / **missing ⇒ 非 0 退出**，
  `DSH_PATCH_STRICT=0` 可降级）。
- ★ 单列 `missing` 是为了抓一个**隐蔽假绿**：若 helper 插进去了（其 MARK 命中）但后续 edit
  没打上，之后每次运行都因 MARK 命中而整文件 skip ⇒「有 helper 但没人调用」= **毫无防护**，
  却永远显示"已打补丁"。现在 app-boot 把 helper 也算一处改动（共 5 处），该状态必然暴露。
- `all:true`（替换全部）**顺序要紧**：只要锚点还在就必须继续替换，否则"改了一半"会被
  误判成 already，从此永远停在半成品。
- 顺带：`patch-goal-round-driver` **此前不在 postinstall 里**（补丁存在但装完不自动打）——已挂上。
  `patch-profile-deps` ① 只在内容真变化时才写 ② **加后置校验**（原把 `BOM: PRESENT(bad)`
  打印出来却不当回事 = 自己报红还照样成功）。
- 自证 `scripts/test-patch-anchors.mjs`（**17 项，两方向**）。
  ★ 测试自身也踩过一次假绿：首版用 `execFileSync`，成功退出时拿不到 stderr，
  导致"降级告警"那条恒假通过 —— 已改 `spawnSync`。

### ✅ 折叠内核（P4 骨架，离线可验）

`packages/capability-bridge/src/notice.ts` —— **纯函数**，不碰 ctx / IO / 时钟。
自证 `scripts/test-capability-notice.mjs`（**27 项**，跑编译产物）。

证的三件事（都是最容易做错、做错了还不显眼的）：
1. **幂等**：同状态重复折叠，第二次起恒为 `no-pending`/`dropped`，绝不重复写。
2. **写的是快照不是增量**：断言文本含全部当前项、**且不含"新增/已卸载"等增量措辞** ——
   因为写增量就引入相对量，一旦丢了模型会**以为错**（而非"不知道"）。
3. **顺序无关**：判据是「当前集合 == 上次折叠时的集合？」，不是"成对相消" ⇒
   `+X,-X` 与 `-X,+X` 结果相同，§6.1.3 那个顺序坑自然消失。
   集合未变时 `dropped`（不写）**但仍推进水位**，否则 delta 永远留在 pending 白做功。

### ⏳ 未做（下一步）：**接线**

折叠内核已验证，但**尚未接进 live 会话**。刻意停在这里 ——
接错会把坏插件塞进 boot 路径，而装配链今天刚出过事。

接线需要先定两件事：
- **观察口**：`ctx.on('session/event', (id, ev) => …)`（`SessionStore` 注释明说
  「persistence plugins subscribe to `session/event` and flush on `session/flush`」
  ⇒ 这是插件观察会话的官方姿势）。
- **写入口**：`session.append(type, data, ...opts)`。但**从事件拿到的是 session id**，
  要经哪个服务取回 session 句柄待核（`tool-evolution` 是在工具 `execute` 里用
  `exec.agent.session`，插件级路径不同）。
- 另需：模块级注册自定义事件类型（照抄 `tool-evolution` 的
  `KNOWN_SESSION_EVENT_TYPES.add('tool/review')`，幂等），本次事件名暂定 `capability/notice`。
- 验收：装进 profile 后，用 `dump-request-tools.mjs` 断言 **`tools` 数在无压缩轮里恒定**
  （指纹 `1789|69~71` → `1789|N`，N 不跳）。**换代由用户自己发。**

> ⚠️ `device note`：`capability-bridge` 加文件后**必须重建 lib** 才能被 `check-config-tolerance`
> 与自证脚本看到（它们跑的是编译产物）。

## 2026-09-15 深夜：P4 接线路径**已核实** + 「拆装不确定」的根因定案

### ✅ 接线路径核实完毕（P4 的阻塞项解除）

**权威先例**：`@deepseek-ai/dsh-session-persistence`（它就是以"订阅会话"为职责的插件）：

```js
ctx.on("session/event",   (session, event) => { ... })   // ← 回调直接给**活的 session 对象**
ctx.on("session/flush",   (session) => this.flush(session))
ctx.on("session/created", (session) => { this.initFor(session) })
ctx.on("session/disposed",(session) => { this.retire(session) })
for (const session of ctx.sessions.list()) this.initFor(session)   // ← **回填既存会话**
```

⇒ 接线三件套全部确定：
- **服务名 = `sessions`**（`SessionStore extends Service` + `super(ctx, "sessions")`）
  ⇒ `ctx.inject(['sessions'], (sctx) => { … })`
- **观察口**：`sctx.on('session/event', (session, event) => …)` —— 拿到的是 session 对象，
  **不需要**自己按 id 去 `get()`（我原先的担心是多余的）
- **写入口**：`session.append(type, data, ...opts)`（`SessionStore.append` 是公开方法）
- ★ **必须回填既存会话**（`ctx.sessions.list()`）—— 否则插件加载前就存在的会话永远收不到通知；
  persistence 正是这么做的。

### ★ 「拆装不确定」根因定案（写入 `capability-registry-evolution.md` §6.4）

用户问：DSH 宣传时间连续性/空间连续性（可热重载、Agent 自己执行、**能拆就能装**），
为什么我们的拆装不确定？

**答：体感是对的，但它描述的是「插件层」；连续性在「能力层」是真的。**

| 层 | 装/卸方式 | 有连续性吗 |
|---|---|---|
| **能力层**（provider / tool / 会话事件类型） | **运行期 API** | ✅ 有 |
| **插件层**（包 / bundles / patch.yml / node_modules 补丁） | 改配置 → **重新装配** | ❌ 没有 |

**能力层可逆的实证**（`dsh-tool-subagent/lib/index.js:278-283`）：
`provider-added` ⇒ `mount()`；`provider-removed` ⇒ `disposeTool()` ⇒ **注销即摘工具**。

**插件层没有的两个原因**：
1. **上游把 host 侧 HMR 关了** —— `cordis-plugin-hmr` 在 `dsh-web-app/cordis.patch.yml:21-23`
   被 `disabled: true`，上游注释自陈「TODO: Re-enable shared HMR for Web after its
   reload lifecycle is tested」；常驻的 `client-hmr` 只管浏览器侧 client bundle。
   ⇒ 改 host 侧代码的最小路径仍是重启/换代。
2. **我们的改动大量落在 cordis 之外**：node_modules 编译产物补丁（4 脚本 + 500 行
   patch-package）、bundles 数组、两层 patch.yml、profile package.json + pnpm。
   不在 effect 体系里 ⇒ 改了就改了，卸载不撤销。
3. 失效模式因此全是**配置层**的：`duplicate loader entry id` / `declares no dsh.bundle` /
   BOM / 缺 `config:` / **`disabled` ≠ 移除**。

⇒ **这正是 P3/P4 的方向所在：把工作从"不成立的那一层"搬到"成立的那一层"。**
P3 让能力采纳有判据（能力是运行期的，所以判据能真跑）；
P4 让能力增删不改写前缀、长尾走 `delegate_capability` ⇒ **Agent 自己装卸能力而不重启**。

> **可复用判据**：判断某改动能否"热拆装"，先问**它落在哪一层** —— 运行期 API（可逆）
> 还是配置/产物（需重装配）。后者别期待回滚，也别指望 `disabled` 当卸载用。

### 工具层纪律增补（本轮又踩到）

- **用标题行当 Edit 锚点插入内容时，若不把标题一起写回，标题就被吃掉**
  （本轮把 `## 7. 外部 Agent 接入` 误删，正文被并进 §6；已修复）。
  ⇒ 以标题为锚点插入时，new_string **必须**以该标题结尾。
- 修文档结构前先 `grep -nE "^#{1,2} "` 列全部标题核对 —— 光看正文 grep 不足以发现标题丢失。

## 2026-09-15 深夜（续）：P4 **接线完成** + §6.5「干净」的两种

### ✅ P4 接线已完成，并被离线自证（16 项）

**关键突破：真正的"搭车位"是 `tools/post-execute` waterfall，不是自己 append 一条 surface 事件。**

```
'tools/post-execute'(exec, result, next) => Promise<PostToolDecision>
```
- 它是**写入前**决定写什么 ⇒ **前缀不动**（与 `dsh-spill-policy` 同一机制，文档明确标它"前缀不动 ✅"）
- 对比 `surfaceOp: replace`（事后改写）⇒ 必击穿 —— 我们正是因此关了 tool-result-pruner
- ★ **surface 只有三类**（`user/message|assistant/message|tool/result`）⇒ 自己造一条会假装成
  "别人说的话"；而 **`additionalContexts` 才是上游设计给插件注入上下文的通道**
  （`dsh-agent-loop` 会 `acceptContext`；先例 `dsh-repeat-tool-reminder`）

**接线的五个确定件**（全部有权威先例）：
1. **非 surface 事件类型**：`KNOWN_SESSION_EVENT_TYPES.add('capability/change')`（照抄 tool-evolution）
2. **服务名 `sessions`**（`SessionStore extends Service` + `super(ctx,"sessions")`）⇒ `ctx.inject(['sessions'], …)`
3. **观察**：`sctx.on('session/event', (session, event) => …)` —— 回调直接给活的 session
4. **写日志**：`session.append(CAP_CHANGE_EVENT, {...})`
5. **取 session id**：`exec.agent?.session.header.id`（spill-policy 的 `ownerSessionId`）
   —— 无 agent 时是 `undefined`（直接/测试调用），要容忍

**通知条目形状**（照抄 repeat-tool-reminder）：
```js
{ content: [{type:'text', text}],
  source: { kind:'plugin', plugin:'capability-bridge', form:'notice', summary } }
```
★ **`source` 标注是必需的**，上游注释明说：漏了它，未标注的 context 会在**派生历史里被渲染成用户提示**（假消息）。

**自证** `scripts/test-capability-notice-wiring.mjs`（**16 项**，mock ctx 真调 `apply()`）：
处理器装上、首次见到会话只记基线不记变更、能力库变了才挂车、幂等收敛、
集合没变就不写（dropped）、`source` 齐全、能力库读不到 ⇒ 原样返回（**失败隔离**）、无 agent 调用不炸。

**设计要点**：全部包 try/catch —— **通知失败绝不影响工具结果，更不能影响 boot**。
收益是"省缓存"，boot 是命脉，代价不对等 ⇒ 一律降级为 no-op。

### ★ §6.5 回答用户：「装得干净、卸得干净」的两种，以及前提的一处修正

用户：*上游关了 HMR 只是不能重载，但装卸干净这个特点我们也要维护好。*

**结论同意，但前提要修**：HMR 关闭**不是**与"能否卸干净"无关的事 ——
上游注释说的是「after its **reload lifecycle** is tested」，而 reload lifecycle
**正是拆卸与重装的顺序问题**。⇒ 它是"拆卸没把握"的**症状**。
**不能因为 HMR 关了，就假定拆卸是干净可靠的；没被测的正是拆卸那一半。**

**"干净"分两种，我们今天主要靠前者**：

| 种 | 怎么来 | 可组合？ | 在哪 |
|---|---|---|---|
| **进程级干净** | 改配置 → **重启** = 全新进程 | ❌ | 插件层（我们的主路径） |
| **效应级干净** | `ctx.effect` 回滚 / 依赖驱动卸载 | ✅ | 能力层 |

★ 改 `bundles` 后重启**根本没有"卸载"发生** —— 是个全新进程
⇒ 那是"简单粗暴地干净"，不是"可组合地干净"。

**我们正在破坏这个性质的 5 处（可核查）**：① 手工改 node_modules 编译产物（体系外，卸不掉）
② `disabled` 当卸载用 ③ 包目录残留（`dsh.client` 可能被前端加载）④ 状态文件残留
⑤ **`KNOWN_SESSION_EVENT_TYPES` 的进程级 mutation**（卸载不撤销 —— **P4 自己引入的有意例外**，因为它是读日志的兼容性要求）。

**建议**（未实施）：`scripts/check-plugin-hygiene.mjs` —— 正查 bundles 完整性、
反查残留包、deps 与 bundles 一致性、遗留物、源码比产物新（提醒没重建）。
口径：每条能指名"哪个包、哪一步没卸干净"，不出总分。

## 验证（无回归）

check:bom 0 违规｜check:profile 582 行/err 0｜config-tolerance 56/56｜
boot-health 32/32｜capability-gate 29/29｜notice 内核 27/27｜**notice 接线 16/16**｜patch-anchors 17/17。

## 2026-09-15 深夜：插件卫生门 ✅（装得干净/卸得干净可核查）

用户选 ① —— 把 §6.5 的性质做成可跑的门。产物 `scripts/check-plugin-hygiene.mjs`
+ 自证 `scripts/test-plugin-hygiene.mjs`（**26 项，两方向**）。

### ★ 它一上来就报出两处**真问题**（不是空门）

1. **4 个 bundle 未在 profile 的 `dependencies` 里声明**（tool-evolution / subagent-council /
   capability-bridge / switchboard）—— 它们靠 `profiles/web/node_modules/@dsh-brain/*` 的
   **符号链接**解析。⇒ **跑一次 `pnpm install` 可能把它们剪掉，那几个 bundle 会静默失效。**
   ⚠️ 这与我们这两天修的"静默失效"是**同一类失败**，只是换了层。
   **未擅自修**：改 profile + pnpm install 是今天出过事的操作，blast radius 大，待用户拍板。
2. **`~/.dsh/pet.json` 残留**（桌宠插件已移除，状态文件还在）+ `~/.dsh/.backup/` 一个备份目录
   —— 正是 §6.5.3 表里的第 4 类"卸不干净"。留着无害，但如实报出。

### 门的设计口径（三条，都写进脚本头注释）

- **每条指名「哪个包 / 哪一步」，不出总分**（沿用 §5 fail-closed 逐项纪律）。
- **ERROR ⇒ 非 0 退出；WARN ⇒ 退出 0 但大声打印**。
  ★ 为什么 WARN 不失败：有些项**可能是有意为之**（如 `packages/` 里留一个开发中的新包）。
  **一律判红 ⇒ 门会被绕过 ⇒ 比不设门更糟**（与"假红"的教训一致）。
  想要更严用 `--strict`。
- `--json` 可机读；`--profile-dir / --packages-dir` 供自证夹具注入（默认走真实路径）。

### 检查项

正查（ERROR）：bundle 的包目录存在 / `lib/index.js` 存在 / `cordis.patch.yml` 存在 /
`package.json` 有 `dsh.bundle` / profile 侧链接存在且不悬空 / manifest 无 BOM。
反查（WARN）：`packages/` 里有但未被任何 bundle 启用（残留 or WIP，需人甄别）/
bundle 未声明进 deps / 已移除插件的遗留状态文件 / `.backup` / **源码比编译产物新**（改了没重建）。

### 自证的诚实边界

悬空链接那条本来"跳过"（本机建不了符号链接）⇒ 我没就这么算它验过：
改用**空目录当链接**命中同一条判据（「link 路径存在 且 link/package.json 不存在」），
现在该分支有覆盖，且额外断言"不能误报成缺链接"。

### ⚠️ 一个待处理的组织问题

现在**门已经有 9 个**（check:bom / check:profile / config-tolerance / boot-health /
capability-gate / notice 内核 / notice 接线 / patch-anchors / plugin-hygiene 自证），
**缺一个统一入口** —— 这本身就会变成"开发起来混乱"的新来源。
建议加 `npm run check:all`（复用 `check-plugin-hygiene.mjs` 的"逐项 + 汇总"口径）。
**待用户拍板**（要不要做、失败语义怎么定）。

## 验证

九门全绿：check:bom 0 违规｜check:profile 582 行/err 0｜config-tolerance 56/56｜
boot-health 32/32｜capability-gate 29/29｜notice 内核 27/27｜notice 接线 16/16｜
patch-anchors 17/17｜**plugin-hygiene 自证 26/26**；门本体：ERROR 0 / WARN 6。

## 2026-09-15 深夜：修掉 4 个未声明依赖 + 定下「不追上游」策略

### 用户定策（长期规则，已进 MEMORY.md 铁律 #10）

> **不追上游版本**。上游随时会改，我们**只按需合并对我们有利的改动**，不为追新而升级。
> **上游自身的问题暂不处理**；**管好我们自己部分的开发即可**。

**边界判据**（本轮核实，用于回答"这是上游的还是我们的"）：
- `@deepseek-ai/*` 从 `profiles/node_modules/` 那条**上游共享树**解析 ⇒ 上游的，不管
  （例：`@deepseek-ai/dsh-web-app` 是 bundle 但不在 deps，**不动**）
- `@dsh-brain/*` 从 `profiles/web/node_modules/` 每-profile 目录解析 ⇒ **我们的，要管**

### ✅ 修掉 4 个未声明依赖（卫生门抓出的那处）

**问题**：`tool-evolution` / `subagent-council` / `capability-bridge` / `switchboard`
只在 `dsh.profile.bundles` 里，**没进 `dependencies`** ⇒ 只靠
`profiles/web/node_modules/@dsh-brain/*` 符号链接解析；而 profile 的 `pnpm-lock.yaml`
只认已声明的包 ⇒ **一次 `pnpm install` 就会剪掉它们，那几个 bundle 静默失效**
（与我们在 boot/配置层修过的"静默失效"同类，只是换了层）。

**修法（脚本化，不手工改）**：扩展 `scripts/patch-profile-deps.mjs` ——
遍历 `dsh.profile.bundles`，为每个 `@dsh-brain/*` 且包目录存在的项补
`link:D:/project_develop/dsh-brain/packages/<name>`。三处硬化：
- **只在内容真变化时才写**（旧版无条件重写）
- **★ 写之前先备份**（该文件在 `~/.dsh/` 下、**不在 git 里**，改坏了没历史可回滚）
- **后置校验**：任何人方 bundle 未声明 ⇒ 非 0 退出（`DSH_PATCH_STRICT=0` 降级）

**结果**：`我方 bundle 声明 7/7`；幂等（再跑"无变化"）；**`check:profile` 仍 582 行 / err 0 /
dup 0 / pet 0**（装配没坏）；`check:bom` 0 违规；**卫生门 WARN 6 → 2**（剩 `pet.json` + `.backup`）。

### ⚠️ 未做（待用户定）：同步 `pnpm-lock.yaml`

新增声明后它与 `package.json` 不再一致：
- 普通 `pnpm install` 会同步它（= 本次修复的收尾动作）
- `--frozen-lockfile` 会**明确报错** —— **响亮 >> 静默**，方向是安全的
- **没擅自跑**：profile 装配链今天出过事，blast radius 大；建议用户在能盯着的时候跑

### 交付物

`scripts/patch-profile-deps.mjs`（扩展）+ `~/.dsh/.backup/profile-web-package.json.*.bak`（改前备份）。

### ✅ pnpm-lock 已同步（2026-09-15 深夜，用户选 ①）

**关键发现：`pnpm` 其实是有的** —— 在 `C:/Users/Admin/AppData/Roaming/npm/pnpm.cmd`
（v10.26.0），只是**不在 PATH 上**；`npx pnpm` 不行，但全路径可直接调。

**用最小改动面做**：`pnpm install --lockfile-only` —— **只改 lock，不碰 node_modules**
（对比 `pnpm install` 会顺带 reconcile node_modules）。先备份 lock 到 `.backup/`。

#### ★ 顺带发现：lock 本来就脏，而且脏在**两个方向**

| 方向 | 内容 |
|---|---|
| **漏** | 4 个我们自己的包（tool-evolution / subagent-council / capability-bridge / switchboard） |
| **多** | `@dsh-brain/handover-agent`（09-14 已从 deps 删的悬空项）+ **`@linxin666/dsh-pet`**（已移除的桌宠，**连它的 integrity 哈希和依赖树 clsx/schemastery/cosmokit 都还在**） |

⇒ 又一次"卸不干净"的残留；而且**没人发现**，因为 `check:profile` 只看装配**结果**、不看 lock。

#### 结果（全部实测）

- lock importers deps **9 条 == manifest dependencies 9 条**（双向零差集）
- 两个陈旧条目归零（`grep -c` 均为 0）
- **`check:profile` 仍 582 行 / err 0 / dup 0**（装配没坏）
- **node_modules 未被动**：`@dsh-brain` 链接仍 7 个

#### ★ 补掉卫生门的盲区（这是本轮更值钱的部分）

给 `check-plugin-hygiene.mjs` 加了 **lock ↔ manifest 一致性检查**：
- manifest 有、lock 无 ⇒ **ERROR**（`--frozen-lockfile` 会失败；正是我们刚修的那种不一致）
- lock 有、manifest 无 ⇒ **WARN**（陈旧条目，会被 prune；属"卸不干净"残留）
- 没有 lock / 解析不出 ⇒ **WARN 且明说"无法核对"**（**不假装通过**）

自证从 26 → **34 项**（含 lock 一致 / 漏依赖 / 陈旧条目 / 无 lock 四种）。
★ 又踩一次自证的坑：断言只查了 `what`，而"无法核对"在 `detail` 里 ⇒ 假失败；已改成
`what + detail` 一起查。

#### 剩余 2 个 WARN（未处理）

`~/.dsh/pet.json`（桌宠残留状态）+ `.dsh/.backup/`（3 项备份，含我这轮新建的 2 个）。
留着无害；要不要清由用户定 —— 注意 `.backup` 里那两项**是有用的回滚点**。

#### 工具层教训（累计第 5 次）

`node -e` 里带正则/引号会被 bash 抢插值 ⇒ **一律写 `.mjs` 文件再跑**。
本轮又中一次（写 lock 解析正则时）。这条已在 MEMORY 环境约束里，但我仍会顺手用 `node -e`
—— 需要更强的自律。
