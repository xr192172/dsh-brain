// spike: UI 端（role=ui），模拟"人类在面板点通过"。
// 收到 permission.request【dsh.swap】→ 打印并向 Hub 回 permission.response {allowed:true}。
import { openHub } from './hubconn.mjs'

async function main() {
  const host = await openHub({
    role: 'ui',
    id: 'ui-1',
    name: 'spike-ui',
    extra: {},
    onMsg: (m) => {
      if (m.type === 'permission.request' && m.payload?.tool_name === 'dsh.swap') {
        const args = m.payload?.tool_args ? JSON.parse(m.payload.tool_args) : {}
        console.log(`[ui] 收到换代申请: gen=${args.gen} reason=${args.reason} correlation=${m.correlation_id}`)
        // 模拟人类点"通过"
        host.send(
          'permission.response',
          { role: 'hub' },
          { allowed: true, reason: 'spike-human-approve' },
          m.correlation_id,
        )
        console.log('[ui] 回: permission.response {allowed:true}')
      } else if (m.type === 'event.message') {
        console.log('[ui] 收到脑的消息:', m.payload?.content ?? '(空)')
      } else if (m.type === 'peer_update') {
        console.log('[ui] peer_update:', JSON.stringify(m.payload))
      }
    },
  })
  // ui 端保持存活一段时间，若收到 event.message / permission.request 便打印
  setTimeout(() => process.exit(0), 15000)
}

main().catch((e) => {
  console.error('ui fail:', e.message)
  process.exit(1)
})