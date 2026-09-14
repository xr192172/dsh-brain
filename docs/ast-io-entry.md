# AST 读写编辑统一入口（code-io）—— 设计规格

> 状态：**设计稿（未实现）** ｜ 提出：2026-09-14（用户口述愿景）｜ 关联：
> `design-canvas/docs/tool-convergence.md` §5.6、`.trae/skills/design-canvas-mind/SKILL.md`、`capability-registry-evolution.md` §3.6.1
>
> 底座代号：本文暂用 **Silva（林）** 代称（名字待拍板，见 §11）。「一个项目 = 一片林；静默解析 = 让它长出来；读写编辑 = 在林间精确定位、修枝、嫁接」。

---

## 1. 用户原话（需求锚点）

> 「design-canvas 成为 agent 的**读写编辑统一入口**，而且**模型无感** ——
> 以后所有的读写编辑都用这个……agent 要自己遇到一个项目就**自发地去解析**，让模型无感。」
>
> 「首先，它最重要的是一个 **AST 解析**。遇到某一个项目，它会首先**默认静默去解析**这个项目，
> 生成一棵 **AST 树**。然后**每一个 agent 都能通过工具直接去调 AST 级别的精确编辑、精准解析、
> 精确筛选所需代码信息**的功能。」

拆成三条不可退让的性质（后面 §4 逐条落设计）：

| # | 性质 | 反面（现状） |
|---|---|---|
| **N1** | **零前置**：遇到项目就静默建索引，没人需要先"准备"什么 | 必须先 `import_project` 才有索引 |
| **N2** | **AST 级精确**：读/筛/改都在语法树上定位，不走 grep/正则 | 部分能力仍靠正则回退、肉眼定位 |
| **N3** | **模型无感**：模型不需要"知道有这套东西"，更不需要被 prompt 教 | 靠 skill/prompt 注入心智，且每条会话重新发现 |

---

## 2. 为什么是现在做：它精准命中了自家工具的**头号障碍**

`design-canvas/docs/tool-convergence.md` §5.6 已由用户自省记录过「为什么真实开发时不主动用这些工具」，
五条障碍里 **#2 是根因，而 N1 直接消掉它**：

| §5.6 障碍 | 本次设计的对应 | 说明 |
|---|---|---|
| **#2 前置状态成本高**（"改个符号前要花好几步准备，成本>收益"） | **N1 零前置** | 索引改为**默认静默建**，前置步骤从 N 步 → 0 步 |
| **#3 粒度太细 + 黑盒**（70 文件改名 = 70 次调用；只回文本、无结构化 diff） | **N2 + 三入口** | 批量 + 结构化 diff + 影响面，一次调用一个语义动作 |
| **#4 输出形态错位**（产出 HTML/JSON 报告，LLM 要的是"代码改好"） | **N2** | 默认返回**结构化编辑结果与 diff**，报告降级为可选 |
| **#1 任务语言不对齐**（想的是"改这个函数名"，工具名是 `rename_symbol`） | **N3 + capability_map** | 靠**工具层默认实现**接住语义词，而非要求模型记住工具名 |
| #5 运行状态依赖（STALE BUILD） | 已有 `stale_check.ts` | 不在本文范围，保持 |

> ⇒ **这不是一个新功能，是把已有内核从"要先装备才可用"改成"进门就在"**。

---

## 3. 现状盘点：内核几乎齐了，缺的是「冷启 + 统一入口 + 沉默」

**★ 这是本次设计最重要的结论 —— 不要重造。**

