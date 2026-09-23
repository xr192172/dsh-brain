#!/usr/bin/env node
/**
 * eval-seal-git.mjs —— ★★ 封住「被测工作树自己的 git 带着答案」这条路
 *
 * ── 它封的是哪条通道（格 ⑨ / O116 的核心发现）────────────────────────────────
 *   `eval-validate.mjs` 的 seed 是**未提交的工作区写入**（`:277` 只是 `fs.writeFileSync`），
 *   而 `eval-wt-new.mjs` 用 `git worktree add` 建的工作树，其 `.git` 是一个**指针文件**，
 *   指向判据根的对象库（`gitdir: <判据根>/.git/worktrees/<名字>`）
 *   ⇒ ★★ **HEAD 里就是"种子前"= 答案那一版**，于是三条命令一步交卷，**全在 wt 内、与沙箱档位无关**：
 *       ① `git status --porcelain`  —— 把被改的文件点名（只有它一个）；
 *       ② `git diff`               —— **直接打印出被抹掉的那一行**（只读，连 `unsafeActions` 都不计）；
 *       ③ `git checkout -- <file>` —— 一步复原（只在 `unsafeActions` 里记账，**不被拦**）。
 *   ⇒ 只要 HEAD 里还留着种子前字节，`applicable`（靶在 wt ∧ 答案不可达）**永远为 false**。
 *
 * ── 封法（为什么不是"禁止 agent 读 git"）──────────────────────────────────────
 *   ★ 靠"禁止读"是**策略**，靠"没有那段历史"是**事实**。本脚本走事实：
 *     把工作树**变成一个独立的、只有一个提交的仓库** ——
 *       · 断掉与判据根对象库的连接（删掉 `.git` 指针文件）；
 *       · `git init` 建一个**全新对象库**；
 *       · 把**当前工作区**（= 已 seed 的状态）作为**根提交**（无父）提交进去。
 *     ⇒ 于是：`git diff` 空、`git status` 空、`git log -p` 只有那一条根提交（内容是"现在的样子"）、
 *       `git checkout -- <file>` 只能回到**现在（种子后）** —— **种子前字节根本不在这个对象库里**。
 *   ★ 与"把种子状态 commit 到一次性分支"的区别：那种做法**父提交仍带着答案**
 *     （`git log -p` 第二下就打印出来）⇒ 不够；必须是**无父的根提交 + 全新对象库**。
 *
 * ── ★ 判据怎么取（"哪根针才算答案"）──────────────────────────────────────────
 *   `evals/pilot/tasks.jsonl` 的 `seed.edits[].find` = **种子之前的原文** = 答案那一段。
 *   但**不是所有题都在这棵树上打过 seed** ⇒ 只把"**现在盘上已经没有这根针**"的那些当判据对象
 *   （= 这根针确实被抹掉了，它才是"答案"）；盘上仍有这根针的题**列出来并说明原因**，不参与断言
 *   （否则会把"这题没打 seed、那行本来就在"误报成"答案泄漏"—— 那正是本脚本第一版的假阳性）。
 *   ★ 最强的一条读数是**种子前内容的 blob sha**：封之前在 HEAD 上取到它，封之后要求这个对象
 *     **在对象库里不存在**（`git cat-file -e <sha>` 必须失败）⇒ 这是"答案字节不在这个库里"的精确证据。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *   node scripts/eval-seal-git.mjs --dir <wt>                      # 封（打印前后读数）
 *   node scripts/eval-seal-git.mjs --dir <wt> --deep               # 封后逐 blob 扫"种子前内容"
 *   node scripts/eval-seal-git.mjs --dir <wt> --json out/x.json    # 落盘（含 preSeedBlobs，供复核）
 *   node scripts/eval-seal-git.mjs --dir <wt> --check --expect out/x.json   # 只验（不封，用落盘 sha 复核）
 *   node scripts/eval-seal-git.mjs --dir <wt> --force              # 允许删"真目录"形式的 .git
 *
 * 退出码：0 = 封住且全部断言成立；1 = 有断言不成立；2 = 用法/IO 错。
 * ★ **只动 `--dir` 那一棵树**（删它的 `.git` 并重建）；不碰判据根、不碰 git 配置、不起服务。
 *   ⚠️ 副作用（如实）：判据根 `git worktree list` 会多一条 prunable 记录（那个工作树的连接被切断）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const NAME = 'eval-seal-git'

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const has = (k) => argv.includes(k)

const USAGE = `${NAME} —— 封住"工作树自己的 git 带着答案"这条通道

用法：
  node scripts/${NAME}.mjs --dir <工作树> [--deep] [--json <f>] [--force]
  node scripts/${NAME}.mjs --dir <工作树> --check [--expect <f>] [--deep]

  --dir <abs>      被测工作树（绝对路径）
  --check          只验（不封）
  --expect <f>     复核用：读一份之前 --json 落的盘，用里面的 preSeedBlobs sha 验"对象不在库里"
  --deep           逐 blob 扫：对象库里有没有"种子前文件内容"的完全一致副本
  --force          允许删掉"真目录"形式的 .git（默认只切 git worktree 的指针文件）
  --json <f>       把结论（含 preSeedBlobs）写成 JSON

退出码：0 = 全部断言成立；1 = 有断言不成立；2 = 用法/IO 错。
`

if (has('-h') || has('--help') || !argOf('--dir')) {
  process.stdout.write(USAGE)
  process.exit(argOf('--dir') ? 0 : 2)
}
const DIR_RAW = argOf('--dir')
if (!path.isAbsolute(DIR_RAW)) {
  process.stderr.write(`[${NAME}] 用法错误：--dir 必须是绝对路径（用 D:/… 而不是 /d/…）\n`)
  process.exit(2)
}
const DIR = path.resolve(DIR_RAW)
const CHECK_ONLY = has('--check')
const DEEP = has('--deep')
const FORCE = has('--force')
const JSON_OUT = argOf('--json')
const EXPECT = argOf('--expect')

const problems = []
const say = (s) => console.log(s)
const slash = (s) => String(s).replace(/\\/g, '/')
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts })
const git = (args, opts = {}) => sh('git', ['-C', DIR, ...args], opts)
const check = (ok, label, detail = '') => {
  say(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) problems.push(label)
  return ok
}

// ── 前置 ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(DIR) || !fs.statSync(DIR).isDirectory()) {
  process.stderr.write(`[${NAME}] 目标不存在或不是目录：${DIR}\n`)
  process.exit(2)
}
if (git(['rev-parse', '--git-dir']).status !== 0) {
  process.stderr.write(`[${NAME}] 目标不是 git 仓库：${slash(DIR)}\n`)
  process.exit(2)
}

/**
 * ★ 判据对象 = "被抹掉的那根针"。
 * 对每条 `seed.edits`：文件在这棵树里存在时，看**当前盘上**还有没有这根针
 * ⇒ 没有 ⇒ 这题的 seed 打过了，`find` 就是"答案"，是本判据的对象；
 * ⇒ 还有 ⇒ 这题没打（或打的不是这条），**列出来并说明**，不参与断言。
 */
