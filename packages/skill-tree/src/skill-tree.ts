/**
 * L2：`SkillTree` —— 三级 `findByPrinciple` + `findSimilar` + `Absorb`（2026-09-21）
 *
 * 来源（只读，不改）：`ai-base/agent-shell/internal/memory/skill_tree.go`:152-1252
 *         以及 `gate.go`:16-30（`EvalResult` / `IsEvalReady`）。
 * 依据：`docs/skill-tree-port-plan.md` §4.1 逐行映射 + §5 边角（①⑩⑪）+ §7.2（下一步第二条）。
 * 依赖：L1 `./index.ts`（类型 + `initialScore` / `mergedScore` / `isAbsorbed`）
 *       L0 `./text/tokenize.ts`（`normalizePrinciple` / `tokenizePrinciple` / `jaccard` /
 *          `mergeTriggers` / `mergeFix` / `sanitizeID` / `extractTriggerTokens` / `byteLen`）
 *
 * ★ 本文件**只做数据层**：`GetActiveSkills` / `nodeToSkillEntry`（skill_tree.go:1054/1156）
 *   整段**不移植** —— 那是要被换成 spawn provider 的执行器，留 `src/executor/` 占位（plan §4.1）。
 *   同理未移植：`UpdateFix`/`UpdateTriggers`/`RecordRejectedReflect`/`AddTriggers`（:885-948，
 *   依赖 MaxEditsPerEpoch 的编辑账本，等 L2 生命周期一起做）、`MigrateFrom`（:1196，依赖 heat.go）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★【移植告警索引】—— 上一轮只写在 commit message 里，这一轮起钉在代码里。
 *    下列每一条都是「Go 侧既有行为 / 既有缺陷」，**本移植照搬、不擅自改**：
 *    改任何一条都会改变既有 `skill_tree.json` 的判定结果 ⇒ 必须单独立项 + 全量回归。
 *
 *   W1 `findByPrinciple` Tier-2 ：CJK 永不入 token ⇒ 中文去重 Tier-2 恒失效
 *   W2 `create`                 ：中文 principle → `sanitizeID` 空 → `randomSuffix` ⇒ ID 不可复现
 *   W3 `create`                 ：`sanitizeID` 与 `sanitizeName` 两套净化器不同构
 *   W4 `findByPrinciple` T1/T3  ：`normalizePrinciple` 是朴素子串替换，会误伤词尾
 *   W5 `findByPrinciple` Tier-2 ：Go 注释自称能捕获的改写，实测 jaccard=0.5，被 `>0.5` 漏掉
 *
 *    搜索 `⚠️ 移植告警：` 可跳到每一处的落点行。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★【第二轮定夺：本移植自行补的 4 条（Go 里没有）】—— 搜索 `★★补` 可跳到落点行。
 *    判据：**「确定的坏」补，「只是行为差异」照搬**。
 *      · W1~W5 只是行为差异（Go 那样也能跑）⇒ 照搬，本轮不动。
 *      · N1/N2/N3a/N3b 是确定的坏（不可复现 / 自锁死 / 误删）⇒ **补掉**，编号改 D* 以示
 *        「这是我们定的，Go 里没有」：
 *
 *   D1 Tier-2 平票 / Tier-3 多命中：Go 是 map 随机序 ⇒ 结果不可复现
 *      ⇒ 补**确定性 tie-break：平票取 ID 字典序最小者**（理由见落点注释，别只看这句）
 *   D2 `findSimilar` 平票排序：Go `sort.Slice` 不稳定 ⇒ 同分顺序不定 ⇒ 同 D1 规则
 *   D3a `Absorb` 自环：`absorb(x, x)` 会把节点自锁死 ⇒ 补 `AbsorbOutcome.RejectedSelfAbsorb`
 *   D3b `Absorb` 收尾删索引：可能误删 `into` 自己的索引 ⇒ 补「只删指向 absorbed 的那一条」
 *
 *    ★ 每处都有「补之前必红、补之后必绿」的双向用例（test/skill-tree.test.mjs 末尾一节）。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  AbsorbOutcome,
  SkillSource,
  SkillStatus,
  initialScore,
  isAbsorbed,
  mergedScore,
  type EvalResult,
  type SkillEvaluator,
  type SkillNode,
  type SkillTreeMeta,
  type ToolDef,
} from './index.js'

import {
  byteLen,
  extractTriggerTokens,
  jaccard,
  mergeFix,
  mergeTriggers,
  normalizePrinciple,
  sanitizeID,
  tokenizePrinciple,
} from './text/tokenize.js'

// ─────────────────────────────────────────────────────────────────────────────
// 常量：全部钉死，改动 = 改去重/合并结果
// ─────────────────────────────────────────────────────────────────────────────

/** Tier-2 / FindSimilar 共用的「token 数下限」：少于 2 个 token 的一律不参与（skill_tree.go:605/613/654/672）。 */
export const MIN_FUZZY_TOKENS = 2

