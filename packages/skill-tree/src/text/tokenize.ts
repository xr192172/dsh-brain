/**
 * L0 纯函数层：分词 / 相似度 / ID 净化 / 合并原语（2026-09-20）
 *
 * 来源（只读，不改）：`ai-base/agent-shell/internal/memory/`
 *   · skill_tree.go  :841 tokenizePrinciple · :856 jaccard · :871 isStopword
 *                     :807 mergeTriggers · :827 mergeFix
 *   · heat.go        :471 normalizePrinciple
 *   · retriever.go   :485 tokenize
 *   · sleep.go       :953 extractTriggerTokens
 *   · builder.go     :1194 sanitizeID      ← builder.go 整体「不移植」（port-plan §2），
 *                                            但 skill_tree.go:295/1208 依赖它 ⇒ 按计划摘出到 L0
 *   · skill_import.go:331 sanitizeName     ← 被 skill_tree.go:1182 反向依赖 ⇒ 同归 L0
 *   · gravity_field.go:223 jaccardFromSets ← 与 jaccard 逐行等价，导出别名即可
 *
 * 依据：`docs/skill-tree-port-plan.md` §3（依赖顺序）/ §7.1（下一步第一条）。
 *
 * ★★ 本文件的存在理由 = **钉死口径**。`findByPrinciple` / `findSimilar` / `Absorb`
 *    三条路共用这里的每一个函数。口径一漂，去重结果就**不可复现**，
 *    而「能不能复现」正是融合判据 L2 的命根子。
 *    ⇒ **改任何一个常量/边界，都等于改去重结果**，必须单独立项 + 全量回归。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【口径清单】以下每条都被 `test/tokenize.test.mjs` 钉住，改动必须同步改测
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A. 通用
 *  A1 **长度一律按 UTF-8 字节**（照 Go `len(string)`），不是 JS 的 UTF-16 `.length`。
 *     差异只在非 ASCII 上出现：一个汉字 = 3 字节。
 *     ⇒ 本文件统一走 `byteLen()`；**禁止**在这里用 `s.length` 判长短。
 *  A2 切字节时（sanitizeID 的 80、3-gram 的 60）按 **rune 边界**回收，
 *     不切出半个 rune。Go 的 `s[:80]` 会切出非法 UTF-8（见 D3/D4，已知缺陷）。
 *
 * B. tokenizePrinciple（去重主口径）
 *  B1 分隔符 = 「非 `[a-zA-Z0-9]`」的**任意**字符（含空格、标点、以及**全部 CJK**）。
 *  B2 转小写后 `len(w) <= 2` 的词**丢弃**（字节口径，见 A1）。
 *  B3 命中 stopword（50 个）丢弃。**注意与 B2 重叠**：`a/an/is/no/to/of/in/on/at/by/as`
 *     长度已 ≤2，先被 B2 干掉 —— 列表里这部分是死代码，但**保留不动**（照 Go）。
 *  B4 返回**集合**（去重），无序；Go 侧是 map，故 jaccard 与迭代顺序无关。
 *  B5 ★ **CJK 整体消失**：汉字全是非 `[a-zA-Z0-9]` ⇒ 只当分隔符，永不成为 token。
 *     纯中文 principle ⇒ 空集 ⇒ jaccard 恒 0 ⇒ `findSimilar` 恒返回空
 *     （Tier-2 完全失效，只剩 Tier-3 子串兜底）。**这是 Go 侧的已知缺陷**，
 *     但去重结果依赖它 ⇒ **照搬**，改动必须单独立项（会改变既有 skill_tree.json 的判定）。
 *
 * C. jaccard / jaccardFromSets
 *  C1 `|A∩B| / |A∪B|`；**两集合都空时返回 0**（不是 NaN，不是 1）。
 *  C2 阈值：`findByPrincipleLocked` Tier-2 用 **严格 > 0.5**；`FindSimilar` 用 **>= minJaccard**。
 *     两个阈值语义不同，别混。
 *  C3 Go 里 `jaccard`（skill_tree.go:856）与 `jaccardFromSets`（gravity_field.go:223）
 *     是**两份重复实现**，后者多一个 `union == 0` 分支 —— 该分支在数学上不可达
 *     （两集合都空已在前面 return 0），故**两者语义完全等价**，这里共存一份实现。
 *
 * D. 三个「看起来对、其实是 bug」的地方 —— **照搬 + 显式标注**，不擅自修
 *  D1 `normalizePrinciple` 的填充词删除是**朴素子串替换**（带尾空格）：
 *     `"validate data flow"` 里的 `"a "` 会被命中 ⇒ 得到 `"validate datflow"`。
 *     同理 `"human "` → `"hum "` ⇒ `"hum"`。语义已坏，但它是 Tier-1 索引键 ⇒ **照搬**。
 *  D2 `sanitizeID` 与 `sanitizeName` 是**两套不一致**的净化器：
 *     `:` 在 sanitizeID 里 → `-`，在 sanitizeName 里 → 丢弃；
 *     `--` 折叠只有 sanitizeName 做，sanitizeID 不做；sanitizeID 有 80 字节截断，
 *     sanitizeName 没有。⇒ 同一 skill 走 Create(sanitizeID) 与走 Import(sanitizeName)
 *     **可能得到两个不同 ID**。**照搬**（改名会打断既有数据）。
 *  D3 全非 ASCII 输入（如中文 principle）经 sanitizeID 后是 `""` ⇒ `skill-` ⇒
 *     Create 会退化到 `randomSuffix()`（时间戳）⇒ **ID 不可复现**。见 test 中的固定用例。
 *  D4 `extractTriggerTokens` 的 3-gram 兜底在 Go 里按**字节**切，混合 ASCII/非 ASCII
 *     时会切出非法 UTF-8（mojibake）。本实现按 rune 边界取块 ⇒ 仅在
 *     「含 2 字节 rune 且触发兜底」的极窄路径上与 Go 有差异，已在注释与测试中标注。
 *
 * E. 两个分词器**不是**一个东西，别合并
 *  E1 `tokenizePrinciple`：用于**去重**（B 组口径，有 stopword、有集合去重、丢 ≤2 字节）。
 *  E2 `tokenize`（retriever.go:485）：用于**关键词检索**。只按 7 个分隔符切
 *     （空格 `,` `.` `;` `?` `!` `\n`），**无 stopword 过滤、无去重、保留重复项**。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 内部：UTF-8 字节口径（A1 / A2）
// ─────────────────────────────────────────────────────────────────────────────

/** 单个码点的 UTF-8 字节数。与 Go rune 编码一致（代理对算 1 个码点 = 4 字节）。 */
function codePointBytes(cp: number): number {
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}

