#!/usr/bin/env node
/**
 * task-bank.mjs —— **题库**（训练场的"题"这一层）。★ 它**不认识 agent**。
 *
 * 依据（用户 2026-09-25 提问的结论，见 `docs/training-ground-as-exam-bank-2026-09-25.md`）：
 *   *"训练场不应该做成那个**一键刷新题目**，然后**选择题目进入题库**，然后**与 Agent 无关**，
 *     Agent 进去只需要**做题**这种吗？"*
 *
 * ★★ 分层（本文件只负责第 1 层）：
 *   | 层 | 管什么 | 认识 agent 吗 |
 *   |---|---|---|
 *   | **题库（本文件）** | 题（正文 / 难度 / 判据 / 来源） | **不认识** ← 判据会**断言**这一点 |
 *   | **实验记录（`evals/runs/`）** | 谁考的、哪一场、成绩 | **认识**（身份属于"实验"，不属于"场"） |
 *
 * ⇒ **为什么必须分开**：现在"训练场 = 臂"是耦合的（`DSH_ARM_SELF/DENY` 把"谁在场"混进了"场"）。
 *   把成绩写进题目文件里 = 又把 agent 混回场里 ⇒ **本文件禁止这样做**（判据 + 消融盯着）。
 *
 * 用法：
 *   node scripts/task-bank.mjs list                 # 列题（★ 输出里没有 agent 字段）
 *   node scripts/task-bank.mjs show <id>            # 看题（正文 + 判据）
 *   node scripts/task-bank.mjs refresh              # **一键刷新题目**：把 out/_tasks/*.md 里还没入库的导进来（幂等）
 *   node scripts/task-bank.mjs pick [--difficulty N]  # **选题**（只返回 id，不涉及谁来考）
 *   node scripts/task-bank.mjs score <id> --result pass --score 0.9 [--by <谁>] [--note "..."]  # 记成绩（写 runs，不写题目）
 *   node scripts/task-bank.mjs stats <id>           # 成绩聚合（跨实验可比）
 *   node scripts/task-bank.mjs --selftest
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const BANK_DIR = path.join(HERE, '..', 'evals', 'tasks')
export const RUNS_DIR = path.join(HERE, '..', 'evals', 'runs')
/** `refresh` 的来源：我们历史上手写的任务书目录。 */
export const INBOX_DIR = path.join(HERE, '..', 'out', '_tasks')

const slug = (s) => String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, '-').replace(/^-|-$/g, '').toLowerCase()

/**
 * ★★ 2026-09-25 精化（用户提问带来的认知修正）：
 *   用户说：*"不需要去设题库，你只是把**下一个开发目标**放进题里，然后把这个**下一个的开发环境**
 *   也放进题里（实验场）里，让他去根据这些去开发下一代……测试成绩留下来。"*
 *   ⇒ **题 = 目标 + 环境**。所以"环境"（`env`）**是题的一部分**，不是非法字段。
 * ★ 所以判据必须精化：把 **"谁"** 与 **"在哪"** 分开 ——
 *   · **禁止（谁）**：`agent / by / tester / model / provider / preset / sessionId`
 *   · **允许（在哪）**：`env`（含 `arm / dshHome / ports / isolate / profile`）
 *   ⚠️ 这不是"为了让判据通过而放宽"：**"在什么条件下开发"是题面的要求**，
 *     而 **"谁来做"不是** —— 前者决定实验怎么搭台，后者与题无关。
 */
export const AGENT_ISH_KEYS = ['agent', 'by', 'tester', 'model', 'provider', 'preset', 'sessionId']
/** 环境里**允许**出现的键（题面的一部分：在哪跑）。 */
export const ENV_KEYS = ['arm', 'dshHome', 'ports', 'isolate', 'profile', 'inherit', 'note']

export function listTasks(bankDir = BANK_DIR) {
  if (!fs.existsSync(bankDir)) return []
  return fs
    .readdirSync(bankDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const meta = path.join(bankDir, e.name, 'meta.json')
      const task = path.join(bankDir, e.name, 'task.md')
      if (!fs.existsSync(meta) || !fs.existsSync(task)) return null
      let m = {}
      try { m = JSON.parse(fs.readFileSync(meta, 'utf8')) } catch { return null }
      return { id: e.name, ...m, taskPath: task }
    })
    .filter(Boolean)
}

