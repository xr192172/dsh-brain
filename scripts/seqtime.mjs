// seqtime.mjs — 打印指定 seq 区间的原始事件 JSON（含所有字段，用于确认时间戳字段）。
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const rel = process.argv[2]
const OUT = 'D:/project_develop/dsh-brain/out/seqtime.txt'
const buf = []
const log = (...a) => buf.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
process.on('exit', () => fs.writeFileSync(OUT, buf.join('\n'), 'utf8'))

const file = path.join('C:/Users/Admin/.dsh/sessions', rel, 'session.jsonl.zstd')
const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
const events = []
for (const l of text.split('\n')) { if (!l.trim()) continue; try { events.push(JSON.parse(l)) } catch {} }

log('total events:', events.length)
log('keys of event[0]:', Object.keys(events[0]).join(','))
log('sample event[0] (400):', JSON.stringify(events[0]).slice(0, 400))

// 打印前几个 compaction/start 的完整 envelope（不含 data 大字段）
const starts = events.filter((e) => e.type === 'compaction/start')
log('\n=== first 2 & last 4 compaction/start envelopes ===')
for (const e of [...starts.slice(0, 2), ...starts.slice(-4)]) {
  const env = { ...e }
  log(JSON.stringify(env).slice(0, 700))
}

// 最后 30 个事件的 type + 时间字段
log('\n=== last 30 events: seq/type/time-ish fields ===')
for (const e of events.slice(-30)) {
  const t = e.time ?? e.ts ?? e.at ?? e.timestamp ?? e.createdAt ?? e.data?.time ?? '-'
  log(`seq=${e.seq} ${e.type}  time=${t}`)
}

// 找 seq=416920 附近的时间
log('\n=== time near the final errors ===')
for (const target of [306452, 318876, 411246, 416920, 416928]) {
  const e = events.find((x) => x.seq === target)
  if (!e) { log(`seq ${target} not found`); continue }
  const t = e.time ?? e.ts ?? e.at ?? e.timestamp ?? e.data?.time ?? '-'
  log(`seq=${target} ${e.type} time=${t}`)
}
