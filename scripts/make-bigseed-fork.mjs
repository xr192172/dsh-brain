#!/usr/bin/env node
/**
 * make-bigseed-fork.mjs —— 造一个**长上下文种子**（≥80K token）的 fork 子代，量出"复用"的真实规模（W10）。
 *
 * ## 为什么需要它
 * `scripts/make-seeded-fork.mjs`（W9）让父代只跑了一轮、只回一个字 ⇒ 种子段只有 291 token
 * ⇒ 算出"复用只占 0.7%"。但那等于把自变量调到最小端：**长程任务里父代的 50K~500K 上下文，
 * fork 出去后能不能被子代直接复用**，用 291 token 的种子是问不出来的。
 * 本脚本把种子堆到 ~90K（让父代用 `read` 完整读两个大文件），再看子代首请求的 `cr` 是否跟着涨。
 *
 * ## 与 make-seeded-fork.mjs 的关系
 * 只读它、不改它。本脚本复用它的 RPC 原语与日志归并口径，但把"父代那一轮"换成
 * **读两个大文件**（≈52,490 + 39,383 token），并新增四个量：
 *   ① 父代【委派前最后一次请求】的 in/cr/cw/总量
 *   ② 父代【委派后】增量（证明净增长只有任务+回执）
 *   ③ 子代 seedLength / 事件数
 *   ④ 子代首请求 in/cr/总量 + 种子规模（= 总量 − 脸基线 40.2K）
 *
 * ## RPC 方法名与 payload（逐字复用 `scripts/eval-run.mjs:57-67` 的传输形态）
 * POST `${FRONT}/api/<method>`，body = `{ type:'client-request', rpcId, method, payload }`，
 * 业务值在 **`json.result.value`**。
 *
 *   session.list    payload `{}` / `{ cursor? }`
 *                   → `{ result:{ value:{ items:[ { sessionId, running, updatedAt, blank,
 *                        parentSessionId?, agentPreset?, cwd?, projections:{ asOfSeq,
 *                        values:{ sessionStats{turns,steps}, tokenUsage, … } } } ] } } }`
 *   session.create  payload `{ workspaceId?, cwd?, sessionId?, agentPreset? }` → `{ sessionId, agentPreset? }`
 *   session.prompt  payload `{ sessionId, mode:'queue'|'steer', content:[{type:'text',text}] }`
 *                   → `{ accepted: true, command? }`
 *
 * 子代工具名（由 preset 决定，不是 RPC）：council preset 把 `provider: fork` 绑在 **`subagent_fork`**
 * （`~/.dsh/.agent-presets/council/agent.cordis.yml:201-205`），参数
 * `description`(string,required) / `prompt`(string,required) / `background`(bool,optional)。
 *
 * ## 读文件为什么必须分块
 * read 工具的硬上限来自 `node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js:16-18`：
 *   `READ_MAX_LINE_LENGTH = 2e3`（每行 2000 字符）、**`READ_MAX_BYTES = 50 * 1024`（单次 50KB）**，
 * 达到字节上限时尾部会打印 `(Output capped. … Use offset=N to continue.)`
 * ⇒ 150,646 字节的文件**一次读不完**，提示词里必须明确要求按 offset 续读到 EOF。
 *
 * ## 用法
 *   node scripts/make-bigseed-fork.mjs --list
 *   node scripts/make-bigseed-fork.mjs --new                       # 建 council 会话，打印 sid
 *   node scripts/make-bigseed-fork.mjs --read     <parentSid>      # 第1步：父代读两个大文件（长）
 *   node scripts/make-bigseed-fork.mjs --delegate <parentSid>      # 第2步：父代委派 fork 子代
 *   node scripts/make-bigseed-fork.mjs --verify   <childSid>       # 只读：四组数字 + 三档对照
 *
 * 副作用：`--new` / `--read` / `--delegate` 会往 DSH 写会话记录并消耗 token（读两个大文件 ≈90K）。
 * `--verify` 纯只读。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { decompress } from 'fzstd'

const REPO = 'D:/project_develop/dsh-brain'
const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const SESS_ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUTDIR = path.join(REPO, 'out')

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const has = (k) => argv.includes(k)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const pad = (s, n) => String(s ?? '').padEnd(n)

/* ── RPC 原语（与 eval-run.mjs:57-67 逐字同形）────────────────────────── */
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
async function listSessions() {
  const r = await rpc('session.list', {})
  const v = valOf(r)
  if (!v?.items) return { items: [], error: errOf(r) ?? { status: r.status } }
  return { items: v.items, error: null }
}

