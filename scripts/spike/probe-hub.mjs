// probe-hub.mjs — 自终止探针：探测某个 Hub /ws 是否接受 {role} 的 session.hello。
// 用法： node scripts/spike/probe-hub.mjs <wsUrl> <role> [seconds]
// 例：   node scripts/spike/probe-hub.mjs ws://127.0.0.1:15813/ws left 6
import { openHub } from './hubconn.mjs'

const url = process.argv[2] ?? 'ws://127.0.0.1:15813/ws'
const role = process.argv[3] ?? 'left'
const secs = Number(process.argv[4] ?? 6)
const id = `dsh-${role}-probe`

console.log(`[probe] connecting ${url} as role=${role} id=${id}`)

const seen = []
let host = null

try {
  host = await openHub({
    hub: url,
    role,
    id,
    name: `probe-${role}`,
    extra: { brain_mode: role, project_root: process.cwd() },
    onMsg: (m) => {
      seen.push(m.type)
      console.log(`[probe] <- ${m.type} from=${JSON.stringify(m.from)} payload=${JSON.stringify(m.payload ?? {}).slice(0, 200)}`)
    },
  })
  console.log(`[probe] HANDSHAKE OK client_id=${host.clientID}`)
} catch (e) {
  console.log(`[probe] HANDSHAKE FAILED: ${e.message}`)
}

setTimeout(() => {
  console.log(`[probe] done. handshake=${host ? 'OK' : 'FAIL'} msgTypes=[${seen.join(',')}]`)
  process.exit(host ? 0 : 1)
}, secs * 1000)
