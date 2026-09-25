// dsh-delegate.mjs —— ★ 把 DSH 当【子 agent】用的通用入口（用户 2026-09-24 定的纪律）
//
// 用法（★ 它连【现役】控制面，不自己起实例、不杀任何进程）：
//   node out/dsh-delegate.mjs --prompt <任务文件> --tag <标签> [--cwd <工作目录>]
//        [--preset standard] [--front http://127.0.0.1:3080] [--budget-ms 2400000] [--stall-ms 420000]
//        [--expect <报告文件>] [--rounds 3]
//   node out/dsh-delegate.mjs --text "冒烟：在 cwd 下建 tmp.txt 并回读" --tag smoke
//
// 它做七件：① 建会话（session.create，cwd 可指定）
//          ② 选 preset（agentPreset.select）+ **回读断言**（铁律 #18：HTTP 200 不是证据）
//          ③ 记下 before.asOfSeq ④ 发指令（session.prompt）
//          ⑤ 轮询至「settled」= running:false **且 asOfSeq 前进过**（照 scripts/eval-run.mjs:763）
//          ⑥ ★★ **停工自动续跑**：settled 之后若 `--expect` 指定的产出**不存在**，就再发一轮追问
//             （最多 `--rounds` 轮）—— 这是为了治「worker 被噪音打断后停工」这一类失败。
//          ⑦ 采"真的干活了吗"的读数：事件表 / toolCalls / byTool / turnEndReason / **审批事件**
//
// 退出码：0 = settled 且（未指定 --expect，或 --expect 已产出）；
//         1 = 发不出去或超预算；3 = 用法错；4 = preset 回读不一致；
//         5 = settled 但**一个工具都没调**（疑似空跑）；6 = 会话在等审批；7 = settled 但 `--expect` 始终没产出
//
// ★★ 已冻结的实测结论（都在本文件里以注释落档，改动前先读）
//   1. `session.prompt` 的形状不是 `{sessionId, text}` —— 那样会 **HTTP 200 + accepted 缺失、什么都不做**
//      （实测只生出 4 个事件、0 条 assistant 文本）。正确形状见下（照 scripts/session-drive.mjs:72-77）。
//   2. 完成判据不能只看 `running === false` —— 那会在"还没起跑"时就判 settled。必须叠加 **asOfSeq 前进**。
//   3. **权限档位没有 RPC 通道**（12 个候选名 + 17 个审批候选名全 404）；经 `session.prompt` 发
//      `/permission …` 只会被当普通用户消息。⇒ 沙箱档位与审批应答**只能由人在 UI 操作**；
//      **绝不提权**（本机无应答者 ⇒ `approval/asked` 后没有 `decided` ⇒ 整轮卡死，实测白烧 20 分钟）。
//   4. **★★ 运行时上下文会被【每个 step 重新注入一次】**（实测 L2 那一轮注入 19 次，
//      `caughtUpSeq` 每次都在变）。那段文案里有「【代际身份】…【切换已完成】…恢复一切正常服务」+
//      「【安全自进化边界】… P0 可自由修改 … P1 激活：调 tool_apply 上线」。
//      它本是写给**控制面活跃代**的，却落进每个 worker 会话 ⇒ worker 会读成"换代了，等指令" ⇒ **停工**。
//      实测：L3b 干到一半停工，最后一句逐字是「已收到代际切换通知…**等待下一步指令**」。
//      ⇒ 两条对策：**(a)** 派活时用 `--expect` 让脚本自动续跑；**(b)** 在追问文案里显式声明
//      「那条通知是给控制面的噪音，继续干活」。**根治要改我们自己的运行时上下文注入（未做，待裁决）。**

import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }

