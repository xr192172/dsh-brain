/**
 * 卡 3a 验收：编号自动化（§15.6）。
 *
 * 三条判据各自对应一个真实风险：
 * ① 编号格式与自增口径 —— 跨席共用一个计数器会让「第 2 号执行器」变成「第 7 号」；
 * ② 编号即身份 —— 编号若只是日志字段，"同级不可互接"就没人执行（谁都能了结别人的任务）；
 * ③ 席名清洗与前缀容忍 —— 调度席写人话时写 executor-1，强制全名只会制造摩擦。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createCouncilHub } from '../src/server.js'
import type { CouncilHub } from '../src/server.js'
import { SeatRegistry } from '../src/registry.js'
import { connectSeat } from './helpers.js'

let hub: CouncilHub | null = null

afterEach(async () => {
  if (hub) {
    await hub.stop()
    hub = null
  }
})

describe('编号自动化（§15.6）', () => {
  it('编号 = agent:<席名>-<序号>，序号按席名独立自增', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const a = await connectSeat(url, 'executor', 'dsh-a')
    const b = await connectSeat(url, 'executor', 'dsh-b')
    const board = await connectSeat(url, 'review-board', 'board')
    const alpha = await connectSeat(url, 'executor-alpha', 'dsh-alpha')

    expect(a.clientId).toBe('agent:executor-1')
    // ★ 按席名独立自增：第二个 executor 是 2 号，不是全局第 3 号
    expect(b.clientId).toBe('agent:executor-2')
    // review-board 自带连字符，不能被切成 review
    expect(board.clientId).toBe('agent:review-board-1')
    // 带后缀的席名是另一具席位（席名参与编号头部）
    expect(alpha.clientId).toBe('agent:executor-alpha-1')

    const seat = hub.registry.byClientId(alpha.clientId)
    expect(seat?.seatName).toBe('executor-alpha')
    expect(seat?.role).toBe('executor') // 基角色仍用于路由

    a.close()
    b.close()
    board.close()
    alpha.close()
  })

  it('编号即身份：不是被指派者不许了结别人的任务', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const mine = await connectSeat(url, 'executor', 'dsh-a') // agent:executor-1
    const other = await connectSeat(url, 'executor', 'dsh-b') // agent:executor-2
    const sec = await connectSeat(url, 'secretary', 'sec')

    sec.send('task.assign', { task_id: 't_own' }, { to: { role: 'executor', id: mine.clientId } })
    await mine.next('task.assign')
    expect(hub.queue.assigneeOf('t_own')).toBe('agent:executor-1')

    // 同级来抢着回报 ⇒ 必须被拒，且任务不许被抢走
    other.send('task.result', { task_id: 't_own', ok: true })
    const refusal = await other.next('event.notice')
    expect(refusal.payload.code).toBe('task_not_yours')
    expect(String(refusal.payload.detail)).toContain('agent:executor-1')
    expect(hub.queue.stats().running).toBe(1)
    expect(hub.queue.stats().completed).toBe(0)

    // 被指派者回报 ⇒ 收口
    mine.send('task.result', { task_id: 't_own', ok: true })
    const verdict = await mine.next('task.verdict')
    expect(verdict.payload.tracked_task).toBe(true)
    expect(hub.queue.stats().completed).toBe(1)

    mine.close()
    other.close()
    sec.close()
  })

  it('isSeatNumber 容忍 agent: 前缀缺省；席名清洗兜底', () => {
    const reg = new SeatRegistry()
    const seat = reg.register({ role: 'executor', rawRole: 'executor-alpha', send: () => {} })

    expect(seat.clientId).toBe('agent:executor-alpha-1')
    expect(reg.isSeatNumber(seat, 'agent:executor-alpha-1')).toBe(true)
    expect(reg.isSeatNumber(seat, 'executor-alpha-1')).toBe(true)
    expect(reg.isSeatNumber(seat, 'agent:executor-1')).toBe(false)

    // 清洗：去 agent: 前缀、小写、非 [a-z0-9-] 折成连字符
    expect(SeatRegistry.seatNameOf('agent:Review Board', 'executor')).toBe('review-board')
    // 兜底：洗不出东西就用基角色
    expect(SeatRegistry.seatNameOf('   ', 'secretary')).toBe('secretary')
  })
})