| 能力 | 现状 | 位置 |
|---|---|---|
| 多语言 AST 解析（150+ 语言注册表） | ✅ 有 | `src/tools/ts_kernel/`（`parseFileFull`：符号/import/调用边/类型引用 四产出） |
| 语言特化 import 解析 | ✅ 有 | `LANG_RESOLVERS`（`.go`/`.py`/… + 通用兜底） |
| **持久化符号索引** | ✅ **有** | `<projectRoot>/.design-canvas/cache.db`（SQLite，SCHEMA_VERSION 8）：`nodes`/`edges`/`files`/`imports`/`symbol_diffs`/`unresolved_refs`/`project_metadata` |
| **增量同步** | ✅ 有 | `src/db/symbols.ts`：`syncFile`（含 `symbolSpanHash` 跨度指纹）/ `syncProject` / `pruneDeletedFiles` / `resolveCrossFileCalls` |
| **懒保鲜（查询前自校验增量重同步）** | ✅ 有 | `src/tools/index_freshness.ts`：`ensureFreshIndex` / `hasChanges`；外部 git pull/手改后查询自动刷新 |
| 精确读 | ✅ 有 | `explore_code`（search/read/diff_impact/arch_layer/…）、`get_dsl` |
| 精确筛 | ✅ 有 | `find_references`（含 `mode=field`/`mode=type`，`src/tools/field_refs.ts`）、`impact_analysis`、`code_health` |
| 精确改 | ✅ 有 | `edit_code`（AST 定位）、`rename_symbols`/`rename_files`/`rename_many`、`move_symbol`、`remove_dead_imports`、`refactor_pipeline` |
| 零参数项目定位 | ✅ 有 | `src/tools/project_root.ts`：`resolveProjectRoot`（git 根→manifest→文件目录）+ `expandClosure` |
| 后台保鲜 | ✅ 有 | `watch_project` + `reconcile`（`changed_files` 透出）+ `detect_drift` 兜底 |
| 能力线导航 | ✅ 有 | `capability_map`（6 线，目录由 `TOOL_DEFS` 派生） |

### ★ 缺口只有一个，但它是致命的

`tests/tools/index_freshness.test.ts` 的用例清单里明确写着：

```
- 空库（从未 import）→ 保鲜不 bootstrap，查询层抛可行动错误
```

**即：`ensureFreshIndex` 只会"保鲜"，不会"冷启"。** 索引必须由 `import_project` 先建立 ——
这正是 §5.6 障碍 #2 的**代码级根因**。用户要的「默认静默去解析」，落点就是这一行语义的翻转。

其余缺口（都是"入口与形态"层，不是内核能力）：

| 缺口 | 说明 |
|---|---|
| **G1 冷启 bootstrap 缺失** | 首次接触项目时要自动建索引（后台、可查进度、诚实标注未完成） |
| **G2 入口分裂** | 读有 `explore_code`、设计读有 `get_dsl`、改散在 5+ 个 rename/edit 工具里；没有"一个语义动作一个调用"的面 |
| **G3 无项目级覆盖度视图** | 没有"这片林建到哪了/多少文件未解析"的统一口径（`getIndexStats` 有，但没人把它当索引体检面） |
| **G4 多 agent 并发口径未定义** | 索引是进程外共享资产（SQLite 文件），谁写谁读、锁与事务语义没写下来 |

---

## 4. 目标态

### 4.1 分层架构

```
┌─────────────── 任意 agent（DSH 前脑 / 子脑 / TRAE / 外部）───────────────┐
│  它们**不需要知道底座存在**：调的是同名的读写编辑工具（工具层默认实现换底） │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ MCP / HTTP / CLI（三出口，同一实现）
┌───────────────────────────────▼──────────────────────────────────────────┐
│ ① 工具面 · 三个语义入口（§5）                                             │
│      code_read（精确读）  code_filter（精确筛）  code_edit（精确改）        │
└───────────────────────────────┬──────────────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────────────┐
│ ② 索引门面 · index_freshness + index_bootstrap（§6）                      │
│      冷启：没有库 → 静默建（后台、可查进度、诚实覆盖度）                    │
│      保鲜：有库 → 增量重同步（已有）；无变更 → 零开销、不惊扰（已有）        │
└───────────────────────────────┬──────────────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────────────┐
│ ③ AST 内核（已有，不动）                                                  │
│      ts_kernel.parseFileFull（AST/符号/import/调用边/类型引用）             │
│      + LANG_RESOLVERS + expandClosure（闭包/邻域/跨语言 import 边）         │
└───────────────────────────────┬──────────────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────────────┐
│ ④ 持久层：<projectRoot>/.design-canvas/cache.db（SQLite，单写多读）        │
│      nodes / edges / files / imports / symbol_diffs / unresolved_refs      │
└──────────────────────────────────────────────────────────────────────────┘
```

