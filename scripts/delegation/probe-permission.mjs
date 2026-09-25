// probe-permission.mjs —— 探针：能否**不经 UI 点击**把一次性会话的权限/沙箱放开？
// 目的：L2 施工会话若卡在审批上，会白等 ~1000 秒（docs/eval-capability-task.md:156-163 有先例）。
// 做法：① 建一次性会话 ② 探一批候选 RPC 名（只记 404/非 404）③ 试 slash 命令 `/permission danger-full-access`
//       ④ 读会话事件流，看 `permission/preset` / `sandbox/mode` / `approval/policy` 是否真的变了
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { decompress } from 'fzstd'

const FRONT = 'http://127.0.0.1:3080'
const HOME = 'C:/Users/Admin/.dsh'
const CWD = process.argv[2] ?? 'D:/project_develop/_l2/wt'

async function rpc(method, payload) {
  const res = await fetch(`${FRONT}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: payload ?? {} }),
  })
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json: j, text }
}

function sessionPath(sid) {
  const root = path.join(HOME, 'sessions')
  for (const d of fs.readdirSync(root)) {
    const pp = path.join(root, d)
    if (!fs.statSync(pp).isDirectory()) continue
    for (const s of fs.readdirSync(pp)) {
      if (s !== sid) continue
      const f = path.join(pp, s, 'session.jsonl.zstd')
      if (fs.existsSync(f)) return f
    }
  }
  return null
}
function eventsOf(sid) {
  const f = sessionPath(sid)
  if (!f) return []
  const raw = Buffer.from(decompress(fs.readFileSync(f))).toString('utf8')
  return raw.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const out = []
const say = (s) => { out.push(s); console.log(s) }

say('=== ① 建一次性会话 ===')
const c = await rpc('session.create', { cwd: CWD })
const sid = c.json?.result?.value?.sessionId ?? c.json?.result?.value?.id
say(`sessionId=${sid}  status=${c.status}`)

const list0 = await rpc('session.list', {})
const item0 = (list0.json?.result?.value?.items ?? []).find((x) => x.sessionId === sid)
say(`回读: agentPreset=${item0?.agentPreset} running=${item0?.running} asOfSeq=${item0?.projections?.asOfSeq}`)

say('')
say('=== ② 探候选 RPC 名（只记 404 / 非 404 与首 120 字符）===')
const candidates = [
  'permission.set', 'permission.setMode', 'permission.preset', 'permission.mode',
  'session.setPermission', 'session.permission', 'session.setApprovalPolicy',
  'sandbox.setMode', 'sandbox.mode', 'approval.set', 'approval.policy.set',
]
for (const m of candidates) {
  const r = await rpc(m, { sessionId: sid })
  const notFound = r.status === 404 || /not found|unknown method|unimplemented/i.test(r.text.slice(0, 200))
  say(`  ${m.padEnd(26)} status=${r.status} ${notFound ? '【不存在】' : '★ 可能存在 → ' + r.text.slice(0, 140).replace(/\s+/g, ' ')}`)
}

say('')
say('=== ③ 试 slash 命令 /permission danger-full-access ===')
const s1 = await rpc('session.prompt', { sessionId: sid, mode: 'steer', content: [{ type: 'text', text: '/permission danger-full-access' }] })
say(`session.prompt status=${s1.status} body=${s1.text.slice(0, 200).replace(/\s+/g, ' ')}`)
await new Promise((r) => setTimeout(r, 6000))

say('')
say('=== ④ 会话事件流（判据：permission / sandbox / approval 三个事件的值变了吗）===')
for (const e of eventsOf(sid)) {
  const t = e.type ?? '?'
  if (/permission|sandbox|approval|preset/.test(t)) say(`  seq=${e.seq} ${t} data=${JSON.stringify(e.data).slice(0, 200)}`)
  else say(`  seq=${e.seq} ${t}`)
}
say('')
const list1 = await rpc('session.list', {})
const item1 = (list1.json?.result?.value?.items ?? []).find((x) => x.sessionId === sid)
say(`回读(后): agentPreset=${item1?.agentPreset} running=${item1?.running} asOfSeq=${item1?.projections?.asOfSeq}`)

fs.mkdirSync('D:/project_develop/dsh-brain/out/_probe', { recursive: true })
fs.writeFileSync('D:/project_develop/dsh-brain/out/_probe/permission-probe.txt', out.join('\n'), 'utf8')
console.log('\n落盘: out/_probe/permission-probe.txt')
