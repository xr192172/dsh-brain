/**
 * 卡 2 验收：bridge ↔ council-hub 端到端（真组件，不 mock 任一侧）。
 *
 * 为什么必须用真组件：这条接缝的 bug 只可能长在"线上形态"——信封 protocol 字段、
 * 角色归一化、task_id 的回传、journal 事件到通道的映射。把任何一侧 mock 掉，
 * 验的就只剩"函数被调过"。
 *
 * 拓扑：council-hub（真）←→ bridge（真，--protocol council-hub）←→ mock dsh 前门（HTTP）
 *                                                    ↑ journal 轮询（临时目录里的 session.jsonl）
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCouncilHub } from '../src/server.js'
import type { CouncilHub } from '../src/server.js'
import { connectSeat, expectNoMessage, waitFor } from './helpers.js'

const BRIDGE_URL = new URL('../../../bridge/hub-bridge.mjs', import.meta.url).href
const SID = 'sess-e2e'

interface Fixture {
  hub: CouncilHub
  bridge: any
  prompts: any[]
  journalFile: string
  url: string
  seatClientId: string
  close: () => Promise<void>
}

/** mock dsh 前门：只实现 bridge 会打的 two 个端点 */
function startFront() {
  const prompts: any[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw || '{}')
      const json = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.url === '/api/session.prompt') {
        prompts.push(body.payload)
        return json(200, { result: { value: { ok: true } } })
      }
      if (req.url === '/api/session.list') {
        return json(200, { result: { value: { items: [{ sessionId: SID, running: false }] } } })
      }
      return json(404, {})
    })
  })
  return new Promise<{ url: string; prompts: any[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        prompts,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

/** 往 journal 追加记录（seq 从 from+1 起，模拟 dsh 的顺序写） */
function appendJournal(file: string, recs: any[], from = 0): void {
  const text = recs.map((r, i) => JSON.stringify({ seq: from + i + 1, ...r })).join('\n') + '\n'
  fs.appendFileSync(file, text)
}

let fixture: Fixture | null = null

afterEach(async () => {
  if (!fixture) return
  fixture.bridge.stop()
  await fixture.hub.stop()
  await fixture.close()
  try {
    fs.rmSync(path.dirname(path.dirname(path.dirname(fixture.journalFile))), { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉不算失败 */
  }
  fixture = null
})

async function setup(): Promise<Fixture> {
  const journalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'))
  const journalFile = path.join(journalRoot, 'desktop', SID, 'session.jsonl')
  fs.mkdirSync(path.dirname(journalFile), { recursive: true })
  fs.writeFileSync(journalFile, '') // 先建空 journal：bridge 的基线 = 0，后续追加才会被读到

  const front = await startFront()
  const hub = createCouncilHub({ port: 0, maxConcurrent: 2 })
  const { url } = await hub.start()

  const { createBridge } = await import(/* @vite-ignore */ BRIDGE_URL)
  const bridge = createBridge({
    hub: url,
    role: 'executor-alpha',
    name: 'dsh-e2e',
    front: front.url,
    sessionId: SID,
    journalRoot,
    pollMs: 30,
    protocol: 'council-hub',
    log: () => {},
  })
  await bridge.start()
  await bridge.whenConnected(3000)
  // 等第一轮 poll 把基线吃掉（否则会把"启动前的历史"当成新事件）
  await new Promise((r) => setTimeout(r, 120))

  const seat = hub.registry.list().find((s) => s.rawRole === 'executor-alpha')
  if (!seat) throw new Error('bridge 未在 council-hub 注册成席位')

  fixture = {
    hub,
    bridge,
    prompts: front.prompts,
    journalFile,
    url,
    seatClientId: seat.clientId,
    close: front.close,
  }
  return fixture
}

/** 让 hub 给 bridge 席位下发一个任务，并等 bridge 把它打到前门 */
async function assignTask(f: Fixture, taskId: string, instruction: string): Promise<void> {
  const secretary = await connectSeat(f.url, 'secretary', 'sec')
  secretary.send('task.assign', { task_id: taskId, instruction }, { to: { role: 'executor', id: f.seatClientId } })
  await waitFor(() => f.prompts.length > 0, 3000, 'session.prompt 到账')
  secretary.close()
}

describe('bridge ↔ council-hub 端到端', () => {
  it('bridge 以 executor-alpha 接入，被归一化为基角色 executor', async () => {
    const f = await setup()

    const seat = f.hub.registry.byClientId(f.seatClientId)
    expect(seat?.role).toBe('executor')
    expect(seat?.rawRole).toBe('executor-alpha')
    // ★ 握手用的是新协议标识（不是靠 2.0 兼容活着）
    expect(f.bridge.cfg.protocol).toBe('council-hub')
  })

  it('下向：task.assign → command.input → dsh 前门 session.prompt', async () => {
    const f = await setup()
    await assignTask(f, 't_bridge_1', '实现 protocol.ts 的 baseRole')

    const prompt = f.prompts[0]
    expect(prompt.sessionId).toBe(SID)
    expect(prompt.mode).toBe('steer')
    expect(prompt.content[0].text).toBe('实现 protocol.ts 的 baseRole')
    // 任务已在 hub 侧占位（下发即 running）
    expect(f.hub.queue.stats().running).toBe(1)
  })

  it('上向：turn/end → task.result（带 task_id）；交接包合格才 handoff.submit', async () => {
    const f = await setup()
    await assignTask(f, 't_bridge_2', '写交接包')

    const board = await connectSeat(f.url, 'review-board', 'board')

    // ── ① 不合格的交接包：hub 必须拦住，review-board 一个字都不该收到 ──
    const bad = '# 交接包 · 半成品\n- depth: 1\n- from: executor-alpha@1\n- to: review-board\n## 已完成（含证据）\n- 做了一半\n'
    appendJournal(f.journalFile, [{ type: 'message/assistant', data: { message: { content: [{ text: bad }] } } }])
    await expectNoMessage(board, 'handoff.submit', 250)

    // ── ② 合格的交接包：转给 review-board，元信息与校验来源都要在 ──
    const good = [
      '# 交接包 · bridge 适配',
      '- depth: 1',
      '- from: executor-alpha@1',
      '- to: review-board',
      '## 已完成（含证据）',
      '- 三向翻译落地 —— 证据：`npx vitest run --root packages/council-hub`',
      '## 未完成（剩余）',
      '- 工具级事件转发 —— 原因：评审团只消费产物与交接包',
      '## 关键发现与坑',
      '- hubconn 的 hello protocol 是硬编码 2.0，已参数化',
      '## 下一步建议',
      '- 接编号自动化（父任务可继承）',
    ].join('\n')
    appendJournal(f.journalFile, [{ type: 'message/assistant', data: { message: { content: [{ text: good }] } } }], 1)

    const handoff = await board.next('handoff.submit')
    expect(handoff.payload.meta).toMatchObject({ depth: '1', from: 'executor-alpha@1', to: 'review-board' })
    expect(handoff.payload.validated_by).toBe('scripts/seats/handoff-contract.mjs')
    expect(handoff.from.role).toBe('executor')

    // ── ③ 回合结束：task.result 带 task_id 回到 hub，产物转 review-board ──
    appendJournal(f.journalFile, [{ type: 'turn/end', data: { turn: 't_bridge_2', reason: 'stop' } }], 2)

    const result = await board.next('task.result')
    expect(result.payload.task_id).toBe('t_bridge_2')
    expect(result.payload.ok).toBe(true)
    await waitFor(() => f.hub.queue.stats().completed === 1, 3000, '任务收口')
    expect(f.hub.queue.stats().running).toBe(0)

    board.close()
  })
})
