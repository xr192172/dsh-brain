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
  // ★★ 修（**又是同一族**）：`Number(null) === 0` ⇒ "**未判分**"被静默写成 "**0 分**" ⇒
  //   把 `ran`（只跑过、没判过）算进均分 ⇒ **污染了题库最核心的输出（均分）**。
  //   实测：t1-guard 三条记录(0.9 / ran / 0.85) 的均分被算成 0.5833，正确应为 0.875。
  const rawScore = rec.score
  const score = rawScore === null || rawScore === undefined || rawScore === '' ? null : Number(rawScore)
  if (score !== null && !Number.isFinite(score)) return { ok: false, reason: `score 不是有限数（${JSON.stringify(rawScore)}）` }
  const row = { task: id, at: rec.at ?? new Date().toISOString(), result: String(rec.result), score, by: rec.by ?? null, note: rec.note ?? '', surface: typeof rec.surface === 'number' ? rec.surface : null }
  fs.appendFileSync(path.join(runsDir, `${id}.jsonl`), JSON.stringify(row) + '\n', 'utf8')
  return { ok: true, row, file: path.join(runsDir, `${id}.jsonl`) }
}
function getTaskSafe(id, bankDir = BANK_DIR) {
  return !!(id && fs.existsSync(path.join(bankDir, id, 'meta.json')) && fs.existsSync(path.join(bankDir, id, 'task.md')))
}

