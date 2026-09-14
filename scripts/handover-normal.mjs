// 触发一次【正常】换代（?cmd=handover，不带 fast）并轮询到落定。
// 目的：验证 P1 修复后 —— 空闲会话下 defer 不再白等满 grace（旧：必定 20s+）。
import fs from 'node:fs'

const ADMIN = 'http://127.0.0.1:31800/'
const OUT = 'D:/project_develop/dsh-brain/out/handover-normal.txt'
const STATE = 'C:/Users/Admin/.dsh/switchboard/state.jsonl'

const log = []
const say = (s) => { log.push(s); console.log(s) }

const get = async (q) => { const r = await fetch(ADMIN + q); return { status: r.status, text: await r.text() } }
const stateLineCount = () => { try { return fs.readFileSync(STATE, 'utf8').split('\n').filter((l) => l.trim()).length } catch { return -1 } }

const before = stateLineCount()
say(`state.jsonl lines before: ${before}`)

const t0 = Date.now()
const kick = await get('?cmd=handover')
say(`--- kick --- HTTP ${kick.status}`)
say(kick.text)

const deadline = t0 + 120_000
let lastResult = ''
let settledAt = null
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500))
  const res = await get('?cmd=result')
  let parsed
  try { parsed = JSON.parse(res.text) } catch { continue }
  const v = parsed?.result
  if (v && JSON.stringify(v) !== lastResult) {
    lastResult = JSON.stringify(v)
    say(`t+${((Date.now() - t0) / 1000).toFixed(1)}s  result=${lastResult}`)
  }
  if (v && v.result) { settledAt = Date.now(); break }
}

say('')
say(`--- 落定用时: ${settledAt ? ((settledAt - t0) / 1000).toFixed(1) + 's' : 'TIMEOUT'} ---`)

try {
  const lines = fs.readFileSync(STATE, 'utf8').split('\n').filter((l) => l.trim())
  say(`state.jsonl lines after: ${lines.length} (+${lines.length - before})`)
  say('--- 新增流水 ---')
  for (const l of lines.slice(before)) {
    try {
      const r = JSON.parse(l)
      const t = r.t ? new Date(r.t).toISOString().replace('T', ' ').slice(11, 19) : '?'
      say(`  ${t} stage=${r.stage} gen=${r.gen} note=${r.note}`)
    } catch { say('  ' + l) }
  }
} catch (e) { say('read state failed: ' + String(e)) }

const st = await get('?cmd=status')
say('')
say('--- final status ---')
say(st.text)

fs.writeFileSync(OUT, log.join('\n'), 'utf8')
