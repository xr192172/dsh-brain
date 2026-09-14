# 同类项目调研：agent 的代码读写/重构层长什么样

> 2026-09-14 起，用户提问：「你搜出这么多同类的 AI 重构工具，**他们是怎么做的？**」
> 本文只回答这个问题 + 由此得出的**定位与命名启示**。设计侧见 `ast-io-entry.md`。
> 星标/许可证数据来自 GitHub API 实测（2026-09-14）。

---

## 1. 四层格局（按"做法"分，不按公司分）

### 第 1 层 · 确定性改写引擎（把代码结构模式做成规则）
| 项目 | 星标 | 做法 |
|---|---|---|
| **ast-grep** | **★15.9k** MIT | tree-sitter AST 模式匹配 + YAML 规则；CLI/库双形态；强调多核并行 |
| **Rector** | ★10.4k MIT | PHP 专用；预置"升级/现代化"规则集，静态分析找目标后改写 |
| **GritQL**（biomejs） | ★4.6k MIT | 自研 DSL（近 SQL/函数式）做 AST 查询与改写；clause 逻辑 + 变量作用域 |
| **OpenRewrite** | ★3.7k Apache-2.0 | **LST（Lossless Semantic Tree）**：类型感知、保留空白格式的语义树；recipe 用 YAML/Java 声明 |
| **Comby** | ★2.7k Apache-2.0 | 语言无关的结构模板（`:[mv]`），不依赖语言解析器 → 更通用但结构表达力弱 |
| Semgrep | — | 偏安全；等价性匹配/dep-semgrep；**不能当库用**（ast-grep 官方对比里点的） |

**共同做法**：把「结构模式」抽成可复现的规则资产 → 批量匹配改写。
**共同短板**：**规则要人写**；对"就改这一个符号/这一次"的交互式精修不友好（ast-grep 自己承认只有语法层、无类型/数据流）。

### 第 2 层 · 语义索引与符号接口（给 agent 的"眼睛"，最像我们）
| 项目 | 星标 | 做法 |
|---|---|---|
| **Serena**（oraios） | **★29.3k** MIT | **LSP 后端 + MCP**，41+ 工具；持久 daemon 让 language server 保持热；**RepoMap**（tree-sitter tag 抽取 + PageRank 排序）；per-client profile 裁剪工具集；内置记忆/指标/健康检查 |
| aider | ★48.9k Apache-2.0 | 终端 AI 结对；**repo map** 做上下文选择（不是编辑引擎） |
| SCIP / Kythe / Glean | 大厂内部开源 | 精确代码索引（定义·引用·跨仓），**只做索引，不做编辑** |

**Serena 的关键做法（逐条对我们有用）**：
- **符号级而非行号级**：`replace_symbol_body` / `insert_after_symbol` / `find_referencing_symbols`，明确对标"line-number replacements + grep"。
- **编辑前查引用、编辑后跑诊断**（reference checking before delete / post-edit diagnostics）。
- **工具面按客户端裁剪**（profiles：claude-code / codex / ide-assistant / ci-bot / full）—— 因为 **41+ 工具本身也是噪音**。
- ⚠️ **它需要"准备动作"**：README 明写需要 **project activation**（"Serena needs project activation before it can resolve symbols"），大项目建议先 `serena project index` 建缓存 → **这正是我们 N1（零前置静默建索引）可以拉开差距的地方**。
- ⚠️ **依赖 LSP**：要装各语言 language server（Java 启动慢、macOS 有问题）→ 我们用 **tree-sitter（零额外安装）+ 持久 SQLite 索引（跨会话复用）**，路线不同。

### 第 3 层 · LLM 落地层（只保证"把编辑无损落盘"）
- Morph / Relace 之类 "fast apply"：把模型的意图**无损**写进文件；Cursor 的 apply 同理。
- **共同短板**：不理解结构 → 事故率高。行业数据（Harness 2025）：**63% 团队上 AI 后发布更快，但 72% 至少出过一次由 AI 生成编辑引致的事故**。

### 第 4 层 · 平台/舰队层（规模化 + 治理）
| 项目 | 做法 |
|---|---|
| **Moderne** | 在 OpenRewrite 上做**万级仓库**确定性改造；**"determinism is the guarantee"**；10k+ 预置 recipe。★ 值得注意：它现在的自我定位已改成 **"the Agent Tools company providing the code intelligence, discovery, and deterministic automation coding agents need"** —— **连平台玩家都在转向"给 agent 供工具"** |
| **Grit**（平台） | GritQL + LLM 生成 codemod → **可复现的 PR、无 prompt drift** |
| Codemod（开源） | jscodeshift 传统的继承者；**底层用 ast-grep**；迁移注册表 + 活动看板 |
| Morph / Modelcode | spec 驱动迁移：人审 Project Spec → 里程碑 PR → **新旧程序行为对拍（functional tests）** |
| AWS Transform / IBM Bob / Copilot App Modernization / vFunction / Mechanical Orchard | 企业遗留系统现代化；agent 执行 + 人审检查点 |

---

## 2. 他们"怎么做的" —— 五条共识，两条共识里的裂缝

