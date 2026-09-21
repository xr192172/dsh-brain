/**
 * measure-delegation-reuse.mjs —— 委派复用度量 v2（离线，零运行时改动）
 *
 * 回答一个具体问题：**fork 子代理的首次请求，到底吃到了多少父代前缀缓存？**
 * 数据源：~/.dsh/sessions/<dir>/<session>/session.jsonl.zstd（多帧 zstd，fzstd 解）
 *
 * 判据（dsh-llm 的 TokenUsage 契约，四桶 disjoint）：
 *   命中率 = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
 *
 * ★ v2 的关键升级：**归因**
 *   子会话里有 `subagent/descriptor` 事件，逐字写着：
 *     {"version":2,"mode":"one-shot","provider":"fork","label":"..."}
 *     {"version":2,"mode":"continuable","provider":"spawn","label":"..."}
 *   ⇒ fork / spawn 是**日志里可读的事实**，不是猜测 ⇒ 可做自然 A/B。
 *
 * 控制变量（缺一个，结论就不成立）：
 *   1. 父/子是否**同一 provider+model**（缓存只在同模型内复用）
 *   2. 父/子 `agentPreset` 是否相同（不同 ⇒ system 前缀不同，命中本来就该低）
 *   3. 父/子 `request/header.system` 的**公共前缀长度**（直接量"前缀重合"）
 *   4. 父最后一次请求 → 子第一次请求的**时间间隔**（缓存有 TTL）
 *
 * ★ v3 增加三段（对应 out/w8-o11-fix-report.md；**旧口径一律保留，只做并列**）：
 *   改动1 usage 两源归并：`assistant/chunk{type:'usage'}` 与 `assistant/message.usage` 是**同一 step 的两阶段**，
 *          按 `(turn,step)` 归并时**后者替换前者、不相加**（message 是该 step 的终样本）。旧口径（仅 message）与新口径并列 + 差值。
 *   改动2 子代账切「种子份 / 分身自己」：切分标记用 `header.seedLength`（候选 A，实测存在的唯一权威边界；
 *          候选 B `session/end-seed` 的实测理由见输出里「切分标记普查」段）。
 *   改动3 负对照：spawn 子代的种子份应为 0、fork 子代应为 >0，末行打印 negative control passed = true/false。
 *
 * 用法：
 *   node scripts/measure-delegation-reuse.mjs
 *   node scripts/measure-delegation-reuse.mjs --by-provider   # 按 fork/spawn 分组对比
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/delegation-reuse.txt'
const BY_PROVIDER = process.argv.includes('--by-provider')

function listSessions() {
  const found = []
  for (const proj of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const pp = path.join(ROOT, proj.name)
    let subs = []
    try { subs = fs.readdirSync(pp, { withFileTypes: true }) } catch { continue }
    for (const s of subs) {
      if (!s.isDirectory()) continue
      const f = path.join(pp, s.name, 'session.jsonl.zstd')
      if (fs.existsSync(f)) found.push({ proj: proj.name, dir: s.name, file: f })
    }
  }
  return found
}

function readEvents(file) {
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8') } catch { return null }
  return text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const pct = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%')
const pad = (s, n) => String(s ?? '').padEnd(n)
const trunc = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s)

/** 两个字符串的公共前缀长度 */
function lcp(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function pickUsage(e) {
  for (const c of [e?.data?.usage, e?.usage, e?.data?.message?.usage]) {
    if (c && typeof c === 'object' && ('inputTokens' in c || 'cacheReadTokens' in c)) return c
  }
  return null
}

/* ══════════════════════════════════════════════════════════════════════════
 * ★ 改动1：usage 两源归并（新增；旧口径一律保留）
 *   来源一：assistant/chunk { data.chunk.type === 'usage' }   —— 早样本（请求失败也留得下）
 *   来源二：assistant/message.usage                           —— 该 step 的终样本（committed step）
 *   归并键：(turn, step)；重复样本 **替换** 而非相加 ⇒ message 覆盖 chunk。
 *   （上游口径见 packages/llm/token-meter/src/usage-projection.ts:100-105 的 addReplacing）
 * ══════════════════════════════════════════════════════════════════════════ */
const ZERO_U = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
const bucketsOf = (u) => ({
  inputTokens: num(u?.inputTokens), cacheReadTokens: num(u?.cacheReadTokens),
  cacheWriteTokens: num(u?.cacheWriteTokens), outputTokens: num(u?.outputTokens),
})
const addU = (a, b) => ({
  inputTokens: a.inputTokens + b.inputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens, outputTokens: a.outputTokens + b.outputTokens,
})
const isZeroU = (u) => u.inputTokens === 0 && u.cacheReadTokens === 0 && u.cacheWriteTokens === 0 && u.outputTokens === 0
const fmtU = (u) => `in=${u.inputTokens} cr=${u.cacheReadTokens} cw=${u.cacheWriteTokens} out=${u.outputTokens}`

/** 收集一个事件切片上的 (turn,step) → usage：message 优先覆盖 chunk */
function collectMergedU(evs) {
  const st = { chunkSamples: 0, msgSamples: 0, both: 0, chunkOnly: 0, msgOnly: 0, unequal: 0 }
  const chunkOnlyList = []
  const chunkMap = new Map()
  for (const e of evs) {
    if (e.type === 'assistant/chunk' && e.data?.chunk?.type === 'usage') {
      chunkMap.set(`${e.data.turn}/${e.data.step}`, e.data.chunk.usage)
      st.chunkSamples++
    }
  }
  const msgMap = new Map()
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const u = pickUsage(e)
    if (!u) continue
    msgMap.set(`${e.data?.turn}/${e.data?.step}`, u)
    st.msgSamples++
  }
  const merged = new Map()
  for (const k of new Set([...chunkMap.keys(), ...msgMap.keys()])) {
    const c = chunkMap.get(k), m = msgMap.get(k)
    if (c && m) { st.both++; if (fmtU(bucketsOf(c)) !== fmtU(bucketsOf(m))) st.unequal++ }
    else if (c) { st.chunkOnly++; chunkOnlyList.push({ key: k, buckets: bucketsOf(c) }) }
    else st.msgOnly++
    merged.set(k, bucketsOf(m ?? c)) // ★ message 优先（终样本替换早样本）
  }
  return { map: merged, stats: st, chunkOnlyList }
}
const sumMergedU = (map) => { let t = ZERO_U; for (const u of map.values()) t = addU(t, u); return t }
const sumBucketsOf = (list) => { let t = ZERO_U; for (const u of list) if (u) t = addU(t, bucketsOf(u)); return t }
const dueOf = (u) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens

