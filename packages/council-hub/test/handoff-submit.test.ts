/**
 * 场景 3：handoff.submit 校验（复用 scripts/seats/handoff-contract.mjs，fail-closed）。
 *
 * 三件事必须同时成立才算验过：
 * ① 不合格的交接包**不转交**（review-board 收不到），且问题清单回给交出者；
 * ② 合格的交接包**被转交**，元信息（depth/from/to）原样带过去；
 * ③ 校验器**确实是那一份**（不是另写一把尺、也不是"加载失败就放行"）。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createCouncilHub } from '../src/server.js'
import type { CouncilHub } from '../src/server.js'
import { handoffContractUrl, validateHandoffText } from '../src/protocol.js'
import { connectSeat, expectNoMessage } from './helpers.js'

let hub: CouncilHub | null = null

afterEach(async () => {
  if (hub) {
    await hub.stop()
    hub = null
  }
})

const GOOD_HANDOFF = [
  '# 交接包 · council-hub 骨架',
  '- depth: 1',
  '- from: executor-alpha@1',
  '- to: review-board',
  '## 已完成（含证据）',
  '- 建包与协议层 —— 证据：`npx vitest run --root packages/council-hub`',
  '## 未完成（剩余）',
  '- 编号自动化 —— 原因：待建队列 #3 尚未开工',
  '## 关键发现与坑',
  '- bridge 的 handoff-contract import 路径写错，被 try/catch 吞成放行',
  '## 下一步建议',
  '- 接队列 #2 的额度回闸口',
].join('\n')

const BAD_HANDOFF = '# 交接包 · 半成品\n- depth: 1\n- from: executor-alpha@1\n- to: review-board\n## 已完成（含证据）\n- 做了一半\n'

describe('handoff.submit 校验', () => {
  it('校验器就是 scripts/seats/handoff-contract.mjs（复用，不是自造）', async () => {
    const url = handoffContractUrl()
    expect(url).toContain('scripts/seats/handoff-contract.mjs')
    expect(fs.existsSync(fileURLToPath(url))).toBe(true)

    const verdict = await validateHandoffText(BAD_HANDOFF)
    expect(verdict.ok).toBe(false)
    expect(verdict.source).toBe('scripts/seats/handoff-contract.mjs')
    // ★ 这些措辞只有那份真实现会产出（自己乱写一把尺很难刚好一样）
    expect(verdict.problems.join('；')).toMatch(/缺段/)
  })

  it('不合格 ⇒ 不转交 review-board，问题清单回给交出者', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor', 'dsh-a')
    const board = await connectSeat(url, 'review-board', 'board')

    executor.send('handoff.submit', { markdown: BAD_HANDOFF })

    const notice = await executor.next('event.notice')
    expect(notice.payload.code).toBe('handoff_invalid')
    expect(Array.isArray(notice.payload.problems)).toBe(true)
    expect(notice.payload.problems.length).toBeGreaterThan(0)

    // ★ fail-closed 的判据：评审席一个字都不该收到
    await expectNoMessage(board, 'handoff.submit', 200)

    executor.close()
    board.close()
  })

  it('合格 ⇒ 转交 review-board，元信息原样带过去', async () => {
    hub = createCouncilHub({ port: 0 })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor', 'dsh-a')
    const board = await connectSeat(url, 'review-board', 'board')

    executor.send('handoff.submit', { markdown: GOOD_HANDOFF })

    const forwarded = await board.next('handoff.submit')
    expect(forwarded.payload.meta).toMatchObject({ depth: '1', from: 'executor-alpha@1', to: 'review-board' })
    expect(forwarded.payload.validated_by).toBe('scripts/seats/handoff-contract.mjs')
    expect(forwarded.payload.sections.length).toBe(4)

    const ack = await executor.next('event.notice')
    expect(ack.payload.code).toBe('handoff_accepted')
    expect(ack.payload.relayed).toBe(true)

    executor.close()
    board.close()
  })

  it('校验器不可用 ⇒ 也拦（fail-closed，不降级放行）', async () => {
    hub = createCouncilHub({
      port: 0,
      handoffValidate: async () => {
        throw new Error('契约模块加载失败（模拟）')
      },
    })
    const { url } = await hub.start()

    const executor = await connectSeat(url, 'executor', 'dsh-a')
    const board = await connectSeat(url, 'review-board', 'board')

    executor.send('handoff.submit', { markdown: GOOD_HANDOFF })

    const notice = await executor.next('event.notice')
    expect(notice.payload.code).toBe('handoff_validator_unavailable')
    await expectNoMessage(board, 'handoff.submit', 200)

    executor.close()
    board.close()
  })
})
