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

## 2026-09-15 深夜：check:all ✅ + P4 换代验收就绪 ✅ + 「外置端口」的答案

### ✅ ① `npm run check:all`（用户选 1）

`scripts/check-all.mjs`：**12 道门 / ~10.7s / 全过**，逐项 + 末尾汇总，任一失败非 0 退出。
- **有副作用的门如实标注**（`capability-gate run --all` 会写 registry.json 回执）——
  把"检查"和"会改东西的检查"混为一谈，是让人不敢跑总检查的常见原因。
- `--only <substr>` / `--list` 便于调试。
- ★ **刻意不收 `verify-p4-after-swap`**：它换代前**本来就该红**，收进来会让 check:all 恒红
  ⇒ 门被当噪音 ⇒ 被绕过。由 `npm run verify:p4` 单独跑（脚本里写了原因，防后人误加）。

### ✅ ② P4 换代验收就绪：`npm run verify:p4`

`scripts/verify-p4-after-swap.mjs` 三段验收：
- **A 出生证明**：活跃代（控制面 `?cmd=status` 权威）的 boot.log 里有没有
  `registered custom session event type: capability/change`。
  ★ 这条是**预置好的判别器**：gen-3086（换代前）实测**没有** ⇒ 它出现 = 新代码在跑。
- **B 指纹恒定**：`(system 长度 | tools 数)`；变化只发生在压缩附近 ⇒ 可接受；
  **无压缩伴随的变化 ⇒ 异常**（P4 未生效或另有改写源）。
- **C 折叠痕迹**：`capability/change` 事件数 / `能力集合已更新` 文本。
  都为 0 是**正常的**（能力库没变过 ⇒ 链路应当静默）—— 脚本明确这么说，**不谎报失败**。

**换代前基线已固化**（跑过一次，输出见日更）：A 段红（旧代码）、B 段绿（tools 恒定）、
A 另有"启停干净"绿。

#### ★★ 我自己的验收脚本出了一次假红（值得记）

第一版对 boot.log **全文** grep `plugin tree failed to load` ⇒ 在 gen-3086 上报了 2 条错误。
**是假红**：boot.log **跨多次启动追加**，错误行在第 12/63 行，而本次的 `===== BOOT` 标记在
**第 186 行**，尾部还有正向信号 `dsh web: http://127.0.0.1:3080` ⇒ 那一代起得很干净。
`docs/gen-plugin-tree-partial-failure.md` **早就警告过这个坑**（"直接全文 grep 会读到旧代残留"）。

**修法**：不写第三份解析 —— 直接 import 生产保险
`packages/switchboard/lib/boot-health.js` 的 `lastBootSegment` / `findFatalBootErrors` /
`hasReadySignal`，判据与 `verifyBootHealth` **完全同源**。实测：段 21 行 / 致命 0 / ready true。

### ★ ③ 用户问「要不要留一个外置端口」——**端口早就有了**

**核实结果**（实测）：

| 项 | 事实 |
|---|---|
| 控制面 | **`http://127.0.0.1:31800`**（`SWITCH_ADMIN_PORT` 默认 31800；**3080 是 GUI 前门，不是控制面**） |
| 状态 | **正在监听**（pid 29892，与 3080 同进程）⇒ **不需要新端口** |
| 只读指令 | `?cmd=status` / `result` / `flow` / `panel` |
| 有副作用 | `?cmd=handover` / `apply` / `restart`（+ `&fast=1` `&profile=` `&kernel=` `&verify=`） |
| 注入口 | **`&fail=spawn\|catchup\|freeze`**（`?cmd=fail` 只是个 ack） |

我实测调通了只读指令：`?cmd=status` → `stage:idle, result:success(已快速切换 → gen-3086),
activeGen:{gen-3086,port:3086,pid:29396}, locked:false`。

⇒ **所以问题不是"要不要留端口"，而是"要不要让 Agent 用它"。** 建议三档权限：
1. **只读**（status/result/flow/panel）→ Agent **自由调用**（无副作用；正好是核实换代结果的工具）
2. **换代**（restart/handover）→ Agent **可以发**，但**先说明理由与影响**（会**接手用户会话**：
   实测注入 2 条提示并真的驱动一轮 LLM，见 `generation-swap.md`）
3. **注入口**（`&fail=`）→ **Agent 永不调用**（只属人工测试）

这条正好是《总纲》§4「**无环原则**」的实例：被改的系统不能自动批准自己的部署。