/* ══════════════════════════════════════════════════════════════════════════
 * ★ 改动2：切分标记 —— 用哪个来切「种子份 / 分身自己」
 *   候选 A = header.seedLength；候选 B = 最后一个 session/end-seed 的 seq。
 *   实测（见输出「切分标记普查」段）：两者都真实存在 ⇒ 按题设**优先 A**，理由：
 *     · A 是 **DURABLE fork-lineage boundary**（上游 docs/subsystems/session.md:392-395），
 *       且 fork 就是写它（session.md:536 "deep-cloned seed events plus child metadata
 *       (parentSession, seedLength, …)"）；它的值是**父代 fork 时刻的 seq**
 *       （上游 packages/goal/goal/tests/goal.spec.ts:187 `expect(child.session.header.seedLength)
 *       .toBe(parent.session.seq)`）⇒ 切成 `seq <= seedLength` 是精确的、按 fork 事件定位的边界。
 *     · B 的 end-seed 是**任何**构造种子的收尾（resume / fork / replay 都写，session.md:585），
 *       实测 90 个会话有它、且**绝大多数落在日志末尾**（lastEndSeq === maxSeq）⇒ 用 B 会把
 *       「本会话自己的工作」整段算进种子份、分身自己恒为 0，对"新增开销"没有分辨力。实测数字见输出。
 *   缺 A 时 **不近似**：seedLength 缺键 ⇒ 种子份 = 0（无 fork 血脉），不拿 B 顶替。
 * ══════════════════════════════════════════════════════════════════════════ */
const SEED_MARKER = 'header.seedLength'

