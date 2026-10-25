#!/usr/bin/env node
/**
 * test-bridge.mjs —— bridge 单测
 *
 * 装置：
 *   mock hub   ：ws 服务（hello/welcome + command.input 下发 + 消息记录）
 *   mock dsh   ：http 前门（session.list / session.prompt / session.cancel）+ 明文 journal
 * 断言：
 *   1) 握手（hello 带 role）
 *   2) 下行翻译：command.input → session.prompt（text 不变形）
 *   3) 上行翻译：journal 记录 → event.tool_call/tool_result/turn_done/message
 *   4) permission 透传：payload 原样、correlation 往返
 *   5) 交接包闸口：不合格拦截、合格下发
 *   6) command.cancel → session.cancel
 *   7) 断线重连：杀 hub → 桥自动重连并重新握手
 * 跑法：node bridge/test-bridge.mjs（全 PASS 退出码 0）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createBridge, findJournalFile, readJournal, translateRecord, looksLikeHandoff } from './hub-bridge.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
const results = []
function ok(name, fn) {
  results.push({ name, fn })
}
async function run() {
  for (const t of results) {
    await t.fn()
    passed++
    console.log(`  ✓ ${t.name}`)
  }
}

// ── mock hub ──────────────────────────────────────────────────────────
function startMockHub(port) {
  const wss = new WebSocketServer({ port })
  const state = { messages: [], hellos: 0, waiters: [] }
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let m
      try {
        m = JSON.parse(String(data))
      } catch {
        return
      }
      state.messages.push(m)
      if (m.type === 'session.hello') {
        state.hellos++
        ws.send(
          JSON.stringify({
            protocol: '2.0',
            id: 'srv_' + Math.random().toString(16).slice(2),
            type: 'session.welcome',
            from: { role: 'hub' },
            to: m.from,
            timestamp: Date.now(),
            payload: { client_id: 'mock-client-' + state.hellos },
          }),
        )
        state.waiters.splice(0).forEach((r) => r())
      }
    })
  })
  const broadcast = (type, payload, correlation_id) => {
    const msg = {
      protocol: '2.0',
      id: 'srv_' + Math.random().toString(16).slice(2),
      correlation_id,
      type,
      from: { role: 'hub' },
      to: { role: 'executor-alpha' },
      timestamp: Date.now(),
      payload,
    }
    for (const c of wss.clients) c.send(JSON.stringify(msg))
    return msg
  }
  const close = () =>
    new Promise((resolve) => {
      for (const c of [...wss.clients]) c.terminate()
      wss.close(() => resolve())
    })
  return { wss, state, broadcast, close }
}

// ── mock dsh 前门 ─────────────────────────────────────────────────────
function startMockDsh(port) {
  const state = { prompts: [], cancels: [] }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      const method = req.url.replace('/api/', '')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (method === 'session.list') {
        res.end(JSON.stringify({ result: { value: { items: [{ sessionId: 'sess-test', running: false, cwd: 'T' }] } } }))
      } else if (method === 'session.prompt') {
        state.prompts.push(body.payload)
        res.end(JSON.stringify({ result: { value: { ok: true } } }))
      } else if (method === 'session.cancel') {
        state.cancels.push(body.payload)
        res.end(JSON.stringify({ result: { value: { ok: true } } }))
      } else {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  return { state, ready: new Promise((r) => server.listen(port, '127.0.0.1', r)), server }
}

// ── 装置 ──────────────────────────────────────────────────────────────
const HUB_PORT = 15981
const DSH_PORT = 15982
const hub = startMockHub(HUB_PORT)
const dsh = startMockDsh(DSH_PORT)
await dsh.ready

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'))
const journalRoot = path.join(tmp, 'sessions')
const sid = 'sess-test'
fs.mkdirSync(path.join(journalRoot, 'p1', sid), { recursive: true })
const journalFile = path.join(journalRoot, 'p1', sid, 'session.jsonl')
const writeJournal = (recs) => fs.writeFileSync(journalFile, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')

const bridge = createBridge({
  hub: `ws://127.0.0.1:${HUB_PORT}/ws`,
  role: 'executor-alpha',
  name: 'dsh-test',
  front: `http://127.0.0.1:${DSH_PORT}`,
  journalRoot,
  pollMs: 60_000, // 手动触发 _pollJournal，避免竞态
  backoffBaseMs: 50,
  backoffMaxMs: 200,
})
await bridge.start()
const waitWelcome = () =>
  new Promise((r, j) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (hub.state.hellos >= 1) {
        clearInterval(iv)
        r()
      } else if (Date.now() - t0 > 5000) {
        clearInterval(iv)
        j(new Error('mock hub 未收到 hello'))
      }
    }, 20)
  })
await bridge.whenConnected()
await waitWelcome()

// ── 用例 ──────────────────────────────────────────────────────────────
ok('1) 握手：hello 携带配置 role 与名字', () => {
  const hello = hub.state.messages.find((m) => m.type === 'session.hello')
  assert.ok(hello, '未收到 session.hello')
  assert.equal(hello.payload.role, 'executor-alpha')
  assert.equal(hello.payload.client_name, 'dsh-test')
  assert.equal(hello.protocol, '2.0')
})

ok('2) 下行翻译：command.input → session.prompt（text/session 映射不变形）', async () => {
  const before = dsh.state.prompts.length
  hub.broadcast('command.input', { text: '把测试跑绿', turn_id: 't-1', session_id: 'hub-sess-1' })
  await sleep(300)
  assert.equal(dsh.state.prompts.length, before + 1, 'session.prompt 未被调用')
  const p = dsh.state.prompts[before]
  assert.equal(p.sessionId, 'sess-test', '应自动挑选 session.list 里的会话')
  assert.equal(p.mode, 'steer')
  assert.equal(p.content[0].type, 'text')
  assert.equal(p.content[0].text, '把测试跑黑'.replace('黑', '绿'), 'text 应原样透传')
  const ack = hub.state.messages.find((m) => m.type === 'event.notice' && m.payload.code === 'input_accepted')
  assert.ok(ack, '受理后应回 event.notice input_accepted')
})

ok('3) 上行翻译：journal → event.tool_call/tool_result/turn_done/message', async () => {
  await bridge._pollJournal() // 首轮：初始化基线（journal 尚空）
  writeJournal([
    { seq: 1, time: 1, type: 'tool/call', data: { name: 'Bash', arguments: '{"cmd":"npm test"}' } },
    { seq: 2, time: 2, type: 'tool/result', data: { callId: 'c-9', message: { content: [{ type: 'text', text: 'all pass', isError: false }] } } },
    { seq: 3, time: 3, type: 'message/assistant', data: { message: { content: [{ type: 'text', text: '测试已修复' }] } } },
    { seq: 4, time: 4, type: 'turn/end', data: { reason: 'completed' } },
  ])
  await bridge._pollJournal()
  await sleep(100)
  const byType = (t) => hub.state.messages.filter((m) => m.type === t)
  const tc = byType('event.tool_call').at(-1)
  const tr = byType('event.tool_result').at(-1)
  const msg = byType('event.message').at(-1)
  const td = byType('event.turn_done').at(-1)
  assert.ok(tc, '缺 event.tool_call')
  assert.equal(tc.payload.tool_name, 'Bash')
  assert.equal(tc.payload.tool_args, '{"cmd":"npm test"}')
  assert.ok(tr, '缺 event.tool_result')
  assert.equal(tr.payload.call_id, 'c-9')
  assert.equal(tr.payload.is_error, false)
  assert.equal(tr.payload.snippet, 'all pass')
  assert.ok(msg, '缺 event.message')
  assert.equal(msg.payload.role, 'assistant')
  assert.equal(msg.payload.content, '测试已修复')
  assert.ok(td, '缺 event.turn_done')
  assert.equal(td.payload.reason, 'completed')
  assert.equal(td.payload.turn_id, 't-1', 'turn_done 应带上最近受理的 hub turn_id')
})

ok('4) permission 透传：payload 原样 + correlation 往返', async () => {
  const rp = bridge.permissionRequest({ tool_name: 'dsh.swap', tool_args: '{"gen":"gen-1"}', tier: 'hard' })
  await sleep(200)
  const req = hub.state.messages.filter((m) => m.type === 'permission.request').at(-1)
  assert.ok(req, 'hub 未收到 permission.request')
  assert.deepEqual(req.payload, { tool_name: 'dsh.swap', tool_args: '{"gen":"gen-1"}', tier: 'hard' }, 'payload 必须原样（不变形）')
  assert.ok(req.correlation_id, '必须带 correlation_id')
  hub.broadcast('permission.response', { allowed: true, reason: 'ok' }, req.correlation_id)
  const resp = await rp
  assert.deepEqual(resp, { allowed: true, reason: 'ok' }, '响应应原样回到等待者')
})

ok('4b) permission 超时：无响应时按 timeout 兜底', async () => {
  const short = createBridge({ hub: `ws://127.0.0.1:${HUB_PORT}/ws`, role: 'x', name: 'perm-timeout', front: `http://127.0.0.1:${DSH_PORT}`, permTimeoutMs: 120 })
  // 不 start（不发真连接）：直接调内部方法也会挂等待者，但 toHub 无 host 时为 no-op → 走超时
  const rp = short._handleLocalPermission({ tool_name: 't', tool_args: '' })
  const resp = await rp
  assert.deepEqual(resp, { allowed: false, reason: 'timeout' })
})

ok('5) 交接包闸口：不合格拦截（不下发），合格下发', async () => {
  const before = dsh.state.prompts.length
  hub.broadcast('command.input', { text: '# 交接包 · 缺段\n- depth: 1\n- from: a\n- to: review-board\n## 已完成（含证据）\n', turn_id: 't-2' })
  await sleep(300)
  assert.equal(dsh.state.prompts.length, before, '不合格交接包必须被拦截')
  const rejected = hub.state.messages.filter((m) => m.type === 'event.notice' && m.payload.code === 'handoff_invalid').at(-1)
  assert.ok(rejected, '应回 event.notice handoff_invalid')
  assert.ok(Array.isArray(rejected.payload.problems) && rejected.payload.problems.length > 0)

  const valid =
    '# 交接包 · 修测试\n- depth: 1\n- from: executor-alpha@1\n- to: review-board\n' +
    '## 已完成（含证据）\n- 跑通单测 —— 证据：`node test-bridge.mjs` 全 PASS\n' +
    '## 未完成（剩余）\n- 真实冒烟 —— 原因：待 hub 起来\n' +
    '## 关键发现与坑\n- journal 的 assistant 消息 type 未实测\n' +
    '## 下一步建议\n- 起 elv/dsh-hub 走全链冒烟\n'
  hub.broadcast('command.input', { text: valid, turn_id: 't-3', handoff: true })
  await sleep(300)
  assert.equal(dsh.state.prompts.length, before + 1, '合格交接包应作为 prompt 下发')
  assert.ok(dsh.state.prompts.at(-1).content[0].text.startsWith('# 交接包'), '交接包正文原样下发')
})

ok('6) command.cancel → session.cancel', async () => {
  hub.broadcast('command.cancel', { session_id: 'hub-sess-1' })
  await sleep(300)
  assert.equal(dsh.state.cancels.length, 1)
  assert.equal(dsh.state.cancels[0].sessionId, 'sess-test')
})

ok('7) 断线重连：杀 hub → 桥指数退避重连并重新握手', async () => {
  hub.state.hellos = 0
  await hub.close() // 杀掉 mock hub（桥应收到 ws close）
  await sleep(150)
  assert.ok(!bridge._state.host, '断线后 host 应清空')
  // 在同端口起新 hub
  const hub2 = startMockHub(HUB_PORT)
  try {
    const t0 = Date.now()
    while (hub2.state.hellos < 1 && Date.now() - t0 < 8000) await sleep(50)
    assert.ok(hub2.state.hellos >= 1, '桥未在超时内重连（应指数退避后重握手）')
    const hello = hub2.state.messages.find((m) => m.type === 'session.hello')
    assert.equal(hello.payload.role, 'executor-alpha', '重连后 role 不变')
    // 重连后仍可下行
    const before = dsh.state.prompts.length
    hub2.broadcast('command.input', { text: '重连后第一条', turn_id: 't-4', session_id: 'hub-sess-1' })
    await sleep(300)
    assert.equal(dsh.state.prompts.length, before + 1, '重连后下行应恢复')
    assert.equal(dsh.state.prompts.at(-1).content[0].text, '重连后第一条')
  } finally {
    await hub2.close()
  }
})

// ── 纯函数直测 ────────────────────────────────────────────────────────
ok('8) 纯函数：findJournalFile/readJournal/translateRecord/looksLikeHandoff', () => {
  assert.equal(findJournalFile(journalRoot, sid).file, journalFile)
  assert.equal(findJournalFile(journalRoot, 'nope'), null)
  const recs = readJournal(findJournalFile(journalRoot, sid))
  assert.ok(recs.length >= 4)
  assert.equal(translateRecord(recs.find((r) => r.type === 'tool/call')).type, 'event.tool_call')
  assert.equal(translateRecord({ type: 'unknown/x' }), null)
  assert.ok(looksLikeHandoff({ text: '# 交接包 · x' }))
  assert.ok(looksLikeHandoff({ handoff: true, text: '' }))
  assert.ok(!looksLikeHandoff({ text: '普通任务' }))
})

await run()
bridge.stop()
console.log(`\n=== test-bridge：${passed}/${results.length} PASS ===`)
process.exit(passed === results.length ? 0 : 1)