/* ── 会话日志读取（只读）──────────────────────────────────────────── */
function findSessionFile(sid) {
  for (const proj of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const f = path.join(SESS_ROOT, proj.name, sid, 'session.jsonl.zstd')
    if (fs.existsSync(f)) return { proj: proj.name, dir: sid, file: f }
  }
  return null
}
function readEvents(sid) {
  const loc = findSessionFile(sid)
  if (!loc) return { loc: null, evs: null }
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(loc.file))).toString('utf8') } catch (e) { return { loc, evs: null, err: e.message } }
  const evs = text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return { loc, evs }
}

/* ── usage 归并（口径同 measure-delegation-reuse.mjs：按 (turn,step)，message 覆盖 chunk）── */
function usageOf(e) {
  for (const c of [e?.data?.usage, e?.usage, e?.data?.message?.usage]) {
    if (c && typeof c === 'object' && ('inputTokens' in c || 'cacheReadTokens' in c)) return c
  }
  return null
}
/** 返回 [{ key:'turn/step', seq, u, src }]，按 seq 升序（= 真实请求顺序） */
function mergedUsages(evs) {
  const chunkMap = new Map(), msgMap = new Map()
  for (const e of evs) {
    if (e.type === 'assistant/chunk' && e.data?.chunk?.type === 'usage') {
      const k = `${e.data.turn}/${e.data.step}`
      const prev = chunkMap.get(k)
      if (!prev || num(e.seq) > num(prev.seq)) chunkMap.set(k, { seq: num(e.seq), u: e.data.chunk.usage })
    }
  }
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const u = usageOf(e)
    if (!u) continue
    const k = `${e.data?.turn}/${e.data?.step}`
    const prev = msgMap.get(k)
    if (!prev || num(e.seq) > num(prev.seq)) msgMap.set(k, { seq: num(e.seq), u })
  }
  const out = []
  for (const k of new Set([...chunkMap.keys(), ...msgMap.keys()])) {
    const m = msgMap.get(k), c = chunkMap.get(k)
    const pick = m ?? c
    out.push({ key: k, seq: pick.seq, u: pick.u, src: m ? 'message' : 'chunk' })
  }
  return out.sort((a, b) => a.seq - b.seq)
}
const buckets = (u) => ({
  in: num(u?.inputTokens), cr: num(u?.cacheReadTokens), cw: num(u?.cacheWriteTokens), out: num(u?.outputTokens),
})
const fmtB = (b) => `in=${b.in} cr=${b.cr} cw=${b.cw} out=${b.out}`
const totB = (b) => b.in + b.cr + b.cw
/** 一段事件里 user/assistant 消息面的字符数（token 估法 chars/2.87） */
const msgChars = (list) => list.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
  .reduce((a, e) => a + JSON.stringify(e.data ?? {}).length, 0)

/* ══════════════════════════════════════════════════════════════════════════
 * 模式 --new：新建 council 会话
 * ══════════════════════════════════════════════════════════════════════════ */
async function modeNew() {
  const cwd = argOf('--cwd') ?? 'D:/project_develop/dsh-brain'
  const preset = argOf('--preset') ?? 'council'
  const rc = await rpc('session.create', { cwd, agentPreset: preset })
  console.log(`[create] status=${rc.status} value=${JSON.stringify(valOf(rc))} err=${JSON.stringify(errOf(rc))}`)
  const v = valOf(rc)
  if (!v?.sessionId) { console.log('[stop] session.create 失败，原始回答:', JSON.stringify(rc).slice(0, 800)); process.exit(2) }
  console.log(`[PARENT] ${v.sessionId}  preset=${v.agentPreset ?? preset}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * 第 1 步 --read：让父代把两个大文件【完整】读进上下文
 *   目标只有一个：让父代上下文**真的**涨到 ≥80K；读不进去就再补读。
 * ══════════════════════════════════════════════════════════════════════════ */
const BIG1 = 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'   // 150646 B ≈ 52490 tok
const BIG2 = 'scripts/eval-run.mjs'                              // 113028 B ≈ 39383 tok

function readPrompt(extra = '') {
  return [
    '请用 read 工具把这【两个】文件**完整读进你的上下文**，不要总结、不要分析、不要省略：',
    '',
    `1. \`${BIG1}\`（150,646 字节）`,
    `2. \`${BIG2}\`（113,028 字节）`,
    '',
    '硬性要求（请逐条照做）：',
    '- **每个文件都必须读到文件末尾（EOF）**，不许只读开头。',
    '- read 工具单次输出有 50KB 字节上限，读满时它会在结尾打印 `(Output capped. … Use offset=N to continue.)`；',
    '  看到这行**必须**按它给的 offset 继续读，直到那个文件读完为止。',
    '- 若 read 对某个文件报错/读不动，改用 `pwsh` 分块读（例：`Get-Content -Path <f> -TotalCount 2000` 与 `-Skip 2000`），同样读到 EOF。',
    '- **用 read/pwsh 把内容读进来**；不许用 grep / 搜索 / 只看函数签名 来代替完整读取。',
    '- 两个文件的内容都要**留在对话上下文里**（不要丢弃、不要用摘要替换）。',
    '',
    '读完这两个文件之后，**只回一句**：`读完`。不要复述内容、不要写总结、不要列 toc。',
    extra,
  ].filter(Boolean).join('\n')
}

