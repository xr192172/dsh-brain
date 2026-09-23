#!/usr/bin/env node
/**
 * evals/checks/cli-0007.mjs —— cli-0007 的 oracle（**行为级：真跑它产出的东西**）
 *
 * ## 题目（题面 = tasks.jsonl 里那条的 `invariant`）
 *
 * **照 cli-0006 同一套模式**再做一个护栏，但对象换成 `store.js` 的**存储层行为面**
 * （`put`/`get`/`size`），读数由做题者**自己设计 5 条**（不许照抄 `--selftest` 那 5 行），
 * 并且比第一题**多三条硬约束**：
 *   ③ 基线格式**钉死**：UTF-8 / LF / 一行一条 / `<条目名>\t<原始读数>` / 恰好一个 TAB / 末行有换行；
 *   ④ `drift` **只列真的漂了的**条目，且**按条目名升序**（JS `a < b` 那种字典序）；
 *   ⑤ 基线文件**不存在**时 `--check` 必须退出 **2**（与"有漂移"的非零、非 2 区分开）。
 *
 * ## 为什么它是行为级（三档强度）
 *   · 档 1：record → check 绿 → **按钉子格式篡改一条** → check 必须红；
 *   · 档 2：`--json` 的 `drift` 必须**逐字**等于被改坏的那些条目名（顺带验"升序"与"只列漂了的"）；
 *   · 档 3（★）：在**临时副本**里改坏 `store.js` 的身份派生式 ⇒ 同一基线再查必须红
 *     （证明读数真挂在 `store.js` 的行为上，而不是读两遍文件）。
 *   ★ 另有一条**格式**判据（D2/D3）—— 它不是"文件里有没有某字符串"，而是**解析它产出的基线**
 *     再拿去喂回被测工具（格式是题面钉死的，解析得出来才谈得上后面几档）。
 *
 * ## 纪律
 * · **只读被测树**：临时目录建在 `os.tmpdir()`，跑完删；不改被测树、不写 `~/.dsh`。
 * · **判不了 ≠ 通过**：靶/交付物不在指定树里 ⇒ 大声报错 + 非零退出。
 *
 * 用法：node evals/checks/cli-0007.mjs
 *       node evals/checks/cli-0007.mjs --repo <被测工作树>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url))
function resolveRepoArgv() {
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--repo') return { repo: a[i + 1] ?? null, src: '--repo' }
    if (a[i].startsWith('--repo=')) return { repo: a[i].slice('--repo='.length), src: '--repo=' }
  }
  if (process.env.DSH_EVAL_REPO) return { repo: process.env.DSH_EVAL_REPO, src: 'DSH_EVAL_REPO（环境变量）' }
  return { repo: path.resolve(HERE_DIR, '../..'), src: '自身相对路径（默认 = 判据根）' }
}
const _resolved = resolveRepoArgv()
const REPO = path.resolve(_resolved.repo ?? '')
const DIR = path.join(REPO, 'evals', 'pilot', 'rename-target')
const INDEX = path.join(DIR, 'index.js')
const STORE = path.join(DIR, 'store.js')
const GUARD = path.join(DIR, 'store-guard.mjs')
const GUARD_SELFTEST = path.join(DIR, 'store-guard.selftest.mjs')

console.log('cli-0007 oracle —— REPO = ' + REPO.replace(/\\/g, '/'))
console.log('  来源：' + _resolved.src)
console.log('  靶目录：' + DIR.replace(/\\/g, '/'))
console.log('  交付物：' + GUARD.replace(/\\/g, '/') + '  存在=' + fs.existsSync(GUARD))
console.log('          ' + GUARD_SELFTEST.replace(/\\/g, '/') + '  存在=' + fs.existsSync(GUARD_SELFTEST))
console.log('')

const BASELINE_SELFTEST = ['h=1a47e90b', 'd=computeHash-v1/1a47e90b', 'put/get=one@computeHash-v1', 'size=1', 'legacy=legacy:computeHash-v1']
/** `--selftest` 那 5 行的（条目名, 读数）对 —— 用于判"是不是把它照抄成了基线"（题面 ①）。 */
const SELFTEST_PAIRS = [
  { name: 'h', value: '1a47e90b' },
  { name: 'd', value: 'computeHash-v1/1a47e90b' },
  { name: 'put/get', value: 'one@computeHash-v1' },
  { name: 'size', value: '1' },
  { name: 'legacy', value: 'legacy:computeHash-v1' },
]
const MIN_ENTRIES = 5

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-0007-oracle-'))
const BASE = path.join(TMP, 'store-baseline.txt')
const MISSING = path.join(TMP, '绝不存在的基线文件.txt')
let pass = 0
let fail = 0
const say = (ok, id, what, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + id.padEnd(4) + ' ' + what + (detail ? '  —— ' + detail : ''))
  if (ok) pass += 1
  else fail += 1
}
const short = (s, n) => String(s ?? '').replace(/\r\n/g, '\n').trim().split('\n').slice(0, 4).join(' | ').slice(0, n ?? 220)
const run = (args, cwd) => spawnSync(process.execPath, args, { cwd: cwd ?? REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 })
const jsonOf = (stdout) => {
  try {
    return { obj: JSON.parse(stdout ?? ''), err: '' }
  } catch (e) {
    return { obj: null, err: String(e.message).slice(0, 100) }
  }
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** 按题面钉子解析基线：UTF-8 / 纯 LF / 每行恰好一个 TAB / 末行有换行。 */
function parsePinned(text) {
  const problems = []
  if (text.includes('\r')) problems.push('含 CR（必须纯 LF）')
  if (!text.endsWith('\n')) problems.push('末行没有换行')
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const raw = body.split('\n')
  const rows = []
  for (const l of raw) {
    const tabs = (l.match(/\t/g) ?? []).length
    if (tabs !== 1) {
      problems.push('行 ' + (rows.length + 1) + ' 的 TAB 数为 ' + tabs + '（必须恰好 1）：' + JSON.stringify(l.slice(0, 40)))
      continue
    }
    const [name, value] = l.split('\t')
    if (!name.trim() || !value.trim()) {
      problems.push('行 ' + (rows.length + 1) + ' 有空字段')
      continue
    }
    rows.push({ name, value })
  }
  const names = rows.map((r) => r.name)
  if (new Set(names).size !== names.length) problems.push('条目名有重复')
  if (rows.length < MIN_ENTRIES) problems.push('条目数 ' + rows.length + ' < ' + MIN_ENTRIES)
  return { rows, problems }
}
const writeLines = (rows) => rows.map((r) => r.name + '\t' + r.value).join('\n') + '\n'

try {
  if (!fs.existsSync(INDEX) || !fs.existsSync(STORE)) {
    console.log('cli-0007 oracle：**不合格** —— 指定树里缺靶文件（' + DIR.replace(/\\/g, '/') + '）⇒ 判不了（不弱化：判不了 ≠ 通过）')
    process.exit(1)
  }
  if (!fs.existsSync(GUARD)) {
    console.log('cli-0007 oracle：**不合格** —— 交付物 `store-guard.mjs` 不存在（' + GUARD.replace(/\\/g, '/') + '）⇒ 没有可跑的东西')
    process.exit(1)
  }

  // ── H1 旧行为冻结（题面 ⑥）──────────────────────────────────────────────
  {
    const r = run([INDEX, '--selftest'], REPO)
    const got = String(r.stdout ?? '').replace(/\r\n/g, '\n').trim()
    const want = BASELINE_SELFTEST.join('\n')
    say(r.status === 0 && got === want, 'H1', '既有行为冻结：index.js --selftest 逐字等于基线（exit=0）',
      r.status === 0 && got === want ? '' : 'exit=' + r.status + '  实得：' + short(got))
  }

  // ── H2 基线格式被钉子钉住（题面 ③）──────────────────────────────────────
  let rows = []
  {
    const r = run([GUARD, '--record', BASE], REPO)
    const exists = fs.existsSync(BASE)
    say(r.status === 0 && exists, 'H2a', 'store-guard.mjs --record <基线> ⇒ 退出 0 且文件非空',
      r.status === 0 && exists ? 'size=' + fs.statSync(BASE).size : 'exit=' + r.status + '  ' + short(r.stderr || r.stdout))
    const text = exists ? fs.readFileSync(BASE, 'utf8') : ''
    const parsed = parsePinned(text)
    rows = parsed.rows
    say(parsed.problems.length === 0, 'H2b', '基线格式合规：纯 LF / 一行一条 / 每行恰好一个 TAB / 末行换行 / ≥' + MIN_ENTRIES + ' 条',
      parsed.problems.length ? parsed.problems.slice(0, 3).join(' ｜ ') : '条目：' + rows.map((x) => x.name).join(', '))
    // ★ 判据是"**不是**把 `--selftest` 那 5 行逐字搬成基线"（题面 ①："不许照抄"）。
    //   刻意写成"整份等于才算抄" —— 避免把"自己设计的读数里恰好有个值也是 1"误判成抄。
    const copied = rows.length === SELFTEST_PAIRS.length && SELFTEST_PAIRS.every((p) => rows.some((r) => r.name === p.name && r.value === p.value))
    say(rows.length > 0 && !copied, 'H2c', '测的是**另一套**读数：基线不是 --selftest 那 5 行的逐字复制（题面 ①）',
      rows.length === 0 ? '基线没解析出一条' : copied ? '基线 = --selftest 那 5 行的逐字复制' : '')
  }

  // ── H3 未漂移 ⇒ 绿 ─────────────────────────────────────────────────────
  {
    const r = run([GUARD, '--check', BASE], REPO)
    say(r.status === 0, 'H3', '--check <刚记的基线> ⇒ 退出 0（无漂移）', r.status === 0 ? '' : 'exit=' + r.status + '  ' + short(r.stderr || r.stdout))
  }

  if (rows.length < MIN_ENTRIES) {
    say(false, 'H4', '★ 篡改一条 ⇒ 非零（漂移检出）', '基线没解析出 ' + MIN_ENTRIES + ' 条 ⇒ 后续判据无法进行')
    say(false, 'H5', '★ drift **恰好**点名被改坏的那一条', '同上')
    say(false, 'H6', '★ drift 只列漂了的且按条目名升序', '同上')
  } else {
    const p = rows[0]
    // ── H4/H5 篡改**一条** ⇒ 红 + JSON drift 恰好点名它 ──────────────────────
    fs.writeFileSync(BASE, writeLines(rows.map((r, i) => (i === 0 ? { name: r.name, value: r.value + 'X' } : r))), 'utf8')
    const plain = run([GUARD, '--check', BASE], REPO)
    say(plain.status !== 0 && plain.status !== 2, 'H4', '★ 按钉子格式篡改一条后 --check ⇒ 非零且 ≠2（= 漂移，不是前置错）',
      plain.status !== 0 && plain.status !== 2 ? 'exit=' + plain.status : 'exit=' + plain.status + '  ' + short(plain.stderr || plain.stdout))
    {
      const r = run([GUARD, '--json', '--check', BASE], REPO)
      const { obj, err } = jsonOf(r.stdout)
      const ok = obj !== null && obj.mode === 'check' && obj.ok === false && deepEq(obj.drift, [p.name]) && typeof obj.detail === 'string' && obj.detail.trim() !== ''
      say(ok, 'H5', '★ --json 的 `drift` **恰好** [' + JSON.stringify(p.name) + ']（只列漂了的，且点名到位）',
        ok ? '' : obj === null ? '解析失败：' + err : 'drift=' + JSON.stringify(obj.drift) + ' ok=' + JSON.stringify(obj.ok))
    }

    // ── H6 再篡改**第三行** ⇒ drift 必须是两条、且按条目名字典序 ─────────────
    {
      const q = rows[2]
      const want = [p.name, q.name].sort()
      fs.writeFileSync(BASE, writeLines(rows.map((r, i) => (i === 0 || i === 2 ? { name: r.name, value: r.value + 'Y' } : r))), 'utf8')
      const r = run([GUARD, '--json', '--check', BASE], REPO)
      const { obj, err } = jsonOf(r.stdout)
      const ok = obj !== null && deepEq(obj.drift, want)
      say(ok, 'H6', '★ 改坏两条 ⇒ drift 恰好 ' + JSON.stringify(want) + '（只列漂了的 + 按条目名升序）',
        ok ? '' : obj === null ? '解析失败：' + err : 'drift=' + JSON.stringify(obj.drift))
    }
  }

  // ── H7 基线不存在 ⇒ 退出 2（与"漂移"区分）────────────────────────────────
  {
    const r = run([GUARD, '--check', MISSING], REPO)
    say(r.status === 2, 'H7', '★ 基线文件不存在时 --check ⇒ 退出码 **2**（前置/用法错，与漂移的非零区分）',
      r.status === 2 ? '' : 'exit=' + r.status + '  ' + short(r.stderr || r.stdout))
  }

  // ── H8 它自己的自测（题面 ⑦）────────────────────────────────────────────
  if (!fs.existsSync(GUARD_SELFTEST)) {
    say(false, 'H8', 'store-guard.selftest.mjs 一条命令自证全绿', '交付物不存在')
  } else {
    const r = run([GUARD_SELFTEST], DIR)
    say(r.status === 0, 'H8', 'store-guard.selftest.mjs 一条命令自证全绿（exit=0）',
      r.status === 0 ? '' : 'exit=' + r.status + '  ' + short((r.stdout ?? '') + (r.stderr ?? '')))
  }

  // ── H9 ★★ live 行为敏感性：副本里改坏 `store.js` 的身份派生 ⇒ 同基线必须红 ──
  {
    const copy = path.join(TMP, 'copy')
    fs.cpSync(DIR, copy, { recursive: true })
    const copyBase = path.join(TMP, 'copy-baseline.txt')
    const g = path.join(copy, 'store-guard.mjs')
    const rec = run([g, '--record', copyBase], copy)
    const green = run([g, '--check', copyBase], copy)
    const sp = path.join(copy, 'store.js')
    const src = fs.readFileSync(sp, 'utf8')
    const anchor = "computeHash(key + '|' + value)"
    let patched = false
    if (src.includes(anchor)) {
      fs.writeFileSync(sp, src.replace(anchor, "computeHash(key + '~' + value)"), 'utf8')
      patched = true
    }
    const red = patched ? run([g, '--check', copyBase], copy) : { status: null, stdout: '', stderr: '锚点找不到' }
    const ok = rec.status === 0 && green.status === 0 && patched && red.status !== 0 && red.status !== 2
    say(ok, 'H9', '★★ 副本里改坏 store.js 的行为 ⇒ 同一基线再查必须红（读数真挂在 store.js 上）',
      ok
        ? ''
        : 'record=' + rec.status + ' 未改时 check=' + green.status + ' 打上补丁=' + patched + ' 改后 check=' + red.status + '  ' + short((red.stderr ?? '') + (red.stdout ?? '')))
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log('')
console.log(fail === 0 ? 'cli-0007 oracle：**全部通过**（' + pass + ' 条判据）' : 'cli-0007 oracle：**不合格**（' + fail + ' 条不过）')
process.exit(fail === 0 ? 0 : 1)