const rows = []
for (const s of listSessions()) {
  const evs = readEvents(s.file)
  if (!evs || !evs.length) continue
  const head = evs.find((e) => e.type === 'session') ?? evs[0]
  const msgs = evs.filter((e) => e.type === 'assistant/message')
  const usages = msgs.map(pickUsage)
  const maxSeq = evs.reduce((a, e) => (typeof e.seq === 'number' ? Math.max(a, e.seq) : a), -1)

  // descriptor：fork / spawn 的权威来源
  const desc = evs.find((e) => e.type === 'subagent/descriptor')?.data ?? {}
  // request/header：模型真实看到的东西（system + tools）
  const hdr = evs.find((e) => e.type === 'request/header')?.data?.header ?? {}
  const cfg = hdr.config ?? {}

  const sum = (f) => usages.reduce((a, u) => a + (u ? num(f(u)) : 0), 0)
  const totalIn = sum((u) => u.inputTokens)
  const totalCacheRead = sum((u) => u.cacheReadTokens)
  const totalCacheWrite = sum((u) => u.cacheWriteTokens)
  const denom = totalIn + totalCacheRead + totalCacheWrite

  const firstIdx = usages.findIndex((u) => u)
  const first = firstIdx >= 0 ? usages[firstIdx] : null
  const firstMsg = firstIdx >= 0 ? msgs[firstIdx] : null
  const firstDenom = first ? num(first.inputTokens) + num(first.cacheReadTokens) + num(first.cacheWriteTokens) : 0

  const lastMsg = [...msgs].reverse().find((e) => pickUsage(e))

  // ── ★ 改动1：新口径（两源归并） ────────────────────────────────
  const { map: mergedMap, stats: mergeStats, chunkOnlyList } = collectMergedU(evs)
  const mergedTotals = sumMergedU(mergedMap)
  const oldTotals = sumBucketsOf(usages) // 旧口径 = 仅 assistant/message.usage
  const mergedSteps = mergedMap.size

  // ── ★ 改动2：种子份 / 分身自己 ────────────────────────────────
  const hasSeedLenKey = head != null && Object.prototype.hasOwnProperty.call(head, 'seedLength')
  const seedLength = hasSeedLenKey && typeof head.seedLength === 'number' ? head.seedLength : null
  const seqOf = (e) => (typeof e.seq === 'number' ? e.seq : null)

  // 候选 A：seq <= seedLength 属于 fork 血脉的种子；缺 seedLength ⇒ 种子为空（不近似）
  let seedA = ZERO_U, liveA = mergedTotals, slicedA = false
  if (seedLength !== null && seedLength > 0) {
    slicedA = true
    const seedEvs = evs.filter((e) => { const q = seqOf(e); return q !== null && q <= seedLength })
    const liveEvs = evs.filter((e) => { const q = seqOf(e); return q !== null && q > seedLength })
    seedA = sumMergedU(collectMergedU(seedEvs).map)
    liveA = sumMergedU(collectMergedU(liveEvs).map)
  }

  // 候选 B：最后一个 session/end-seed 的 seq；无 end-seed ⇒ 无种子边界 ⇒ 种子为空
  const endSeqs = evs.filter((e) => e.type === 'session/end-seed' && seqOf(e) !== null).map(seqOf)
  const lastEndSeq = endSeqs.length ? Math.max(...endSeqs) : null
  let seedB = ZERO_U, liveB = mergedTotals, slicedB = false
  if (lastEndSeq !== null) {
    slicedB = true
    const seedEvs = evs.filter((e) => { const q = seqOf(e); return q !== null && q <= lastEndSeq })
    const liveEvs = evs.filter((e) => { const q = seqOf(e); return q !== null && q > lastEndSeq })
    seedB = sumMergedU(collectMergedU(seedEvs).map)
    liveB = sumMergedU(collectMergedU(liveEvs).map)
  }

  rows.push({
    dir: s.dir,
    id: head?.id ?? null,
    depth: head?.delegationDepth ?? null,
    preset: head?.agentPreset ?? null,
    parent: head?.parentSession ?? null,
    origin: head?.origin ?? null,
    createdAt: head?.createdAt ?? null,
    // 委派身份
    prov: desc.provider ?? null,          // ★ fork / spawn / 其他
    mode: desc.mode ?? null,              // one-shot / continuable
    agentModel: desc.agentModel ?? null,
    // 真实请求面
    model: cfg.model ?? null,
    provider: cfg.provider ?? null,
    systemLen: typeof hdr.system === 'string' ? hdr.system.length : null,
    system: hdr.system ?? null,
    toolsCount: Array.isArray(hdr.tools) ? hdr.tools.length : null,
    steps: msgs.length,
    totalIn, totalCacheRead, totalCacheWrite,
    hit: denom ? totalCacheRead / denom : null,
    firstSeq: firstMsg?.seq ?? null,
    firstTime: firstMsg?.time ?? null,
    firstIn: first ? num(first.inputTokens) : null,
    firstCacheRead: first ? num(first.cacheReadTokens) : null,
    firstHit: firstDenom ? num(first.cacheReadTokens) / firstDenom : null,
    lastTime: lastMsg?.time ?? null,
    // ── v3 新增 ──
    oldTotals, mergedTotals, mergedSteps, mergeStats, chunkOnlyList, maxSeq,
    hasSeedLenKey, seedLength, seedMarker: SEED_MARKER,
    endSeedN: endSeqs.length, lastEndSeq,
    seedA, liveA, slicedA, seedB, liveB, slicedB,
    totalA: addU(seedA, liveA), totalB: addU(seedB, liveB),
  })
}

const byId = new Map(rows.map((r) => [r.id, r]))
const pairs = []
for (const r of rows) {
  const p = r.parent ? byId.get(r.parent) : null
  if (p) pairs.push({ child: r, parent: p })
}

const L = []
L.push('=== 委派复用度量 v2（数据源：真实会话日志的 assistant/message.usage）===')
L.push(`扫描到会话: ${rows.length} 个；可配对父子: ${pairs.length} 对`)
L.push('')

// ── 父子配对明细（含全部控制变量）────────────────────────────
L.push('--- 父/子配对明细 ---')
for (const { child: c, parent: p } of pairs) {
  const gapSec = c.firstTime && p.lastTime ? ((c.firstTime - p.lastTime) / 1000).toFixed(0) : null
  const common = lcp(c.system, p.system)
  const commonPct = common !== null && c.systemLen ? ((common / c.systemLen) * 100).toFixed(1) + '%' : 'n/a'
  L.push(`■ child ${c.id}  provider=${c.prov}  mode=${c.mode}  depth=${c.depth}`)
  L.push(`  ← parent ${p.id}  depth=${p.depth}`)
  L.push(`  控制变量: 子模型=${c.provider}/${c.model}  父模型=${p.provider}/${p.model}  ` +
    `同模型=${c.model === p.model && c.provider === p.provider ? 'YES' : 'NO'}`)
  L.push(`            子preset=${c.preset}  父preset=${p.preset}  同preset=${c.preset === p.preset ? 'YES' : 'NO'}`)
  L.push(`            system 长度: 子=${c.systemLen} 父=${p.systemLen}  公共前缀=${common} (${commonPct})  工具数: 子=${c.toolsCount} 父=${p.toolsCount}`)
  L.push(`            父末请求→子首请求间隔=${gapSec ?? 'n/a'}s`)
  L.push(`  子首请求: 未缓存输入=${c.firstIn}  缓存读=${c.firstCacheRead}  命中率=${pct(c.firstHit)}`)
  L.push(`  父末轮  : 未缓存输入=${p.totalIn}  缓存读=${p.totalCacheRead}  总命中率=${pct(p.hit)}`)
  const v = c.firstHit === null ? '不可判定'
    : c.firstHit >= 0.5 ? '✅ 吃到父代前缀'
      : c.firstHit > 0.05 ? '⚠️ 部分命中' : '❌ 几乎零命中'
  L.push(`  裁决: ${v}`)
  L.push('')
}