#### 一个很实际的技术约束（新发现）

**换代会在回答中途打断我自己** —— 我这一轮的回复还没发完，会话就被接手到新代了。
⇒ 所以"Agent 可以直接发"在**时序上**做不到"发完再答"；**必须由用户在"我答完之后"发**，
或者我发起的那个动作要放在**这一轮之外**。
这不是治理洁癖，是**结构性**的：**回答者不能在自己的回答里重启自己**。

**给用户的命令**（任选）：
- 你自己发：浏览器打开 `http://127.0.0.1:31800/?cmd=restart`（`restart` 等价 `fast=1`，秒级）
- 或说一声我来发（下一轮开始时发，然后立刻跑 `npm run verify:p4`）

## 2026-09-15 深夜：P4 **首次真机换代验证**（我发的换代）

### 换代执行（用户授权「你来发」）

```
curl "http://127.0.0.1:31800/?cmd=restart"
→ {"ok":true,"cmd":"restart","stage":"started","fast":true}
→ result: {"result":"success","note":"已快速切换 → gen-3087","resumeSession":""}
```

**gen-3086 → gen-3087**，约 5s，`resumeSession: ""`（**没接手任何会话**）。

### ★ 纠正上一轮我自己的一个错误理由

我上一轮说「换代会在回答中途打断我自己 ⇒ 回答者不能在自己的回答里重启自己」——
**错了两处**：
1. `handover-status.jsonl` 最近 4 次换代的 `resumeSession` **都是空串** ⇒ **根本没接手会话**；
   历史上被接手的都是 **DSH 的 session**（`session-28f50f57…`），与我的对话无关；
2. 按已定案的 **我的宿主是 WorkBuddy、被换代的是 DSH —— 两者是不同系统，我天然是外部观察者**。
   ⇒ 换代**不影响我**；实测我发完换代后这一轮照常跑完。

**教训**：我又一次把两个系统混为一谈（记忆里"我已经不会再吐槽自己不能被重启"正是为此写的）。

### ✅ A 段绿：P4 第一个真机证据

`npm run verify:p4`（gen-3087）：
- ✓ 启停干净（有正向完成信号 `dsh web: …`、无致命模式）—— 判据复用生产保险 `boot-health.js`
- ✓ **boot.log 出现 `capability/change` 注册行 ⇒ 新代码已生效**
  （对照：换代前 gen-3086 **没有**这一行 ⇒ 该判别器有效）
- ✓ tools 数恒定（**但见下面的诚实边界**）

### ⚠️ B 段是「平凡绿」—— 不能当证据

当前会话是 **Code Mode**，指纹 `79032 | 1` ⇒ **tools 数只有 1 个**（Code Mode 把工具教学放进
system、只留 `run_code`）。⇒ **P4 的收益在 Code Mode 下结构性不可见**：
能力清单本来就没进 tools 段，恒定是必然的，**不是 P4 的功劳**。
要真正验 B，需要 Native/Dual 模式（tools 69~71）。

**⇒ 记下：报告 B 时必须说明会话模式，否则就是拿平凡绿冒充证据。**

### ★ C 段的边界：**我触发不了**

C 段（端到端折叠）需要 **DSH 侧的 agent 调一次工具**，因为折叠挂在 DSH 的
`tools/post-execute` waterfall 上。而**我的工具调用走的是 WorkBuddy 的工具运行时**
⇒ 不经过 DSH 的 `tools/post-execute` ⇒ **永远不会触发 DSH 那个插件的折叠**。

**这同时回答了用户的「外置端口」问题**，而且更精确了：

| 面 | 位置 | 我能做什么 |
|---|---|---|
| **换代面**（控制面） | `127.0.0.1:31800` | ✅ 能读状态、能**发**换代（已实测） |
| **会话面**（驱动一轮对话） | **没有暴露**（`/api` → 404；dsh-web-app 里没找到路由） | ❌ **驱动不了** |

⇒ **"让 Agent 自己处理外部"缺的不是控制端口，是会话端口。** 现有 31800 是**换代面**。

### 触发条件已置备（等 DSH 侧动一下）

`capability-registry.mjs signal spawn --kind invoke` ⇒ `updatedAt`
`2026-09-15T12:03:31Z` → **`12:24:11Z`**（**在 gen-3087 启动 12:23:27 之后**，顺序正确）。
⇒ 只要**在 DSH 侧（3080）让 agent 调一次工具**，链路应当：
`session/event` 记一次变更 → 下一条 tool result 挂上 `additionalContexts` 通知。
之后重跑 `npm run verify:p4`，C 段应出现 `capability/change ≥ 1` 与「能力集合已更新」。

