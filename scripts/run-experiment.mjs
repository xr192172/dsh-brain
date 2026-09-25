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
 * ★★ **功能面**的读数（用户 2026-09-25 的规则要用它）：
 *   *"退步一小段时间，因为此次加入了某些工具等**那个牺牲了性能来扩展的功能面**这种，完全是可以理解的"*
 * ⇒ 可测代理：该臂 DSH_HOME 下**能力库的条目数**（能力库就是"这一代多了什么能力"的账本）。
 * ★ 读不到就返回 **null**（不是 0 ——"看不到 ≠ 没有"）。
 */
export function featureSurface(dshHome) {
  const f = path.join(dshHome, 'capabilities', 'registry.json')
  if (!fs.existsSync(f)) return null
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const c = j?.capabilities
    return Array.isArray(c) ? c.length : (c && typeof c === 'object' ? Object.keys(c).length : null)
  } catch { return null }
}

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
  // ★★ 修（**又是我自己犯的那一族**）：传进来 null/undefined 时，`evMissing` 会是 false、
  //   于是 `readingQuality` 报 **ok** —— 把"根本没读到"说成"读到了" ✗
  //    ⇒ **空读数一律算 missing**（"看不到 ≠ 没有"）。
  if (!delegateResult || typeof delegateResult !== 'object') {
    return {
      outcome: null, toolCalls: null, assistantTexts: null, byTool: {},
      evMissing: true, sessionId: null,
      readingQuality: 'missing（委托结果没拿到 ⇒ 不许当 0、也不许当 ok）',
    }
  }
  const w = delegateResult?.work ?? {}
  const evMissing = w.evMissing === true || w.toolCalls === undefined
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

  // ★ `--from <result.json>`：**只重采证据**（用于"跑过了但收卷读错路径"这种情形 —— 免得白重跑一次）
  const fromFile = argOf('--from')
  if (fromFile) {
    const p = path.resolve(fromFile)
    if (!fs.existsSync(p)) { console.error(`[拒绝] 找不到 ${p}`); process.exit(2) }
    const ev = collectEvidence(JSON.parse(fs.readFileSync(p, 'utf8')))
    const dir = path.join(WT, 'evals', 'runs', '_evidence', sp.taskId)
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-recollect.json`)
    fs.writeFileSync(f, JSON.stringify({ spec: sp, evidence: ev, recollectedFrom: path.relative(WT, p) }, null, 2) + '\n', 'utf8')
    console.log(`-- 重采证据（from ${path.relative(WT, p)}）--`)
    console.log(`  outcome=${ev.outcome}  toolCalls=${ev.toolCalls}  assistantTexts=${ev.assistantTexts}  读数质量=${ev.readingQuality}`)
    console.log(`  证据已存：${f}`)
    process.exit(ev.evMissing ? 1 : 0)
  }

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
  fs.mkdirSync(outDir, { recursive: true })
  // ★★ 2026-09-25 修（**实现与自己刚立的原则矛盾**）：派活产物会落在**任务书所在目录**下
  //   （`<dir>/_delegate-<tag>/`）⇒ 直接拿 `evals/tasks/<id>/task.md` 当 `--prompt`
  //   就会把**实验产物写进【题目录】** ⇒ 违反"**场 ≠ 实验**"。
  //   ⇒ 正解：把题面**拷贝到证据区**再用它当 prompt ⇒ 产物自然落在证据区 ✓
  const stagedPrompt = path.join(outDir, 'task.md')
  fs.copyFileSync(sp.promptPath, stagedPrompt)
  const dl = spawnSync(NODE, [path.join(HERE, 'delegation', 'dsh-delegate.mjs'), '--for-arm', sp.arm, '--tag', `exp-${sp.taskId}`, '--cwd', sp.cwd, '--rounds', String(sp.rounds), '--budget-ms', '1500000', '--stall-ms', '420000', '--prompt', stagedPrompt], { encoding: 'utf8', timeout: 1800000 })
  const dlOut = (dl.stdout ?? '') + (dl.stderr ?? '')
  console.log(dlOut.split('\n').filter((l) => /outcome|toolCalls|evMissing|产物|读数/.test(l)).slice(0, 6).join('\n'))
  let dres = null
  // ★★ 派活产物目录的真实位置 = **<任务书所在目录>/_delegate-<tag>/**（我今天已记下这条，却又只找了另外两处）
  const rps = [
    path.join(path.dirname(sp.promptPath), `_delegate-exp-${sp.taskId}`, 'result.json'),
    path.join(WT, 'out', '_tasks', `_delegate-exp-${sp.taskId}`, 'result.json'),
    path.join(WT, 'evals', 'runs', `_delegate-exp-${sp.taskId}`, 'result.json'),
  ]
  for (const p of rps) if (fs.existsSync(p)) { dres = JSON.parse(fs.readFileSync(p, 'utf8')); console.log(`  （读到的 result.json = ${path.relative(WT, p)}）`); break }
  if (!dres) console.log(`  ⚠️ **没找到 result.json**（找过：${rps.map((p) => path.relative(WT, p)).join(' / ')}）⇒ 证据会是 missing`)

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

  // ⑤ 判定（**报警 / 放行**）—— ★ 判据松紧由**题里的 `expect`** 决定：
  //    默认 `functional-only`（小更新：**只要跑成功就算过**，不套性能阈值）；
  //    大改动时由出题者在题里显式写 `{mode:'score-band', score:[lo,hi]}`。
  const s2 = stats(sp.taskId)
  const last = s2.trajectory[s2.trajectory.length - 1] ?? null
  console.log(`\n-- ⑤ 判定（报警 / 放行）--`)
  console.log(`  模式 = ${s2.expect?.mode}${s2.expect?.mode === 'functional-only' ? '（小更新：只看能不能跑）' : `（分数带 [${s2.expect?.score?.[0]}, ${s2.expect?.score?.[1]}]）`}`)
  console.log(`  本次判定 = ${last?.verdict} —— ${last?.why}`)
  console.log(`  该题重放轨迹（报警 ${s2.alarms} 次）：${s2.trajectory.map((t) => `${t.result}${t.score !== null ? `:${t.score}` : ''}⇒${t.verdict}`).join('  →  ')}`)
  const alarm = !!last?.alarm
  console.log(`\n===== ${alarm ? '❌ 报警（不要放行）' : '✅ 放行（无报警）'} =====`)
  process.exit(alarm ? 1 : 0)
}
