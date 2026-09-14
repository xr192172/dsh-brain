# 可抄清单：同类比我们做得好的地方（采纳台账）

> 来源：`agent-code-io-landscape.md` 的四层格局调研。用户指示（2026-09-14）：
> 「既然有这么多同类产品，我们也可以**抄一抄他们有哪些比我们做得更好的地方**」。
> 本文是**采纳台账**：每条 = 出处 / 他们怎么做 / 我们怎么落地（不照搬）/ 落到哪个文件 / 状态。

---

## 0. 先说已经做完的那条（不是抄，是我们自己的缺口）

| 项 | 说明 | 状态 |
|---|---|---|
| **P0 冷启 bootstrap（N1 零前置）** | 空库不再甩"请先 import_project"，而是**就地静默建索引**（有界 2000 文件 + 诚实 `state/truncated`） | ✅ **已实现并端到端验证**（`index_freshness.ts` / `semantic_search.ts`；探针 `scripts/probe-dc-zero-setup.mjs` 5 项断言 PASS） |

**顺带发现的同类差距（P0-b，同一件事的残余）**：仓内还有 **8 处**在报"请先运行 import_project"——
`diagnosis/candidate_locator.ts`、`diagnosis/chain_tracer.ts`、`diagnosis/root_cause_aggregator.ts`、
`tools/diff_impact.ts`（2 处）、`tools/extract_contracts.ts`、`tools/function_outline.ts`、
`server_registry.ts` 里 `diagnose` 的前置说明。
⇒ 零前置要做成**系统属性**，不能只修查询入口；这些点应逐个改成"自己建/自己退回解析 + 诚实标注"。

---

## P0 · 立刻可做（小改动、体验直接受益）

### 1. 智能报错：拼错的参数名给 "Did you mean?"
- **出处**：Serena（"Smart Errors"：对参数名/枚举值做 Levenshtein，给候选）。
- **他们**：错参数不是干巴巴报错，而是"did you mean `project_dir`?"。
- **我们**：工具报错基本是中文长句、无候选建议；agent 只能重试猜。
- **落地**：在工具入口做一层统一的参数校验（`action`/枚举/常见键），错键 → 用编辑距离给 Top3 建议。
- **落点**：新增 `src/tools/arg_suggest.ts` + 在 `server_registry` 注册时的 wrapper 里接（**不改各业务工具的 schema**）。
- **状态**：待做（性价比最高的一条）

### 2. 渐进式工具描述：短描述进 prompt，全文按需取
- **出处**：Serena（progressive descriptions：列表给短描述，`get_tool_help` 取全文）。
- **他们**：41+ 工具进上下文时不灌长文。
- **我们**：60 个工具的 `description` **全文进 prompt**（`explore_code` 的 1.2k 字符、`refactor_pipeline` 943 字符）。
- **落地**：`description` 收敛到 ≤80 字摘要 + 详细用法放 `get_tool_help(tool, section)` 按需取。
- **⚠️ 与 prompt 缓存的张力**：description 在前缀里，**改一次就击穿一次** ⇒ 要**一次到位**、之后只用 append-only 纪律（铁律 5）。
- **状态**：待设计（收益大但影响前缀，要与缓存策略一起排期）

### 3. 编辑前后闸门（post-edit diagnostics）
- **出处**：Serena（编辑前查引用；**编辑后跑 language server 诊断**再回复）。
- **我们**：已有 `dry_run` + 落盘后自校验 + 回滚；**缺"把语言级诊断回读给模型"**。
- **落地**：`edit_code` / `rename_*` 返回体加可选 `diagnostics`（走已有语言适配器：tsc/ts_kernel 能做的先做 TS 家族）。
- **状态**：待做

### 4. 模糊编辑级联（fuzzy editing cascade）
- **出处**：Serena（4 级降级匹配：exact → 空白归一 → 缩进弹性 → 省略号占位）。
- **为什么关键**：LLM 生成的编辑**天然不精确**；没有级联就会大量"改不了、请重试"。
- **我们**：需先核查 `edit_code` 现有匹配策略（是否只有 exact）。
- **落地**：在编辑定位层实现同样的 4 级降级，并在返回里明示"用了哪一级"（诚实）。
- **状态**：待核查 + 待做

### 5. git 快照 + 一键回滚
- **出处**：aider（每轮自动 commit，`/undo` 回退）。
- **我们**：有 dry_run + 原子落盘 + 失败回滚，但**没有"可回退的历史"**（跨调用无法撤销）。
- **落地**：`edit_code`/`rename_*` 落盘前自动建快照（git stash/临时 branch 或 `.design-canvas/snapshots/` 影子副本，按项目是否 git 仓自适应）；加 `rollback <snapshot>`。
- **状态**：待做（与"不可撤回 > 能力"的设计原则 6 一致，值得早做）

---

## P1 · 结构性（中改动、决定长期形态）

