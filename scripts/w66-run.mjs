#!/usr/bin/env node
/**
 * w66-run.mjs —— w66：**第一次真正可信的 A/B** 的驱动器。
 *
 * 每题每臂一条固定流水线（与题面/判据口径一致，不改任何判据）：
 *   复位 wt（git 回滚 + 清未跟踪） ⇒ 打 seed（`eval-validate --prepare`）⇒ 证信号（oracle 必红）
 *   ⇒ 渲染记忆载体到 `<wt>/AGENTS.md` ⇒ 建**新**会话（cwd=wt, preset=council）⇒ 发题（eval-run 的 v2 题面）
 *   ⇒ 等空闲 ⇒ 采读数（oracle/regression/toolCalls/tokens×2/wallClock/返工）
 *   ⇒ 还原 seed（sha256 独立复核）⇒ 复原 wt ⇒ 处理臂写一条 L1 ⇒ 立刻落盘 `out/ab-run-w66/<id>__<arm>.json`
 *
 * ★ 纪律（逐条照做）
 *   · 只**新建**会话（`session.create`），绝不碰在用的会话；不起服务、不杀进程、不改 `packages/switchboard/**`。
 *   · seed/还原一律**委托** `scripts/eval-validate.mjs`（生产路径）——本脚本不自己实现打/还原，
 *     并**独立**用 sha256 再验一次还原结果。
 *   · 判据（oracle/regression）从**判据根**跑，用 `DSH_EVAL_REPO` 指认被测树（R1 口径）。
 *   · 缺读数一律记 `NEEDS-EVIDENCE`，**绝不填“通过”**。
 *   · 每题每臂**立刻落盘**（防中断丢进度），并更新 `out/_w66/progress.json`。
 *
 * 用法：
 *   node scripts/w66-run.mjs --tasks cli-0006,cli-0007          # 先跑同族两题
 *   node scripts/w66-run.mjs --tasks cli-0001,cli-0002,cli-0003,cli-0004,cli-0005
 *   node scripts/w66-run.mjs --tasks all
 *   node scripts/w66-run.mjs --only cli-0006 --arm A
 *   node scripts/w66-run.mjs --tasks all --skip-existing        # 已落盘的题跳过（续跑）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { decompress } from 'fzstd'

const REPO = 'D:/project_develop/dsh-brain'
const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const SESS_ROOT = 'C:/Users/Admin/.dsh/sessions'
const MEMPROMPT = path.join(REPO, 'out', 'memprompt.exe')
const MEMFACE = path.join(REPO, 'out', 'memface.exe')
const ARMS_FILE = path.join(REPO, 'evals', 'arms.json')
const TASKS_FILE = path.join(REPO, 'evals', 'pilot', 'tasks.jsonl')
const OUT_DIR = path.join(REPO, 'out', 'ab-run-w66')
const PROGRESS = path.join(REPO, 'out', '_w66', 'progress.json')
const EOL_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']

/** ★ 批次顺序：同族两题（cli-0006/cli-0007）**必须最先**，且相邻。 */
const DEFAULT_ORDER = [
  'cli-0006-selftest-drift-guard-json',
  'cli-0007-store-surface-guard-pinned',
  'cli-0001-injected-message-identity',
  'cli-0002-seal-before-unlock',
  'cli-0003-prepareswitch-real-phase',
  'cli-0004-verify-drain-json-output',
  'cli-0005-symbol-rename-design-canvas',
]

/**
 * ★★ L1 写入内容（族级做法/纪律；**不点任何具体文件 / 行 / 字段 / 修法**）。
 *   逐条自检：都不含新交付物的文件名、不含代码标识符、不含 find 锚点、不含判据期望值 ⇒ 不是 L2/L3。
 */