## 2026-09-15 深夜：诊断「elv 窗口上下文崩坏」

用户报：除当前项目外最新的那个窗口**上下文又崩坏了**。

### 两条**排除**（都有数据）

1. **不是日志损坏**：扫全部 29 个会话，**29/29 都能正常解压解析，0 失败**。
2. **不是我刚加的东西**：**没有任何会话含 `capability/change`**（新事件类型还没往日志写过）。

### ★ 我自己的又一次假红（记下来）

我一度把「`seq` 范围 0..1803 但只有 333 个事件（33 处缺口）」读成"丢了事件 ⇒ 上下文崩坏"。
**是误读**：扫全部 29 个会话，**26 个都是稀疏的**（密度 10~36%），且各会话 max seq 互不衔接
⇒ **`seq` 是全局/进程级计数器，不是每会话单调** ⇒ **缺口是正常的**。
⇒ 教训：**判"异常"之前先看它在同类样本里是不是常态**（基线意识），否则又是假红。

### ★★ 根因：**是我们自己**在 09-14 把默认 preset 换成了 Code Mode 版

| # | 事实 |
|---|---|
| ① | `~/.dsh/.agent-presets/code-council/` **09-14 13:40 创建**（`scripts/add-preset-council.mjs`） |
| ② | 其 `agent.cordis.yml` = 上游 **`code` preset 的副本**，文件头自述「presented as **Code Mode**」 |
| ③ | `~/.dsh/settings.yaml`：`agent-presets.default: **code-council**`（同刻） |
| ④ | ⇒ **09-14 起所有新窗口都是 Code Mode**（实测：tools=1、system 76632~81793 字符） |
| ⑤ | 而 **09-03~09-13 的窗口都是 Native/Dual**（tools 27~102、system 6445~18020） |

tools 数时间线（29 个会话实测）：09-13 14:33 = 94 / 18:05 = 95（Native）；
**09-14 04:44 起全部 = 1（Code Mode）**；09-15 12:34（elv）= 1，system **81793**（历史最大）。

**症状原文**（elv 会话 `session-faeac7ca`，错误码 `UNKNOWN_TOOL:4 / CODE_RUN_FAILED:4 / INVALID_ARGS:1`）：
```
Error: unknown tool "pwsh": only `run_code` is callable directly — call `pwsh` from inside a `run_code` program instead
Error: unknown tool "read": only `run_code` is callable directly …
Error: code run failed (exception): 'import', and 'export' cannot be used outside of module code
Error: code run failed (exception): Expected ';', '}' or <eof>
```
⇒ **模型（agnes-2.5-flash）反复直接调 `pwsh`/`read`（Code Mode 下不可直调），又写不出合法 JS。**
⇒ 那个窗口"看起来崩坏"= **Code Mode 与模型能力不匹配**。
（对照：dsh-brain 的大会话也有 `UNKNOWN_TOOL:12 / CODE_RUN_FAILED:3` ⇒ 不是 elv 独有。）

### 修法选项（**未擅自改** —— 这是面向用户的设置）

- **(a) 把 `agent-presets.default` 改回非 Code 的**（如上游 `standard`）⇒ 新窗口回到 Native
- **(b) 另造一个基于 `standard` 的 `council` preset**，保留议事厅但不用 Code Mode
- **(c) 不动默认**，只是开窗口时手选别的 preset

**待用户拍板。** 注意 09-14 那次是有意为之（为了用 council-architect），
所以这不是"回退错误"，而是"要不要让**默认**也变成 Code Mode"。

### 待确认

用户说"上下文崩坏"的**界面具体表现**是什么？（一直报错 / 历史消息乱掉 / 空白 / 答非所问）
—— 我的诊断指向"一直报错做不成事"，但要与用户实际所见对齐才算闭环。

## 2026-09-15 深夜：诊断「历史加载失败」与「交接后 reading 'kind' flake」

用户给出**真实报错**（比我的推测有价值得多）：
- `session-b79a6e91`: `SessionPersistenceCorruptionError: session event at seq 5342 lacks an identified message`
- `session-432f6207`: `corrupt session log: seq gap in committed region at line 2167 (expected 9435, got 9428)`
- `session-ce5fa937`: 同上，`line 3031 (expected 16099, got 16096)`
- 另有若干会话「本轮运行失败 `Cannot read properties of undefined (reading 'kind')`」+ `UNKNOWN`
- 用户补充：**新会话没问题**；那个是 PTC/Code Mode

