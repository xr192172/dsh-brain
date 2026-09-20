#!/usr/bin/env node
/**
 * eval-validate.mjs —— 任务集**有效性**校验（M1 的前半，**不需要 Agent**）
 *
 * ## 它守的是什么
 *
 * 一份任务集最容易出的错不是"题不够多"，而是**题目没有信号**：
 * 打上 `seed`（把修过的改动反向打回去）之后 oracle 还是绿的 ⇒ 这题跑一万次也不区分好坏。
 * 2026 年的公开教训是同一个：SWE-bench Verified 被审计出"难度子集里 59.4% 的测试集
 * 根本抓不到目标 bug"（判据坏了，比没有判据更糟 —— 与本项目的"假绿"同一条）。
 *
 * 所以每题必须过三关：
 *   ① 干净态：`regression` 绿 **且** `oracle` 绿（题目成立的前提）
 *   ② 打上 seed：`oracle` **必须红**（= 这题有信号）
 *   ③ 还原：字节级 sha256 校验通过，且 `oracle` 复绿
 *
 * ## 安全
 *
 * - 只改 `seed.edits` 里点名的文件；**不碰 git、不碰 node_modules、不写 ~/.dsh**。
 * - 改前把原字节备份到 `out/eval-backup/<sha256 前缀>/`，`finally` 里还原并**校验 sha256**；
 *   还原失败 ⇒ 大声报错 + **保留备份**（绝不静默）。
 * - `find` 必须恰好出现 1 次（0 次 = 上游改了/题失效；多次 = 会误伤），否则拒绝执行。
 *
 * ## 用法
 *
 *   node scripts/eval-validate.mjs [--tasks evals/pilot/tasks.jsonl] [--only <id>] [--json out/eval-validate.json]
 *   node scripts/eval-validate.mjs --prepare <id>    # 只把题打坏（留给 Agent 修），写还原清单
 *   node scripts/eval-validate.mjs --restore         # 按清单还原（幂等）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const REPO = 'D:/project_develop/dsh-brain'
const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const TASKS = path.resolve(REPO, argOf('--tasks') ?? 'evals/pilot/tasks.jsonl')
const ONLY = argOf('--only')
const JSON_OUT = path.resolve(REPO, argOf('--json') ?? 'out/eval-validate.json')
const BACKUP_DIR = path.join(REPO, 'out', 'eval-backup')
const MANIFEST = path.join(REPO, 'out', 'eval-prepare.json')

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
const run = (cmd) => spawnSync(cmd[0], cmd.slice(1), { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const results = []
const say = (s) => console.log(s)

function loadTasks() {
  const raw = fs.readFileSync(TASKS, 'utf8')
  const out = []
  raw.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('//')) return
    try {
      out.push(JSON.parse(t))
    } catch (e) {
      throw new Error(`${TASKS}:${i + 1} JSON 解析失败：${e.message}`)
    }
  })
  return ONLY ? out.filter((t) => t.id === ONLY) : out
}

/** 结构检查：缺字段 / 锚点出现次数不对 ⇒ 直接判这题不可用。 */
function checkShape(t) {
  const bad = []
  for (const k of ['id', 'invariant', 'seed', 'oracle', 'regression', 'budget']) if (!t[k]) bad.push(`缺字段 ${k}`)
  if (!Array.isArray(t?.seed?.edits) || t.seed.edits.length === 0) bad.push('seed.edits 为空')
  if (!Array.isArray(t?.oracle?.cmd) || t.oracle.cmd.length === 0) bad.push('oracle.cmd 为空')
  if (!Array.isArray(t?.regression?.cmd) || t.regression.cmd.length === 0) bad.push('regression.cmd 为空')
  for (const e of t?.seed?.edits ?? []) {
    const abs = path.join(REPO, e.file)
    if (!fs.existsSync(abs)) {
      bad.push(`seed 目标不存在：${e.file}`)
      continue
    }
    const n = fs.readFileSync(abs, 'utf8').split(e.find).length - 1
    if (n !== 1) bad.push(`seed.find 在 ${e.file} 里出现 ${n} 次（必须恰好 1 次）：${JSON.stringify(String(e.find).slice(0, 60))}`)
    if (e.find === e.replace) bad.push(`seed 的 find/replace 相同（不会改任何东西）：${e.file}`)
  }
  return bad
}

/**
 * 打 seed：**先落字节级备份，再改盘**；manifest 写成功才算这一步成功。
 * 中途任何一步抛错 ⇒ 回滚已改的文件（best-effort）并抛出，绝不留半改状态。
 */
