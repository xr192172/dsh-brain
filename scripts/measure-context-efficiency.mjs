/**
 * measure-context-efficiency.mjs —— 上下文效率度量（离线，零运行时改动）
 *
 * 数据源：~/.dsh/sessions/<dir>/<session>/session.jsonl.zstd（多帧 zstd，fzstd 解）
 *
 * 产出两个指标：
 *   A. cache 命中率 = cacheRead / (inputTokens + cacheReadTokens + cacheWriteTokens)
 *      - inputTokens 是「未缓存 input」（见 dsh-llm TokenUsage 注释：三者 disjoint）
 *      - 给出总体值 + per-turn 时间序列 + 骤降点检测（前后轮差值）
 *      - 验收线（用户定）：≥ 93%
 *   B. 关键信息召回率（信息保全）
 *      - 取 compaction/summary 的 shadowedSeqs → 被压缩掉的原文
 *      - 提取"特征词"（文件路径 / 反引号内容 / 错误串）
 *      - 看这些特征词在【压缩点之后的一段窗口】里是否复现
 *      - 复现 = 该内容事后被重新需要，但已被压掉 ⇒ 本该有召回能力
 *
 * 用法：
 *   node scripts/measure-context-efficiency.mjs --list
 *   node scripts/measure-context-efficiency.mjs --sample <rel> [--n 6]
 *   node scripts/measure-context-efficiency.mjs --rel <rel>
 *   node scripts/measure-context-efficiency.mjs --all
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/context-efficiency.txt'

// 召回窗口：只看压缩点之后这么多事件 / 这么多字符（再远的需求概率低，且成本会爆）
const MAX_LATER_EVENTS = 3000
const MAX_LATER_CHARS = 20 * 1024 * 1024
const MAX_FEATURES_PER_SPAN = 15

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes('--' + name)

function listSessions() {
  const out = []
  if (!fs.existsSync(ROOT)) return out
  for (const dir of fs.readdirSync(ROOT)) {
    const dp = path.join(ROOT, dir)
    let st
    try { st = fs.statSync(dp) } catch { continue }
    if (!st.isDirectory()) continue
    for (const s of fs.readdirSync(dp)) {
      const f = path.join(dp, s, 'session.jsonl.zstd')
      if (fs.existsSync(f)) out.push({ dir, session: s, rel: `${dir}/${s}`, file: f, size: fs.statSync(f).size })
    }
  }
  return out.sort((a, b) => b.size - a.size)
}

function loadEvents(file) {
  const raw = fs.readFileSync(file)
  const text = Buffer.from(decompress(raw)).toString('utf8')
  const events = []
  const skip = { parseError: 0, noSeq: 0, array: 0, sample: [] }
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    let o
    try { o = JSON.parse(l) } catch { skip.parseError++; continue }
    if (Array.isArray(o)) { skip.array++; if (skip.sample.length < 3) skip.sample.push(l.slice(0, 200)); continue }
    if (typeof o.seq !== 'number') { skip.noSeq++; if (skip.sample.length < 3) skip.sample.push(l.slice(0, 200)); continue }
    events.push(o)
  }
  return { events, skip }
}

const textOfContent = (c) => {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' ? (p.text ?? '') : String(p))).join('\n')
  if (typeof c === 'object' && typeof c.text === 'string') return c.text
  return ''
}

function eventText(e) {
  const d = e.data ?? {}
  switch (e.type) {
    case 'user/message':
    case 'assistant/message':
      return textOfContent(d.message?.content ?? d.content ?? d.message)
    case 'tool/result':
      return textOfContent(d.message?.content ?? d.content)
    case 'tool/call':
      return String(d.arguments ?? '')
    default:
      return ''
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function usageOf(e) {
  const d = e.data ?? {}
  const u = d.usage ?? d.message?.usage
  if (!u || typeof u !== 'object') return null
  if (typeof u.inputTokens !== 'number' && typeof u.outputTokens !== 'number') return null
  return u
}

const GENERIC = new Set([
  'true', 'false', 'null', 'undefined', 'string', 'number', 'object', 'function',
  'import', 'export', 'const', 'return', 'async', 'await', 'process', 'console',
])

/** 特征词提取：只取高辨识度的三类，避免噪声 */
function extractFeatures(text) {
  const f = new Set()
  if (!text) return f
  for (const m of text.matchAll(/[A-Za-z]:[\\/][^\s"'`<>|*?\n]+|(?:[\w.@-]+[\\/])+[\w.@-]+\.(?:ts|tsx|js|mjs|cjs|jsx|go|py|json|md|ya?ml|toml|css|html|sh|ps1|patch)/g)) {
    const v = m[0].trim()
    if (v.length >= 6 && v.length <= 180) f.add(v)
  }
  for (const m of text.matchAll(/`([^`\n]{4,60})`/g)) {
    const v = m[1].trim()
    if (v && !GENERIC.has(v)) f.add(v)
  }
  for (const m of text.matchAll(/(?:Error|error|Exception|failed|FAILED)[:\s]+([^\n]{8,80})/g)) {
    f.add(m[1].trim())
  }
  return f
}

function analyze(s) {
  const { events, skip } = loadEvents(s.file)
  const bySeq = new Map(events.map((e) => [e.seq, e]))

  const typeCount = new Map()
  for (const e of events) typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1)

  // 会话窗口配置
  const ctxEv = events.find((e) => e.type === 'request/context')
  const contextWindow = ctxEv?.data?.contextWindow ?? null
  const model = ctxEv?.data?.model ?? null

  // ---- A. cache 命中率 ----
  const turns = []
  const agg = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const u = usageOf(e)
    if (!u) continue
    const input = num(u.inputTokens), cr = num(u.cacheReadTokens), cw = num(u.cacheWriteTokens), out = num(u.outputTokens)
    const billed = input + cr + cw
    turns.push({
      seq: e.seq, turn: e.data?.turn ?? null,
      input, cacheRead: cr, cacheWrite: cw, output: out, billed,
      hit: billed > 0 ? cr / billed : 0,
      hitExclWrite: input + cr > 0 ? cr / (input + cr) : 0,
    })
    agg.input += input; agg.cacheRead += cr; agg.cacheWrite += cw; agg.output += out
  }
  const aggBilled = agg.input + agg.cacheRead + agg.cacheWrite
  const overallHit = aggBilled > 0 ? agg.cacheRead / aggBilled : 0
  const overallHitExclWrite = agg.input + agg.cacheRead > 0 ? agg.cacheRead / (agg.input + agg.cacheRead) : 0

  // 骤降检测（相邻轮 hit 差 > 0.3 且计费显著）
  const drops = []
  for (let i = 1; i < turns.length; i++) {
    const p = turns[i - 1], c = turns[i]
    if (c.billed < 2000) continue
    const d = p.hit - c.hit
    if (d >= 0.3) drops.push({ seq: c.seq, turn: c.turn, from: p.hit, to: c.hit, drop: d, billed: c.billed })
  }

  // ---- 压缩事件 ----
  const compactions = []
  for (const e of events) {
    if (e.type === 'compaction/summary' || e.type === 'compaction/prune') {
      compactions.push({
        seq: e.seq, kind: e.type, turn: e.data?.turn ?? null,
        shadowedSeqs: e.data?.shadowedSeqs ?? [],
        tokens: num(e.data?.shadowedTokenCount),
        model: e.data?.model ?? '',
        err: e.data?.error,
      })
    }
  }

  // ---- B. 关键信息召回率（窗口化）----
  const textEvents = events.map((e) => ({ seq: e.seq, text: eventText(e) })).filter((x) => x.text)
  const idxOfSeq = new Map(textEvents.map((x, i) => [x.seq, i]))

  const recalls = []
  for (const c of compactions) {
    if (!c.shadowedSeqs.length) continue
    const feat = new Set()
    for (const sq of c.shadowedSeqs) {
      const ev = bySeq.get(sq)
      if (!ev) continue
      for (const f of extractFeatures(eventText(ev))) feat.add(f)
      if (feat.size >= MAX_FEATURES_PER_SPAN) break
    }
    const feats = [...feat].slice(0, MAX_FEATURES_PER_SPAN)
    if (!feats.length) {
      recalls.push({ seq: c.seq, judgeable: false, reason: '无特征词', nShadow: c.shadowedSeqs.length, tokens: c.tokens, nFeat: 0, recalled: 0, rate: null })
      continue
    }
    // 找到压缩点在 textEvents 中的位置
    let start = -1
    for (let i = textEvents.length - 1; i >= 0; i--) { if (textEvents[i].seq < c.seq) { start = i + 1; break } }
    if (start < 0) start = 0
    // 窗口：其后 MAX_LATER_EVENTS 个文本事件 / 累计 MAX_LATER_CHARS
    const parts = []
    let chars = 0, used = 0
    for (let i = start; i < textEvents.length && used < MAX_LATER_EVENTS; i++, used++) {
      const t = textEvents[i].text
      parts.push(t)
      chars += t.length
      if (chars >= MAX_LATER_CHARS) break
    }
    if (used < 20) {
      recalls.push({ seq: c.seq, judgeable: false, reason: `后续样本过少(${used})`, nShadow: c.shadowedSeqs.length, tokens: c.tokens, nFeat: feats.length, recalled: 0, rate: null })
      continue
    }
    const later = parts.join('\n')
    let recalled = 0
    const missed = []
    for (const f of feats) { if (later.includes(f)) recalled++; else missed.push(f) }
    recalls.push({
      seq: c.seq, judgeable: true, nShadow: c.shadowedSeqs.length, tokens: c.tokens,
      nFeat: feats.length, recalled, rate: recalled / feats.length,
      windowEvents: used, windowChars: chars,
      missedSample: missed.slice(0, 6),
    })
  }

  const judged = recalls.filter((r) => r.judgeable)
  const recallRate = judged.length ? judged.reduce((a, r) => a + r.recalled, 0) / judged.reduce((a, r) => a + r.nFeat, 0) : null
  const spanRecallRate = judged.length ? judged.filter((r) => r.recalled > 0).length / judged.length : null

  // 前缀改写事件（= summary + prune）：任何一次都会改 surface → 击穿 prefix cache
  const prefixRewrites = compactions.map((c) => ({ seq: c.seq, kind: c.kind })).sort((a, b) => a.seq - b.seq)

  return {
    prefixRewrites,
    rel: s.rel, size: s.size, skip, totalEvents: events.length,
    contextWindow, model,
    typeCount: [...typeCount.entries()].sort((a, b) => b[1] - a[1]),
    turns, agg, aggBilled, overallHit, overallHitExclWrite, drops,
    compactions, recalls, recallRate, spanRecallRate,
  }
}

// ---------------- 输出 ----------------
const L = []
const say = (x = '') => L.push(x)
const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%')
const fmt = (n) => n.toLocaleString('en-US')

function report(a) {
  say(`===== ${a.rel} =====`)
  say(`file ${(a.size / 1048576).toFixed(2)} MB · events ${fmt(a.totalEvents)} · window=${a.contextWindow ?? '?'} model=${a.model ?? '?'}`)
  say(`skipped: parseError=${a.skip.parseError} noSeq=${a.skip.noSeq} array=${a.skip.array}`)
  if (a.skip.sample?.length) say(`skip sample: ${a.skip.sample[0]?.slice(0, 160)}`)
  say(`top types: ${a.typeCount.slice(0, 8).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  say('')
  say('--- A. cache 命中率 ---')
  say(`  计费 input : ${fmt(a.aggBilled)}  (uncached ${fmt(a.agg.input)} / cacheRead ${fmt(a.agg.cacheRead)} / cacheWrite ${fmt(a.agg.cacheWrite)})`)
  say(`  ★ 命中率   : ${pct(a.overallHit)}   验收线 93% → ${a.overallHit >= 0.93 ? 'PASS' : 'FAIL'}`)
  say(`    (不含写) : ${pct(a.overallHitExclWrite)}`)
  const sig = a.turns.filter((t) => t.billed > 2000)
  say(`  有效轮数   : ${a.turns.length}（计费>2K 的 ${sig.length} 轮）`)
  say(`  低命中轮次 : ${sig.filter((t) => t.hit < 0.93).length} / ${sig.length}   (阈值 93%)`)
  say(`  骤降点(≥30pp): ${a.drops.length}`)
  for (const d of a.drops.slice(0, 8)) say(`    seq=${d.seq} turn=${d.turn} ${pct(d.from)} → ${pct(d.to)} (billed=${fmt(d.billed)})`)
  say('')
  const worst = [...sig].sort((x, y) => x.hit - y.hit).slice(0, 8)
  say('  最差 8 轮:')
  for (const t of worst) say(`    seq=${t.seq} turn=${t.turn} hit=${pct(t.hit)} billed=${fmt(t.billed)} uncached=${fmt(t.input)} cacheRead=${fmt(t.cacheRead)}`)
  say('')
  say(`--- 压缩事件 (${a.compactions.length}) ---`)
  for (const c of a.compactions.slice(-12)) say(`  seq=${c.seq} ${c.kind} turn=${c.turn} shadowed=${c.shadowedSeqs.length} tokens=${fmt(c.tokens)}${c.err ? ' ERR=' + String(c.err).slice(0, 60) : ''}`)
  say('')
  say('--- B. 关键信息召回率 ---')
  say(`  压缩段总数   : ${a.recalls.length}（可判定 ${judgedCount(a)}）`)
  say(`  ★ 特征词召回率: ${pct(a.recallRate)}`)
  say(`  ★ 段级召回率  : ${pct(a.spanRecallRate)}`)
  for (const r of a.recalls.slice(-8)) {
    if (!r.judgeable) { say(`  seq=${r.seq} [不可判定: ${r.reason}] shadowed=${r.nShadow}`); continue }
    say(`  seq=${r.seq} shadowed=${r.nShadow} tokens=${fmt(r.tokens)} 特征词=${r.nFeat} 复现=${r.recalled} (${pct(r.rate)})`)
    if (r.missedSample?.length) say(`      未复现: ${r.missedSample.join(' | ').slice(0, 180)}`)
  }
  say('')
}
const judgedCount = (a) => a.recalls.filter((r) => r.judgeable).length

const SNAPDIR = 'D:/project_develop/dsh-brain/out/snapshots'

/** 计算「干净轮 / 受损轮」分组（损伤窗口 = 改写后 N 轮） */
function splitCleanDamaged(r, window = 5) {
  const damagedIdx = new Set()
  const pruneIdx = new Set()
  for (const w of r.prefixRewrites) {
    let idx = -1
    for (let i = 0; i < r.turns.length; i++) { if (r.turns[i].seq > w.seq) { idx = i; break } }
    if (idx < 0) continue
    for (let k = idx; k < Math.min(idx + window, r.turns.length); k++) {
      damagedIdx.add(k)
      if (w.kind === 'compaction/prune') pruneIdx.add(k)
    }
  }
  let cN = 0, cS = 0, dN = 0, dS = 0
  r.turns.forEach((t, i) => {
    if (t.billed < 2000) return
    if (damagedIdx.has(i)) { dN++; dS += t.hit } else { cN++; cS += t.hit }
  })
  return { cN, cS, dN, dS, pruneTouched: pruneIdx.size }
}

function buildSnapshot(label) {
  const reports = []
  for (const s of sessions) { try { reports.push(analyze(s)) } catch { /* skip */ } }
  const window = 5
  const tot = { billed: 0, cacheRead: 0, uncached: 0, output: 0, cleanN: 0, cleanSum: 0, damN: 0, damSum: 0, nFeat: 0, recalled: 0, judged: 0, rewrites: 0, nSummary: 0, nPrune: 0, turns: 0, sessions: 0 }
  const sess = []
  for (const r of reports) {
    if (!r.turns.length) continue
    const g = splitCleanDamaged(r, window)
    const judged = r.recalls.filter((x) => x.judgeable)
    const nFeat = judged.reduce((a, x) => a + x.nFeat, 0)
    const recalled = judged.reduce((a, x) => a + x.recalled, 0)
    const nSummary = r.prefixRewrites.filter((x) => x.kind === 'compaction/summary').length
    const nPrune = r.prefixRewrites.filter((x) => x.kind === 'compaction/prune').length
    sess.push({
      rel: r.rel, sizeMB: +(r.size / 1048576).toFixed(3), contextWindow: r.contextWindow, model: r.model,
      turns: r.turns.length, billed: r.aggBilled, cacheRead: r.agg.cacheRead, uncached: r.agg.input, output: r.agg.output,
      hit: r.turns.length ? +r.overallHit.toFixed(4) : null,
      rewrites: r.prefixRewrites.length, nSummary, nPrune,
      cleanN: g.cN, cleanHit: g.cN ? +(g.cS / g.cN).toFixed(4) : null,
      damN: g.dN, damHit: g.dN ? +(g.dS / g.dN).toFixed(4) : null,
      judgedSpans: judged.length, nFeat, recalled, recall: nFeat ? +(recalled / nFeat).toFixed(4) : null,
    })
    tot.billed += r.aggBilled; tot.cacheRead += r.agg.cacheRead; tot.uncached += r.agg.input; tot.output += r.agg.output
    tot.cleanN += g.cN; tot.cleanSum += g.cS; tot.damN += g.dN; tot.damSum += g.dS
    tot.nFeat += nFeat; tot.recalled += recalled; tot.judged += judged.length
    tot.rewrites += r.prefixRewrites.length; tot.nSummary += nSummary; tot.nPrune += nPrune
    tot.turns += r.turns.length; tot.sessions += 1
  }
  return {
    label, createdAt: new Date().toISOString(), damageWindow: window,
    totals: {
      ...tot,
      hit: tot.billed ? +(tot.cacheRead / tot.billed).toFixed(4) : null,
      cleanHit: tot.cleanN ? +(tot.cleanSum / tot.cleanN).toFixed(4) : null,
      damHit: tot.damN ? +(tot.damSum / tot.damN).toFixed(4) : null,
      recall: tot.nFeat ? +(tot.recalled / tot.nFeat).toFixed(4) : null,
    },
    sessions: sess,
  }
}

const pp = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%')
const dpp = (a, b) => (a == null || b == null ? 'n/a' : ((b - a) * 100 >= 0 ? '+' : '') + ((b - a) * 100).toFixed(2) + 'pp')

const mode = has('list') || process.argv.length <= 2 ? 'list'
  : has('snapshot') ? 'snapshot'
    : has('compare') ? 'compare'
      : has('cf') ? 'cf'
        : has('impact') ? 'impact'
          : has('sample') ? 'sample'
            : has('all') ? 'all'
              : has('rel') ? 'rel' : 'list'
const sessions = listSessions()

if (mode === 'snapshot') {
  const label = arg('snapshot', `snap-${Date.now()}`)
  const snap = buildSnapshot(label)
  fs.mkdirSync(SNAPDIR, { recursive: true })
  const f = path.join(SNAPDIR, label + '.json')
  fs.writeFileSync(f, JSON.stringify(snap, null, 2), 'utf8')
  const t = snap.totals
  say(`# 快照已写入`)
  say(`${f}`)
  say('')
  say(`| 指标 | 值 |`)
  say(`|---|---|`)
  say(`| 会话数 / 轮数 | ${t.sessions} / ${fmt(t.turns)} |`)
  say(`| **cache 命中率** | **${pp(t.hit)}** |`)
  say(`| 干净轮命中率 | ${pp(t.cleanHit)}（${fmt(t.cleanN)} 轮） |`)
  say(`| 受损轮命中率 | ${pp(t.damHit)}（${fmt(t.damN)} 轮） |`)
  say(`| 前缀改写总数 | ${t.rewrites}（summary ${t.nSummary} / prune ${t.nPrune}） |`)
  say(`| 计费 input | ${fmt(t.billed)}（uncached ${fmt(t.uncached)}） |`)
  say(`| 关键信息召回率 | ${pp(t.recall)}（${t.judged} 个可判定压缩段） |`)
} else if (mode === 'compare') {
  const aLabel = arg('compare'), bLabel = arg('to')
  const pa = path.join(SNAPDIR, aLabel + '.json'), pb = path.join(SNAPDIR, bLabel + '.json')
  if (!fs.existsSync(pa)) { say(`missing: ${pa}`); }
  else if (!fs.existsSync(pb)) { say(`missing: ${pb}`); }
  else {
    const A = JSON.parse(fs.readFileSync(pa, 'utf8')), B = JSON.parse(fs.readFileSync(pb, 'utf8'))
    const ta = A.totals, tb = B.totals
    say(`# 对比：${A.label}  →  ${B.label}`)
    say('')
    say(`> ${A.createdAt} → ${B.createdAt}`)
    say('')
    say('## 总体')
    say('')
    say('| 指标 | 基线 | 现在 | 变化 | 验收线 |')
    say('|---|---|---|---|---|')
    say(`| **cache 命中率** | ${pp(ta.hit)} | **${pp(tb.hit)}** | **${dpp(ta.hit, tb.hit)}** | 93% → ${tb.hit >= 0.93 ? '**PASS**' : 'FAIL'} |`)
    say(`| 干净轮命中率 | ${pp(ta.cleanHit)} | ${pp(tb.cleanHit)} | ${dpp(ta.cleanHit, tb.cleanHit)} | — |`)
    say(`| 受损轮命中率 | ${pp(ta.damHit)} | ${pp(tb.damHit)} | ${dpp(ta.damHit, tb.damHit)} | — |`)
    say(`| 前缀改写总数 | ${ta.rewrites} | ${tb.rewrites} | ${tb.rewrites - ta.rewrites >= 0 ? '+' : ''}${tb.rewrites - ta.rewrites} | 越少越好 |`)
    say(`| └ prune 次数 | ${ta.nPrune} | ${tb.nPrune} | ${tb.nPrune - ta.nPrune >= 0 ? '+' : ''}${tb.nPrune - ta.nPrune} | **目标 0** |`)
    say(`| └ summary 次数 | ${ta.nSummary} | ${tb.nSummary} | ${tb.nSummary - ta.nSummary >= 0 ? '+' : ''}${tb.nSummary - ta.nSummary} | — |`)
    say(`| 受损轮数 | ${fmt(ta.damN)} | ${fmt(tb.damN)} | ${tb.damN - ta.damN >= 0 ? '+' : ''}${tb.damN - ta.damN} | 越少越好 |`)
    say(`| 计费 input | ${fmt(ta.billed)} | ${fmt(tb.billed)} | ${tb.billed - ta.billed >= 0 ? '+' : ''}${fmt(tb.billed - ta.billed)} | — |`)
    say(`| 关键信息召回率 | ${pp(ta.recall)} | ${pp(tb.recall)} | ${dpp(ta.recall, tb.recall)} | 越高越好 |`)
    say('')
    const mapB = new Map(B.sessions.map((s) => [s.rel, s]))
    const rows = []
    for (const sa of A.sessions) {
      const sb = mapB.get(sa.rel)
      if (!sb) continue
      rows.push({ rel: sa.rel, a: sa, b: sb, delta: (sb.hit ?? 0) - (sa.hit ?? 0) })
    }
    rows.sort((x, y) => y.delta - x.delta)
    if (rows.length) {
      say('## 分会话变化（按命中率提升降序）')
      say('')
      say('| session | 基线命中率 | 现在 | 变化 | prune(基/现) | 窗口(基/现) |')
      say('|---|---|---|---|---|---|')
      for (const r of rows) {
        say(`| ${r.rel.replace(/^--/g, '').slice(0, 40)} | ${pp(r.a.hit)} | ${pp(r.b.hit)} | ${dpp(r.a.hit, r.b.hit)} | ${r.a.nPrune} / ${r.b.nPrune} | ${r.a.contextWindow ?? '?'} / ${r.b.contextWindow ?? '?'} |`)
      }
    }
    const onlyA = A.sessions.filter((s) => !mapB.has(s.rel))
    if (onlyA.length) { say(''); say(`仅基线有（${onlyA.length} 个）：${onlyA.slice(0, 6).map((s) => s.rel.split('/').pop()).join(', ')}${onlyA.length > 6 ? ' …' : ''}`) }
  }
} else if (mode === 'cf') {
  const reports = []
  for (const s of sessions) { try { reports.push(analyze(s)) } catch (e) { say(`[skip] ${s.rel}: ${e.message}`) } }
  const DAMAGE_WINDOW = 5
  const rows = []
  const agg = { cleanN: 0, cleanSum: 0, damN: 0, damSum: 0 }
  for (const r of reports) {
    if (r.turns.length < 3) continue
    const damagedIdx = new Set()
    const causedByPrune = new Set()
    for (const w of r.prefixRewrites) {
      let idx = -1
      for (let i = 0; i < r.turns.length; i++) { if (r.turns[i].seq > w.seq) { idx = i; break } }
      if (idx < 0) continue
      for (let k = idx; k < Math.min(idx + DAMAGE_WINDOW, r.turns.length); k++) {
        damagedIdx.add(k)
        if (w.kind === 'compaction/prune') causedByPrune.add(k)
      }
    }
    let cleanN = 0, cleanSum = 0, damN = 0, damSum = 0
    r.turns.forEach((t, i) => {
      if (t.billed < 2000) return
      if (damagedIdx.has(i)) { damN++; damSum += t.hit } else { cleanN++; cleanSum += t.hit }
    })
    if (cleanN === 0 && damN === 0) continue
    agg.cleanN += cleanN; agg.cleanSum += cleanSum; agg.damN += damN; agg.damSum += damSum
    rows.push({
      rel: r.rel, span: r.turns.length,
      rewrites: r.prefixRewrites.length,
      nPrune: r.prefixRewrites.filter((x) => x.kind === 'compaction/prune').length,
      overall: r.overallHit,
      clean: cleanN ? cleanSum / cleanN : null, cleanN,
      damaged: damN ? damSum / damN : null, damN,
      pruneTouched: causedByPrune.size,
    })
  }
  say('# 反事实分析：如果前缀改写不发生，命中率能到多少？')
  say('')
  say(`> 定义：某轮若落在某次前缀改写之后的 ${DAMAGE_WINDOW} 轮内，则该轮为「受损轮」（改写击穿了它的缓存）。`)
  say('> 「干净轮」= 不在任何改写损伤窗口内的轮次 —— 它代表**系统在没有改写干扰时的稳态命中率上限**。')
  say('')
  say('## 全量')
  say('')
  say(`| 类别 | 轮数 | 平均命中率 |`)
  say(`|---|---|---|`)
  say(`| 干净轮（无改写干扰） | ${fmt(agg.cleanN)} | **${pct(agg.cleanSum / agg.cleanN)}** |`)
  say(`| 受损轮（改写后 ${DAMAGE_WINDOW} 轮内） | ${fmt(agg.damN)} | ${pct(agg.damSum / agg.damN)} |`)
  const overall = (agg.cleanSum + agg.damSum) / (agg.cleanN + agg.damN)
  say(`| 合计 | ${fmt(agg.cleanN + agg.damN)} | ${pct(overall)} |`)
  say('')
  say(`**干净轮 ${pct(agg.cleanSum / agg.cleanN)} vs 验收线 93% → ${agg.cleanSum / agg.cleanN >= 0.93 ? 'PASS' : 'FAIL'}**`)
  say('')
  say('## 会话级')
  say('')
  say('| session | 轮数 | 改写 | 其中prune | 整体命中率 | 干净轮命中率 | 受损轮命中率 | 受损轮数 |')
  say('|---|---|---|---|---|---|---|---|')
  for (const r of rows.sort((a, b) => b.overall - a.overall)) {
    say(`| ${r.rel.replace(/^--/g, '').slice(0, 42)} | ${r.span} | ${r.rewrites} | ${r.nPrune} | ${pct(r.overall)} | ${pct(r.clean)} | ${pct(r.damaged)} | ${r.damN} |`)
  }
  say('')
  say('## 解读')
  say('')
  const cleanAvg = agg.cleanSum / agg.cleanN
  say(`  · 无改写干扰时命中率 = ${pct(cleanAvg)}；一旦发生改写，之后 ${DAMAGE_WINDOW} 轮平均只有 ${pct(agg.damSum / agg.damN)}。`)
  say(`  · 也就是说：**命中率不是被"压缩质量"拖低的，是被"改写的频率"拖低的。**`)
  const pruneShare = rows.filter((r) => r.pruneTouched > 0).length
  say(`  · ${pruneShare} / ${rows.length} 个会话的受损轮与 \`compaction/prune\` 有关（工具结果裁剪，默认 >8192 字符即触发）。`)
} else if (mode === 'impact') {
  const reports = []
  for (const s of sessions) { try { reports.push(analyze(s)) } catch (e) { say(`[skip] ${s.rel}: ${e.message}`) } }
  const buckets = Array.from({ length: 6 }, () => ({ n: 0, sum: 0 }))
  const rows = []
  for (const r of reports) {
    if (!r.turns.length) continue
    const nSum = r.prefixRewrites.filter((x) => x.kind === 'compaction/summary').length
    const nPrune = r.prefixRewrites.filter((x) => x.kind === 'compaction/prune').length
    const span = r.turns.length
    rows.push({
      rel: r.rel, span, rewrites: r.prefixRewrites.length, nSum, nPrune,
      hit: r.overallHit, interval: r.prefixRewrites.length ? span / r.prefixRewrites.length : null,
    })
    for (const w of r.prefixRewrites) {
      const after = r.turns.filter((t) => t.seq > w.seq).slice(0, 5)
      after.forEach((t, i) => { if (t.billed > 500) { buckets[i].n++; buckets[i].sum += t.hit } })
    }
  }
  say('# 前缀改写事件（summary + prune）对 cache 命中率的因果影响')
  say('')
  say('> 每次 compaction/summary 或 compaction/prune 都会改写 surface 的**前缀区**，')
  say('> 因此其后第一轮必然整段 miss。下表量化这个代价，以及恢复速度。')
  say('')
  say('## 改写事件之后第 k 轮的命中率')
  say('')
  say('| 改写后第 k 轮 | 样本轮数 | 平均命中率 |')
  say('|---|---|---|')
  buckets.forEach((b, i) => {
    if (b.n) say(`| 第 ${i + 1} 轮 | ${fmt(b.n)} | ${pct(b.sum / b.n)} |`)
  })
  say('')
  say('## 会话级：改写频率 vs 命中率')
  say('')
  say('| session | 轮数 | 改写总数 | summary | prune | 平均间隔(轮) | 命中率 |')
  say('|---|---|---|---|---|---|---|')
  const sorted = rows.slice().sort((a, b) => b.hit - a.hit)
  for (const r of sorted) {
    say(`| ${r.rel.replace(/^--/g, '').slice(0, 46)} | ${r.span} | ${r.rewrites} | ${r.nSum} | ${r.nPrune} | ${r.interval ? r.interval.toFixed(1) : '-'} | ${pct(r.hit)} |`)
  }
  say('')
  const withInt = rows.filter((r) => r.interval != null && r.span >= 20)
  say('## 分组统计（轮数 ≥ 20 的会话）')
  say('')
  const groups = [[0, 3], [3, 8], [8, 20], [20, 1e9]]
  say('| 平均改写间隔 | 会话数 | 加权命中率 | 结论 |')
  say('|---|---|---|---|')
  for (const [lo, hi] of groups) {
    const g = withInt.filter((r) => r.interval >= lo && r.interval < hi)
    if (!g.length) continue
    const totB = g.reduce((a, r) => a + r.span, 0) // 近似权重：轮数
    const avg = g.reduce((a, r) => a + r.hit * r.span, 0) / totB
    say(`| ${lo}~${hi === 1e9 ? '∞' : hi} 轮 | ${g.length} | ${pct(avg)} | ${avg >= 0.93 ? '达标' : '不达标'} |`)
  }
  say('')
  say('## 推断：要 ≥93% 需要什么')
  say('')
  const good = withInt.filter((r) => r.hit >= 0.93)
  const bad = withInt.filter((r) => r.hit < 0.93)
  if (good.length) say(`  达标会话的平均改写间隔: ${(good.reduce((a, r) => a + r.interval, 0) / good.length).toFixed(1)} 轮（${good.length} 个）`)
  if (bad.length) say(`  未达标会话的平均改写间隔: ${(bad.reduce((a, r) => a + r.interval, 0) / bad.length).toFixed(1)} 轮（${bad.length} 个）`)
  say('')
  say('  ⚠️ 注意：这是**相关性**不是严格因果，但方向一致——改写越密，命中率越低。')
} else if (mode === 'list') {
  say('可用会话（按体积降序）:')
  for (const s of sessions) say(`  ${(s.size / 1048576).toFixed(2).padStart(7)} MB  ${s.rel}`)
} else if (mode === 'sample') {
  const rel = arg('sample')
  const s = sessions.find((x) => x.rel === rel) ?? { rel, file: path.join(ROOT, rel, 'session.jsonl.zstd'), size: 0 }
  const { events, skip } = loadEvents(s.file)
  say(`===== SAMPLE ${rel} =====`)
  say(`events ${events.length} · skip parseError=${skip.parseError} noSeq=${skip.noSeq} array=${skip.array}`)
  if (skip.sample?.length) { say('skip samples:'); for (const x of skip.sample) say('  ' + x) }
  const wu = events.filter((e) => e.type === 'assistant/message' && usageOf(e))
  say(`assistant/message with usage: ${wu.length}`)
  for (const e of wu.slice(-3)) say(`  seq=${e.seq} usage=${JSON.stringify(usageOf(e))}`)
  const cs = events.filter((e) => e.type === 'compaction/summary')
  say(`compaction/summary: ${cs.length}`)
  if (cs.length) {
    const c = cs[cs.length - 1]
    say(`  last: seq=${c.seq} keys=${Object.keys(c.data).join(',')} shadowed=${(c.data.shadowedSeqs || []).length} tokens=${c.data.shadowedTokenCount}`)
  }
} else if (mode === 'rel') {
  const rel = arg('rel')
  const s = sessions.find((x) => x.rel === rel) ?? { rel, file: path.join(ROOT, rel, 'session.jsonl.zstd'), size: 0 }
  report(analyze(s))
} else {
  const reports = []
  for (const s of sessions) {
    try { reports.push(analyze(s)) } catch (e) { say(`[skip] ${s.rel}: ${e.message}`) }
  }
  reports.sort((a, b) => b.size - a.size)
  say('# 全量汇总')
  say('')
  say('| session | MB | 窗口 | 轮数 | cache命中率 | 压缩 | 特征词召回率 |')
  say('|---|---|---|---|---|---|---|')
  for (const r of reports) {
    say(`| ${r.rel.replace(/^—|--/g, '').slice(0, 58)} | ${(r.size / 1048576).toFixed(2)} | ${r.contextWindow ?? '?'} | ${r.turns.length} | ${pct(r.overallHit)} | ${r.compactions.length} | ${pct(r.recallRate)} |`)
  }
  say('')
  const totBilled = reports.reduce((a, r) => a + r.aggBilled, 0)
  const totCR = reports.reduce((a, r) => a + r.agg.cacheRead, 0)
  const totUncached = reports.reduce((a, r) => a + r.agg.input, 0)
  say('## 跨会话合计')
  say(`  计费 input 总量 : ${fmt(totBilled)}  (uncached ${fmt(totUncached)} / cacheRead ${fmt(totCR)})`)
  say(`  ★ 加权命中率    : ${totBilled ? pct(totCR / totBilled) : 'n/a'}   验收线 93% → ${totBilled && totCR / totBilled >= 0.93 ? 'PASS' : 'FAIL'}`)
  const allJudged = reports.flatMap((r) => r.recalls.filter((x) => x.judgeable))
  const nf = allJudged.reduce((a, r) => a + r.nFeat, 0)
  const nr = allJudged.reduce((a, r) => a + r.recalled, 0)
  say(`  可判定压缩段数  : ${allJudged.length}`)
  say(`  ★ 特征词召回率  : ${nf ? pct(nr / nf) : 'n/a'}`)
  say('')
  say('## 明细')
  say('')
  for (const r of reports) report(r)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, L.join('\n'), 'utf8')
console.log('written:', OUT, 'lines:', L.length)