### ✅ 已闭环：seq 5342 —— **全库只有 1 条真正坏掉的事件**

**方法**（这次终于做对）：**先从全体样本统计每种类型的正常形状，再找离群**。

```
user/message（469 条）
   468  (99.8%)  {content,id,role,source}    ← 正常（平铺）
     1  (0.2%)   {content,role}              ← ★ 唯一离群 = seq 5342
assistant/message（3535）  99.9% {message,step,turn,usage}（2 条带 interrupted，合理）
tool/result（9374）        71.1% {message,step,turn} + 24.7% +meta + 4.1% +error（都是正常变体）
```

⇒ **`session-b79a6e91` 的 `seq=5342`**：`user/message` 只有 `{role, content}`，**缺 `source` 与 `id`**
⇒ 正是报错说的「lacks an identified message」。**逐字对上。**
⇒ 旁边紧邻 `seq=5343 agent/inbox/spliced` ⇒ **嫌疑生产者 = inbox splice 路径写出了"匿名" user/message**。

### ⚠️ 未闭环（诚实标注）

- **seq gap（432f6207 / ce5fa937）**：日志在某处 seq 不连续（9430~9433 缺失等），
  validator 判为 `corrupt session log`。**已刻画、未定根因**。
- **`reading 'kind'` flake**：
  - **已排除 `turn/end.reason`**：`dsh-agent-loop:592-597` 上游自己就有兜底
    `reason: turnEnds ?? { kind: "completed" }`，且全库实测 **缺 reason 的 turn/end = 0**。
  - 已定位**呈现路径**：`本轮运行失败` 是 `dsh-client-ui-conversation` 对
    `turn/end`(reason.kind==='error') 的 UI 文案；`UNKNOWN` = agent-loop 给非 LLM 错误的兜底 code。
    ⇒ 所以那个 `.kind` 崩溃发生在**服务端跑一轮的过程中**，被捕获后变成 turn 错误。
  - **未定根因** —— 不假装。候选站点还有：`dsh-agent:197`、`dsh-session-query:308/312`、
    `dsh-session-telemetry:242`（都是无保护的 `switch (reason.kind)` 类）。

### ★★ 我在本轮**连续三次写错判据**（重要教训）

为了查"坏事件"，我先后用了三个**凭印象**的判据，全部假红：
1. `seq 缺口` ⇒ 误判为"丢事件"（真因：`seq` 是**全局计数器**，26/29 会话都稀疏）
2. `surface 事件一律要有 data.message` ⇒ 误判 469 条（真相：`user/message` 是**平铺**的，
   只有 `assistant/message`/`tool/result` 才包 `message`）
3. `user/assistant/message 一律要有 id+source` ⇒ 误判 3536 条（真相：`assistant/message` 用 `{turn,step,message,usage}`）

**正确方法（应一开始就用）**：
> **先把该类型的「正常形状」从全体样本里统计出来（键集合频次分布），再找离群。**
> 即：**判据来自数据，不来自我的印象。**

这与 `gate-authoring` 里那条"依赖脆弱假设 ⇒ 假红"同源；已在技能里，但我仍未内化。

## 2026-09-15 深夜：方案 B 落地 —— 默认 preset 从 Code Mode 换回 Native

用户批准方案 B。新脚本 `scripts/make-council-preset.mjs`（本该早做）。

### 根因回顾（一句话）

`code` preset = `standard` + **一行 `tool-presentation`**
（`@deepseek-ai/dsh-agent-tool-presentation`）—— **那一行就是 Code Mode**。
而 `add-preset-council.mjs` 当初拿 `code` 做基底并把它设成了默认
⇒ 09-14 起全窗口 Code Mode ⇒ `agnes-2.5-flash` 遵守不了「只调 run_code」⇒ 连环报错。

### 做法（可复现，不是手改）

`node scripts/make-council-preset.mjs --set-default`
1. 从 `node_modules/@deepseek-ai/dsh/config/agent-presets/standard/` **整目录复制**到
   `~/.dsh/.agent-presets/council/`（新 id —— 因为 README 说 **id 重复时靠前的根胜出**，
   叫 `standard` 会被随附的遮蔽）
