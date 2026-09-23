#!/usr/bin/env node
/**
 * mem-seq.mjs —— 主线第 ⑦ 格：**记忆的【写】侧**（走 (b) 编排，**不改工具面**）。
 *
 * ## 它补的是哪个洞（现状，别重新发现）
 *   · ✅ 读侧已成：`scripts/mem-arm.mjs` + `ai-base/…/cmd/memprompt` ⇒ 把 store 渲染进提示词
 *     （载体 = 会话 cwd 的 `AGENTS.md`，由 `@deepseek-ai/dsh-agent-instructions` 注入，
 *      **不碰 tools 段** ⇒ 工具面不变）。
 *   · ❌ 写侧没有 ⇒ 一条臂的 store 只能**预置常驻**（本实验里 B 臂预置 1 条）
 *     ⇒ 每个 k 的注入都一样 ⇒ **(甲) 序列/学习曲线型跑不了**，判据机器的 A3
 *       「处理臂 count 随 k 严格递增」在真实场地里只是**常驻 1**，不是真累积。
 *
 * ## ★ 为什么走 (b)「编排层在每题结束后写入」而不是 (a)「注册成 remember 工具」
 *   | | (a) 注册工具（agent 主动写） | ★ (b) 编排层写（本文件） |
 *   |---|---|---|
 *   | 工具面 | **变了**（多一个工具）⇒ 与历史读数**不可横比**；且两臂都要加才公平 |
 *   | agent 是否知情 | 知情（它得判断"该不该记"）⇒ 引入一个**新自变量** |
 *   | 累积的最简实现 | 要等 agent 自己"想清楚该记什么" | ★ **每题必写 ⇒ 累积是确定的** |
 *   ⇒ 本文件实现 (b)：**agent 全程不知道有写这件事**，工具面逐字不变。
 *
 * ## 每一步（严格按顺序）
 *   ① 渲染：`out/memprompt.exe render --db <store>`（Go 侧，复用 KnowledgeStore）→ 记 count/items/text
 *   ② 落载体：渲染结果包进固定模板写进 `<wt>/AGENTS.md`（UTF-8 无 BOM）
 *      —— ★ 与 `mem-arm.mjs` **逐字同一个模板**（同 HEADING/PREFACE/EMPTY_NOTE 常量）
 *   ③ 起会话：`session.create { cwd: <wt>, agentPreset: 'council' }`（★ 永远新建，不碰用户会话）
 *   ④ 发题：`session.prompt`（本题的极小任务，见 taskOf）
 *   ⑤ 等空闲
 *   ⑥ 取证（从会话语义日志读，不靠"我以为"）：
 *      · `request/header` 的 system 长度 + 工具名集合（两臂"脸"对比）
 *      · 注入消息（`source.kind=agent-instructions`）的正文
 *        ⇒ ★ 与①的渲染文本逐行比对 ⇒ **"注入 = 当时 store 的全部"** 这条有机器证据
 *      · 本题目标文件是否真的生成（本题的 oracle-lite）
 *   ⑦ ★★ **写侧**（只有 `--write per-task` 时才做；`--write none` 恒不写）：
 *      `out/memface.exe remember --db <store> --text <本题经验> --kind note`
 *      ⇒ 题 k 的注入里带的是**前 k−1 题攒下的**条目 ⇒ 这才是"累积"。
 *   ⑧ 再读一次 `out/memface.exe count`（写在之后的权威条目数）
 *
 * ## ★★ 写什么（这一步决定 A/B 有没有意义）—— 分级纪律
 *   · **L1（可以写）**：族级做法/纪律（"先逐字对齐文件名再动手""做完自检"…），
 *     **不点任何具体文件 / 行 / 字段 / 修法**。
 *   · **L2（变相答案，写进去要标出来）**：点出具体文件/行/字段。
 *   · **L3（答案，禁止）**：fix 代码 / `find` 锚点 / 判据期望值。
 *   ⇒ 本文件的写入内容**只有 L1**（见 L1_HEURISTICS）；★ 题面/id/notes/invariant/seed
 *     **一律不写**（那些含关键字面，属 L2/L3）。
 *   ⇒ 每条写入内容都记进 evidence（逐字），报告里逐题抄出 + 给 L 级判断。
 *
 * ## ★ 边界（如实说，别当成已验证）
 *   1. 本题序列用**自造的极小任务族**（`micro-write`），不是 `evals/pilot/tasks.jsonl` 的真回归题；
 *      写进去的"经验"是**族级 L1 提示**（按题序轮转），**不是**从该题答案里提取的。
 *   2. ★ 同一写入模板**若搬到真回归题上**，"目标是否完成 / 工具调用次数"这类观测就变成 L2 ⇒
 *      **不许直接搬用**（要搬必须先重新分级）。
 *   3. **n=3**，不谈显著性；本脚本只证"写侧接线 + 累积是真的"，**不产任何"记忆有效"的结论**。
 *   4. ★ **不是沙箱**：`--peer` 只堵"两臂互见"（跨卷 + 长回旋实探），不堵"回得到判据根"（O87 残余）。
 *
 * ## 用法
 *   # 控制臂（不写；store 应恒 0）
 *   node scripts/mem-seq.mjs --arm A --root D:/project_develop/_abA --write none \
 *        --peer C:/_abB-experiment-root --steps 3
 *   # 处理臂（每题后写入；store 应从 k 条涨到 k+步数 条）
 *   node scripts/mem-seq.mjs --arm B --root C:/_abB-experiment-root --write per-task \
 *        --peer D:/project_develop/_abA --steps 3
 *
 * ★ 只做：只读 RPC（session.create / session.prompt / session.list）+ 写
 *   `<wt>/AGENTS.md`（载体，本来就每步重渲染）+ 本臂的 store（`--write per-task` 时）+ 本臂 evidence。
 *   **不写**主仓、`packages/switchboard/**`、`evals/**`、`~/.dsh/**`。
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
/** ★ 写侧用的**真实写入口**（与 memprompt 同一个 KnowledgeStore；不新写一份存储）。 */
const MEMFACE = path.join(REPO, 'out', 'memface.exe')
const MAX_STEP_MS = 300000

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const has = (k) => argv.includes(k)

