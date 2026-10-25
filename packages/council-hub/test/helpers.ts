/**
 * helpers.ts —— 测试用 WS 席位客户端（不是 *.test.ts，不会被当成用例收集）。
 *
 * ★ 用**真连接**而不是 mock：协议类组件的 bug 几乎全在"线上形态"（信封字段名、client_id、
 *   关闭时序、广播次数）。mock 掉 ws 就只剩"函数被调过"，那验不到这张卡的验收目标。
 */
import { WebSocket } from 'ws'

export interface TestSeat {
  ws: WebSocket
  role: string
  readonly clientId: string
  inbox: any[]
  send(type: string, payload?: Record<string, unknown>, opts?: { to?: { role: string; id?: string }; correlation_id?: string }): void
  next(type: string, timeoutMs?: number): Promise<any>
  seen(type: string): boolean
  close(): void
}

let idCounter = 0

/** 连上 hub 并完成 session.hello → session.welcome，返回可收发消息的席位 */
export function connectSeat(url: string, role: string, name = role): Promise<TestSeat> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const inbox: any[] = []
    const waiters: { type: string; resolve: (m: any) => void; timer: ReturnType<typeof setTimeout> }[] = []
    let clientId = ''

    const deliver = (m: any): void => {
      const i = waiters.findIndex((w) => w.type === m.type)
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0]
        clearTimeout(w.timer)
        w.resolve(m)
        return
      }
      inbox.push(m)
    }

    const seat: TestSeat = {
      ws,
      role,
      get clientId(): string {
        return clientId
      },
      inbox,
      send(type, payload = {}, opts = {}) {
        idCounter += 1
        const now = Date.now()
        ws.send(
          JSON.stringify({
            protocol: 'council-hub/1',
            id: `m_${idCounter}`,
            ...(opts.correlation_id ? { correlation_id: opts.correlation_id } : {}),
            type,
            from: { role, id: clientId },
            to: opts.to ?? { role: 'hub' },
            ts: now,
            timestamp: now,
            payload,
          }),
        )
      },
      next(type, timeoutMs = 2000) {
        const hit = inbox.findIndex((m) => m.type === type)
        if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0])
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.findIndex((w) => w.timer === timer)
            if (i >= 0) waiters.splice(i, 1)
            rej(new Error(`等待 ${type} 超时 ${timeoutMs}ms；已收到：${inbox.map((m) => m.type).join(', ') || '(空)'}`))
          }, timeoutMs)
          waiters.push({ type, resolve: res, timer })
        })
      },
      seen(type) {
        return inbox.some((m) => m.type === type)
      },
      close() {
        try {
          ws.close()
        } catch {
          /* 已断开 */
        }
      },
    }

    ws.on('message', (data: unknown) => {
      let m: any
      try {
        m = JSON.parse(String(data))
      } catch {
        return
      }
      if (m.type === 'session.welcome') {
        clientId = String(m.payload?.client_id ?? '')
        resolve(seat)
        return
      }
      deliver(m)
    })
    ws.on('error', (e: Error) => reject(e))
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          protocol: 'council-hub/1',
          id: `hello_${role}_${(idCounter += 1)}`,
          type: 'session.hello',
          from: { role, id: name },
          to: { role: 'hub' },
          ts: Date.now(),
          payload: { role, client_name: name },
        }),
      )
    })
  })
}

/** 断言在 ms 内**没有**收到某类消息 —— "没发生"也是判据（fail-closed 只能这么验） */
export async function expectNoMessage(seat: TestSeat, type: string, ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
  if (seat.seen(type)) {
    throw new Error(`不该收到 ${type}，但收到了：${JSON.stringify(seat.inbox.find((m) => m.type === type))}`)
  }
}

/** 轮询等待条件成立 */
export async function waitFor(fn: () => boolean, timeoutMs = 2000, label = '条件'): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等待${label}超时 ${timeoutMs}ms`)
}