const L1_OF = {
  'cli-0001-injected-message-identity':
    '族级做法（回归修复）：动那种"会让整份记录读不出来"的写法之前，先想清楚这条记录被**别人**读时靠什么认它——缺了这层身份，读侧是整份失败而不是单条失败。修完不要只看"命令不报错"，要真的让读侧把这批记录从头读完一遍。',
  'cli-0002-seal-before-unlock':
    '族级做法：凡涉及"交接/两代之间"的改动，先定**顺序**——必须先确认旧的动作确实已停，再放开新的；顺序反了就是两代同时动同一份东西。改完用一个能自证的检查确认"没停就不能放"。',
  'cli-0003-prepareswitch-real-phase':
    '族级做法：判断"有没有在做"这类状态时，要直读**真实来源**，不要读一个可能永远不触发的二手事件——后者会让你以为逻辑生效、其实从未执行过。验收方式：让这个判断在"确实有事在做"时真的为真。',
  'cli-0004-verify-drain-json-output':
    '族级做法：给脚本加机器可读输出时，把"人读"与"机器读"两条路分开——人读一律走 stderr，机器读在 stdout 只留一个 JSON 对象；对象要**逐条判据一个键**并另给汇总，且**不带开关时的输出与退出码逐字不变**。',
  'cli-0005-symbol-rename-design-canvas':
    '族级做法：按语义做跨文件重命名时，先把"哪些是语义引用、哪些是巧合同名"分开——语义引用要跟全，同名的局部量、以及字符串字面量里的同名文本都不能动；改完用既有自检确认行为逐字不变。',
  'cli-0006-selftest-drift-guard-json':
    '族级做法（"口径护栏"模式）：把"人眼看一次"升级成"每次都能复跑"时，按同一套骨架落地：① 记基线（把当前读数落盘，成功即退 0）；② 查基线（与当前逐条比对，有任何漂移即退非零，漂移内容走 stderr 并逐条点名是哪一条）；③ 机器可读开关下 stdout 只留一个 JSON 对象；④ 用一条自证命令证明"该红的红、该绿的不绿"（含故意改坏基线必须变红）。换被观测对象时，只替换读数与基线格式。',
  'cli-0007-store-surface-guard-pinned':
    '族级做法（同族第二题）：沿用上一题的护栏骨架即可，但要注意增量是把**格式与语义收紧**——基线格式一旦被钉死就照钉死的写；漂移清单只列真的漂了的、并按条目名升序；并把"基线文件不存在"当成一个**独立的退出码语义**，与"有漂移"区分开。',
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const slash = (s) => String(s).replace(/\\/g, '/')
const toolNameOf = (t) => t?.name ?? t?.function?.name ?? ''
const textOf = (c) => {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' ? (p.text ?? '') : String(p))).join('\n')
  if (typeof c === 'object' && typeof c.text === 'string') return c.text
  return ''
}
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const has = (k) => argv.includes(k)
if (has('-h') || has('--help')) {
  console.log('usage: node scripts/w66-run.mjs --tasks <id,...|all> [--arms A,B] [--only <id>] [--arm <A|B>] [--skip-existing]')
  process.exit(0)
}
if (!has('--tasks') && !argOf('--only')) {
  console.error('必须显式给 --tasks <id,...|all> 或 --only <id>（防误跑）')
  process.exit(2)
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
}
const gitIn = (dir, args, opts = {}) => sh('git', ['-C', dir, ...args], opts)
/**
 * ★ 传输层重试：实测 `session.create` 偶发 `fetch failed`（瞬时不可达）⇒ 一次实验整跑被废。
 *   ★ 只对**幂等/可重建**的调用重试（create/list/models）。`session.prompt` **绝不重试**
 *     —— 重发会把题面发两遍，那是污染而不是容错（调用点显式传 tries=1）。
 */
async function rpc(method, payload, tries = 4) {
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${FRONT}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
      })
      const text = await res.text()
      try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: null, text: text.slice(0, 400) } }
    } catch (e) {
      last = e
      if (i < tries - 1) await sleep(1500 * (i + 1))
    }
  }
  throw last
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

/* ── face（dsh-face/v1 本地移植 + **venue 归一化**）────────────────────── */
const FACE_VERSION = 'dsh-face/v1'
const sha8 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)
function canonical(v) {
  if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}
/**
 * ★★ venue 归一化：两臂跨卷 ⇒ cwd 必不同 ⇒ 原样比 **必然不同**。
 *   把所有能表达本臂 cwd 的写法都换成 `<WT>`（正斜杠 / 反斜杠 / JSON 转义形态），
 *   再把 `127.0.0.1:<port>` 换成 `127.0.0.1:PORT` ⇒ 剩下的才是"与场地无关"的脸。
 */