function prepare(task) {
  if (fs.existsSync(MANIFEST)) throw new Error(`已有未还原的 seed：${MANIFEST}（先跑 --restore）`)
  const files = []
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  try {
    for (const e of task.seed.edits) {
      const abs = path.join(REPO, e.file)
      const before = fs.readFileSync(abs)
      const text = before.toString('utf8')
      const next = text.replace(e.find, e.replace)
      if (next === text) throw new Error(`seed 未产生变化：${e.file}`)
      const backup = path.join(BACKUP_DIR, `${sha(before)}-${path.basename(e.file)}`)
      fs.writeFileSync(backup, before) // ★ 备份的是**改前**字节
      fs.writeFileSync(abs, next, 'utf8')
      files.push({ file: e.file, sha256: sha(before), backup, after: sha(fs.readFileSync(abs)) })
    }
  } catch (err) {
    for (const f of files) {
      try {
        fs.writeFileSync(path.join(REPO, f.file), fs.readFileSync(f.backup))
      } catch {
        /* 回滚尽力而为；下面会大声报错 */
      }
    }
    throw err
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ task: task.id, files, at: new Date().toISOString() }, null, 2), 'utf8')
  return files
}

/** 按 manifest 还原 + **字节级 sha256 校验**（不匹配 ⇒ 报错且**保留备份**，绝不静默）。
 *
 * `force=true`（`--restore --force`）：**无条件用改前字节还原**，跳过"疑似并发写者就拒绝"的保护。
 * 给**实验台**（`eval-run.mjs`）用：实验期间改那些文件的**就是它自己派出去的 Agent**，
 * 跑完把工作区恢复到实验起点是它的职责。⚠️ 手工用 `--restore`（不带 force）时保持保护不变。
 */
function restore(force = false) {
  if (!fs.existsSync(MANIFEST)) return { restored: 0, ok: true }
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  let ok = true
  for (const f of man.files) {
    const abs = path.join(REPO, f.file)
    const cur = sha(fs.readFileSync(abs))
    if (cur === f.sha256) continue // 已是原字节
    // ★★ 2026-09-20 加的**防覆盖**：本仓库可能**同时有别的会话在写**（实测发生过）。
    //   只有"当前内容 == 我们打进去的那个 seed"才允许还原；否则**拒绝改写**（否则会把并发写者的编辑抹掉）。
    if (!force && f.after && cur !== f.after) {
      ok = false
      say(`  ✗ 拒绝还原 ${f.file}：当前内容既不是原字节、也不是我们打进去的 seed（**疑似并发写者**）⇒ 不覆盖它。`)
      say(`     备份仍在：${f.backup}（人工决定怎么处理；处理完删掉 ${MANIFEST} 即可恢复流程）`)
      continue
    }
    if (!fs.existsSync(f.backup)) {
      ok = false
      say(`  ✗ 还原失败：备份不见了 ${f.backup}`)
      continue
    }
    fs.writeFileSync(abs, fs.readFileSync(f.backup))
    if (sha(fs.readFileSync(abs)) !== f.sha256) {
      ok = false
      say(`  ✗ 还原后 sha256 不匹配：${f.file}（备份保留在 ${f.backup}）`)
    }
  }
  if (ok) fs.rmSync(MANIFEST)
  return { restored: man.files.length, ok }
}

// ── --restore：独立入口 ────────────────────────────────────────────────────
if (argv.includes('--restore')) {
  const force = argv.includes('--force')
  const r = restore(force)
  say(
    (r.restored ? `已还原 ${r.restored} 个文件（sha256 校验 ${r.ok ? '通过' : '**失败**'}` : '没有待还原的 seed') +
      (r.restored ? `；${force ? 'force 模式：实验台用，无条件回到实验起点' : '保护模式：拒绝覆盖并发写者的编辑'}）` : ''),
  )
  process.exit(r.ok ? 0 : 1)
}

const tasks = loadTasks()
if (tasks.length === 0) {
  say(`没有匹配的任务（--only ${ONLY ?? '-'}）`)
  process.exit(1)
}