const NAME = argOf('--arm') ?? 'arm'
const ROOT_ARG = argOf('--root')
if (ROOT_ARG && !path.isAbsolute(ROOT_ARG)) {
  console.log(`[stop] --root 必须是绝对路径（用 D:/… 而不是 /d/…）：${ROOT_ARG}`)
  process.exit(2)
}
const ROOT = ROOT_ARG ? path.resolve(ROOT_ARG) : null
if (!ROOT) {
  console.log('[stop] 必须给 --root <该臂的实验根>（store=<root>/store、cwd=<root>/wt）')
  process.exit(2)
}
const STORE = argOf('--store') ? path.resolve(argOf('--store')) : path.join(ROOT, 'store')
const CWD = argOf('--cwd') ? path.resolve(argOf('--cwd')) : path.join(ROOT, 'wt')
/** ★ 写侧开关：`none` = 控制臂（恒不写）／`per-task` = 每题写一条。**必须显式给**（fail-closed）。 */
const WRITE = argOf('--write') ?? null
if (WRITE !== 'none' && WRITE !== 'per-task') {
  console.log('[stop] 必须显式给 --write none|per-task（不给就不跑：写侧开关不能靠默认值）')
  process.exit(2)
}
const STEPS = Number(argOf('--steps') ?? 3)
if (!Number.isInteger(STEPS) || STEPS < 1) {
  console.log(`[stop] --steps 需要 ≥1 的整数，收到 ${argOf('--steps')}`)
  process.exit(2)
}
const PEER_ARG = argOf('--peer')
const EVIDENCE = argOf('--evidence')
  ? path.resolve(argOf('--evidence'))
  : path.join(ROOT, 'evidence', `w40-mem-seq-${NAME}.json`)

