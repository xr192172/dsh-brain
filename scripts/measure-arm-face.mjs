#!/usr/bin/env node
/**
 * measure-arm-face.mjs —— **臂面量尺**：一步量出某个 (profile × preset) 组合的
 * **系统提示面 + 工具面**，并留下可复查的指纹。
 *
 * ## 为什么需要它（现有工具各缺一半）
 *
 *   · `scripts/arm-probe.mjs` —— 只管 **profile 换代**，不会选 preset；它探到的是
 *     当前代**默认 preset** 的面，量不出 "(profile × preset)" 这个组合。
 *   · `scripts/eval-run.mjs` —— 有面读数（`analyzeTrajectory().metrics`）与 preset 选择回读，
 *     但那套逻辑**埋在跑批里**（要 `--task` 才能走），做不了"只量面、不跑题"。
 *   ⇒ 本脚本把这两半拼起来：**换代(抄 arm-probe) → 建会话 → 选 preset(抄 eval-run 的信封) →
 *     回读校验(抄 eval-run 的 sessionStats) → 发一句话 → 读面(抄 eval-run 的 --traj)**。
 *
 * ## 两条纪律（本项目踩过，写在这里防复发）
 *
 *   ① **回读才算数**：`agentPreset.select` **用错字段会 HTTP 200 但静默不生效**
 *      （见 `eval-run.mjs:1426`）⇒ 必须再 `session.list` 取 `items[].agentPreset` 做断言。
 *   ② **回读成功 ≠ 生效的是你以为的那份**：随附只读 preset 与我们自建的**同 id 会被静默遮蔽**
 *      （详见 `make-g0-preset.mjs` 头注释）⇒ 所以本脚本除了回读**还打印 `toolSetSize` +
 *      工具名**，让人能用**指纹**（"没装成别人的那份"）来判，而不是靠名字。
 *
 * ## 用法
 *
 *   node scripts/measure-arm-face.mjs --profile exp-base-nodc --preset g0
 *   node scripts/measure-arm-face.mjs --profile exp-base --preset g0 --expectToolCount 77
 *   node scripts/measure-arm-face.mjs --preset g0                 # 不换代，只量当前代
 *   node scripts/measure-arm-face.mjs --prompt '只回一个字：好'      # 改发的话
 *   node scripts/measure-arm-face.mjs --waitToolResult            # ★ 等到工具结果落盘，并逐条判成败
 *
 * ## 行为
 *
 *   1. `--profile` 给了 ⇒ **换代**（`?cmd=handover&profile=`）并轮询 `?cmd=status` 到 `stage==='idle'`。
 *   2. `node scripts/session-create.mjs` 建**空会话**（末行是 sid）。
 *   3. `POST /api/agentPreset.select` 选 preset，再 `POST /api/session.list` **回读**断言。
 *   4. `node scripts/session-drive.mjs prompt <sid> '<话>'` 发一句（默认 `只回一个字：好`）。
 *   5. `node scripts/eval-run.mjs --traj <sid>` 读面，**未落盘则轮询**（15 次 × 2s）。
 *   6. 打印一行摘要 + 一段 JSON（`profile/gen/preset/presetReadback/systemChars/toolSetSize/tools`）。
 *   7. `--expectToolCount <n>` 不符 ⇒ **退出码非 0**（并原样打印实际值）。
 *   8. **收尾：把栈留在 `web`**（换过代就切回并等到 idle），并确认前门 200。
 *
 * `--waitToolResult` 用 `scripts/lib-tool-failure.mjs` 的**结构判据**判工具成败
 * （❌ 不能看 `isError`：实测 shell 工具的失败**从不**标 `isError=true`，会假绿）。
 *
 * 前置：控制面可达（`DSH_CTRL` 默认 http://127.0.0.1:31800，必须 `stage=idle` 才能换代）；
 *       前门可达（`DSH_FRONT` 默认 http://127.0.0.1:3080）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { decompress as decompressZstd } from 'fzstd'
import { isToolFailure, resultTextOf, SESSION_ROOT } from './lib-tool-failure.mjs'

const CTRL = process.env.DSH_CTRL ?? 'http://127.0.0.1:31800'
const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const REPO = 'D:/project_develop/dsh-brain'
/** 收尾落点：栈必须留在这个 profile（项目约定）。 */
const HOME_PROFILE = 'web'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : argv[i + 1]
}

