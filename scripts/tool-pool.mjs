#!/usr/bin/env node
/**
 * tool-pool.mjs —— **工具池 + 回值**（DSH 侧）。**就两件事：收一条"回值"，和把池子聚合出来。**
 *
 * 依据（结论固化，逐字）：`docs/training-ground-and-skill-sieve-2026-09-25.md` **§11.8**。
 * 用户原话：
 *   *"你不需要搜索工具，你只需要**给工具打分**即可。因为每个子 Agent **有自己的工具面**，
 *   然后这个子 Agent 只需要**自己评价自己的工具**即可，也**不需要自己去检索新工具**。
 *   所以实际上它就是**一个工具池**，然后对这个工具池里的工具进行一个**回值**而已。
 *   就是**给一个反馈而已，评分和反馈罢了**，然后根据评分和反馈交给**开发脑和进化脑**进行下一步的迭代。"*
 *
 * ★★ **明确不做**（YAGNI，且那属于旧 AI Base 方向，见 §11.8）：
 *    注册表 / 上架下架 / 能力声明 / transport / 检索选型 / 对外榜单 —— **一条都不做**。
 *
 * ★ 存储：**append-only JSONL**（与项目"写入时外置化必须 append-only"一致）。
 *   默认 `~/.dsh/tool-pool/pool.jsonl`，**可用 `--file` 覆盖**；★ **读操作绝不写盘**。
 * ★ **幂等**：同一条回值（同 `t|tool|agent|task`）重复写 ⇒ **不重复计**（本机命令可能被执行两次）。
 *
 * 用法：
 *   node scripts/tool-pool.mjs record --tool <工具名> --score <0..1> --agent <谁> [--note "..."] [--task <id>] [--file <path>]
 *   node scripts/tool-pool.mjs report [--file <path>] [--json]
 *   node scripts/tool-pool.mjs --selftest
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_POOL = path.join(os.homedir(), '.dsh', 'tool-pool', 'pool.jsonl')

/** 校验一条回值（**fail-closed**：不合格就拒，不静默改写成 0）。 */
export function validateRating(r) {
  const tool = String(r?.tool ?? '').trim()
  const agent = String(r?.agent ?? '').trim()
  const score = r?.score
  if (!tool) return { ok: false, reason: 'tool 为空（回值必须指明是给哪个工具）' }
  if (!agent) return { ok: false, reason: 'agent 为空（回值必须说明是谁评的 —— 自评者身份）' }
  if (typeof score !== 'number' || !Number.isFinite(score)) return { ok: false, reason: `score 必须是有限数（拿到 ${JSON.stringify(score)}）` }
  if (score < 0 || score > 1) return { ok: false, reason: `score 越界（${score}，须在 [0,1]）` }
  const note = r?.note === undefined || r?.note === null ? '' : String(r.note)
  return { ok: true, value: { t: String(r?.t ?? new Date().toISOString()), tool, score, agent, note, task: r?.task ? String(r.task) : '' } }
}

/** 幂等键：同一条回值重复到达 ⇒ 判为同一条（★ 本机"命令可能被执行两次"）。 */
export const dedupeKey = (r) => `${r.t}|${r.tool}|${r.agent}|${r.task ?? ''}`

/** 读池子（**只读，不写盘**；文件不存在 ⇒ 空数组）。坏行**跳过并计入 bad**，不抛。 */
export function readRatings(file = DEFAULT_POOL) {
  if (!fs.existsSync(file)) return { rows: [], bad: 0 }
  const raw = fs.readFileSync(file, 'utf8')
  const rows = []
  let bad = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      if (validateRating(v).ok) rows.push(v)
      else bad++
    } catch {
      bad++
    }
  }
  return { rows, bad }
}

/** 追加回值（**append-only + 幂等**）。返回实际写入/跳过条数。 */
export function appendRatings(file, ratings) {
  const { rows } = readRatings(file)
  const have = new Set(rows.map(dedupeKey))
  const toWrite = []
  let skipped = 0
  const rejected = []
  for (const r of ratings) {
    const v = validateRating(r)
    if (!v.ok) { rejected.push({ r, reason: v.reason }); continue }
    const k = dedupeKey(v.value)
    if (have.has(k)) { skipped++; continue }
    have.add(k)
    toWrite.push(v.value)
  }
  if (toWrite.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, toWrite.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  }
  return { written: toWrite.length, skipped, rejected }
}

