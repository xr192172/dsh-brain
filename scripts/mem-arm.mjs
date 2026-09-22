#!/usr/bin/env node
/**
 * mem-arm.mjs —— O80：把「记忆库」接进被测 agent 的**一条臂**，并**从会话日志取证**。
 *
 * ## 它做什么（严格按顺序）
 *   ① 渲染：调 `out/memprompt.exe render --db <store>`（Go 侧，复用 KnowledgeStore）
 *   ② 落载体：把渲染结果包进一个固定模板，写进 `<cwd>/AGENTS.md`（UTF-8 无 BOM）
 *      —— 这是 **DSH 侧既有的、活着的注入面**：`@deepseek-ai/dsh-agent-instructions`
 *         在会话第一个 `agent/pre-step` 把 cwd 链上的 AGENTS.md 作为**持久 user 角色消息**
 *         注入（`source.kind = "agent-instructions"`），**step 1 就到达第一次请求**，
 *         且**不碰 tools 段**（工具面不变）。
 *   ③ 起会话：`session.create { cwd, agentPreset: 'council' }`（★ 永远新建，不碰用户会话）
 *   ④ 发题：`session.prompt` 一条**极小任务**（不需要任何工具调用）
 *   ⑤ 等待空闲，然后**读会话日志**取证：
 *      - 独特短语是否出现（出现 ⇒ 在提示词里）；出现在哪条事件 / 什么 source / 偏移多少
 *      - `request/header` 的 system 长度与**工具名集合**（用于两臂"脸"对比）
 *   ⑥ 把原始读数写成 `out/w29-arm-<name>.json`，并打印人读版
 *
 * ## 两臂隔离
 *   · 记忆库（store）= 一个**数据目录**，真实记忆落在 `<store>/knowledge_base.json`
 *     （与 `cmd/memface` 逐字同一约定）。A/B 各给一个目录 ⇒ **互不污染**。
 *   · 注入载体（carrier）= `<cwd>/AGENTS.md`，A/B 各给一个 cwd 目录 ⇒ **互不污染**。
 *   · ★ 两个 cwd 的**路径长度刻意取相同**（mem-arm-A / mem-arm-B），
 *     免得 cwd 长度差异泄进 `system`（sandbox policy 里带 workspace 绝对路径）。
 *
 * ## 用法
 *   node scripts/mem-arm.mjs --name A --store <dir> --cwd <dir> [--expect present|absent] [--phrase <p>]
 *   例：
 *   node scripts/mem-arm.mjs --name treat --store out/mem-store-treat --cwd out/mem-arm-treat --expect present
 *   node scripts/mem-arm.mjs --name ctrl  --store out/mem-store-ctrl  --cwd out/mem-arm-ctrl  --expect absent
 *
 * ★ 本脚本只做：只读 RPC（session.create / session.prompt / session.list）+ 写两个**新建目录**。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { decompress } from 'fzstd'

const REPO = 'D:/project_develop/dsh-brain'
const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const SESS_ROOT = 'C:/Users/Admin/.dsh/sessions'
const MEMPROMPT = path.join(REPO, 'out', 'memprompt.exe')
const MAX_MS = 240000

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const has = (k) => argv.includes(k)

const NAME = argOf('--name') ?? 'arm'
const STORE = path.resolve(REPO, argOf('--store') ?? `out/mem-store-${NAME}`)
const CWD = path.resolve(REPO, argOf('--cwd') ?? `out/mem-arm-${NAME}`)
const PHRASE = argOf('--phrase') ?? 'ZXQ-MEM-PROBE-7f3a91-DO-NOT-LEAK'
const EXPECT = argOf('--expect') ?? null // present | absent | null(只报)
const TASK = argOf('--task') ?? '只回一个字：好'

/* ── 载体模板（唯一的"策略"处，集中在这里，便于审阅与替换）────────────
 * 两臂用**逐字相同**的模板，只有「记忆条目块」不同 ⇒ 差异只有自变量本身。 */
const HEADING = `# 记忆注入（由 scripts/mem-arm.mjs 从记忆库渲染，勿手改）`
const EMPTY_NOTE = '（本题的记忆库为空：没有可注入的条目）'
const PREFACE = '以下条目来自本会话绑定的记忆库。它们可能与本任务相关；相关则纳入判断，无关则忽略。'