**一句话**：③④ 已经有了；本次要做的是 ② 的**冷启**与 ① 的**收敛**，再让 agent 侧**无感接入**。

### 4.2 三条性质怎么落地

| 性质 | 落地手段 | 判据（可测） |
|---|---|---|
| **N1 零前置** | `ensureFreshIndex` 增加冷启分支：无库则**后台异步 bootstrap**，并把"正在建/建到哪"作为**一等返回字段**（`index: {state, files, symbols, coverage, startedAt}`） | 空项目上第一次 `code_read` **不需要任何前置调用**；返回可见进度而非报错 |
| **N2 AST 级精确** | 三入口的**参数即定位**（file+symbol+span），返回**结构化**（`ops[]`/`hits[]`/`locator`），报告类产出降级为 `format=report` 才出 | 编辑返回可重放的结构化 diff；筛选取回带 `pos/len` 与 snippet；**不返回整文件** |
| **N3 模型无感** | **不写 system prompt**（§7）；底座以"同名工具换底层 + 零参数自动发现"接入 | 从零会话直接说"把这个函数改名"就能成功，无需先声明项目/建索引 |

---

## 5. 工具面：收敛为三个语义入口

> 遵循自家《渐进式披露》原则（`tool-convergence.md` §2.0）：**按操作对象聚合，不按实现机制**。
> 三入口对应"读 / 筛 / 改"三个**不可再分的语义动作**，而不是按子系统分。

### 5.1 `code_read` —— 精确读

- **定位即参数**：`{ project_root?, file?, symbol?, span?, depth? }`（`project_root` 可省略 → `resolveProjectRoot` 自动定位）
- **返回**：AST 定位的结构化片段（`{file, symbol, kind, span:{start,end}, src, callers?, callees?}`）
- **归并**：`explore_code` 的 read/search 分支、`get_dsl`(query=node/…) 的代码侧

### 5.2 `code_filter` —— 精确筛

- **筛选维度**（全部走索引，不扫文本）：符号/引用点/影响面/未被引用的导出/复杂度超阈/指定语言/指定目录/契约缺口
- **返回**：命中清单 + 每条 `pos/len` + snippet + 排序依据（可 `limit`/`cursor` 分页）
- **归并**：`find_references`(symbol/field/type)、`impact_analysis`、`code_health`、`search_bricks` 的符号侧

### 5.3 `code_edit` —— 精确改

- **动作**：`rename` / `move` / `edit_body` / `remove_dead_imports` / `apply_patch`（AST 定位的批量 ops）
- **硬纪律（继承现状）**：全部先 `dry_run` 出结构化 diff → 任一条被阻断则**整体不落盘**（原子）→ 落盘后自校验 → 失败回滚
- **返回**：`{ applied, ops[{pos,len,old,new}], files[], verification }`（可直接喂给下一步/人复核）
- **归并**：`edit_code`、`rename_symbols`/`rename_files`/`rename_many`、`move_symbol`、`refactor_pipeline`（保留为"编排样板"，内部改调三入口）

**与现有 60 个工具的关系**：**不替换、不废弃**。60 个工具是这三者的"特化组合"（observe/harvest/契约/积木/渲染等是**别的能力线**，不进读写内核）。
三入口是**面向 agent 的高频面**，`capability_map` 里新增一条 `io` 线承载它们；
旧名**同名换底层**（§7.2），契约不破。

---

## 6. 索引门面：冷启 bootstrap（P0 的核心改造）

**改造点（小、清晰、可测）**：