// ── 按 provider 分组：fork vs spawn 的自然 A/B ────────────────
const grp = new Map()
for (const { child, parent } of pairs) {
  const k = `${child.prov ?? '(无descriptor)'}`
  if (!grp.has(k)) grp.set(k, [])
  grp.get(k).push({ child, parent })
}

L.push('=== ★ fork vs spawn 分组对比（自然 A/B）===')
for (const [prov, list] of [...grp.entries()].sort()) {
  const hits = list.map((x) => x.child.firstHit).filter((x) => x !== null)
  const avg = hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : null
  const reads = list.map((x) => num(x.child.firstCacheRead))
  L.push(`provider=${pad(prov, 14)} 样本=${list.length}  子首请求命中率均值=${pct(avg)}  ` +
    `缓存读=[${reads.join(', ')}]`)
  for (const { child, parent } of list) {
    const sameModel = child.model === parent.model && child.provider === parent.provider ? '同模型' : '异模型'
    const samePreset = child.preset === parent.preset ? '同preset' : `异preset(${parent.preset})`
    L.push(`    ${pad(child.id.slice(0, 8), 10)} ${pad(child.mode, 12)} ${pad(sameModel, 8)} ${pad(samePreset, 22)} ` +
      `首次命中=${pad(pct(child.firstHit), 8)} 缓存读=${child.firstCacheRead}`)
  }
  L.push('')
}

// ── ★ 交叉表：找真正的决定因子 ───────────────────────────────
// 候选因子（都可从日志读出）：工具集合是否一致 / system 公共前缀占比 / fork-or-spawn / mode
L.push('=== ★ 交叉表：哪个因子真正决定复用 ===')
const real = pairs.filter((x) => x.child.prov) // 排掉非委派的"新会话"配对
const bucket = (h) => (h === null ? 'n/a' : h >= 0.5 ? '高(≥50%)' : h > 0.05 ? '中(5~50%)' : '低(≤5%)')

function crosstab(name, keyFn, subset) {
  const m = new Map()
  for (const { child } of subset) {
    const k = keyFn(child)
    if (!m.has(k)) m.set(k, { hi: [], mid: [], lo: [], na: [] })
    const b = m.get(k)
    const h = child.firstHit
    if (h === null) b.na.push(child)
    else if (h >= 0.5) b.hi.push(child)
    else if (h > 0.05) b.mid.push(child)
    else b.lo.push(child)
  }
  L.push(`  [因子] ${name}`)
  for (const [k, b] of [...m.entries()].sort()) {
    const read = (xs) => xs.map((c) => num(c.firstCacheRead)).join(',') || '-'
    L.push(`    ${pad(k, 26)} 高=${pad(b.hi.length, 3)}中=${pad(b.mid.length, 3)}低=${pad(b.lo.length, 3)}` +
      `  缓存读: 高[${read(b.hi)}] 中[${read(b.mid)}] 低[${read(b.lo)}]`)
  }
  L.push('')
}

const FACTORS = [
  ['子/父工具数是否相同', (c) => {
    const p = byId.get(c.parent)
    if (!p || c.toolsCount === null || p.toolsCount === null) return '(不可比)'
    return c.toolsCount === p.toolsCount ? `相同(${c.toolsCount})` : `不同(${c.toolsCount} vs ${p.toolsCount})`
  }],
  ['委派 provider', (c) => c.prov],
  ['mode', (c) => c.mode ?? '(无)'],
  ['子/父 preset 是否相同', (c) => {
    const p = byId.get(c.parent)
    return p ? (c.preset === p.preset ? '相同' : '不同') : '(不可比)'
  }],
  ['system 逐字完全一致', (c) => {
    const p = byId.get(c.parent)
    if (!p || !c.system || !p.system) return '(不可比)'
    if (c.system === p.system) return '完全一致'
    const k = lcp(c.system, p.system)
    return `不一致(公共${(k / c.system.length * 100).toFixed(0)}%)`
  }],
]

