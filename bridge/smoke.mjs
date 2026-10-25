#!/usr/bin/env node
/**
 * smoke.mjs —— 真实冒烟：对已运行的 elv/dsh-hub(:15813) + bridge 验证全链。
 * 前置：hub 已起（node D:/project_develop/elv/dsh-hub/dist/server.js），
 *       bridge 已起（--role executor-alpha --bridge-port 15900）。
 * 本脚本扮演审批客户端（role=ui）：
 *   ★ 实测（permissionService.ts）：hub 把 permission.request 只广播给 role:'ui' ——
 *     审批者必须是 ui 角色（§15.11 评审团闸口若要接管审批，需 hub 侧扩路由，见 NOTES）。
 *   1) hello/welcome 握手；
 *   2) 向 executor-alpha 发 command.input → 期待 event.notice（input_accepted 或 input_rejected=dsh 未起）；
 *   3) 等 bridge 的 permission.request → 回 permission.response{allowed:true}；
 *   4) 断言 bridge /permission 返回 {allowed:true, reason:'smoke'}。
 * 跑法：node dist/dsh-hub-handoff/bridge/smoke.mjs
 */
import assert from 'node:assert/strict'
import { openHub, genId } from '../spike/hubconn.mjs'

const HUB = process.env.HUB_URL ?? 'ws://127.0.0.1:15813/ws'
const BRIDGE_PERM = process.env.BRIDGE_PERM ?? 'http://127.0.0.1:15900/permission'
const ROLE = process.env.TARGET_ROLE ?? 'executor-alpha'
const CLIENT_ROLE = process.env.CLIENT_ROLE ?? 'ui' // hub 审批路由只认 ui（permissionService.ts 实测）

const seen = []
let noticeCode = null
let permReq = null

const me = await openHub({
  hub: HUB,
  role: CLIENT_ROLE,
  id: 'smoke-approver',
  name: 'smoke-approver',
  onMsg: (m) => {
    seen.push(m)
    if (m.type === 'event.notice') noticeCode = m.payload?.code ?? null
    if (m.type === 'permission.request') {
      permReq = m
      me.send('permission.response', { role: 'hub' }, { allowed: true, reason: 'smoke' }, m.correlation_id)
      console.log(`[smoke] 收到 permission.request corr=${m.correlation_id}，已回 allowed=true`)
    }
  },
})
console.log(`[smoke] 审批客户端(${CLIENT_ROLE})已接入 hub client_id=${me.clientID}`)

// 1) 下行：command.input → executor-alpha
me.send('command.input', { role: ROLE }, { text: '[smoke] 请报一下你的状态', turn_id: 'smoke-t1', session_id: 'smoke-s1' })
console.log(`[smoke] 已发 command.input → ${ROLE}`)

// 2) permission 透传（走 bridge 本地 HTTP 面）
const permResp = await fetch(BRIDGE_PERM, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool_name: 'dsh.swap', tool_args: '{"gen":"smoke-1"}', tier: 'hard' }),
  signal: AbortSignal.timeout(30_000),
}).then((r) => r.json())
console.log('[smoke] bridge /permission →', JSON.stringify(permResp))

await new Promise((r) => setTimeout(r, 500))

// ── 判定 ──
const checks = []
checks.push(['握手 welcome（client_id）', !!me.clientID])
checks.push(['下行 command.input 有回执（event.notice）', noticeCode !== null])
checks.push(['回执码 ∈ {input_accepted, input_rejected}', ['input_accepted', 'input_rejected'].includes(noticeCode)])
checks.push(['permission.request 到达秘书席（payload 不变形）', !!permReq && permReq.payload?.tool_name === 'dsh.swap' && permReq.payload?.tool_args === '{"gen":"smoke-1"}'])
checks.push(['/permission 原样返回 allowed=true', permResp?.allowed === true && permResp?.reason === 'smoke'])

let fail = 0
for (const [name, okFlag] of checks) {
  console.log(` ${okFlag ? '✓' : '✗'} ${name}`)
  if (!okFlag) fail++
}
console.log(fail === 0 ? '=== 冒烟全绿 ===' : `=== 冒烟 ${checks.length - fail}/${checks.length} 绿 ===`)
console.log('noticeCode =', noticeCode, '（input_rejected = dsh 前门未起，属预期）')
process.exit(fail === 0 ? 0 : 1)
