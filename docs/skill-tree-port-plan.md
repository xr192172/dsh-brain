# SkillTree 移植映射表（2026-09-20）

> 上游（只读，不改）：`D:\project_develop\ai-base\agent-shell\internal\memory\`
> 依据：`docs/revised-architecture-2026-09-20.md` **§7 全节**（尤其 §7.3）、
> `.workbuddy/memory/topics/self-evolution-design.md` **§13** 的三分清单、
> `docs/memory-asset-triage.md` §3 处置表 / §6 落地顺序。
>
> **本阶段只做数据层**（对应 `memory-asset-triage.md` §6 的 **P2**）。
> 执行器（P3）刻意不做 —— 顺序理由是「**数据先行、执行器可替换**」。

---

## 1. 边界：本表管什么、不管什么

| 管 | 不管 |
|---|---|
| `SkillNode` 数据模型 + 生命周期 + `Absorb`（新建/合并/融合的**账本**） | `GetActiveSkills` / 注入 / `spawn provider` 委派（**执行器**，P3） |
| 导入器（把外部 skill 变成**候选能力**） | 注册门 L1/L3 的具体实现（挂在 `SkillEvaluator` 接口上，本层只留挂载点） |
| 确定性评分层（`gravity_field`）/ 遗忘（`sleep_prune` 的数据面） | 睡眠调度（`sleep_scheduler` 的"同时最多 1 个运行 + checkpoint"） |

**一句话**：能力库**不需要设计**（§13 原文），本表只是把它从 Go 搬到 TS，**不新增字段、不改语义**。

---

## 2. 三分归类（照 §13，不重造）

| Go 文件 | 行数 | 归类 | 理由 / 处置 |
|---|---|---|---|
| `skill_tree.go` | 1253 | **换执行器** | 数据模型 + 生命周期 + `Absorb` 整体可用；只把 `Active Skill Injection`（`GetActiveSkills`/`nodeToSkillEntry`）换成 `spawn provider` |
| `skill_import.go` | 584 | **换执行器** | 导入器保留（格式就是 Claude Code / Cursor 的 `.md`+frontmatter）；导入后视为**候选能力** |
| `sqlite_store.go` | 1448 | **直接移植**（但**阻塞于 P0**，见 §6） | 存储/索引层，与架构无关；但选型依赖"记忆宿主进程形态"这个未决前提 |
| `heat.go` | 526 | **直接移植** | 热度/衰减/锚点，纯数据层 |
| `gravity_field.go` | 239 | **直接移植** | **无 LLM、无 IO、无新持久字段**的确定性评分层 —— 最好移、最难腐坏 |
| `sleep_prune.go` | 240 | **直接移植**（**有外溢依赖**） | 遗忘；但依赖 `GraphCache`/`GraphWriter`，这两个**不在本次 6 文件内** |
| `shallow_writer.go` | — | **不移植** | 跑 `os/exec` 抓状态 ⇒ DSH 里是**工具调用**，不该内置成记忆层 |
| `sleep_config.go` 的 REST API | — | **不移植** | DSH 有 admin 面 |
| `builder.go` 的装配部分 | — | **不移植**（只参考） | 插件体系 + `SubagentProvider` 取代；**但 `sanitizeID()` 在它里面**，要摘出来 |

---

## 3. 依赖顺序（**必须先移的在前**）

```
L0  纯函数层（无 IO / 无依赖 / 可被一切复用）
     tokenizePrinciple · jaccard · isStopword · tokenize · normalizePrinciple
     sanitizeID · sanitizeName · mergeTriggers · mergeFix · extractTriggerTokens
        │
L1  类型层  ★ 本次已落地：packages/skill-tree/src/index.ts
     ToolDef · SkillNode · EditRecord · SkillStatus/Source · AbsorbOutcome
     SkillTreeMeta · EvalResult · SkillEvaluator
        │
     ├──────────────────┬──────────────────┬───────────────────┐
L2  gravity-field.ts   skill-tree.ts      heat-store.ts
     （独立，仅依赖       （生命周期+Absorb，   （Decay/Record/
      L0 jaccardFromSets） 依赖 L0+L1+          GetHot/Upsert）
                          Evaluator）
        │                   │                  │
        │                   │         MigrateFrom(HeatStore→SkillTree)
        │                   │                  │