/** 聚合（纯函数）：按工具汇总 ⇒ **这就是"交给开发脑/进化脑"的输入**。 */
export function aggregate(rows) {
  const by = new Map()
  for (const r of rows) {
    let e = by.get(r.tool)
    if (!e) { e = { tool: r.tool, n: 0, sum: 0, scores: [], agents: new Set(), lastAt: '', lastNote: '', tasks: new Set() }; by.set(r.tool, e) }
    e.n++
    e.sum += r.score
    e.scores.push(r.score)
    e.agents.add(r.agent)
    if (r.task) e.tasks.add(r.task)
    if (String(r.t) >= String(e.lastAt)) { e.lastAt = r.t; e.lastNote = r.note }
  }
  const out = [...by.values()].map((e) => ({
    tool: e.tool,
    n: e.n,
    meanScore: Number((e.sum / e.n).toFixed(4)),
    minScore: Math.min(...e.scores),
    maxScore: Math.max(...e.scores),
    agents: [...e.agents],
    tasks: e.tasks.size,
    lastAt: e.lastAt,
    lastNote: e.lastNote,
  }))
  out.sort((a, b) => a.meanScore - b.meanScore) // ★ 均分低的排前面（那才是要迭代的）
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
//  自测（判据）+ CLI —— ★ 一律 `if (isMain)` 守卫，保证被 import 时不派发 CLI
// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const TMP = path.join(HERE, '..', 'out', '_toolpool-test')
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  const F = path.join(TMP, 'pool.jsonl')
  const res = []
  const check = (n, ok, detail) => { res.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

  // ① / ② / ③ 校验
  check('① 合法回值 ⇒ 通过', validateRating({ tool: 'a', score: 0.8, agent: 'evo-dev' }).ok, '')
  const badScores = [-0.1, 1.1, NaN, '0.8', null, undefined]
  const leaked = badScores.filter((s) => validateRating({ tool: 'a', score: s, agent: 'x' }).ok)
  check('② score 越界/非数 ⇒ 全拒', leaked.length === 0, `6 种都拒（漏 ${leaked.length}）`)
  check('③ tool/agent 空 ⇒ 拒',
    !validateRating({ score: 0.5, agent: 'x' }).ok && !validateRating({ tool: 'a', score: 0.5 }).ok, '')

  // ④ ⑤ append-only + 幂等
  const r1 = { t: '2026-09-25T18:00:00.000Z', tool: 't1', score: 0.2, agent: 'evo-dev', note: '差', task: 'T1' }
  const r2 = { t: '2026-09-25T18:01:00.000Z', tool: 't1', score: 0.8, agent: 'evo-review', note: '好', task: 'T1' }
  const w1 = appendRatings(F, [r1, r2])
  const lines1 = fs.readFileSync(F, 'utf8').split('\n').filter((l) => l.trim()).length
  check('④ append-only：2 条 ⇒ 文件 2 行', w1.written === 2 && lines1 === 2, `written=${w1.written} 行=${lines1}`)
  const w2 = appendRatings(F, [r1]) // 重复到达
  const lines2 = fs.readFileSync(F, 'utf8').split('\n').filter((l) => l.trim()).length
  check('⑤ ★ 幂等：同一条重复到达 ⇒ 不重复计', w2.written === 0 && w2.skipped === 1 && lines2 === 2, `written=0 skipped=${w2.skipped} 行=${lines2}`)

  // ⑥ 聚合
  appendRatings(F, [{ t: '2026-09-25T18:02:00.000Z', tool: 't1', score: 0.5, agent: 'evo-dev', note: '中', task: 'T2' }])
  const agg = aggregate(readRatings(F).rows)
  const t1 = agg.find((x) => x.tool === 't1')
  check('⑥ 聚合：n/均分/极值/评分者 都对', t1.n === 3 && t1.meanScore === 0.5 && t1.minScore === 0.2 && t1.maxScore === 0.8 && t1.agents.length === 2,
    JSON.stringify({ n: t1.n, mean: t1.meanScore, min: t1.minScore, max: t1.maxScore, agents: t1.agents }))
  check('⑥b 均分低的排前面（要迭代的先看到）', agg[0].tool === 't1', `首位=${agg[0].tool}`)

  // ⑦ 读不写盘
  const NOPE = path.join(TMP, 'nope', 'pool.jsonl')
  const rr = readRatings(NOPE)
  check('⑦ 读不存在的池子 ⇒ 空 + **不创建任何东西**', rr.rows.length === 0 && rr.bad === 0 && !fs.existsSync(path.dirname(NOPE)),
    `rows=0 目录存在=${fs.existsSync(path.dirname(NOPE))}`)

  // ⑧ ★★ 消融：撤掉"score 越界就拒" ⇒ 判据② 必须变红
  console.log('\n=== 消融自证 ===')
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const ANCHOR = "  if (score < 0 || score > 1) return { ok: false, reason: `score 越界（${score}，须在 [0,1]）` }"
  let ablOk = false
  if (!src.includes(ANCHOR)) {
    console.log('  ★ 锚点失配 —— 消融脚本必须重写（不许模糊匹配）')
  } else {
    const tmp = path.join(HERE, '_toolpool-ablated.mjs')
    fs.writeFileSync(tmp, src.replace(ANCHOR, '  // ABLATED: 越界检查已撤'), 'utf8')
    const run = spawnSync(process.execPath, [tmp, '--selftest-only'], { encoding: 'utf8', timeout: 60000 })
    const out = (run.stdout ?? '') + (run.stderr ?? '')
    ablOk = /FAIL 越界/.test(out)
    console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 撤掉"越界就拒"⇒ 判据② 变红 ${ablOk ? '✓' : `（没变红；${out.slice(0, 160)}）`}`)
    fs.unlinkSync(tmp)
  }
  fs.rmSync(TMP, { recursive: true, force: true })
  const pass = res.filter((x) => x.ok).length
  const total = pass === res.length && ablOk
  console.log(`\n结果：判据 ${pass}/${res.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }

  if (argv.includes('--selftest-only')) {
    // 消融版自调用：只跑"越界必须被拒"那条，故意 FAIL 供父进程断言
    const leaked = [-0.1, 1.1].filter((s) => validateRating({ tool: 'a', score: s, agent: 'x' }).ok)
    console.log(leaked.length ? `  FAIL 越界（漏 ${leaked.length} 个）` : '  ok  越界')
    process.exit(0)
  }
  if (argv.includes('--selftest') || argv.length === 0) process.exit(selftest())

  const cmd = argv[0]
  const file = argOf('--file') ?? DEFAULT_POOL

  if (cmd === 'record') {
    const w = appendRatings(file, [{ tool: argOf('--tool'), score: Number(argOf('--score')), agent: argOf('--agent'), note: argOf('--note') ?? '', task: argOf('--task') ?? '' }])
    for (const r of w.rejected) console.error(`[拒绝] ${r.reason}`)
    console.log(`已写入 ${w.written} 条（跳过重复 ${w.skipped}，拒绝 ${w.rejected.length}）→ ${file}`)
    process.exit(w.rejected.length ? 1 : 0)
  }
  if (cmd === 'report') {
    const { rows, bad } = readRatings(file)
    const agg = aggregate(rows)
    if (argv.includes('--json')) console.log(JSON.stringify({ file, n: rows.length, badLines: bad, tools: agg }, null, 2))
    else {
      console.log(`\n工具池 ${file}：${rows.length} 条回值${bad ? `（另有 ${bad} 条坏行）` : ''}，覆盖 ${agg.length} 个工具`)
      for (const t of agg) console.log(`  ${String(t.meanScore).padEnd(6)} n=${String(t.n).padEnd(3)} ${t.tool}  ← ${t.agents.join(', ')}${t.lastNote ? ` ｜最近：${t.lastNote}` : ''}`)
      console.log('\n★ 这份聚合就是"交给开发脑 / 进化脑"的输入（均分低的排前面）。')
    }
    process.exit(0)
  }
  console.error('[用法] record --tool <名> --score <0..1> --agent <谁> [--note ""] [--task <id>] [--file <path>]\n        report [--file <path>] [--json]\n        --selftest')
  process.exit(2)
}
