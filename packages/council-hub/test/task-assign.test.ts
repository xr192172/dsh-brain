/**
 * 场景 2：task.assign 下发（含目标不在线时的如实回报）。
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

describe('task.assign 下发', () => {
  it('按 client_id 点名下发：执行席收到任务，correlation_id 就是任务 id', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor', 'dsh-a')
    const secretary = await connectSeat(url, 'secretary', 'sec')

    secretary.send(
      'task.assign',
      { task_id: 't_001', title: '实现 protocol.ts', budget: { maxSteps: 5 } },
      { to: { role: 'executor', id: executor.clientId } },
    )

    const got = await executor.next('task.assign')
    expect(got.payload.task_id).toBe('t_001')
    expect(got.payload.title).toBe('实现 protocol.ts')
    // 下发者的身份要能追溯（from 保持原样，不篡改成 hub）
    expect(got.from.role).toBe('secretary')
    expect(got.correlation_id).toBe('t_001')
    expect(got.to.id).toBe(executor.clientId)
    expect(hub.queue.stats().running).toBe(1)

    executor.close()
    secretary.close()
  })

  it('只给基角色不给 id 时，发给该角色的在线席位', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor-beta', 'dsh-b')
    const board = await connectSeat(url, 'review-board', 'board')

    board.send('task.assign', { task_id: 't_role' }, { to: { role: 'executor' } })

    const got = await executor.next('task.assign')
    expect(got.payload.task_id).toBe('t_role')
    expect(got.to.role).toBe('executor')

    executor.close()
    board.close()
  })

  it('目标不在线 ⇒ 任务判失败，并把 task_unroutable 回给下发者（不假装成功）', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const secretary = await connectSeat(url, 'secretary', 'sec')
    secretary.send('task.assign', { task_id: 't_ghost' }, { to: { role: 'executor', id: 'c_999' } })

    const notice = await secretary.next('event.notice')
    expect(notice.payload.code).toBe('task_unroutable')
    expect(String(notice.payload.detail)).toContain('t_ghost')
    expect(hub.queue.stats().failed).toBe(1)
    expect(hub.queue.stats().running).toBe(0)

    secretary.close()
  })
})