// ★ 用户裁定（2026-09-21）：**agnes 免费、只跟次数有关 ⇒ 它的命中率读数没有经济意义，不能当判据**。
//   ⇒ 结论必须只看 **deepseek-v4-flash**（有真实计费）的样本。下面两表并列，谁被 agnes 带偏一眼可见。
const DS_MODEL = 'deepseek-v4-flash'
const dsOnly = real.filter((x) => x.child.model === DS_MODEL)
const others = real.filter((x) => x.child.model !== DS_MODEL)

L.push('=== ★ 交叉表：哪个因子真正决定复用 ===')
L.push(`（A）全部样本 n=${real.length}：`)
for (const [n, f] of FACTORS) crosstab(n, f, real)
L.push(`（B）★ 只看 DeepSeek（model=${DS_MODEL}）n=${dsOnly.length} —— 有真实计费，才是判据：`)
for (const [n, f] of FACTORS) crosstab(n, f, dsOnly)
L.push(`（C）被剔除的非 DeepSeek 样本 n=${others.length}（免费/按次数，命中率无经济意义）：`)
for (const { child: c } of others) {
  L.push(`    ${pad(String(c.id ?? c.dir ?? '?').slice(0, 8), 10)} model=${pad(c.model, 22)} preset=${pad(c.preset, 14)} ` +
    `首命中=${pad(pct(c.firstHit), 8)} 缓存读=${c.firstCacheRead}  ← 不计入结论`)
}
L.push('')

L.push('说明：本表是【假设生成】，不是受控实验。因子之间可能共线（例如"工具数不同"的样本恰好都是 continuable）。')
L.push('')


// ── 全量按 depth ──────────────────────────────────────────────
L.push('=== 全量一览（depth 升序；只列有 usage 的）===')
L.push(pad('depth', 6) + pad('prov', 8) + pad('preset', 14) + pad('steps', 6) + pad('总命中', 8) + pad('首命中', 8) + pad('首缓存读', 10) + 'session')
for (const r of rows.filter((x) => x.steps > 0).sort((a, b) => (a.depth ?? -1) - (b.depth ?? -1))) {
  L.push(pad(r.depth, 6) + pad(r.prov, 8) + pad(r.preset, 14) + pad(r.steps, 6) +
    pad(pct(r.hit), 8) + pad(pct(r.firstHit), 8) + pad(r.firstCacheRead, 10) + r.id)
}
L.push('')

const depthHist = new Map()
for (const r of rows) depthHist.set(r.depth, (depthHist.get(r.depth) ?? 0) + 1)
L.push('--- delegationDepth 分布 ---')
for (const [d, n] of [...depthHist.entries()].sort((a, b) => (a[0] ?? -1) - (b[0] ?? -1))) L.push(`  depth=${d}: ${n}`)
L.push('')


/* ══════════════════════════════════════════════════════════════════════════
 * ★ 改动1 —— usage 两源归并：旧口径（仅 assistant/message）vs 新口径（两源归并）
 *   两者是**同一个 step 的两阶段**，归并时**替换不相加** ⇒ 新口径 ⊇ 旧口径，差值即旧口径的漏账。
 * ══════════════════════════════════════════════════════════════════════════ */
const subU = (a, b) => ({
  inputTokens: a.inputTokens - b.inputTokens, cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens, outputTokens: a.outputTokens - b.outputTokens,
})
const oldGlobal = rows.reduce((a, r) => addU(a, r.oldTotals), ZERO_U)
const newGlobal = rows.reduce((a, r) => addU(a, r.mergedTotals), ZERO_U)
const diffGlobal = subU(newGlobal, oldGlobal)

