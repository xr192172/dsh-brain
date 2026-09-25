#!/usr/bin/env node
/**
 * run-experiment.mjs —— **把一条链串起来**：一次实验 = `取题 → 起一代 → 发题 → 收卷 → 留痕`。
 *
 * 依据用户 2026-09-25 的框架（逐字）：
 *   *"其实你可以对自进化可以这样理解，就像是我在操作你这个 Agent 去改另一个 Agent 一样，
 *    它完全可以**起现在一个 Agent 去改下一个 Agent**，然后**去测试下一个 Agent**嘛，
 *    **测试题就是我们的实验场**，然后**去做的是下下一代的开发**嘛。"*
 *
 * ⇒ 所以"一次实验"就是这条链上的一节。它**不判分**，只**采证据 + 留痕**。
 *
 * ★★ 为什么**不自动判分**（与本项目铁律 7 一致）：
 *   被改的 B 是**利益相关方** ⇒ 它的自评**不能当分数**（"裸满意度评分丢弃"）。
 *   分数只能由**发起方 / 核验方**显式给：`--result pass|fail --score 0..1 --by <谁>`。
 *   ⇒ 不给就记成 **`ran`（未判）** —— **诚实地说"只跑过、没判过"**。
 *
 * ★ 复用（不重造）：`task-bank`（题与成绩）/ `arm-up`（**另起一代 + 不 flip** = 起实例的原语）/
 *   `dsh-delegate`（发题与采读数）。
 *
 * 用法：
 *   node scripts/run-experiment.mjs <题id> [--arm A] [--rounds 1] [--dry]
 *        [--result pass|fail] [--score 0.9] [--by <谁>] [--note "..."]     # 判分（可选，默认"未判"）
 *
 * 判据：`--selftest`
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getTask, checkExecutable, recordScore, stats } from './task-bank.mjs'
import { portsForArm, dshHomeForArm } from './arm-ports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, '..')
const NODE = process.execPath

/**
 * ★ 纯函数：由【题 + 参数】算出"这一场实验的规格"。**不产生副作用**（便于判据）。
 * @returns {{ok:true, spec}|{ok:false, reason}}
 */
export function experimentSpec(taskId, { arm = 'A', rounds = 1, cwd = WT } = {}) {
  const t = getTask(taskId)
  const ex = checkExecutable(t)
  if (!ex.ok) return { ok: false, reason: `题 ${taskId} 不可执行：${ex.reason}` }
  // ★ 环境：`env.inherit` ⇒ 用 --arm；否则按题面 env.arm（没写就退回 --arm）
  const env = t.meta.env ?? {}
  const theArm = env.inherit ? arm : String(env.arm ?? arm)
  return {
    ok: true,
    spec: {
      taskId,
      title: t.meta.title,
      arm: theArm,
      env,
      front: portsForArm(theArm, [theArm]).front, // ★ 端口**派生**，不手抄
      dshHome: dshHomeForArm(theArm),
      promptPath: path.join(WT, 'evals', 'tasks', taskId, 'task.md'),
      cwd,
      rounds,
    },
  }
}

