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

const rows = []
for (const s of listSessions()) {
  const evs = readEvents(s.file)
  if (!evs || !evs.length) continue
  const head = evs.find((e) => e.type === 'session') ?? evs[0]
  const msgs = evs.filter((e) => e.type === 'assistant/message')
  const usages = msgs.map(pickUsage)

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

fs.writeFileSync(OUT, L.join('\n'), 'utf8')
console.log('written', OUT, '| pairs=', pairs.length, '| byProvider=', BY_PROVIDER)