L.push('=== ★ 改动1：usage 两源归并（旧口径 = 仅 assistant/message.usage；新口径 = chunk+message 按 (turn,step) 替换归并）===')
L.push(`扫描到会话: ${rows.length} 个；有 usage 的会话: ${rows.filter((r) => !isZeroU(r.mergedTotals)).length} 个`)
L.push('')
L.push('--- 样本来源普查 ---')
L.push(`  assistant/chunk{type:'usage'} 样本数 = ${rows.reduce((a, r) => a + r.mergeStats.chunkSamples, 0)}`)
L.push(`  assistant/message.usage     样本数 = ${rows.reduce((a, r) => a + r.mergeStats.msgSamples, 0)}`)
L.push(`  按 (turn,step) 归一的 key 数 = ${rows.reduce((a, r) => a + r.mergedSteps, 0)}`)
L.push(`    两者都有          = ${rows.reduce((a, r) => a + r.mergeStats.both, 0)}`)
L.push(`    只有 chunk（漏账） = ${rows.reduce((a, r) => a + r.mergeStats.chunkOnly, 0)}   ← 旧口径读不到这些 = 失败请求的 durable 记录`)
L.push(`    只有 message      = ${rows.reduce((a, r) => a + r.mergeStats.msgOnly, 0)}`)
L.push(`    两者都有但值不同   = ${rows.reduce((a, r) => a + r.mergeStats.unequal, 0)}   ← 0 表示 message 就是该 step 的终样本（替换无副作用）`)
const coAll = rows.flatMap((r) => r.chunkOnlyList)
L.push(`  漏账 key 合计 ${coAll.length} 个，其中桶全为 0 的 = ${coAll.filter((x) => isZeroU(x.buckets)).length} 个（全 0 的不改变总额，故"有差异的会话数"会小于 chunkOnly key 数）`)
L.push('')
L.push('--- ★ 旧口径 vs 新口径（全部会话合计）---')
L.push(`  旧口径（仅 message）: ${fmtU(oldGlobal)}   计费 prompt 侧 = ${dueOf(oldGlobal)}`)
L.push(`  新口径（两源归并）  : ${fmtU(newGlobal)}   计费 prompt 侧 = ${dueOf(newGlobal)}`)
L.push(`  差值（漏账量级）    : ${fmtU(diffGlobal)}   计费 prompt 侧 = ${dueOf(diffGlobal)}`)
L.push(`  相对偏差            : ${dueOf(oldGlobal) ? ((dueOf(diffGlobal) / dueOf(oldGlobal)) * 100).toFixed(4) + '%' : 'n/a'}（漏账 / 旧口径）`)
L.push('')
L.push('--- ★ 逐会话：旧口径 ≠ 新口径 的会话（其余会话两口径逐字相同）---')
const perDiff = rows.filter((r) => fmtU(r.oldTotals) !== fmtU(r.mergedTotals))
L.push(`  共 ${perDiff.length} / ${rows.length} 个会话不同。列宽：chunkOnly = 旧口径读不到的 (turn,step) key 数`)
for (const r of perDiff) {
  const d = subU(r.mergedTotals, r.oldTotals)
  L.push(`  ✗ ${pad(String(r.id).slice(0, 12), 14)} msgSamples=${pad(r.mergeStats.msgSamples, 5)} chunkSamples=${pad(r.mergeStats.chunkSamples, 5)} chunkOnly=${r.mergeStats.chunkOnly}`)
  L.push(`      旧口径(仅message) ${fmtU(r.oldTotals)}`) 
  L.push(`      新口径(两源归并)  ${fmtU(r.mergedTotals)}`)
  L.push(`      差值              ${fmtU(d)}`)
  for (const x of r.chunkOnlyList) L.push(`      └ 只有 chunk 的 key t/s=${x.key}  ${fmtU(x.buckets)}`)
}
L.push('')
L.push('※ 旧口径所有原有表格（父子配对明细 / fork-vs-spawn A_B / 交叉表 / 全量一览）**一律保留未改**，本段是并列对照。')
L.push('')


/* ══════════════════════════════════════════════════════════════════════════
 * ★ 改动2 的前置：切分标记普查（用哪个标记切「种子份 / 分身自己」，必须先给实测计数）
 * ══════════════════════════════════════════════════════════════════════════ */
const hasSeedLen = rows.filter((r) => r.hasSeedLenKey)
const seedLenPos = rows.filter((r) => r.seedLength !== null && r.seedLength > 0)
const hasEndSeed = rows.filter((r) => r.endSeedN > 0)
const lastEndAtTail = hasEndSeed.filter((r) => r.lastEndSeq === r.maxSeq)
const withParent = rows.filter((r) => r.parent)
const withDesc = rows.filter((r) => r.prov)
const byProvCount = new Map()
for (const r of withDesc) byProvCount.set(r.prov, (byProvCount.get(r.prov) ?? 0) + 1)

L.push('=== ★ 改动2 前置：切分标记普查（实测计数，非推断）===')
L.push(`  候选 A  header.seedLength ：**缺键** = ${rows.length - hasSeedLen.length} / ${rows.length}；键存在 = ${hasSeedLen.length}；其中数值 > 0 = ${seedLenPos.length}`)
for (const r of seedLenPos) L.push(`        └ ${String(r.id).slice(0, 12)} seedLength=${r.seedLength}  parentSession=${r.parent ?? '-'}  prov=${r.prov ?? '(无 descriptor)'}`)
L.push(`  候选 B  session/end-seed ：有 ≥1 条的会话 = ${hasEndSeed.length} / ${rows.length}；其中**最后一条落在日志末尾**(lastEndSeq === maxSeq) = ${lastEndAtTail.length} / ${hasEndSeed.length}`)
L.push(`  旁证     header.parentSession：有 = ${withParent.length} / ${rows.length}`)
L.push(`  旁证     subagent/descriptor：有 = ${withDesc.length} 个（${[...byProvCount.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}）`)
L.push('')
L.push(`  ⇒ **两个候选在本机样本里都存在**（A 存在 ${seedLenPos.length} 例，B 存在 ${hasEndSeed.length} 例）⇒ 按题设**优先 A**，理由：`)
L.push('     (1) A 是上游定义的 DURABLE fork-lineage boundary（docs/subsystems/session.md:392-395），fork 就是写它')
L.push('         （session.md:536 "deep-cloned seed events plus child metadata (parentSession, seedLength, …)"）；')
L.push('         它的值是**父代 fork 时刻的 seq**（packages/goal/goal/tests/goal.spec.ts:187）⇒ `seq <= seedLength` 是精确边界。')
L.push(`     (2) B 的 end-seed 是**任何**构造种子的收尾（resume / fork / replay 都写，session.md:585）。实测 ${lastEndAtTail.length}/${hasEndSeed.length} 的会话里`)
L.push('         它就在日志最后一条 ⇒ 用它切会把「本会话自己的工作」整段归入种子份、分身自己恒为 0，对"新增开销"零分辨力。')
L.push('         下面并列 B 的数字，可直接看到这个退化。')
L.push(`  ⇒ 缺 A 时**不近似**：seedLength 缺键 ⇒ 种子份 = 0（无 fork 血脉），不拿 B 顶替。切分标记 = ${SEED_MARKER}`)
L.push('')
L.push('--- A / B 两口径并列（全部 有种子标记 的会话）---')
const seedMarked = rows.filter((r) => r.slicedA || r.slicedB)
for (const r of seedMarked) {
  L.push(`  ■ ${pad(String(r.id).slice(0, 12), 14)} prov=${pad(r.prov ?? '(无)', 16)} seedLength=${pad(r.seedLength, 6)} endSeedN=${pad(r.endSeedN, 3)} lastEndSeq=${pad(r.lastEndSeq, 8)} maxSeq=${r.maxSeq}`)
  L.push(`      A(seedLength为界): 种子=${fmtU(r.seedA)} | 自己=${fmtU(r.liveA)}`)
  L.push(`      B(last end-seed) : 种子=${fmtU(r.seedB)} | 自己=${fmtU(r.liveB)}`)
  L.push(`      合计(两源归并)   : ${fmtU(r.mergedTotals)}`)
}
const degenerateB = seedMarked.filter((r) => r.slicedB && isZeroU(r.liveB))
L.push(`  ⇒ B 口径下「分身自己 = 0」的会话: ${degenerateB.length} / ${seedMarked.filter((r) => r.slicedB).length}  ← 这就是选 A 不选 B 的实测依据`)
L.push('')


