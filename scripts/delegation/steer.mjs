// steer.mjs —— 向**正在跑**的 DSH 会话注入一条纠正消息（`mode:'steer'`）
// 用途：派活后才发现边界要收紧 ⇒ 不必取消重跑，直接补发。
// ★ 只发消息，不碰进程、不改任何文件。
// 用法: node out/_probe/steer.mjs <sessionId> "<一句话>" [--from-file <文件>]
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const sid = argv[0]
const ffIdx = argv.indexOf('--from-file')
const text = ffIdx >= 0 ? fs.readFileSync(argv[ffIdx + 1], 'utf8') : argv[1]
const front = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'

if (!sid || !text) { console.error('用法: node steer.mjs <sessionId> "<text>" | --from-file <f>'); process.exit(3) }

const body = {
  type: 'client-request', rpcId: randomUUID(), method: 'session.prompt',
  payload: { sessionId: sid, mode: 'steer', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
}
const res = await fetch(`${front}/api/session.prompt`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const t = await res.text()
let j = null
try { j = JSON.parse(t) } catch { /* 非 JSON */ }
const accepted = j?.result?.value?.accepted ?? null
console.log(`session=${sid}\nHTTP ${res.status}  accepted=${accepted}`)
if (accepted !== true) console.log(`原始返回：${t.slice(0, 300)}`)
process.exit(accepted === true ? 0 : 1)