L3                     import/*.ts        store/*.ts
                        （依赖 skill-tree）   （依赖 L1 + embedder 接口）
        │
L4  prune.ts（SynapticPruner）
        ⚠ 依赖 GravityField + GraphCache + GraphWriter
          ⇒ **必须先于它立项移植 graph_cache.go / graph_writer.go**
```

**顺序理由**：`FindByPrinciple`/`FindSimilar`/`Absorb` 三条路都踩 L0 的分词与 jaccard；
口径一旦漂移，去重结果就**不可复现**（而"能不能复现"正是融合判据 L2 的命根子）。

---

## 4. 逐文件映射表（Go → TS）

### 4.1 `skill_tree.go`（1253 行）→ `src/skill-tree.ts` + `src/types.ts`

| Go | 行 | TS | 备注 |
|---|---|---|---|
| `SkillNode` | 21 | `SkillNode`（**已落地**，`src/index.ts`） | **33 字段，顺序与 Go 完全一致**，已用脚本双向核对 0 缺 0 多 |
| `EditRecord` | 77 | `EditRecord`（已落地） | — |
| `statusAbsorbed` | 86 | `SkillStatus.Absorbed`（已落地） | Go 侧未导出，TS 侧提升为一等成员 |
| `AbsorbOutcome` + 4 个常量 | 90-101 | `AbsorbOutcome` 数字枚举（已落地） | 保 0..3 的 iota 序，便于跨语言日志对齐 |
| `MaxEditsPerEpoch` | 107 | `MaxEditsPerEpoch`（已落地） | ch09 §3 文本学习率 |
| `isAbsorbed` | 112 | `isAbsorbed()`（已落地） | — |
| `SkillTreeMeta` | 145 | `SkillTreeMeta`（已落地） | `RejectedEdits` 环形缓冲上限 20 |
| `SkillTree` struct | 152 | `SkillTree` class | `mu` → 无（见 §5①）；`prinIndex` 显式重建（见 §5⑪）；`epoch` 是 `Save()` 的副作用（见 §5⑩） |
| `NewSkillTree` / `Load` / `Save` | 165/185/232 | `constructor` / `load()` / `save()` | — |
| `initialScore` | 254 | `initialScore()`（已落地） | user .60 / community·shared .55 / learned .30 |
| `Create` | 269 | `create()` | 内含 `prinIndex` 去重三级：精确 → Jaccard>0.5 → 子串 |
| `MergeRemote` | 330 | `mergeRemote()` | **三级去重**：ID 精确 → principle 匹配（挂 `MergedFrom`）→ 新建 `shared` |
| `Score` | 406 | `recordUse()` | 命中 +0.02 / 未中 −0.05；`findByNameNoLock` 兼容带不带 `skill-` 前缀（**别丢，2026-08-13 就是因为丢了它评分静默失效**） |
| `Promote` / `Demote` / `Archive` / `RunLifecycle` | 448/479/505/531 | 同名方法 | 都过 `SkillEvaluator` 门；**只在 `IsEvalReady` 为真时才门控**（"无验证集"不算拦） |
| `FindByPrinciple` / `findByPrincipleLocked` | 585/594 | `findByPrinciple()` | 三级：O(1) 索引 → Jaccard>0.5 → 子串（norm>20） |
| `FindSimilar` | 649 | `findSimilar()` | LLM 去重前的**预筛**（最终决定权在 LLM）—— 对应流水线"相似比较" |
| **`Absorb`** | 720 | `absorb()` | ★ 三种操作里"**合并**"的现成实现：6 条合并规则 + 2 条不合并检查；`Exclusive` 是用户钉住的"不许合并"位 |
| `mergeTriggers` / `mergeFix` | 807/827 | 同 | 规则 2/3；`mergeFix` 用 `"\n\n---\n\n"` 连接 |
| `tokenizePrinciple` / `jaccard` / `isStopword` | 841/856/871 | → `src/text/tokenize.ts`（**L0**） | 与 `retriever.go:485 tokenize`、`heat.go:471 normalizePrinciple` 一起下沉 |
| `UpdateFix` / `UpdateTriggers` / `RecordRejectedReflect` / `AddTriggers` | 885/900/934/948 | 同名 | 只有 `reflect_fix`/`reflect_triggers` **且 Accepted** 才计入 `MaxEditsPerEpoch` |
| `Get` / `FindBySourceFile` / `FindByName` / `findByNameNoLock` / `AllNodes` | 970-1043 | 同名 | `AllNodes` 过滤 `archived` |
| **`GetActiveSkills`** / `nodeToSkillEntry` | 1054/1156 | **不移植** → 留 `src/executor/` 占位 | ★ 这就是要被换掉的**执行器**；`agent.SkillEntry` 是它的返回类型 |
| `resolveSkillIDRLock` | 1178 | `resolveSkillID()` | 避免可重入 RLock 死锁的 Go 特有写法，TS 里自然消失 |
| `MigrateFrom(HeatStore)` | 1196 | `migrateFrom()` | **依赖 heat.go ⇒ L2 之后** |
| `randomSuffix` | 1250 | `randomSuffix()` | Go 用 `time.Format("150405.000000")`，TS 需等价实现 |

### 4.2 `skill_import.go`（584 行）→ `src/import/`

| Go | 行 | TS | 备注 |
|---|---|---|---|
| `frontmatter` | 39 | `SkillFrontmatter` | 含 `Tools []external.ToolDef`（不可信输入！见 §5⑥） |
| `skillRegistry` / `NewSkillRegistry` | 54/60 | `SkillRegistry` class | `Load(ctx, dirs)` → `ctx` 变 `AbortSignal`（§5④） |
| `scanDir` / `importFile` | 98/126 | 同名 | `io/fs` 遍历 → `fs/promises` + `withFileTypes` |
| `parseFrontmatter` / `parseFrontmatterBlock` / `toStringList` | 214/247/279 | 同名 | YAML 解析需引入依赖 |
| `classifySource` / `expandPath` / `sanitizeName` | 304/320/331 | 同名 | **`sanitizeName` 被 `skill_tree.go` 反向依赖 ⇒ 归 L0** |
| `nodeToSkillDef` | 353 | 同名 | → `external.SkillDef` |
| `ImportSkill` / `UpdateImport` | 384/426 | 同名 | `source_hash` 探测上游变更 → `update_pending`（**外部升级 = 新候选，重跑注册门**，§7.4 ④） |
| `ResolveInheritance` / `resolveSkillID` / `hasCircularInheritance` | 467/546/564 | 同名 | **`Extends` 环检测必须保留** |

### 4.3 `sqlite_store.go`（1448 行）→ `src/store/`

| Go | 行 | TS | 备注 |
|---|---|---|---|
| `NodeIndexEntry` / `SkillIndexEntry` | 45/65 | 同名接口 | — |
| `SQLiteVecStore` / `NewSQLiteVecStore` | 76/92 | `SqliteVecStore` class | **最大难点**，见 §5② |
| `Search` / `SearchSimilar` / `knnNodes` / `knnSkills` | 129/163/1006/1063 | `async` 方法 | vec0 KNN cosine |
| `UpsertNodes` / `UpsertSkills` / `MarkDirty` / `SyncIfDirty` | 241/326/256/344 | 同名 | **dirty 惰性同步**（写路径不 embed，Search 时才补）—— 这套机制值得原样搬 |
| `Reconcile` / `ReconcileStats` | 430/412 | 同名 | — |
| `FindActiveByAnchors` / `AnchorHit` | 284/274 | 同名 | 锚点检索 |
| `initSchema` / `reconcileVecDim` / `selfCheck` | 870/937/975 | 同名 | schema_version / vec_dim 自检 |
| `f32ToBlob` / `blobToF32` | 1404/1417 | `Float32Array` ⇄ `Buffer` | — |
| `ErrEmbedderNotConfigured` | ~40 | 同名 | embedder 为 nil 时**停用向量检索并降级关键词** —— fail-soft 语义要保住 |

### 4.4 `heat.go`（526 行）→ `src/heat-store.ts`

| Go | 行 | TS |
|---|---|---|
| `HeatEntry`（含 `Anchors` / `Supersedes` / `SupersededBy`） | 46 | `HeatEntry` |
| `SkillEntry` / `PromotionCandidate` / `Filter` | 75/67/22 | 同名 |
| `HeatStore` + `Load`/`Save`/`Flush`/`Record`/`RecordAnchored` | 92-223 | `HeatStore` class |
| `MarkSuperseded` / `FindActiveByAnchors` / `GetHot` / `GetHotSkills` | 233/250/278/354 | 同名 |
| `Decay` / `DecayNREM` | 371/403 | 同名 |
| `UpsertSkill` / `FindSkillByPrinciple` | 324/300 | 同名 |
| `normalizePrinciple` / `uniqueStrings` / `unionStrings` / `strSlice` | 471/494/507/485 | → **L0** `src/text/` |

### 4.5 `gravity_field.go`（239 行）→ `src/gravity-field.ts`

| Go | 行 | TS | 备注 |
|---|---|---|---|
| `PairForce` / `GravityField` | 21/31 | 同名 | `HighMassFloor` = 质量 75 分位 |
| `minPairHeap`（`Len`/`Less`/`Swap`/`Push`/`Pop`/`pushPair`） | 39-92 | 自写二叉堆 或 排序替代 | Go 有 `container/heap`，**JS 标准库没有堆**（§5⑨） |
| `NewGravityField` / `Compute` | 94/111 | 同名 | 纯函数；`lastCompute` 是 TTL 去重 |
| `jaccardFromSets` | 223 | → L0 | — |

### 4.6 `sleep_prune.go`（240 行）→ `src/prune.ts`

| Go | 行 | TS | 备注 |
|---|---|---|---|
| `PruneAuditEntry` | 26 | 同名 | 审计留痕要保 |
| `SynapticPruner{gc,gw,gf,dataDir}` | 39 | 同名 | **依赖 `GraphCache`+`GraphWriter`（未移植）** |
| `NewSynapticPruner` / `RunPrune` | 47/53 | 同名 | `ctx` → `AbortSignal` |
| `isDecisionType` / `writePruneAudit` | 201/208 | 同名 | 对 subagent 有差异化策略（§3 三条特别值得留） |

---

## 5. 边角：Go 特有的东西，在 DSH 里对应什么

| # | Go 侧 | 出现处 | DSH / TS 对应 | ⚠ 坑 |
|---|---|---|---|---|
| ① | `sync.RWMutex` | `skill_tree`/`sqlite_store`/`heat`/`skill_import` | **不能简单删锁** | JS 单线程没有共享内存锁，但 ai-base 是**三 brain 进程共享单文件 `memory.db`** —— 并发是真的。要靠 **I1 写权唯一** + 常驻宿主进程（`memory-asset-triage.md` §5） |
| ② | `database/sql` + `modernc.org/sqlite` + `sqlite-vec`（vec0 虚拟表、cosine KNN、auto-extension） | `sqlite_store` | Node 侧无等价：需 `better-sqlite3`（原生编译）或 `node:sqlite`（≥22.5 实验性）；vec0 靠 `loadExtension` | 打包进 DSH 插件是**真问题**；这是本次最难的一处 |
| ③ | `os/exec` | `shallow_writer.go`（**不移植**） | **工具调用** | 别把它内置进记忆层 |
| ④ | `context.Context` | `skill_import`/`sleep_prune` | `AbortSignal` | 取消语义要显式传，别省略 |
| ⑤ | goroutine（"单 goroutine 独占写 + tmp→rename 原子写 + `.corrupted` 恢复"） | `graph_writer.go`（`sleep_prune` 的依赖） | 单写者 + `fs.rename` 原子替换 | 与 **I1 写权唯一**同构，是现成实现，值得原样搬 |
| ⑥ | `gopkg.in/yaml.v3` frontmatter | `skill_import` | 需引 YAML 依赖 | ★ **外部 skill 是不可信输入**（§7.4）：解析后必须过 **L1 安全门**（`role`/`writeScope`/`credentials`/`budget` 一票否决）+ **L3 红队用例** |
| ⑦ | JSON tag **snake_case** | 全部 | TS 侧用 camelCase（照 Go 字段名） | **必须有一层显式映射**，不许靠"字段名刚好一样"的默契（已在 `src/index.ts` 顶部注明） |
| ⑧ | `time.Now().Format(time.RFC3339)` | 全部 | `new Date().toISOString()` | Go RFC3339 可能带纳秒+偏移，JS 是 `Z`+毫秒；**字符串比较/排序前要归一** |
| ⑨ | `container/heap` | `gravity_field` 的 `minPairHeap` | 自写堆 或 用排序替代 | JS 无标准堆 |
| ⑩ | `Save()` 里 `st.epoch++` | `skill_tree.go:232` | `save()` 同样递增 | **保存不是纯持久化，它有副作用**；移植时别把它挪走 |
| ⑪ | `prinIndex`（**NOT persisted**，Load 后 `rebuildPrinIndex`） | `skill_tree.go:160/215` | 显式 `rebuild()` | 别指望 JSON 反序列化把它带上 |
| ⑫ | `agent.SkillEntry`（`GetActiveSkills` 返回） | `skill_tree.go:1054` | **不移植** | 这是执行器边界，P3 换成 `spawn provider` |
| ⑬ | REST API | `sleep_config.go`（不移植） | DSH admin 面 | — |
| ⑭ | `logging.Error("memory:skilltree", …)` | 全部 | DSH logger / 宿主进程日志 | 保留 `memory:skilltree` 域，便于跨语言对日志 |

---

## 6. 未决前提（**横在前面，不解决会白干**）

- **`memory-asset-triage.md` §6 的 P0「定记忆宿主进程形态」还没定**。
  `sqlite_store` 的选型（SQLite vs 文件）直接取决于它 ⇒ **存储层先不要动**，
  这也是本阶段只落地类型层（L1）而不碰 L3 存储的原因。
- `sleep_prune` 依赖的 `graph_cache.go` / `graph_writer.go` **不在本次 6 文件内**，需要单独立项。

---

## 7. 下一步该移什么（按依赖排序）

1. **L0 纯函数层** `src/text/tokenize.ts` + 单测 ——
   `tokenizePrinciple` / `jaccard` / `isStopword` / `tokenize`（`retriever.go:485`）/
   `normalizePrinciple`（`heat.go:471`）/ `sanitizeID`（`builder.go:1194`）/ `sanitizeName`（`skill_import.go:331`）/
   `mergeTriggers` / `mergeFix` / `extractTriggerTokens`（`sleep.go:953`）。
   **先钉死口径**：`FindByPrinciple`/`FindSimilar`/`Absorb` 三条路共用它，口径一漂，去重结果就不可复现。
2. **`src/skill-tree.ts`**（L2）：`SkillTree` + 生命周期（Create/MergeRemote/Score/Promote/Demote/Archive/RunLifecycle）+ **`Absorb`**（6 条规则 + 2 条不合并检查）。
   `evaluator` 先给 no-op 实现（保持"门可替换"）；**`GetActiveSkills` 整段不移植**，单独留 `src/executor/` 占位。
3. **序列化映射层**（snake_case ⇄ camelCase）+ 与 ai-base `skill_tree.json` 的**只读**互通自测。
   不做这层，"数据先行"就接不上既有数据 → 数据层等于没接。
4. **`src/heat-store.ts`**（L2，来自 `heat.go`）并接上 `MigrateFrom` ——
   它是 §7.3「判分」缺口的**数据来源**（`UseCount`/`SuccessRate` 都从这来）。
5. **`src/gravity-field.ts`**（L2，纯确定性、最好移、最抗腐坏），为 `sleep_prune` 铺路；
   而 **`sleep_prune` 之前必须先立项移植 `graph_cache.go` / `graph_writer.go`**。

> 三步之后才轮到 P3（换执行器）。**不要让执行器反过来逼数据层改字段** ——
> 那就等于推翻 §13「能力库不需要设计」的结论。
