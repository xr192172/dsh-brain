#!/usr/bin/env node
/**
 * w66-assert.mjs —— 从 `out/ab-run-w66/*.json`（+ 会话日志**独立**复核）算：
 *   · 三条对照断言（A1 face 指纹 venue 归一化 / A2 控制臂 count==0 / A3 处理臂 count 严格递增）
 *   · 逐题读数表（oracle/regression/toolCalls/tokens×2/wallClock/返工）
 *   · 工具失误统计（工具 × 调用数 × 失败数 × 失败类型；两臂对比）
 *   · agent 对工具的自述（题面末段**原话**，不改写）
 *   · 两臂 system diff（venue 归一化后逐字节；独立从会话日志重取，不信任 run JSON 的自报）
 * 输出：out/w66-ab-readings.json（机读）+ stdout 人读摘要。
 * ★ 只读：不改任何 store / wt / 会话。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { decompress } from 'fzstd'

const REPO = 'D:/project_develop/dsh-brain'
const OUT = path.join(REPO, 'out', 'ab-run-w66')
const SESS_ROOT = 'C:/Users/Admin/.dsh/sessions'
const ARMS_FILE = path.join(REPO, 'evals', 'arms.json')
const TASKS_FILE = path.join(REPO, 'evals', 'pilot', 'tasks.jsonl')

const reg = JSON.parse(fs.readFileSync(ARMS_FILE, 'utf8').replace(/^\uFEFF/, ''))
const ARM = {}
for (const a of reg.arms) ARM[a.name] = { cwd: String(a.cwd).replace(/\\/g, '/'), store: String(a.store).replace(/\\/g, '/'), role: a.role, preset: a.preset, label: a.label }
const allTasks = fs.readFileSync(TASKS_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => JSON.parse(l))
const ORDER = [
  'cli-0006-selftest-drift-guard-json', 'cli-0007-store-surface-guard-pinned',
  'cli-0001-injected-message-identity', 'cli-0002-seal-before-unlock', 'cli-0003-prepareswitch-real-phase',
  'cli-0004-verify-drain-json-output', 'cli-0005-symbol-rename-design-canvas',
]

const sha8 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8)
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
function canonical(v) {
  if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}
const toolNameOf = (t) => t?.name ?? t?.function?.name ?? ''
function venueNorm(text, wt) {
  let s = String(text ?? '')
  const forms = new Set([wt, wt.replace(/\//g, '\\'), wt.replace(/\//g, '\\\\'), JSON.stringify(wt).slice(1, -1)])
  for (const f of forms) if (f) s = s.split(f).join('<WT>')
  return s.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
}
function faceOf(system, tools, wt) {
  const sys = venueNorm(system, wt)
  const list = Array.isArray(tools) ? tools : []
  const byName = new Map()
  for (const t of list) { const n = toolNameOf(t); if (!byName.has(n)) byName.set(n, t) }
  const names = [...byName.keys()].sort()
  const parts = ['dsh-face/v1', '|S|' + sys.length, sys, '|T|' + names.length]
  for (const n of names) parts.push(n, venueNorm(canonical(byName.get(n)), wt))
  return { faceNormRaw: sha8(String(system ?? '').length + '|' + sys), faceNorm: sha8(parts.join('\n')), names, count: list.length, sysNorm: sys, sysLenRaw: String(system ?? '').length }
}
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}
function findSessionFile(sid) {
  for (const proj of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const f = path.join(SESS_ROOT, proj.name, sid, 'session.jsonl.zstd')
    if (fs.existsSync(f)) return f
  }
  return null
}
function readEvents(file) {
  const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
const load = (key) => { const p = path.join(OUT, `${key}.json`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : null }

const out = { at: new Date().toISOString(), order: ORDER, arms: ARM, assertions: {}, perTask: {}, toolFailures: {}, selfReports: {}, systemDiff: {}, missing: [] }

// ── A2/A3：store count 序列 ─────────────────────────────────────────────
const countSeq = { A: [], B: [] }
for (const id of ORDER) {
  for (const armName of ['A', 'B']) {
    const R = load(`${id}__${armName}`)
    if (!R) { out.missing.push(`${id}__${armName}`); countSeq[armName].push(null); continue }
    const atInject = R.stages?.carrier?.storeCount ?? null
    const after = R.stages?.store?.countAfter ?? null
    if (armName === 'B') countSeq.B.push(after)
    else countSeq.A.push(after)
  }
}
const A2 = countSeq.A.every((c) => c === 0)
const Bseq = countSeq.B.map((x) => (x === null ? -1 : x))
const A3 = Bseq.every((n, i) => i === 0 || n > Bseq[i - 1]) && Bseq[Bseq.length - 1] > 0
out.assertions.A2 = { name: '控制臂 count == 0（每 k）', ok: A2, seq: countSeq.A }
out.assertions.A3 = { name: '处理臂 count 随 k 严格递增（末项>0）', ok: A3, seq: countSeq.B }

// ── A1 + system diff：**独立**从会话日志重取 system/tools ────────────────
{
  const rows = []
  let allOk = true
  for (const id of ORDER) {
    const per = {}
    for (const armName of ['A', 'B']) {
      const R = load(`${id}__${armName}`)
      if (!R || !R.sessionId) { per[armName] = null; continue }
      const f = findSessionFile(R.sessionId)
      if (!f) { per[armName] = null; continue }
      const evs = readEvents(f)
      const hdr = evs.find((e) => e.type === 'request/header')
      const sys = String(hdr?.data?.header?.system ?? '')
      const tools = hdr?.data?.header?.tools ?? []
      const wt = R.wt ?? ARM[armName].cwd
      per[armName] = { ...faceOf(sys, tools, wt), tools }
    }
    const sameNorm = !!per.A && !!per.B && per.A.faceNorm === per.B.faceNorm
    const sameRawSys = !!per.A && !!per.B && per.A.sysNorm === per.B.sysNorm
    const sameNames = !!per.A && !!per.B && JSON.stringify(per.A.names) === JSON.stringify(per.B.names)
    let diffAt = null, ctx = null
    if (per.A && per.B && !sameRawSys) {
      diffAt = firstDiff(per.A.sysNorm, per.B.sysNorm)
      ctx = { A: per.A.sysNorm.slice(Math.max(0, diffAt - 80), diffAt + 120), B: per.B.sysNorm.slice(Math.max(0, diffAt - 80), diffAt + 120) }
    }
    const injectedInSystem = !!(per.A && per.B && (/记忆注入/.test(per.A.sysNorm) || /没有可注入的条目|^- \[/m.test(per.A.sysNorm)))
    rows.push({ id, faceA: per.A?.faceNorm ?? null, faceB: per.B?.faceNorm ?? null, sameNorm, systemBytesIdenticalAfterVenueNorm: sameRawSys, sysLenA: per.A?.sysNorm.length ?? null, sysLenB: per.B?.sysNorm.length ?? null, sameToolNames: sameNames, toolCountA: per.A?.count ?? null, toolCountB: per.B?.count ?? null, injectedTextInSystem: injectedInSystem, firstDiffAt: diffAt, diffCtx: ctx })
    if (!(sameNorm && sameRawSys && sameNames)) allOk = false
    out.systemDiff[id] = { sameNorm, sameRawSys, sameNames, diffAt, ctx }
  }
  out.assertions.A1 = { name: '两臂 face 指纹相同（venue 归一化后）', ok: allOk, rows }
}

// ── 逐题读数表 + 工具失误 + 自述 ─────────────────────────────────────────
for (const id of ORDER) {
  const task = allTasks.find((t) => t.id === id)
  const row = { id, kind: task?.kind ?? 'regression-repair', budgetMinutes: task?.budget?.maxMinutes ?? null, arms: {} }
  for (const armName of ['A', 'B']) {
    const R = load(`${id}__${armName}`)
    if (!R) { row.arms[armName] = null; continue }
    const M = R.stages?.metrics ?? {}
    const T = R.stages?.tokens ?? {}
    const assistantTexts = M.assistantTexts ?? []
    const lastText = assistantTexts.length ? assistantTexts[assistantTexts.length - 1].text : ''
    row.arms[armName] = {
      sessionId: R.sessionId ?? null, outcome: R.stages?.outcome ?? R.error ?? null,
      wallMs: R.stages?.wallMs ?? null, stepDelta: R.stages?.stepDelta ?? null,
      oracle: R.stages?.oracle ?? null, regression: R.stages?.regression ?? null,
      toolCalls: M.toolCalls ?? null, toolResults: M.toolResults ?? null, byTool: M.byTool ?? null,
      failureCount: (M.failures ?? []).length, failByTool: M.failByTool ?? null, failByKind: M.failByKind ?? null,
      failures: M.failures ?? [],
      rework: M.rework ?? null, editCalls: M.editCalls ?? null, distinctFilesEdited: M.distinctFilesEdited ?? null,
      tokens: {
        providerEvents: T.providerEvents ?? null,
        providerProjection: T.providerProjection ?? null,
        dsTokenCount: T.dsTokenCount ?? null,
      },
      face: M.face ?? null,
      store: R.stages?.store ?? null,
      injected: { found: M.injected?.found ?? null, textLen: M.injected?.textLen ?? null, sha256: M.injected?.sha256 ?? null },
      agentChanges: R.stages?.agentChanges ?? null,
      model: R.stages?.model ?? null, presetReadback: R.stages?.presetReadback ?? null,
      restore: R.stages?.restore ?? null,
      lastAssistantText: lastText,
    }
    // 工具失误统计（按臂累计 + 明细）
    out.toolFailures[`${id}__${armName}`] = { byTool: M.failByTool ?? {}, byKind: M.failByKind ?? {}, total: (M.failures ?? []).length, detail: M.failures ?? [] }
    out.selfReports[`${id}__${armName}`] = { lastAssistantText: lastText, allCount: assistantTexts.length }
  }
  out.perTask[id] = row
}

// ── ★ 工具失误：**独立**从会话日志重取（取 tool-result 正文再分类，不信 run JSON 的自报）──
{
  /**
   * ★ 失败类型（按优先级；**只在真的失败结果上分类**）。
   *   ★★ 关键防假阳：`read` 工具**成功**返回的正文里会出现 `spawn`/`child_process` 等词
   *     （就是源码文本本身）⇒ 必须先把"文件载荷"（`<path>…<content>…`）排除，
   *     否则会把一次成功的读文件记成"进程被禁"。第一版就栽在这里。
   */
  const FAIL_KINDS = [
    ['redirect-native-exe', /StandardErrorEncoding|StandardOutputEncoding|only supported when standard (error|output) is redirected|运行失败/i],
    ['dev-null-path', /Access to the path '[^']*dev[\\/]null'|\\dev\\null/i],
    ['spawn-blocked', /spawnSync[^\n]*EPERM|EPERM[^\n]*spawnSync|child proc|belongs to the "the child proc|进程.*(被|不)允许|process spawning|spawn.*not permitted/i],
    ['unknown-tool', /unknown tool|Unknown tool/i],
    ['not-found', /ENOENT|cannot find|no such file|not found|找不到路径|is not recognized|CommandNotFound/i],
    ['not-defined', /is not defined|is not a function|Cannot read propert/i],
    ['permission', /EPERM|EACCES|Access is denied|拒绝访问|permission denied/i],
    ['timeout', /超时|timed out|timeout/i],
    ['refused', /ECONNREFUSED|ECONNRESET|socket hang up/i],
    ['shell-usage', /bad option|Invalid string escape|SyntaxError|^Usage:|^usage:/im],
    ['traceback', /Traceback|TypeError|ReferenceError/i],
    ['stderr', /\[stderr\]/],
  ]
  const textOfResult = (d) => {
    const c = d?.message?.content?.[0]?.content
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('\n')
    return typeof d?.message?.content === 'string' ? d.message.content : ''
  }
  const isFilePayload = (t) => /^<path>/.test(t.trim()) || /<\/content>/.test(t) || /^\s*\d+:/.test(t)
  const classify = (t, isErr) => {
    for (const [k, re] of FAIL_KINDS) if (re.test(t)) return k
    return isErr ? 'isError-true' : 'other'
  }
  out.toolFailures = {}
  for (const id of ORDER) {
    for (const armName of ['A', 'B']) {
      const R = load(`${id}__${armName}`)
      if (!R || !R.sessionId) { out.toolFailures[`${id}__${armName}`] = null; continue }
      const f = findSessionFile(R.sessionId)
      if (!f) { out.toolFailures[`${id}__${armName}`] = null; continue }
      const evs = readEvents(f)
      const callName = new Map()
      let calls = 0
      const byTool = {}
      for (const e of evs) if (e.type === 'tool/call') { calls++; const n = e.data?.name ?? '?'; byTool[n] = (byTool[n] ?? 0) + 1; if (e.data?.callId) callName.set(e.data.callId, n) }
      const failByTool = {}, failByKind = {}
      const detail = []
      for (const e of evs) {
        if (e.type !== 'tool/result') continue
        const d = e.data ?? {}
        const isErr = d?.message?.content?.[0]?.isError === true
        const t = textOfResult(d)
        if (isFilePayload(t)) continue // ★ 成功读文件的载荷不算失败
        const ERR_SIG = /\[stderr\]|ResourceUnavailable|EPERM|EACCES|拒绝访问|Access is denied|ENOENT|no such file|not found|is not defined|SyntaxError|TypeError|ReferenceError|Traceback|Unknown tool|unknown tool|not recognized|Cannot find|超时|timed out|运行失败|Access to the path|bad option/i
        if (!(isErr || ERR_SIG.test(t))) continue
        const tool = callName.get(d?.message?.source?.callId) ?? '(未知工具)'
        const kind = classify(t, isErr)
        failByTool[tool] = (failByTool[tool] ?? 0) + 1
        failByKind[kind] = (failByKind[kind] ?? 0) + 1
        detail.push({ seq: e.seq, tool, kind, text: String(t).slice(0, 300).replace(/\s+/g, ' ') })
      }
      out.toolFailures[`${id}__${armName}`] = { calls, byTool, failByTool, failByKind, total: detail.length, detail }
    }
  }
}

