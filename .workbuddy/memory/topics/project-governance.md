# 项目治理：资产边界、文档可信度、文档索引

> 上级索引：`../MEMORY.md`

## 1. 资产边界：哪些是重复建设，哪些是独有的（2026-09-14 判断）

**结论：DSH 做的是「插座」，我们做的是「电器」。不是"人家做得更好"，是"不同层"。**

**DSH 已经做得比我们好的（＝重复建设，不要重造）**：

- 子代理基础设施：`SubagentProvider` 可插拔接口 + `registerProvider` + `provider-added/removed` +
  工具 lazy mount + `toolFilter`/`persona`/`agentOptions` + 谱系树 UI + `report` + `send_message`/`interrupt_agent`
- 上下文压缩：DSH 原生 compaction（cache-first 设计 + 摘要调用构造为"最后一个真实请求的真前缀"）
- 大输出外置：`dsh-spill-policy`（写入时替换 + spillStore + locator 可召回）
- 多会话/编排底座：`dsh-agent-loop` + preset + realm + `dsh-tool-workflow`
- 观测/审批 UI：客户端插件体系

**DSH 没有的（＝真正独有，值得继续做）**：

- **判据阶梯**（机械门 → 不变量门 → 基线不退化 → 隐藏 holdout → 反事实对照）
- **自进化闭环**：候选 → 装配 → 验收 → **注册**（DSH 只有注册 API，**没有"谁批准注册"**）
- **能力库版本管理**：lineage / supersededBy / **谱系毒性召回**
- **淘汰规则**与重叠度判据
- **能力级蓝绿**与"进化税"
- **外部 Agent 接入的注册门**（acceptance 必须由我们定，不采信外部自证）
- **信息保全层**：DSH 原生压缩有损且**不可召回**
  （21 个 `dsh-tool-*` 无任何读回历史入口）

**最重要的一条**：DSH 是 `0.1.1-rc.2`，注释里满是 TODO（HMR 未测、fork 保持 one-shot 的取舍理由写在 note 里），
**不是完成态**。而"自进化"这一层在开源界也还没成型 —— 所以不是"人家已经做完了"。

**推论（把"能力税"原则用到自己身上）**：**能接的不要自造。**
每发现一处 DSH 已有且更好的实现，就用它替掉自研的，把精力全部留给判据层。

## 2. 文档可信度（2026-09-13 血泪教训）

- **`ai-base/agent-shell/docs/conveyor-belt/design.md:218`「我们的 DeepSeek 后端无此约束」是 AI 写入文档的幻觉**。
  用户当时已纠正、但文档未同步 → 后来者（**包括 AI 自己**）把它当成"用户的设计误判"来论证，
  **得出完全相反的结论**。
- **约定**：**AI 写入设计文档的事实性断言必须带来源 / 置信标记**；
  引用老文档做论证前，先查该断言是否被后续推翻（文档内是否自相矛盾、代码是否与文档冲突）。
- **`ai-base` 整体半废弃**：其文档里的**角色命名一律作废**（与 `elv/dsh-hub` / `dsh-brain` 代码冲突）。
  Canonical：`right`＝导师/科研（选题＋判定）· `left`＝执行者 · `sandbox`＝被测物。
- 命名与"15813 = elv/dsh-hub"之类的陈旧说法，**以代码为准**。

## 3. 文档索引（`docs/`）

