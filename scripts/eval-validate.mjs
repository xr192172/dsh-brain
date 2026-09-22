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
 *   ★ O76（2026-09-22）：**命中数在 LF 归一化空间里数** —— 被测树是 CRLF 时不再被误判成
 *   "锚点 0 次"；替换时保持文件自身行尾风格、且只动命中那一段（见下方 `findSpans` 一节）。
 *
 * ## 用法
 *
 *   node scripts/eval-validate.mjs [--tasks evals/pilot/tasks.jsonl] [--only <id>] [--json out/eval-validate.json]
 *   node scripts/eval-validate.mjs --prepare <id>    # 只把题打坏（留给 Agent 修），写还原清单
 *   node scripts/eval-validate.mjs --restore         # 按清单还原（幂等）
 *   node scripts/eval-validate.mjs --repo <工作树> …  # ★ 判据作用于**你指定的那棵树**（R1 隔离树用它）
 *
 * ★★ `--repo <path>`（＞ 环境变量 `DSH_EVAL_REPO` ＞ 硬编码 fallback）：
 *   - **不给** ⇒ 一切照旧（`REPO` 就是原来那个字符串，判据、任务集、cwd、退出码逐字不变）。
 *   - **给了** ⇒ seed 打在 `<path>`、oracle 判 `<path>`；而**判据本身**仍从本脚本所在的
 *     **判据根**跑（因为隔离树里按 R1 没有 `scripts/`、没有 `evals/`），并用 `DSH_EVAL_REPO`
 *     把被测树告诉它。任务集在被测树里找不到时回落到判据根那一份。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
/** ★ 判据根：**本脚本所在的仓库** —— 判据（含任务集）住在这里，永远是被信的那一侧。 */
const JUDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * ★★ 2026-09-22（O69 / R1「判据必须在 Agent 够不到的地方」）——
 * 判据脚本必须能被**指向你指定的工作树**，否则隔离在原理上不可能生效
 * （旧版硬编码 `REPO='D:/project_develop/dsh-brain'` + `process.cwd` 出现 0 次 ⇒ 判据永远看主仓）。
 *
 * 优先级：`--repo <path>` ＞ 环境变量 `DSH_EVAL_REPO` ＞ **原来的硬编码值**（fallback）。
 * ★ **不许弱化判据**：两个都没给时 `REPO` **就是改动前那个字符串**、`JUDGE_ROOT` 与它同值
 *   ⇒ 路径、`cwd`、判据口径、退出码全部逐字不变。
 *
 * ## `REPO`（被测树）与 `JUDGE_ROOT`（判据根）是**两件事**
 * - `REPO`：seed 打在它身上、oracle 判的是它 —— 隔离工作树（`scripts/eval-wt-new.mjs`）就是它。
 * - `JUDGE_ROOT`：**判据从哪儿跑**。R1 要求判据不在被测树里 ⇒ 隔离树按规格排除了 `scripts/` 与 `evals/`
 *   ⇒ 被测树里**没有** `scripts/test-*.mjs`，也**没有** `evals/pilot/tasks.jsonl`。
 *   ⇒ 所以：① 子进程（oracle/regression）从 `JUDGE_ROOT` 起、用 `DSH_EVAL_REPO` 指认被测树；
 *            ② 任务集在被测树里找不到时**回落到判据根**的那一份。
 *   ⚠️ 这两条**只在显式给了 `--repo` / `DSH_EVAL_REPO` 时才生效**（不给时 `REPO === JUDGE_ROOT`，见上）。
 */
const REPO_GIVEN = argOf('--repo') ?? process.env.DSH_EVAL_REPO ?? null
const REPO = REPO_GIVEN ? path.resolve(REPO_GIVEN) : 'D:/project_develop/dsh-brain'
/** 任务集：显式 `--tasks` 优先；否则先看被测树里有没有；再回落到**判据根**（`--repo <工作树>` 时就是这条）。 */
const TASKS = (() => {
  const given = argOf('--tasks')
  if (given) return path.resolve(REPO, given)
  const local = path.resolve(REPO, 'evals/pilot/tasks.jsonl')
  if (!REPO_GIVEN || fs.existsSync(local)) return local
  return path.resolve(JUDGE_ROOT, 'evals/pilot/tasks.jsonl')
})()
const ONLY = argOf('--only')
/**
 * ★★ 判据自己的产物（**改前字节的备份** / 还原清单 / 校验报告）**绝不写进被测树**。
 *
 * 为什么是 R1 的要害：`prepare` 备份的是**改前**字节 —— 对"把已修好的改动打回去"这类题，
 * 那份备份**就是答案**。2026-09-22 实测：把它放在 `<wt>/out/eval-backup/` 里时，
 * `memory-judge-poison-check --wt <wt>` **真的把它列成了疑点**
 * （`out/eval-backup/b5593b3bb6344807-index.ts`，命中 `content/zh-expected`）——
 * 也就是"答案躺在 Agent 能读能写的目录里"。
 * ⇒ 给了 `--repo` 时，产物一律落到**判据根**的 `out/eval-wt-state/<被测树 8 位指纹>/`
 *   （**按被测树分桶**，让并发跑不同工作树时不会互相踩同一个清单）；
 *   不给 `--repo` 时就是原来的 `<REPO>/out/…`，**逐字不变**。
 */