// ── 汇总打印 ───────────────────────────────────────────────────────────
const pct = (n) => (n === null || n === undefined ? '-' : String(n))
console.log('='.repeat(100))
console.log('w66 A/B 读数汇总')
console.log('='.repeat(100))
if (out.missing.length) console.log(`★ 缺落盘：${out.missing.join(', ')}`)
console.log('\n[断言]')
console.log(`  A1 两臂 face 指纹相同（venue 归一化）: ${out.assertions.A1.ok ? '成立 ✓' : '**不成立 ✗**'}`)
for (const r of out.assertions.A1.rows) console.log(`     ${r.id}\n        faceA=${r.faceA} faceB=${r.faceB} 相同=${r.sameNorm} system逐字节=${r.systemBytesIdenticalAfterVenueNorm} 工具名同=${r.sameToolNames} 注入段在system=${r.injectedTextInSystem}${r.firstDiffAt !== null ? ` 首差@${r.firstDiffAt}` : ''}`)
console.log(`  A2 控制臂 count==0: ${out.assertions.A2.ok ? '成立 ✓' : '**不成立 ✗**'}  seq=[${out.assertions.A2.seq.join(',')}]`)
console.log(`  A3 处理臂 count 严格递增: ${out.assertions.A3.ok ? '成立 ✓' : '**不成立 ✗**'}  seq=[${out.assertions.A3.seq.join(',')}]`)

