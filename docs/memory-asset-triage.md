# ai-base 记忆系统资产处置表 —— 多 sub agent 架构下哪些还该留

> 日期：2026-09-14 ｜ 状态：设计（待拍板）｜ 关联：`per-subagent-memory.md`、`capability-registry-evolution.md`
> 盘点对象：`ai-base/agent-shell/internal/memory/` —— **33 个非测试模块，457 KB**（Go 实现，仓库半废弃）

---

## 0. 结论速览

| 问题 | 回答 |
|---|---|
| 那些"乱七八糟的"该保留吗？ | **大部分要留，而且有一件被严重低估**（见 §2） |
| 技能树还有必要吗？ | **有，但它不是"候选池"，它就是能力库**。新架构要补的不是"设计能力库"，而是**给技能换执行器** |
| 你的判断 | **方向对，但结论偏保守**：不是"只拿来读取当开发方向"，而是**整体移植 + 换掉最后一层**（注入 → 委派） |
| 最有价值的发现 | `SkillNode` 已含 **`Script`/`Tools`/`Extends`/`Requires`/`Absorb`/`Exclusive`/`Score`/`SuccessRate`/`AbsorbedBy`** —— 一个能力库需要的**全部字段都在** |
| 结构性推论 | ★ 睡眠机制需要**常驻宿主**，而 gen 会换代 ⇒ **记忆库必须是独立进程**（印证上一轮的倾向） |
| **要不要改成 TS？** | **不要**——但理由不是"翻译不好"（§7.0 已订正：`translate_go_ts` **是** tree-sitter AST 底座，质量有保障）。真理由是**不需要**：记忆库必须是独立进程 ⇒ 无"必须同语言"约束 ⇒ **Go 保留 + MCP 面**（ai-base 本就是 Hub↔Brain 走 REST 的架构） |
| ⚠️ 一个已发生的事故 | `elv/dsh-hub` 搬运**绕过了自己做的 AST 工具**，改用 LLM 逐文件翻 → `void` 译成 `vID`、丢首字符 → 35 个正则脚本（144 KB）回补。**工具对，使用错**（§7.3、§7.7） |
| 技能声明工具 | ✅ 你选对了（工具共享 ⇒ 一次改进对所有能力生效），但它引入**反向依赖**，需四条配套（§8.1） |
| 建议池 | ✅ 它是科研目标的**第三个来源（内生）**，两条硬约束见 §8.2 |

---

## 1. 全模块清单（33 个，457 KB）

### A. 存储与图（骨架）
| 模块 | KB | 定位（自述） |
|---|---|---|
| `sqlite_store.go` | 47 | `SQLiteVecStore`：单文件 `memory.db`（WAL 三脑共享），`nodes`/`skills`/`vec_*`/`embedding_cache`/`meta`；**dirty 惰性同步** |
| `graph_cache.go` | 14 | 内存图缓存，"the single source of truth for in-memory graph state"；读写分离 |
| `graph_writer.go` | 12 | **单 goroutine 独占写路径**（MergeRequest channel）；`tmp→rename` 原子写 + `.corrupted` 恢复 |
| `memory_store.go` | 3 | 存储辅助 |
| `embedder.go` / `remote_embedder.go` | 1 + 9 | Embedder 接口 + OpenAI 兼容实现；**cache key = `sha256(model\0text)`** |
| `index_text.go` | 3 | 索引文本构建（保证 embedding 输入与历史语义一致） |

### B. 检索管线
| 模块 | KB | 定位 |
|---|---|---|
| `retriever.go` + `retriever_DeepRetriever.go` + `retriever_ShallowRetriever.go` | 21+9+3 | 深/浅两档检索器 |
| `retrieval_pipeline.go` | 12 | 管线编排 |
| `rrf.go` | 1 | **Reciprocal Rank Fusion**（多源融合，纯算法零依赖） |
| `reranker.go` / `query_rewriter.go` | 2 + 2 | 重排 / 查询改写 |
| `heat.go` | 15 | `HeatStore`（热度条目）+ 三层记忆的门面（浅/热/深，**确切切分未逐字确认**） |
| `shallow_writer.go` | 4 | `WriteShallowState` —— **用 `os/exec` 抓实时状态**写进浅层 |