/* ══════════════════════════════════════════════════════════════════════════
 * ★ 改动2：子代账三列 —— 种子份 / 分身自己 / 合计（标记 = header.seedLength）
 * ══════════════════════════════════════════════════════════════════════════ */
L.push('=== ★ 改动2：子代账「种子份 / 分身自己 / 合计」（切分标记 = header.seedLength）===')
L.push('  种子份 = seq <= seedLength 的事件折叠 ⇒ 父代已付过账的拷贝，**不是新增开销**；')
L.push('  分身自己 = seq >  seedLength 的事件折叠 ⇒ 新增开销（其首请求会把整段 seed 当 prompt 重发）。')
L.push('  口径：两源归并（改动1），且两段**各自**按 (turn,step) 归并后再相加，避免跨边界串 key。')
L.push('')
L.push(pad('prov', 20) + pad('mode', 13) + pad('depth', 6) + pad('seedLen', 8) + pad('endSeedN', 9) +
  pad('种子份(in/cr/out)', 30) + pad('分身自己(in/cr/out)', 30) + pad('合计(in/cr/out)', 30) + 'session')
const delegates = rows.filter((r) => r.parent || r.prov)
for (const r of delegates.sort((a, b) => (a.depth ?? -1) - (b.depth ?? -1))) {
  L.push(pad(r.prov ?? '(无descriptor)', 20) + pad(r.mode ?? '-', 13) + pad(r.depth, 6) +
    pad(r.seedLength === null ? '(缺键)' : r.seedLength, 8) + pad(r.endSeedN, 9) +
    pad(`${r.seedA.inputTokens}/${r.seedA.cacheReadTokens}/${r.seedA.outputTokens}`, 30) +
    pad(`${r.liveA.inputTokens}/${r.liveA.cacheReadTokens}/${r.liveA.outputTokens}`, 30) +
    pad(`${r.totalA.inputTokens}/${r.totalA.cacheReadTokens}/${r.totalA.outputTokens}`, 30) +
    String(r.id).slice(0, 12))
}
L.push('')
L.push('--- 分组小计（三列，按 descriptor.provider）---')
L.push(pad('分组', 20) + pad('n', 5) + pad('种子份 cr', 14) + pad('分身自己 cr', 16) + pad('合计 cr', 14) + '种子份 in / 分身自己 in')
for (const [prov, list] of [...new Set(rows.filter((r) => r.prov).map((r) => r.prov))].sort().map((p) => [p, rows.filter((r) => r.prov === p)])) {
  const s = list.reduce((a, r) => addU(a, r.seedA), ZERO_U)
  const l = list.reduce((a, r) => addU(a, r.liveA), ZERO_U)
  L.push(pad(prov, 20) + pad(list.length, 5) + pad(s.cacheReadTokens, 14) + pad(l.cacheReadTokens, 16) +
    pad(s.cacheReadTokens + l.cacheReadTokens, 14) + `${s.inputTokens} / ${l.inputTokens}`)
}
L.push('--- 一致性问题检查 ---')
const inconsistent = rows.filter((r) => fmtU(r.totalA) !== fmtU(r.mergedTotals))
L.push(`  「种子份 + 分身自己 ≠ 整份归并」的会话数 = ${inconsistent.length} / ${rows.length}` +
  `（>0 说明有 (turn,step) 跨 seedLength 边界，两段各自归并会比整份折叠多算；本机该数为 0 表示切分无串扰）`)