function venueNorm(text, wt) {
  let s = String(text ?? '')
  const forms = new Set([wt, slash(wt), wt.replace(/\//g, '\\'), wt.replace(/\//g, '\\\\'), JSON.stringify(wt).slice(1, -1)])
  for (const f of forms) if (f) s = s.split(f).join('<WT>')
  s = s.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
  return s
}
function faceOf(system, tools, { normalize = false, wt = null } = {}) {
  const sysRaw = typeof system === 'string' ? system : String(system ?? '')
  const sys = normalize ? venueNorm(sysRaw, wt) : sysRaw
  const list = Array.isArray(tools) ? tools : []
  const byName = new Map()
  for (const t of list) { const n = toolNameOf(t); if (!byName.has(n)) byName.set(n, t) }
  const names = [...byName.keys()].sort()
  const parts = [FACE_VERSION, '|S|' + sys.length, sys, '|T|' + names.length]
  for (const n of names) {
    const body = canonical(byName.get(n))
    parts.push(n, normalize ? venueNorm(body, wt) : body)
  }
  return { face: sha8(parts.join('\n')), namesHash: sha8(names.join('\n')), names, count: list.length, sysLen: sys.length, sysNorm: sys }
}

/* ── 题面（★ 逐字取 eval-run.mjs 的 v2 `taskPrompt`）────────────────────── */
function taskPrompt(t) {
  return [
    '【评测任务】仓库里有一处回归，导致下面这条不变量被破坏：',
    '',
    `  ${t.invariant}`,
    '',
    '请定位并修好它（以仓库内现有代码为准；修完必须让仓库自己的检查脚本通过）。',
    '要求：① 不要向我提问、不要等我确认；② 修完就停手，不要顺手重构无关代码；',
    '③ 用你能用的工具**实际改文件**，不要只在回答里贴 patch。',
    '④ 另外，请用两三句话说说：你刚才用的工具里，**哪一步最别扭 / 哪里有坑 / 你希望它怎么改**。',
    '请自行确认你的改动确实修好了问题。',
  ].join('\n')
}

/* ── 臂（注册表）─────────────────────────────────────────────────────── */
const reg = JSON.parse(fs.readFileSync(ARMS_FILE, 'utf8').replace(/^\uFEFF/, ''))
const ARM = {}
for (const a of reg.arms) ARM[a.name] = { name: a.name, role: a.role, cwd: slash(a.cwd), store: slash(a.store), preset: a.preset, label: a.label }
const ARMS = (argOf('--arms') ?? argOf('--arm') ?? 'A,B').split(',').map((s) => s.trim()).filter(Boolean)
for (const a of ARMS) if (!ARM[a]) { console.error(`注册表里没有臂 ${a}`); process.exit(2) }

/* ── 任务 ────────────────────────────────────────────────────────────── */
const allTasks = fs.readFileSync(TASKS_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).map((l) => JSON.parse(l))
const taskByIdOrPrefix = (q) => {
  const exact = allTasks.find((t) => t.id === q)
  if (exact) return exact
  const p = allTasks.filter((t) => t.id.startsWith(q))
  if (p.length === 1) return p[0]
  throw new Error(`--tasks 里的 '${q}' ${p.length > 1 ? `匹配到多题 ${p.map((x) => x.id).join(', ')}` : '匹配不到任何题'}`)
}
const tasksArg = argOf('--tasks')
let ORDER
if (argOf('--only')) ORDER = [taskByIdOrPrefix(argOf('--only')).id]
else if (!tasksArg || tasksArg === 'all') ORDER = DEFAULT_ORDER
else ORDER = tasksArg.split(',').map((s) => taskByIdOrPrefix(s.trim()).id)

/* ── 记忆面 ──────────────────────────────────────────────────────────── */
function faceCount(db) {
  const r = spawnSync(MEMFACE, ['count', '--db', db], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(String(r.stdout ?? '').trim().split('\n').filter(Boolean)[0] ?? 'null') } catch { /* 留 null */ }
  return { exit: r.status, raw: String(r.stdout ?? '').trim(), count: json?.count ?? null }
}
function faceRemember(db, text, kind = 'note') {
  const r = spawnSync(MEMFACE, ['remember', '--db', db, '--text', text, '--kind', kind], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(String(r.stdout ?? '').trim().split('\n').filter(Boolean)[0] ?? 'null') } catch { /* 留 null */ }
  return { exit: r.status, raw: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').trim(), count: json?.count ?? null }
}
function renderCarrier(db) {
  const r = spawnSync(MEMPROMPT, ['render', '--db', db], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`memprompt render 失败 exit=${r.status} stderr=${String(r.stderr ?? '').trim().slice(0, 200)}`)
  return JSON.parse(String(r.stdout ?? '').trim())
}

/* ── 载体模板（逐字同 scripts/mem-arm.mjs / mem-seq.mjs）──────────────── */
const HEADING = '# 记忆注入（由 scripts/mem-arm.mjs 从记忆库渲染，勿手改）'
const EMPTY_NOTE = '（本题的记忆库为空：没有可注入的条目）'
const PREFACE = '以下条目来自本会话绑定的记忆库。它们可能与本任务相关；相关则纳入判断，无关则忽略。'

/* ── 会话统计 ────────────────────────────────────────────────────────── */
async function sessionStats(sid) {
  const r = await rpc('session.list', {})
  const s = (valOf(r)?.items ?? []).find((x) => x.sessionId === sid)
  if (!s) return null
  const st = s.projections?.values?.sessionStats ?? {}
  const tk = s.projections?.values?.tokenUsage ?? {}
  return {
    running: !!s.running,
    asOfSeq: s.projections?.asOfSeq ?? null,
    steps: st.steps ?? null,
    turns: st.turns ?? null,
    toolMs: st.toolMs ?? null,
    llmMs: st.llmMs ?? null,
    outputTokens: tk.outputTokens ?? null,
    uncachedInputTokens: tk.uncachedInputTokens ?? null,
    cwd: s.cwd ?? null,
    agentPreset: s.agentPreset ?? null,
  }
}
/** ★ 等前端可达（最多 40s）。实测 `session.create` 偶发瞬时 `fetch failed`。 */
async function waitFront() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${FRONT}/`, { method: 'GET' })
      if (r.status === 200) return true
    } catch { /* 继续等 */ }
    await sleep(2000)
  }
  return false
}
async function sessionModel(sid) {
  const r = await rpc('session.models', { sessionId: sid })
  const c = valOf(r)?.current
  return c ? `${c.provider}/${c.model}` : null
}

/* ── 失败类型分类（内容判据：isError 位不可信）────────────────────────── */
function classifyFailure(text) {
  const s = String(text)
  const rules = [
    ['stderr', /\[stderr\]/i],
    ['not-found', /找不到路径|cannot find|not recognized|no such file|ENOENT|CommandNotFound|is not recognized/i],
    ['not-defined', /is not defined|is not a function|undefined is not|Cannot read propert/i],
    ['permission', /EPERM|EACCES|denied|拒绝访问|权限/i],
    ['timeout', /超时|timed out|timeout/i],
    ['refused', /ECONNREFUSED|ECONNRESET|socket hang up/i],
    ['nonzero-exit', /exit code|退出码|non-zero|failed with exit/i],
    ['running-failed', /运行失败/],
    ['traceback', /Traceback|SyntaxError|TypeError|ReferenceError/i],
  ]
  for (const [name, re] of rules) if (re.test(s)) return name
  return 'other'
}

/* ── 主流程 ──────────────────────────────────────────────────────────── */
const report = { at: new Date().toISOString(), front: FRONT, arms: ARM, order: ORDER, runs: {}, env: {} }
function persist() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, '_index.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
}
function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8').replace(/^\uFEFF/, '')) } catch { return { goal: '', done: [], todo: [], evidence: [], blockers: [] } }
}
function saveProgress(p) { fs.mkdirSync(path.dirname(PROGRESS), { recursive: true }); fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2) + '\n', 'utf8') }

async function runOne(task, armName) {
  const arm = ARM[armName]
  const wt = arm.cwd
  const t0 = Date.now()
  const R = {
    task: task.id, taskKind: task.kind ?? 'regression-repair', arm: armName, armRole: arm.role,
    wt, store: arm.store, startedAt: new Date().toISOString(), stages: {},
  }
  const step = (msg) => console.log(`[${task.id}][${armName}] ${msg}`)

  // ① 复位 wt（已跟踪回滚 + 清未跟踪；ignored 保留）
  {
    gitIn(wt, [...EOL_FLAGS, 'checkout', '--', '.'])
    gitIn(wt, [...EOL_FLAGS, 'clean', '-fdq'])
    const st = String(gitIn(wt, ['status', '--porcelain']).stdout ?? '').trim()
    R.stages.reset = { statusPorcelain: st, clean: st === '' }
    step(`① 复位 wt：git status ${st ? `非空(${st.split('\n').length}行)` : '空 ✓'}`)
  }

  // ② 打 seed（委托 eval-validate）+ 记录 seed 目标文件改前 sha256（独立复核用）
  const seedFiles = [...new Set((task.seed?.edits ?? []).map((e) => e.file))]
  const preSha = {}
  for (const f of seedFiles) { const abs = path.join(wt, f); preSha[f] = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null }
  let prepOut = null
  if (seedFiles.length > 0) {
    const pr = sh('node', ['scripts/eval-validate.mjs', '--only', task.id, '--prepare', task.id], { env: { ...process.env, DSH_EVAL_REPO: wt } })
    prepOut = { status: pr.status, tail: `${pr.stdout ?? ''}${pr.stderr ?? ''}`.slice(-600) }
    step(`② 打 seed：exit=${pr.status}（${seedFiles.join(', ')}）`)
  } else {
    step('② 本题无 seed（能力题）；HEAD 上 oracle 应已红')
  }
  R.stages.prepare = { seedFiles, preSha, out: prepOut }

  // ③ 证信号：oracle 必须红
  const runJudge = (cmd) => sh(cmd[0], cmd.slice(1), { cwd: REPO, env: { ...process.env, DSH_EVAL_REPO: wt, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }, timeout: 15 * 60_000 })
  const sig = runJudge(task.oracle.cmd)
  R.stages.signal = { oracleStatus: sig.status, red: sig.status !== 0, tail: `${sig.stdout ?? ''}${sig.stderr ?? ''}`.slice(-500) }
  step(`③ 信号：seed 后 oracle exit=${sig.status} ⇒ ${sig.status !== 0 ? '红 ✓' : '**仍绿 ✗（题目无信号）**'}`)

  // ④ 渲染记忆载体
  const rendered = renderCarrier(arm.store)
  const memBlock = rendered.items > 0 ? rendered.text : EMPTY_NOTE
  const carrier = `${HEADING}\n\n${PREFACE}\n\n${memBlock}\n`
  const carrierPath = path.join(wt, 'AGENTS.md')
  fs.writeFileSync(carrierPath, carrier, 'utf8')
  const cb = fs.readFileSync(carrierPath)
  R.stages.carrier = { path: slash(carrierPath), storeCount: rendered.count, items: rendered.items, bytes: cb.length, sha256: sha256(cb), hasBom: cb[0] === 0xef && cb[1] === 0xbb && cb[2] === 0xbf, text: carrier, store: arm.store }
  step(`④ 载体：store.count=${rendered.count} items=${rendered.items} → AGENTS.md ${cb.length}B`)

  // ★ --preflight：只验 ①–④ + 还原（不起会话、不发题），用于开跑前的装置自检
  if (has('--preflight')) {
    if (seedFiles.length > 0) sh('node', ['scripts/eval-validate.mjs', '--restore', '--force'], { env: { ...process.env, DSH_EVAL_REPO: wt } })
    gitIn(wt, [...EOL_FLAGS, 'checkout', '--', '.'])
    gitIn(wt, [...EOL_FLAGS, 'clean', '-fdq'])
    const post = {}; for (const f of seedFiles) { const abs = path.join(wt, f); post[f] = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null }
    R.stages.preflight = { signalRed: sig.status !== 0, shaOk: seedFiles.every((f) => preSha[f] === post[f]), statusAfter: String(gitIn(wt, ['status', '--porcelain']).stdout ?? '').trim() }
    step(`★ preflight：信号红=${R.stages.preflight.signalRed} 还原逐字节=${R.stages.preflight.shaOk} wt=${R.stages.preflight.statusAfter ? '脏' : '干净'}`)
    R.finishedAt = new Date().toISOString(); R.elapsedMs = Date.now() - t0
    return R
  }

  // ⑤ 建会话（永远新建）★ 先等前端可达（实测有瞬时 `fetch failed`）
  await waitFront()
  const winCwd = wt.replace(/\//g, '\\')
  const c = await rpc('session.create', { cwd: winCwd, agentPreset: arm.preset })
  const sid = valOf(c)?.sessionId
  if (!sid) { R.stages.error = 'no-session'; R.stages.createErr = errOf(c); step(`⑤ 建会话失败：${JSON.stringify(errOf(c))}`); return R }
  R.sessionId = sid
  step(`⑤ 会话 ${sid}`)
  const tCreate = Date.now()
  while (Date.now() - tCreate < 60000) {
    const s = await sessionStats(sid)
    if (s && !s.running) break
    await sleep(1000)
  }
  const before = await sessionStats(sid)
  const model = await sessionModel(sid)
  R.stages.before = before
  R.stages.model = model
  R.stages.presetReadback = before?.agentPreset ?? null
  step(`   会话就绪 cwd=${before?.cwd} preset=${before?.agentPreset} model=${model}`)

  // ⑥ 发题
  const sent = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: taskPrompt(task) }] }, 1)
  R.stages.promptStatus = sent.status
  if (sent.status !== 200) { R.stages.error = 'prompt-failed'; R.stages.promptErr = errOf(sent); step(`⑥ 发题失败 HTTP ${sent.status}`); return R }
  const tPrompt = Date.now()
  step('⑥ 已发题，等待…')

  // ⑦ 等空闲（预算 = task.budget.maxMinutes）
  const budgetMs = (task.budget?.maxMinutes ?? 15) * 60_000
  let last = before
  let outcome = 'timeout'
  for (;;) {
    await sleep(4000)
    last = (await sessionStats(sid)) ?? last
    if (last && last.running === false && (last.asOfSeq ?? 0) !== (before?.asOfSeq ?? 0)) { outcome = 'settled'; break }
    if (Date.now() - tPrompt > budgetMs) { outcome = 'over-budget'; break }
  }
  const wallMs = Date.now() - tPrompt
  R.stages.after = last
  R.stages.outcome = outcome
  R.stages.wallMs = wallMs
  R.stages.stepDelta = (last?.steps ?? 0) - (before?.steps ?? 0)
  R.stages.outputTokensDelta = (last?.outputTokens ?? 0) - (before?.outputTokens ?? 0)
  R.stages.uncachedInputDelta = (last?.uncachedInputTokens ?? 0) - (before?.uncachedInputTokens ?? 0)
  step(`⑦ 结束：${outcome}（${(wallMs / 1000).toFixed(0)}s, steps +${R.stages.stepDelta}）`)
  await sleep(2000)

  // ⑧ 采读数：oracle / regression（绿则复跑一次做 flaky 检测；红则 regression 复跑一次）
  const o1 = runJudge(task.oracle.cmd)
  let after = o1, oRetry = null
  if (o1.status === 0) { oRetry = runJudge(task.oracle.cmd); if (oRetry.status !== 0) after = oRetry }
  R.stages.oracle = { firstStatus: o1.status, retryStatus: oRetry ? oRetry.status : null, status: after.status, pass: after.status === 0, flaky: !!oRetry && oRetry.status !== 0, tail: `${after.stdout ?? ''}${after.stderr ?? ''}`.slice(-900) }
  const g1 = runJudge(task.regression.cmd)
  let reg = g1, gRetry = null
  if (g1.status !== 0) { gRetry = runJudge(task.regression.cmd); if (gRetry.status === 0) reg = gRetry }
  R.stages.regression = { firstStatus: g1.status, retryStatus: gRetry ? gRetry.status : null, status: reg.status, pass: reg.status === 0, flaky: !!gRetry && gRetry.status === 0, tail: `${reg.stdout ?? ''}${reg.stderr ?? ''}`.slice(-900) }
  step(`⑧ oracle=${after.status === 0 ? '绿' : '红'} regression=${reg.status === 0 ? '绿' : '红'}`)

  // ⑨ 轨迹读数（会话日志）+ 工具失误 + 自述 + face
  const loc = findSessionFile(sid)
  if (!loc) { R.stages.error = 'no-session-log'; step('⑨ 找不到会话日志'); return R }
  R.sessionLog = slash(loc.file)
  const evs = readEvents(loc.file)
  const typeHist = {}
  for (const e of evs) typeHist[e.type] = (typeHist[e.type] ?? 0) + 1
  const calls = evs.filter((e) => e.type === 'tool/call')
  const results = evs.filter((e) => e.type === 'tool/result')
  const byTool = {}
  const callNameById = new Map()
  for (const c2 of calls) {
    const n = c2?.data?.name ?? '?'
    byTool[n] = (byTool[n] ?? 0) + 1
    if (c2?.data?.callId) callNameById.set(c2.data.callId, n)
  }
  // 失败判据：内容（isError 位不可信 —— 实测失败结果里 isError 仍是 false）
  const FAIL_RE = /\[stderr\]|运行失败|找不到路径|cannot find|not recognized|is not defined|Traceback|ECONNREFUSED|EPERM|EACCES|denied|超时|timed out/i
  const failByTool = {}
  const failByKind = {}
  const failures = []
  for (const r of results) {
    const s = JSON.stringify(r?.data ?? {})
    if (!FAIL_RE.test(s)) continue
    const cid = r?.data?.message?.source?.callId ?? r?.data?.callId ?? null
    const name = callNameById.get(cid) ?? r?.data?.name ?? '(未知工具)'
    const kind = classifyFailure(s)
    failByTool[name] = (failByTool[name] ?? 0) + 1
    failByKind[kind] = (failByKind[kind] ?? 0) + 1
    failures.push({ seq: r.seq, callId: cid, tool: name, kind, snippet: s.slice(0, 220) })
  }
  // usage（provider 口径）
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, n: 0 }
  for (const e of evs) {
    const u = e?.data?.usage ?? e?.data?.message?.usage
    if (u && typeof u === 'object') {
      usage.inputTokens += u.inputTokens ?? u.promptTokens ?? 0
      usage.outputTokens += u.outputTokens ?? u.completionTokens ?? 0
      usage.cacheReadTokens += u.cacheReadTokens ?? 0
      usage.cacheWriteTokens += u.cacheWriteTokens ?? 0
      usage.n++
    }
  }
  // assistant 文本（含"说说工具体验"那段）
  const assistantTexts = []
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const d = e.data ?? {}
    const tx = textOf(d.content ?? d.message?.content ?? d.message ?? d)
    if (tx.trim()) assistantTexts.push({ seq: e.seq, turn: d.turn, step: d.step, text: tx })
  }
  // face（第一条 request/header 的 system+tools）
  const hdrs = evs.filter((e) => e.type === 'request/header')
  const h0 = hdrs[0]?.data?.header ?? null
  const systemRaw = typeof h0?.system === 'string' ? h0.system : ''
  const tools = Array.isArray(h0?.tools) ? h0.tools : []
  const fRaw = faceOf(systemRaw, tools, { normalize: false })
  const fNorm = faceOf(systemRaw, tools, { normalize: true, wt })
  // 注入段（agent-instructions）—— 证明"注入在消息流、不在 system"
  const instrMsg = evs.find((e) => e.type === 'user/message' && e.data?.source?.kind === 'agent-instructions')
  const instrText = instrMsg ? textOf(instrMsg.data?.content ?? instrMsg.data?.message?.content ?? instrMsg.data) : ''
  // 返工：同一文件被重复编辑的次数（edit 类工具调用 − 被编辑的不同文件数）
  const EDIT_TOOLS = /edit|write|str_replace|notebook/i
  const editedFiles = new Set()
  let editCalls = 0
  for (const c2 of calls) {
    const n = c2?.data?.name ?? ''
    if (!EDIT_TOOLS.test(n)) continue
    editCalls++
    let a = {}
    try { a = JSON.parse(String(c2?.data?.arguments ?? '{}')) } catch { a = {} }
    const p = a.file_path ?? a.path ?? a.filePath ?? null
    if (typeof p === 'string') editedFiles.add(p)
  }
  const rework = Math.max(0, editCalls - editedFiles.size)
  R.stages.metrics = {
    eventTypes: typeHist, toolCalls: calls.length, toolResults: results.length, byTool,
    failures, failByTool, failByKind, failureRule: 'isError 位不可信 ⇒ 内容判据（[stderr]/错误关键词）',
    usageFromEvents: usage, assistantTexts,
    face: { raw: fRaw.face, norm: fNorm.face, systemLen: fRaw.sysLen, toolCount: fRaw.count, toolNames: fRaw.names, namesHash: fRaw.namesHash },
    injected: { found: !!instrMsg, seq: instrMsg?.seq ?? null, textLen: instrText.length, sha256: instrText ? sha256(instrText) : null, text: instrText.slice(0, 1200) },
    editCalls, distinctFilesEdited: editedFiles.size, rework,
  }
  step(`⑨ toolCalls=${calls.length} 失败=${failures.length} 返工=${rework} face.norm=${fNorm.face}`)

  // ⑩ 双口径 token
  const dsr = sh('node', ['scripts/ds-token-count.mjs', '--session', sid], { timeout: 5 * 60_000 })
  let dsJson = null
  try { dsJson = JSON.parse(String(dsr.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? 'null') } catch { dsJson = { parseError: String(dsr.stdout ?? '').slice(0, 300), exit: dsr.status } }
  R.stages.tokens = { providerEvents: usage, providerProjection: { outputTokensDelta: R.stages.outputTokensDelta, uncachedInputDelta: R.stages.uncachedInputDelta }, dsTokenCount: dsJson }

  // 变卖前快照：agent 的改动（供报告"它改了什么"）
  const diffStat = String(gitIn(wt, ['diff', '--stat']).stdout ?? '').trim()
  const untracked = String(gitIn(wt, ['status', '--porcelain']).stdout ?? '').split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim())
  R.stages.agentChanges = { diffStat, untracked }

  // ⑪ 还原 seed（委托）+ 独立 sha256 复核 + 复原 wt
  let restoreOut = null
  if (seedFiles.length > 0) {
    const rr = sh('node', ['scripts/eval-validate.mjs', '--restore', '--force'], { env: { ...process.env, DSH_EVAL_REPO: wt } })
    restoreOut = { status: rr.status, tail: `${rr.stdout ?? ''}${rr.stderr ?? ''}`.slice(-400) }
  }
  gitIn(wt, [...EOL_FLAGS, 'checkout', '--', '.'])
  gitIn(wt, [...EOL_FLAGS, 'clean', '-fdq'])
  const postSha = {}
  for (const f of seedFiles) { const abs = path.join(wt, f); postSha[f] = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : null }
  const shaOk = seedFiles.every((f) => preSha[f] === postSha[f])
  const stAfter = String(gitIn(wt, ['status', '--porcelain']).stdout ?? '').trim()
  R.stages.restore = { out: restoreOut, preSha, postSha, byteIdentical: shaOk, statusAfter: stAfter, clean: stAfter === '' }
  step(`⑪ 还原：seed 逐字节复核=${shaOk ? '通过 ✓' : '**不一致 ✗**'}；wt ${stAfter ? '仍脏 ✗' : '干净 ✓'}`)

  // ⑫ 处理臂写一条 L1（控制臂不写；并回读 count）
  const countBefore = faceCount(arm.store)
  let write = null
  if (arm.role === 'treat') {
    const l1 = L1_OF[task.id]
    if (!l1) { R.stages.error = 'no-L1-for-task'; step('⑫ 没有该题的 L1 内容'); return R }
    const w = faceRemember(arm.store, l1, 'note')
    write = { level: 'L1', text: l1, exit: w.exit, raw: w.raw, stderr: w.stderr, count: w.count }
    step(`⑫ 写入 L1（exit=${w.exit}）→ count ${countBefore.count} ⇒ ${w.count}`)
  } else {
    step(`⑫ 控制臂：不写（count=${countBefore.count}）`)
  }
  const countAfter = faceCount(arm.store)
  R.stages.store = { countBefore: countBefore.count, countAfter: countAfter.count, write }

  R.finishedAt = new Date().toISOString()
  R.elapsedMs = Date.now() - t0
  return R
}

/* ── 执行 ────────────────────────────────────────────────────────────── */
const GOAL = '跑 dsh-brain 第一次真正可信的 A/B：7 题 × 2 臂（A 控制 store 恒空 / B 处理 每题后写 L1），先 cli-0006+cli-0007，逐题落盘 out/ab-run-w66/，三条对照断言机器验证，报告 out/w66-first-credible-ab.md'
const prog = loadProgress()
prog.goal = GOAL
prog.blockers = prog.blockers ?? []
const ALL_KEYS = ORDER.flatMap((id) => ARMS.map((a) => `${id}__${a}`))
if (!prog.done) prog.done = []
prog.done = prog.done.filter((k) => ALL_KEYS.includes(k))
prog.todo = ALL_KEYS.filter((k) => !prog.done.includes(k))
prog.evidence = prog.done.map((k) => `out/ab-run-w66/${k}.json`)

// 环境前置快照
report.env = {
  repoHead: String(sh('git', ['rev-parse', 'HEAD']).stdout ?? '').trim(),
  armHead: Object.fromEntries(Object.entries(ARM).map(([k, a]) => [k, String(gitIn(a.cwd, ['rev-parse', 'HEAD']).stdout ?? '').trim()])),
  armStatus: Object.fromEntries(Object.entries(ARM).map(([k, a]) => [k, String(gitIn(a.cwd, ['status', '--porcelain']).stdout ?? '').trim()])),
  storeCount: Object.fromEntries(Object.entries(ARM).map(([k, a]) => [k, faceCount(a.store).count])),
  front: FRONT,
}

for (const id of ORDER) {
  const task = allTasks.find((t) => t.id === id)
  for (const armName of ARMS) {
    const preflightMode = has('--preflight')
    const key = `${id}__${armName}`
    const target = path.join(OUT_DIR, `${preflightMode ? '_preflight__' : ''}${key}.json`)
    if (has('--skip-existing') && fs.existsSync(target)) { console.log(`[skip] ${key} 已有落盘`); continue }
    console.log('\n' + '='.repeat(78))
    console.log(`RUN ${key}  (task.kind=${task.kind ?? 'regression-repair'}, arm.role=${ARM[armName].role})`)
    console.log('='.repeat(78))
    let R
    try {
      R = await runOne(task, armName)
    } catch (e) {
      R = { task: id, arm: armName, error: String(e?.stack ?? e), at: new Date().toISOString() }
      console.log(`[${id}][${armName}] ✗ 异常：${e?.message ?? e}`)
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(target, JSON.stringify(R, null, 2) + '\n', 'utf8')
    report.runs[key] = { file: slash(target), oracle: R.stages?.oracle?.status ?? null, regression: R.stages?.regression?.status ?? null, outcome: R.stages?.outcome ?? R.error ?? null, wallMs: R.stages?.wallMs ?? null, toolCalls: R.stages?.metrics?.toolCalls ?? null, storeCountAfter: R.stages?.store?.countAfter ?? null }
    persist()
    if (!prog.done.includes(key)) prog.done.push(key)
    prog.todo = ALL_KEYS.filter((k) => !prog.done.includes(k))
    prog.evidence = prog.done.map((k) => `out/ab-run-w66/${k}.json`)
    saveProgress(prog)
    console.log(`⇒ 落盘 ${slash(target)}`)
  }
}
console.log('\n全部完成。索引：out/ab-run-w66/_index.json')
process.exit(0)