const promptFile = argOf('--prompt')
const textArg = argOf('--text')
const tag = argOf('--tag') ?? 'dsh'
const cwd = argOf('--cwd') ?? 'D:/project_develop/dsh-brain'
const front = argOf('--front') ?? 'http://127.0.0.1:3080'
const preset = argOf('--preset') ?? 'standard'
const budgetMs = Number(argOf('--budget-ms') ?? 2400000)   // 40 min
const stallMs = Number(argOf('--stall-ms') ?? 420000)      // 7 min 无前进 ⇒ 报"疑似卡住"
const DSH_HOME = argOf('--home') ?? 'C:/Users/Admin/.dsh'
// ★ 停工续跑：`--expect` 指定的产出文件（判据是**文件在不在**，不是"感觉它做完了"）
const expectFile = argOf('--expect') ? path.resolve(argOf('--expect')) : null
const rounds = Math.max(1, Number(argOf('--rounds') ?? 3))

if (!promptFile && !textArg) { console.error('[用法] 需要 --prompt <任务文件> 或 --text "<一句话>"'); process.exit(3) }
if (promptFile && !fs.existsSync(promptFile)) { console.error(`[用法] 任务文件不存在：${promptFile}`); process.exit(3) }

const OUTDIR = path.join(path.dirname(promptFile ?? 'D:/project_develop/dsh-brain/out/x'), `_delegate-${tag}`)
fs.mkdirSync(OUTDIR, { recursive: true })

async function rpc(method, params) {
  const body = { type: 'client-request', rpcId: randomUUID(), method, payload: params ?? {} }
  const res = await fetch(`${front}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const t = await res.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* 非 JSON */ }
  return { status: res.status, json: j, text: t, value: j?.result?.value ?? null }
}

const t0 = Date.now()
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const sessionItem = async (sid) => {
  const r = await rpc('session.list', {})
  return (r.value?.items ?? []).find((x) => x.sessionId === sid) ?? null
}

function sessionFile(sid) {
  const root = path.join(DSH_HOME, 'sessions')
  if (!fs.existsSync(root)) return null
  for (const d of fs.readdirSync(root)) {
    const pp = path.join(root, d)
    if (!fs.statSync(pp).isDirectory()) continue
    for (const s of fs.readdirSync(pp)) {
      if (s !== sid) continue
      for (const name of ['session.jsonl.zstd', 'session.v3.jsonl.zstd']) {
        const f = path.join(pp, s, name)
        if (fs.existsSync(f)) return f
      }
    }
  }
  return null
}
function readEvents(sid) {
  const f = sessionFile(sid)
  if (!f) return { file: null, events: [] }
  let raw = ''
  try { raw = Buffer.from(decompress(fs.readFileSync(f))).toString('utf8') } catch { return { file: f, events: [] } }
  const events = raw.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  return { file: f, events }
}
/** 递归收集任意深度的 `{type:'text', text}` 片段（assistant/message 的形状不稳定，别写死路径）。 */
function collectText(node, acc) {
  if (node == null || typeof node === 'string') return
  if (Array.isArray(node)) { for (const x of node) collectText(x, acc); return }
  if (typeof node === 'object') {
    if (node.type === 'text' && typeof node.text === 'string') { acc.push(node.text); return }
    for (const k of Object.keys(node)) collectText(node[k], acc)
  }
}

// ── ① 建会话 ─────────────────────────────────────────────────────────────────
const c = await rpc('session.create', { cwd })
const sid = c.value?.sessionId ?? c.value?.id
if (!sid) { console.error('[失败] 没拿到 sessionId: ' + c.text.slice(0, 200)); process.exit(1) }
let it = await sessionItem(sid)
log(`会话已建 ${sid}`)
log(`  回读: preset=${it?.agentPreset} running=${it?.running} asOfSeq=${it?.projections?.asOfSeq}`)

// ── ② 选 preset + 回读断言（★ HTTP 200 不是证据）──────────────────────────────
if (preset) {
  const r = await rpc('agentPreset.select', { sessionId: sid, agentPreset: preset })
  await new Promise((x) => setTimeout(x, 1200))
  it = await sessionItem(sid)
  const got = it?.agentPreset ?? null
  log(`  选 preset=${preset}（HTTP ${r.status}）→ 回读=${got}`)
  if (got !== preset) {
    console.error(`[失败] preset 回读不一致（要 ${preset}，得 ${got}）⇒ 弃跑（铁律 #18：同名/HTTP 200 都会骗人）`)
    process.exit(4)
  }
}