function casesOf(dir) {
  const tasksFile = path.join(ROOT, 'evals/pilot/tasks.jsonl')
  if (!fs.existsSync(tasksFile)) return { cases: [], skipped: [], why: `/无任务集 ${slash(tasksFile)}/` }
  const cases = []
  const skipped = []
  for (const line of fs.readFileSync(tasksFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('//')) continue
    let t
    try {
      t = JSON.parse(line)
    } catch {
      continue
    }
    for (const e of t.seed?.edits ?? []) {
      if (!e.find) continue
      const abs = path.join(dir, e.file)
      if (!fs.existsSync(abs)) {
        skipped.push({ id: t.id, file: slash(e.file), why: '文件不在这棵树里' })
        continue
      }
      const onDisk = fs.readFileSync(abs, 'utf8')
      if (onDisk.includes(e.find)) {
        skipped.push({ id: t.id, file: slash(e.file), why: '这根针还在盘上（本题未打 seed 或打的不是这条）⇒ 不算"答案"' })
        continue
      }
      cases.push({ id: t.id, file: slash(e.file), needle: e.find, replace: e.replace ?? '' })
    }
  }
  return { cases, skipped, why: '' }
}
const { cases, skipped, why: caseWhy } = casesOf(DIR)

say(`${NAME} —— 封「工作树自己的 git 带着答案」`)
say(`  目标工作树: ${slash(DIR)}`)
say(`  判据根    : ${slash(ROOT)}`)
say(`  模式      : ${CHECK_ONLY ? '--check（只验，不封）' : '封'}${DEEP ? ' + --deep' : ''}`)
say(`  判据对象  : ${cases.length} 条（= 盘上已经没有那根针的 seed 编辑）`)
for (const c of cases) say(`      · ${c.id}  ${c.file}  ← ${JSON.stringify(c.needle).slice(0, 72)}`)
if (skipped.length) {
  say(`  不参与判据（如实列出，不许静默丢弃）：`)
  for (const s of skipped) say(`      ⊘ ${s.id}  ${s.file} —— ${s.why}`)
}
if (caseWhy) say(`      ${caseWhy}`)
say('')