/* ── ★ 载体模板：与 scripts/mem-arm.mjs **逐字相同**（两臂同模板，只让条目块不同）── */
const HEADING = `# 记忆注入（由 scripts/mem-arm.mjs 从记忆库渲染，勿手改）`
const EMPTY_NOTE = '（本题的记忆库为空：没有可注入的条目）'
const PREFACE = '以下条目来自本会话绑定的记忆库。它们可能与本任务相关；相关则纳入判断，无关则忽略。'

/**
 * ★★ L1 提示表（写进 store 的**全部内容**就是这些，按题序轮转）。
 *   逐条自检：都不点任何具体文件/行/字段/修法 ⇒ 不是 L2/L3。
 */
const L1_HEURISTICS = [
  '动手前先把题面里要求的**确切文件名与内容**逐字抄出来对齐——同名/大小写/空格/换行差异是这类任务最常见的返工源。',
  '只做被要求的那一处改动；不要顺手格式化、重命名或"优化"其它文件。',
  '做完自检一遍：目标产物确实存在、内容与要求逐字一致——"命令没报错"不等于"做对了"。',
  '别在工作目录里留临时文件或中间产物：下一题会把它们读成噪声。',
  '题面要求"只回一行"时就只回一行，不要追加解释、总结或复述。',
]

/** 本题（自造微任务族 micro-write）。 */
function taskOf(k) {
  const name = `w40-step-${k}.txt`
  const expect = `step ${k}`
  return {
    k,
    id: `w40-micro-${String(k).padStart(2, '0')}`,
    family: 'micro-write',
    targetName: name,
    targetExpect: expect,
    text:
      `本题是一个极小任务（第 ${k} 题）。请在当前工作目录下新建文件 ${name}，` +
      `其中写入一行内容：${expect}。不要改动其它任何文件。完成后只回一行：${name} done`,
  }
}

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

