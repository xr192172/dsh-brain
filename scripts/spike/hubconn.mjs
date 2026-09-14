// spike 共享连接助手：极简 Hub v2 WS 客户端。
// 只实现 spike 所需的最小协议面：hello/welcome + 收发 envelope。
// 参照 hub/v2/protocol.go（Hello/Welcome/Message/Address/permission payload）。
import { WebSocket } from 'ws'
import { randomBytes } from 'node:crypto'

export function genId() {
  return 'msg_' + randomBytes(4).toString('hex')
}

export function addr(role, id = '') {
  const a = { role }
  if (id) a.id = id
  return a
}

/** 连接 Hub /ws 并完成 session.hello→welcome 握手。 */
export function openHub({ hub = 'ws://127.0.0.1:15813/ws', role, id, name, extra = {}, onMsg }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(hub)
    const connected = { ws, clientID: '', send: null }

    ws.on('message', (data) => {
      let m
      try {
        m = JSON.parse(String(data))
      } catch {
        return
      }
      if (m.type === 'session.welcome') {
        connected.clientID = m.payload?.client_id ?? ''
        connected.send = (type, to, payload, correlationID) => {
          const msg = {
            protocol: '2.0',
            id: genId(),
            correlation_id: correlationID,
            type,
            from: addr(role, connected.clientID),
            to: typeof to === 'string' ? addr(to) : to,
            timestamp: Date.now(),
            payload,
          }
          ws.send(JSON.stringify(msg))
        }
        console.log(`[${id}] welcome client_id=${connected.clientID}`)
        resolve(connected)
        return
      }
      if (onMsg) onMsg(m)
    })

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          protocol: '2.0',
          id: genId(),
          type: 'session.hello',
          from: addr(role, id),
          to: addr('hub'),
          timestamp: Date.now(),
          payload: { role, id, brain_mode: extra.brain_mode, model: 'dsh', client_name: name, ...(extra.project_root ? { project_root: extra.project_root } : {}) },
        }),
      )
    })
    ws.on('error', (e) => reject(e))
    ws.on('close', () => {
      connected.closed = true
    })
  })
}