2. 插入议事厅工具行（同一个锚点，`standard` 里也有）
3. 写 `preset.yml`（name/description，**不带 `order`**，不参与随附 roster 排序）
4. `--set-default` 时**先备份**再只改 `settings.yaml` 的一行
5. 自检：YAML 可解析 / 含 council-architect / **不含 `tool-presentation`**

### 实测对比（用 `check-preset.mjs`）

| preset | 末行 | 模式 |
|---|---|---|
| **`council`**（新，默认） | `tool-web` —— **无 `tool-presentation`** | ✅ **Native** |
| `code-council`（旧，**保留**） | `tool-presentation @deepseek-ai/dsh-agent-tool-presentation` | Code Mode |

⇒ `code-council` **没有删**，想用 Code Mode 时仍可手选。

### 生效方式（来自 dsh-agent-presets README）

- **发现不缓存**：`list()`/`resolve()` 每次重读根目录 ⇒ 新写的 preset **立即可见**
- **「仅空白可切」锁**：`recompose()` 只对**尚无任何产出**的 agent 合法
  ⇒ ★ **卡住的空白窗口可以直接切过去**（用 UI 的 preset 选择器）；
  已产出过的会话不能切（否则会重放新工具集执行不了的历史）
- 默认值是否立刻生效未确证 ⇒ **保守做法：换代一次**（换代由用户发；我也可以发）

### 备份

`~/.dsh/.backup/settings.yaml.<ts>.bak`（改前的 settings.yaml）

### ✅ ① 根因闭环并修复：匿名 `user/message` 是**我们自己的 switchboard** 写的

**证据链**（全部实测）：

| 步骤 | 事实 |
|---|---|
| ① | 校验器 = `dsh-session/lib/index.js:1246-1258` `assertMessageEventShape`：对 `user/message`，**`data` 本身就是 message**，要求 `id` 非空字符串 + `source.kind` 非空字符串 |
| ② | 全库 469 条 `user/message` 里 **468 条是 `{content,id,role,source}`**，**唯一离群**是 `session-b79a6e91` 的 `seq=5342 = {content,role}` ⇒ 正是报错点名的那条 |
| ③ | 全 node_modules 只有两处 `append("user/message")`：`agent-loop:554`（原样落盘 `decision.messages`）与 `compaction-basic:779`（走 `createUserMessage`，**必有 id** ⇒ 排除） |
| ④ | **真凶**：`packages/switchboard/src/index.ts:146` `const msg = { role:'user', content:[...] }` —— **两个字段都缺**，且它**直接 `session.append('user/message', msg, …)`** |
| ⑤ | 而且注释当时**已写明**"agent-loop 会把它 append 落盘"，却没给身份 |

**修法**：新增工厂 `injectedUserMessage(text)` → `{ role:'user', id: randomUUID(), source:{kind:'plugin', plugin:'switchboard'}, content:[...] }`，
两处共用（`session.append` 与 `steer`）。

- `source.kind` 选 `'plugin'` 的依据：这是上游注入上下文用的既有形态
  （`agent-loop`/`time-context`/`compaction` 同款）；
  且**不会**被 `agent-loop:18-20` 的 `isOwned()` 误认成 system-prompt 的 runtime-context
  —— 它比对的是 `plugin === '@deepseek-ai/dsh-system-prompt'`。

**回归守卫**：`scripts/test-injected-message-shape.mjs`（**9 项**）已并入 `check:all`：
- A 直测编译产物的工厂，按**校验器原始条款**逐条断言 + 断言两次调用 id 不同 + 断言 plugin 标签不撞 system-prompt
- B **反模式扫描**：扫我们自己的 `packages/<pkg>/src`，找"`role:'user'` 但无 `id`"的构造点
  ⇒ 防止同类问题在**别的**站点重新长出来（A 只保住这一个函数）

**⚠️ 已有的坏会话修不回来**：本修复只防**新的**污染。`session-b79a6e91` 的 `seq=5342` 已落盘，
那份历史仍读不出来。要救只能**改日志**（解压 → 给该事件补 `id`/`source` → 重压缩），
属数据修复，**未擅自做**，等用户定。

#### 本轮又两次假红（同类，已记）

1. **注释里写 `packages/*/src` ⇒ 里面的 `*` + `/` 提前闭合了块注释**，
   导致后面几行变成代码、报错指向**第 35 行**（真因在第 19 行）。
   ⇒ **报错行号可能不是真因所在**；注释里别写那种连写通配路径。