```
ensureFreshIndex(projectRoot)
  ├─ 库存在 → 增量重同步（现状，不动）
  └─ 库不存在 / 空库 → 【新】bootstrap：
       ├─ 立即返回 { state: 'indexing', startedAt, files: 0 }   ← 不阻塞调用
       ├─ 后台跑 syncProject（分片，可按目录/语言限流）
       ├─ 进度可查：{ state: 'indexing'|'ready'|'partial', files, symbols, coverage, eta }
       └─ ready 之前：读/筛返回**已索引部分** + `coverage` 明确标注（诚实纪律，不假装完整）
```

**三条纪律**：

1. **不阻塞**：第一次调用不许卡在"正在建索引"上；要么给局部结果 + 覆盖度，要么给 `state=indexing` + 可轮询句柄。
2. **不静默撒谎**：任何结果都带 `index: {state, coverage, indexed_at}`；覆盖度不足时**显式标注**（对齐 `.trae/skills/design-canvas-mind` 的"诚实纪律"）。
3. **可跳过**：超大仓库/`node_modules`/生成物有 ignore 策略（已有 ignore 依赖）；命中 ignore 不算覆盖缺口。

**保鲜（已有）**不变：外部改动（git pull / 手改 / 其他 agent）→ 查询前懒校验增量重同步；
无变更 → 零重同步、不加注记（不惊扰）。

---

## 7. 「模型无感」怎么做（★ 与 prompt 前缀稳定的张力）

### 7.1 不这么做（反例）

❌ 在 system prompt 里写「遇到项目先用 Silva 建索引」——
**每次调整都击穿 prompt 前缀**（本项目铁律 5：外置化/缩减必须在写入时 append-only；事后改写必击穿前缀）。
且它把"默认行为"降级为"模型可能记住的指令"，与 N3 直接冲突。

### 7.2 这么做

| 手段 | 说明 | 现状 |
|---|---|---|
| **同名工具换底层** | agent 调的还是 `code_read`/`code_edit`/`explore_code`…；**底层实现从"要求先建索引"换成"自己静默建"** | 本次改造 |
| **零参数自动发现** | `project_root` 省略 → `resolveProjectRoot`（git 根→manifest→文件目录，嵌套 git 安全） | ✅ 已有 |
| **工具层默认（host plane 全局层）** | 工具走 host plane 全局注册，**不进 preset** ⇒ 不依赖任何 persona/prompt 文本 | ✅ 先例：`tool_score`、`list_capabilities` |
| **索引只在工具返回里，不进 prompt** | 索引状态是**返回值**，不是 system 文本 ⇒ 前缀不动、缓存不炸 | 设计约束 |
| **能力线导航** | `capability_map` 增 `io` 线（目录仍由 `TOOL_DEFS` 派生，零手工同步） | §5 |

> 判据：**在完全干净的会话里，直接说"改这个函数名"，不做任何声明与准备，也要成功。**
> 若必须靠一句 prompt 才能触发，就是没做到 N3。

### 7.3 DSH 侧接线

- 已接：`~/.dsh/profiles/web/cordis.patch.yml` 的 `mcp-client`（`serverName: design-canvas`，stdio 拉 `dist/src/server.js`，`DESIGN_CANVAS_HOME` 指向项目数据根）。
- 待接（能力库）：把该底座登记为 `kind: kernel` 的能力条（`capability-registry.mjs`），
  ⇒ `list_capabilities` 的跨源总览里出现"代码读写内核：1 条 / N 个入口"。
- 换代才能生效：MCP server 是**独立进程、不热更新**（`generation-swap.md`）。

---

## 8. 多 agent 并发口径（G4）

索引是**进程外共享资产**（`<projectRoot>/.design-canvas/cache.db`），因此：

