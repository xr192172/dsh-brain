#!/usr/bin/env node
/**
 * make-seeded-fork.mjs —— 造一个**真正带非空种子的 fork 子代**（O21），并读出它的种子账。
 *
 * ## 为什么需要它
 * 规格 `docs/skill-as-agent-spec.md` §10.3 实测：手上 4/4 个 `provider=fork` 子代**种子全为空**，
 * 机制是 `completedTurnPrefix` 只取「最后一条 `turn/end`」之前的事件，
 * 而我们历来的测试习惯是「在新会话里**立刻**委派」⇒ 父代一条 `turn/end` 都没有 ⇒ 返回 `[]` ⇒ 空种子
 * （`dsh-subagent-fork-in-process/lib/index.js:23-28,47`）。
 * ⇒ 本脚本按相反的顺序做：**同一会话里先让父代跑完整整一轮（落一条 `turn/end`），再委派 fork**。
 *
 * ## RPC 方法名与 payload（可复用资产）
 * 从 DSH 源码的 RPC 注册表读出（克隆 `packages/host/apiproxy/src/api/rpc-map.ts`；
 * 已装产物 `node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api/rpc-map.js` 是空壳，只有 .d.ts 注释）。
 * 传输形态与 `scripts/eval-run.mjs:57-67` 的 `rpc()` 逐字相同：POST `${FRONT}/api/<method>`，
 * body = `{ type:'client-request', rpcId, method, payload }`，回答在 `json.result.value`。
 *
 *   session.list    payload `{}` / `{ cursor? }`
 *                   → `{ result:{ value:{ items:[ { sessionId, running, updatedAt, blank,
 *                        parentSessionId?, agentPreset?, cwd?, projections:{ asOfSeq,
 *                        values:{ sessionStats{turns,steps}, tokenUsage, … } } } ] } } }`
 *                   （源码签名：`sessions.ts:234`）
 *
 *   session.create  payload `{ workspaceId?, cwd?, sessionId?, agentPreset? }`
 *                   → `{ sessionId, agentPreset? }`        （源码签名：`sessions.ts:261`）
 *                   ★ 只给 `at most one of workspaceId / cwd`；`agentPreset` 省略则用默认。
 *
 *   session.prompt  payload `{ sessionId, mode:'queue'|'steer', content: PromptContentPart[], clientTimeZone? }`
 *                   `PromptContentPart = {type:'text',text} | {type:'image',mediaType,data,name?}`
 *                   → `{ accepted: true, command? }`       （源码签名：`sessions.ts:347-353`）
 *                   ★ 这是**发消息**的方法；`mode:'queue'` = 普通发送（`steer` = 插队）。
 *                   ★ content 恰为一个以 '/' 开头的 text 块 ⇒ 被当 slash command，**不会发给模型**。
 *
 *   session.fork    payload `{ sessionId, atSeq? }` → `{ sessionId }`（会话级 fork，本脚本不用）
 *
 *   子代工具名（由 preset 决定，不是 RPC）：council preset 里 fork 绑的是 `subagent_fork`
 *   （`~/.dsh/.agent-presets/council/agent.cordis.yml:201-205`，`provider: fork`），
 *   参数 `description`(string,required) / `prompt`(string,required) / `background`(bool,optional)。
 *
 * ## 用法
 *   node scripts/make-seeded-fork.mjs --list                  # 列会话（含 preset / cwd / turns / running）
 *   node scripts/make-seeded-fork.mjs --run                   # 自动挑一个 council 会话跑实验
 *   node scripts/make-seeded-fork.mjs --run --session <sid>   # 指定会话
 *   node scripts/make-seeded-fork.mjs --inspect <sid> [--parent <sid>]   # 只读：把三条硬判据的证据打出来
 *
 * 本脚本只做只读 RPC 与 `session.prompt`（会往指定会话写记录、消耗 token）。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 会话日志读取（只读）──────────────────────────────────────────── */