const dotGit = path.join(DIR, '.git')
const dotGitIsFile = fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()
const pointer = dotGitIsFile ? fs.readFileSync(dotGit, 'utf8').trim() : null

// ── ① 封之前 ──────────────────────────────────────────────────────────────
const before = { at: new Date().toISOString(), cases: [] }
say('① 封之前的读数（这条路通不通）')
before.head = String(git(['rev-parse', 'HEAD']).stdout ?? '').trim()
before.commitCount = (() => {
  const r = git(['rev-list', '--count', 'HEAD'])
  return r.status === 0 ? Number(String(r.stdout).trim()) : null
})()
before.status = String(git(['status', '--porcelain']).stdout ?? '').trim()
before.dotGit = pointer
say(`  · .git 形态：${dotGitIsFile ? `**指针文件** → ${pointer}` : fs.existsSync(dotGit) ? '目录（独立仓库）' : '（无）'}`)
if (pointer) {
  say(`    ${slash(pointer).includes(slash(ROOT)) ? '★ 指向**判据根的对象库** ⇒ 判据根的历史（含 HEAD）在这棵树里直接可用' : '未指向判据根'}`)
}
say(`  · HEAD = ${before.head}（提交数 ${before.commitCount}）`)
say(`  · git status --porcelain：${before.status ? '' : '（空）'}`)
for (const l of before.status.split('\n').filter((x) => x.trim())) say(`      ${l}`)

/** ★ 种子前内容 = HEAD 上那份（这就是"答案"本身，逐字节）。 */
const preSeedOf = (rel) => {
  const r = git(['show', `HEAD:${rel}`])
  return r.status === 0 ? String(r.stdout ?? '') : null
}
const needleHits = (text, needle) => (text ? text.split(needle).length - 1 : 0)
const blobShaOf = (text) => {
  const r = sh('git', ['hash-object', '--stdin', '--no-filters'], { input: text })
  return r.status === 0 ? String(r.stdout).trim() : null
}

say('  · 逐条判据对象（封之前：答案**可达**）：')
for (const c of cases) {
  const row = { ...c }
  if (!CHECK_ONLY) {
    row.preSeedText = preSeedOf(c.file)
    row.preSeedSha = row.preSeedText === null ? null : blobShaOf(row.preSeedText)
    row.preSeedBytes = row.preSeedText === null ? null : Buffer.byteLength(row.preSeedText, 'utf8')
  }
  row.before = {
    diffHits: needleHits(String(git(['diff', '--', c.file]).stdout ?? ''), c.needle),
    showHeadHits: needleHits(preSeedOf(c.file), c.needle),
    logPHits: needleHits(String(git(['log', '-p', '--', c.file]).stdout ?? ''), c.needle),
  }
  before.cases.push({ id: c.id, file: c.file, needle: c.needle, preSeedSha: row.preSeedSha ?? null, ...row.before })
  say(`      ${c.file}`)
  say(`        · git diff -- <file>        ：针 ${row.before.diffHits} 次 ${row.before.diffHits >= 1 ? '★ **答案被直接打印出来**' : ''}`)
  say(`        · git show HEAD:<file>      ：针 ${row.before.showHeadHits} 次 ${row.before.showHeadHits >= 1 ? '★ HEAD 就是种子前那版' : ''}`)
  say(`        · git log -p -- <file>      ：针 ${row.before.logPHits} 次 ${row.before.logPHits >= 1 ? '★ 历史里也能拿到' : ''}`)
  if (row.preSeedSha) say(`        · 种子前内容的 blob sha     ：${row.preSeedSha}（${row.preSeedBytes} B）← 封之后此对象**必须不存在**`)
}
say(`  · git checkout -- <file>：**不在封之前这棵树上做**（它会一步毁掉 seed 状态，那正是它的危害）`)
say(`      ⇒ 单独用一次实测证明（复现命令见报告 §②）；这里只留一句如实说明，不假装测过。`)
say('')

