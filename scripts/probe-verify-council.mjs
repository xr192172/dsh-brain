/**
 * probe-verify-council.mjs —— 验收 P1-b（议事厅 · 架构师）
 *
 * 一次验三件事：
 *   ① preset 是否切成 code-council          → 读会话 header 的 agentPreset
 *   ② 工具 council_architect 是否交到模型   → 读 request/header
 *   ③ provider 是否真注册成功、persona 生效 → 让它真委派一次，看回答形状
 *
 * 用法： node scripts/probe-verify-council.mjs
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { decompress } from 'fzstd'

const BASE = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const OUT = 'D:/project_develop/dsh-brain/out/verify-council.txt'
const CWD = 'D:\\project_develop\\dsh-brain'
const log = []
const say = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ')
  log.push(s)
  console.log(s.split('\n')[0].slice(0, 150))
}
process.on('exit', () => fs.writeFileSync(OUT, log.join('\n'), 'utf8'))

async function rpc(method, payload) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const val = (r) => r.json?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readEvents(file) {
  try {
    const t = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
    return t.split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

// ── 0. host 活着吗 ───────────────────────────────────────────
const d = await rpc('host.describe', {})
say(`host.describe -> ${d.status}  ${JSON.stringify(val(d) ?? d.json).slice(0, 200)}`)

// ── 1. 建会话 ────────────────────────────────────────────────
const c = await rpc('session.create', { cwd: CWD })
const sessionId = val(c)?.session?.id ?? val(c)?.id ?? val(c)?.sessionId
say(`session.create -> ${c.status}  id=${sessionId}`)
if (!sessionId) { say('建会话失败，退出'); process.exit(0) }

// ── 2. 委派给架构师 ──────────────────────────────────────────
const TASK = [
  '请用 council_architect 这个工具，把下面这个设计问题委派给「议事厅 · 架构师」，前台等结果（run_in_background: false）。',
  '',
  '任务内容：判断「给 DSH 的每个子代理各自配一套独立记忆系统」这个方向该不该做，理由是什么。',
  '',
  '拿到架构师的回答后，原样转述给我（不要自己加工、不要补充你的看法）。',
].join('\n')

const pr = await rpc('session.prompt', {
  sessionId, mode: 'queue',
  content: [{ type: 'text', text: TASK }],
  clientTimeZone: 'Asia/Shanghai',
})
say(`session.prompt -> ${pr.status}  accepted=${val(pr)?.accepted}`)

// ── 3. 等回合结束（轮询会话文件，比 history RPC 可靠）──────────
const rel = `--D-project_develop-dsh-brain--/${sessionId}`
const file = `C:/Users/Admin/.dsh/sessions/${rel}/session.jsonl.zstd`
say(`会话文件: ${file}`)
say('')
say('===== 轮询 =====')

const deadline = Date.now() + 420_000
let evs = []
let endCount = 0
while (Date.now() < deadline) {
  await sleep(6000)
  if (!fs.existsSync(file)) { say('  (文件尚未落盘)'); continue }
  evs = readEvents(file)
  endCount = evs.filter((e) => e.type === 'turn/end').length
  const calls = evs.filter((e) => e.type === 'tool/call').map((e) => e.data?.name)
  say(`  [${new Date().toISOString().slice(11, 19)}] events=${evs.length} turn/end=${endCount} toolCalls=[${calls.join(',')}]`)
  if (endCount >= 1) { await sleep(3000); evs = readEvents(file); break }
}

// ── 4. 分析 ─────────────────────────────────────────────────
say('')
say('===== ① preset =====')
const first = evs[0]
say(`  header.agentPreset = ${first?.agentPreset ?? '(未取到)'}   delegationDepth=${first?.delegationDepth}`)

say('')
say('===== ② 模型看到的工具（request/header）=====')
for (const e of evs.filter((x) => x.type === 'request/header')) {
  const h = e.data?.header ?? {}
  const tools = Array.isArray(h.tools) ? h.tools : []
  const names = tools.map((t) => t?.name ?? t?.function?.name ?? '?')
  say(`  tools 字段: [${names.join(', ')}]  (${names.length} 个)`)
  say(`  system 长度: ${typeof h.system === 'string' ? h.system.length : 'n/a'}`)
  const sys = typeof h.system === 'string' ? h.system : ''
  say(`  system 含 council_architect : ${/council_architect/.test(sys)}`)
  say(`  system 含 council-architect : ${/council-architect/.test(sys)}`)
  if (/council_architect/.test(sys)) {
    const i = sys.indexOf('council_architect')
    say('  system 中该工具的定义片段:')
    say('  ' + sys.slice(Math.max(0, i - 260), i + 420).replace(/\n/g, '\n  '))
  }
}

say('')
say('===== ③ 工具调用序列 =====')
for (const e of evs.filter((x) => x.type === 'tool/call')) {
  const n = e.data?.name
  const args = String(e.data?.arguments ?? '').slice(0, 420)
  say(`  [seq ${e.seq}] ${n}`)
  say(`      ${args}`)
}
for (const e of evs.filter((x) => x.type === 'tool/result')) {
  const c0 = e.data?.message?.content?.[0]?.content?.[0]?.text ?? JSON.stringify(e.data).slice(0, 300)
  say(`  [seq ${e.seq}] result: ${String(c0).slice(0, 400)}`)
}
for (const e of evs.filter((x) => x.type === 'tool/code-dispatch-start')) {
  say(`  [seq ${e.seq}] code-dispatch-start name=${e.data?.name}`)
}

say('')
say('===== ④ 顶层最终回答 =====')
const ams = evs.filter((e) => e.type === 'assistant/message')
for (const e of ams) {
  for (const blk of e.data?.message?.content ?? []) {
    if (blk?.type === 'text' && blk.text?.trim()) { say('--- text ---'); say(blk.text.trim()) }
  }
}

say('')
say('===== ⑤ 判据汇总 =====')
const sys0 = evs.find((x) => x.type === 'request/header')?.data?.header?.system ?? ''
const allText = ams.flatMap((e) => e.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')

// ★ persona 修复判据：第一次 tool/call 应直接是 run_code（而非先直接调工具名被拒）
const firstCall = evs.find((e) => e.type === 'tool/call')?.data?.name
const rejected = evs.filter((e) =>
  e.type === 'tool/result' && /only `?run_code`? is callable/.test(JSON.stringify(e.data)))

say(`  preset = ${first?.agentPreset}`)
say(`  council_architect 出现在 system  : ${/council_architect/.test(sys0)}`)
say(`  调用了 council_architect        : ${evs.some((e) => e.type === 'tool/call' && e.data?.name === 'council_architect')}`)
say(`  走 Code Mode 派发               : ${evs.some((e) => e.type === 'tool/code-dispatch-start' && e.data?.name === 'council_architect')}`)
say(`  回答含「我可能错在哪」(persona 生效): ${/我可能错在哪/.test(allText.concat(JSON.stringify(evs)))}`)
say('  ── Code Mode 调用约定修复效果 ──')
say(`  第一次 tool/call = ${firstCall ?? '(无)'}   ⇒ 是否直接走 run_code: ${firstCall === 'run_code'}`)
say(`  直接调工具名被拒次数: ${rejected.length}   ⇒ ${rejected.length === 0 ? '✅ 修复生效' : '❌ 仍在踩坑'}`)
say(`  sessionId = ${sessionId}`)