/* ── 小工具 ─────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const sha8 = (s) => sha256(s).slice(0, 8)
const toolNameOf = (t) => t?.name ?? t?.function?.name ?? ''
const textOf = (c) => {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' ? (p.text ?? '') : String(p))).join('\n')
  if (typeof c === 'object' && typeof c.text === 'string') return c.text
  return ''
}

async function rpc(method, payload) {
  const res = await fetch(`${FRONT}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: null, text: text.slice(0, 400) } }
}
const valOf = (r) => r?.json?.result?.value
const errOf = (r) => r?.json?.result?.error ?? r?.json?.error ?? (r?.json ? null : { raw: r?.text })

function findSessionFile(sid) {
  for (const proj of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const f = path.join(SESS_ROOT, proj.name, sid, 'session.jsonl.zstd')
    if (fs.existsSync(f)) return { proj: proj.name, file: f }
  }
  return null
}
function readEvents(file) {
  const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/* ── ① 渲染 + ② 落载体 ─────────────────────────────────────── */
console.log(`===== 臂 ${NAME} =====`)
console.log(`[store ] ${STORE}`)
console.log(`[cwd   ] ${CWD}`)

if (!fs.existsSync(MEMPROMPT)) {
  console.log(`[stop] 找不到 ${MEMPROMPT}（先在 ai-base/agent-shell 跑 go build -o ${MEMPROMPT} ./cmd/memprompt）`)
  process.exit(2)
}
const rm = spawnSync(MEMPROMPT, ['render', '--db', STORE], { encoding: 'utf8' })
console.log(`[render] exit=${rm.status} stdout=${(rm.stdout ?? '').trim().slice(0, 400)}`)
console.log(`[render] stderr=${(rm.stderr ?? '').trim().slice(0, 300)}`)
if (rm.status !== 0) { console.log('[stop] memprompt render 失败'); process.exit(2) }
const rendered = JSON.parse((rm.stdout ?? '').trim())
console.log(`[render] count=${rendered.count} items=${rendered.items} bytes=${rendered.bytes}`)

const memBlock = rendered.items > 0 ? rendered.text : EMPTY_NOTE
const carrier = `${HEADING}\n\n${PREFACE}\n\n${memBlock}\n`
fs.mkdirSync(CWD, { recursive: true })
const carrierPath = path.join(CWD, 'AGENTS.md')
fs.writeFileSync(carrierPath, carrier, 'utf8')
const carrierRaw = fs.readFileSync(carrierPath)
console.log(`[carrier] ${carrierPath} bytes=${carrierRaw.length} sha256=${sha256(carrierRaw.toString('utf8')).slice(0, 16)}`)
console.log(`[carrier] BOM=${carrierRaw[0] === 0xef && carrierRaw[1] === 0xbb && carrierRaw[2] === 0xbf}`)
console.log(`[carrier] 含短语=${carrier.includes(PHRASE)}`)

/* ── ③ 建会话（永远新建）───────────────────────────────────── */
const winCwd = CWD.replace(/\//g, '\\')
const c = await rpc('session.create', { cwd: winCwd, agentPreset: 'council' })
console.log(`[create] status=${c.status} value=${JSON.stringify(valOf(c))} err=${JSON.stringify(errOf(c))}`)
const sid = valOf(c)?.sessionId
if (!sid) { console.log('[stop] 没拿到 sessionId'); process.exit(2) }
console.log(`[create] 新会话 ${sid} preset=${valOf(c)?.agentPreset}`)

// 等它出现在列表里且空闲
const tCreate = Date.now()
while (Date.now() - tCreate < 60000) {
  const lr = await rpc('session.list', {})
  const s = valOf(lr)?.items?.find((x) => x.sessionId === sid)
  if (s && !s.running) break
  await sleep(1000)
}
await sleep(1000)

/* ── ④ 发极小任务 ─────────────────────────────────────────── */
const baselineTurns = (await rpc('session.list', {})).json?.result?.value?.items?.find((x) => x.sessionId === sid)
  ?.projections?.values?.sessionStats?.turns ?? 0
const r = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: TASK }] })
console.log(`[prompt] status=${r.status} accepted=${valOf(r)?.accepted} err=${JSON.stringify(errOf(r))}`)

/* ── ⑤ 等空闲 ─────────────────────────────────────────────── */
const t0 = Date.now()
let last = null
while (Date.now() - t0 < MAX_MS) {
  const lr = await rpc('session.list', {})
  const s = valOf(lr)?.items?.find((x) => x.sessionId === sid)
  if (s) {
    const st = s.projections?.values?.sessionStats ?? {}
    last = { running: !!s.running, turns: st.turns ?? 0, steps: st.steps ?? 0 }
    if (!last.running && last.turns >= baselineTurns + 1) break
  }
  await sleep(2000)
}
console.log(`[wait] ${JSON.stringify({ ...last, waitedMs: Date.now() - t0 })}`)
await sleep(2000)

/* ── ⑥ 取证（从会话语义日志读，不靠"我以为"）───────────────── */
const loc = findSessionFile(sid)
if (!loc) { console.log('[stop] 找不到会话日志'); process.exit(2) }
console.log(`[日志] ${loc.file}`)
const evs = readEvents(loc.file)