### C. 知识 / 技能层
| 模块 | KB | 定位 |
|---|---|---|
| **`skill_tree.go`** | **36** | ★ **统一技能树**：`SkillNode`（见 §2）、生命周期（active/demoted/archived/**absorbed**）、**跨路径吸收 `Absorb`**、继承/组合、**Active Skill Injection** |
| **`skill_import.go`** | **19** | Path B `SkillRegistry`：扫描 **Claude Code / Cursor 兼容的 `.md` + YAML frontmatter**，算 `sha256` 检测上游变更后导入；`Match/Get/List` 委托 SkillTree |
| `knowledge.go` | 20 | `KnowledgeBase` + `KnowledgeEntry`（**"知识 = 论文"**：Claim/Scope/Transferability/Limitations/SourceNodes/Verified/JournalTier/Experiment） |
| `meta_skill.go` | 8 | **MetaSkill（SkillOpt 机制 4）**："优化器自身的经验"——哪些修改被接受/拒绝、哪些 trigger 更有效；持久化 `meta_skill.json` |
| `tool_feedback.go` | 3 | 工具失败反馈（append-only JSONL：`{tool,pattern,env,fix}`） |
| `explorer.go` | 5 | per-session 多跳探索状态 |

### D. 睡眠（离线巩固发动机）
| 模块 | KB | 定位 |
|---|---|---|
| `sleep.go` | **60** | `NremReplay` Phase 1（差异化 Hebbian）；Depends: **HeatStore, SkillTree, ExplorationState** |
| `sleep_rem.go` | 14 | Phase 2 **REM 跨社区关联**（论文推论文）：`related_to/depends_on/contradicts/supersedes` |
| `sleep_prune.go` | 7 | Phase 3 **突触稳态剪枝**（纯算法无 LLM）：isolated/leaf→删/归档，**bridge/hub/anchor→保护** |
| `sleep_experiment.go` | 12 | **实验复现执行器**：审稿分身真跑 `command` 比对 `expect`（5 层安全边界含 Job Object） |
| `sleep_scheduler.go` | 18 | 调度：**同时最多 1 个、FIFO 容量 3、checkpoint 断点续跑** |
| `sleep_wander.go` | 11 | `DreamWalker`：向量空间贪婪游荡生成 `DreamPath`（新颖性来源） |
| `sleep_config.go` | 13 | 用户可配置调度（空闲检测/时间段）+ REST API |
| `gravity_field.go` | 7 | **引力场**：三阶段共享的确定性评分层（**无 LLM、无 IO、无新持久字段**） |
| `gate.go` | 6 | 门 |

### E. 装配
| 模块 | KB | 定位 |
|---|---|---|
| `builder.go` | **57** | `MemoryBuilder` 总装配 + `RecordMemory`/`SearchDiverse`/`RunREM` 等门面 |
| `vector_store.go` | 1 | `VectorStore` 接口 |

---

## 2. ★ 核心发现：`SkillNode` 就是能力库的字段表

`skill_tree.go:21` 的结构（逐字摘）：

```go
type SkillNode struct {
    ID, Type, Parent, Source, Brain string   // Source: "learned" | "user" | "community"
    Status      string   // "active" | "demoted" | "archived" | "absorbed"
    Score       float64
    UseCount    int
    SuccessRate float64
    Principle   string   // 原理
    Fix         string   // 修法
    Triggers    []string // 触发词

    // Path B（导入）
    SourceFile, SourceHash, ImportedAt, ImportVersion

    // Direction 4: 能力泛化 —— composable + inheritable
    Script            string   // ← 可执行体
    ScriptLang        string
    Archive           string
    SendInputRequired string
    Extends           string   // 继承父技能（body 追加 / triggers 合并 / script 继承）
    Requires          []string // 组合依赖（激活时一并拉入）

    // Evolution tracking
    EditHistory      []EditRecord  // {Epoch, Op, Delta, Accepted}
    MergedFrom       []string
    AbsorbedBy       string        // 被哪个节点吸收
    RejectedAttempts int
    LastValidated    string
    ValidationScore  float64

    // ch22 §6: Skill-as-Capability —— 工具声明。
    // 从 frontmatter tools: 解析，SkillToolRegistrar 读取并注册到 ToolRegistry。
    Tools []external.ToolDef

    // 用户显式要求独立，阻止跨路径吸收
    Exclusive bool
}
```

**对照新架构要的"能力库"**：

| 能力库需要的 | `SkillNode` 已有 | 对应 `SubagentProvider` |
|---|---|---|
| 注册元数据 | ✅ `ID/Source/Brain` | provider **注册名（全局唯一）** |
| **何时被选中**（路由） | ✅ `Triggers` + `GetActiveSkills(taskHint)` | 委派工具的 description / 决策层路由 |
| 需要什么权限/工具 | ✅ `Tools []ToolDef` | `toolFilter{allow,deny}` |
| **可执行体** | ✅ `Script`/`ScriptLang`/`Archive` | provider 的实现（进程内/进程外） |
| 组合与继承 | ✅ `Requires`/`Extends` | 子代理嵌套（`maxDepth`） |
| 健康度 | ✅ `Score`/`UseCount`/`SuccessRate`/`ValidationScore` | 注册门判据的输入 |
| 生命周期 | ✅ `active/demoted/archived/absorbed` | 注册/升级/**淘汰** |
| **合并** | ✅ **`Absorb` + `AbsorbedBy`/`MergedFrom`** | 你说的"一个能力能干两件事就合并" |
| 谱系 | ✅ `MergedFrom`/`AbsorbedBy`/`EditHistory` | `lineage`（我上轮说要补的） |
| 保护位 | ✅ `Exclusive` | 人工钉住的能力 |

**⇒ 所以"能力库"不需要设计。`SkillTree` 已经是了。**

它**唯一缺**的一层是执行：现在技能是**注入主脑上下文**执行（`Active Skill Injection` ch09 §6 —
`GetActiveSkills` 按 `score>0.7 ∧ use_count>10` / trigger 匹配选出来塞进 prompt），
而新架构要的是**委派给独立 sub agent 执行**。

> **迁移工作量因此大幅下降**：`skill_tree.go`(36KB) + `skill_import.go`(19KB) 的
> **数据模型与生命周期逻辑整体可用**，只需替换"注入"那一段为"spawn provider"。
>
> 这也解释了你为什么会觉得"技能树可以当开发方向"——你的直觉抓到了它**产出的东西**（可执行能力），
> 但它其实**连容器一起都是现成的**。

---

## 3. 三类处置

### A. 直接移植（是骨架，与架构无关）
`sqlite_store.go` · `graph_cache.go` · `graph_writer.go` · `embedder.go` · `remote_embedder.go` ·
`index_text.go` · `retriever*.go` · `retrieval_pipeline.go` · `rrf.go` · `reranker.go` ·
`query_rewriter.go` · `gravity_field.go` · `gate.go` · `knowledge.go` · `sleep_experiment.go` ·
`sleep_rem.go` · `sleep_prune.go` · `sleep_scheduler.go` · `sleep_config.go` · `heat.go` ·
`tool_feedback.go` · `meta_skill.go` · `explorer.go` · `vector_store.go`

**三条特别值得留的**：
- **`graph_writer.go` 的"单 goroutine 独占写 + tmp→rename 原子写 + .corrupted 恢复"** ——
  与我们 **I1 写权唯一**同构，是现成的实现。
- **`gravity_field.go`** —— "**无 LLM、无 IO、无新持久字段**"的确定性评分层，
  是三阶段睡眠共享的地基。这种"纯函数层"最容易移植、最难腐坏。
- **`sleep_prune.go`** —— **遗忘**（你之前漏掉的第四条规则）。而且它已经对 subagent 有差异化策略。

### B. 换执行器（概念与数据模型保留，只替换最外一层）
| 模块 | 改造 |
|---|---|
| **`skill_tree.go`** | 保留 `SkillNode` + 生命周期 + `Absorb`；把 **`Active Skill Injection` 换成 `spawn provider`** |
| **`skill_import.go`** | **导入器保留**（它是外部技能生态的入口，格式就是 Claude Code / Cursor 的 `.md`+frontmatter）；导入后视为**候选能力**而非注入物 |
| `meta_skill.go` | 保留为**元层建议**——按**无环原则**，它只能产生建议，**不能自动应用**（"决定怎么改优化器"的代码不能被优化器自己改） |
| `sleep_wander.go` | 保留（新颖性来源），优先级低 |
| `builder.go`(57KB) | **只参考不移植**：总装配在新架构里由 cordis 插件体系 + `SubagentProvider` 承担 |

### C. 不移植
| 模块 | 理由 |
|---|---|
| `shallow_writer.go` | "跑 `os/exec` 抓状态写浅层" —— 在 DSH 里这是**工具调用**，不该内置成记忆层 |
| `sleep_config.go` 的 REST API | DSH 有 admin 面，不需要自建 REST |
| `builder.go` 的装配部分 | 被插件体系取代（只留门面逻辑作参考） |

---

## 4. 修正你的判断

你说：**"多 skill 的 skill 树其实只能拿来读取，然后当做新的 sub agent 的开发方向吧？"**

**方向对，但结论偏保守。两处修正：**

**① 它不是"候选池"，是"能力库本体"。**
你抓到了它**产出的东西**（可执行能力 + 触发条件 + 脚本），但它连**容器**（生命周期/评分/合并/淘汰/谱系/保护位）都是现成的。
所以不是"读取它来指导开发"，而是"**把它从注入式执行切到委派式执行**"。

**② 但"三分"仍然成立，只是淘汰方式不同。**
技能按内容分三类，去向不同：

| 技能形态 | 判据 | 去向 |
|---|---|---|
| 带 `Script`/`Tools` | 可独立执行、需要自己的工具集/上下文 | **升格为 sub agent**（`provider`） |
| 只有 `Principle`+`Fix`（无脚本） | 是**知识**不是**能力** | **降格为记忆/论文条目**（`KnowledgeEntry`） |
| 纯 prompt 技巧（"遇到 X 就那样说"） | 无独立价值 | **交给现有生命周期自然淘汰** |

第三类**不需要人工退役** —— `Score`/`UseCount`/`AbsorbedBy` + `sleep_prune` 会把它降为 `demoted` → `archived`。
**一个重要判断**：纯 prompt 技巧是**最脆弱的资产**——它们会被模型升级本身淘汰。
（这也是为什么"把技能注入上下文"这条路会越来越没用。）

---

## 5. ★ 结构性推论：记忆库必须是独立进程

`sleep.go` 的依赖是 `HeatStore, SkillTree, ExplorationState, client.Client`，
而 `sleep_scheduler.go` 要求"**同时最多 1 个运行**、checkpoint 断点续跑、会话关闭/手动/定时三种触发"。

**⇒ 睡眠是一个需要"后台常驻 + 独占 + 断点续跑"的长期进程。**

但在我们的架构里：
- **gen 会换代**（今天实测：换代 4.6s，旧代 retire）
- **子代理是一次性的**（`spawn` = fresh child，跑完即销毁）

**结论**：
> **睡眠（以及它整理的对象：技能树 + 知识库 + 图）不能住在 gen 里，也不能住在子代理里。
> 它必须有一个独立的常驻宿主进程。**

这**印证了上一轮的倾向**（`per-subagent-memory.md` §7 选项 2），并且给出更强的理由：
不只是"跨代际不丢"，而是 **"睡眠这个机制本身需要常驻"**。

**顺带的架构收益**：这个常驻进程天然处在"**外部见证**"的位置 ——
发表门的判据持有者（§3 的作者/审稿分身）、谱系毒性召回的执行者，都应该住在它里面。
**判据持有者与被判定者分离，这条在架构上就成立了，不需要靠约定。**

---

## 6. 落地顺序（并入 `per-subagent-memory.md` §8）

| 阶段 | 做什么 | 依赖 |
|---|---|---|
| **P0** | 定"记忆宿主进程"的形态（独立进程 vs DSH 插件） | — |
| **P1** | 移植骨架（存储 + 图 + 检索 + embedding cache） | P0 |
| **P2** | **移植 `SkillNode` + 生命周期**（此时能力库就位，且**不需要新设计**） | P1 |
| **P3** | **给技能换执行器**：`Active Skill Injection` → `spawn provider` 委派 | P2 + preset 层启用委派工具 |
| **P4** | 睡眠三阶段（NREM/REM/Prune）+ 论文系统（`KnowledgeEntry`） | P1 |
| **P5** | 发表门（作者/审稿双循环 + `runExperiment` + `JournalTier`）+ 谱系毒性召回 | P4 |

**关键顺序理由**：**P2 在 P3 之前** —— 先把能力库的**数据模型**接进来（它同时服务"技能"和"sub agent"两种执行器），
再换执行器。这样迁移是**数据先行、执行器可替换**，而不是推倒重来。

---

## 7. 语言与进程边界（含**订正**：我上一轮查错了对象）

### 7.0 ⚠️ 订正（2026-09-14，由用户指出）

**我上一轮写下"design-canvas 没有代码翻译能力"，是错的。**
错误原因：**我只查了 `design-canvas-bridge` 那 8 个「编排壳」工具，没查 kernel 的 58 个 MCP 工具。**

**真相**（用户提供 + 已核实）：

- **`translate_go_ts` 存在**，实现于 `design-canvas/src/translate/`（**15 个模块**），
  且**确实是 tree-sitter AST 底座**：
  - `go_extractor.ts`（22 KB）：注释原文「**tree-sitter 萃取 Go 顶层函数 / 结构体，产出 trans_unit**」，
    「复用仓库共享解析根基 `ts_kernel.parseAstRoot`（**tree-sitter-go**，optionalDependency）」
  - `ts_codegen.ts`（14 KB）：TS 代码生成（含 `mapGoType`）
  - `verify.ts`（6 KB）：语法闸 —— 「每条骨架以 **.ts 重新 tree-sitter 解析**，必须解析出根节点」
  - `package.json` 已装 `tree-sitter` / `-go` / `-typescript` / `-c` / `-c-sharp`
- 设计文档：**`design-canvas/docs/go-ts-translate.md`**（质量极高，见 §7.2）

**⇒ 方法教训（值得记）**：**查一个系统的能力时，要查它真正的注册表，不是它的包装层。**

### 7.1 三个副本与两个通道（拓扑澄清）

| 名称 | 角色 |
|---|---|
| **`D:\project_develop\design-canvas`** | **工具真身** —— 独立 git 仓，v0.1.3（commit `1d19e23`），**TRAE 与 DSH 都拉起的活内核** |
| `dsh-brain/design-canvas-dev` | dsh-brain 内的**开发副本**（`node_modules` 是 junction） |
| `Downloads\…\design-canvas-main` | 给它的 `node_modules` **宿主** |

三者**同版本、同 commit**。

**暴露两通道**：
- **TRAE 侧**：`mcp_design-canvas`，**快照 58 个工具**，会话内直接可调
- **DSH 侧**：`@deepseek-ai/dsh-mcp-client` 以 **stdio 拉起 `server.js`** → 暴露为 `mcp__design-canvas__*`；
  再由 `design-canvas-bridge`（**编排壳**）额外注册那 8 个（`symbol_edit` / `safe_rename` / `move_symbol` /
  `self_evolve` / `design_canvas_prewarm*` / `memory_observe`）

**使用指引**（用户提供）：
- 改名 / 检索前先 **`design_canvas_prewarm`** 上索引
- **翻译走 `translate_go_ts`**（LLM 池已自动接 `http://127.0.0.1:3101` key-pool-proxy，**无需额外 key**）
- **改内核源码要 rebuild + 重启新一代才生效**

### 7.2 工具的真相：它很清醒，问题在"被绕过"

`docs/go-ts-translate.md` 的定位原文：

> 一条**端到端可用**的 Go→TS 半自动翻译链路。分工严格：
> **机器做"可正确机械化的"，LLM 填"语义函数体"，验证闸兜底。**

**默认路径就是 AST 骨架 + 验证闸**（`src/translate/tool.ts`）：

| 参数 | 默认 | 作用 |
|---|---|---|
| （无） | **开** | 机械骨架 + 语法闸（tree-sitter + `hasError`）+ 结构闸（签名/参数/形状） |
| `fill` | `false` | 用 key 池 LLM **逐孔填函数体**（**锁定签名**、`maxRetries` 默认 2 纠错重试） |
| `verify` | `false` | 对已填**纯函数**跑 Go↔TS **行为对拍** |
| `tscVerify` | `false` | 项目模式全工程 tsc 预发射门禁（纯项目应 0 错） |

**且未过闸的单元「不可落盘」。**

**§三 设计原则：正确性边界（为什么这样切）** —— 全文最重的一段：

> - 翻译锚点是 **trans_unit 契约**（锁定骨架 + `bodyHole` + 约束），不是一棵要 round-trip 的公共 AST。
> - **机器做满「可正确机械化的」** 会缩小 LLM 决策面、给出更准的锚点（最契合 LLM）；
> - **别越界硬造**——把语义（并发/error/复合值）伪装成机械产物，
>   会让 LLM 拿着**错误前提**翻译，反而更差。
> - 因此：类型/签名/结构/常量/别名做满；并发/副作用保持 note + LLM + 验证闸兜底。

**§四 为什么「对拍」不扩展到 const 与类型** —— **这一节直接印证我们的判据阶梯**：

> - const 对拍：值是机器自己算出/抄出的，比较是**恒等废话**。
> - 类型对拍：TS/JS 与 Go 的类型都在编译期擦除，**运行时没有"类型的值"，无实体可比**。
> - 对拍只对**可运行**的纯函数有意义（`Add(1,1)→2/2`）。

⇒ 与"**裸满意度评分应被丢弃**（没有成本就没有信息量）"是**同一条原则**：
**验证必须有信息量；恒等废话不算验证。**

**§五 转换约定表**（"机器到底把哪些 Go 写成哪个 TS"的**恒定口径**）：方法 → 独立自由函数
`user_Greet(u: User, …)`；多返回值 → 元组 `[T, Error|null]`；`chan T` → `Channel<T>` + 垫片
（**诚实标注非 Go 阻塞/select 语义**）；`comparable` → `<T>` + note；
决策表 `switch` 的判别式/case 标签**机械 1:1 焊死，LLM 只填各分支动作**。

### 7.3 `vID` / 丢首字符 是谁产生的 —— **不是这个工具**

**AST 路径不可能产生字符级错误**：签名与结构是**机器生成的**，LLM 只填 `bodyHole`（函数体）。

而 `fix_translation_artifacts.cjs` 修的恰恰是**声明层字符错误**：

```js
// Fix vID -> void (translated from Go's void-like return)
nc = nc.replace(/\bvID\b/g, 'void');
// Fix .Method: -> Method: (lost first character)
```

`void` 被译成 `vID`、标记丢首字符 —— 这是**把整个文件交给 LLM 通篇翻译**的典型症状。

**⇒ 结论：那次 `elv/dsh-hub` 的搬运，没有走 `translate_go_ts` 的 AST 骨架路径**，
于是产生字符级错误，只能用 35 个正则脚本（144 KB）回补。

| 证据 | 指向 |
|---|---|
| `fix_*.cjs` 35 个 / 144 KB；`fix_patterns` **1~15 轮**、`fix_errors_v5~v9` | 若走了 AST + 验证闸，**不需要这种修补** |
| `fix_translation_artifacts.cjs` 修 `vID` / 丢首字符 | **声明层**错误 ⇒ 签名不是机器生成的 |
| `_transpile.cjs` 只是 `ts.transpileModule`（TS→JS 编译） | 搬运是**手工/LLM 驱动**，不是工具驱动 |

> **你记的是对的**：你让他用 **AST 底座**开发工具，**工具确实做成了 AST 底座**
> （`go_extractor` 用 `tree-sitter-go`），而且**设计得很清醒**。
> **出问题的是使用环节**——搬运时绕过了自己刚做好的工具。

### 7.4 修正后的结论：**不是"翻译不好"，而是"不需要翻译"**

上一轮我给的理由是"翻译成本高、质量差"—— **这个理由作废**（成本高是因为**没用工具**）。

**结论不变，理由换成**：

```
① 记忆库必须是独立进程（§5：睡眠需常驻）
   ↓
② 既然是独立进程 → 就没有"必须同语言"的约束
   ↓
③ 协议用 MCP（DSH 已有 mcp-client；design-canvas 正是 MCP server，模式已验证）
   → 零新协议设计
```

**将来若真要迁**，正确路径是
`translate_go_ts(projectDir=…, outDir=…, fill=true, tscVerify=true)`
（项目级、跨文件 import、全工程 tsc 门禁），**而不是让 LLM 逐文件翻**。
**但现在不需要迁** —— 见 §7.6。

### 7.5 ai-base 已经是"独立进程 + 协议"架构（不是推测）

| 证据 | 内容 |
|---|---|
| `sleep_config.go` 注释 | 「**Hub 进程**通过 REST API 写入 `sleep_config.json` 后，**Brain 进程**…」 |
| `sleep_config.go:10` | 「REST API `GET/PUT /api/memory/sleep/config` 让前端读写」 |
| `internal/hub/v2/plugins/memory_view/` | **hub 里已经有"通过 REST 读记忆给前端看"的插件** |

**⇒ "记忆通过进程间接口暴露给上层"这件事，ai-base 已经做过一遍了。**

### 7.6 分层的具体划法

| 层 | 语言 | 理由 |
|---|---|---|
| 存储 / 图 / 检索 / 睡眠 / 论文 / 技能树（`sqlite_store`·`graph_*`·`retrieval*`·`rrf`·`gravity_field`·`sleep_*`·`knowledge`·`skill_tree`·`tool_feedback`） | **Go 保留** | ① 纯数据+算法，语言无关 ② **全部 Go test 是资产** ③ 独立进程不需要和 cordis 同进程 ④ `sleep_experiment.go` 的**进程隔离（Windows Job Object）在 Go 侧已实现** —— 沙箱执行天然留在这里 |
| provider 注册 / 工具声明 / 委派 / 注入 / 决策层接入 | **必须 TS** | 要进 cordis 插件体系、要动 tools 段 |
| 两者之间 | **MCP（首选）或 loopback JSON-RPC** | DSH 侧用现成 `mcp-client`；Go 侧加一个面 —— 而**加面的成本已被 `memory_view` 插件证明很低** |

**⇒ 结论：不翻译，零 457 KB 重写成本，Go 测试全部保留，且"独立进程"的推论自然满足。**
唯一新增工作量：**Go 侧一个 MCP/HTTP 面**（接口数量：`search` / `record` / `promote`(发表) / `health`）。

**顺带的架构收益**：Go 记忆宿主天然处在**外部见证**位置 →
发表门的判据持有者（作者/审稿分身）+ 谱系毒性召回执行者都住它里面 ⇒
**"判据持有者与被判定者分离"在架构上自动成立**（§5 已述）。

### 7.7 可推广的教训：**工具的边界声明必须可执行、可验证**

这次事故的形态很清楚：**工具做对了、边界也写明并解释了，但使用环节绕过了它。**

> **"边界文档存在" ≠ "边界被遵守"。**

三条落地做法：
1. **产出带 provenance**：`translate_go_ts` 的产物应能回答"哪些单元走了 AST 骨架、哪些 hole 是 LLM 填的、
   哪些 `verify` 跑过"——现在的 `translation-report` + `unit.id` 已具备雏形。
2. **门禁前置而非事后**：搬运时**强制** `tscVerify=true`，让"绕过骨架"的产物**在门禁处暴露**——
   这正是 `verify.ts` 语法闸/结构闸的用途（未过闸的单元**已经**不可落盘，只是**没人强制跑**）。
3. **把"正则修补"当红灯而非手段**：需要 35 个 `fix_*.cjs` 来修补，本身就说明**上游有环节没按设计走**。
   **修补是症状，不是解法** —— 这与我们"降级要显式标注、不静默"是同一种工程纪律。

---

## 8. 两件你提的东西

### 8.1 「技能声明所需工具」——你选对了，但它引入一个**反向依赖**

**为什么对**：工具是**共享**的 ⇒ 一次工具改进**对所有能力自动生效**。
这正是"工具域自进化"的杠杆点：**进化一个工具 = 同时提升 N 个能力**。

但它把依赖方向翻转了：

```
能力 A ─┐
能力 B ─┼─→ 声明 tool:fs_read        ← 改 fs_read 会同时影响 A/B/C
能力 C ─┘
```

**因此需要四条配套**（前两条是新的设计点）：

1. **改工具前先查影响面**（谁声明了它）—— 这是"能力清单作为契约"的**反向用法**：
   契约不只用来"告诉决策层这个能力要什么"，也用来"告诉工具维护者谁会被波及"。
2. **工具的判据不能由使用者定** —— 否则"好不好用"由使用者说，又变自评。
   工具域要有**自己的** `acceptance` + holdout（任务域能力门）。
3. **契约变更要注入，别让 LLM 试错反推。** 你说"击穿就击穿吧，这很正常"——**我同意**（成本可接受），
   但要加一句：**别让 LLM 从调用失败里发现参数变了**。
   工具 schema 变更时，在**委派提示里附上变更说明**（"`fs_read` v2：参数 X 由 A 改为 B"）——
   **对子代理是零成本的**（§4 已证：fresh child 从零构造提示词，无可复用前缀）。
   让 LLM 试错反推的代价不是钱，是**任务成功率**。
4. **两笔账要分开记**：工具变更导致的击穿（**可控**）vs 长期空闲导致的击穿（**provider 侧 TTL，不可控**，
   已量化：>30 分钟 → 7.04%）。混在一起会误判改动效果。

### 8.2 「建议池」= 科研目标的**第三个来源**（内生）

你这句话把"进化脑=导师/科研人员"的课题来源补齐了：

| 来源 | 谁提 | 进科研队列的条件 |
|---|---|---|
| 人提需求 | 人 | 目标可写成能力用例 |
| 自主找课题 | 脑上网/情报 | 须声明预期指标 + **falsifier** |
| **★ 建议池（内生）** | **系统自身** | **能写成可证伪假设 + 可执行 `acceptance`** |

**建议池条目**（与"修改意见"同构）：

```json
{ "path": "哪个能力/工具/技能", "change": "改什么",
  "expectedGain": "预期提升哪个能力指标", "falsifier": "什么实验能证伪它",
  "evidence": "指向具体失败（tool_feedback 条目 / 元层反思 / 行为信号 / 红队用例）" }
```

**四路来源**（全部已有实现或已设计）：
① `tool_feedback.go`（工具失败）· ② `meta_skill.go`（元层反思）·
③ 行为信号（**高选用率 + 低复用率 = 描述过度承诺**，见 `capability-registry-evolution.md` §5.5）·
④ 红队对抗用例

**两条硬约束**：

1. **`evidence` 必填且可验证** —— 否则建议池就是 **prompt injection 的新入口**
   （外部内容——网上找的课题、工具返回的错误文本——能往池里塞条目）。
   这条和我们"评分必须附具体理由 + 可复现反例，否则丢弃"是**同一条原则**。
2. **它是候选池，不是队列** —— 每条要过"能否写成能力用例"这一关才进科研队列。
   否则网上的"有趣课题"会把系统引向"看起来有意思但不提升任务能力"的方向（**目标漂移**）。

**⇒ 与既有设计的接续点**：`meta_skill.go` 原本是"优化器自身的经验"（SkillOpt 机制 4），
现在它成为建议池的一个来源，且**只产建议、不自动应用** ——
这正好是"R1 需外部共签"的**第一个具体实例**。

---

## 9. 待拍板（本项 6 已由用户拍板）

6. ~~技能的 `Tools []ToolDef` 与 DSH 的 `toolFilter` 如何对齐~~ →
   **✅ 已定：技能只「声明」所需工具，不「自带」工具定义**（用户 2026-09-14 决定）。
   理由：工具共享 ⇒ 工具改进对所有能力自动生效。**配套四条见 §8.1**（新增待落地项：
   影响面查询 + 工具域自有判据 + 契约变更注入 + 两笔账分开记）。
7. **`meta_skill.go`（元层）的定位**：建议它只产建议（进建议池）、**不自动应用**。
   同意的话，它就是我们之前说"R1 需外部共签"的**第一个具体实例**。
   → 用户已同意"建议池"方向（§8.2），本条事实上已定。
8. **新增**：Go 记忆宿主的接口面选 **MCP** 还是 **loopback HTTP+JSON**？
   我倾向 **MCP**（DSH 已有 `mcp-client`，模式已验证，且天然带工具描述）。
