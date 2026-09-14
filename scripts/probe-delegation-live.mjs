/**
 * probe-delegation-live.mjs —— P0' 验收：委派工具到底有没有交到模型手里
 *
 * 做三件事，全部写进 out/delegation-live.txt：
 *   1. subagent.list  —— host 侧委派注册表是否活着（便宜、无副作用）
 *   2. session.create —— 默认 preset 建一个会话
 *   3. session.prompt —— 只问「把你能调用的工具名列出来」
 *
 * 用法： node scripts/probe-delegation-live.mjs
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

const BASE = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const OUT = 'D:/project_develop/dsh-brain/out/delegation-live.txt'
const log = []
const say = (...a) => { log.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ')); console.log(a[0]) }
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

say('===== 1. subagent.list（host 侧委派注册表）=====')
const sl = await rpc('subagent.list', {})
say('status ' + sl.status)
say(JSON.stringify(sl.json).slice(0, 2000))

say('')
say('===== 2. session.create =====')
let created = await rpc('session.create', { cwd: 'D:\\project_develop\\dsh-brain' })
say('payload {cwd} -> status ' + created.status)
say(JSON.stringify(created.json).slice(0, 1500))

let sessionId = val(created)?.session?.id ?? val(created)?.id ?? val(created)?.sessionId
if (!sessionId) {
  say('未拿到 sessionId，尝试空 payload…')
  created = await rpc('session.create', {})
  say('payload {} -> status ' + created.status)
  say(JSON.stringify(created.json).slice(0, 1500))
  sessionId = val(created)?.session?.id ?? val(created)?.id ?? val(created)?.sessionId
}
say('sessionId = ' + (sessionId ?? '(未拿到)'))
if (!sessionId) { say('中止：无法创建会话'); process.exit(0) }

say('')
say('===== 3. session.history（建会话后的 header 事件）=====')
const h0 = await rpc('session.history', { sessionId })
say('status ' + h0.status)
say(JSON.stringify(h0.json).slice(0, 2500))

say('')
say('===== 4. session.prompt：问工具清单 =====')
const pr = await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '不要调用任何工具。只回答一件事：把你当前可以调用的工具名，逐行列出（只列名字，不要解释）。' }],
  clientTimeZone: 'Asia/Shanghai'
})
say('status ' + pr.status)
say(JSON.stringify(pr.json).slice(0, 1200))

say('')
say('===== 5. 轮询 history 等回复（最多 90s）=====')
const deadline = Date.now() + 90_000
let lastLen = 0
let finalText = ''
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000))
  const h = await rpc('session.history', { sessionId })
  const s = JSON.stringify(h.json)
  if (s.length !== lastLen) {
    lastLen = s.length
    say(`  [${new Date().toISOString().slice(11, 19)}] history 长度 ${s.length}`)
  }
  const events = val(h)?.events ?? val(h)?.items ?? (Array.isArray(val(h)) ? val(h) : null)
  if (events) {
    const texts = events
      .map((e) => (typeof e?.content === 'string' ? e.content : e?.content?.map?.((c) => c?.text ?? '').join('') ?? e?.text ?? ''))
      .filter((t) => t && t.length > 0)
    finalText = texts.join('\n---\n')
  }
  if (/subagent|list_agents/i.test(finalText)) break
}
say('')
say('===== 6. 最终拼接文本（尾部 3000 字符）=====')
say(finalText.slice(-3000) || '(未取到文本)')
say('')
say('===== 7. 结论判据 =====')
const hasSub = /subagent/i.test(finalText)
const hasListAgents = /list_agents/i.test(finalText)
say(`模型自报含 subagent : ${hasSub}`)
say(`模型自报含 list_agents: ${hasListAgents}`)
say(`sessionId = ${sessionId}`)
