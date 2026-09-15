# 可抄清单：同类比我们做得好的地方（采纳台账）

> 来源：`agent-code-io-landscape.md` 的四层格局调研。用户指示（2026-09-14）：
> 「既然有这么多同类产品，我们也可以**抄一抄他们有哪些比我们做得更好的地方**」。
> 本文是**采纳台账**：每条 = 出处 / 他们怎么做 / 我们怎么落地（不照搬）/ 落到哪个文件 / 状态。

---

## 0. 先说已经做完的那条（不是抄，是我们自己的缺口）

| 项 | 说明 | 状态 |
|---|---|---|
| **P0 冷启 bootstrap（N1 零前置）** | 空库不再甩"请先 import_project"，而是**就地静默建索引**（有界 2000 文件 + 诚实 `state/truncated`） | ✅ **已实现并端到端验证**（`index_freshness.ts` / `semantic_search.ts`；探针 `scripts/probe-dc-zero-setup-mcp.mjs` 6 项断言 PASS） |
| **P0-b 零前置化（统一入口 + 已接线路径）** | 新增 **`ensureProjectIndex(root)`** 作为全仓"我要一个已就绪索引"的单一入口；已接线：`semantic_search`、`explore_code(action=diff_impact)`、`diagnose`（`runDiagnosis` 内）、`extract_contracts`、`harvest_closure`、**`find_references`（缺索引→自建→重试一次，不再直接拒绝）**；并改写 7 处"请先 import_project"文案 | ✅ **已完成（本轮）** |

**P0-b 顺带收益（可测）**：`tests/tools/find_references.test.ts` 由 **7 红 → 3 红** ——
修好的 4 项正是"没建索引就 ok:false"那几类；剩下 3 项是**既有的跨语言闭包缺口**
（Go/Java/Python 的 cross-call 未覆盖，仓内 `tool-convergence.md` §5.6 已记录在案），与本轮无关。

**P0-b 残余（同步内核，需在其异步边界接 bootstrap / 或本就非 agent 路径）**：

| 位置 | 情况 |
|---|---|
| `tools/analyze_monolith.ts:571,593` | 同步内核；调用方 `import_project` / `derive_feature_tree` 均自带 db，非 agent 主路径 |
| `tools/language_concepts.ts:267,293` | 同步内核；调用方是 `serve.ts` HTTP 端点（非 agent 路径） |
| `tools/query_feature.ts:662` | 走 `cache_db` 参数（DSH 侧显式传库），语义特殊 |
| `tools/function_outline.ts:207` | 走 **feature 级**缓存（`import_cache_*.db`），不是项目索引 → 需"用项目索引替代 feature 缓存"的更大改动 |
| `tools/diff_views.ts:625,628` | 属"设计视图/代码快照不存在"，是**领域前置**（要先有设计），不是索引前置 ⇒ **不该动** |
| `derive_mind_map` / `detect_drift` / `sync_contracts` 的 "feature 不存在，请先 import_project" | 同上，属领域前置（先有 feature/DSL），不该动 |


---

## P0 · 立刻可做（小改动、体验直接受益）

### 1. 智能报错：拼错的参数名给 "Did you mean?"
- **出处**：Serena（"Smart Errors"：对参数名/枚举值做 Levenshtein，给候选）。
- **他们**：错参数不是干巴巴报错，而是"did you mean `project_dir`?"。
- **我们**：工具报错基本是中文长句、无候选建议；agent 只能重试猜。
- **落地**：新增 `src/tools/arg_suggest.ts`（自带 Levenshtein、归一化后 `projectDir ≈ project_dir`、
  阈值自适应 + "够像才提示"的静默纪律）+ 在 `registerAllTools` 统一注入到响应尾部。
- **★ 关键实现细节（踩过）**：**只加提示代码是没用的** —— SDK 会把 raw shape 包成**严格 object**，
  zod 解析时**静默丢弃未知键**，纠错代码永远看不到错键（实测：提示不出现）。
  ⇒ 必须把 inputSchema 改成 **loose object**（zod4 `z.looseObject` / zod3 `.passthrough()`），
  未知键才会活到 handler。
- **验证**：`tests/tools/arg_suggest.test.ts` 12 项；真 MCP 探针 `scripts/probe-dc-arg-suggest-mcp.mjs`
  **4 项断言 PASS** —— 传 `lanes`（应为 `lane`）时输出：
  `⚠ 未知参数 \`lanes\` —— 是否想传 \`lane\`？（本工具参数：lane）`；参数正确时不误报；不像的键静默。
- **状态**：✅ **已完成**

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
- **我们**：核查结论（2026-09-15）——`replace/delete` 走 AST 符号定位、`range` 显式行号，都天然不模糊；
  只有 `replace_text` 是 exact-only（`replace_text` 死代码疑虑 09-14 已排除：op 枚举已修，一致性测试在）。
- **落地**：新模块 `src/tools/fuzzy_match.ts`（四级定位 + `realignNewTextTo` 缩进重排），
  `edit_code` replace_text 接入：**L1 逐字 → L2 空白归一**（保留行首缩进、去行内空白，宽容 CRLF/行尾空格）
  **→ L3 缩进弹性**（去缩进键 + 忽略空行；命中后 new_text 按实际首行缩进重排）
  **→ L4 省略号占位**（`...`/`…` 行=省略任意行，其余段按 L3 键顺序锚定，MAX_COMBOS=64 防爆）。
  纪律：**歧义即停**（任一级命中 >1 处 ⇒ 报错列出级别+行号，绝不降级硬找唯一）+ **唯一才动**；
  **诚实回执**：级别进消息（`L2·空白归一` 等），L≥2 加 `⚠ 模糊命中` 注记，diff 的 "-" 侧用**实际被替换的文件片段**
  （`matchedText`）而非模型写的 old_text；语法门/快照/dry_run/索引重建等安全网不因模糊而放松。