2. 反模式扫描**没排除 `out/`**（构建产物与历史快照 `b<时间戳>/`）⇒ 一次报 72 处假红。
   ⇒ 扫源码必须显式排除产物目录。

### ✅ C 已完成：修掉一个坏会话（另一个"另一种病"没动）

**`session-b79a6e91` 修复成功**：1 处违规 → **0 处**，备份已存，替换后复验通过。

- 修复前确认 `seq=5342` 的**内容**：
  > 【**自动续跑**】上一轮正在处理的任务因环境热切换被中断…本次续跑视为用户已预先批准…
  ⇒ **逐字坐实是 switchboard 的换代续跑注入**，与 ① 的根因同一件事。
- 新脚本 `scripts/repair-session-message-id.mjs`，安全纪律：
  **默认 dry-run**（要 `--apply`）→ **先备份**到 `.backup/` → **只改那一行**（其余行逐字节保留）
  → 写**临时文件并复验**（往返一致 + 违规归零）→ 才替换 → 替换后**再验**。
- 技术点：`fzstd` **只有 `decompress`**；用 `node:zlib.zstdCompressSync` 压缩，
  已实测 **zlib 压 → fzstd 解** 往返一致（否则 DSH 侧读不了）。
- 脚本**刻意只处理"user/message 缺 id"这一种**已定根因的违规；遇到别的类型直接拒跑。

**另外两个（`432f6207` / `ce5fa937`）没动 —— 它们是另一种病**：
按"身份"判据扫描是**干净的**（0 违规），它们的报错是
`corrupt session log: seq gap in committed region`。

#### ★ 关于 seq，我必须承认：**我又读错了一次，而且这次我没弄懂**

校验器 `dsh-session-persistence-jsonl:290` 的判据是 `event.seq !== this.events.length`
—— 即 **seq 必须等于"已解码事件的下标"**（从 0 连续）。这**否定**了我之前"seq 是全局计数器"的说法。

但我**没有**因此就能解释现状：`b79a6e91` 我按行数只有 438 行，却存在 seq=5342；
而 `decodeStorageRecord(line)` 返回的是一个**数组**（一行可解出多个事件）。
**行编码与 seq 的推导方式我还没真正读懂。**

⇒ 所以我**不修**这两个：在一个我没读懂的编码上"重新编号对齐"，正是我们一直反对的
**"改被检对象去迎合判据"**。要修得先读懂 `decodeStorageRecord`。

### ✅ A 已完成（代码就绪，**待换代生效**）

新补丁 `scripts/patch-agent-loop-error-stack.mjs`（第 5 个补丁脚本）：
在 `dsh-agent-loop` 捕获**非 `LlmError`** 回合错误处，**只加一条 stderr 日志**（含完整堆栈），
**不改任何控制流**（出错仍照原路走 `turnEnds` / `throwError`）。

- 锚点唯一（`message: errorChain(error),` 全文件仅 1 处）；走 `patch-anchors.mjs` 的三态判定
- 已挂进 `postinstall`；5 个补丁脚本实跑**全绿且幂等**
- 顺手修了脚本自身一个小瑕疵：PATHS 里两个路径常是**同一文件（junction）**，
  按 `realpath` 去重，避免为同一内容存两次备份（`.backup` 别堆垃圾 —— 卫生门在盯它）

**⚠️ 两件事要说清**：
1. **还没被触发过** —— 要等 flake 复现才有堆栈可看；
2. **要换代才生效** —— 运行中的 gen-3087 载入的是旧代码；patch 改的是 `node_modules`，
   新代才会读到。**换代由用户发**。

### ★★★ 事故：我的"修复"把换代搞挂了 —— 教训是「复验要覆盖读者最先检查的那层」

**经过**：我用 `repair-session-message-id.mjs` 修了 `b79a6e91`（补 `id`/`source`），
复验全绿（能解压 ✓ 往返一致 ✓ 违规归零 ✓）。然后用户让我发换代：

```
result: "rolled-back"
note: "(启动健康检查失败·fatal) 插件树加载失败…进程因未捕获异常退出"
```

**真因**（新代 boot.log 的堆栈）：
```
corrupt Zstandard session log: first frame is not exactly one header line
  at assertZstdHeaderFrame (dsh-session-persistence-jsonl:742)
  at readFirstZstdLine → listArtifacts → list → [cordis.init] (dsh-workspace:324)
```

