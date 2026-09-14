// 验证 prepareSwitch 的「空闲短路」：空闲会话应**立即**返回 reason='idle'，
// 而旧实现会对空闲会话注入 steer 并白等满 grace（默认 20s）。
const PORT = process.argv[2] ?? '31811'
const GRACE = Number(process.argv[3] ?? 20000)

const post = async (path, body) => {
  const t0 = Date.now()
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await r.text()
  return { ms: Date.now() - t0, status: r.status, text }
}
const get = async (path) => {
  const t0 = Date.now()
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
  const text = await r.text()
  return { ms: Date.now() - t0, status: r.status, text }
}

const lines = []
const push = (s) => { lines.push(s); console.log(s) }

push(`=== admin @ ${PORT} ===`)
const h = await get('/admin/health')
push(`health(${h.ms}ms) ${h.status} ${h.text}`)

push('')
push(`=== prepareSwitch(graceMs=${GRACE}) —— 期望：秒级返回 reason=idle ===`)
const p = await post('/admin/prepareSwitch', { graceMs: GRACE })
push(`prepareSwitch 耗时 = ${p.ms} ms   (旧实现：若 foundAgent 且空闲 → 等满 ${GRACE}ms)`)
push(`status=${p.status}`)
push(`body=${p.text}`)

push('')
push('=== 判定 ===')
let verdict = 'UNKNOWN'
try {
  const j = JSON.parse(p.text)
  if (p.ms < 3000 && j.reason === 'idle') verdict = `PASS —— 空闲短路生效（${p.ms}ms，未白等 grace）`
  else if (p.ms >= GRACE * 0.8) verdict = `FAIL —— 仍然等满 grace（${p.ms}ms），旧行为`
  else verdict = `OBSERVE —— 快速返回但 reason=${j.reason}，需要人工判断`
  push(`reason=${j.reason}  waitedForTurnEnd=${j.waitedForTurnEnd}  foundAgent=${j.foundAgent}  turnInFlight=${j.turnInFlight}`)
} catch (e) { verdict = 'FAIL —— 响应不是 JSON: ' + e.message }
push(verdict)

import fs from 'node:fs'
fs.writeFileSync('D:/project_develop/dsh-brain/out/test-prepare-idle.txt', lines.join('\n'), 'utf8')