/** 收卷：从 delegate 的结果里取"读了什么"（★ 不判分）。 */
export function collectEvidence(delegateResult) {
  const w = delegateResult?.work ?? {}
  const evMissing = w.evMissing === true
  return {
    outcome: delegateResult?.outcome ?? null,
    toolCalls: evMissing ? null : (w.toolCalls ?? null),
    assistantTexts: w.assistantTexts ?? null,
    byTool: w.byTool ?? {},
    evMissing,
    sessionId: delegateResult?.sessionId ?? null,
    // ★★ 读数来源必须声明：看不到就说"看不到"（不许当 0）
    readingQuality: evMissing ? 'missing（读数拿不到 ⇒ 不许当 0）' : 'ok',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const res = []
  const check = (n, ok, detail) => { res.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

  // ① 取不到题 / 题不可执行 ⇒ 拒跑
  const s0 = experimentSpec('no-such-task')
  check('① 题不存在 ⇒ 拒跑', s0.ok === false, s0.reason ?? '')
  // ② 真题 ⇒ 出规格，且端口是**派生**的
  const s1 = experimentSpec('t1-guard', { arm: 'A' })
  check('② 真题 ⇒ 出规格（端口派生、env 带上）', s1.ok === true && s1.spec.front.startsWith('http://127.0.0.1:33') && !!s1.spec.env, s1.ok ? `${s1.spec.arm} front=${s1.spec.front}` : s1.reason)
  // ③ ★ 收卷只采证据、**不产分数**
  const ev = collectEvidence({ outcome: 'settled', work: { toolCalls: 12, assistantTexts: 3, byTool: { read: 2 }, evMissing: false }, sessionId: 's1' })
  check('③ 收卷不含任何 score 字段（不判分）', !('score' in ev) && !('result' in ev), Object.keys(ev).join(','))
  // ④ ★★ 读数拿不到 ⇒ 明确标 missing，**不许当 0**
  const ev2 = collectEvidence({ outcome: 'settled', work: { evMissing: true } })
  check('④ ★ 读数拿不到 ⇒ toolCalls=null 且标 missing（不当 0）', ev2.toolCalls === null && ev2.evMissing === true && /missing/.test(ev2.readingQuality), `toolCalls=${JSON.stringify(ev2.toolCalls)} q=${ev2.readingQuality}`)
  // ⑤ 默认不判分 ⇒ 记 'ran'（未判），而不是假 pass
  check('⑤ 未判分 ⇒ 记 ran（不冒充 pass）', ['pass', 'fail', 'ran'].includes('ran') && !['pass'].includes('ran'), '未判 ≠ 通过')

  console.log('\n（注：本脚本的判据只覆盖"规格/收卷/判分语义"，真正的跑一次见命令输出）')
  const pass = res.filter((x) => x.ok).length
  const total = pass === res.length
  console.log(`\n结果：判据 ${pass}/${res.length} ⇒ ${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (argv.includes('--selftest')) process.exit(selftest())
  const taskId = argv.find((a) => !a.startsWith('--'))
  if (!taskId) { console.error('[用法] node scripts/run-experiment.mjs <题id> [--arm A] [--rounds 1] [--dry] [--result … --score … --by …]'); process.exit(2) }

  const s = experimentSpec(taskId, { arm: argOf('--arm') ?? 'A', rounds: Number(argOf('--rounds') ?? 1) })
  if (!s.ok) { console.error(`[拒绝] ${s.reason}`); process.exit(2) }
  const sp = s.spec
  console.log(`\n===== 实验：${sp.taskId}「${sp.title}」=====`)
  console.log(`  环境(env) : ${JSON.stringify(sp.env)}`)
  console.log(`  用哪一代   : arm=${sp.arm}  front=${sp.front}  DSH_HOME=${sp.dshHome}`)
  console.log(`  题面       : ${sp.promptPath}`)
  const before = stats(sp.taskId)
  console.log(`  该题历史   : ${before.n} 次实验${before.meanScore !== null ? `，均分 ${before.meanScore}` : ''}`)

  if (argv.includes('--dry')) { console.log('\n（--dry：只算了规格，没起一代、没发题）'); process.exit(0) }

  // ① 起一代（**不 flip** ⇒ 不会抢现役的 3080）
  console.log('\n-- ① 起一代（arm-up，不 flip）--')
  const up = spawnSync(NODE, [path.join(HERE, 'arm-up.mjs'), sp.arm], { encoding: 'utf8', timeout: 900000 })
  const upOut = (up.stdout ?? '') + (up.stderr ?? '')
  console.log('  ' + (upOut.split('\n').filter((l) => /起来了|没起来/.test(l)).pop() ?? `exit=${up.status}`).trim())
  if (up.status !== 0) { console.error('[失败] 起一代没过自检 ⇒ 不敢发题'); console.error(upOut.split('\n').slice(-8).join('\n')); process.exit(1) }

  // ② 发题（+ 收卷）
  console.log('\n-- ② 发题（dsh-delegate --for-arm）--')
  const outDir = path.join(WT, 'evals', 'runs', '_evidence', sp.taskId)
  const dl = spawnSync(NODE, [path.join(HERE, 'delegation', 'dsh-delegate.mjs'), '--for-arm', sp.arm, '--tag', `exp-${sp.taskId}`, '--cwd', sp.cwd, '--rounds', String(sp.rounds), '--budget-ms', '1500000', '--stall-ms', '420000', '--prompt', sp.promptPath], { encoding: 'utf8', timeout: 1800000 })
  const dlOut = (dl.stdout ?? '') + (dl.stderr ?? '')
  console.log(dlOut.split('\n').filter((l) => /outcome|toolCalls|evMissing|产物|读数/.test(l)).slice(0, 6).join('\n'))
  let dres = null
  const rp = path.join(WT, 'evals', 'runs', '_delegate-' + `exp-${sp.taskId}`, 'result.json')
  const rp2 = path.join(WT, 'out', '_tasks', '_delegate-' + `exp-${sp.taskId}`, 'result.json')
  for (const p of [rp, rp2]) if (fs.existsSync(p)) dres = JSON.parse(fs.readFileSync(p, 'utf8'))

  // ③ 收卷（采证据，**不判分**）
  const ev = collectEvidence(dres)
  fs.mkdirSync(outDir, { recursive: true })
  const evFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(evFile, JSON.stringify({ spec: sp, evidence: ev }, null, 2) + '\n', 'utf8')
  console.log(`\n-- ③ 收卷（只采证据，不判分）--`)
  console.log(`  outcome=${ev.outcome}  toolCalls=${ev.toolCalls}  assistantTexts=${ev.assistantTexts}  读数质量=${ev.readingQuality}`)
  console.log(`  证据已存：${evFile}`)

  // ④ 留痕：判分（**默认不判** ⇒ 记 ran）
  const judged = argOf('--result')
  const rec = judged
    ? { result: judged, score: argOf('--score') === null ? null : Number(argOf('--score')), by: argOf('--by') ?? '(未署名)', note: argOf('--note') ?? '', at: undefined }
    : { result: 'ran', score: null, by: null, note: `只跑过、**未判分**（证据：${path.relative(WT, evFile)}）` }
  const sc = recordScore(sp.taskId, rec)
  console.log(`\n-- ④ 留痕 --`)
  console.log(`  ${sc.ok ? `已记录 result=${rec.result}${rec.score !== null ? ` score=${rec.score}` : ''}` : `★ 记录失败：${sc.reason}`}`)
  if (!judged) console.log('  ★ 未给 --result ⇒ 记 ran（**不冒充通过**）。判分只能由发起方/核验方给 —— 答题方自评不算数。')
  process.exit(0)
}