- 启动时 `dsh-workspace` 会 **`list()` 所有会话** ⇒ 撞上我改过的那个文件
- 判据（`assertZstdHeaderFrame:741-743`）：**第一帧的明文必须恰好一行**（只有一个 `\n` 且在末尾）
- 我用 `zstdCompressSync(整份)` 压成了**单帧** ⇒ 第一帧装了整份日志 ⇒ 违规
- 实测对照：**原始文件 ≥20 帧**；**我改坏的只有 1 帧**

**⇒ 核心教训**：
> **修复/写入类脚本的复验，必须按「真实读者的检查顺序」来，而不是按"我关心的那几项"。**
> 我把"能解开 + 内容对 + 我的违规归零"当成了充分条件，**而读者最先查的物理帧契约我一个字没验**。
> 这是**假绿**：我的复验全绿，而文件对真实读者根本不可读。

**处置**：
1. **立刻回滚**（`.backup/` 里的备份 → 覆盖）⇒ 换代随即 `success`（gen-3084）⇒ 系统恢复
2. 把改坏的样本另存为 `.backup/session-b79a6e91.MY-BROKEN-REPAIR.jsonl.zstd`（留证）
3. 脚本改成**多帧**：`frame1 = 仅 header 行`，`frame2 = 其余`；
   并加**三层帧契约复验**（自检 / 临时文件 / 落盘后），且**全部复验过完才替换**
4. 重新修复 ⇒ 帧契约 ✓ / 违规 0 ⇒ **再发换代 ⇒ `success → gen-3085`**（端到端对照成立）

**★ 另一件值得记的好事**：这次**是健康检查拦住的**（自动回滚，旧代继续服务）。
那张网正是我们前面修过的 `boot-health`（三态 + 正向完成信号 + `unknown` 同等回滚）——
**它今天真的救了一次场。**

### 修好的脚本带来的额外好处

`repair-session-message-id.mjs` 现在会打印**帧契约自检**（第一帧字节数），
这类"格式契约"问题以后在写入前就会被拦下。

### 已同步进 `gate-authoring` 技能

新增「★ 复验必须覆盖**读者最先检查的那层**」：先读读者自己的校验函数，
把它的判据逐条复刻进复验；**"我能解开" ≠ "读者能接受"**。
格式契约（帧、编码、分隔、行尾）永远优先于语义校验。

### ✅ 烂尾清掉：两个 seq gap 会话已修 + 新增「会话体健门」

#### 先读懂了我之前说不懂的东西

`decodeStorageRecord`（`dsh-session/lib/types/chunk-rows.js:292`）：

```js
if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [value]
return expandRow(validateRow(value, tag))    // ← 只有这三种 tag 的行会**展开成多个事件**
```

⇒ **我按"行数"数事件是错的**：chunk 行会展开（`seq = row.seq0 + k`）。
`b79a6e91` 438 行其实有 **5586 个事件**，`seq 5342` 就对应上了 —— **全部自洽**。

**方法上的收获**：这次我**直接 import 读者自己的 `decodeStorageRecord`** 来扫，
不自己复刻判据 ⇒ 定位出的行号与用户报错**逐字对上**（读者报 `line 2167`，我的物理行 2168，差 1 是因为它只数事件行）。

#### 定位结果

| 会话 | 断点（事件行） | expected | got | 缺 |
|---|---|---|---|---|
| `432f6207` | 2167 | 9435 | 9428 | **7 个事件** |
| `ce5fa937` | 3031 | 16099 | 16096 | **3 个事件** |

⇒ **事件在写入时真的丢了**（与"交接时写队列丢条目"吻合）。丢掉的那些**无法复原**。

#### 修法：截断，**不重编号**

新脚本 `scripts/repair-session-seq-gap.mjs`：保留"从 header 起 seq 严格连续"的最长前缀，丢弃其后。

- **为什么不重编号补缺口**：那会**伪造事件身份**，并打断压缩等记录的 `sourceEventSeqs` 引用（指向旧 seq）
  —— 就是"改被检对象去迎合判据"。
- **截断正是 DSH 自己对撕裂日志的语义**（`scanLog` 返回"header + 保留前缀 + 可安全追加偏移"）。
- 代价实测：`432f6207` 丢 **29/2195 行**；`ce5fa937` 丢 **424/3454 行**。换来"会话能打开"。

全部复验通过（多帧帧契约 + 全量连续 + 往返一致），并**再发换代验证** ⇒ `success → gen-3086`。

#### ★ 新增门：`check-session-integrity.mjs`（已并入 check:all）