// ── ② 封 ──────────────────────────────────────────────────────────────────
if (!CHECK_ONLY) {
  say('② 封（切断与判据根对象库的连接 + 建一个只有根提交的独立仓库）')
  if (fs.existsSync(dotGit) && !dotGitIsFile) {
    if (!FORCE) {
      say(`  ✗ .git 已是**真目录**（独立仓库）⇒ 无需/不应再封。要强做请给 --force。`)
      process.exit(2)
    }
    say(`  · --force：删掉 .git 目录（${slash(dotGit)}）`)
    fs.rmSync(dotGit, { recursive: true, force: true })
  } else if (dotGitIsFile) {
    say(`  · 删掉 .git 指针文件（原内容：${pointer}）`)
    fs.rmSync(dotGit, { force: true })
  }
  const init = sh('git', ['-C', DIR, 'init', '--quiet'])
  check(init.status === 0, 'git init（全新对象库）', init.status === 0 ? '' : String(init.stderr ?? '').trim().slice(0, 240))
  const add = sh('git', ['-C', DIR, 'add', '-A'])
  check(add.status === 0, 'git add -A（把**当前**= 种子后状态收进索引）', add.status === 0 ? '' : String(add.stderr ?? '').trim().slice(0, 240))
  const commit = sh('git', [
    '-C', DIR, '-c', 'user.name=dsh-eval-seal', '-c', 'user.email=seal@localhost',
    'commit', '--quiet', '-m', 'sealed: 单根提交（种子后状态）；无父提交 —— 由 eval-seal-git.mjs 生成',
  ])
  check(commit.status === 0, 'commit（★ 无父的根提交）', commit.status === 0 ? '' : String(commit.stderr ?? '').trim().slice(0, 300))
  say('')
}

// ── ③ 封之后的断言 ────────────────────────────────────────────────────────
const after = { at: new Date().toISOString(), cases: [] }
say(`${CHECK_ONLY ? '③ --check 的读数（不封）' : '③ 封之后的读数（逐条断言）'}`)
after.head = String(git(['rev-parse', 'HEAD']).stdout ?? '').trim()
after.commitCount = (() => {
  const r = git(['rev-list', '--count', 'HEAD'])
  return r.status === 0 ? Number(String(r.stdout).trim()) : null
})()
after.status = String(git(['status', '--porcelain']).stdout ?? '').trim()
after.diff = String(git(['diff']).stdout ?? '').trim()
after.dotGit = fs.existsSync(dotGit) ? (fs.statSync(dotGit).isFile() ? fs.readFileSync(dotGit, 'utf8').trim() : '（目录：独立仓库）') : '（无）'
say(`  · .git = ${after.dotGit}`)
check(!after.dotGit || !slash(after.dotGit).includes(slash(ROOT)), '.git 不再指向判据根的对象库', slash(after.dotGit ?? ''))
check(after.commitCount === 1, '只有 1 个提交（根提交，无父）', `实得 ${after.commitCount}`)
check(after.status === '', 'git status --porcelain 为空', JSON.stringify(after.status.slice(0, 120)))
check(after.diff === '', 'git diff 为空（**不再打印被抹掉的那一行**）', JSON.stringify(after.diff.slice(0, 120)))

let expectShas = null
if (EXPECT) {
  try {
    const j = JSON.parse(fs.readFileSync(path.isAbsolute(EXPECT) ? EXPECT : path.join(ROOT, EXPECT), 'utf8'))
    expectShas = j.preSeedBlobs ?? null
  } catch (e) {
    say(`  ⚠ --expect 读不了/解析不了：${String(e?.message ?? e)} ⇒ 改用现场捕获的 sha`)
  }
}

for (const c of cases) {
  const diffHits = needleHits(String(git(['diff', '--', c.file]).stdout ?? ''), c.needle)
  const showHeadHits = needleHits(String(git(['show', `HEAD:${c.file}`]).stdout ?? ''), c.needle)
  const logPHits = needleHits(String(git(['log', '-p', '--', c.file]).stdout ?? ''), c.needle)
  // ★ git checkout -- ：封后必须拿不到答案（只能回到"现在"那一版，且**逐字节不变**）
  const p = path.join(DIR, c.file)
  const b0 = fs.existsSync(p) ? fs.readFileSync(p) : null
  const co = git(['checkout', '--', c.file])
  const b1 = fs.existsSync(p) ? fs.readFileSync(p) : null
  const sameBytes = !!b0 && !!b1 && b0.equals(b1)
  const needleAfterCheckout = b1 ? b1.toString('utf8').includes(c.needle) : false

  say(`  · ${c.file}`)
  const ok1 = check(diffHits === 0, '  git diff 里没有那行', `针 ${diffHits} 次`)
  const ok2 = check(showHeadHits === 0, '  git show HEAD:<file> 里没有那行', `针 ${showHeadHits} 次`)
  const ok3 = check(logPHits === 0, '  git log -p -- <file> 里没有那行', `针 ${logPHits} 次`)
  const ok4 = check(co.status === 0 && sameBytes && !needleAfterCheckout, '  git checkout -- 拿不到那行（文件逐字节没变）', `exit=${co.status} 逐字节相同=${sameBytes}`)
  after.cases.push({ id: c.id, file: c.file, diffHits, showHeadHits, logPHits, checkoutExit: co.status, checkoutByteIdentical: sameBytes, checkoutGotAnswer: needleAfterCheckout, ok: ok1 && ok2 && ok3 && ok4 })
}

