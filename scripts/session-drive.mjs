// session-drive.mjs — 通过前门 RPC 驱动 DSH 会话（用于自触发一次压缩）。
// 用法：
//   node scripts/session-drive.mjs describe
//   node scripts/session-drive.mjs list
//   node scripts/session-drive.mjs prompt <sessionId> "<text>"
import { randomUUID } from 'node:crypto'

const BASE = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'

async function rpc(method, payload) {
  const body = { type: 'client-request', rpcId: randomUUID(), method, payload }
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

const cmd = process.argv[2]
if (cmd === 'describe') {
  const r = await rpc('host.describe', {})
  console.log(JSON.stringify(r, null, 2).slice(0, 3000))
} else if (cmd === 'list') {
  const r = await rpc('session.list', {})
  console.log('status', r.status)
  const v = r.json?.result?.value
  if (Array.isArray(v?.sessions)) {
    for (const s of v.sessions.slice(0, 25)) {
      console.log(`  ${s.id}  cwd=${s.cwd ?? '-'}  title=${(s.title ?? '').slice(0, 40)}  updated=${s.updatedAt ?? s.createdAt ?? '-'}`)
    }
    console.log('total', v.sessions.length)
  } else console.log(JSON.stringify(r.json).slice(0, 2500))
} else if (cmd === 'cred') {
  const refs = process.argv.slice(3)
  const want = refs.length > 0 ? refs : ['AGENTSHELL_MAIN_LLM_API_KEY', 'AGENTSHELL_MAIN_LLM_API_KEYS']
  const r = await rpc('credentials.describe', { refs: want })
  console.log('status', r.status)
  const creds = r.json?.result?.value?.credentials
  if (creds) for (const [ref, view] of Object.entries(creds)) console.log(`  ${ref}  configured=${view.configured}  writable=${view.writable}  source=${view.source ?? '-'}`)
  else console.log(JSON.stringify(r.json, null, 2).slice(0, 1500))
} else if (cmd === 'credset') {
  // 从 ai-base/agent-shell/.env 取值，经 credentials.set 持久化到凭据库。
  // 值永不打印；只回报长度与 configured 状态。
  const fs = await import('node:fs')
  const envFile = 'D:\\project_develop\\ai-base\\agent-shell\\.env'
  const wanted = process.argv.slice(3)
  const refs = wanted.length > 0 ? wanted : ['AGENTSHELL_MAIN_LLM_API_KEY', 'AGENTSHELL_MAIN_LLM_API_KEYS']
  const table = {}
  for (const ln of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const t = ln.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    table[t.slice(0, eq)] = t.slice(eq + 1)
  }
  for (const ref of refs) {
    const value = table[ref]
    if (value === undefined || value === '') { console.log(`  ${ref}: .env 中缺失或为空，跳过`); continue }
    const r = await rpc('credentials.set', { ref, value })
    console.log(`  ${ref}: len=${value.length} status=${r.status} ok=${r.json?.result?.ok ?? '?'}`)
  }
  const r2 = await rpc('credentials.describe', { refs })
  const creds = r2.json?.result?.value?.credentials
  if (creds) for (const [ref, view] of Object.entries(creds)) console.log(`  after: ${ref} configured=${view.configured} source=${view.source ?? '-'}`)
} else if (cmd === 'prompt') {
  const sessionId = process.argv[3]
  const text = process.argv[4] ?? '继续'
  const r = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    clientTimeZone: 'Asia/Shanghai'
  })
  console.log(JSON.stringify(r, null, 2).slice(0, 2000))
} else {
  console.log('usage: session-drive.mjs describe|list|cred|credset|prompt <sessionId> "<text>"')
}