/** 等某个会话 idle 且 turns ≥ wantTurns */
async function waitIdle(sid, { wantTurns = null, maxMs = 900000, label = '' } = {}) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < maxMs) {
    const { items } = await listSessions()
    const s = items.find((x) => x.sessionId === sid)
    if (!s) { await sleep(1500); continue }
    const st = s.projections?.values?.sessionStats ?? {}
    last = { running: !!s.running, turns: st.turns ?? 0, steps: st.steps ?? 0, asOfSeq: s.projections?.asOfSeq ?? null }
    if (!last.running && (wantTurns === null || last.turns >= wantTurns)) return { ok: true, ...last, waitedMs: Date.now() - t0 }
    await sleep(3000)
  }
  return { ok: false, ...(last ?? {}), waitedMs: Date.now() - t0, timeout: true, label }
}

/** 父代日志里【最后一条】有 usage 的请求 */
function lastUsageOf(evs) {
  const m = mergedUsages(evs)
  return m.length ? m[m.length - 1] : null
}
/** 父代日志里那些带有【工具调用】的 assistant 消息（看它到底调了什么工具、参数多大） */
function toolCallsOf(evs) {
  const out = []
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const blocks = e.data?.message?.content ?? e.data?.content ?? []
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b?.type === 'tool-call' || b?.type === 'tool_use' || b?.type === 'toolCall') {
        out.push({ seq: e.seq, turn: e.data?.turn, step: e.data?.step, name: b.name ?? b.toolName ?? '?', input: b.input ?? b.args ?? null })
      }
    }
  }
  return out
}
/** 工具结果面的字符数（粗略看"内容有没有真的进上下文"） */
function toolResultChars(evs) {
  let n = 0, cnt = 0
  for (const e of evs) {
    if (!/^tool\//.test(e.type ?? '')) continue
    n += JSON.stringify(e.data ?? {}).length; cnt++
  }
  return { n, cnt }
}
/** 取某事件切片里 `read` 工具调用的参数（证明它真的分段读到了 EOF） */
function readCallsOf(evs) {
  const out = []
  for (const e of evs) {
    if (e.type !== 'tool/call') continue
    const d = e.data ?? {}
    if (d.name !== 'read') continue
    let args = d.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { /* 保留原串 */ } }
    out.push({ seq: e.seq, key: `${d.turn}/${d.step}`, callId: d.callId, args })
  }
  return out
}
/** 取 tool/result 的正文串（read 的返回），用于判断有没有 `Output capped` 残留 */
function toolResultText(e) {
  const blocks = e?.data?.message?.content ?? e?.data?.content ?? []
  if (!Array.isArray(blocks)) return ''
  return blocks.map((b) => (typeof b === 'string' ? b : JSON.stringify(b?.text ?? b ?? ''))).join('')
}
function readResultsOf(evs) {
  const out = []
  for (const e of evs) {
    if (e.type !== 'tool/result') continue
    const txt = toolResultText(e)
    const capped = /Output capped|Use offset=/.test(txt)
    const m = txt.match(/Use offset=(\d+) to continue/)
    out.push({ seq: e.seq, key: `${e.data?.turn}/${e.data?.step}`, chars: txt.length, capped, nextOffset: m ? Number(m[1]) : null })
  }
  return out
}

