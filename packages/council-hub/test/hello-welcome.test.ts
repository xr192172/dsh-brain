/**
 * 场景 1：session.hello → session.welcome（含角色白名单与旧协议兼容）。
 *
 * 这一组盯的是**握手面**：进来的人是不是被认成了正确的基角色、不该进来的有没有被挡住、
 * 现役 bridge 说的 `protocol: '2.0'` 还认不认。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createCouncilHub } from '../src/server.js'
import type { CouncilHub } from '../src/server.js'
import { connectSeat } from './helpers.js'

let hub: CouncilHub | null = null

afterEach(async () => {
  if (hub) {
    await hub.stop()
    hub = null
  }
})

describe('session.hello → session.welcome', () => {
  it('executor-alpha 被归一化为基角色 executor，并拿到 client_id', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const seat = await connectSeat(url, 'executor-alpha', 'dsh-alpha')
    expect(seat.clientId).toMatch(/^c_\d{3}$/)

    const registered = hub.registry.byClientId(seat.clientId)
    expect(registered?.role).toBe('executor')
    // ★ 原始角色串要留着：回执/审计要能看出它到底是谁（不是"某个 executor"）
    expect(registered?.rawRole).toBe('executor-alpha')
    expect(hub.registry.size).toBe(1)

    seat.close()
  })

  it('review-board 不被连字符切成 review（白名单最长优先）', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const seat = await connectSeat(url, 'review-board', 'board')
    expect(hub.registry.byClientId(seat.clientId)?.role).toBe('review-board')

    seat.close()
  })

  it('非白名单角色 ROLE_NOT_FOUND 并关连接（不占 client_id）', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const ws = new WebSocket(url)
    const received: any[] = []
    ws.on('message', (d: unknown) => received.push(JSON.parse(String(d))))
    await new Promise<void>((res) => ws.on('open', () => res()))
    const closed = new Promise<void>((res) => ws.on('close', () => res()))

    ws.send(
      JSON.stringify({
        protocol: 'council-hub/1',
        id: 'h_left',
        type: 'session.hello',
        from: { role: 'left', id: 'old-brain' },
        to: { role: 'hub' },
        ts: Date.now(),
        payload: { role: 'left' },
      }),
    )

    await closed
    const err = received.find((m) => m.type === 'system.error')
    expect(err?.payload?.code).toBe('ROLE_NOT_FOUND')
    expect(err?.payload?.allowed).toEqual(['hub', 'ui', 'secretary', 'review-board', 'executor', 'sentinel'])
    expect(hub.registry.size).toBe(0)
  })

  it('兼容现役 bridge：protocol=2.0 + timestamp 字段的 hello 也认', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const ws = new WebSocket(url)
    const received: any[] = []
    ws.on('message', (d: unknown) => received.push(JSON.parse(String(d))))
    await new Promise<void>((res) => ws.on('open', () => res()))

    // ★ 这一段逐字照 scripts/spike/hubconn.mjs 的 hello 形状（bridge 就是这么说的）
    ws.send(
      JSON.stringify({
        protocol: '2.0',
        id: 'msg_legacy',
        type: 'session.hello',
        from: { role: 'executor-alpha', id: 'dsh-alpha' },
        to: { role: 'hub' },
        timestamp: Date.now(),
        payload: { role: 'executor-alpha', id: 'dsh-alpha', model: 'dsh', client_name: 'dsh-alpha' },
      }),
    )

    const welcome = await new Promise<any>((res) => {
      const iv = setInterval(() => {
        const hit = received.find((m) => m.type === 'session.welcome')
        if (hit) {
          clearInterval(iv)
          res(hit)
        }
      }, 10)
    })

    expect(welcome.payload.client_id).toMatch(/^c_\d{3}$/)
    expect(welcome.payload.protocol).toBe('council-hub/1')
    // 出站同时带 ts 与 timestamp（bridge 读后者）
    expect(typeof welcome.ts).toBe('number')
    expect(welcome.timestamp).toBe(welcome.ts)
    ws.close()
  })
})