const hdrs = evs.filter((e) => e.type === 'request/header')
const firstHdr = hdrs[0]?.data?.header ?? null
const names = Array.isArray(firstHdr?.tools) ? [...new Set(firstHdr.tools.map(toolNameOf))].sort() : []
const namesHash = names.length ? sha8(names.join('\n')) : '-'
console.log(`[header] 请求数=${hdrs.length} system长度=${typeof firstHdr?.system === 'string' ? firstHdr.system.length : 'n/a'} 工具数=${names.length} namesHash=${namesHash}`)

const hits = []
for (const e of evs) {
  const s = JSON.stringify(e)
  if (!s.includes(PHRASE)) continue
  const d = e.data ?? {}
  const t = textOf(d.content ?? d.message?.content ?? d.message ?? d)
  const i = t.indexOf(PHRASE)
  hits.push({
    seq: e.seq,
    type: e.type,
    source: d.source ?? d.message?.source ?? null,
    offset: i,
    context: i >= 0 ? t.slice(Math.max(0, i - 200), i + PHRASE.length + 120) : '(该事件无直读文本，仅 JSON 内命中)',
    textLen: t.length,
  })
}
console.log(`\n── 短语「${PHRASE}」命中 ${hits.length} 处 ──`)
for (const h of hits) {
  console.log(`  seq=${h.seq} type=${h.type} offset=${h.offset}`)
  console.log(`    source=${JSON.stringify(h.source)}`)
  console.log(`    上下文: ${JSON.stringify(h.context.slice(0, 420))}`)
}

// 记忆载体那条注入消息的完整形状（便于报告引用）
const instrMsg = evs.find((e) => e.type === 'user/message' && (e.data?.source?.kind === 'agent-instructions'))
if (instrMsg) {
  const d = instrMsg.data ?? {}
  const t = textOf(d.content ?? d.message?.content ?? d)
  console.log(`\n── agent-instructions 注入消息 ──`)
  console.log(`  seq=${instrMsg.seq} 文本长度=${t.length}`)
  console.log(`  source=${JSON.stringify(d.source ?? d.message?.source ?? null).slice(0, 700)}`)
  console.log(`  正文（前 500 字）: ${JSON.stringify(t.slice(0, 500))}`)
} else {
  console.log('\n⚠ 没有找到 source.kind=agent-instructions 的 user/message')
}

// 助手最终回复（用于"模型真的读到了吗"的行为面证据）
const assistantTexts = []
for (const e of evs) {
  if (e.type !== 'assistant/message') continue
  const d = e.data ?? {}
  const t = textOf(d.content ?? d.message?.content ?? d.message ?? d)
  if (t.trim()) assistantTexts.push({ seq: e.seq, turn: d.turn, step: d.step, text: t })
}
console.log(`\n── 助手回复（${assistantTexts.length} 条）──`)
for (const a of assistantTexts) {
  console.log(`  seq=${a.seq} t/s=${a.turn}/${a.step} 含短语=${a.text.includes(PHRASE)}`)
  console.log(`    正文: ${JSON.stringify(a.text.slice(0, 400))}`)
}
const replyHasPhrase = assistantTexts.some((a) => a.text.includes(PHRASE))

const verdict = hits.length > 0 ? 'present' : 'absent'
const pass = EXPECT ? verdict === EXPECT : null

const evidence = {
  arm: NAME,
  at: new Date().toISOString(),
  store: STORE,
  storeCount: rendered.count,
  storeItems: rendered.items,
  carrier: carrierPath,
  carrierBytes: carrierRaw.length,
  carrierSha256: sha256(carrierRaw.toString('utf8')),
  carrierHasPhrase: carrier.includes(PHRASE),
  sessionId: sid,
  preset: valOf(c)?.agentPreset ?? null,
  task: TASK,
  requestHeader: {
    count: hdrs.length,
    systemLen: typeof firstHdr?.system === 'string' ? firstHdr.system.length : null,
    toolCount: names.length,
    namesHash,
    toolNames: names,
  },
  phrase: PHRASE,
  phraseHits: hits,
  assistantTexts,
  replyHasPhrase,
  agentInstructionsMessage: instrMsg
    ? { seq: instrMsg.seq, source: instrMsg.data?.source ?? null, textLen: textOf(instrMsg.data?.content ?? instrMsg.data?.message?.content ?? instrMsg.data).length }
    : null,
  verdict,
  expect: EXPECT,
  pass,
}
const outFile = path.join(REPO, 'out', `w29-arm-${NAME}.json`)
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log(`\n=== 判定：短语 ${verdict}（期望 ${EXPECT ?? '(未指定)'}）⇒ ${pass === null ? 'N/A' : pass ? 'PASS' : 'FAIL'} ===`)
console.log(`SID=${sid}`)
console.log(`evidence=${outFile}`)
