import fs from 'node:fs'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const out = []
const fmtT = (ms) => (typeof ms === 'number' ? new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (+8)' : '?')

function load(rel) {
  const f = `${ROOT}/${rel}/session.jsonl.zstd`
  const text = Buffer.from(decompress(fs.readFileSync(f))).toString('utf8')
  return text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((e) => e && typeof e.seq === 'number')
}

for (const rel of [
  '--D-project_develop-elv--/session-b79a6e91-45cd-4332-b6bc-763735b27bf9',
  '--D-project_develop-elv--/session-28f50f57-61e4-434e-a8eb-7e7544c71a70',
]) {
  let evs
  try { evs = load(rel) } catch (e) { out.push(`FAIL ${rel}: ${e.message}`); continue }
  out.push(`===== ${rel.split('/').pop().slice(0, 24)} =====`)
  out.push(`events=${evs.length}`)

  const turns = []
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const u = e.data?.usage
    if (!u) continue
    const i = u.inputTokens ?? 0, cr = u.cacheReadTokens ?? 0, cw = u.cacheWriteTokens ?? 0
    const b = i + cr + cw
    turns.push({ seq: e.seq, turn: e.data?.turn, time: e.time, billed: b, hit: b ? cr / b : 0, input: i, cr })
  }
  const totB = turns.reduce((a, t) => a + t.billed, 0)
  const totC = turns.reduce((a, t) => a + t.cr, 0)
  out.push(`turns=${turns.length}  overallHit=${totB ? (100 * totC / totB).toFixed(2) + '%' : 'n/a'}  billed=${totB.toLocaleString()}`)
  if (turns.length) out.push(`FIRST turn: seq=${turns[0].seq} t=${fmtT(turns[0].time)} hit=${(100 * turns[0].hit).toFixed(1)}% billed=${turns[0].billed}`)
  out.push(`last turn : seq=${turns.at(-1).seq} t=${fmtT(turns.at(-1).time)} hit=${(100 * turns.at(-1).hit).toFixed(1)}%`)

  out.push('last 18 turns:')
  for (const t of turns.slice(-18)) {
    out.push(`  seq=${t.seq} turn=${t.turn} t=${fmtT(t.time)} billed=${String(t.billed).padStart(7)} hit=${(100 * t.hit).toFixed(1).padStart(5)}% uncached=${t.input}`)
  }

  const comp = evs.filter((e) => typeof e.type === 'string' && e.type.startsWith('compaction/'))
  out.push(`compaction events: ${comp.length}`)
  for (const c of comp.slice(-10)) {
    out.push(`  seq=${c.seq} ${c.type} t=${fmtT(c.time)} shadowed=${(c.data?.shadowedSeqs || []).length}`)
  }

  const hdrs = evs.filter((e) => e.type === 'request/header')
  out.push(`request/header: ${hdrs.length}`)
  for (const h of hdrs.slice(-8)) {
    const d = h.data?.header ?? {}
    out.push(`  seq=${h.seq} t=${fmtT(h.time)} reason=${h.data?.reason} sysLen=${(d.system ?? '').length} tools=${Array.isArray(d.tools) ? d.tools.length : '?'}`)
  }

  const ctx = evs.filter((e) => e.type === 'request/context')
  if (ctx.length) out.push(`request/context: window=${ctx.at(-1).data?.contextWindow} model=${ctx.at(-1).data?.model}`)
  out.push('')
}

fs.writeFileSync('D:/project_develop/dsh-brain/out/check-newdata.txt', out.join('\n'), 'utf8')
console.log('ok')
