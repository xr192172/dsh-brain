/**
 * probe-delegate-once.mjs —— P1-a 验收：跑通一次真实委派
 *
 * 链路：顶层脑 → subagent 工具 → spawn provider → 子代理干活 → 结果回顶层
 * 同时观察 host 侧 subagents 注册表（subagent.list）。
 *
 * 用法： node scripts/probe-delegate-once.mjs [sessionId]
 *       不给 sessionId 就自己建一个。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

const BASE = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const OUT = 'D:/project_develop/dsh-brain/out/delegate-once.txt'
const log = []
const say = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ')
  log.push(s); console.log(s.split('\n')[0].slice(0, 160))
}
process.on('exit', () => fs.writeFileSync(OUT, log.join('\n'), 'utf8'))

async function rpc(method, payload) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload })
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const val = (r) => r.json?.result?.value
const evsOf = (h) => (val(h)?.events ?? []).map((e) => e.event ?? e)

// ── 会话 ────────────────────────────────────────────────────
let sessionId = process.argv[2]
if (!sessionId) {
  const c = await rpc('session.create', { cwd: 'D:\\project_develop\\dsh-brain' })
  sessionId = val(c)?.session?.id ?? val(c)?.id ?? val(c)?.sessionId
  say(`新建会话: ${sessionId}`)
} else {
  say(`复用会话: ${sessionId}`)
}
if (!sessionId) { say('无法获得会话，退出'); process.exit(0) }

const TASK = [
  '请用 subagent 工具把一个子任务委派出去（run_in_background: false，前台等结果）。',
  '子任务内容：读取 D:\\project_develop\\dsh-brain\\package.json，只回答其中 name 字段的值。',
  '委派回来后，用一行告诉我：子代理返回的 name 是什么。不要自己读文件，必须走委派。',
].join('\n')

say('')
say('===== 发指令 =====')
const pr = await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: TASK }],
  clientTimeZone: 'Asia/Shanghai',
})
say('prompt status ' + pr.status + ' accepted=' + (val(pr)?.accepted ?? '?'))

// ── 轮询 ────────────────────────────────────────────────────
say('')
say('===== 轮询（最多 180s）=====')
const deadline = Date.now() + 180_000
let seenTypes = new Map()
let done = false
let wroteDelegateHint = false

while (Date.now() < deadline && !done) {
  await new Promise((r) => setTimeout(r, 5000))
  const h = await rpc('session.history', { sessionId })
  const evs = evsOf(h)

  for (const e of evs) {
    seenTypes.set(e.type, (seenTypes.get(e.type) ?? 0) + 1)
    if (e.type === 'turn/end') done = true
  }

  // 工具调用事件：找 subagent
  const toolCalls = evs.filter((e) => /tool\/call|tool-call|toolCall/.test(String(e.type)))
  if (toolCalls.length && !wroteDelegateHint) {
    wroteDelegateHint = true
    say('  观察到工具调用事件 ' + toolCalls.length + ' 条：')
    for (const t of toolCalls.slice(0, 10)) {
      say('    ' + JSON.stringify(t.data).slice(0, 300))
    }
  }

  // host 侧注册表
  const sl = await rpc('subagent.list', {})
  const kids = val(sl)?.subagents ?? val(sl)?.children ?? val(sl)?.items ?? null
  const n = Array.isArray(kids) ? kids.length : 'n/a'
  say(`  [${new Date().toISOString().slice(11, 19)}] events=${evs.length} subagent.list->${sl.status} children=${n} done=${done}`)
  if (Array.isArray(kids) && kids.length) {
    say('    子代理：' + JSON.stringify(kids).slice(0, 800))
  }
}

say('')
say('===== 事件类型统计 =====')
for (const [t, n] of [...seenTypes.entries()].sort((a, b) => b[1] - a[1])) say(`  ${String(n).padStart(4)}  ${t}`)

say('')
say('===== 最终文本 =====')
const h = await rpc('session.history', { sessionId })
const evs = evsOf(h)
for (const e of evs) {
  if (e.type === 'assistant/message') {
    for (const c of e.data?.message?.content ?? []) {
      if (c?.type === 'text' && c.text?.trim()) say('--- text ---\n' + c.text.trim())
      if (c?.type === 'tool-call') say('--- tool-call: ' + (c.name ?? c.toolName) + ' args=' + JSON.stringify(c.arguments ?? c.input ?? {}).slice(0, 400))
    }
  }
}
say('')
say('sessionId = ' + sessionId)