**共识 1：符号/结构级接口，而不是行号与正则。**
Serena 的对比表把这条写死了：「line-number replacements + regex」vs「replace symbol body + rename across files」。

**共识 2：确定性引擎 + 概率性 LLM 的混合架构。**
LLM 负责"想改什么"、生成规则/意图；AST/LST 引擎负责"怎么精确改"；**验证闸**（编译 + 测试 + 行为对拍）负责"改对了没"。Moderne 的卖点是确定性，Grit 的卖点是"无 prompt drift"，Morph 的卖点是"新旧行为对拍"。

**共识 3：可审计、可回滚是商业价值的来源，不是附加项。**
因为 72% 的事故率，企业只为"能证明改对了"付钱。

**共识 4：上下文要做排序与裁剪。**
Serena 的 RepoMap 用 tree-sitter tag + PageRank 打分；aider 用 repo map。**没有人把整个仓库塞进上下文**。

**共识 5：工具数量必须被治理。**
Serena 41+ 工具 → 用 profile 按客户端裁剪；我们 60 个 → 用 capability_map 导航 + 三入口收敛。**同一问题的两种解法。**

**裂缝 1：他们都要求"准备动作"。**
Serena 要 activate / index；ast-grep 要写规则；Moderne 要接平台。**没有一家做到"遇到项目就静默建好，agent 零前置"** —— 这就是 N1 的空白区。

**裂缝 2：没有一家是"对所有 agent 默认可用"的底座。**
它们要么绑 IDE（Cursor/Copilot），要么绑 CLI（ast-grep/Comby），要么绑平台账号（Moderne/Grit），要么绑客户端（Serena 要逐个 `serena setup <client>`）。**"模型无感、宿主默认接上"仍是空白。**

---

## 3. 由此得出的定位（我们的差异点）

| 维度 | 主流做法 | 我们的选择 |
|---|---|---|
| 解析底座 | LSP（要装 language server）或 tree-sitter | **tree-sitter + 150+ 语言注册表**（零额外安装） |
| 索引 | 有的按需建、有的不持久 | **持久 SQLite 索引**（跨会话/跨 agent 共享，可离线筛） |
| 前置 | activate / index / 写规则 | **零前置：静默 bootstrap**（N1，本次改造的核心） |
| 工具面 | 41+ / 60 个平铺 | **capability_map 导航 + 三入口收敛**（read/filter/edit） |
| 接入 | 逐个客户端 setup | **宿主 MCP 默认挂载，模型无感**（N3） |
| 编辑纪律 | 各行其是 | **dry_run 结构化 diff + 原子落盘 + 自校验 + 回滚 + 冻结行保护**（已在 `tool-convergence.md` §5.7 落地） |

一句话：**别人做"更好的工具"，我们要做"agent 默认长在身上的手眼"。**

---

## 4. 命名启示（三条，全部有实例支撑）

1. **同类的名字几乎都走"短、直白、功能向"**：ast-grep / Comby / OpenRewrite / GritQL / Rector / Semgrep / Codemod —— **没有一个是意象词**。意象词确实都被占光了（见 `rename-design-canvas.md` §2 事实 A）。
2. **但"意象美名"并非不可行 —— 前提是没人占**：**Serena ★29.3k**，名字本意只是希腊语"美丽/宁静"（作者德国两人团队），**跟代码毫无关系**，照样成了这个赛道最成功的项目。
   ⇒ 反过来说：**你最初担心的"零相关的名字不好"在业界并不成立**；真正的硬指标是 **唯一 + 好念 + 好记**。
   真正的问题是「**你想要的那些好词已经被人占了**」，而不是"意象词这条路线不行"。
3. **忌用会与既有语义撞车的角色名**：`proxy`（网络代理）、`gateway`（网关）、`agent`（本项目的 agent 概念）、`steward/butler`（都被占且偏"服务人的角色"）—— 而这个东西**不是一个人格，是被 agent 调用的能力层**。可参考 `agentio` 这种"说清给谁用 + 干什么"的直白命名。

---

## 5. 可借鉴清单（按性价比排序）

1. **profile/裁剪**：按客户端给不同工具子集（Serena 的做法）→ 我们可让 `capability_map` 的线既是导航也是"子集开关"。
2. **RepoMap 式排序**（tree-sitter tag + PageRank）：把"最相关的符号"按 token 预算喂给模型，而不是整文件。
3. **编辑前后闸门**：edit 前查引用、edit 后跑诊断（我们已有 dry_run + 自校验，可再补"post-edit diagnostics"）。
4. **项目级记忆/约定**（Serena memories + project config）：与 `per-subagent-memory.md` 的记忆库设计天然对齐。
5. **可观测性**：健康检查 + 指标（Serena 有 Prometheus/healthz）→ 我们的索引也该有 `state/coverage/indexed_at` 的一等口径（已写进 `ast-io-entry.md` §6）。

## 6. 明确不做的

- ❌ 不做"规则库"路线（写 recipe 是另一条价值链，Moderne/Grit 已经很强；我们的优势在"零前置 + agent 默认"）。
- ❌ 不做企业舰队治理（多仓批量改 + 合规审计）—— 那是平台层的事。
- ❌ 不依赖 LSP（引入"装语言服务"这一前置，与 N1 冲突）。