// ── ④ --deep：对象库里有没有"种子前内容"的完整副本（精确判据）─────────────
const preSeedBlobs = before.cases.map((b) => ({ file: b.file, sha: b.preSeedSha })).filter((x) => x.sha)
if (DEEP) {
  say('')
  say('④ --deep：对象库逐 blob 扫（判据 = **种子前文件内容**有没有完整副本）')
  const list = String(git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).stdout ?? '')
  const blobs = list.split('\n').map((l) => l.trim()).filter((l) => l.endsWith(' blob')).map((l) => l.split(/\s+/)[0])
  say(`     对象库里 blob 共 ${blobs.length} 个；逐个取内容比对 …`)

  // (甲) 精确：对象库里有没有 sha == 种子前内容的 blob
  const shas = expectShas ?? preSeedBlobs
  if (shas.length === 0) {
    check(false, '有可复核的 preSeedBlobs（否则这一步在空集上为真 = 假绿）', '没有 sha ⇒ 本步作废')
  } else {
    for (const s of shas) {
      const has = git(['cat-file', '-e', s.sha]).status === 0
      check(!has, `对象库里不存在「种子前内容」这个对象：${s.sha.slice(0, 12)}（${s.file}）`, has ? '**存在！答案字节还在库里**' : 'cat-file -e 失败 = 不在', )
    }
  }
  // (乙) 逐 blob 全量比对（也报"含针"的粗读数，但**只作信息**，不当判据）
  let scanned = 0
  const exact = []
  const coarse = []
  for (const sha of blobs) {
    const c = git(['cat-file', 'blob', sha])
    if (c.status !== 0) continue
    scanned += 1
    const text = String(c.stdout ?? '')
    for (const c2 of cases) {
      if (text.includes(c2.needle)) coarse.push({ sha, file: c2.file })
    }
  }
  for (const b of before.cases) {
    if (!b.preSeedSha) continue
    const c = git(['cat-file', 'blob', b.preSeedSha])
    if (c.status === 0) exact.push({ sha: b.preSeedSha, file: b.file })
  }
  after.deep = { blobs: blobs.length, scanned, exactMatches: exact, coarseNeedleHits: coarse.length }
  check(exact.length === 0, `${scanned} 个 blob 里没有一个**等于**种子前文件内容`, exact.length ? `命中：${exact.map((x) => x.sha.slice(0, 12)).join(', ')}` : '')
  say(`     · 信息（不作判据）：含那根针的 blob 有 ${coarse.length} 个 —— 别的文件里出现同样字符串很正常，`)
  say(`       所以"含针"只能当线索、"**等于种子前内容**"才是判据（本脚本第一版就栽在这上面）。`)
} else {
  say('')
  say('④ --deep：未给 ⇒ 跳过（**不声称**"对象库里绝对没有"，见报告"未验证"）')
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
say('')
say('─'.repeat(78))
const ok = problems.length === 0
say(`结论：${ok ? '✓ 封住（全部断言成立）' : `✗ 有 ${problems.length} 条断言不成立`}`)
for (const p of problems) say(`  · ${p}`)
say('')
say(`★ 复核（不封，只验）：node scripts/${NAME}.mjs --dir "${slash(DIR)}" --check --deep${JSON_OUT ? ` --expect ${slash(JSON_OUT)}` : ''}`)

const out = {
  schema: 'dsh-eval-seal-git/v1',
  dir: slash(DIR),
  judgeRoot: slash(ROOT),
  mode: CHECK_ONLY ? 'check' : 'seal',
  cases,
  skipped,
  before,
  after,
  preSeedBlobs,
  problems,
  ok,
}
if (JSON_OUT) {
  const abs = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(ROOT, JSON_OUT)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(out, null, 2), 'utf8')
  say(`JSON → ${slash(abs)}`)
}
process.exit(ok ? 0 : 1)