/** 字符串的 UTF-8 字节数 = Go 的 `len(s)`。**本文件所有长度判定都走它**（A1）。 */
export function byteLen(s: string): number {
  let n = 0
  // for..of 按码点迭代：代理对算一次，与 Go 的 range string 对齐
  for (const ch of s) n += codePointBytes(ch.codePointAt(0) as number)
  return n
}

/** 按字节截断到 n，**不切出半个 rune**（A2）。超长的那个码点整个丢弃。 */
function byteTruncate(s: string, n: number): string {
  let out = ''
  let used = 0
  for (const ch of s) {
    const sz = codePointBytes(ch.codePointAt(0) as number)
    if (used + sz > n) break
    out += ch
    used += sz
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. tokenizePrinciple / jaccard / isStopword（去重主口径）
// ─────────────────────────────────────────────────────────────────────────────

/** skill_tree.go:871 —— 无领域信号的英文常用词。共 50 个，照抄不增删。 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those', 'it', 'its', 'and', 'or',
  'but', 'not', 'no', 'to', 'of', 'in', 'for', 'on', 'with',
  'at', 'by', 'from', 'as', 'can', 'will', 'would', 'should',
  'has', 'have', 'had', 'do', 'does', 'did', 'when', 'where',
  'which', 'who', 'what', 'how', 'all', 'any', 'each', 'every',
])

/** 是否停用词。注意与「长度 ≤2 → 丢弃」规则重叠（B3），重叠部分是 Go 的死代码，保留。 */
export function isStopword(w: string): boolean {
  return STOPWORDS.has(w)
}

/**
 * skill_tree.go:841 —— principle 分词。
 *
 * 口径 B1~B5：分隔符 = 非 `[a-zA-Z0-9]`；丢弃字节长度 ≤2 的词；丢弃 stopword；返回集合。
 * ★ CJK 不会成为 token（B5）—— 这是 Go 侧既有行为，**去重结果依赖它**。
 */
export function tokenizePrinciple(s: string): Set<string> {
  const tokens = new Set<string>()
  // 非 [a-zA-Z0-9] 一律当分隔符。汉字/假名/emoji 全在此列 ⇒ 永不入集（B5）
  for (const w of s.split(/[^a-zA-Z0-9]/)) {
    if (w === '') continue
    const t = w.toLowerCase()
    if (byteLen(t) <= 2 || isStopword(t)) continue
    tokens.add(t)
  }
  return tokens
}

/**
 * skill_tree.go:856 / gravity_field.go:223 —— 集合 Jaccard 相似度。
 *
 * 口径 C1：两集合都空 ⇒ **返回 0**（不是 NaN / 1）。
 * Go 侧 `jaccardFromSets` 多一个 `union == 0` 分支，数学上不可达 ⇒ 语义等价（C3）。
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  if (union === 0) return 0
  return intersection / union
}

/** gravity_field.go:223 的同名入口；与 `jaccard` 逐行等价（C3），保留名字便于逐行核对。 */
export const jaccardFromSets = jaccard

// ─────────────────────────────────────────────────────────────────────────────
// 2. normalizePrinciple（Tier-1 索引键 + Tier-3 子串判据）
// ─────────────────────────────────────────────────────────────────────────────

/** heat.go:471 的填充词，**顺序敏感**（先删 the，再 a/an/this/that），每个都带尾空格。 */
const FILLER_WORDS: readonly string[] = ['the ', 'a ', 'an ', 'this ', 'that ']

/**
 * heat.go:471 —— principle 归一化（小写 → TrimSpace → 删填充词）。
 *
 * ★ 口径 D1（已知缺陷，照搬）：删填充词是**朴素子串替换**，会误伤词尾：
 *   `"validate data flow"` → `"validate datflow"`（`"data "` 里的 `"a "` 被删）；
 *   `"human loop"` → `"hum loop"`。
 *   它是 `prinIndex` 的键（Tier-1）与 Tier-3 子串的输入 —— **改它会改既有数据的判定**。
 * ★ 调用方 `findByPrincipleLocked` 的 Tier-3 用 `len(norm) > 20`：**字节**口径（A1），
 *   即 7 个汉字（21 字节）能进 Tier-3，7 个英文字母不能。
 */
export function normalizePrinciple(p: string): string {
  let s = p.toLowerCase().trim()
  for (const w of FILLER_WORDS) s = s.split(w).join('')
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. tokenize（retriever.go:485 —— 检索用，**与 tokenizePrinciple 不是一回事**，E2）
// ─────────────────────────────────────────────────────────────────────────────

/** retriever.go:485 的分隔符：只有这 7 个。注意**不含** `\t` `\r` `-` `_` `/`。 */
const RETRIEVER_SEPARATORS = /[ ,.;?!\n]/

/**
 * retriever.go:485 —— 检索用分词。
 *
 * 口径 E2：先整体小写；只按 7 个分隔符切；保留字节长度 >2 的词；
 * **无 stopword 过滤、无去重（保留重复项）、CJK 会保留**（跟 tokenizePrinciple 相反）。
 */
export function tokenize(s: string): string[] {
  const out: string[] = []
  for (const w of s.toLowerCase().split(RETRIEVER_SEPARATORS)) {
    if (byteLen(w) > 2) out.push(w)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. sanitizeID / sanitizeName（ID 净化 —— 两套不一致，D2）
// ─────────────────────────────────────────────────────────────────────────────

/** sanitizeID 的截断上限（builder.go:1206）：**80 字节**。 */
export const MAX_ID_BYTES = 80

/**
 * builder.go:1194 —— 生成 `skill-<id>` 的后半段（skill_tree.go:295/1208 用）。
 *
 * 口径：小写 → 逐 rune 映射（保留 `[a-z0-9-]`；空格/冒号/下划线 → `-`；其余**丢弃**）
 *       → 截断 80 字节 → 修剪首尾 `-`。
 * ★ 映射后只剩 ASCII ⇒ `slice(0, 80)` 与 Go 的 `s[:80]` 字节截断等价（A2 不会切到 rune）。
 * ★ D3：全中文输入 ⇒ `""` ⇒ 调用方退化到 `randomSuffix()` ⇒ **ID 不可复现**。
 * ★ D2：不折叠 `--`（sanitizeName 折叠）⇒ 两个净化器不同构。
 */
export function sanitizeID(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-') {
      out += ch
    } else if (ch === ' ' || ch === ':' || ch === '_') {
      out += '-'
    } // 其余（含全部 CJK）丢弃
  }
  // 映射后只剩 ASCII，故按码点截 80 个 == 截 80 字节
  return out.slice(0, MAX_ID_BYTES).replace(/^-+/, '').replace(/-+$/, '')
}

/**
 * skill_import.go:331 —— 导入路径的 ID 段（skill_tree.go:1182 / skill_import.go:160 用）。
 *
 * 口径：小写 → ` `→`-` → `_`→`-` → 逐**字节**过滤（只留 `[a-z0-9-]`，非 ASCII 字节全丢）
 *       → 反复折叠 `--` → 修剪首尾 `-`。
 * ★ D2：与 sanitizeID 的三处差异 —— `:` 是**丢弃**而非变 `-`；折叠 `--`；**无 80 截断**。
 */
export function sanitizeName(name: string): string {
  let s = name.toLowerCase().split(' ').join('-').split('_').join('-')
  let filtered = ''
  for (const ch of s) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-') filtered += ch
  }
  while (filtered.includes('--')) filtered = filtered.split('--').join('-')
  return filtered.replace(/^-+/, '').replace(/-+$/, '')
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. extractTriggerTokens（sleep.go:953 —— 兜底触发词）
// ─────────────────────────────────────────────────────────────────────────────

/** sleep.go:967 兜底路径的截断上限：**60 字节**；最多返回 5 个 token。 */
export const TRIGGER_FALLBACK_BYTES = 60
export const MAX_TRIGGER_TOKENS = 5

/**
 * sleep.go:953 —— 把 pattern 切成触发词（skill_tree.go:395 MergeRemote 也用）。
 *
 * 口径：按 `unicode.IsSpace || unicode.IsPunct` 切 → 小写 → 去重 → 保留字节长度 >2
 *       → **最多 5 个**（满 5 立即 break）。
 * 兜底：一个词都没剩下时，取小写后的前 60 字节，切成 **3 字节一块**（尾部不足 3 字节的
 *       残余**丢弃**，照 Go `i <= len-3`），最多 5 块。
 * ★ D4：Go 按字节切块，混合 ASCII/非 ASCII 会切出非法 UTF-8；本实现按 rune 边界取块
 *       （≥3 字节即成块），纯 ASCII 与纯 CJK 下与 Go 完全一致，仅在含 2 字节 rune
 *       （如 é/希腊字母）且触发兜底时有差异。
 */
export function extractTriggerTokens(pattern: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const raw of pattern.split(/[\s\p{P}]/u)) {
    if (raw === '') continue
    const w = raw.toLowerCase().trim()
    if (byteLen(w) <= 2 || seen.has(w)) continue
    seen.add(w)
    tokens.push(w)
    if (tokens.length >= MAX_TRIGGER_TOKENS) break
  }
  if (tokens.length > 0) return tokens

  // ── 兜底：3 字节一块的滑动切成块（D4）──
  const lower = byteTruncate(pattern.toLowerCase(), TRIGGER_FALLBACK_BYTES)
  const chunks: string[] = []
  let cur = ''
  let curSize = 0
  for (const ch of lower) {
    cur += ch
    curSize += codePointBytes(ch.codePointAt(0) as number)
    if (curSize >= 3) {
      chunks.push(cur)
      cur = ''
      curSize = 0
      if (chunks.length >= MAX_TRIGGER_TOKENS) break
    }
  }
  // 尾部不足 3 字节的残余：Go 侧因为 `i <= len-3` 而丢弃 ⇒ 这里同样丢弃
  return chunks
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 合并原语（Absorb 规则 2/3）
// ─────────────────────────────────────────────────────────────────────────────

/** Absorb 规则 3 的连接符（skill_tree.go:830）。改它会改既有 Fix 文本 ⇒ 钉死。 */
export const FIX_SEPARATOR = '\n\n---\n\n'

/** skill_tree.go:807 —— 追加合并 triggers，**保序去重**，不改入参，返回新数组。 */
export function mergeTriggers(dst: readonly string[], src: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of dst) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  for (const t of src) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** skill_tree.go:827 —— 双方都非空时用 `FIX_SEPARATOR` 连接；有一方空就返回另一方；都空返回 ""。 */
export function mergeFix(a: string, b: string): string {
  if (a === '') return b
  if (b === '') return a
  return a + FIX_SEPARATOR + b
}
