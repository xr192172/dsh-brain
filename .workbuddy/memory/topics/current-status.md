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
- ⚠️ **运行时未生效**：MCP server 是 stdio 拉起的进程，需 **rebuild（已做）+ 换代**后模型才看到新地图。

## 其他未闭合

- **读写编辑统一入口（AST 内核）：设计稿已出** → `docs/ast-io-entry.md`。
  ★ 结论：**内核已有，缺口只有「冷启 bootstrap」**（`ensureFreshIndex` 只保鲜不冷启，
  见 `tests/tools/index_freshness.test.ts` 的「空库 → 不 bootstrap」用例）⇒ P0 极小。
  三入口 `code_read`/`code_filter`/`code_edit`；N3 模型无感**绝不写 prompt**（靠工具层默认实现）。
  待拍板 5 项（名字/兼容/扫描边界/dry_run 默认/索引归属）。
- **design-canvas 改名：推荐已给，待用户拍板**（主推 `silva`/「林」；备选 `graft`/`arbor`）。
  影响面：仓内 **179 文件** + DSH profile/插件/能力库；分「品牌层 / 机器契约层」两次走。
- P2-b 重启验证（`list_capabilities` 是否进模型工具清单）｜
  "读写编辑统一入口 + 模型无感"愿景（详见日更 2026-09-14 尾部）。