| 场景 | 语义 |
|---|---|
| 多 agent 并发读 | ✅ 自由（SQLite WAL，读不阻塞写） |
| 多 agent 并发写索引 | **单写**：写前取文件锁；拿不到锁 → 转 `state=indexing(external)` 等它，不重复建 |
| 写代码 vs 写索引 | 编辑落盘后**只失效受影响文件**的索引项（复用 `changed_files`），不整库重建 |
| 索引损坏/版本升级 | `SCHEMA_VERSION` 不匹配 → 就地重建（已有机制），并记一条日志（不静默） |

---

## 9. 判据与验收（接到 P3 注册门的 L0~L4）

| 档 | 判据 | 具体口径 |
|---|---|---|
| **L0** | 能跑 | 三入口在空项目上各成功调用一次 |
| **L1** | 结构正确 | `dry_run` 的 `ops[]` 可重放且与落盘结果一致；索引表行数与文件数自洽 |
| **L2** | 零前置 | 统计"首次成功读写前的额外前置调用数"：今天 ≥1（`import_project`），目标 **= 0** |
| **L3** | 不撒谎 | 覆盖度 <100% 时结果必须带 `coverage`；**伪造/静默降级计为失败** |
| **L4** | 可执行验收 + 隐藏 holdout | ① 真实场景集（改名/搬迁/加字段/死代码清理）自动化通过 ② **holdout 不在训练/开发集里**：随机抽 5 个真实仓库，冷启→改名→回滚一次 |

**明确不进判据**：裸满意度评分（本项目铁律 7：判据与信号不可混）。

---

## 10. 分期路线

| 期 | 内容 | 产物 |
|---|---|---|
| **P0** | 冷启 bootstrap（§6）+ 覆盖度/新鲜度字段 | `ensureFreshIndex` 改造 + 测试（空库 bootstrap、进度、覆盖率、并发单写） |
| **P1** | 三入口（§5）：先 `code_read`/`code_filter`（只读，风险低），再 `code_edit` | 三工具 + 归并映射表 + `capability_map` 的 `io` 线 |
| **P2** | 语义层：把"语义词 → 结构化动作"的翻译做成默认（如"改这个函数名"→ `code_edit(rename)`） | 意图→动作的路由（**工具层**，非 prompt） |
| **P3** | 全 agent 默认：DSH 前脑/子脑都默认走这条底座；旧入口退为兼容壳 | 接入验收（§9 L4）+ 能力库登记 |

---

## 11. 待拍板（需要用户决策）

1. **底座叫什么名字？** 推荐见本轮对话（主推 Silva/林；备选 Graft/Arbor）。名字是**跨仓契约**
   （MCP `serverName` → 工具前缀 `mcp__<name>__*`、`DESIGN_CANVAS_HOME`、`.design-canvas/` 数据根、
   `.design-canvas.json` 项目配置、179 个文件里的字面量），一旦开动要一次到位。
   ⇒ **两段式建议**：① 先改"对外品牌层"（仓名/文档/显示名）；② 机器契约层单独一次原子提交 + 数据迁移别名。
2. **三入口是否保留旧名兼容？**（建议：保留，同名换底层，零契约破坏）
3. **冷启的边界策略**：默认扫全仓 vs 只扫"当前任务触及的目录"（建议：先按 manifest/ignore 扫全仓，大仓可配 `scope`）
4. **`code_edit` 的默认权限**：默认 `dry_run=true`（更安全、但多一轮）vs 默认直接落盘（更快、但需信任）
5. **多 agent 共享索引**：按项目一份 `cache.db`（现状）还是集中一份（便于跨项目筛选，但耦合）

---

## 附：本文与既有文档的关系

- **不重复**：`tool-convergence.md` 管"工具数量与命名收敛"；本文管"读写编辑内核的**入口与零前置**"。
- **不重复**：`capability-registry-evolution.md` §3.6 / §3.6.1 管"能力库覆盖工具层"；本文的产物会成为其中一条 `kind: kernel`。
- **对齐**：`.trae/skills/design-canvas-mind/SKILL.md` 的「先注入 → 先编排 → 才固化 → 诚实交付」——
  本文的 N3（模型无感）是它的**下一级**：让"注入"这件事本身消失。