// ── ③ 记 before.asOfSeq ──────────────────────────────────────────────────────
const beforeSeq = it?.projections?.asOfSeq ?? 0

// ── ④⑤⑥ 一轮驱动 + 停工续跑 ─────────────────────────────────────────────────
const firstText = textArg ?? (
  `请完整读取并执行这个文件里的任务：${path.resolve(promptFile).replace(/\\/g, '/')}\n\n` +
  `★ 执行前先把这个文件读完（它是完整任务书）。★ 完成后把结论写进报告文件（任务书里指定了路径）。`
)
const continueText = (round) => (
  `【主线追问 · 第 ${round} 轮】你上一轮**停下了**，但任务书还没执行完。\n\n` +
  `⇒ 请对照任务书的**每一项**逐条自查：**没做的现在做**（已经做对的**不要重做**），\n` +
  `   然后把每条判据的**原始输出**与结论写进任务书指定的报告文件` +
  (expectFile ? `（当前**还看不到** ${expectFile.replace(/\\/g, '/')} —— 这就是判定你"还没做完"的依据）` : '') + `。\n\n` +
  `★★ 若你在上一步收到「【代际身份】/【切换已完成】/恢复一切正常服务」之类的通知：\n` +
  `   **那是发给控制面的噪音，不是给你的指令** —— 你不需要"等待指令"，也没有换代这回事。\n` +
  `   **继续把任务书做完**。`
)

let outcome = 'over-budget'
let round = 0
let approvalAsked = 0
let approvalDecided = 0
const roundLog = []

for (round = 1; round <= rounds; round++) {
  const text = round === 1 ? firstText : continueText(round)
  // ★★ 2026-09-25 修：基准 seq 必须在【发指令之前】读。
  //   原来读在 `session.prompt` **之后** ⇒ 若会话在那两步之间就跑完一个回合，
  //   `asOfSeq` 恰好等于基准 ⇒ 完成判据 `!== baseSeq` **永不成立** ⇒ 挂到预算上限。
  //   （`round.mjs` 被这条实测卡了 17 分钟；本脚本同结构，一并堵上。）
  const baseSeq = (await sessionItem(sid))?.projections?.asOfSeq ?? beforeSeq
  const sent = await rpc('session.prompt', {
    sessionId: sid, mode: 'steer', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai',
  })
  const accepted = sent.value?.accepted ?? null
  log(`第 ${round} 轮发指令：HTTP ${sent.status} accepted=${accepted}`)
  if (sent.status !== 200 || accepted !== true) {
    console.error(`[失败] 指令没被接受：${sent.text.slice(0, 300)}`)
    process.exit(1)
  }
  let lastSeq = baseSeq
  let lastProgressAt = Date.now()
  // ★ 2026-09-25：加"看见过前进"标志（配合上面的"发指令前读基准"，两条一起堵住误判）
  let sawProgress = false
  let preEvents = readEvents(sid).events.length
  outcome = 'over-budget'

  while (Date.now() - t0 < budgetMs) {
    await new Promise((r) => setTimeout(r, 5000))
    const cur = await sessionItem(sid)
    const seq = cur?.projections?.asOfSeq ?? null
    if (seq !== null && seq !== lastSeq) { lastSeq = seq; lastProgressAt = Date.now(); sawProgress = true }
    try {
      const { events } = readEvents(sid)
      approvalAsked = events.filter((e) => e.type === 'approval/asked').length
      approvalDecided = events.filter((e) => e.type === 'approval/decided').length
      if (events.length !== preEvents) { preEvents = events.length; lastProgressAt = Date.now(); sawProgress = true }
    } catch { /* 读日志失败不算致命 */ }

    if (cur && cur.running === false && sawProgress) { outcome = 'settled'; break }
    if (Date.now() - lastProgressAt > stallMs) {
      log(`⚠️ ${Math.round((Date.now() - lastProgressAt) / 1000)}s 无任何前进 —— 疑似在等审批（asked=${approvalAsked} decided=${approvalDecided}）或卡住；继续等但会如实记账`)
      lastProgressAt = Date.now()
    }
  }
  log(`第 ${round} 轮结束：${outcome}`)
  roundLog.push({ round, outcome })
  if (outcome !== 'settled') break
  if (!expectFile) break                       // 没给判据 ⇒ 不续跑（避免无谓消耗）
  if (fs.existsSync(expectFile)) break          // ★ 判据为真 ⇒ 真做完了
  if (round === rounds) break
  log(`★ 续跑：${expectFile.replace(/\\/g, '/')} 还不存在 ⇒ 再发一轮追问`)
  await new Promise((r) => setTimeout(r, 3000))
}