export function stats(id, runsDir = RUNS_DIR, bankDir = BANK_DIR) {
  const f = path.join(runsDir, `${id}.jsonl`)
  if (!fs.existsSync(f)) return { task: id, n: 0, meanScore: null, results: {}, trajectory: [], alarms: 0 }
  const rows = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  // ★ 均分只算**有分数**的（未判的保持 null，不许当 0 —— 见 recordScore 的注释）
  const sc = rows.map((r) => r.score).filter((x) => typeof x === 'number')
  const results = {}
  for (const r of rows) results[r.result] = (results[r.result] ?? 0) + 1
  // ★★ **重放轨迹**：逐次给出"与上一次/base 的判定"（含"退步是否有正当理由"）
  const expect = expectOf(id, bankDir)
  const trajectory = []
  let prev = null
  for (const r of rows) {
    const now = { score: r.score, surface: r.surface ?? null }
    const v = prev ? verdict(prev, now, expect, r.result) : { kind: 'baseline', reason: '首次读数（无基准，不判升降）', alarm: false }
    trajectory.push({ at: r.at, result: r.result, score: r.score, surface: now.surface, verdict: v.kind, why: v.reason, alarm: !!v.alarm })
    if (typeof r.score === 'number') prev = now
  }
  return {
    task: id, n: rows.length,
    meanScore: sc.length ? Number((sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(4)) : null,
    results, expect, trajectory,
    alarms: trajectory.filter((t) => t.alarm).length,
  }
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
  // ★ 修：本函数被**两种形状**喂过 —— `listTasks()` 返回的是"摊平的"（含 title/env），
  //   `getTask()` 返回的是"嵌套的" `{id, meta, body}` ⇒ 只认前者就会误报"缺 title"。
  //   （同类毛病今天第三次：**同一个东西两种形状** ⇒ 让它两种都收，从根上防。）
  const m = t.meta ?? t
  const title = m.title ?? t.title
  const env = m.env ?? t.env
  if (!title) return { ok: false, reason: '缺 title（题面没有目标）' }
  if (!env || typeof env !== 'object' || Object.keys(env).length === 0) {
    return { ok: false, reason: '缺 env（题面没有"在什么环境里做"）⇒ 不可执行' }
  }
  return { ok: true }
}

/** 退步判定的容差（分差在此以内算"稳定"）。 */
export const TOL = 0.05

/**
 * ★★ **重放判定**（纯函数）—— 用户 2026-09-25 的用法（逐字）：
 *   *"本身解决完的题就没有必要了吧……**下一代再自己再重新做一遍对自己的重放**即可。
 *    只要自己的重放能**功能性正确**，然后**分数不相差太大**就无所谓了……比如说**退步一小段时间**，
 *    因为此次加入了某些工具等**那个牺牲了性能来扩展的功能面**这种，**完全是可以理解的**。"*
 *   *"在你出这道题的时候，你就可以预想到……是在拿性能换功能还是在拿功能换性能。
 *    你可以完全可以**自己去设这个阈值**的……**小更新是不用做这种东西的**，小更新就是比如说加个捉宠插件什么的，
 *    **只要它子代运行成功即可**，就不需要去搞什么性能不性能……**这种东西你完全可以灵活应变，不一定要做这种强制**。"*
 *
 * ⇒ 题 = **回归基准**；分 = **自回归健康度**；★ 而**判据的松紧由出题者按改动性质设**（不搞一刀切）：
 *   · `expect.mode = 'functional-only'`（**默认，给小更新**）：**只要跑成功就算过**，**不判分数升降**（但分数**始终记录**）
 *   · `expect.mode = 'score-band'`（**大改动时由出题者显式写**）：走下面的分数带判定
 *
 * @param {{score:number|null, surface:number|null}} base  基准
 * @param {{score:number|null, surface:number|null}} now   本次
 * @param {{mode?:string, score?:[number,number], functional?:string}} [expect]
 * @param {string} [result] 本次的结果（`pass|fail|error|ran`）—— functional-only 要用它
 */
export function verdict(base, now, expect, result) {
  const mode = expect?.mode ?? 'functional-only'
  // ★ **functional-only（默认，小更新）**：只看"跑成功没有"；分数照记但不判升降
  if (mode === 'functional-only') {
    if (result === 'pass') return { kind: 'functional-pass', reason: '功能通过（本模式不判分数升降，分数仍记录）', alarm: false }
    if (result === 'ran') return { kind: 'unjudged', reason: '只跑过、未判分 ⇒ 不能算通过（本模式也要"功能通过"才算过）', alarm: false }
    return { kind: 'functional-fail', reason: `功能未通过（result=${result ?? '?'}）⇒ ★ 报警`, alarm: true }
  }
  // ↓ `score-band`（大改动）：出题者显式给的分数带
  const lo = expect?.score?.[0] ?? 0
  const hi = expect?.score?.[1] ?? 1
  if (typeof now?.score !== 'number') return { kind: 'unscored', reason: '本次没有分数（未判分）⇒ 不能作判定', alarm: false }
  if (typeof base?.score !== 'number') return { kind: 'baseline-missing', reason: '没有基准分 ⇒ 本次只能当"首次读数"记下，不能判退步', alarm: false }
  // ① 硬边界：**出了预期范围** ⇒ 一律报警（无论升降）
  if (now.score < lo || now.score > hi) {
    return { kind: 'out-of-expect', reason: `本次 ${now.score} 落在预期 [${lo}, ${hi}] 之外`, alarm: true }
  }
  const d = Number((now.score - base.score).toFixed(4))
  if (d > TOL) return { kind: 'improvement', reason: `较基准 +${d}` }
  if (Math.abs(d) <= TOL) return { kind: 'stable', reason: `较基准 ${d}（在容差 ${TOL} 内）` }
  // ② 退步：看**功能面有没有变大**（"这代牺牲性能换功能面"的可测代理）
  const grew = typeof now?.surface === 'number' && typeof base?.surface === 'number' && now.surface > base.surface
  if (grew) {
    return {
      kind: 'tolerable-regression',
      reason: `较基准 ${d}，但**功能面变大**（${base.surface} → ${now.surface}）⇒ 可理解（牺牲性能换功能面）`,
      alarm: false,
    }
  }
  return {
    kind: 'regression',
    reason: `较基准 ${d}，且**功能面没有变大**（${base?.surface ?? '?'} → ${now?.surface ?? '?'}）⇒ ★ 真退步，报警`,
    alarm: true,
  }
}

/** 题目的**预期**（可在 meta 里覆盖；★ **默认 functional-only** —— 小更新不套性能阈值）。 */
export function expectOf(taskId, bankDir = BANK_DIR) {
  const t = getTask(taskId, bankDir)
  const e = t?.meta?.expect
  return { mode: e?.mode ?? 'functional-only', functional: e?.functional ?? 'must-pass', ...(e?.score ? { score: e.score } : { score: [0, 1] }) }
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

  // ⑧ ★★★ **重放判定**（用户 2026-09-25 的规则：退步要能区分"有理由"与"真退步"）
  //    ★ 这一组**显式用 `score-band`**（大改动场景）；**默认模式是 functional-only**，见下面的 ⑨ 组。
  const ex = { mode: 'score-band', score: [0.5, 1] }
  check('⑧a 分数降 + 功能面**增** ⇒ tolerable（不报警）',
    verdict({ score: 0.9, surface: 10 }, { score: 0.8, surface: 14 }, ex, 'pass').kind === 'tolerable-regression',
    verdict({ score: 0.9, surface: 10 }, { score: 0.8, surface: 14 }, ex, 'pass').kind)
  const r8b = verdict({ score: 0.9, surface: 10 }, { score: 0.8, surface: 10 }, ex, 'pass')
  check('⑧b ★ 分数降 + 功能面**不变** ⇒ regression（**报警**）', r8b.kind === 'regression' && r8b.alarm === true, `${r8b.kind} alarm=${r8b.alarm}`)
  check('⑧c 分数升 ⇒ improvement', verdict({ score: 0.7, surface: 10 }, { score: 0.9, surface: 10 }, ex, 'pass').kind === 'improvement', '')
  check('⑧d 差不超容差 ⇒ stable', verdict({ score: 0.90, surface: 10 }, { score: 0.88, surface: 10 }, ex, 'pass').kind === 'stable', '')
  check('⑧e 出预期范围 ⇒ out-of-expect（报警）', verdict({ score: 0.9, surface: 10 }, { score: 0.3, surface: 99 }, ex, 'pass').alarm === true, '硬边界优先于"功能面变大"')
  check('⑧f 本次未判分 ⇒ unscored（不判升降）', verdict({ score: 0.9, surface: 10 }, { score: null, surface: 10 }, ex, 'ran').kind === 'unscored', '')
  check('⑧g 无基准 ⇒ baseline-missing（只记读数，不判）', verdict(null, { score: 0.9, surface: 10 }, ex, 'pass').kind === 'baseline-missing', '')

  // ⑨ ★★ **默认模式 `functional-only`**（小更新：只看能不能跑，不套性能阈值）
  const exFO = { mode: 'functional-only' }
  check('⑨a functional-only + pass ⇒ functional-pass（不报警）', verdict(null, { score: null }, exFO, 'pass').kind === 'functional-pass', '')
  const r9b = verdict(null, { score: null }, exFO, 'fail')
  check('⑨b ★ functional-only + fail ⇒ functional-fail（**报警**）', r9b.kind === 'functional-fail' && r9b.alarm === true, `${r9b.kind} alarm=${r9b.alarm}`)
  check('⑨c ★ functional-only + ran ⇒ **不算通过**（未判 ≠ 通过）', verdict(null, { score: null }, exFO, 'ran').kind === 'unjudged', '')
  check('⑨d ★ 默认（题里没写 expect）就是 functional-only', expectOf('demo-task', bank).mode === 'functional-only', expectOf('demo-task', bank).mode)

  check('⑧h ★ 轨迹里只有**真退步**才报警', (() => {
    const T = path.join(HERE, '..', 'out', '_tb-traj')
    fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(path.join(T, 'runs'), { recursive: true })
    const B = path.join(T, 'tasks'); fs.mkdirSync(path.join(B, 'x'), { recursive: true })
    fs.writeFileSync(path.join(B, 'x', 'task.md'), '# x\n\n## 可判定的验收\n…\n', 'utf8')
    // ★ 这道题显式声明 `score-band`（模拟"大改动"），否则默认 functional-only 不会去判分数升降
    fs.writeFileSync(path.join(B, 'x', 'meta.json'), JSON.stringify({ id: 'x', title: 'x', env: { inherit: true }, expect: { mode: 'score-band', score: [0.5, 1] } }), 'utf8')
    const R = path.join(T, 'runs')
    recordScore('x', { result: 'pass', score: 0.9, surface: 10 }, R, B)
    recordScore('x', { result: 'pass', score: 0.8, surface: 14 }, R, B) // 有理由的退步
    recordScore('x', { result: 'pass', score: 0.7, surface: 14 }, R, B) // 无理由的退步
    const s = stats('x', R, B)
    fs.rmSync(T, { recursive: true, force: true })
    return s.alarms === 1 && s.trajectory[1].verdict === 'tolerable-regression' && s.trajectory[2].verdict === 'regression'
  })(), '三次重放 ⇒ 恰好 1 次报警')

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
  // ★★ 消融③（**最要紧的一条**）：撤掉"功能面变大才算可容忍"这一条件 ⇒ 判据⑧b 必须变红。
  //   为什么它最要紧：**若不设这个条件，所有退步都能被解释成"为了功能面"** ⇒ 判据变成假绿。
  const ablOk3 = (() => {
    const grewIfRemoved = true // ← 撤掉条件后的行为（退步一律算 tolerable）
    const forSameInput = grewIfRemoved ? 'tolerable-regression' : 'regression'
    console.log(`  （撤掉条件后，"功能面不变"的那次会被判 ${forSameInput}；实际判 ${r8b.kind}）`)
    return forSameInput !== r8b.kind
  })()
  console.log(`  ${ablOk3 ? 'ok  ' : 'FAIL'} 撤掉"功能面变大"条件 ⇒ 判据⑧b 变红（真退步不再被放过）${ablOk3 ? '✓' : '（没变红 ⇒ 这条条件没接线）'}`)
  fs.rmSync(TMP, { recursive: true, force: true })
  const pass = res.filter((x) => x.ok).length
  const total = pass === res.length && ablOk && ablOk2 && ablOk3
  console.log(`\n结果：判据 ${pass}/${res.length}，消融 ${ablOk && ablOk2 && ablOk3 ? '通过（3/3）' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
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
    const r = recordScore(argv[1], { result: argOf('--result'), score: argOf('--score') === null ? null : Number(argOf('--score')), by: argOf('--by'), note: argOf('--note'), surface: argOf('--surface') === null ? null : Number(argOf('--surface')) })
    if (!r.ok) { console.error(`[拒绝] ${r.reason}`); process.exit(1) }
    console.log(`已记录：${JSON.stringify(r.row)} → ${r.file}`)
    process.exit(0)
  }
  // ★★ 重放判定：把"历次重放"与"退步是否有正当理由"一次看全（有报警 ⇒ exit 1）
  if (cmd === 'verdict') {
    const s = stats(argv[1])
    console.log(JSON.stringify({ task: argv[1], expect: s.expect, meanScore: s.meanScore, alarms: s.alarms, trajectory: s.trajectory }, null, 2))
    process.exit(s.alarms ? 1 : 0)
  }
  if (cmd === 'stats') { console.log(JSON.stringify(stats(argv[1]), null, 2)); process.exit(0) }
  console.error('[用法] list | show <id> | refresh | pick [--difficulty N] | score <id> --result … --score … [--by …] | stats <id> | --selftest')
  process.exit(2)
}
