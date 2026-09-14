// compaction-probe.mjs — 解码 DSH 会话，导出 compaction/* 事件（含类型）与指定 seq 的上下文。
// 用法： node scripts/compaction-probe.mjs <sessionDirRelPath> [--around <seq>] [--from <seq>]
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const root = 'C:/Users/Admin/.dsh/sessions'
const rel = process.argv[2]
const OUT = 'D:/project_develop/dsh-brain/out/comp-probe.txt'
const buf = []
const log = (...a) => { buf.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
process.on('exit', () => fs.writeFileSync(OUT, buf.join('\n'), 'utf8'))

if (!rel) { log('usage: node scripts/compaction-probe.mjs <relPath> [--around <seq>] [--from <seq>]'); process.exit(1) }
const file = path.join(root, rel, 'session.jsonl.zstd')
if (!fs.existsSync(file)) { log('missing', file); process.exit(1) }
const raw = fs.readFileSync(file)
let text
try { text = Buffer.from(decompress(raw)).toString('utf8') } catch (e) { log('decode fail:', e.message); process.exit(1) }
const events = []
for (const l of text.split('\n')) { if (!l.trim()) continue; try { events.push(JSON.parse(l)) } catch { /* skip */ } }

log('file bytes:', raw.length, 'events:', events.length)
log('max seq:', events.reduce((m, e) => Math.max(m, e.seq ?? -1), -1))

const comp = events.filter((e) => String(e.type).startsWith('compaction/'))
log('\n=== compaction/* count:', comp.length, '===')
for (const e of comp) {
  const d = e.data ?? {}
  const bits = [`seq=${e.seq}`, e.type]
  if (d.compactionId !== undefined) bits.push(`id=${String(d.compactionId).slice(0, 8)}`)
  if (d.shadowedRange) bits.push(`range=${d.shadowedRange.start}-${d.shadowedRange.end}`)
  if (typeof d.shadowedTokenCount === 'number') bits.push(`shadowed=${d.shadowedTokenCount}`)
  if (d.provider) bits.push(`provider=${d.provider}`)
  if (d.error) bits.push(`ERROR=${JSON.stringify(d.error)}`)
  log(bits.join('  '))
}

// 事件类型直方图（top）
const hist = new Map()
for (const e of events) hist.set(e.type, (hist.get(e.type) ?? 0) + 1)
log('\n=== top 25 event types ===')
;[...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => log(String(v).padStart(7), k))

const aroundIdx = process.argv.indexOf('--around')
if (aroundIdx > 0) {
  const target = Number(process.argv[aroundIdx + 1])
  const i = events.findIndex((e) => e.seq === target)
  if (i < 0) log('\n--around: seq not found', target)
  else {
    log(`\n=== context around seq ${target} (index ${i}) ===`)
    for (let k = Math.max(0, i - 10); k <= Math.min(events.length - 1, i + 10); k++) {
      const e = events[k]
      const s = JSON.stringify(e.data ?? {})
      log(`[${k}] seq=${e.seq} ${e.type} :: ${s.length > 300 ? s.slice(0, 300) + '…' : s}`)
    }
  }
}

const fromIdx = process.argv.indexOf('--from')
if (fromIdx > 0) {
  const target = Number(process.argv[fromIdx + 1])
  log(`\n=== all events with seq >= ${target} (types only, first 120) ===`)
  const rest = events.filter((e) => (e.seq ?? -1) >= target).slice(0, 120)
  for (const e of rest) log(`seq=${e.seq} ${e.type}`)
}