/** 读一道题（正文 + 判据 + 元数据）。★ 它**只读题目那一层**，不碰 runs。 */
export function getTask(id, bankDir = BANK_DIR) {
  const d = path.join(bankDir, id)
  const meta = path.join(d, 'meta.json')
  const task = path.join(d, 'task.md')
  if (!fs.existsSync(meta) || !fs.existsSync(task)) return null
  return { id, meta: JSON.parse(fs.readFileSync(meta, 'utf8')), body: fs.readFileSync(task, 'utf8') }
}

/** 记成绩 ⇒ 写 **runs**（**绝不写进题目**）。 */
export function recordScore(id, rec, runsDir = RUNS_DIR, bankDir = BANK_DIR) {
  // ★★ 修：内层必须用**传进来的** bankDir（我第一版用了默认路径 ⇒ 在临时库里记分时
  //    "题不存在" ⇒ 静默失败 ⇒ 判据④ 崩在详情串上）。典例：**同一个参数没透传**。
  if (!getTaskSafe(id, bankDir)) return { ok: false, reason: `题 ${id} 不在题库里` }
  if (!rec || !rec.result) return { ok: false, reason: '缺 result（pass/fail/error）' }
  fs.mkdirSync(runsDir, { recursive: true })
  const row = { task: id, at: rec.at ?? new Date().toISOString(), result: String(rec.result), score: rec.score === undefined ? null : Number(rec.score), by: rec.by ?? null, note: rec.note ?? '' }
  fs.appendFileSync(path.join(runsDir, `${id}.jsonl`), JSON.stringify(row) + '\n', 'utf8')
  return { ok: true, row, file: path.join(runsDir, `${id}.jsonl`) }
}
function getTaskSafe(id, bankDir = BANK_DIR) {
  return !!(id && fs.existsSync(path.join(bankDir, id, 'meta.json')) && fs.existsSync(path.join(bankDir, id, 'task.md')))
}

export function stats(id, runsDir = RUNS_DIR) {
  const f = path.join(runsDir, `${id}.jsonl`)
  if (!fs.existsSync(f)) return { task: id, n: 0, meanScore: null, results: {} }
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const sc = rows.map((r) => r.score).filter((x) => typeof x === 'number')
  const results = {}
  for (const r of rows) results[r.result] = (results[r.result] ?? 0) + 1
  return { task: id, n: rows.length, meanScore: sc.length ? Number((sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(4)) : null, results }
}

/** ★ **一键刷新题目**：把 inbox 里还没入库的 `.md` 导成题目（幂等）。
 *  ★★ 判"是不是一道**题**"要用**内容**，不能只看文件名 —— 实测：worker 写回来的
 *     **任务报告**（`*-report.md`）也被当成题导了进来（假题混进题库）。
 *  ⇒ 判据：正文里必须含任务书模板的那一节 **`## 可判定的验收`**（报告没有）。 */
export const TASK_MARKER = '## 可判定的验收'
export function refresh({ bankDir = BANK_DIR, inbox = INBOX_DIR } = {}) {
  if (!fs.existsSync(inbox)) return { imported: [], skipped: [], notATask: [] }
  const imported = []
  const skipped = []
  const notATask = []
  for (const f of fs.readdirSync(inbox).filter((n) => n.endsWith('.md'))) {
    const raw = fs.readFileSync(path.join(inbox, f), 'utf8')
    if (!raw.includes(TASK_MARKER)) { notATask.push(f); continue } // ★ 不是题（多半是报告）
    const title = (raw.split('\n').find((l) => l.startsWith('# ')) ?? `# ${f}`).replace(/^#\s*/, '').trim()
    const id = slug(path.basename(f, '.md'))
    const dir = path.join(bankDir, id)
    if (fs.existsSync(path.join(dir, 'task.md'))) { skipped.push(id); continue }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'task.md'), raw, 'utf8')
    // ★ meta = **目标(题面,在 task.md) + 环境(env)**；★ 不写"谁"（agent/arm…那是 runs 的事）
    //   `env: {inherit:true}` = "继承默认实验场"（题面没特别要求时用它；要特化就写全 env）
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ id, title, source: `out/_tasks/${f}`, difficulty: null, gates: [], tags: [], env: { inherit: true }, importedAt: new Date().toISOString() }, null, 2) + '\n',
      'utf8',
    )
    imported.push(id)
  }
  return { imported, skipped, notATask }
}

/**
 * ★★ 判"这道题**可不可执行**"：题 = **目标 + 环境** ⇒ 缺 env 就**跑不起来**。
 * 用户 2026-09-25：*"你只是把下一个开发目标放进题里，然后把这个下一个的**开发环境**也放进题里（实验场）。"*
 */