L.push('')


/* ══════════════════════════════════════════════════════════════════════════
 * ★ 改动3：负对照（验收门）—— 证明切分真的在起作用
 *   spawn 子代（无种子）种子份应为 0；fork 子代（有种子）种子份应 > 0。
 * ══════════════════════════════════════════════════════════════════════════ */
L.push('=== ★ 改动3：负对照（切分是否真的在起作用）===')
const provGroups = [...new Set(rows.filter((r) => r.prov).map((r) => r.prov))].sort()
const ctl = {}
for (const p of provGroups) {
  const list = rows.filter((r) => r.prov === p)
  ctl[p] = { n: list.length, zero: list.filter((r) => isZeroU(r.seedA)).length, pos: list.filter((r) => !isZeroU(r.seedA)).length, list }
}
L.push('--- 按 descriptor.provider 分组的「种子份」（标记 = header.seedLength）---')
for (const p of provGroups) {
  const g = ctl[p]
  L.push(`  [${p}] n=${g.n}  种子份 = 0 的 = ${g.zero}  种子份 > 0 的 = ${g.pos}`)
  for (const r of g.list) {
    L.push(`      ${pad(String(r.id).slice(0, 12), 14)} seedLength=${pad(r.seedLength === null ? '(缺键)' : r.seedLength, 8)} ` +
      `种子份=${fmtU(r.seedA)} 分身自己=${fmtU(r.liveA)}`)
  }
}
const forkN = ctl.fork?.n ?? 0
const spawnN = ctl.spawn?.n ?? 0
const spawnOK = (ctl.spawn?.pos ?? 0) === 0        // spawn 的种子份必须全为 0
const forkOK = (ctl.fork?.pos ?? 0) === (ctl.fork?.n ?? -1) && (ctl.fork?.n ?? 0) > 0 // fork 的种子份必须全 > 0
let controlPassed = false
if (!forkN || !spawnN) {
  L.push(`  ⇒ 样本不足以分 fork/spawn（fork=${forkN}, spawn=${spawnN}）⇒ **无法做对照**，不假装通过。`)
} else {
  L.push(`  判据：spawn 子代种子份全为 0 ? ${spawnOK}（实测 ${ctl.spawn.pos}/${ctl.spawn.n} 个 > 0）；` +
    `fork 子代种子份全 > 0 ? ${forkOK}（实测 ${ctl.fork.pos}/${ctl.fork.n} 个 > 0）`)
  controlPassed = spawnOK && forkOK
  if (!controlPassed) {
    L.push('  ⇒ ★ 负对照**未通过**：fork 臂要求「种子份 > 0」，实测本机**每一个 fork 子代都没有可切的种子**。')
    L.push('     证据（见上面逐条 + 上面的切分标记普查）：4 个 fork 子代的 header **缺 seedLength 键**，')
    L.push('     且其日志本身**不含父代 seed 的深拷贝**（事件数 21~22、seq 0 是 sandbox/mode，首事件时间 = 子代 createdAt），')
    L.push('     故按「不近似」原则种子份 = 0 —— 与 spawn 同值 ⇒ 该对照在本机样本上不可满足。')
    L.push('     （不是脚本坏了：唯一带 seedLength 的样本切得出非零种子份，见下「机制正对照」。）')
  }
}
L.push('')
L.push('--- 机制正对照（唯一带 seedLength 的样本；它没有 subagent/descriptor，是**会话级 fork**）---')
if (seedLenPos.length) {
  for (const r of seedLenPos) {
    L.push(`  ${String(r.id).slice(0, 12)}  parentSession=${r.parent}  seedLength=${r.seedLength}`)
    L.push(`      种子份   = ${fmtU(r.seedA)}   ← 非 0 ⇒ 切分机制本身有效（父代已付账的拷贝）`)
    L.push(`      分身自己 = ${fmtU(r.liveA)}`)
    L.push(`      合计     = ${fmtU(r.totalA)}  （= 该会话整份归并，一致=${fmtU(r.totalA) === fmtU(r.mergedTotals)}）`)
  }
} else {
  L.push('  （本机没有任何带 seedLength 的样本 ⇒ 连"机制正对照"也做不出）')
}
L.push('')
L.push(`negative control passed = ${controlPassed}`)
L.push('')

// 供 stdout 一行读数（不改原有功能）
const negativeControlLine = `negative control passed = ${controlPassed}`

fs.writeFileSync(OUT, L.join('\n'), 'utf8')
console.log('written', OUT, '| pairs=', pairs.length, '| byProvider=', BY_PROVIDER)
console.log(`[v3] 旧口径(仅message) prompt侧=${dueOf(oldGlobal)}  →  新口径(两源归并) prompt侧=${dueOf(newGlobal)}  漏账=${dueOf(diffGlobal)}`)
console.log(`[v3] 种子份总量 cr=${rows.reduce((a, r) => a + r.seedA.cacheReadTokens, 0)} | 分身自己总量 cr=${rows.reduce((a, r) => a + r.liveA.cacheReadTokens, 0)} | 标记=${SEED_MARKER}`)
console.log(`[v3] ${negativeControlLine}`)