async function modeRead() {
  const sid = argOf('--read')
  if (!sid) { console.log('usage: --read <parentSid>'); process.exit(2) }
  const before = readEvents(sid)
  if (!before.evs) { console.log(`读不到日志 ${sid}`); process.exit(2) }
  const baseTurns = (await listSessions()).items.find((x) => x.sessionId === sid)
    ?.projections?.values?.sessionStats?.turns ?? 0
  console.log(`[use ] 父代 ${sid}  基线 turns=${baseTurns}`)

  const r = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: readPrompt() }] })
  console.log(`[prompt] status=${r.status} value=${JSON.stringify(valOf(r))} err=${JSON.stringify(errOf(r))}`)
  if (!valOf(r)?.accepted) { console.log('[stop] prompt 未被接受，原始回答:', JSON.stringify(r).slice(0, 800)); return }

  const w = await waitIdle(sid, { wantTurns: baseTurns + 1, maxMs: 1500000, label: 'read' })
  console.log(`[wait ] ${JSON.stringify(w)}`)
  if (!w.ok) console.log('[warn] 未在预算内 idle —— 下面的读数取自**当下**日志（可能仍在跑）')

  await sleep(2000)
  const { evs } = readEvents(sid)
  const m = mergedUsages(evs)
  console.log('\n═══ 父代逐条请求（(turn,step) 归并，message 覆盖 chunk）═══')
  for (const x of m) {
    const b = buckets(x.u)
    console.log(`  seq=${pad(x.seq, 5)} t/s=${pad(x.key, 8)} [${x.src}]  ${fmtB(b)}   prompt总量=${totB(b)}`)
  }
  const last = m[m.length - 1]
  if (last) {
    const b = buckets(last.u)
    console.log(`\n★ 父代【最后一次请求】seq=${last.seq} t/s=${last.key}: ${fmtB(b)}`)
    console.log(`★ 上下文规模（in + cr）= ${b.in + b.cr}    （in + cr + cw = ${totB(b)}）`)
    console.log(`★ 门：≥ 80K token ? ${(b.in + b.cr) >= 80000 ? 'PASS' : 'FAIL'}`)
  }
  const tc = toolCallsOf(evs)
  console.log(`\n父代工具调用共 ${tc.length} 次：`)
  for (const c of tc) console.log(`  seq=${pad(c.seq, 5)} t/s=${pad(c.turn + '/' + c.step, 8)} ${pad(c.name, 12)} input=${JSON.stringify(c.input ?? null).slice(0, 160)}`)
  const tr = toolResultChars(evs)
  console.log(`tool/* 事件 ${tr.cnt} 条，JSON 字符合计 ${tr.n}（≈ ${(tr.n / 2.87).toFixed(0)} token）`)
  console.log(`消息面字符数（user+assistant）= ${msgChars(evs)}（≈ ${(msgChars(evs) / 2.87).toFixed(0)} token）`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * 第 2 步 --delegate：父代在【下一轮】委派 fork 子代
 * ══════════════════════════════════════════════════════════════════════════ */
async function modeDelegate() {
  const sid = argOf('--delegate')
  if (!sid) { console.log('usage: --delegate <parentSid>'); process.exit(2) }
  const { evs: preEvs } = readEvents(sid)
  const preLast = preEvs ? lastUsageOf(preEvs) : null
  const preTotal = preLast ? totB(buckets(preLast.u)) : null
  console.log(`[pre ] 父代委派前最后一次请求: ${preLast ? `seq=${preLast.seq} t/s=${preLast.key} ` : '(读不到)'}` +
    (preLast ? `${fmtB(buckets(preLast.u))} 总量=${preTotal}` : ''))
  const beforeIds = new Set((await listSessions()).items.map((x) => x.sessionId))

  const P2 = '调用 `subagent_fork`，参数 `prompt` 写 `只回一个字：行`、`description` 写 `bigseed`；只做这一次调用，不要等结果。'
  const r = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: P2 }] })
  console.log(`[prompt] status=${r.status} value=${JSON.stringify(valOf(r))} err=${JSON.stringify(errOf(r))}`)
  if (!valOf(r)?.accepted) { console.log('[stop] prompt 未被接受，原始回答:', JSON.stringify(r).slice(0, 800)); return }

  let child = null
  const t0 = Date.now()
  while (Date.now() - t0 < 300000) {
    const { items } = await listSessions()
    const c = items.filter((x) => x.parentSessionId === sid && !beforeIds.has(x.sessionId))
    if (c.length) { child = c.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]; break }
    const c2 = items.filter((x) => x.parentSessionId === sid)
    if (c2.length) { child = c2.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]; break }
    await sleep(3000)
  }
  if (!child) { console.log('[stop] 预算内没有出现 parentSessionId = 父代 的子代会话'); return }
  console.log(`[CHILD] ${child.sessionId} preset=${child.agentPreset} running=${child.running}`)
  const w = await waitIdle(child.sessionId, { maxMs: 300000, label: 'child' })
  console.log(`[waitChild] ${JSON.stringify(w)}`)
  console.log(`\n下一步：node scripts/make-bigseed-fork.mjs --verify ${child.sessionId}`)
}