const STATE_DIR = REPO_GIVEN
  ? path.join(JUDGE_ROOT, 'out', 'eval-wt-state', crypto.createHash('sha1').update(REPO).digest('hex').slice(0, 8))
  : path.join(REPO, 'out')
const JSON_OUT = REPO_GIVEN
  ? argOf('--json')
    ? path.resolve(argOf('--json'))
    : path.join(STATE_DIR, 'eval-validate.json')
  : path.resolve(REPO, argOf('--json') ?? 'out/eval-validate.json')
const BACKUP_DIR = path.join(STATE_DIR, 'eval-backup')
const MANIFEST = path.join(STATE_DIR, 'eval-prepare.json')

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
/** 判据（oracle / regression）一律从**判据根**跑；给了 `--repo` 才带上 `DSH_EVAL_REPO`（不给 ⇒ 与改动前同路）。 */
const run = (cmd) =>
  spawnSync(cmd[0], cmd.slice(1), {
    cwd: JUDGE_ROOT,
    ...(REPO_GIVEN ? { env: { ...process.env, DSH_EVAL_REPO: REPO } } : {}),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
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

/**
 * ── ★★ O76：seed 的**行尾容忍**（2026-09-22）───────────────────────────────
 *
 * **症状**：被测树里那个文件是 **CRLF**，而 `tasks.jsonl` 的 `find` 写的是 **LF**
 *   ⇒ 旧实现 `text.split(find).length - 1` 得 **0** ⇒ 题被误判"失效"；
 *   ★ 更坏的一档：任何**绕过这条校验**的路径都会拿到"seed 打不上 ⇒ oracle 不会红"
 *   ⇒ **假绿**（任务看起来"本来就修好了"）。这不是假红，是判据变瞎。
 *   实测（2026-09-22，`out/_wt/w26-fix`）：该文件 **CR=523**，主仓同文件 **CR=0**。
 *
 * **口径（不放松任何纪律）**：
 *   · 匹配在 **LF 归一化空间**里做（两边都把 `\r\n` → `\n`）；
 *   · **"必须恰好命中 1 次"在同一个空间里数** —— 0 次仍是"题失效"、多次仍是"会误伤"，
 *     只是**行尾风格不再参与判定**。
 *
 * **落盘（保持文件自身风格）**：只改**被命中那一段**，其余字节逐字不动；
 *   插进去的 `replace` 的行尾风格跟着**那一段在原文件里的风格**走
 *   （原文件那段是 CRLF ⇒ 插 CRLF；是 LF ⇒ 插 LF）⇒ 不会把一个 CRLF 文件顺手
 *   改写成"全 LF"或把 LF 文件改成"全 CRLF"（那等于伪造出一大堆无关改动）。
 */
const toLf = (s) => String(s).replace(/\r\n/g, '\n')

/**
 * 在**原文本**里找出（LF 归一化后）的全部命中，并映射回原文本的 `[start,end)` 区间。
 * 为什么要映射回去：只有这样才能**只动那一段**，其余字节逐字保留。
 * 归一化只吃 `\r\n`（裸 `\r` 原样留下 —— 不做超出本问题的猜测）。
 */
function findSpans(text, find) {
  const lf = toLf(text)
  const needle = toLf(find)
  if (!needle) return []
  const map = new Array(lf.length + 1)
  let j = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') continue
    map[j++] = i
  }
  map[lf.length] = text.length
  const spans = []
  for (let at = lf.indexOf(needle); at >= 0; at = lf.indexOf(needle, at + 1)) {
    spans.push([map[at], map[at + needle.length]])
    if (spans.length > 64) break // 只用于诊断；命中过多时不必数清
  }
  return spans
}

/** 命中数（**在 LF 归一化空间里数** —— 纪律与实现用同一个空间，不许两套口径）。 */
const countAnchors = (text, find) => findSpans(text, find).length

/** 把 `replace` 的行尾风格对齐到**被命中那一段**在原文件里的风格。 */
function alignEol(replace, spanText) {
  return spanText.includes('\r\n')
    ? String(replace).replace(/\r\n|\n/g, '\r\n')
    : String(replace).replace(/\r\n/g, '\n')
}

/** 对**原文本**施加一次 seed 编辑：只替换那一段；命中数 ≠ 1 ⇒ 原样返回（调用方判错）。 */
function applySeedEdit(text, find, replace) {
  const spans = findSpans(text, find)
  if (spans.length !== 1) return { text, spans }
  const [a, b] = spans[0]
  // ★ 这里是**字面插入**（不走 `String.replace` 的 `$&`/`$1` 展开），插入什么就是什么。
  return { text: text.slice(0, a) + alignEol(replace, text.slice(a, b)) + text.slice(b), spans }
}

/** 结构检查：缺字段 / 锚点出现次数不对 ⇒ 直接判这题不可用。 */
function checkShape(t) {
  const bad = []
  for (const k of ['id', 'invariant', 'seed', 'oracle', 'regression', 'budget']) if (!t[k]) bad.push(`缺字段 ${k}`)
  if (!Array.isArray(t?.seed?.edits)) bad.push('seed.edits 必须是数组')
  // ★ 2026-09-20：支持**空 seed 题**（`kind: 'capability-task'`）——
  //   这类题不是"把已提交的修复打回去"，而是"去做一件还没做的事"（能力题）。
  //   它的有效性判据不是"打 seed 后变红"，而是"**在 HEAD 上跑 oracle 必须红**"（见校验循环）。
  //   ⚠️ 空 seed 也顺手堵死了"`git checkout` 秒解"这条捷径（HEAD 里没有答案）。
  const isEmptySeed = Array.isArray(t?.seed?.edits) && t.seed.edits.length === 0
  if (isEmptySeed) {
    if (t.kind !== 'capability-task') bad.push('seed.edits 为空 ⇒ 必须是 kind="capability-task"（能力题）')
    if (t.oracle?.expectSeeded !== 'fail') bad.push('空 seed 题必须写 oracle.expectSeeded="fail"（HEAD 上就该是红的）')
  }
  if (!Array.isArray(t?.oracle?.cmd) || t.oracle.cmd.length === 0) bad.push('oracle.cmd 为空')
  if (!Array.isArray(t?.regression?.cmd) || t.regression.cmd.length === 0) bad.push('regression.cmd 为空')
  for (const e of t?.seed?.edits ?? []) {
    const abs = path.join(REPO, e.file)
    if (!fs.existsSync(abs)) {
      bad.push(`seed 目标不存在：${e.file}`)
      continue
    }
    // ★ O76：命中数在 **LF 归一化空间**里数（与 prepare 用的是同一个函数）——
    //   CRLF 文件因此不再被误判成"锚点 0 次"，而"恰好 1 次"这条纪律原样保留。
    const text = fs.readFileSync(abs, 'utf8')
    const n = countAnchors(text, e.find)
    if (n !== 1)
      bad.push(
        `seed.find 在 ${e.file} 里出现 ${n} 次（必须恰好 1 次；★ 已按 LF 归一化匹配 ⇒ 行尾风格不参与判定）：${JSON.stringify(String(e.find).slice(0, 60))}`,
      )
    if (e.find === e.replace) bad.push(`seed 的 find/replace 相同（不会改任何东西）：${e.file}`)
  }
  return bad
}

/**
 * 打 seed：**先落字节级备份，再改盘**；manifest 写成功才算这一步成功。
 * 中途任何一步抛错 ⇒ 回滚已改的文件（best-effort）并抛出，绝不留半改状态。
 */
function prepare(task) {
  // ★ 幂等：若已有清单，但**它记的文件都已经回到改前字节**（上次已经还原干净，只是清单没删掉），
  //   就直接清掉清单继续；否则才报错让人介入。
  //   为什么需要：2026-09-20 实测出现过"清单残留 ⇒ 后续 `--prepare` 连环失败"（实验台整批白跑）。
  if (fs.existsSync(MANIFEST)) {
    let stale = true
    try {
      const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
      for (const f of man.files ?? []) {
        const abs = path.join(REPO, f.file)
        if (!fs.existsSync(abs) || sha(fs.readFileSync(abs)) !== f.sha256) {
          stale = false
          break
        }
      }
    } catch {
      stale = false
    }
    if (stale) {
      fs.rmSync(MANIFEST)
      say('  · 清掉一份**已还原干净**的残留清单（幂等处理）')
    } else {
      throw new Error(`已有未还原的 seed：${MANIFEST}（先跑 --restore）`)
    }
  }
  const files = []
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  try {
    for (const e of task.seed.edits) {
      const abs = path.join(REPO, e.file)
      const before = fs.readFileSync(abs)
      const text = before.toString('utf8')
      // ★ O76：LF 归一化匹配 + **只改命中那一段**（文件其余字节逐字不动，
      //   插入的 replace 跟着那段自身在文件里的行尾风格走）⇒ CRLF 树也能打上 seed。
      const applied = applySeedEdit(text, e.find, e.replace)
      if (applied.spans.length !== 1)
        throw new Error(`seed 锚点未命中恰好 1 次（LF 归一化后 ${applied.spans.length} 次）：${e.file}`)
      const next = applied.text
      if (next === text) throw new Error(`seed 未产生变化：${e.file}`)
      const backup = path.join(BACKUP_DIR, `${sha(before)}-${path.basename(e.file)}`)
      fs.writeFileSync(backup, before) // ★ 备份的是**改前**字节
      // ★ Windows 上文件可能被瞬时占用（EPERM/EBUSY）⇒ 重试几次，别让实验因为一次瞬时锁挂掉
      for (let i = 0; ; i++) {
        try {
          fs.writeFileSync(abs, next, 'utf8')
          break
        } catch (e) {
          if (i >= 4) throw new Error(`写入失败(${e && e.code}): ${abs} —— 可能是被别的进程占用`)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250) // 同步睡 250ms（prepare 是同步函数）
        }
      }
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
  if (Array.isArray(t?.seed?.edits) && t.seed.edits.length === 0) {
    // 能力题：**没有 seed 可打** —— 明确说清（而不是"静默什么都没做"）
    say(`已 prepare ${t.id}：**本题无 seed（能力题）**，无需打坏；直接去做即可。`)
    say(`  有效性已在 HEAD 上验过：oracle 现在是红的（${t.oracle.cmd.join(' ')}）`)
    say(`\n题面（交给 Agent 的不变量描述）：\n  ${t.invariant}`)
    process.exit(0)
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
  const isEmptySeed = Array.isArray(t?.seed?.edits) && t.seed.edits.length === 0
  try {
    // ★ 能力题（空 seed）：没有"打坏"这一步 ⇒ 有效性判据换成
    //   "**在 HEAD 上跑 oracle 必须红**（= 这件事还没做）" + "regression 绿（仓库本身是好的）"。
    if (isEmptySeed) {
      const o = run(t.oracle.cmd)
      rec.seededOracle = o.status !== 0
      const reg = run(t.regression.cmd)
      rec.cleanRegression = reg.status === 0
      if (!rec.seededOracle) {
        say(`  ✗ **假题（能力题）**：在 HEAD 上 oracle 就是绿的 ⇒ 这件事本来就做完了，题没有信号`)
        failed++
        continue
      }
      if (!rec.cleanRegression) {
        say(`  ✗ 前提不成立：regression 在 HEAD 上就是红的（先把仓库修好再收题）`)
        failed++
        continue
      }
      say(`  ✓ 能力题：HEAD 上 oracle 红（${t.oracle.cmd.join(' ')}）+ regression 绿 ⇒ 有信号`)
      rec.ok = true
      // ★ 2026-09-21 修：此处原先 `results.push(rec)` —— 但 `continue` **仍会跑 finally**，
      //   而 finally 的 isEmptySeed 分支也会 push ⇒ **同一条 rec 被数两遍**。
      //   实测后果：`tasks.jsonl` 只有 4 题，报告却写"**5 题有效**"（cli-0005 重复），
      //   即**判据自身假绿**（最坏那档：你以为查过了）。
      //   ⇒ 现在 **push 只发生在 finally 里（按分支互斥，每条恰好一次）**，此处只 continue。
      continue
    }
    // ① 干净态：oracle 绿（regression 绿是前提，跑一次 oracle 就够说明这题"本来就过"）
    const o1 = run(t.oracle.cmd)
    rec.cleanOracle = o1.status === 0
    if (!rec.cleanOracle) {
      say(`  ✗ 干净态 oracle 就是红的 —— 这题的前提不成立（先修好仓库再收题）`)
      failed++
      // ★ 同上：不再在 try 内 push（单一 push 点在 finally）—— 否则这条也会被数两遍
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
    // ③ 还原 + 校验（★ 能力题没有 seed ⇒ 没有"还原"这一步，别把它的"oracle 仍红"当成异常）
    if (isEmptySeed) {
      results.push(rec)
    } else {
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