// ── --prepare：只打坏（给 Agent 用）────────────────────────────────────────
if (argOf('--prepare')) {
  // ★ 2026-09-20 修掉一个**静默误伤**：原先这里取 `tasks[0]`，
  //   而 `--prepare` 后面那个值只当"真值"用 ⇒ `--prepare cli-0002` 其实**打的是第一题**（cli-0001），
  //   调用方却以为打的是 cli-0002（`eval-run.mjs` 的第一次真跑就因此报"题目没有信号"，白查一圈）。
  //   现在：值必须是**能唯一匹配的 id 或前缀**，匹配不上就直接报错（宁可吵，也不要静默打错题）。
  const sel = argOf('--prepare')
  const exact = tasks.find((t) => t.id === sel)
  const prefix = tasks.filter((t) => t.id.startsWith(sel))
  if (!exact && prefix.length !== 1) {
    say(`--prepare 打哪一题必须唯一：'${sel}' ${prefix.length > 1 ? `匹配到多题 ${prefix.map((t) => t.id).join(', ')}` : '匹配不到任何题'}`)
    say(`可用：${tasks.map((t) => t.id).join(', ')}`)
    process.exit(1)
  }
  const t = exact ?? prefix[0]
  const bad = checkShape(t)
  if (bad.length) {
    say(`任务 ${t.id} 结构不合格，拒绝 prepare：`)
    for (const b of bad) say('  · ' + b)
    process.exit(1)
  }
  const files = prepare(t)
  say(`已 prepare ${t.id}：改了 ${files.length} 个文件；还原用 node scripts/eval-validate.mjs --restore`)
  for (const f of files) say(`  ${f.file}  ${f.sha256}(原) → ${f.after}(现)`)
  say(`\n题面（交给 Agent 的不变量描述）：\n  ${t.invariant}`)
  process.exit(0)
}

// ── 默认：有效性校验 ───────────────────────────────────────────────────────
say(`任务集：${path.relative(REPO, TASKS)}（${tasks.length} 题）`)
say('每题三关：①干净态绿 ②打 seed 后 oracle 必须红 ③还原后复绿\n')
let failed = 0
for (const t of tasks) {
  say(`── ${t.id}`)
  const bad = checkShape(t)
  if (bad.length) {
    failed++
    for (const b of bad) say('  ✗ 结构：' + b)
    results.push({ id: t.id, ok: false, stage: 'shape', problems: bad })
    continue
  }
  const rec = { id: t.id, ok: false, cleanOracle: null, cleanRegression: null, seededOracle: null, restored: null }
  try {
    // ① 干净态：oracle 绿（regression 绿是前提，跑一次 oracle 就够说明这题"本来就过"）
    const o1 = run(t.oracle.cmd)
    rec.cleanOracle = o1.status === 0
    if (!rec.cleanOracle) {
      say(`  ✗ 干净态 oracle 就是红的 —— 这题的前提不成立（先修好仓库再收题）`)
      failed++
      results.push(rec)
      continue
    }
    // ② 打 seed → oracle 必须红
    prepare(t)
    const o2 = run(t.oracle.cmd)
    rec.seededOracle = o2.status !== 0
    if (!rec.seededOracle) {
      say(`  ✗ **假题**：打上 seed 之后 oracle 仍是绿的 ⇒ 这题没有信号`)
      failed++
      continue
    }
    say(`  ✓ 有信号：seed 让 oracle 由绿转红（${t.oracle.cmd.join(' ')}）`)
  } finally {
    // ③ 还原 + 校验
    const r = restore()
    rec.restored = r.ok
    const o3 = run(t.oracle.cmd)
    rec.cleanRegression = o3.status === 0
    if (!r.ok || !rec.cleanRegression) {
      say(`  ✗ 还原/复绿异常：restored=${r.ok} oracleAfterRestore=${rec.cleanRegression}`)
      failed++
    } else {
      rec.ok = true
      say(`  ✓ 还原并复绿（sha256 校验通过）`)
    }
    results.push(rec)
  }
}

fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true })
fs.writeFileSync(
  JSON_OUT,
  JSON.stringify({ tasks: path.relative(REPO, TASKS), at: new Date().toISOString(), results }, null, 2),
  'utf8',
)
say('')
say('─'.repeat(70))
say(`${results.length - failed} 题有效 / ${failed} 题有问题   报告 → ${path.relative(REPO, JSON_OUT)}`)
if (failed) {
  say('')
  say('有问题的题**不算数**（判据纪律：未实施的判据级不得计作通过）。常见原因：')
  say('  · seed 的锚点在上游/本次改动后失效（find 出现 0 次）⇒ 重写 seed')
  say('  · oracle 与 seed 无因果（改了 A、门却在查 B）⇒ 换 oracle 或换 seed')
  say('  · 干净态本来就红 ⇒ 先把仓库修好')
}
process.exit(failed ? 1 : 0)
