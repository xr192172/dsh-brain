/**
 * 场景 4：队列并发上限（config.maxConcurrent）。
 *
 * 两个层次都验：
 * ① **端到端**：maxConcurrent=1 时第二条任务**不会被下发**，直到第一条回报结果；
 * ② **单元**：优先级 + 依赖序（端到端里被并发上限掩盖，只能直接测队列）。
 */
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createCouncilHub } from '../src/server.js'
import type { CouncilHub } from '../src/server.js'
import { TaskQueue } from '../src/queue.js'
import { connectSeat, expectNoMessage } from './helpers.js'

let hub: CouncilHub | null = null

afterEach(async () => {
  if (hub) {
    await hub.stop()
    hub = null
  }
})

describe('队列并发上限（端到端）', () => {
  it('maxConcurrent=1：第二条任务必须等第一条回报后才下发', async () => {
    hub = createCouncilHub({ port: 0, maxConcurrent: 1 })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor', 'dsh-a')
    const secretary = await connectSeat(url, 'secretary', 'sec')
    const toExec = { to: { role: 'executor', id: executor.clientId } }

    secretary.send('task.assign', { task_id: 't_1' }, toExec)
    secretary.send('task.assign', { task_id: 't_2' }, toExec)

    const first = await executor.next('task.assign')
    expect(first.payload.task_id).toBe('t_1')
    // ★ 上限是硬闸：第二条此刻不许出现
    await expectNoMessage(executor, 'task.assign', 200)
    expect(hub.queue.stats()).toMatchObject({ pending: 1, running: 1, maxConcurrent: 1 })

    executor.send('task.result', { task_id: 't_1', ok: true })

    const second = await executor.next('task.assign')
    expect(second.payload.task_id).toBe('t_2')
    expect(hub.queue.stats()).toMatchObject({ pending: 0, running: 1, completed: 1 })

    // 产物回收：hub 回执 task.verdict（语义判定留给评审席）
    const verdict = await executor.next('task.verdict')
    expect(verdict.payload.task_id).toBe('t_1')
    expect(verdict.payload.verdict).toBe('received')
    expect(verdict.payload.tracked_task).toBe(true)

    executor.close()
    secretary.close()
  })

  it('有 review-board 在线时，task.result 会被转交过去', async () => {
    hub = createCouncilHub({ port: 0, maxConcurrent: 2 })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor', 'dsh-a')
    const board = await connectSeat(url, 'review-board', 'board')
    const secretary = await connectSeat(url, 'secretary', 'sec')

    secretary.send('task.assign', { task_id: 't_relay' }, { to: { role: 'executor' } })
    await executor.next('task.assign')
    executor.send('task.result', { task_id: 't_relay', ok: true, artifact: 'lib/protocol.js' })

    const relayed = await board.next('task.result')
    expect(relayed.payload.artifact).toBe('lib/protocol.js')
    const verdict = await executor.next('task.verdict')
    expect(verdict.payload.relayed_to_review_board).toBe(true)

    executor.close()
    board.close()
    secretary.close()
  })
})

describe('队列语义（单元）', () => {
  const endpoint = { role: 'executor' }

  it('优先级大者先出；同优先级先到先得', () => {
    const q = new TaskQueue({ maxConcurrent: 10 })
    q.enqueue({ id: 'low1', priority: 0, from: endpoint, to: endpoint })
    q.enqueue({ id: 'high', priority: 5, from: endpoint, to: endpoint })
    q.enqueue({ id: 'low2', priority: 0, from: endpoint, to: endpoint })

    expect(q.nextRunnable()?.id).toBe('high')
    expect(q.nextRunnable()?.id).toBe('low1')
    expect(q.nextRunnable()?.id).toBe('low2')
    expect(q.nextRunnable()).toBeNull()
  })

  it('dependsOn 未完成则阻塞，完成后放行', () => {
    const q = new TaskQueue({ maxConcurrent: 10 })
    q.enqueue({ id: 'a', from: endpoint, to: endpoint })
    q.enqueue({ id: 'b', dependsOn: ['a'], from: endpoint, to: endpoint })

    const first = q.nextRunnable()
    expect(first?.id).toBe('a')
    // a 在跑但没完成 ⇒ b 不许出队（依赖看的是"完成"，不是"入队顺序"）
    expect(q.nextRunnable()).toBeNull()

    expect(q.finish('a', 'completed')).toBe(true)
    expect(q.nextRunnable()?.id).toBe('b')
  })

  it('并发上限为硬闸：running 满时 nextRunnable 恒为 null', () => {
    const q = new TaskQueue({ maxConcurrent: 2 })
    q.enqueue({ id: 'x1', from: endpoint, to: endpoint })
    q.enqueue({ id: 'x2', from: endpoint, to: endpoint })
    q.enqueue({ id: 'x3', from: endpoint, to: endpoint })

    expect(q.nextRunnable()?.id).toBe('x1')
    expect(q.nextRunnable()?.id).toBe('x2')
    expect(q.nextRunnable()).toBeNull()
    expect(q.stats()).toMatchObject({ pending: 1, running: 2, maxConcurrent: 2 })
  })

  it('同 id 重复入队抛错（不静默覆盖）；未派发就回报 finish=false', () => {
    const q = new TaskQueue({ maxConcurrent: 1 })
    q.enqueue({ id: 'dup', from: endpoint, to: endpoint })
    expect(() => q.enqueue({ id: 'dup', from: endpoint, to: endpoint })).toThrow(/重复/)
    expect(q.finish('nobody', 'completed')).toBe(false)
  })
})

describe('验收场景文件齐备', () => {
  it('HANDOFF §7 点名的 5 个场景文件都在盘上', () => {
    for (const name of ['hello-welcome', 'task-assign', 'handoff-submit', 'queue-concurrency', 'sentinel-alert']) {
      const p = new URL(`./${name}.test.ts`, import.meta.url)
      expect(fs.existsSync(p), `缺 ${name}.test.ts`).toBe(true)
    }
  })
})
