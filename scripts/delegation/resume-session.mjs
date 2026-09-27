// resume-session.mjs —— ★ 续跑一个**已存在**的 DSH 会话（dsh-delegate.mjs 只能新建，不能续跑）。
//
// 用法：
//   node scripts/delegation/resume-session.mjs --session <sid> --prompt <任务文件>
//        [--front http://127.0.0.1:3080] [--home C:/Users/Admin/.dsh]
//        [--budget-ms 2400000] [--stall-ms 420000]
//
// ## 为什么需要它（实测记录，2026-09-27）
//
// `dsh-delegate.mjs` 的 settled 判据是 `cur.running === false && sawProgress`。
// 但实测发现：**会话已经停工、代理进程已退出之后，`session.list` 里的 `running` 仍可能是 `true`**
// （陈旧标志）⇒ settled **永不成立** ⇒ 脚本**白等到预算上限**，把一次成功的委派报成 `outcome:"over-budget"`。
// ★ 证据：`out/_tasks/_delegate-seat-contract-md/result.json` 报 `over-budget`（墙钟 2404s），
//   但同一时刻 `Get-CimInstance Win32_Process` 里**没有任何** delegate/node 进程在跑那个任务
//   ⇒ "running:true" 与"真的有进程"矛盾 ⇒ **以进程为准**。
//
// ⇒ 本脚本的 settled 判据**不依赖 `running`**，改为**双通道**（铁律 13/32）：
//   ① 事件数不再增长（读会话日志，与 running 无关）
//   ② 且**静默超过 `--stall-ms`**
//   `running` 只作为**辅助读数**照实打出来，**不参与判定**（"读数拿不到/不可信"不得当正判据）。
//
// ## 复用而非重写（铁律 26：协议形状照同族现成脚本抄）
//   `session.prompt` = `{sessionId, mode:'steer'|'queue', content:[{type:'text',text}], clientTimeZone}`

import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }

const sid = argOf('--session')
const promptFile = argOf('--prompt')
const front = argOf('--front') ?? 'http://127.0.0.1:3080'
const DSH_HOME = argOf('--home') ?? 'C:/Users/Admin/.dsh'
const cwd = argOf('--cwd') ?? 'D:/project_develop/dsh-brain'
const budgetMs = Number(argOf('--budget-ms') ?? 2_400_000)
const stallMs = Number(argOf('--stall-ms') ?? 300_000)

if (!sid || !promptFile) { console.error('用法：--session <sid> --prompt <文件>'); process.exit(3) }
if (!fs.existsSync(promptFile)) { console.error(`[失败] 任务文件不存在：${promptFile}`); process.exit(3) }
const text = fs.readFileSync(promptFile, 'utf8')

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`)

let rpcN = 0
async function rpc(method, payload) {
  rpcN++
  const r = await fetch(`${front}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `resume-${rpcN}-${Date.now()}`, method, payload }),
  })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, value: j?.result?.value ?? null, text: JSON.stringify(j).slice(0, 400) }
}

/** 定位本会话的日志文件（按 cwd 归目录，同 dsh-delegate 的做法）。 */
function sessionFile(s) {
  const dirKey = '--' + String(cwd).replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9\-_]/g, '~0020') + '--'
  const cand = path.join(DSH_HOME, 'sessions', dirKey, s, 'session.jsonl.zstd')
  if (fs.existsSync(cand)) return cand
  // 兜底：扫一遍
  const root = path.join(DSH_HOME, 'sessions')
  if (!fs.existsSync(root)) return null
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, s, 'session.jsonl.zstd')
    if (fs.existsSync(p)) return p
  }
  return null
}

function eventCount(s) {
  const f = sessionFile(s)
  if (!f) return null
  try {
    const raw = fs.readFileSync(f)
    const jsonl = decompress(new Uint8Array(raw)).toString('utf8')
    return jsonl.split('\n').filter((l) => l.trim()).length
  } catch { return null }
}

// ── ① 发指令前的读数 ────────────────────────────────────────────────────────
const before = await rpc('session.list', {})
const item = (before.value?.items ?? []).find((x) => x.sessionId === sid)
if (!item) { console.error(`[失败] 找不到会话 ${sid}（现役库 ${DSH_HOME}）`); process.exit(3) }
const evBefore = eventCount(sid)
log(`会话 ${sid}`)
log(`  发指令前：running=${item.running}  事件数=${evBefore ?? '(读不到)'}  cwd=${item.cwd}`)
if (evBefore === null) {
  console.error('[失败] 事件日志读不到 ⇒ 库指错了？（铁律 12：不许把"看不到"当 0）')
  process.exit(3)
}

// ── ② 发指令 ────────────────────────────────────────────────────────────────
const sent = await rpc('session.prompt', {
  sessionId: sid, mode: 'steer', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai',
})
const accepted = sent.value?.accepted ?? null
log(`发指令：HTTP ${sent.status} accepted=${accepted}`)
if (sent.status !== 200 || accepted !== true) {
  console.error(`[失败] 指令没被接受：${sent.text}`)
  process.exit(1)
}

// ── ③ 轮询：★ 判据只看"事件数增长"，不看 running ──────────────────────────────
const t0 = Date.now()
let last = evBefore
let lastProgressAt = Date.now()
let sawGrowth = false
let outcome = 'over-budget'

while (Date.now() - t0 < budgetMs) {
  await new Promise((r) => setTimeout(r, 5000))
  const n = eventCount(sid)
  if (n !== null && n !== last) {
    log(`  事件 ${last} → ${n}（+${n - last}）`)
    last = n; lastProgressAt = Date.now(); sawGrowth = true
  }
  // ★ settled = 有过增长 且 静默超过 stallMs。**不读 running**。
  if (sawGrowth && Date.now() - lastProgressAt > stallMs) {
    outcome = 'settled'
    break
  }
}

const after = await rpc('session.list', {})
const item2 = (after.value?.items ?? []).find((x) => x.sessionId === sid)
const evAfter = eventCount(sid)
log(`结束：outcome=${outcome}  墙钟=${Math.round((Date.now() - t0) / 1000)}s`)
log(`  发指令后：running=${item2?.running}  事件数=${evAfter}  （增长 ${evAfter - evBefore}）`)
log(`  ★ 注意：running 只是辅助读数，不参与判定（本机实测会陈旧为 true）`)
process.exit(outcome === 'settled' ? 0 : 1)