/* ══════════════════════════════════════════════════════════════════════════
 * 第 3 步 --verify：四组数字 + 三档对照（只读）
 * ══════════════════════════════════════════════════════════════════════════ */
const FACE_BASELINE_CR = 40448   // 同 preset 已知脸基线（b094f295 空种子 fork 的 cr）
const FACE_BASELINE_TOT = 41015  // 同一会话的首请求总量
const KNOWN = [
  { tag: '空种子 fork b094f295', sid: 'b094f295-6b5c-47eb-9fca-14aa75e008b0', seed: 0 },
  { tag: '空种子 fork 1df6c839', sid: '1df6c839-7b9b-42aa-bc22-81a5092d4dce', seed: 0 },
  { tag: '短种子 fork a04d96f5', sid: 'a04d96f5-122c-41b7-8666-096bac03d1a8', seed: 291 },
]

const div = (t) => { console.log('\n' + '═'.repeat(78)); console.log('═══ ' + t); console.log('═'.repeat(78)) }

function modeVerify() {
  const childSid = argOf('--verify')
  if (!childSid) { console.log('usage: --verify <childSid>'); process.exit(2) }
  const { evs: ce, loc: cloc } = readEvents(childSid)
  if (!ce) { console.log(`读不到子代日志 ${childSid}`); process.exit(2) }
  const head = ce.find((e) => e.type === 'session') ?? ce[0]
  const desc = ce.find((e) => e.type === 'subagent/descriptor')?.data ?? {}
  const hasSeedKey = Object.prototype.hasOwnProperty.call(head, 'seedLength')
  const seedLength = hasSeedKey && typeof head.seedLength === 'number' ? head.seedLength : null
  const parentSid = head.parentSession
  // 种子段 / 分身自己的切分（标记 = header.seedLength，与 measure-delegation-reuse.mjs 同口径）
  const seedEvs = seedLength === null ? [] : ce.filter((e) => typeof e.seq === 'number' && e.seq <= seedLength)
  const liveEvs = seedLength === null ? ce : ce.filter((e) => typeof e.seq === 'number' && e.seq > seedLength)

  div('【0】身份与来源')
  console.log(`  子代 sid      = ${head.id}`)
  console.log(`  子代日志      = ${cloc?.file}`)
  console.log(`  parentSession = ${parentSid}`)
  console.log(`  preset        = ${head.agentPreset}   delegationDepth=${head.delegationDepth}   createdAt=${head.createdAt}`)
  console.log(`  descriptor    = ${JSON.stringify(desc)}`)
  console.log(`  子代事件数    = ${ce.length}   maxSeq = ${ce.reduce((a, e) => (typeof e.seq === 'number' ? Math.max(a, e.seq) : a), -1)}`)

  div('【1】父代委派前的上下文规模 —— 与委派后增量')
  let pBefore = null, pAfter = null, delegationSeq = null, delegationTime = null
  let pe = null
  if (parentSid) {
    const r = readEvents(parentSid)
    pe = r.evs
    if (!pe) console.log(`  （读不到父代日志 ${parentSid}）`)
    else {
      console.log(`  父代日志 = ${r.loc?.file}`)
      const pdesc = ce.find((e) => e.type === 'subagent/descriptor')
      delegationTime = pdesc?.time ?? null
      const pturns = pe.filter((e) => e.type === 'turn/end')
      console.log(`  父代 turn/end 条数 = ${pturns.length}（seq: ${pturns.map((x) => x.seq).join(', ')}）`)
      console.log(`  子代 descriptor.time = ${delegationTime}`)
      const m = mergedUsages(pe)
      console.log('\n  父代逐条请求：')
      for (const x of m) {
        const b = buckets(x.u)
        console.log(`    seq=${pad(x.seq, 6)} t/s=${pad(x.key, 8)} [${x.src}]  ${fmtB(b)}   总量=${totB(b)}`)
      }
      const before = m.filter((x) => delegationTime === null || x.seq < (pe.find((e) => e.type === 'turn/end' &&
        e.time >= delegationTime)?.seq ?? Infinity))
      // 更稳的口径：取"descriptor 事件时间之前"的最后一条请求（按事件 time）
      const seqTime = new Map(pe.filter((e) => typeof e.seq === 'number').map((e) => [e.seq, e.time]))
      const cand = m.filter((x) => delegationTime === null || (seqTime.get(x.seq) ?? 0) < delegationTime)
      pBefore = cand.length ? cand[cand.length - 1] : (before.length ? before[before.length - 1] : null)
      pAfter = m.length ? m[m.length - 1] : null
      delegationSeq = pBefore?.seq ?? null
      if (pBefore) {
        const b = buckets(pBefore.u)
        console.log(`\n  ★【委派前最后一次请求】seq=${pBefore.seq} t/s=${pBefore.key}  ${fmtB(b)}`)
        console.log(`  ★ 父代委派前上下文规模 = in + cr = ${b.in + b.cr}   （in+cr+cw = ${totB(b)}）`)
        console.log(`  ★ 门①：≥ 80K ? ${(b.in + b.cr) >= 80000 ? 'PASS' : `FAIL（实测 ${b.in + b.cr}）`}`)
      }
      if (pAfter && pBefore) {
        const ba = buckets(pAfter.u), bb = buckets(pBefore.u)
        console.log(`\n  委派后父代最后一条请求 seq=${pAfter.seq} t/s=${pAfter.key}  ${fmtB(ba)}`)
        console.log(`  ⇒ 委派后增量（prompt 总量差）= ${totB(ba) - totB(bb)}（in 差=${ba.in - bb.in}, cr 差=${ba.cr - bb.cr}）`)
      }
      // 父代在委派那一轮里新增的消息面（任务+回执）
      const afterEvs = pe.filter((e) => typeof e.seq === 'number' && delegationSeq !== null && e.seq > delegationSeq)
      console.log(`\n  父代【委派那一轮】新增的消息面字符数 = ${msgChars(afterEvs.filter((e) => e.type === 'user/message' || e.type === 'assistant/message'))}` +
        `（≈ ${(msgChars(afterEvs.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')) / 2.87).toFixed(0)} token）`)
      console.log(`  父代【委派那一轮】新增事件总数 = ${afterEvs.length}`)
      for (const e of afterEvs.slice(0, 24)) {
        const s = JSON.stringify(e.data ?? {})
        console.log(`    seq=${pad(e.seq, 6)} ${pad(e.type, 22)} ${s.slice(0, 110)}`)
      }
      if (afterEvs.length > 24) console.log(`    … 其余 ${afterEvs.length - 24} 条略`)

      div('【1b】父代"读文件那一轮"到底读了什么（证明种子内容 = 两个文件的正文）')
      const rcalls = readCallsOf(pe)
      const rres = readResultsOf(pe)
      console.log(`  父代 read 调用 ${rcalls.length} 次：`)
      for (const c of rcalls) console.log(`    seq=${pad(c.seq, 6)} t/s=${pad(c.key, 8)} args=${JSON.stringify(c.args)}`)
      console.log(`  父代 read 返回 ${rres.length} 次（capped = 尾部带 "Output capped. … Use offset=N to continue."）：`)
      for (const r of rres) console.log(`    seq=${pad(r.seq, 6)} t/s=${pad(r.key, 8)} 正文字符=${pad(r.chars, 8)} capped=${r.capped}${r.nextOffset ? `  nextOffset=${r.nextOffset}` : ''}`)
      console.log(`  ⇒ 读了 EOF 吗：最后一个 read 返回 capped=false 才是"读到文件末尾"（同上逐条自证）`)
      const seedToolChars = seedEvs.filter((e) => /^tool\//.test(e.type ?? '')).reduce((a, e) => a + JSON.stringify(e.data ?? {}).length, 0)
      const seedTc = new Map(); for (const e of seedEvs) seedTc.set(e.type, (seedTc.get(e.type) ?? 0) + 1)
      console.log(`  ★ 子代种子段里的 tool/* 事件 JSON 字符合计 = ${seedToolChars}（${[...seedTc.entries()].filter(([k]) => /^tool\//.test(k)).map(([k, v]) => `${k}=${v}`).join(' ')}）`)
      console.log(`    ⇒ 种子段含 ${seedTc.get('tool/result') ?? 0} 条 tool/result ⇒ **文件正文真的被深拷贝进了种子**（不是空种子）`)
    }
  }

  div('【2】子代的 seedLength 与事件数')
  console.log(`  session 头原始键 = ${Object.keys(head).join(', ')}`)
  console.log(`  hasOwnProperty('seedLength') = ${hasSeedKey}   值 = ${JSON.stringify(head.seedLength)}`)
  console.log(`  ⇒ 门②(a)：seedLength 存在且 > 22 ? ${hasSeedKey && typeof head.seedLength === 'number' && head.seedLength > 22 ? 'PASS' : 'FAIL'}`)
  const endSeeds = ce.filter((e) => e.type === 'session/end-seed')
  console.log(`  session/end-seed 条数 = ${endSeeds.length}` + (endSeeds.length ? `  ${endSeeds.map((e) => `seq=${e.seq}`).join(' ')}` : ''))
  console.log(`  子代事件数 = ${ce.length}；种子段（seq <= ${seedLength}）= ${seedEvs.length} 条；分身自己 = ${liveEvs.length} 条`)
  const st = new Map(); for (const e of seedEvs) st.set(e.type, (st.get(e.type) ?? 0) + 1)
  console.log(`  种子段事件类型: ${[...st.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
  console.log(`  种子段消息面字符数 = ${msgChars(seedEvs)}（≈ ${(msgChars(seedEvs) / 2.87).toFixed(0)} token）  ← 种子规模的下界估计`)
  console.log(`  种子段里的 user/message 正文（证明它确实是父代读文件那一轮）:`)
  for (const e of seedEvs.filter((e) => e.type === 'user/message')) {
    const blocks = e.data?.message?.content ?? e.data?.content ?? []
    const txt = Array.isArray(blocks) ? blocks.map((b) => b?.text ?? `[${b?.type}]`).join('') : JSON.stringify(blocks)
    console.log(`    seq=${e.seq} text=${JSON.stringify(txt).slice(0, 150)}`)
  }
  const seedTurns = seedEvs.filter((e) => e.type === 'turn/end')
  console.log(`  种子段里的 turn/end: ${seedTurns.length ? seedTurns.map((e) => `seq=${e.seq}`).join(', ') : '【没有】'}`)
  const seedTool = toolCallsOf(seedEvs).length
  console.log(`  种子段里的 tool-call 数 = ${seedTool}`)

  div('【3】★ 子代首请求的 usage')
  const clive = mergedUsages(liveEvs)
  console.log('  分身自己（seq > seedLength）逐条请求：')
  for (const x of clive) { const b = buckets(x.u); console.log(`    seq=${pad(x.seq, 6)} t/s=${pad(x.key, 8)} [${x.src}]  ${fmtB(b)}   总量=${totB(b)}`) }
  const first = clive[0] ?? null
  if (!first) console.log('  （分身自己没有请求）')
  else {
    const b = buckets(first.u)
    console.log(`\n  ★ 子代首请求 seq=${first.seq} t/s=${first.key}:  in=${b.in}  cr=${b.cr}  cw=${b.cw}  out=${b.out}`)
    console.log(`  ★ 首请求总量（prompt 侧）= in + cr + cw = ${totB(b)}`)
    console.log(`  ★ 门②(b)：首请求总量 ≥ 100K ? ${totB(b) >= 100000 ? 'PASS' : `FAIL（实测 ${totB(b)}）`}`)
    console.log(`  首请求命中率 = cr / (in+cr+cw) = ${(b.cr / (totB(b) || 1) * 100).toFixed(2)}%`)
  }
  const hdr = liveEvs.find((e) => e.type === 'request/header')?.data?.header
  const shdr = seedEvs.find((e) => e.type === 'request/header')?.data?.header
  if (hdr) console.log(`  分身自己的 request/header: system 长度=${typeof hdr.system === 'string' ? hdr.system.length : 'n/a'}  tools=${Array.isArray(hdr.tools) ? hdr.tools.length : 'n/a'}`)
  if (shdr) console.log(`  种子段的 request/header    : system 长度=${typeof shdr.system === 'string' ? shdr.system.length : 'n/a'}  tools=${Array.isArray(shdr.tools) ? shdr.tools.length : 'n/a'}`)
  if (hdr && shdr) console.log(`  脸是否逐字相同: system=${shdr.system === hdr.system}  tools=${JSON.stringify(shdr.tools) === JSON.stringify(hdr.tools)}`)
  if (first && pBefore && pe) {
    const phdr = pe.find((e) => e.type === 'request/header')?.data?.header
    if (phdr && hdr) {
      const n = Math.min(phdr.system.length, hdr.system.length)
      let i = 0; while (i < n && phdr.system.charCodeAt(i) === hdr.system.charCodeAt(i)) i++
      console.log(`  子代 system 与父代 system 的逐字公共前缀 = ${i}/${hdr.system.length}`)
    }
  }

  div('【4】★ 种子规模与 cr 是否随种子规模一起涨')
  const total = first ? totB(buckets(first.u)) : null
  const cr = first ? buckets(first.u).cr : null
  const inTok = first ? buckets(first.u).in : null
  console.log(`  脸基线（同 preset 的已知对照，来自 b094f295 空种子 fork）: cr=${FACE_BASELINE_CR}  总量=${FACE_BASELINE_TOT}`)
  if (total !== null) {
    console.log(`  本次子代首请求: in=${inTok} cr=${cr} 总量=${total}`)
    console.log(`  ⇒ 种子规模（总量 − 脸基线总量）= ${total} − ${FACE_BASELINE_TOT} = ${total - FACE_BASELINE_TOT}`)
    console.log(`  ⇒ 种子规模（cr − 脸基线 cr）    = ${cr} − ${FACE_BASELINE_CR} = ${cr - FACE_BASELINE_CR}`)
    console.log(`  ⇒ 门③：cr ≈ 脸 + 种子（即 cr 明显 > 脸基线，且 in 相对种子仍很小）? ` +
      `${cr > FACE_BASELINE_CR + 1000 && inTok < 20000 ? 'PASS' : 'CHECK'}`)
  }
  console.log(`  旁证：种子段消息面 ≈ ${(msgChars(seedEvs) / 2.87).toFixed(0)} token（与上面两种估法可互校）`)

  div('【5】★ 三档并排对照')
  console.log(pad('档', 26) + pad('seedLen', 10) + pad('子代首请求 in', 15) + pad('cr', 12) + pad('总量', 12) + '来源')
  for (const k of KNOWN) {
    const r = readEvents(k.sid)
    if (!r.evs) { console.log(pad(k.tag, 26) + '(读不到日志)'); continue }
    const h = r.evs.find((e) => e.type === 'session') ?? r.evs[0]
    const sl = typeof h.seedLength === 'number' ? h.seedLength : null
    const lv = sl === null ? r.evs : r.evs.filter((e) => typeof e.seq === 'number' && e.seq > sl)
    const f = mergedUsages(lv)[0] ?? null
    const b = f ? buckets(f.u) : null
    console.log(pad(k.tag, 26) + pad(sl === null ? '(缺键)' : sl, 10) + pad(b ? b.in : '?', 15) + pad(b ? b.cr : '?', 12) +
      pad(b ? totB(b) : '?', 12) + `${h.id.slice(0, 12)} (种子≈${k.seed})`)
  }
  if (first) {
    const b = buckets(first.u)
    console.log(pad('★ 长种子 fork（本次）', 26) + pad(seedLength === null ? '(缺键)' : seedLength, 10) + pad(b.in, 15) + pad(b.cr, 12) + pad(totB(b), 12) + `${head.id.slice(0, 12)}`)
  }
  console.log(`\n  注：in/cr/总量 = 子代【自己段】第一条 (turn,step) 归并后的 usage；总量 = in + cr + cw。`)
}

/* ── 入口 ─────────────────────────────────────────────────────────── */
if (has('--list')) { const { items, error } = await listSessions(); console.log(error ? JSON.stringify(error) : `${items.length} 个会话`); for (const s of items.filter((x) => (x.agentPreset ?? '') === 'council').slice(0, 30)) console.log(`  ${s.sessionId}  turns=${s.projections?.values?.sessionStats?.turns ?? 0} running=${s.running} parent=${s.parentSessionId ?? '-'}`) }
else if (has('--new')) await modeNew()
else if (has('--read')) await modeRead()
else if (has('--delegate')) await modeDelegate()
else if (has('--verify')) modeVerify()
else {
  console.log('usage:')
  console.log('  node scripts/make-bigseed-fork.mjs --list')
  console.log('  node scripts/make-bigseed-fork.mjs --new')
  console.log('  node scripts/make-bigseed-fork.mjs --read <parentSid>')
  console.log('  node scripts/make-bigseed-fork.mjs --delegate <parentSid>')
  console.log('  node scripts/make-bigseed-fork.mjs --verify <childSid>')
}