function findSessionFile(sid) {
  for (const proj of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const d = path.join(SESS_ROOT, proj.name, sid)
    const f = path.join(d, 'session.jsonl.zstd')
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

/* ── 模式 1：列会话 ───────────────────────────────────────────────── */
async function modeList() {
  const { items, error } = await listSessions()
  if (error) { console.log('session.list 原始回答:', JSON.stringify(error).slice(0, 800)); return }
  console.log(`session.list ok —— ${items.length} 个会话`)
  const rows = items.map((s) => ({
    sid: s.sessionId,
    preset: s.agentPreset ?? '(无)',
    cwd: s.cwd ?? '(无)',
    running: s.running,
    parent: s.parentSessionId ?? '-',
    blank: s.blank,
    turns: s.projections?.values?.sessionStats?.turns ?? 0,
    steps: s.projections?.values?.sessionStats?.steps ?? 0,
    upd: s.updatedAt,
  }))
  rows.sort((a, b) => (b.upd ?? 0) - (a.upd ?? 0))
  for (const r of rows.slice(0, 40)) {
    console.log(`  ${r.sid.slice(0, 12)}  preset=${String(r.preset).padEnd(10)} turns=${String(r.turns).padEnd(3)} ` +
      `steps=${String(r.steps).padEnd(3)} running=${String(r.running).padEnd(5)} parent=${String(r.parent).slice(0, 12).padEnd(13)} cwd=${r.cwd}`)
  }
  console.log('\n--preset=council 的会话--')
  for (const r of rows.filter((x) => x.preset === 'council')) {
    console.log(`  ${r.sid}  turns=${r.turns} steps=${r.steps} running=${r.running} cwd=${r.cwd}`)
  }
}

/* ── 模式 2：跑实验 ───────────────────────────────────────────────── */
async function waitIdle(sid, { wantTurns = null, maxMs = 180000, label = '' } = {}) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < maxMs) {
    const { items } = await listSessions()
    const s = items.find((x) => x.sessionId === sid)
    if (!s) { await sleep(1500); continue }
    const st = s.projections?.values?.sessionStats ?? {}
    last = { running: !!s.running, turns: st.turns ?? 0, steps: st.steps ?? 0, asOfSeq: s.projections?.asOfSeq ?? null }
    const turnsOK = wantTurns === null || last.turns >= wantTurns
    if (!last.running && turnsOK) return { ok: true, ...last, waitedMs: Date.now() - t0 }
    await sleep(2000)
  }
  return { ok: false, ...(last ?? {}), waitedMs: Date.now() - t0, timeout: true, label }
}