export function checkExecutable(t) {
  if (!t) return { ok: false, reason: '题不存在' }
  if (!t.title) return { ok: false, reason: '缺 title（题面没有目标）' }
  if (!t.env || typeof t.env !== 'object' || Object.keys(t.env).length === 0) {
    return { ok: false, reason: '缺 env（题面没有"在什么环境里做"）⇒ 不可执行' }
  }
  return { ok: true }
}

/** ★ 判据：题目那一层里**不得出现** agent 味道的 key（递归查 meta.json）。 */
export function findAgentLeak(bankDir = BANK_DIR) {
  const bad = []
  for (const t of listTasks(bankDir)) {
    const walk = (o, p) => {
      if (o === null || typeof o !== 'object') return
      for (const [k, v] of Object.entries(o)) {
        if (AGENT_ISH_KEYS.includes(k)) bad.push(`${t.id}.meta.json:${p}${k}`)
        walk(v, `${p}${k}.`)
      }
    }
    walk(t, '')
  }
  return bad
}

// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const TMP = path.join(HERE, '..', 'out', '_taskbank-test')
  fs.rmSync(TMP, { recursive: true, force: true })
  const bank = path.join(TMP, 'tasks'), runs = path.join(TMP, 'runs'), inbox = path.join(TMP, 'inbox')
  fs.mkdirSync(inbox, { recursive: true })
  // ★ 夹具必须**像真的任务书**（含 `## 可判定的验收` 那一节）—— 否则会被"不是题"的内容判据拒掉，
  //   而那不是 bug（真实任务书 T1/T2/T3 都有那一节）。我第一版夹具省了这一节 ⇒ 假红。
  fs.writeFileSync(path.join(inbox, 'demo-task.md'), `# 演示题：把某个文件的首行取出来\n\n## 要做什么\n用给定脚本取首行，**不要**整份读进来。\n\n## 可判定的验收\n逐条贴真实输出。\n`, 'utf8')
  const res = []
  const check = (n, ok, detail) => { res.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

  // ① refresh（一键刷新题目）
  const r1 = refresh({ bankDir: bank, inbox })
  check('① refresh 导题（幂等）', r1.imported.length === 1 && refresh({ bankDir: bank, inbox }).imported.length === 0, `首次导入 ${r1.imported.length}，二次导入 ${refresh({ bankDir: bank, inbox }).imported.length}`)
  // ② list / show
  const ts = listTasks(bank)
  check('② list 能列出题目', ts.length === 1 && !!ts[0].title, JSON.stringify(ts.map((t) => t.id)))
  const g = getTask('demo-task', bank)
  check('③ show 能读到正文', !!g && g.body.includes('验收'), g?.body?.slice(0, 24) ?? '(无)')
  // ④ ★ 记成绩写 runs、**不写题目**
  const before = fs.readFileSync(path.join(bank, 'demo-task', 'meta.json'), 'utf8')
  const sc = recordScore('demo-task', { result: 'pass', score: 0.9, by: 'whoever' }, runs, bank)
  const after = fs.readFileSync(path.join(bank, 'demo-task', 'meta.json'), 'utf8')
  check('④ 记成绩写 runs，**题目文件一字未动**', sc.ok && before === after && fs.existsSync(path.join(runs, 'demo-task.jsonl')), sc.ok ? `runs 行数=${fs.readFileSync(path.join(runs, 'demo-task.jsonl'), 'utf8').trim().split('\n').length}` : `★ 记分失败：${sc.reason}`)
  // ④b ★★ **不是题的东西不许进题库**（实测：worker 写回来的"报告"被当成题导进来了）
  fs.writeFileSync(path.join(inbox, 'some-report.md'), '# 某任务报告\n\n## 完成情况\n做完了。\n', 'utf8')
  const r2 = refresh({ bankDir: bank, inbox })
  check('④b ★ 报告（无「可判定的验收」标记）⇒ **不入库**', r2.notATask.includes('some-report.md') && !fs.existsSync(path.join(bank, 'some-report')), `notATask=${JSON.stringify(r2.notATask)}`)
  // ⑤ stats 聚合
  recordScore('demo-task', { result: 'fail', score: 0.1, by: 'another' }, runs, bank)
  const st = stats('demo-task', runs)
  check('⑤ stats 聚合（n/均分/结果分布）', st.n === 2 && st.meanScore === 0.5 && st.results.pass === 1 && st.results.fail === 1, JSON.stringify(st))
  // ⑥ ★★ **agent-agnostic 判据**：题库里不得有 agent 味道的 key
  const leak0 = findAgentLeak(bank)
  check('⑥ ★ 题库里**没有** agent 味道的字段（场 ≠ 实验）', leak0.length === 0, leak0.length ? `泄漏：${leak0.join(', ')}` : '干净')
  // ⑦ 拒绝对不存在的题记分（fail-closed）
  check('⑦ 给不存在的题记分 ⇒ 拒绝', recordScore('nope', { result: 'pass' }, runs).ok === false, '')
  // ⑦b ★ **题 = 目标 + 环境**：refresh 出来的题必须自带 env
  check('⑦b ★ refresh 出来的题**自带 env**（目标 + 环境）', checkExecutable(listTasks(bank).find((x) => x.id === 'demo-task')).ok === true, 'env:{inherit:true}')

  // ⑧ ★★ 两个消融：塞 `by` ⇒ ⑥ 变红；删 `env` ⇒ ⑦b 变红
  console.log('\n=== 消融自证 ===')
  const mf = path.join(bank, 'demo-task', 'meta.json')
  const bak = fs.readFileSync(mf, 'utf8')
  const m = JSON.parse(bak); m.by = 'leaked-agent'
  fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n', 'utf8')
  const leak1 = findAgentLeak(bank)
  fs.writeFileSync(mf, bak, 'utf8')
  const ablOk = leak1.length > 0
  console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 把 agent 字段塞进题目 ⇒ 判据⑥ 变红 ${ablOk ? '✓' : '（没变红 ⇒ 这条判据没接线）'}`)
  const m2 = JSON.parse(bak); delete m2.env
  fs.writeFileSync(mf, JSON.stringify(m2, null, 2) + '\n', 'utf8')
  const exec2 = checkExecutable(listTasks(bank).find((x) => x.id === 'demo-task'))
  fs.writeFileSync(mf, bak, 'utf8')
  const ablOk2 = exec2.ok === false
  console.log(`  ${ablOk2 ? 'ok  ' : 'FAIL'} 把 env 删掉 ⇒ 判据⑦b 变红（题不可执行）${ablOk2 ? '✓' : '（没变红）'}`)
  fs.rmSync(TMP, { recursive: true, force: true })
  const pass = res.filter((x) => x.ok).length
  const total = pass === res.length && ablOk && ablOk2
  console.log(`\n结果：判据 ${pass}/${res.length}，消融 ${ablOk && ablOk2 ? '通过（2/2）' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (argv.includes('--selftest')) process.exit(selftest())
  const cmd = argv[0]
  if (cmd === 'list') {
    const ts = listTasks()
    console.log(`题库 ${BANK_DIR}：${ts.length} 道题`)
    for (const t of ts) { const s = stats(t.id); console.log(`  ${t.id}  「${t.title}」  难度=${t.difficulty ?? '未标'}  实验次数=${s.n}${s.meanScore !== null ? `  均分=${s.meanScore}` : ''}`) }
    console.log('★ 本层只描述"题"；成绩在 evals/runs/ —— 场不认识 agent。')
    process.exit(0)
  }
  if (cmd === 'show') {
    const g = getTask(argv[1])
    if (!g) { console.error('没有这道题'); process.exit(2) }
    console.log(`==== ${g.id}「${g.meta.title}」====`);
    console.log(g.body)
    process.exit(0)
  }
  if (cmd === 'refresh') {
    const r = refresh()
    console.log(`刷新完成：新导入 ${r.imported.length} 道（${r.imported.join(', ') || '无'}）；已存在跳过 ${r.skipped.length} 道`)
    process.exit(0)
  }
  if (cmd === 'pick') {
    const ts = listTasks()
    if (!ts.length) { console.error('题库是空的 ⇒ 先 refresh'); process.exit(2) }
    const d = argOf('--difficulty')
    const pool = d ? ts.filter((t) => String(t.difficulty) === String(d)) : ts
    if (!pool.length) { console.error(`没有难度=${d} 的题`); process.exit(2) }
    console.log(pool[0].id)
    process.exit(0)
  }
  if (cmd === 'score') {
    const r = recordScore(argv[1], { result: argOf('--result'), score: argOf('--score') === null ? null : Number(argOf('--score')), by: argOf('--by'), note: argOf('--note') })
    if (!r.ok) { console.error(`[拒绝] ${r.reason}`); process.exit(1) }
    console.log(`已记录：${JSON.stringify(r.row)} → ${r.file}`)
    process.exit(0)
  }
  if (cmd === 'stats') { console.log(JSON.stringify(stats(argv[1]), null, 2)); process.exit(0) }
  console.error('[用法] list | show <id> | refresh | pick [--difficulty N] | score <id> --result … --score … [--by …] | stats <id> | --selftest')
  process.exit(2)
}