function ancestorsOf(p) {
  const out = []
  let cur = path.resolve(p)
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) return out
    out.push(parent)
    cur = parent
  }
}
/** ★ 真正调 memface 读 count（权威读数来源；**只读**）。 */
function faceCount(db) {
  const r = spawnSync(MEMFACE, ['count', '--db', db], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(String(r.stdout ?? '').trim().split('\n').filter(Boolean)[0] ?? 'null') } catch { /* 解析失败留 null */ }
  return { exit: r.status, stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').trim(), count: json?.count ?? null }
}
/** ★ 写侧：真正调 memface remember（与 memprompt 同一个 KnowledgeStore 的写入口）。 */
function faceRemember(db, text, kind = 'note') {
  const r = spawnSync(MEMFACE, ['remember', '--db', db, '--text', text, '--kind', kind], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(String(r.stdout ?? '').trim().split('\n').filter(Boolean)[0] ?? 'null') } catch { /* 同上 */ }
  return { exit: r.status, stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').trim(), count: json?.count ?? null }
}

/* ── 场地守卫（fail-closed；与 mem-arm.mjs / eval-wt-new.mjs 同口径）────────── */
console.log(`===== mem-seq 臂 ${NAME} =====`)
console.log(`[root  ] ${ROOT}`)
console.log(`[store ] ${STORE}`)
console.log(`[cwd   ] ${CWD}`)
console.log(`[write ] ${WRITE}`)
console.log(`[steps ] ${STEPS}`)
console.log(`[evidence] ${EVIDENCE}`)

const ANC = ancestorsOf(CWD)
const JUDGE_ROOT_IN_ANCESTORS = ANC.includes(path.resolve(REPO))
const insideJudge = (anc, p) => {
  const rel = path.relative(path.resolve(anc), path.resolve(p)).replace(/\\/g, '/')
  return rel === '' || (!rel.startsWith('../') && !path.isAbsolute(rel))
}
console.log(`[isolation] 判据根在 cwd 祖先链上 = ${JUDGE_ROOT_IN_ANCESTORS ? '**是**' : '否'}；cwd 在判据根内部 = ${insideJudge(REPO, CWD) ? '**是**' : '否'}`)
if (JUDGE_ROOT_IN_ANCESTORS || insideJudge(REPO, CWD)) {
  console.log('  ⚠ 这条臂的 cwd 在判据根内/其祖先链上 ⇒ R1 不成立（O87：要物理堵死需第三个卷或真沙箱）')
}
if (!fs.existsSync(path.join(CWD, '.git'))) {
  console.log(`[stop] ${CWD} 不是 git 工作树（缺 .git）⇒ 拒绝把注入载体写进一个非工作树的目录`)
  process.exit(2)
}
for (const exe of [MEMPROMPT, MEMFACE]) {
  if (!fs.existsSync(exe)) {
    console.log(`[stop] 找不到 ${exe}`)
    process.exit(2)
  }
}
if (PEER_ARG) {
  const peer = path.resolve(PEER_ARG)
  const volumeOf = (p) => path.parse(path.resolve(p)).root.toLowerCase()
  const volumeDiffers = volumeOf(CWD) !== volumeOf(peer)
  const relRaw = path.relative(path.resolve(CWD), peer)
  const peerInAncestors = ancestorsOf(CWD).map((a) => a.toLowerCase()).includes(peer.toLowerCase())
  const peerBase = path.basename(peer)
  const probes = []
  for (let k = 1; k <= 5; k++) {
    for (const sub of ['', 'store', 'store/knowledge_base.json', 'wt']) {
      const rel = `${'../'.repeat(k)}${peerBase}${sub ? '/' + sub : ''}`
      probes.push({ rel, exists: fs.existsSync(path.resolve(CWD, rel)) })
    }
  }
  const reachable = probes.filter((p) => p.exists)
  const peerExists = fs.existsSync(peer)
  const ok = peerExists && volumeDiffers && !peerInAncestors && reachable.length === 0
  console.log(`[peer  ] ${peer}   存在=${peerExists}   卷：本臂 ${volumeOf(CWD)} vs 另一臂 ${volumeOf(peer)} ⇒ ${volumeDiffers ? '不同卷（相对路径跨不过去）' : '**同卷**（`..` 无界 ⇒ 长回旋可达）'}`)
  console.log(`[peer  ] path.relative(本臂 cwd → 另一臂) = ${relRaw.replace(/\\/g, '/')}${path.isAbsolute(relRaw) ? '   ★ 回落成绝对路径 = 相对路径表达不出这条路' : '   ★ 是相对路径 ⇒ 可达'}`)
  console.log(`[peer  ] 另一臂在本臂祖先链上？ ${peerInAncestors ? '**是**' : '否'}；长回旋相对路径实探：可达 ${reachable.length}/${probes.length}${reachable.length ? `（${reachable.map((p) => p.rel).join(' , ')}）` : ''}`)
  if (!ok && !has('--allow-peer-visible')) {
    console.log('')
    console.log('[stop] ★★ 本臂**够得到**另一臂 ⇒ 这不是两臂，自变量泄漏 ⇒ **拒跑**（不起会话、不写载体）')
    console.log('       明知故犯（只在复现实验里用）：--allow-peer-visible')
    process.exit(2)
  }
  console.log(`[peer  ] ⇒ ${ok ? '★ 两臂互不可见（含长回旋）✓' : '▲ 已用 --allow-peer-visible 放行（读数**不可解释**）'}`)
}

/* ── 基线读数（跑之前）──────────────────────────────────────── */
const countBefore = faceCount(STORE)
console.log(`[baseline] ${MEMFACE} count --db ${STORE} ⇒ ${JSON.stringify(countBefore.stdout)}  (exit=${countBefore.exit})`)

/* ── 主循环 ─────────────────────────────────────────────────── */
const steps = []
const t0All = Date.now()

for (let k = 1; k <= STEPS; k++) {
  const task = taskOf(k)
  console.log('')
  console.log('─'.repeat(88))
  console.log(`── 第 ${k}/${STEPS} 题  [${task.id}]  write=${WRITE}`)
  console.log('─'.repeat(88))

  // ① 渲染（注入内容 = 【此刻】store 的全部）
  const rm = spawnSync(MEMPROMPT, ['render', '--db', STORE], { encoding: 'utf8' })
  if (rm.status !== 0) {
    console.log(`[stop] memprompt render 失败 exit=${rm.status} stderr=${String(rm.stderr ?? '').trim()}`)
    process.exit(2)
  }
  const rendered = JSON.parse(String(rm.stdout ?? '').trim())
  const renderedLines = String(rendered.text ?? '').split('\n').filter((l) => l.trim() !== '')
  console.log(`[render] count=${rendered.count} items=${rendered.items} bytes=${rendered.bytes} lines=${renderedLines.length}`)

  // ② 落载体
  const memBlock = rendered.items > 0 ? rendered.text : EMPTY_NOTE
  const carrier = `${HEADING}\n\n${PREFACE}\n\n${memBlock}\n`
  const carrierPath = path.join(CWD, 'AGENTS.md')
  fs.writeFileSync(carrierPath, carrier, 'utf8')
  const carrierRaw = fs.readFileSync(carrierPath)
  console.log(`[carrier] bytes=${carrierRaw.length} sha256=${sha256(carrierRaw.toString('utf8')).slice(0, 16)} BOM=${carrierRaw[0] === 0xef && carrierRaw[1] === 0xbb && carrierRaw[2] === 0xbf}`)

  // ③ 起会话（永远新建）
  const winCwd = CWD.replace(/\//g, '\\')
  const c = await rpc('session.create', { cwd: winCwd, agentPreset: 'council' })
  const sid = valOf(c)?.sessionId
  if (!sid) {
    console.log(`[stop] 没拿到 sessionId：status=${c.status} err=${JSON.stringify(errOf(c))}`)
    process.exit(2)
  }
  console.log(`[create] sessionId=${sid} preset=${valOf(c)?.agentPreset}`)
  const tCreate = Date.now()
  while (Date.now() - tCreate < 60000) {
    const lr = await rpc('session.list', {})
    const s = valOf(lr)?.items?.find((x) => x.sessionId === sid)
    if (s && !s.running) break
    await sleep(1000)
  }
  await sleep(1000)

  // ④ 发题
  const baselineTurns = (await rpc('session.list', {})).json?.result?.value?.items?.find((x) => x.sessionId === sid)
    ?.projections?.values?.sessionStats?.turns ?? 0
  const pr = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: task.text }] })
  console.log(`[prompt] status=${pr.status} accepted=${valOf(pr)?.accepted} err=${JSON.stringify(errOf(pr))}`)

  // ⑤ 等空闲
  const tStep = Date.now()
  let last = null
  while (Date.now() - tStep < MAX_STEP_MS) {
    const lr = await rpc('session.list', {})
    const s = valOf(lr)?.items?.find((x) => x.sessionId === sid)
    if (s) {
      const st = s.projections?.values?.sessionStats ?? {}
      last = { running: !!s.running, turns: st.turns ?? 0, steps: st.steps ?? 0, toolMs: st.toolMs ?? null, llmMs: st.llmMs ?? null }
      if (!last.running && last.turns >= baselineTurns + 1) break
    }
    await sleep(2000)
  }
  const waitedMs = Date.now() - tStep
  console.log(`[wait] ${JSON.stringify({ ...last, waitedMs })}`)
  await sleep(2000)

  // ⑥ 取证
  const loc = findSessionFile(sid)
  if (!loc) { console.log('[stop] 找不到会话日志'); process.exit(2) }
  const evs = readEvents(loc.file)
  const typeHist = {}
  for (const e of evs) typeHist[e.type] = (typeHist[e.type] ?? 0) + 1
  const hdrs = evs.filter((e) => e.type === 'request/header')
  const firstHdr = hdrs[0]?.data?.header ?? null
  const names = Array.isArray(firstHdr?.tools) ? [...new Set(firstHdr.tools.map(toolNameOf))].sort() : []
  const namesHash = names.length ? sha8(names.join('\n')) : '-'
  const systemLen = typeof firstHdr?.system === 'string' ? firstHdr.system.length : null
  console.log(`[header] 请求数=${hdrs.length} system长度=${systemLen} 工具数=${names.length} namesHash=${namesHash}`)

  const instrMsg = evs.find((e) => e.type === 'user/message' && (e.data?.source?.kind === 'agent-instructions'))
  const instrText = instrMsg ? textOf(instrMsg.data?.content ?? instrMsg.data?.message?.content ?? instrMsg.data) : ''
  // ★★ 「注入 = 当时 store 的全部」机器判定
  const missingLines = renderedLines.filter((l) => !instrText.includes(l))
  const markerCount = (instrText.match(/^- \[/gm) ?? []).length
  const injectOk = !!instrMsg && missingLines.length === 0 && markerCount === rendered.items
  console.log(`[inject] 找到=${!!instrMsg} 文本长度=${instrText.length} 逐行齐全=${missingLines.length === 0} 条目行数=${markerCount}(应=${rendered.items}) ⇒ ${injectOk ? '注入=当时store全部 ✓' : '✗'}`)

  const assistantTexts = []
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const d = e.data ?? {}
    const t = textOf(d.content ?? d.message?.content ?? d.message ?? d)
    if (t.trim()) assistantTexts.push({ seq: e.seq, turn: d.turn, step: d.step, text: t })
  }
  const toolEventCount = evs.filter((e) => /tool/i.test(String(e.type ?? ''))).length
  /** ★ 精确口径：`tool/call` 事件数 = 本题真正发起的工具调用次数（`toolEventCount` 是粗口径，含 chunks 事件）。 */
  const toolCallCount = typeHist['tool/call'] ?? 0
  console.log(`[assistant] ${assistantTexts.length} 条；tool/call=${toolCallCount} 条（粗口径 /tool/i=${toolEventCount} 条）`)

  // 本题 oracle-lite：目标文件是否真的生成
  const targetPath = path.join(CWD, task.targetName)
  const targetExists = fs.existsSync(targetPath)
  const targetContent = targetExists ? fs.readFileSync(targetPath, 'utf8') : null
  const targetOk = targetExists && String(targetContent).trim() === task.targetExpect
  console.log(`[target] ${task.targetName} 存在=${targetExists} 内容逐字符合=${targetOk}`)

  // ⑦ ★★ 写侧（只有 per-task）
  const expText =
    `【第${k}题·同族经验】族=${task.family}；本题观测：工具相关事件 ${toolEventCount} 条，目标完成=${targetOk ? '是' : '否'}。` +
    `族级做法（L1）：${L1_HEURISTICS[(k - 1) % L1_HEURISTICS.length]}`
  let write = null
  if (WRITE === 'per-task') {
    const w = faceRemember(STORE, expText, 'note')
    write = { text: expText, level: 'L1', exit: w.exit, stdout: w.stdout, stderr: w.stderr, count: w.count }
    console.log(`[write ] memface remember exit=${w.exit} count=${w.count}`)
    console.log(`[write ] 写入内容（L1）: ${expText}`)
    if (w.exit !== 0) { console.log('[stop] 写侧失败'); process.exit(2) }
  } else {
    console.log('[write ] --write none ⇒ 控制臂：本题**不写**（store 应恒为基线值）')
  }

  // ⑧ 写在之后的权威 count
  const countAfter = faceCount(STORE)
  console.log(`[count ] 第 ${k} 题后 count=${countAfter.count}（注入时 count=${rendered.count}）`)

  steps.push({
    k,
    task,
    rendered: { count: rendered.count, items: rendered.items, bytes: rendered.bytes, lines: renderedLines, text: rendered.text },
    carrier: { path: carrierPath, bytes: carrierRaw.length, sha256: sha256(carrierRaw.toString('utf8')), hasBom: carrierRaw[0] === 0xef && carrierRaw[1] === 0xbb && carrierRaw[2] === 0xbf },
    sessionId: sid,
    sessionLog: loc.file,
    baselineTurns,
    waitedMs,
    stats: last,
    requestHeader: { count: hdrs.length, systemLen, toolCount: names.length, namesHash, toolNames: names },
    injected: { found: !!instrMsg, seq: instrMsg?.seq ?? null, textLen: instrText.length, sha256: instrText ? sha256(instrText) : null, missingLines, markerCount, ok: injectOk, text: instrText },
    eventTypes: typeHist,
    toolCallCount,
    toolResultCount: typeHist['tool/result'] ?? 0,
    toolEventCount,
    assistantTexts,
    target: { path: targetPath, name: task.targetName, exists: targetExists, content: targetContent, expect: task.targetExpect, ok: targetOk },
    write,
    countAtInject: rendered.count,
    countAfterWrite: countAfter.count,
    countRaw: { before: countBefore.stdout, after: countAfter.stdout },
  })
}