async function modeRun() {
  let sid = argOf('--session')
  let preset = null
  if (has('--new')) {
    const cwd = argOf('--cwd') ?? 'D:/project_develop/dsh-brain'
    const rc = await rpc('session.create', { cwd, agentPreset: 'council' })
    const v = valOf(rc)
    console.log(`[create] status=${rc.status} value=${JSON.stringify(v)} err=${JSON.stringify(errOf(rc))}`)
    if (!v?.sessionId) { console.log('[stop] session.create 失败，原始回答:', JSON.stringify(rc).slice(0, 800)); return }
    sid = v.sessionId
    preset = v.agentPreset ?? 'council'
    console.log(`[new  ] 新建会话 ${sid} (preset=${preset})`)
    await sleep(3000)
  } else if (!sid) {
    const { items, error } = await listSessions()
    if (error) { console.log('session.list 失败:', JSON.stringify(error)); process.exit(2) }
    const cand = items.filter((s) => (s.agentPreset ?? '') === 'council' && !s.running)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    if (!cand.length) { console.log('没有 idle 的 council 会话；用 --session 指定，或先建一个。'); process.exit(2) }
    sid = cand[0].sessionId
    preset = cand[0].agentPreset
    console.log(`[pick] 选中最新的 idle council 会话 ${sid} (preset=${preset})`)
  } else {
    const { items } = await listSessions()
    preset = items.find((x) => x.sessionId === sid)?.agentPreset ?? '(未知)'
    console.log(`[use ] 指定会话 ${sid} (preset=${preset})`)
    if (preset !== 'council') console.log(`[warn] preset 不是 council（=${preset}）⇒ 工具名可能不叫 subagent_fork`)
  }

  const baseTurns = (await listSessions()).items.find((x) => x.sessionId === sid)
    ?.projections?.values?.sessionStats?.turns ?? 0
  console.log(`[base] 委派前 turns=${baseTurns}`)

  // ── 第一条：让父代完成一整轮（必须等它落一条 turn/end）──
  const P1 = '只回一个字：好'
  const r1 = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: P1 }] })
  console.log(`[prompt1] status=${r1.status} value=${JSON.stringify(valOf(r1))} err=${JSON.stringify(errOf(r1))}`)
  if (!valOf(r1)?.accepted) { console.log('[stop] prompt1 未被接受，原始回答:', JSON.stringify(r1).slice(0, 800)); return }
  const w1 = await waitIdle(sid, { wantTurns: baseTurns + 1, maxMs: 180000, label: 'p1' })
  console.log(`[wait1] ${JSON.stringify(w1)}`)
  if (!w1.ok) { console.log('[stop] 第一轮未在预算内完成'); return }

  // ── 第二条：让父代在【已完成回合之后】委派一个 fork 子代 ──
  const P2 = '调用 `subagent_fork`，参数 `prompt` 写 `只回一个字：行`、`description` 写 `seedtest`；只做这一次调用，不要等结果。'
  const r2 = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: P2 }] })
  console.log(`[prompt2] status=${r2.status} value=${JSON.stringify(valOf(r2))} err=${JSON.stringify(errOf(r2))}`)
  if (!valOf(r2)?.accepted) { console.log('[stop] prompt2 未被接受，原始回答:', JSON.stringify(r2).slice(0, 800)); return }

  // ── 等子代出现 ──
  let child = null
  const t0 = Date.now()
  while (Date.now() - t0 < 240000) {
    const { items } = await listSessions()
    child = items.find((x) => x.parentSessionId === sid)
    if (child) break
    await sleep(3000)
  }
  if (!child) { console.log('[stop] 预算内没有出现 parentSessionId = 父代 的子代会话'); return }
  console.log(`[child] ${child.sessionId} preset=${child.agentPreset} running=${child.running}`)
  const w2 = await waitIdle(child.sessionId, { maxMs: 180000, label: 'child' })
  console.log(`[waitChild] ${JSON.stringify(w2)}`)

  console.log(`\n[PARENT] ${sid}`)
  console.log(`[CHILD ] ${child.sessionId}`)
  console.log('\n下一步：node scripts/make-seeded-fork.mjs --inspect ' + child.sessionId + ' --parent ' + sid)
}