### 6. 上下文排序：RepoMap（tree-sitter tag + PageRank → token 预算内给最相关符号）
- **出处**：Serena `get_repo_map` / `get_context`；aider 的 repo map。
- **我们**：索引里已有 `nodes/edges` 图 ⇒ **PageRank 是现成的**，但目前没有"按 token 预算挑上下文"的入口。
- **落地**：新入口 `code_map`（或 `explore_code action=repo_map`）：输入 token 预算 + 任务种子文件 → 输出排序后的符号清单。
- **状态**：待设计（在 `ast-io-entry.md` 的三入口之外，作为"读"的高级形态）

### 7. ★ 把一次性修复沉淀成可复跑规则（最"我们"的一条）
- **出处**：Grit（用 GritQL 把 LLM 生成的重构固化成**可复现 PR、无 prompt drift**）；Codemod（迁移注册表 + ast-grep 底层）；OpenRewrite（recipe 资产）。
- **他们**：**一次修复 → 一条规则 → 全仓/全组织复跑 → 进 CI 防回归**。
- **我们**：有 `refactor_pipeline`（可复跑的组合）与「能力库 + 判据阶梯」，但缺少"**把这个改动导出成规则**"的动作。
- **落地**：`code_edit` 成功后可选 `export_recipe=true` → 产出可复跑规则（先用我们自己的 pipeline 步骤表示，未来可映射到 ast-grep/GritQL 语法），登记进能力库（`capability-registry`）。
- **价值**：这是把"agent 自进化"落到**代码改造**上的具体形态；也是与同类形成差异的地方（他们做规则给人用，我们让 agent 现场长规则）。
- **状态**：待设计（建议列为 P1 首位）

### 8. 迁移/重构看板（campaign dashboard）
- **出处**：Codemod 的 campaign 看板；Moderne 的跨仓进度视图。
- **我们**：有画布 + feature + DSL ⇒ **做看板是现成能力**，只是没把"重构活动"当成一等实体。
- **落地**：把 `refactor_pipeline` 的每一步与影响面渲染成画布（复用 `render_brickwork`/`render_design` 的渲染层）。
- **状态**：待设计

### 9. Lossless 契约（格式不变要成为**可测的承诺**）
- **出处**：OpenRewrite 的 **LST**（保留空白/格式的类型感知树，卖点即"改完 diff 干净"）。
- **我们**：编辑是 span 级（`{pos,len,old,new}` 可重放）⇒ 已接近，但**没有把"格式不变"写成契约 + 测试**。
- **落地**：为 `code_edit` 补"最小 diff"断言（不允许整段重写导致的格式漂移），并纳入回归。
- **状态**：待做（小）

### 10. 按客户端/角色裁剪工具集（profiles）
- **出处**：Serena 的 `--profile=claude-code / codex / ide-assistant / ci-bot / full`。
- **我们**：60 个工具全量给所有 agent；`capability_map` 只是"导航"，不是"开关"。
- **落地**：把 `capability_map` 的 6 条线同时当作**子集开关**（DSH 侧按 preset/agent 只挂某几条线）。
- **状态**：待设计（与 DSH preset 平面配合，见 `topics/profile-and-gen-integrity.md`）

---

## P2 · 可选（等上面落地后再说）

| # | 项 | 出处 | 说明 |
|---|---|---|---|
| 11 | 健康检查 + 指标（`state/coverage/indexed_at` 一等口径） | Serena（healthz/Prometheus） | 已写进 `ast-io-entry.md` §6，落到 `getIndexStats` 的对外形态 |
| 12 | 一键注册到各客户端（`setup <client>`） | Serena `serena setup` | 我们已有 `install_mcp.mjs` / `.trae/mcp.json`，可扩成多客户端 |
| 13 | 多核并行建索引 | ast-grep（ignore 多线程） | 我们已用 `ignore` 走查；`syncFile` 串行 → 可并行化（大仓冷启提速） |

---

## 我们已有、而同类普遍弱的（守住，别抄丢了）

| 能力 | 同类现状 |
|---|---|
| **零前置冷启**（刚做完） | Serena 要 activate/index；ast-grep 要写规则；Moderne 要接平台 |
| **dry_run 结构化 diff + 原子落盘 + 冻结行保护** | 多数只有"改完看 diff" |
| **跨仓杂交 / Go→TS 跨语言翻译** | 基本没人做（Moderne/Grit 限语言生态） |
| **能力线导航 + 工具面收敛** | Serena 41+ 工具靠 profile 硬裁；其它更粗 |
| **索引跨会话持久（SQLite）+ 多 agent 共享** | Serena 靠 LSP 热进程（会话级）；aider 每次重建 |

---

## 建议的采纳顺序（给用户拍板）

1. **P0-b 补齐零前置**（8 处残余文案）—— 把刚做完的 N1 变成系统属性，半天级。
2. **P0-1 智能报错** + **P0-5 快照回滚** —— 两个小改动，directly 降 agent 失败率。
3. **P0-4 模糊编辑级联** —— 先核查 `edit_code` 现状，缺就补。
4. **P1-7 修复→规则沉淀** —— 最差异化，也最贴"自进化"主线。
5. **P1-6 RepoMap 排序** / **P1-9 lossless 契约** —— 结构性收益。
6. P0-2（描述瘦身）**与缓存策略同批**做，别单独动前缀。

> 取舍原则（对齐本项目既有铁律）：**先做"降失败率"的，再做"降 token"的，最后做"降人力"的**。