/** Tier-2 阈值：**严格大于** 0.5（skill_tree.go:617 `score > 0.5`）。见 W5。 */
export const TIER2_JACCARD_GT = 0.5

/** Tier-3 判据：`len(norm) > 20`，**字节**口径（skill_tree.go:629/635）。 */
export const TIER3_MIN_NORM_BYTES = 20

/** `Meta.RejectedEdits` 环形缓冲上限（skill_tree.go:465）。 */
export const REJECTED_EDITS_MAX = 20

/** 归档判据：score < 0.1 且 90 天未用（skill_tree.go:515-523）。 */
export const ARCHIVE_SCORE_LT = 0.1
export const ARCHIVE_IDLE_MS = 90 * 24 * 60 * 60 * 1000

/** gate.go:19/23 —— 「无验证集」类原因**不算门控**。 */
export const EvalReason = {
  NoValidationSet: 'no validation set available',
  NoMatchingScenarios: 'no matching scenarios for skill triggers',
} as const

/** gate.go:29 —— 只有真的跑过验证集，`EvalResult` 才有资格门控。 */
export function isEvalReady(r: EvalResult): boolean {
  return r.Reason !== EvalReason.NoValidationSet && r.Reason !== EvalReason.NoMatchingScenarios
}

// ─────────────────────────────────────────────────────────────────────────────
// 零值节点（Go 的 struct 零值；TS interface 要求全字段显式给出）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Go 里 `&SkillNode{...}` 未赋值的字段是零值；这里等价展开，便于逐字段核对。
 * 导出是为了给 L3（导入器 / `MigrateFrom`）和测试当构造起点，避免各处手抄 33 个字段。
 */
