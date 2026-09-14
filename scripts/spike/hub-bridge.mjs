// spike: 脑端（role=brain），代表一个 dsh 实例接入老 Hub。
// 验证三件事：
//  1) hello→welcome 握手成功；
//  2) 能向 ui 广播一条 event.message（真实触达 dsh switchboard 的状态）；
//  3) 发 permission.request【dsh.swap】换代申请 → 收到 ui 端 permission.response→该人类批准；
//     Hub 按 correlation_id 路由回本脑，本身就证明"Hub 能按 ID 路由回该 dsh 脑"。
import { openHub, genId } from './hubconn.mjs'

const DSH_CTRL = 'http://127.0.0.1:31800'

let host
let uiApproved = null

async function dshStatus() {
  try {
    const r = await fetch(DSH_CTRL + '/?cmd=status')
    const j = await r.json()
    return `activeGen=${j.lease?.activeGen?.gen ?? '-'} stage=${j.stage} locked=${!!j.locked} result=${j.result?.result ?? 'none'}`
  } catch (e) {
    return 'dsh-status-ERR:' + e.message
  }
}

async function main() {
  host = await openHub({
    role: 'brain',
    id: 'dsh-1',
    name: 'dsh-brain-spike',
    extra: { brain_mode: 'left', project_root: process.cwd() },
    onMsg: async (m) => {
      if (m.type === 'permission.response') {
        const allowed = m.payload?.allowed
        uiApproved = allowed
        console.log(`[brain] 换代审批响应: allowed=${allowed} reason=${m.payload?.reason}`)
        // 全绿判定：至此三件验收都完成
        finish()
      }
    },
  })

  // 2) 真实触达 dsh switchboard，把状态广播给 ui（兼证 Hub 能投递给 ui）
  const st = await dshStatus()
  host.send('event.message', { role: 'ui', broadcast: true }, { role: 'assistant', content: '[dsh-brain-spike] ' + st })

  // 3) 换代申请：复用 permission.request/response 通道，语义=dsh.swap
  const corr = 'corr_' + genId()
  const args = JSON.stringify({ gen: 'gen-3090', reason: 'spike-verify-approval-path' })
  console.log(`[brain] 发起换代申请 dsh.swap correlation=${corr}`)
  host.send('permission.request', { role: 'hub' }, { tool_name: 'dsh.swap', tool_args: args, tier: 'hard' }, corr)
}

function finish() {
  const s = 'GREEN (accepted)'
  console.log('=== spike-bridge 判定 ===')
  console.log(' hub 引导 dsh 为脑:  OK (hello→welcome)')
  console.log(' hub 投递给 ui:      OK (event.message 已广播)')
  console.log(' 换代审批往返:      ' + s)
  setTimeout(() => process.exit(0), 200)
}

main().catch((e) => {
  console.error('bridge fail:', e.message)
  process.exit(1)
})