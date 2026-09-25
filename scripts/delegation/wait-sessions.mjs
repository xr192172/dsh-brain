// wait-sessions.mjs —— 前台等待若干会话跑完（带总时限），只在"有变化"时打印，避免刷屏
// 用法: node out/_probe/wait-sessions.mjs <sid,sid,...> [--max-ms 540000] [--poll 30000]
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const ids = (argv[0] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const maxMs = Number(argOf('--max-ms') ?? 540000)
const pollMs = Number(argOf('--poll') ?? 30000)
if (ids.length === 0) { console.error('用法: node wait-sessions.mjs <sid,...>'); process.exit(3) }

const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
async function rpc(method, payload) {
  const res = await fetch(`${FRONT}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: payload ?? {} }),
  })
  const j = await res.json().catch(() => null)
  return j?.result?.value ?? null
}

const t0 = Date.now()
const prev = {}
let round = 0
while (Date.now() - t0 < maxMs) {
  round++
  const v = await rpc('session.list', {})
  const items = v?.items ?? []
  const rows = []
  let allStopped = true
  for (const id of ids) {
    const s = items.find((x) => x.sessionId === id)
    if (!s) { rows.push(`${id.slice(0, 20)} 不存在`); continue }
    const st = s.projections?.values?.sessionStats ?? {}
    rows.push(`${id.slice(0, 20)} running=${s.running} seq=${s.projections?.asOfSeq} steps=${st.steps ?? '?'}`)
    if (s.running) allStopped = false
  }
  const sig = rows.join(' | ')
  if (sig !== prev.sig) { console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${sig}`); prev.sig = sig }
  if (allStopped) { console.log(`\n★ 全部已停止（等待 ${Math.round((Date.now() - t0) / 1000)}s，轮询 ${round} 次）`); process.exit(0) }
  await new Promise((r) => setTimeout(r, pollMs))
}
console.log(`\n⚠️ ${Math.round(maxMs / 1000)}s 到点，仍有会话在跑（退出码 2 —— 不是失败，是"还没完"）`)
process.exit(2)