console.log('\n[逐题读数：oracle / regression / toolCalls / tokens(provider事件|DS口径) / wall(s) / 返工]')
console.log(`  ${'task'.padEnd(38)} ${'arm'.padEnd(4)} oracle reg tool tk_prov tk_ds wall rework`)
for (const id of ORDER) {
  const row = out.perTask[id]
  for (const armName of ['A', 'B']) {
    const a = row.arms[armName]
    if (!a) { console.log(`  ${id.padEnd(38)} ${armName.padEnd(4)} (缺)`); continue }
    const ds = a.tokens?.dsTokenCount?.totals?.tokens ?? a.tokens?.dsTokenCount?.tokens ?? '-'
    console.log(`  ${id.slice(0, 38).padEnd(38)} ${armName.padEnd(4)} ${String(a.oracle?.pass ? 'PASS' : 'FAIL').padEnd(6)} ${String(a.regression?.pass ? 'PASS' : 'FAIL').padEnd(3)} ${pct(a.toolCalls).padEnd(4)} ${pct(a.tokens?.providerEvents?.outputTokens).padEnd(7)} ${pct(ds).padEnd(5)} ${pct(Math.round((a.wallMs ?? 0) / 1000)).padEnd(4)} ${pct(a.rework)}`)
  }
}

console.log('\n[工具失误统计（独立从会话日志重取：工具 × 调用数 × 失败数；+ 失败类型分布）]')
for (const id of ORDER) {
  for (const armName of ['A', 'B']) {
    const t = out.toolFailures[`${id}__${armName}`]
    if (!t) continue
    const calls = Object.entries(t.byTool).map(([k, v]) => `${k}×${v}`).join(' ')
    const failc = Object.entries(t.failByTool).map(([k, v]) => `${k}×${v}`).join(' ')
    const kinds = Object.entries(t.failByKind).map(([k, v]) => `${k}×${v}`).join(' ')
    console.log(`  ${id.slice(0, 30).padEnd(30)} ${armName} calls=[${calls}] 失败=[${failc}] 类型=[${kinds}] 合计=${t.total}`)
  }
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, '_readings.json'), JSON.stringify(out, null, 2) + '\n', 'utf8')
console.log(`\n机读 → out/ab-run-w66/_readings.json`)
