/**
 * 场景 5：sentinel.alert 路由（监督席 → hub → review-board + ui）。
 *
 * 监督席的价值全在"警报一定送到评审席"：送不到就等于监督席不存在。
 * ⇒ 这里同时验三处：评审席收到、观察面（ui）收到、hub 把警报**记下来了**（可追溯）。
 */
import { afterEach, describe, expect, it } from 'vitest'
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

describe('sentinel.alert 路由', () => {
  it('监督席的警报同时到 review-board 与 ui，并被 hub 记录', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const sentinel = await connectSeat(url, 'sentinel', 'sentinel-1')
    const board = await connectSeat(url, 'review-board', 'board')
    const ui = await connectSeat(url, 'ui', 'console')

    sentinel.send('sentinel.alert', {
      kind: 'budget_exceeded',
      target: 'executor-alpha',
      detail: '预授权 5 步已用尽仍在直连',
    })

    const toBoard = await board.next('sentinel.alert')
    expect(toBoard.payload.kind).toBe('budget_exceeded')
    expect(toBoard.payload.target).toBe('executor-alpha')
    expect(toBoard.payload.alert_id).toBe('alert_1')
    expect(toBoard.from.role).toBe('sentinel')

    const toUi = await ui.next('sentinel.alert')
    expect(toUi.payload.alert_id).toBe('alert_1')
    expect(toUi.to.role).toBe('ui')

    const ack = await sentinel.next('event.notice')
    expect(ack.payload.code).toBe('sentinel_alert_recorded')
    expect(ack.payload.relayed_to_review_board).toBe(true)

    // hub 自己留痕：监督席的警报不能"路由完就没了"
    expect(hub.alerts.length).toBe(1)
    expect(hub.alerts[0].from).toBe('agent:sentinel-1')
    expect(hub.alerts[0].payload.kind).toBe('budget_exceeded')

    sentinel.close()
    board.close()
    ui.close()
  })

  it('没有 review-board 在线时如实回报未转交（不谎报已送达）', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const sentinel = await connectSeat(url, 'sentinel', 'sentinel-1')
    sentinel.send('sentinel.alert', { kind: 'skip_review', target: 'executor-beta' })

    const ack = await sentinel.next('event.notice')
    expect(ack.payload.code).toBe('sentinel_alert_recorded')
    expect(ack.payload.relayed_to_review_board).toBe(false)
    expect(hub.alerts.length).toBe(1)

    sentinel.close()
  })

  it('未知通道不静默丢弃：回 event.notice(unknown_type)', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor', 'dsh-a')
    executor.send('task.magic', { x: 1 })

    const notice = await executor.next('event.notice')
    expect(notice.payload.code).toBe('unknown_type')
    expect(String(notice.payload.detail)).toContain('task.magic')

    executor.close()
  })
})