/* ── 模式 3：只读取证（三条硬判据 + 数量）──────────────────────────── */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
function usageOf(e) {
  for (const c of [e?.data?.usage, e?.usage, e?.data?.message?.usage]) {
    if (c && typeof c === 'object' && ('inputTokens' in c || 'cacheReadTokens' in c)) return c
  }
  return null
}
/** 与 measure-delegation-reuse.mjs 相同的归并：按 (turn,step) 归并 chunk 与 message，message 覆盖 chunk */
function mergedUsages(evs) {
  const chunkMap = new Map(), msgMap = new Map()
  for (const e of evs) {
    if (e.type === 'assistant/chunk' && e.data?.chunk?.type === 'usage') {
      chunkMap.set(`${e.data.turn}/${e.data.step}`, e.data.chunk.usage)
    }
  }
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const u = usageOf(e)
    if (u) msgMap.set(`${e.data?.turn}/${e.data?.step}`, u)
  }
  const out = []
  for (const k of new Set([...chunkMap.keys(), ...msgMap.keys()])) {
    const u = msgMap.get(k) ?? chunkMap.get(k)
    out.push({ key: k, u, src: msgMap.has(k) ? 'message' : 'chunk' })
  }
  return out
}
const sumU = (list) => list.reduce((a, x) => ({
  inputTokens: a.inputTokens + num(x.u.inputTokens),
  cacheReadTokens: a.cacheReadTokens + num(x.u.cacheReadTokens),
  cacheWriteTokens: a.cacheWriteTokens + num(x.u.cacheWriteTokens),
  outputTokens: a.outputTokens + num(x.u.outputTokens),
}), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
const fmtU = (u) => `in=${u.inputTokens} cr=${u.cacheReadTokens} cw=${u.cacheWriteTokens} out=${u.outputTokens}`

function modeInspect() {
  const child = argOf('--inspect')
  const parent = argOf('--parent')
  const { loc: cloc, evs: ce } = readEvents(child)
  if (!ce) { console.log(`读不到子代会话日志: ${child} (loc=${JSON.stringify(cloc)})`); process.exit(2) }
  console.log(`[文件] 子代日志 = ${cloc?.file}`)
  const head = ce.find((e) => e.type === 'session') ?? ce[0]
  const desc = ce.find((e) => e.type === 'subagent/descriptor')
  const endSeeds = ce.filter((e) => e.type === 'session/end-seed')
  const maxSeq = ce.reduce((a, e) => (typeof e.seq === 'number' ? Math.max(a, e.seq) : a), -1)

  console.log('\n═══ 判据 1：子代 header 里有 seedLength 键且 > 0 ═══')
  const hasKey = Object.prototype.hasOwnProperty.call(head, 'seedLength')
  console.log(`  session 头原始键: ${Object.keys(head).join(', ')}`)
  console.log(`  hasOwnProperty('seedLength') = ${hasKey}   值 = ${JSON.stringify(head.seedLength)}`)
  console.log(`  → 判据1 = ${hasKey && typeof head.seedLength === 'number' && head.seedLength > 0 ? 'PASS' : 'FAIL'}`)

  console.log('\n═══ 判据 2：子代日志里有 session/end-seed ═══')
  console.log(`  session/end-seed 条数 = ${endSeeds.length}`)
  for (const e of endSeeds) console.log(`    seq=${e.seq} time=${e.time} data=${JSON.stringify(e.data)}`)
  console.log(`  → 判据2 = ${endSeeds.length > 0 ? 'PASS' : 'FAIL'}`)

  console.log('\n═══ 判据 3：父代在委派【之前】已有 turn/end ═══')
  if (!parent) {
    console.log('  （未给 --parent，无法核对；请加 --parent <sid>）')
  } else {
    const { evs: pe, loc: ploc } = readEvents(parent)
    if (!pe) console.log(`  （读不到父代日志 ${parent}）`)
    else {
      console.log(`  [文件] 父代日志 = ${ploc?.file}`)
      const pturns = pe.filter((e) => e.type === 'turn/end')
      const dTime = desc?.time ?? null
      console.log(`  父代 turn/end 条数 = ${pturns.length}`)
      for (const e of pturns) console.log(`    seq=${e.seq} time=${e.time}`)
      console.log(`  子代 subagent/descriptor: time=${dTime} (子代内 seq=${desc?.seq ?? 'N/A'}) data=${JSON.stringify(desc?.data)}`)
      const before = pturns.filter((e) => dTime !== null && e.time < dTime)
      const lastBefore = before[before.length - 1] ?? null
      console.log(`  ⇒ 【委派前】父代已完成 turn/end 条数 = ${before.length}` +
        (lastBefore ? `，最后一条 seq=${lastBefore.seq} time=${lastBefore.time}` : ''))
      console.log(`  (a) 口径「委派前最后一条 turn/end 的 time < descriptor.time」 = ` +
        `${lastBefore ? (lastBefore.time < dTime ? 'PASS' : 'FAIL') : 'FAIL(无)'}  (${lastBefore?.time} < ${dTime})`)
      const lastAll = pturns[pturns.length - 1] ?? null
      console.log(`  (b) 口径「全日志最后一条 turn/end 的 time < descriptor.time」 = ` +
        `${lastAll ? (lastAll.time < dTime ? 'PASS' : 'FAIL') : 'FAIL(无)'}  (${lastAll?.time} < ${dTime})` +
        `  ← 父代在委派【之后】还继续跑了回合，故 (b) 必然为 FAIL`)
      const pd = pe.filter((e) => e.type === 'subagent/descriptor')
      console.log(`  旁证：父代日志里的 subagent/descriptor 条数 = ${pd.length}`)
      const ptc = new Map()
      for (const e of pe) ptc.set(e.type, (ptc.get(e.type) ?? 0) + 1)
      console.log(`  父代事件类型分布: ${[...ptc.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
      // 父代每步 usage（看它自己有没有吃到缓存）
      const pu = mergedUsages(pe)
      for (const x of pu) console.log(`  父代 step t/s=${x.key} [${x.src}] ${fmtU({ inputTokens: num(x.u.inputTokens), cacheReadTokens: num(x.u.cacheReadTokens), cacheWriteTokens: num(x.u.cacheWriteTokens), outputTokens: num(x.u.outputTokens) })}`)
    }
  }

  console.log('\n═══ 形状量（与空种子 fork 对照用）═══')
  console.log(`  子代事件数 = ${ce.length}   maxSeq = ${maxSeq}`)
  console.log(`  子代 seq 0 事件类型 = ${ce[0]?.type}   最后一条类型 = ${ce[ce.length - 1]?.type}`)
  const evTypes = new Map()
  for (const e of ce) evTypes.set(e.type, (evTypes.get(e.type) ?? 0) + 1)
  console.log(`  事件类型分布: ${[...evTypes.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)

  const seedLen = hasKey && typeof head.seedLength === 'number' ? head.seedLength : null
  const seedEvs = seedLen === null ? [] : ce.filter((e) => typeof e.seq === 'number' && e.seq <= seedLen)
  const liveEvs = seedLen === null ? ce : ce.filter((e) => typeof e.seq === 'number' && e.seq > seedLen)

  console.log('\n--- 种子段（seq <= seedLength）的实证 ---')
  if (seedLen === null) console.log('  （无 seedLength ⇒ 无种子段）')
  else {
    console.log(`  种子段事件数 = ${seedEvs.length}`)
    const st = new Map()
    for (const e of seedEvs) st.set(e.type, (st.get(e.type) ?? 0) + 1)
    console.log(`  种子段事件类型: ${[...st.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
    console.log('  种子段里的 user/message 正文（证明它确实是父代那一轮）:')
    for (const e of seedEvs) {
      if (e.type !== 'user/message') continue
      const blocks = e.data?.message?.content ?? e.data?.content ?? []
      const txt = Array.isArray(blocks) ? blocks.map((b) => b?.text ?? `[${b?.type}]`).join('') : JSON.stringify(blocks)
      console.log(`    seq=${e.seq} source=${JSON.stringify(e.data?.source?.kind ?? e.data?.source ?? null)} text=${JSON.stringify(txt).slice(0, 160)}`)
    }
    const se = seedEvs.find((e) => e.type === 'turn/end')
    console.log(`  种子段里的 turn/end: ${se ? `seq=${se.seq} time=${se.time}` : '【没有】'}`)
    const sh = seedEvs.find((e) => e.type === 'request/header')?.data?.header
    console.log(`  种子段里的 request/header: system 长度=${typeof sh?.system === 'string' ? sh.system.length : 'n/a'}  tools=${Array.isArray(sh?.tools) ? sh.tools.length : 'n/a'}`)
  }

  console.log('\n--- ★ usage 拆账（口径同 measure-delegation-reuse.mjs：按 (turn,step) 归并，message 覆盖 chunk）---')
  const seedU = mergedUsages(seedEvs)
  const liveU = mergedUsages(liveEvs)
  console.log('  种子段（= 父代已付过账的深拷贝，**不是新增开销**）:')
  for (const x of seedU) console.log(`    t/s=${x.key} [${x.src}] ${fmtU({ inputTokens: num(x.u.inputTokens), cacheReadTokens: num(x.u.cacheReadTokens), cacheWriteTokens: num(x.u.cacheWriteTokens), outputTokens: num(x.u.outputTokens) })}`)
  console.log(`    小计 ${fmtU(sumU(seedU))}`)
  console.log('  分身自己（= 新增开销）:')
  for (const x of liveU) console.log(`    t/s=${x.key} [${x.src}] ${fmtU({ inputTokens: num(x.u.inputTokens), cacheReadTokens: num(x.u.cacheReadTokens), cacheWriteTokens: num(x.u.cacheWriteTokens), outputTokens: num(x.u.outputTokens) })}`)
  console.log(`    小计 ${fmtU(sumU(liveU))}`)
  const ownFirst = liveU[0] ?? null
  console.log(`  ★ 首请求（分身自己的第一个请求）: ${ownFirst ? fmtU({ inputTokens: num(ownFirst.u.inputTokens), cacheReadTokens: num(ownFirst.u.cacheReadTokens), cacheWriteTokens: num(ownFirst.u.cacheWriteTokens), outputTokens: num(ownFirst.u.outputTokens) }) : 'n/a'}`)
  const hdr = liveEvs.find((e) => e.type === 'request/header')?.data?.header
  console.log(`  分身自己那次的 request/header: system 长度=${typeof hdr?.system === 'string' ? hdr.system.length : 'n/a'}  tools=${Array.isArray(hdr?.tools) ? hdr.tools.length : 'n/a'}`)

  // 两段的消息面字符数（用于判断"474 未缓存"是不是种子段）
  const msgChars = (list) => list.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
    .reduce((a, e) => a + JSON.stringify(e.data ?? {}).length, 0)
  console.log(`  消息面字符数: 种子段=${msgChars(seedEvs)}  分身自己=${msgChars(liveEvs)}  ` +
    `(≈ chars/2.87 = ${(msgChars(seedEvs) / 2.87).toFixed(0)} / ${(msgChars(liveEvs) / 2.87).toFixed(0)} token)`)
  for (const [tag, list] of [['种子段', seedEvs], ['自己', liveEvs]]) {
    const rc = list.filter((e) => e.type === 'request/context')
    console.log(`  request/context（${tag}）条数=${rc.length}` + (rc.length ? ` dataKeys=${JSON.stringify(Object.keys(rc[0].data ?? {}))}` : ''))
  }
  // 子代自己的 request/header 与种子段 request/header 是否逐字相同（脸不变 ⇒ 前缀可复用）
  const h1 = seedEvs.find((e) => e.type === 'request/header')?.data?.header
  const h2 = liveEvs.find((e) => e.type === 'request/header')?.data?.header
  if (h1 && h2) {
    console.log(`  脸比较: system 逐字相同=${h1.system === h2.system}  tools 逐字相同=${JSON.stringify(h1.tools) === JSON.stringify(h2.tools)}  ` +
      `tools 数=${Array.isArray(h1.tools) ? h1.tools.length : '?'}/${Array.isArray(h2.tools) ? h2.tools.length : '?'}`)
  }
}

/* ── 模式 4：并排对照（本次带种子 fork vs 4 个空种子 fork）───────────── */
const pad = (s, n) => String(s ?? '').padEnd(n)
function modeCompare() {
  const ids = argv.slice(argv.indexOf('--compare') + 1).filter((x) => !x.startsWith('--'))
  if (!ids.length) { console.log('usage: --compare <sid>...'); return }
  console.log(pad('session', 14) + pad('prov', 7) + pad('mode', 12) + pad('seedLen', 9) + pad('endSeed', 8) +
    pad('evts', 6) + pad('自己in', 8) + pad('自己cr', 8) + pad('自己总', 8) +
    pad('sysLCP', 8) + pad('父末in', 8) + pad('父末cr', 8) + pad('父末总', 8) + '父')
  for (const sid of ids) {
    const { evs } = readEvents(sid)
    if (!evs) { console.log(pad(sid.slice(0, 12), 14) + '(读不到日志)'); continue }
    const head = evs.find((e) => e.type === 'session') ?? evs[0]
    const desc = evs.find((e) => e.type === 'subagent/descriptor')?.data ?? {}
    const hasKey = Object.prototype.hasOwnProperty.call(head, 'seedLength')
    const seedLen = hasKey && typeof head.seedLength === 'number' ? head.seedLength : null
    const liveEvs = seedLen === null ? evs : evs.filter((e) => typeof e.seq === 'number' && e.seq > seedLen)
    const lU = mergedUsages(liveEvs)
    const l = sumU(lU)
    const lf = lU[0] ?? null
    const ownSys = liveEvs.find((e) => e.type === 'request/header')?.data?.header?.system
    let pIn = '-', pCr = '-', pTot = '-', pLabel = '-', lcp = '-'
    const pid = head.parentSession
    if (pid) {
      const { evs: pe } = readEvents(pid)
      if (pe) {
        const pU = mergedUsages(pe)
        const pl = pU[pU.length - 1] ?? null
        if (pl) {
          pIn = num(pl.u.inputTokens); pCr = num(pl.u.cacheReadTokens)
          pTot = pIn + pCr + num(pl.u.cacheWriteTokens)
        }
        const pSys = pe.find((e) => e.type === 'request/header')?.data?.header?.system
        if (typeof pSys === 'string' && typeof ownSys === 'string') {
          const n = Math.min(pSys.length, ownSys.length)
          let i = 0; while (i < n && pSys.charCodeAt(i) === ownSys.charCodeAt(i)) i++
          lcp = `${i}/${ownSys.length}`
        }
        const pd = pe.find((e) => e.type === 'subagent/descriptor')
        pLabel = `${String(pid).slice(0, 12)}${pd ? '' : '(无descriptor)'}`
      }
    }
    const tot = l.inputTokens + l.cacheReadTokens + l.cacheWriteTokens
    console.log(pad(String(head.id).slice(0, 12), 14) + pad(desc.provider ?? '-', 7) + pad(desc.mode ?? '-', 12) +
      pad(seedLen === null ? '(缺键)' : seedLen, 9) + pad(evs.filter((e) => e.type === 'session/end-seed').length, 8) +
      pad(evs.length, 6) + pad(l.inputTokens, 8) + pad(l.cacheReadTokens, 8) + pad(tot, 8) +
      pad(lcp, 8) + pad(pIn, 8) + pad(pCr, 8) + pad(pTot, 8) + pLabel)
  }
  console.log('\n注：自己in/自己cr = 分身自己（seq > seedLength）的 (turn,step) 归并小计；自己总 = in+cr+cw。')
  console.log('    sysLCP = 子代 request/header.system 与父代 request/header.system 的逐字公共前缀 / 子代 system 长度。')
  console.log('    父末in/父末cr/父末总 = 父代【最后一条】有 usage 的 step（委派后父代还会继续跑，故不一定是委派那一刻）。')
}

/* ── 入口 ─────────────────────────────────────────────────────────── */
if (has('--list')) await modeList()
else if (has('--compare')) modeCompare()
else if (has('--inspect')) modeInspect()
else if (has('--run')) await modeRun()
else {
  console.log('usage:')
  console.log('  node scripts/make-seeded-fork.mjs --list')
  console.log('  node scripts/make-seeded-fork.mjs --run [--new] [--session <sid>]')
  console.log('  node scripts/make-seeded-fork.mjs --inspect <childSid> [--parent <parentSid>]')
  console.log('  node scripts/make-seeded-fork.mjs --compare <sid> <sid> ...')
}