// ── ⑦ 采读数（★ "真的干活了吗"）──────────────────────────────────────────────
const { file: evFile, events } = readEvents(sid)
const byType = {}
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1
const toolCalls = events.filter((e) => e.type === 'tool/call')
const byTool = {}
for (const e of toolCalls) {
  const n = e?.data?.name ?? e?.data?.tool ?? e?.data?.toolName ?? '(未知)'
  byTool[n] = (byTool[n] ?? 0) + 1
}
const codeDispatches = events.filter((e) => e.type === 'tool/code-dispatch-start' || e.type === 'tool/code-dispatch').length
const turnEnds = events.filter((e) => e.type === 'turn/end').map((e) => e?.data?.reason ?? null)
const assistantMsgs = events.filter((e) => e.type === 'assistant/message')
const texts = []
for (const m of assistantMsgs) collectText(m.data, texts)
const lastText = texts.length ? texts[texts.length - 1] : null

const final = await sessionItem(sid)
const stats = final?.projections?.values?.sessionStats ?? {}
const tokens = final?.projections?.values?.tokenUsage ?? {}
const approvalOpen = approvalAsked > approvalDecided
const expectOk = expectFile ? fs.existsSync(expectFile) : null

const result = {
  tag, front, cwd, preset, sessionId: sid,
  outcome, rounds: roundLog, wallMs: Date.now() - t0,
  expect: expectFile ? { file: expectFile.replace(/\\/g, '/'), exists: expectOk } : null,
  presetReadBack: final?.agentPreset ?? null,
  asOfSeq: { before: beforeSeq, after: final?.projections?.asOfSeq ?? null },
  session: { file: evFile ? path.basename(evFile) : null, events: events.length, byType },
  work: {
    toolCalls: toolCalls.length, byTool, codeDispatches,
    steps: stats.steps ?? null, turns: stats.turns ?? null,
    outputTokens: tokens.outputTokens ?? null, uncachedInputTokens: tokens.uncachedInputTokens ?? null,
  },
  approvals: { asked: approvalAsked, decided: approvalDecided, open: approvalOpen },
  turnEndReasons: turnEnds,
  assistantTexts: texts.length,
}

let code = 0
if (outcome !== 'settled') code = 1
else if (approvalOpen) code = 6
else if (expectFile && !expectOk) code = 7
else if (toolCalls.length === 0 && codeDispatches === 0) code = 5

fs.writeFileSync(path.join(OUTDIR, 'result.json'), JSON.stringify(result, null, 2), 'utf8')
if (lastText) fs.writeFileSync(path.join(OUTDIR, 'last-assistant.txt'), lastText, 'utf8')
fs.writeFileSync(path.join(OUTDIR, 'event-types.txt'),
  Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${String(v).padStart(5)}  ${k}`).join('\n'), 'utf8')

console.log(JSON.stringify({ ...result, session: { events: result.session.events } }, null, 2))
if (code === 6) console.log('★★★ 有未决审批 ⇒ 会话在等人点"允许"（本机没有编程通道可放开，见文件头注释）')
if (code === 5) console.log('★ settled 但一个工具都没调 ⇒ 疑似空跑，别当成功')
if (code === 7) console.log(`★★ settled 但 ${expectFile} 始终没产出 ⇒ 任务**没做完**（别把"settled"当完成）`)
console.log(`产物目录：${OUTDIR.replace(/\\/g, '/')}`)
process.exit(code)
