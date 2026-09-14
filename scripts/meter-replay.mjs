// meter-replay.mjs — 离线复现：用真实 TokenMeter 重放某会话事件流，定位 measure() 抛错点。
// 用法： node scripts/meter-replay.mjs <sessionDirRelPath>
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const root = 'C:/Users/Admin/.dsh/sessions'
const rel = process.argv[2]
const file = path.join(root, rel, 'session.jsonl.zstd')
if (!fs.existsSync(file)) { console.log('missing', file); process.exit(1) }

const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
const raw = text.split('\n').filter((l) => l.trim())
const events = []
for (const l of raw) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  events.push(e)
}
console.log('events array length:', events.length, ' first seq:', events[0] && events[0].seq, ' last seq:', events[events.length - 1] && events[events.length - 1].seq)

const mod = await import('file:///D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js')
const TokenMeter = mod.TokenMeter
const meter = Object.create(TokenMeter.prototype)
meter.states = new WeakMap()

const session = { events }
try {
  const m = meter.measure(session)
  console.log('measure() OK. totalTokens=', m.totalTokens, 'surfaceTokens=', m.surfaceTokens, 'nodes=', m.nodes.length, 'baseline=', JSON.stringify(m.baseline))
} catch (e) {
  console.log('measure() THREW:', e && e.message)
  console.log('--- stack ---')
  console.log(String(e && e.stack).split('\n').slice(0, 12).join('\n'))
  // 定位毒化事件：逐段推进，找到第一个抛错的 seq
  const probe = Object.create(TokenMeter.prototype)
  probe.states = new WeakMap()
  let prev = 0
  for (let upto = 1; upto <= events.length; upto++) {
    if (!events[upto - 1] && !events[upto]) continue
    const sub = { events: [] }
    for (let i = 0; i < upto; i++) if (events[i]) sub.events[i] = events[i]
    try { probe.states = new WeakMap(); probe.measure(sub) } catch (err) {
      if (upto > prev) {
        prev = upto
        console.log('first failing prefix tail seq =', upto - 1, 'type =', events[upto - 1] && events[upto - 1].type, '=>', err.message)
        break
      }
    }
  }
}