| 文档 | 内容 |
|---|---|
| **`ideas-spec.md`** | **入口级旗舰规格（实现无关）**：把 agent-shell 值得保留的**工程理念/不变量**抽成规格，作为在 DSH 上重新实现的唯一依据。每节：意图 / 不变量 / 边界 / 验收标准。**改动架构前先读它。** |
| **`ast-io-entry.md`** | **AST 读写编辑统一入口（设计稿）**：零前置静默建索引 / 三入口 code_read·filter·edit / 模型无感（工具层默认实现，不写 prompt）｜缺口只有"冷启 bootstrap"，内核已有 |
| **`rename-design-canvas.md`** | **改名方案**：候选名 + npm 实测证据 + 179 文件影响面 + 两段式迁移（品牌层 / 机器契约层）｜**待定，working name `agentio`** |
| **`agent-code-io-landscape.md`** | **同类项目调研**：四层格局（改写引擎/语义索引/LLM 落地/平台）+ 五共识两裂缝 + 定位与命名启示｜**"他们怎么做的"** |
| **`agent-code-io-adoption.md`** | **可抄台账**：13 条同类优于我们的做法（出处/怎么落地/落点/优先级）+ 我们已有而他们弱的｜**P0 冷启已做，P0-b 残余 8 处待补** |
| `self-evolution-master-plan.md` | **自进化总纲**：四条路径、判据阶梯 §5、免疫系统、假设引擎 |
| `capability-registry-evolution.md` | **能力库式自进化**：provider 机制、架构分层、注册规则、信号/判据分工 |
| `per-subagent-memory.md` | **每个子脑的记忆**：三档 tier + 发表门、粒度挂能力不挂实例、记忆注入对子代理免费 |
| `memory-asset-triage.md` | **记忆资产处置表**：33 模块/457KB 盘点、`SkillNode` 就是能力库、睡眠需常驻宿主 |
| `single-front-brain-delegation.md` | **单前脑 + 委派式多脑**：谱系树 UI 查证、顶层更新问题、六个失败模式 |
| `handover-vs-restart.md` | **换代 vs 重启**：三道保险、三级替换策略、fast 换代 |
| `three-brain-evolution.md` | 三脑演进路线（历史设计，角色命名需以代码为准） |
| `context-cache-efficiency-measurement.md` | 命中率实测、三个前缀改写源、外置化时机原则 |
| `cache-ab-experiment-log.md` | 缓存 A/B 实验记录（基线、判定标准、待做队列） |
| `gen-port-prefix-invalidation.md` | gen 端口写进 system prompt → 换代击穿缓存 |
| `gen-plugin-tree-partial-failure.md` | 插件树部分加载失败 → 能力残缺 + 模式漂移 |
| `conveyor-postmortem-and-revival.md` | 传送带复盘与复活（信息保全，不是 cache） |
| `findings-compaction-nodes-crash-2026-09-13.md` | 压缩崩溃排查（`measurement` 缺字段） |
| `review-external-six-layer-plan.md` | 外部六层方案评估（最危险的是它的 `auto_evolve`） |
| `BUILD.md` | 构建说明（含 profile manifest 必须无 BOM） |
| `verification-contract.spec.md` / `self_evolution_verify_gate.review.md` | 验证契约 |
| `.trae/documents/HANDOFF-2026-09-13.md` | 交接文档（**注意其"15813 = elv/dsh-hub"是错的**） |

## 4. 设计原则汇总（跨主题）

这些是反复出现、可迁移的原则，值得单列：

1. **外置化要在写入时（append-only），不能事后 replace** —— 否则击穿前缀（见 `prompt-cache.md`）
2. **动态内容不放前缀，放尾部或按需** —— 能力清单、动态注入同理
3. **判据不能由被判定者自证**；判据的独立性靠**上下文隔离**，不靠 prompt 写"请客观"
4. **字典序，不是加权** —— 能力门先过，再比效率（加权一定存在"省资源但做不成事"的正收益坡道）
5. **无谓限制 = 纯能力税** —— 判断一条限制该不该留，只问：**它防住了哪一个具体危害？答不上来就该拆**
6. **危险的不是"能力"，是"不可撤回"** —— 目标应是最大化能力 + 让动作可撤回
7. **反馈要成为使用的副产品，而不是额外流程**（进化税不设收益率门槛）
8. **任何"手工挑字段"的路径都必须与主路径共享同一份接口契约，并纳入测试**
   （`deterministicFallbackPrune` 漏 `measurement` 崩溃就是这么来的）
9. **信号决定何时花判据；判据决定是否采纳** —— 两者不可混
10. **按变化频率分层**（三级替换策略 / 能力清单方案 C，同一思路）