- **验证**：`tests/tools/edit_code_fuzzy.test.ts` 7 项（四级各一 + dry_run 真片段 + 歧义列行号 + 四级未命中报错）；
  既有 `edit_code.test.ts` 27 项全过（宽松断言不受消息变化影响）；tsc 零错误。
- **状态**：✅ **已完成**（2026-09-15）

### 5. git 快照 + 一键回滚
- **出处**：aider（每轮自动 commit，`/undo` 回退）。
- **我们**：有 dry_run + 原子落盘 + 失败回滚，但**没有"可回退的历史"**（跨调用无法撤销）。
- **落地**：新增 `src/tools/file_snapshot.ts`（**影子副本**，不用 git —— 项目未必是 git 仓，
  且替用户 commit/stash 会污染他的工作区；只存被改动的那几个文件，KB 级、与 git 解耦）；
  存储 `.design-canvas/code-snapshots/<id>/{meta.json,files/<rel>}`，默认保留 20 份。
  新工具 **`list_snapshots` / `rollback_snapshot`**（省略 = 最近一份；`file` 可只回滚一个文件）；
  回滚语义含"**快照时不存在 → 删除**"（即撤销"这次新建的文件"）。
  **接线（落盘前自动快照）**：`edit_code`、`rename_files`（清单取自 dry_run 的 references）、
  `move_symbol`（用它自己算好的 `affectedFiles` 源+目标+各 importer）。
  ⚠️ **命名避让**：仓内**已有** `src/tools/snapshot.ts`，那是 **DSL feature 快照**（设计状态），
  与本模块**同名不同职** → 本模块叫 `file_snapshot.ts`、目录也用 `code-snapshots/` 分开。
- **验证**：`tests/tools/file_snapshot.test.ts` 8 项（含"edit_code 落盘前自动快照 → 回滚复原"端到端）；
  真 MCP 探针 `scripts/probe-dc-snapshot-mcp.mjs` **5 项断言 PASS**
  （落盘后快照在 / 文件已改 / 回滚复原 / 回滚后仍可查）。
- **状态**：✅ **已完成**（`rename_symbols` 暂未接线：其影响文件集在内部 dry-run 才算出来，留作后续）

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
- **触类旁通（2026-09-15，实读 getgrit/gritql README + docs.grit.io + stdlib 真身）**：
  - **他们的形态**：模式 = 反引号代码片段 + `$元变量` + `=>` 改写 + `where` 侧条件（`not within \`try { $_ }\`` 等）；
    规则文件 = **`.md`**（frontmatter: title/tags + 一句描述 + 单个 ```grit 块 + 若干 `##` 测试段，
    每段 = 成对的 before/after 裸代码块——**测试即文档**，stdlib 的 openai.md 有 14 段）；
    配置 `.grit/grit.yaml`（启用哪些规则 + `level: error/warn`）⇒ `grit apply`（改写）/ `grit check`（当 lint）双模式；
    stdlib 200+ 共享模式；引擎 = Rust marzano（tree-sitter，10M 行级）。
  - **★ CI 棘轮（他们最聪明的一点）**：check 只在「相对 default 分支上一提交**新增**的命中」上 fail
    ⇒ 可以先启用当前就失败的规则而不炸 CI，增量修复防回归。
    ⇒ 我们不用 GitHub App：check 结果的存量命中清单存 `.design-canvas/rules/baseline.json` 实现同语义。
  - **todo() 半修语义**：改不动处不失败，插入 `# TODO: 原因` 注释（甚至注释掉原代码）
    ⇒ 规则应用三态：改了 / 标记了 todo / 没命中——比"要么全改要么不动"更贴真实迁移。
  - **他们的缺口 = 我们的差异化**：① stdlib 测试段**全是正向、零反例**（规则手写+人审所以敢省）；
    我们的规则是 LLM 现场长的 ⇒ **反例夹具（阴性对照）是我们必须自加的可靠性层**。
    ② Grit **没有"从一次修复自动萃取规则"的机制**（专家手写 pattern）⇒ 萃取动作正是本条的立身之本。
  - **采纳四项**：md 载体（frontmatter+模式+夹具同居一个文件）／`$hole` 元变量（AST 子树通配 + 模板回填）／
    棘轮 baseline／todo 半修。**坚持两项**：反例夹具、萃取动作。
  - **v1 收敛**：完整 GritQL（bubble/or 组合/regex 绑定/join 累积）**不做**；匹配层复用 P0-4 模糊级联
    （片段锚定 exact→空白归一→缩进弹性）+ kernel AST 覆盖判断实现 `$hole`；规则随仓走（`.design-canvas/rules/`），
    md 自包含可整文件复制到其他仓复用（跨仓共享层留给能力库）。
- **状态**：待设计 → 设计已校准（2026-09-15，待实现）

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
3. **P0-4 模糊编辑级联** —— ✅ 已完成（2026-09-15，见 §4）。
4. **P1-7 修复→规则沉淀** —— 最差异化，也最贴"自进化"主线。
5. **P1-6 RepoMap 排序** / **P1-9 lossless 契约** —— 结构性收益。
6. P0-2（描述瘦身）**与缓存策略同批**做，别单独动前缀。

> 取舍原则（对齐本项目既有铁律）：**先做"降失败率"的，再做"降 token"的，最后做"降人力"的**。