const countFinal = faceCount(STORE)
console.log('')
console.log('='.repeat(88))
console.log(`序列读数（权威来源 = ${MEMFACE} count --db ${STORE}）`)
console.log(`  跑前 count = ${countBefore.count}`)
for (const s of steps) console.log(`  第 ${s.k} 题：注入时 count=${s.countAtInject}；题后 count=${s.countAfterWrite}；${WRITE === 'per-task' ? `写[${s.write.level}]「${s.write.text}」` : '本题不写'}`)
console.log(`  跑后 count = ${countFinal.count}`)
const seqAfter = steps.map((s) => s.countAfterWrite)
const strictInc = seqAfter.every((n, i) => i === 0 || n > seqAfter[i - 1])
console.log(`  题后序列 = [${seqAfter.join(',')}] ⇒ 严格递增=${strictInc ? '是' : '否'}；末项>0=${seqAfter[seqAfter.length - 1] > 0 ? '是' : '否'}`)
const faces = steps.map((s) => ({ k: s.k, toolCount: s.requestHeader.toolCount, namesHash: s.requestHeader.namesHash, sysLen: s.requestHeader.systemLen }))
console.log(`  两臂以外的脸读数（本臂各步）：${JSON.stringify(faces)}`)
console.log('='.repeat(88))

const evidence = {
  script: 'scripts/mem-seq.mjs',
  arm: NAME,
  write: WRITE,
  at: new Date().toISOString(),
  elapsedMs: Date.now() - t0All,
  root: ROOT,
  store: STORE,
  cwd: CWD,
  ancestors: ANC,
  judgeRootInAncestors: JUDGE_ROOT_IN_ANCESTORS,
  insideJudgeRoot: insideJudge(REPO, CWD),
  peer: PEER_ARG ?? null,
  front: FRONT,
  memprompt: MEMPROMPT,
  memface: MEMFACE,
  l1Heuristics: L1_HEURISTICS,
  countBaseline: { raw: countBefore.stdout, count: countBefore.count },
  countFinal: { raw: countFinal.stdout, count: countFinal.count },
  sequenceAfterWrite: seqAfter,
  strictlyIncreasing: strictInc,
  steps,
}
fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true })
fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log(`evidence=${EVIDENCE}`)