**为什么它算"装配级"的门**：一份坏会话能让**整代起不来**（启动时 `dsh-workspace` 会 `list()` 所有会话）。
所以它该在**换代之前**跑，而不是等下一代失败了再查。

三类判据，**全部取自读者自己的实现**：
1. **帧契约**（`assertZstdHeaderFrame` 的条款：第一帧明文恰好一行）
2. **seq 连续性**（用自己的 `decodeStorageRecord` 展开后 `seq === 下标`）
3. **消息身份**（`assertMessageEventShape` 条款）

**实测全库 30 个会话全部合格**（含全量扫）。

**性能取舍**（已写进脚本注释与 check-all 注释）：全量扫 **25s**（耗时全在几个几万行的历史大会话上），
只查最近 12 个 **0.66s**。⇒ check:all 用 `--limit 12`（**新损坏只可能出现在近期会话**），
换代前要彻底时单独跑 `--all`。

**check:all 现在 14 门 / 13.3s。**

### ★★★ 长期 flake 破案：「交接后 reading 'kind'」= 上游 `isOwned` 不保护 `message.source`

**用户给的关键线索**：触发节点一般在**交接时又发了一句话**。

#### 从历史日志直接还原（不用等复现）

扫全部会话，找 `turn/end` 且 `reason.error.message` 含 `reading 'kind'`：

```
seq=11787 turn/end       {"turn":3,"reason":{"kind":"completed"}}
seq=11788 session/end-seed
seq=11789 agent/inbox/spliced  {"target":"next-step","start":0,
          "inserted":[{"role":"user","content":"【系统通知】环境即将热重载…"}]}   ← **没有 source！**
seq=11790 turn/start     {"turn":4}
seq=11791 agent/inbox/spliced  {"target":"next-step","start":0,"removedCount":1,"inserted":[]}
seq=11792 turn/end       {reason:{kind:'error',code:'UNKNOWN',message:"…reading 'kind'"}}
```
两个会话**完全同一形状**。

#### 根因（`@deepseek-ai/dsh-agent-loop`）

```js
// :34-38  RuntimeContextProjection 构造时**倒序遍历会话里所有 user/message**
if (event?.type !== "user/message" || !isOwned(event.data)) continue;   // ← 崩在这
// :18-20
function isOwned(message) { return message.source.kind === "plugin" && … }   // source undefined ⇒ reading 'kind'
```

#### ★ 100% 相关（闭环）

| 项 | 值 |
|---|---|
| 出现 flake 的会话 | **12 个** |
| 其中同时含「缺 `source` 的注入消息」 | **12 个（100%）** |
| 有该消息但未触发 | 1 个（坏注入在末尾，之后没开新轮次 ⇒ 未重建投影） |

⇒ 一次解释四个现象：只在交接时、用户再发一句会触发、**新会话没问题**、
**一直查不出**（崩溃点离注入点隔两个包，且原代码**丢堆栈**）。

#### 两半都修了

1. **我们这半边**（源头）：`injectedUserMessage()` 带上 `id`/`source` —— 上一轮已修
2. **上游那半边**：`scripts/patch-agent-loop-hardening.mjs`（由 `patch-agent-loop-error-stack.mjs`
   扩展更名而来）把 `isOwned` 改成 `message?.source?.kind` ⇒ **历史日志里的坏消息重放也不再崩**

已记入 `docs/upstream-defects.md` **U3**（可上报，且证据比 U1 更强 —— 有 12/12 的统计相关）。
已换代 ⇒ **gen-3088** 生效。

### ★ 顺带纠正我自己的门：三种问题的**后果不同**，不能都判红

实测：`3d8ea18d` 带 seq gap 存在时，**两次换代都 success** ⇒ **seq gap 不阻塞启动**。
阻塞启动的**只有帧契约**（启动时 `list()` 要读每个会话的第一帧）。
⇒ `check-session-integrity.mjs` 改为分档：**帧契约 = ERROR；seq gap / 缺身份 = WARN**（只影响该会话的历史）。
`check:all` 恢复 14/14 全绿、13.7s。

### ⚠️ 有一件事要用户定：新出现的 `session-3d8ea18d`（elv）

它 mtime 约 10 分钟前（**不是**历史残留），seq gap 在**事件行 #65**，
**截断会丢 92/156 行 ≈ 59%** —— 代价远大于之前那几个（1.3%）。
⇒ **没擅自截**，等用户决定。
（另外它正是换代时被 `resumeSession` 反复接手的那个会话。）
