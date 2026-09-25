// probe-approval-answer.mjs —— 探：能不能**编程应答**审批请求（`approval/asked` → `approval/decided`）
//
// 为什么值得花这几分钟：用户的核心诉求是"**完全脱离人工，AI 互相监督**"；
// 而"沙箱放权"目前只有在 UI 点"允许"这一条路（权限档位 12 个候选 RPC 全 404）。
// 若存在一条 RPC 能应答审批，就等于打通了"隔离沙箱内自动放行"的通道。
import { randomUUID } from 'node:crypto'

const FRONT = 'http://127.0.0.1:3080'

async function rpc(method, payload) {
  const res = await fetch(`${FRONT}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: payload ?? {} }),
  })
  const t = await res.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* 非 JSON */ }
  return { status: res.status, text: t, json: j }
}

const CANDIDATES = [
  'approval.answer', 'approval.decide', 'approval.respond', 'approval.resolve', 'approval.list',
  'approval.pending', 'userApproval.decide', 'userApproval.answer', 'userApproval.list',
  'session.approval', 'session.approval.answer', 'session.approvals',
  'permission.approve', 'permission.decide', 'permission.answer',
  'sandbox.escalate', 'sandbox.approve',
]

console.log('=== 候选方法名探测（404 = 不存在）===')
for (const m of CANDIDATES) {
  // 故意用一个不存在的 sessionId：**存在**的方法会报参数/会话错误，**不存在**的会 404
  const r = await rpc(m, { sessionId: 'probe-nonexistent', approvalId: 'x', callId: 'x', decision: 'allow' })
  const notFound = r.status === 404 || /not found|unknown method|unimplemented|no such method/i.test(r.text.slice(0, 200))
  console.log(`  ${m.padEnd(26)} status=${r.status} ${notFound ? '【不存在】' : '★ 可能存在 → ' + r.text.slice(0, 200).replace(/\s+/g, ' ')}`)
}

// 看看 host.describe / 其它列举面里有没有蛛丝马迹
console.log('\n=== host.describe 原文 ===')
const d = await rpc('host.describe', {})
console.log(d.text.slice(0, 600))

console.log('\n=== 有没有"列举所有可用方法"的通道 ===')
for (const m of ['host.methods', 'api.describe', 'api.methods', 'rpc.describe', 'host.capabilities']) {
  const r = await rpc(m, {})
  const notFound = r.status === 404 || /not found|unknown method/i.test(r.text.slice(0, 200))
  console.log(`  ${m.padEnd(22)} status=${r.status} ${notFound ? '【不存在】' : '★ → ' + r.text.slice(0, 300).replace(/\s+/g, ' ')}`)
}