const profile = argOf('--profile')
const preset = argOf('--preset')
const PROMPT = argOf('--prompt') ?? '只回一个字：好'
const EXPECT = argOf('--expectToolCount') == null ? null : Number(argOf('--expectToolCount'))
const WAIT_TOOL_RESULT = has('--waitToolResult')

if (has('--help') || (!profile && !preset && !has('--current'))) {
  console.log(
    'usage: node scripts/measure-arm-face.mjs [--profile <name>] [--preset <name>]' +
      ' [--expectToolCount <n>] [--prompt <text>] [--waitToolResult]',
  )
  process.exit(has('--help') ? 0 : 2)
}
if (EXPECT !== null && !Number.isFinite(EXPECT)) {
  console.error(`--expectToolCount 必须是数字，实得 ${JSON.stringify(argOf('--expectToolCount'))}`)
  process.exit(2)
}

const notes = []
const status = async () => (await fetch(`${CTRL}/?cmd=status`)).json()

/** ★ 照抄 `scripts/arm-probe.mjs` 的 `flip()`（不要自己发明换代流程）。 */
async function flip(prof) {
  const s0 = await status()
  if (s0.stage !== 'idle') throw new Error(`控制面 stage=${s0.stage}，先别换代（要等到 idle）`)
  await fetch(`${CTRL}/?cmd=handover&profile=${encodeURIComponent(prof)}`)
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const s = await status()
    if (s.stage === 'idle' && s.result) return s
  }
  throw new Error('换代超时（60 × 2s 到不了 idle）')
}