export function newSkillNode(): SkillNode {
  return {
    ID: '',
    Type: 'skill',
    Parent: '',
    Source: SkillSource.Learned,
    Brain: '',
    Status: SkillStatus.Active,
    Level: 1,
    Score: 0,
    UseCount: 0,
    SuccessRate: 0.5,
    Principle: '',
    Fix: '',
    Triggers: [],
    SourceFile: '',
    SourceHash: '',
    ImportedAt: '',
    ImportVersion: 0,
    Script: '',
    ScriptLang: '',
    Archive: '',
    SendInputRequired: 'conditional',
    Extends: '',
    Requires: [],
    EditHistory: [],
    MergedFrom: [],
    AbsorbedBy: '',
    RejectedAttempts: 0,
    LastValidated: '',
    ValidationScore: 0,
    Tools: [],
    Exclusive: false,
    LastUsedAt: '',
    CreatedAt: '',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 时间：Go `time.Now().Format(time.RFC3339)`（skill_tree.go:303 等）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ 序列化差异（port-plan §5⑧）：Go 的 RFC3339 带**本地偏移**（`+08:00`）且无毫秒，
 * JS 的 `toISOString()` 是 **UTC + 毫秒**（`.000Z`）。同一时刻两种写法**字符串不同** ⇒
 * 跨语言做字符串比较/排序前必须先归一。本移植不做归一，照原样各写各的。
 */
function nowStamp(): string {
  return new Date().toISOString()
}

/**
 * skill_tree.go:1250 —— `time.Now().Format("150405.000000")` 再 TrimPrefix "."，
 * 即 `HHMMSS.微秒`（**本地时区**，与 `nowStamp()` 的 UTC 不是同一套时钟，照 Go 保留）。
 * ★ 精度只有毫秒级（末三位恒 0），Go 侧同格式命名但实际也是 `time.Time` 的纳秒截断到 6 位。
 */
export function randomSuffix(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const frac = String(d.getMilliseconds() * 1000).padStart(6, '0')
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${frac}`
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillTree（skill_tree.go:152）
// ─────────────────────────────────────────────────────────────────────────────

/** 落盘/入参快照（Go `Save()`/`Load()` 里那个匿名 struct；snake_case 映射层尚未写，见 index.ts 顶部）。 */
export interface SkillTreeSnapshot {
  nodes: Record<string, SkillNode>
  meta: SkillTreeMeta
}

/**
 * 技能树：Path A（自学）与 Path B（用户/社区）在此合流（ch09 §5）。
 *
 * ★ plan §5①：`sync.RWMutex` 在 JS 里没有对应物，但**别以为并发问题消失了** ——
 *   ai-base 是三 brain 进程共享单文件 `memory.db`，并发是真的。DSH 侧靠
 *   **I1 写权唯一** + 常驻宿主进程兜（plan §5①）。本类**不自带锁**。
 */
export class SkillTree {
  /** Go `map[string]*SkillNode`。JS `Map` 是**插入序**，Go map 是**随机序** —— 见 N1。 */
  readonly Nodes: Map<string, SkillNode> = new Map()
  Meta: SkillTreeMeta = { Version: 1, RejectedEdits: [] }

  /** ★ plan §5⑪：normalize(principle) → ID，**NOT persisted**，`load()` 后必须显式 `rebuild()`。 */
  private prinIndex: Map<string, string> = new Map()
  /** ★ plan §5⑩：`Save()` 不是纯持久化，它有 `epoch++` 副作用 —— 别把自增挪走。 */
  private epochCount: number = 0
  private evaluator: SkillEvaluator | null = null

  /** Go `NewSkillTree`；IO 部分（os.MkdirAll + HeldOutEvaluator）归 L3 store，这里只留装配。 */
  constructor(meta?: Partial<SkillTreeMeta>) {
    if (meta) this.Meta = { Version: meta.Version ?? 1, RejectedEdits: meta.RejectedEdits ?? [] }
  }

  /** Go `SetEvaluator`（:178）。传 null = 跳过门控（Go 的 `evaluator == nil`）。 */
  setEvaluator(e: SkillEvaluator | null): void {
    this.evaluator = e
  }

  /** 当前 epoch（只读）。只在 `save()` 里自增。 */
  get epoch(): number {
    return this.epochCount
  }

  // ── 载入 / 落盘 ────────────────────────────────────────────────────────────

  /**
   * Go `Load`（:185）的非 IO 内核：灌入快照后**必须**重建 prinIndex（§5⑪）。
   * 真正的 `os.ReadFile` 归 L3 store（P0「记忆宿主进程形态」未定，plan §6）。
   */
  load(snapshot: SkillTreeSnapshot): void {
    this.Nodes.clear()
    for (const [id, node] of Object.entries(snapshot.nodes)) this.Nodes.set(id, node)
    this.Meta = snapshot.meta
    if (this.Meta.Version < 1) this.Meta.Version = 1
    this.rebuild()
  }

  /**
   * Go `Save`（:232）的非 IO 内核。**保留 `epoch++` 副作用**（§5⑩），返回待落盘快照。
   * ⚠️ 「保存」有副作用：连续两次 `save()` 会得到不同 epoch —— 别把它当纯函数挪动。
   */
  save(): SkillTreeSnapshot {
    this.epochCount++
    const nodes: Record<string, SkillNode> = {}
    for (const [id, node] of this.Nodes) nodes[id] = node
    return { nodes, meta: this.Meta }
  }

  // ── 批量写入 / 索引重建 ────────────────────────────────────────────────────

  /**
   * 批量导入入口。Go 侧没有这个方法（那里是直接 `st.Nodes[id] = node`），
   * 但 Go 的 `rebuildPrinIndex` 注释明写「should be called after any batch import」
   * ⇒ 这里把「写 Nodes + 刷索引」合成一步，避免调用方忘了 rebuild。
   */
  put(node: SkillNode): void {
    this.Nodes.set(node.ID, node)
    if (!isAbsorbed(node)) this.setPrinIndex(node.ID, node.Principle)
  }

  /** Go `rebuildPrinIndex`（:215）：跳过已吸收节点；**同键后写覆盖先写**（N1）。 */
  rebuild(): void {
    this.prinIndex = new Map()
    for (const [id, node] of this.Nodes) {
      if (isAbsorbed(node)) continue
      this.setPrinIndex(id, node.Principle)
    }
  }

  /** Go `setPrinIndex`（:227）。 */
  private setPrinIndex(id: string, principle: string): void {
    this.prinIndex.set(normalizePrinciple(principle), id)
  }

  // ── 三级 findByPrinciple（skill_tree.go:585/594）──────────────────────────

  /**
   * 三级模糊匹配：Tier-1 O(1) 索引 → Tier-2 Jaccard **严格 > 0.5** → Tier-3 子串（norm > 20 字节）。
   *
   * 返回命中的 ID；未命中返回 `undefined`（对应 Go 的 `("", false)`—— 空串 ID 不可能存在）。
   *
   * ⚠️ 三级**共用** L0 的分词与归一化口径（tokenize.ts 顶部口径清单 A~E）。
   *    口径一漂，去重结果就不可复现 ⇒ 改这里之前先看那份清单。
   */
  findByPrinciple(principle: string): string | undefined {
    // ── Tier 1：O(1) 精确（归一化后）────────────────────────────────────────
    // ⚠️ 移植告警 W4：键是 `normalizePrinciple()` 的输出，而它是**朴素子串替换**
    //    （带尾空格的填充词），会误伤词尾：`"validate data flow"` → `"validate datflow"`、
    //    `"human in loop"` → `"humin loop"`。语义已坏，但它是 prinIndex 的键 ⇒ **照搬**。
    //    改它会让既有 skill_tree.json 里的 principle 全部查不到。
    const norm = normalizePrinciple(principle)
    const tier1 = this.prinIndex.get(norm)
    if (tier1 !== undefined) return tier1

    // ── Tier 2：token 集合 Jaccard，严格 > 0.5 ──────────────────────────────
    // ⚠️ 移植告警 W1：`tokenizePrinciple` 的分隔符是「非 [a-zA-Z0-9]」，
    //    **全部 CJK 都只当分隔符、永不成为 token** ⇒ 纯中文 principle 的 token 集恒为空，
    //    `size >= 2` 这个闸门直接把它挡在门外 ⇒ **中文去重 Tier-2 恒失效**
    //    （只剩 Tier-3 子串兜底，而 Tier-3 又要求 >20 字节）。照搬，改动会改既有判定。
    const candidate = tokenizePrinciple(principle)
    if (candidate.size >= MIN_FUZZY_TOKENS) {
      // ★★补 D1（**这是我们定的规则，Go 里没有**）—— 平票取 **ID 字典序最小者**。为什么是这条：
      //   ① Go 取的是 map **随机迭代序**的第一个，本实现取的是 JS Map **插入序**的第一个 ——
      //      两者都不可复现：插入序**不持久化**（§5⑪ prinIndex 不落盘，`load()` 后 Nodes 的
      //      插入序来自快照 key 顺序，而快照又是从 Go 的 map 序列化出来的 ⇒ 顺序本就随机）。
      //      ⇒ 只有「**由数据本身**决定的规则」才可复现，遍历序/插入序都不算；可持久化的稳定
      //        身份只有 ID。
      //   ② 字典序是**全序**且 ID 在 Nodes 里唯一 ⇒ 不存在二次平票，也不依赖任何遍历顺序与
      //      语言实现（Go 侧将来要对齐，照抄同一条即可）。
      //   ③ 平票意味着相似度**相同**，不该再暗含质量偏好 —— 所以**不**按 Score / UseCount /
      //      CreatedAt 挑（那等于凭空造一个「谁更好」的语义，是我们自己的漂移）。选字典序最小
      //      = 只为保证「谁都一样时，永远选同一个」。
      let bestID = ''
      let bestScore = 0
      for (const [id, node] of this.Nodes) {
        if (isAbsorbed(node)) continue
        const nodeTokens = tokenizePrinciple(node.Principle)
        if (nodeTokens.size < MIN_FUZZY_TOKENS) continue
        const score = jaccard(candidate, nodeTokens)
        // ⚠️ 移植告警 W5：skill_tree.go:603 的注释自称
        //    「Catches rephrasings like "validate user input" vs "input validation for user"」，
        //    但实测这对改写 jaccard **恰好 = 0.5**，而这里的判据是**严格 >** 0.5
        //    ⇒ 注释里点名的那句改写**命中不了**（已被 tokenize.test.mjs 钉死为 0.5）。
        //    想让它命中就得放宽到 `>=`（那是 FindSimilar 的 minJaccard 语义，两套阈值别混）。
        if (score > TIER2_JACCARD_GT && (score > bestScore || (score === bestScore && id < bestID))) {
          bestScore = score
          bestID = id
        }
      }
      if (bestID !== '') return bestID
    }

    // ── Tier 3：双向子串包含（两边 norm 都要 > 20 字节）─────────────────────
    // ⚠️ 移植告警 W4（同上）：输入同样过 `normalizePrinciple`（D1 误伤在这里二次生效）。
    // ★★补 D1（同一条规则，理由见 Tier-2 落点注释）：Go 是「命中即 return」⇒ 谁先被遍历到谁赢
    //    （map 随机序，不可复现）。这里改成「**扫完全集再取 ID 字典序最小者**」。
    //    ⚠️ 长度是**字节**口径：7 个汉字（21 字节）能进 Tier-3，7 个英文字母不能。
    if (byteLen(norm) > TIER3_MIN_NORM_BYTES) {
      let bestID = ''
      for (const [id, node] of this.Nodes) {
        if (isAbsorbed(node)) continue
        const np = normalizePrinciple(node.Principle)
        if (byteLen(np) <= TIER3_MIN_NORM_BYTES) continue
        if (norm.includes(np) || np.includes(norm)) {
          if (bestID === '' || id < bestID) bestID = id
        }
      }
      if (bestID !== '') return bestID
    }

    return undefined
  }

  // ── FindSimilar（skill_tree.go:649）───────────────────────────────────────

  /**
   * LLM 去重前的**预筛**：返回 jaccard **>= minJaccard** 的未吸收节点，按分数降序，最多 topN。
   *
   * ★ C2：这里是 **>=**，而 Tier-2 是 **严格 >** —— 两套阈值语义不同，别混。
   *   （两者都取 0.5 时，jaccard 恰好 =0.5 的一对：**FindSimilar 命中、Tier-2 不命中**。）
   * ★ 最终合并决定权在 LLM（Go 注释原话），本函数只做排序预筛。
   */
  findSimilar(principle: string, minJaccard: number, topN: number): SkillNode[] {
    const tokens = tokenizePrinciple(principle)
    // ⚠️ 移植告警 W1（同 Tier-2）：token 数 < 2 直接返回空 ⇒ 纯中文 principle 连预筛都进不去。
    if (tokens.size < MIN_FUZZY_TOKENS) return []
    // Go 里 `candidates[:topN]`，topN 为负会 **panic**；JS `slice(0, -1)` 是「去最后一个」。
    // 这里显式截断到空数组，避免负 topN 语义跑偏。
    if (topN <= 0) return []

    const scored: Array<{ node: SkillNode; score: number }> = []
    for (const node of this.Nodes.values()) {
      if (isAbsorbed(node)) continue
      const nt = tokenizePrinciple(node.Principle)
      if (nt.size < MIN_FUZZY_TOKENS) continue
      const s = jaccard(tokens, nt)
      if (s >= minJaccard) scored.push({ node, score: s })
    }

    // ★★补 D2（**这是我们定的规则，Go 里没有**）：Go 用 `sort.Slice`（pdqsort，**不稳定**），
    //    「同分谁在前」在 Go 侧本就不可复现；JS 侧稳定的 `Array.sort` 保的是**插入序**，
    //    而插入序不持久化（见 D1 理由①③）⇒ 同样不可复现。
    //    ⇒ 显式补一条完全比较子：**分数降序，同分按 ID 字典序升序**（与 D1 同一条规则，
    //      理由见 Tier-2 落点注释）。ID 唯一 ⇒ 全序 ⇒ 结果只取决于数据集本身。
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.node.ID < b.node.ID ? -1 : a.node.ID > b.node.ID ? 1 : 0
    })
    return scored.slice(0, topN).map((c) => c.node)
  }

  // ── Absorb（skill_tree.go:720）────────────────────────────────────────────

  /**
   * 跨路径吸收 = 「合并」：`absorbedID`（通常是 learned）并入 `intoID`（通常是 user/community）。
   *
   * ch09 §5 的 **6 条合并规则**：
   *  1. 保留 `into` 的 ID 与 Principle（人的意图优先）
   *  2. 追加 absorbed 的 Triggers（去重）
   *  3. 追加 absorbed 的 Fix（`"\n\n---\n\n"` 连接）
   *  4. 把 absorbedID 记进 `into.MergedFrom`（审计留痕）
   *  5. `into.Score = absorbed*0.3 + into*0.7`（加权平均）
   *  6. `into.Source` **不变**（不许降级成 learned）
   *
   * **2 条不合并检查**：
   *  · `into.Exclusive=true` → `RejectedExclusive`
   *  · 合并后 validation_score < min(合并前两者) → `RejectedValidation`
   *
   * ★ 被吸收节点**保留在 Nodes 里**（status="absorbed" + AbsorbedBy），只从 prinIndex 摘掉 ——
   *   这是审计留痕，别当成删除。
   * ★ 「>80% 语义重叠」判定**不在本函数**，由调用方（LLM DedupSkill）负责（Go 注释原话）。
   */
  absorb(absorbedID: string, intoID: string): AbsorbOutcome {
    const absorbed = this.Nodes.get(absorbedID)
    if (!absorbed) return AbsorbOutcome.RejectedNotFound
    const into = this.Nodes.get(intoID)
    if (!into) return AbsorbOutcome.RejectedNotFound

    // ★★补 D3a（**这是我们补的，Go 里没有**）：Go **没有**自环检查，`absorb(x, x)` 会走到最后
    //    ⇒ x 自己标成 absorbed + AbsorbedBy=x（`isAbsorbed()` 为真 ⇒ 三级查找 / FindSimilar
    //    全部看不见它，且没有反操作 ⇒ **自锁死**），Fix 还会被自我拼接一遍、MergedFrom 记自己。
    //    这是「确定的坏」而非行为差异 ⇒ 补一个显式拒绝（新枚举 `RejectedSelfAbsorb`）。
    if (absorbedID === intoID) return AbsorbOutcome.RejectedSelfAbsorb

    // 不合并检查 1：用户钉住不许合并。
    if (into.Exclusive) return AbsorbOutcome.RejectedExclusive

    // 规则 5 的分数先算出来（门控要拿它评估候选态）。
    const merged = mergedScore(absorbed.Score, into.Score)

    // 不合并检查 2：验证分不许掉到 min(合并前两者) 之下。
    if (this.evaluator) {
      const beforeMin = Math.min(into.ValidationScore, absorbed.ValidationScore)
      // 浅拷贝候选态：门控绝不能先把 `into` 改了（Go:752 `candidate := *into`）。
      const candidate: SkillNode = {
        ...into,
        Score: merged,
        Triggers: mergeTriggers(into.Triggers, absorbed.Triggers),
        Fix: mergeFix(into.Fix, absorbed.Fix),
      }
      const result = this.evaluator.Evaluate(candidate)
      // 只在「真跑过验证集」时门控；"no validation set available" 这类兜底原因不算拦。
      if (isEvalReady(result) && result.Score < beforeMin) {
        into.RejectedAttempts++
        this.pushRejected(into.ID)
        return AbsorbOutcome.RejectedValidation
      }
    }

    // ── 应用规则 1-6 ──
    // 规则 1：into.ID / into.Principle 不动（本函数确实没碰它们）。
    into.Triggers = mergeTriggers(into.Triggers, absorbed.Triggers) // 规则 2
    into.Fix = mergeFix(into.Fix, absorbed.Fix) // 规则 3
    if (!into.MergedFrom.includes(absorbedID)) {
      // 规则 4
      into.MergedFrom = [...into.MergedFrom, absorbedID]
    }
    into.Score = merged // 规则 5
    // 规则 6：Source 不动（没有赋值就是不动，别手贱补一句 downgrade）。

    // 标记被吸收方：status + AbsorbedBy + 从 prinIndex 摘掉。
    absorbed.Status = SkillStatus.Absorbed
    absorbed.AbsorbedBy = intoID
    // ★★补 D3b（**这是我们补的，Go 里没有**）：Go 这里**不检查**该键当前指向谁，
    //    直接 `delete(prinIndex, norm(absorbed.Principle))` ⇒ 两节点 principle 相同、
    //    且索引键此刻指向 **into** 时，会把 **into 自己的索引删掉**（Tier-1 落空）。
    //    ★ 复现（见 test/skill-tree.test.mjs「D3b」）：principle 取 `'pdf'`（1 token、≤20 字节）
    //      让 Tier-2/Tier-3 都兜不住 ⇒ `findByPrinciple('pdf')` 从 `skill-into` 变成 `undefined`。
    //    这是「确定的坏」（误删活节点的索引）⇒ 补成**只删确实指向 absorbed 的那一条**。
    const absorbedKey = normalizePrinciple(absorbed.Principle)
    if (this.prinIndex.get(absorbedKey) === absorbedID) this.prinIndex.delete(absorbedKey)

    return AbsorbOutcome.Succeeded
  }

  /** `Meta.RejectedEdits` 环形缓冲（skill_tree.go:463-466）。 */
  private pushRejected(id: string): void {
    this.Meta.RejectedEdits.push(id)
    if (this.Meta.RejectedEdits.length > REJECTED_EDITS_MAX) {
      this.Meta.RejectedEdits = this.Meta.RejectedEdits.slice(-REJECTED_EDITS_MAX)
    }
  }

  // ── Create（skill_tree.go:269）────────────────────────────────────────────

  /**
   * 新建技能；命中既有 principle 时**返回既有节点**（去重，UseCount++ 并追加 triggers）。
   *
   * ⚠️ 移植告警 W3：`sanitizeID`（builder.go:1194，本文件走它）与
   *    `sanitizeName`（skill_import.go:331，导入路径走它）是**两套不一致**的净化器：
   *      · `:` 在 sanitizeID 里 → `-`，在 sanitizeName 里 → **丢弃**
   *      · `--` 折叠只有 sanitizeName 做；80 字节截断只有 sanitizeID 做
   *    ⇒ 同一 skill 走 Create 与走 Import **可能得到两个不同 ID**。照搬（改名打断既有数据）。
   */
  create(
    source: string,
    principle: string,
    fix: string,
    triggers: readonly string[],
    brain: string,
  ): SkillNode {
    const existingID = this.findByPrinciple(principle)
    if (existingID !== undefined) {
      const node = this.Nodes.get(existingID)
      if (node) {
        node.UseCount++
        node.LastUsedAt = nowStamp()
        node.Triggers = mergeTriggers(node.Triggers, triggers)
        return node
      }
    }

    let id = 'skill-' + sanitizeID(principle)
    if (id === 'skill-') id = 'skill-' + sanitizeID(triggers.join('-'))
    // ⚠️ 移植告警 W2：全非 ASCII（中文）principle 经 sanitizeID 后是 `""` ⇒ `skill-`
    //    ⇒ 退化到 triggers 拼接；再空就退化到 **时间戳后缀**（skill_tree.go:300 `randomSuffix`）
    //    ⇒ **ID 不可复现**：同样的输入两次 Create 得到两个不同 ID，
    //      进而 Tier-1 索引各建各的 ⇒ 中文技能**永远无法被去重**。照搬，修它要单独立项。
    if (id === 'skill-') id = 'skill-' + randomSuffix()

    const ts = nowStamp()
    const node = newSkillNode()
    node.ID = id
    node.Source = source
    node.Brain = brain
    node.Status = SkillStatus.Active
    node.Level = 1
    node.Score = initialScore(source)
    node.SuccessRate = 0.5
    node.Principle = principle
    node.Fix = fix
    node.Triggers = [...triggers]
    node.CreatedAt = ts
    node.LastUsedAt = ts
    this.Nodes.set(id, node)
    this.setPrinIndex(id, principle)
    return node
  }

  // ── MergeRemote（skill_tree.go:330）───────────────────────────────────────

  /**
   * 跨脑同步，同样三级去重：
   *  1. ID 精确命中 → UseCount++ / 本地 Fix 为空则采纳远端 / 脑不一致则清空 Brain / 补 Tools
   *  2. principle 命中（不同 ID）→ 同上，并把远端 ID 挂进 `MergedFrom`
   *  3. 全新 → 建 source="shared" 节点，**初分写死 0.30**（不是 `initialScore("shared")` 的 .55！
   *     照 Go:390，跨脑来的要先过注册门再说）
   */
  mergeRemote(
    id: string,
    principle: string,
    fix: string,
    brain: string,
    tools: readonly ToolDef[] = [],
  ): void {
    const existing = this.Nodes.get(id)
    if (existing) {
      this.adoptRemote(existing, fix, brain, tools)
      return
    }
    const byPrinciple = this.findByPrinciple(principle)
    if (byPrinciple !== undefined) {
      const node = this.Nodes.get(byPrinciple)
      if (node) {
        this.adoptRemote(node, fix, brain, tools)
        if (!node.MergedFrom.includes(id)) node.MergedFrom = [...node.MergedFrom, id]
        return
      }
    }
    const ts = nowStamp()
    const node = newSkillNode()
    node.ID = id
    node.Source = SkillSource.Shared
    node.Brain = ''
    node.Score = 0.3
    node.Principle = principle
    node.Fix = fix
    node.Triggers = extractTriggerTokens(principle)
    node.Tools = [...tools]
    node.CreatedAt = ts
    node.LastUsedAt = ts
    this.Nodes.set(id, node)
    this.setPrinIndex(id, principle)
  }

  /** MergeRemote Tier-1/2 的公共部分（skill_tree.go:336-347 / 354-376）。 */
  private adoptRemote(
    node: SkillNode,
    fix: string,
    brain: string,
    tools: readonly ToolDef[],
  ): void {
    node.UseCount++
    node.LastUsedAt = nowStamp()
    if (fix !== '' && node.Fix === '') node.Fix = fix
    if (node.Brain !== '' && node.Brain !== brain) node.Brain = ''
    if (node.Tools.length === 0 && tools.length > 0) node.Tools = [...tools]
  }

  // ── Score → recordUse（skill_tree.go:406）─────────────────────────────────

  /**
   * 用后评分：命中 +0.02 / 未中 −0.05，并滚动更新 success_rate。
   *
   * ★ 2026-08-13 的坑（Go 注释原话）：评分回调传的是 **skill name**（如 `"pdf"`），
   *   而节点 ID 是 `"skill-pdf"`；当年直接查 `Nodes[skillID]` 找不到 ⇒ **评分静默失效**
   *   （use_count 永远 0）。⇒ **必须**走 `findByName` 的兼容匹配，别图省事直接 get。
   */
  recordUse(skillID: string, success: boolean): void {
    let node = this.Nodes.get(skillID)
    if (!node) {
      const byName = this.findByName(skillID)
      if (!byName) return
      node = byName
    }
    node.UseCount++
    node.LastUsedAt = nowStamp()

    if (success) {
      node.Score += 0.02
      node.SuccessRate = (node.SuccessRate * (node.UseCount - 1) + 1.0) / node.UseCount
    } else {
      node.Score -= 0.05
      node.SuccessRate = (node.SuccessRate * (node.UseCount - 1)) / node.UseCount
    }
    if (node.Score > 1.0) node.Score = 1.0
    if (node.Score < 0.0) node.Score = 0.0

    // 分数变化后的自动升降级（skill_tree.go:437-443）。
    if (node.Score >= 0.7 && node.UseCount >= 10 && node.Level < 3) node.Level = 3
    if (node.SuccessRate < 0.3 && node.UseCount >= 5) node.Status = SkillStatus.Demoted
  }

  // ── Lookup（skill_tree.go:970-1043）───────────────────────────────────────

  get(id: string): SkillNode | undefined {
    return this.Nodes.get(id)
  }

  findBySourceFile(path: string): SkillNode | undefined {
    for (const node of this.Nodes.values()) {
      if (node.SourceFile === path) return node
    }
    return undefined
  }

  /**
   * Go `findByNameNoLock`（:1000）：精确 ID → 归一化（`_`→`-`，小写）→
   * 带/不带 `skill-` 前缀再各试一轮。**别丢这段兼容**（见 `recordUse` 的注释）。
   */
  findByName(name: string): SkillNode | undefined {
    const exact = this.Nodes.get(name)
    if (exact) return exact
    const norm = name.toLowerCase().split('_').join('-')
    for (const [id, node] of this.Nodes) {
      if (id.toLowerCase().split('_').join('-') === norm) return node
    }
    if (norm.startsWith('skill-')) {
      const short = norm.slice(6)
      for (const [id, node] of this.Nodes) {
        if (id.toLowerCase().split('_').join('-') === short) return node
      }
    } else {
      const prefixed = 'skill-' + norm
      for (const [id, node] of this.Nodes) {
        if (id.toLowerCase().split('_').join('-') === prefixed) return node
      }
    }
    return undefined
  }

  /** Go `AllNodes`（:1032）：过滤 archived（**不过滤 absorbed** —— 它要留在审计视图里）。 */
  allNodes(): SkillNode[] {
    const out: SkillNode[] = []
    for (const node of this.Nodes.values()) {
      if (node.Status === SkillStatus.Archived) continue
      out.push(node)
    }
    return out
  }
}