/** 前门 RPC 信封（与 `session-create.mjs` / `session-drive.mjs` / `eval-run.mjs` 一致）。 */
async function rpc(method, payload) {
  const res = await fetch(`${FRONT}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text }
}

/** ★ 照抄 `eval-run.mjs:71-89` 的回读口径：`items[].agentPreset`（**用错字段会 200 但静默不生效**）。 */
async function sessionStats(sid) {
  const r = await rpc('session.list', {})
  const items = r.json?.result?.value?.items ?? []
  const s = items.find((x) => x.sessionId === sid)
  if (!s) return null
  return { agentPreset: s.agentPreset ?? null, cwd: s.cwd ?? null, running: !!s.running }
}

function createSession() {
  const r = sh('node', ['scripts/session-create.mjs'])
  const sid = String(r.stdout ?? '').trim().split('\n').pop().trim()
  return sid && sid.startsWith('session-') ? sid : null
}

/** 读面：**不重跑**，只对已跑过的会话补算轨迹（`eval-run.mjs --traj`）。 */
function readMetrics(sid) {
  const r = sh('node', ['scripts/eval-run.mjs', '--traj', sid])
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

/** 会话文件路径（与 `eval-run.mjs:404-418` 同一找法）。 */
function sessionFile(sid) {
  try {
    for (const d of fs.readdirSync(SESSION_ROOT)) {
      const p = path.join(SESSION_ROOT, d, sid, 'session.jsonl.zstd')
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* 目录不存在 */
  }
  return null
}

/**
 * 逐条列 `tool/call` ↔ 其 `tool/result`，并用**结构判据**判成败。
 * ⚠ 不用 `isError`：实测 shell 工具的失败从不标 `isError=true`（见 lib-tool-failure.mjs 头注释）。
 */
function toolPairs(sid) {
  const f = sessionFile(sid)
  if (!f) return null
  let text
  try {
    text = Buffer.from(decompressZstd(fs.readFileSync(f))).toString('utf8')
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
  const recs = text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const pending = new Map()
  const pairs = []
  for (const r of recs) {
    if (r.type === 'tool/call') {
      pending.set(r?.data?.callId ?? 'seq' + r.seq, { name: r?.data?.name ?? '?', args: r?.data?.arguments ?? r?.data?.input ?? null, seq: r.seq })
    } else if (r.type === 'tool/result') {
      const id = r?.data?.message?.source?.callId ?? r?.data?.message?.content?.[0]?.toolCallId
      const hit = pending.get(id)
      const v = isToolFailure(r)
      if (hit) pending.delete(id)
      pairs.push({
        tool: hit?.name ?? '(未配对的 call)',
        callSeq: hit?.seq ?? null,
        args: hit?.args ?? null,
        failed: v.failed,
        rule: v.rule,
        interrupted: v.interrupted,
        isError: v.isError,
        text: resultTextOf(r).slice(0, 600),
      })
    }
  }
  return { pairs, unresultedCalls: [...pending.values()].map((v) => v.name) }
}

const say = (s) => console.log(s)

// ── 1. 换代 ───────────────────────────────────────────────────────────────────
let gen = (await status()).lease?.activeGen?.gen ?? null
if (profile) {
  say(`=== 换代 → ${profile} ===`)
  const s = await flip(profile)
  gen = s.lease?.activeGen?.gen ?? gen
  say(`  ${String(s.result?.note ?? '').slice(0, 60)}  代=${gen}`)
}

try {
  // ── 2. 建会话 ───────────────────────────────────────────────────────────────
  const sid = createSession()
  if (!sid) throw new Error('建会话失败（session-create.mjs 没吐出 session-* 的 id）')
  say(`会话 ${sid}`)

  // ── 3. 选 preset + **回读** ─────────────────────────────────────────────────
  let presetReadback = null
  if (preset) {
    const sel = await rpc('agentPreset.select', { sessionId: sid, agentPreset: preset })
    // ★ 用错字段会 HTTP 200 但静默不生效 ⇒ 必须回读
    const rb = await sessionStats(sid)
    presetReadback = rb?.agentPreset ?? null
    const ok = presetReadback === preset
    say(`preset→HTTP ${sel.status}  回读=${presetReadback ?? '?'}  ${ok ? '✓' : '✗'}`)
    if (!ok) {
      say('⚠ preset 回读不符（可能：id 不存在 / 该会话已产出过历史而不可切 / 信封字段写错）')
      notes.push(`preset 回读=${presetReadback}，期望 ${preset}`)
    }
  } else {
    presetReadback = (await sessionStats(sid))?.agentPreset ?? null
    say(`未指定 --preset，沿用该会话默认 preset=${presetReadback ?? '?'}`)
  }

  // ── 4. 发一句话 ─────────────────────────────────────────────────────────────
  const drv = sh('node', ['scripts/session-drive.mjs', 'prompt', sid, PROMPT])
  const drvStatus = /"status":\s*(\d+)/.exec(String(drv.stdout ?? ''))?.[1] ?? '?'
  say(`prompt→HTTP ${drvStatus}  「${PROMPT}」`)

  // ── 5. 读面（未落盘就轮询）─────────────────────────────────────────────────
  let m = null
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const a = readMetrics(sid)
    const mm = a?.metrics ?? null
    if (mm && mm.toolSetSize > 0) {
      m = mm
      // `--waitToolResult`：还要等**工具结果**落盘（否则只有 request/header，判不了成败）
      if (WAIT_TOOL_RESULT) {
        const tp = toolPairs(sid)
        const done = tp?.pairs?.length >= (mm.toolCalls ?? 0) && (mm.toolCalls ?? 0) > 0
        if (!done) continue
      }
      break
    }
  }
  if (!m) throw new Error('读不到工具面（15 × 2s 内 request/header 未落盘）')

  const tools = m.toolSet ?? []
  // ── 6. 摘要 + JSON ─────────────────────────────────────────────────────────
  say(
    `面读数：profile=${profile ?? '(未换)'} gen=${gen ?? '?'} preset=${preset ?? '(默认)'}` +
      `（回读 ${presetReadback ?? '?'}） systemChars=${m.systemChars} toolSetSize=${m.toolSetSize}`,
  )
  const out = {
    profile: profile ?? null,
    gen: gen ?? null,
    preset: preset ?? null,
    presetReadback,
    systemChars: m.systemChars,
    toolSetSize: m.toolSetSize,
    tools,
    sid,
    mode: m.mode,
  }
  say(JSON.stringify(out, null, 2))

  if (WAIT_TOOL_RESULT) {
    const tp = toolPairs(sid)
    say(`\n── 工具执行（结构判据，❌ 不看 isError）: toolCalls=${m.toolCalls} toolResults=${m.toolResults} ──`)
    if (!tp || tp.error) say(`  ⚠ 读不到会话事件：${tp?.error ?? '(文件不存在)'}`)
    else {
      for (const p of tp.pairs) {
        say(`  [${p.failed ? '✗ 失败' : p.interrupted ? '⚠ 中断' : '✓ 成功'}] ${p.tool}  rule=${p.rule ?? '-'}`)
        say(`      args: ${String(p.args ?? '').slice(0, 200).replace(/\n/g, ' ')}`)
        say(`      text: ${String(p.text).replace(/\r?\n/g, ' | ').slice(0, 400)}`)
      }
      if (!tp.pairs.length) say('  ⚠ 这次回合里**没有任何 tool/result 落盘**（模型没调工具，或还没跑到）')
      if (tp.unresultedCalls.length) say(`  ⚠ 有 call 没有对应 result：${JSON.stringify(tp.unresultedCalls)}`)
      out.toolPairs = tp.pairs.map((p) => ({ tool: p.tool, failed: p.failed, interrupted: p.interrupted, rule: p.rule, text: p.text.slice(0, 200) }))
    }
  }

  // ── 7. 断言 ────────────────────────────────────────────────────────────────
  if (EXPECT !== null && m.toolSetSize !== EXPECT) {
    console.error(`✗ --expectToolCount ${EXPECT} 不符：实际 toolSetSize=${m.toolSetSize}`)
    console.error(`  实际工具名：${JSON.stringify(tools)}`)
    process.exitCode = 1
  }
  if (out.preset && presetReadback !== preset) {
    console.error(`✗ preset 回读不符：${presetReadback} ≠ ${preset}`)
    process.exitCode = 1
  }
} catch (e) {
  console.error(`✗ 量尺失败：${e?.message ?? e}`)
  process.exitCode = 1
} finally {
  // ── 8. 收尾：栈留在 `web`（换过代才切），并确认前门 200 ──────────────────────
  // ⚠ 控制面的 `?cmd=status` **不报当前 profile**（实测只有 gen/port/pid）⇒ 本脚本
  //   不做"当前是不是 web"的猜测，只按"本次是否代过代"决定是否切回（可机验、不臆断）。
  try {
    if (profile && profile !== HOME_PROFILE) {
      say(`\n=== 收尾：换代回 ${HOME_PROFILE} ===`)
      const s = await flip(HOME_PROFILE)
      say(`  ${String(s.result?.note ?? '').slice(0, 60)}  代=${s.lease?.activeGen?.gen}`)
    } else {
      say(`\n=== 收尾：本次没换过代（或本来就指向 ${HOME_PROFILE}），不换代 ===`)
    }
  } catch (e) {
    console.error(`✗ 收尾换代回 ${HOME_PROFILE} 失败：${e?.message ?? e}`)
    process.exitCode = 1
  }
  try {
    const res = await fetch(`${FRONT}/`)
    say(`前门 ${FRONT} → HTTP ${res.status}${res.status === 200 ? ' ✓' : ' ✗'}`)
    if (res.status !== 200) process.exitCode = 1
  } catch (e) {
    console.error(`✗ 前门不可达：${e?.message ?? e}`)
    process.exitCode = 1
  }
  for (const n of notes) console.error(`⚠ ${n}`)
}
