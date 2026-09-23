#!/usr/bin/env node
/**
 * evals/checks/cli-0006.mjs —— cli-0006 的 oracle（**行为级：真跑它产出的东西**）
 *
 * ## 题目（题面 = tasks.jsonl 里那条的 `invariant`）
 *
 * 把 `evals/pilot/rename-target/`（零依赖纯 Node 小工程）从"只能人眼看一次 `--selftest`"
 * 升级成"**每次都能复跑的口径护栏**"：
 *   ① 新建 `guard.mjs`：`--record <基线>` 落基线 / `--check <基线>` 查漂移（一致 ⇒ 0，漂移 ⇒ 非零，
 *      漂移内容走 stderr）/ 都可加 `--json`（stdout 只输出一个 JSON 对象，
 *      至少含 `{mode, ok, drift, detail}`）；
 *   ② 基线要**逐条**存 5 条原始读数，`--check` 必须**点名**漂了哪条（格式自定）；
 *   ③ `index.js --selftest` 的输出**逐字不变**，既有导出一个都不许删改；
 *   ④ 新建 `guard.selftest.mjs`：一条命令自证"该红的红、该绿的不绿"。
 *
 * ## 为什么本 oracle 是「行为级」（而不是"文件里有没有某个字符串"）
 *
 * 全部判据都是**跑它写出来的东西**再看行为，一共三档强度：
 *   · 档 1（基线往返）：record → check 绿 → **篡改基线** → check 必须红；
 *   · 档 2（机器可读）：`--json --check` 的 stdout 能 parse，`drift` 必须**恰好**点名被改坏的那几条；
 *   · 档 3（★ live 读数敏感性）：在**临时副本**里 record 之后**改坏被观测对象本身**
 *     （`index.js` 里 `put('alpha','one')` → `'two'`）⇒ 同一条基线再查必须红。
 *     ★ 这一档才是"真在比当前读数"的证明 —— 没有它，一个"把基线文件读两遍"的假实现也能过档 1/2。
 *
 * ## 纪律
 * · **只读被测树**：本 oracle 只在 `os.tmpdir()` 下建临时目录（跑完删）；不改被测树、不写 `~/.dsh`。
 * · **判不了 ≠ 通过**：靶文件/交付物不在指定树里 ⇒ 大声报错 + 非零退出。
 * · ★ 本 oracle **不测**"基线文件不存在时 `--check` 怎么退" —— 那正是本题**故意留的歧义点**
 *   （见 `notes`：第一题故意不说，第二题 `cli-0007` 把它钉死成退出码 2）。
 *
 * 用法：node evals/checks/cli-0006.mjs                    # 退出 0 = 通过
 *       node evals/checks/cli-0006.mjs --repo <被测工作树>  # ★ 判**指定那棵树**的交付物
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** `--repo` ＞ `DSH_EVAL_REPO` ＞ 自身相对路径（= 判据根；与改动前逐字相同）。 */
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
const GUARD = path.join(DIR, 'guard.mjs')
const GUARD_SELFTEST = path.join(DIR, 'guard.selftest.mjs')

console.log('cli-0006 oracle —— REPO = ' + REPO.replace(/\\/g, '/'))
console.log('  来源：' + _resolved.src)
console.log('  靶目录：' + DIR.replace(/\\/g, '/'))
console.log('  交付物：' + GUARD.replace(/\\/g, '/') + '  存在=' + fs.existsSync(GUARD))
console.log('          ' + GUARD_SELFTEST.replace(/\\/g, '/') + '  存在=' + fs.existsSync(GUARD_SELFTEST))
console.log('')

/** 既有行为（`index.js --selftest`）的**逐字基线** —— 5 行纯数据，不含任何符号名。 */
const BASELINE_SELFTEST = ['h=1a47e90b', 'd=computeHash-v1/1a47e90b', 'put/get=one@computeHash-v1', 'size=1', 'legacy=legacy:computeHash-v1']
/** 5 条读数的**条目名**（题面钉死的取法：`=` 左边那一段）与原始读数。 */
const READINGS = [
  { name: 'h', value: '1a47e90b' },
  { name: 'd', value: 'computeHash-v1/1a47e90b' },
  { name: 'put/get', value: 'one@computeHash-v1' },
  { name: 'size', value: '1' },
  { name: 'legacy', value: 'legacy:computeHash-v1' },
]
/** 篡改用的替换串：把基线里所有 `1a47e90b` 换掉 ⇒ 受影响条目**恰好** h 与 d（题面口径可推）。 */
const TAMPER = ['1a47e90b', 'deadbeef']
const EXPECT_DRIFT_AFTER_TAMPER = ['h', 'd']

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-0006-oracle-'))
let pass = 0
let fail = 0
const say = (ok, id, what, detail) => {
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + id.padEnd(4) + ' ' + what + (detail ? '  —— ' + detail : ''))
  if (ok) pass += 1
  else fail += 1
}
const short = (s, n) => String(s ?? '').replace(/\r\n/g, '\n').trim().split('\n').slice(0, 4).join(' | ').slice(0, n ?? 200)
/** 跑被测命令：**从判据根起进程**，cwd 指到被测树（口径同其它 oracle）。 */
const run = (args, cwd) => spawnSync(process.execPath, args, { cwd: cwd ?? REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 })
const jsonOf = (stdout) => {
  try {
    return { obj: JSON.parse(stdout ?? ''), err: '' }
  } catch (e) {
    return { obj: null, err: String(e.message).slice(0, 100) }
  }
}
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')

try {
  // ── 前提：靶文件必须在指定树里（判不了 ≠ 通过）────────────────────────────
  if (!fs.existsSync(INDEX)) {
    console.log('cli-0006 oracle：**不合格** —— 指定树里没有靶文件（' + INDEX.replace(/\\/g, '/') + '）⇒ 判不了（不弱化：判不了 ≠ 通过）')
    process.exit(1)
  }
  if (!fs.existsSync(GUARD)) {
    console.log('cli-0006 oracle：**不合格** —— 交付物 `guard.mjs` 不存在（' + GUARD.replace(/\\/g, '/') + '）⇒ 没有可跑的东西')
    process.exit(1)
  }

  // ── G1 旧行为冻结：`index.js --selftest` 必须逐字不变（题面 ③）──────────────
  {
    const r = run([INDEX, '--selftest'], REPO)
    const got = String(r.stdout ?? '').replace(/\r\n/g, '\n').trim()
    const want = BASELINE_SELFTEST.join('\n')
    say(r.status === 0 && got === want, 'G1', '既有行为冻结：index.js --selftest 逐字等于基线（exit=0）',
      r.status === 0 && got === want ? '' : 'exit=' + r.status + '  实得：' + short(got))
  }

  // ── G2 record：落基线并退出 0 ────────────────────────────────────────────
  const baseA = path.join(TMP, 'base-a.txt')
  {
    const r = run([GUARD, '--record', baseA], REPO)
    const ok = r.status === 0 && fs.existsSync(baseA) && fs.statSync(baseA).size > 0
    say(ok, 'G2', 'guard.mjs --record <基线> ⇒ 退出 0 且基线文件非空',
      ok ? 'size=' + fs.statSync(baseA).size : 'exit=' + r.status + '  ' + short(r.stderr || r.stdout))
  }

  // ── G3 基线里确实带着**原始读数**（题面 ② 的"逐条存原始读数"）──────────────
  {
    const text = fs.existsSync(baseA) ? fs.readFileSync(baseA, 'utf8') : ''
    const missing = READINGS.filter((x) => !text.includes(x.value)).map((x) => x.name)
    say(missing.length === 0, 'G3', '基线逐条存了 5 条**原始读数**（不是整体哈希）',
      missing.length ? '读不到的条目：' + missing.join(', ') : '')
  }

  // ── G4 未漂移 ⇒ 绿 ──────────────────────────────────────────────────────
  {
    const r = run([GUARD, '--check', baseA], REPO)
    say(r.status === 0, 'G4', 'guard.mjs --check <刚记的基线> ⇒ 退出 0（无漂移）', r.status === 0 ? '' : 'exit=' + r.status + '  ' + short(r.stderr || r.stdout))
  }

  // ── G5 ★ 篡改基线 ⇒ 必须红，且漂移内容走 stderr ──────────────────────────
  {
    const raw = fs.readFileSync(baseA, 'utf8')
    fs.writeFileSync(baseA, raw.split(TAMPER[0]).join(TAMPER[1]), 'utf8')
    const r = run([GUARD, '--check', baseA], REPO)
    const errText = String(r.stderr ?? '')
    say(r.status !== 0, 'G5a', '★ 篡改基线后 --check ⇒ 非零（真的会检到漂移）', r.status !== 0 ? 'exit=' + r.status : 'exit=0（漂移没被检出）')
    say(errText.trim().length > 0, 'G5b', '漂移内容走 stderr（题面 ①）', errText.trim().length ? '' : 'stderr 为空')
  }

  // ── G6 ★ `--json --check`（篡改后）：形状 + 点名能力（必须恰好 h、d）────────
  {
    const r = run([GUARD, '--json', '--check', baseA], REPO)
    const { obj, err } = jsonOf(r.stdout)
    say(obj !== null, 'G6a', '--json --check 的 **stdout 只有一个 JSON 对象**（能 JSON.parse）', obj !== null ? '' : '解析失败：' + err + '  实得：' + short(r.stdout))
    if (obj === null) {
      say(false, 'G6b', 'JSON 含 {mode,ok,drift,detail} 且 drift 恰好点名 h、d', 'JSON 都解析不出 ⇒ 一条都判不了')
    } else {
      const shaped = obj.mode === 'check' && obj.ok === false && Array.isArray(obj.drift) && typeof obj.detail === 'string' && obj.detail.trim() !== ''
      const named = sameSet(obj.drift, EXPECT_DRIFT_AFTER_TAMPER)
      say(shaped && named, 'G6b', '★ JSON 含 {mode:"check",ok:false,drift,detail} 且 drift **恰好** [' + EXPECT_DRIFT_AFTER_TAMPER.join(', ') + ']',
        shaped && named ? '' : 'mode=' + JSON.stringify(obj.mode) + ' ok=' + JSON.stringify(obj.ok) + ' drift=' + JSON.stringify(obj.drift))
    }
  }

  // ── G7 未漂移时的 `--json`：ok:true 且 drift 为空 ────────────────────────
  {
    const baseB = path.join(TMP, 'base-b.txt')
    const rec = run([GUARD, '--record', baseB], REPO)
    const r = run([GUARD, '--json', '--check', baseB], REPO)
    const { obj, err } = jsonOf(r.stdout)
    const ok = rec.status === 0 && obj !== null && obj.ok === true && Array.isArray(obj.drift) && obj.drift.length === 0 && typeof obj.detail === 'string' && obj.detail.trim() !== ''
    say(ok, 'G7', '--json --check（未漂移）⇒ ok:true、drift:[]、detail 非空',
      ok ? '' : 'record exit=' + rec.status + '  解析=' + (obj === null ? err : JSON.stringify(obj)).slice(0, 160))
    fs.rmSync(baseB, { force: true })
  }

  // ── G8 它自己的自测（题面 ④）────────────────────────────────────────────
  if (!fs.existsSync(GUARD_SELFTEST)) {
    say(false, 'G8', 'guard.selftest.mjs 一条命令自证全绿', '交付物不存在')
  } else {
    const r = run([GUARD_SELFTEST], DIR)
    say(r.status === 0, 'G8', 'guard.selftest.mjs 一条命令自证全绿（exit=0）',
      r.status === 0 ? '' : 'exit=' + r.status + '  ' + short((r.stdout ?? '') + (r.stderr ?? '')))
  }

  // ── G9 ★★ live 读数敏感性：在**临时副本**里改坏被观测对象 ⇒ 同一条基线必须红 ──
  //   ★ 这一档才是"真在比**当前读数**"的证明：一个"把基线文件读两遍"的假实现能过 G4/G5，
  //     但过不了这一条（它必须重新算读数才会发现 `index.js` 变了）。
  {
    const copy = path.join(TMP, 'copy')
    fs.cpSync(DIR, copy, { recursive: true })
    const copyBase = path.join(TMP, 'base-copy.txt')
    const rec = run([path.join(copy, 'guard.mjs'), '--record', copyBase], copy)
    const green = run([path.join(copy, 'guard.mjs'), '--check', copyBase], copy)
    const idxPath = path.join(copy, 'index.js')
    const src = fs.readFileSync(idxPath, 'utf8')
    const anchor = "put('alpha', 'one')"
    let patched = false
    if (src.includes(anchor)) {
      fs.writeFileSync(idxPath, src.replace(anchor, "put('alpha', 'two')"), 'utf8')
      patched = true
    }
    const red = patched ? run([path.join(copy, 'guard.mjs'), '--check', copyBase], copy) : { status: null, stdout: '', stderr: '锚点找不到' }
    const ok = rec.status === 0 && green.status === 0 && patched && red.status !== 0
    say(ok, 'G9', '★★ 改坏被观测对象（副本里 index.js 的读数来源）⇒ 同一基线再查必须红',
      ok
        ? ''
        : 'record=' + rec.status + ' 未改时 check=' + green.status + ' 打上补丁=' + patched + ' 改后 check=' + red.status + '  ' + short((red.stderr ?? '') + (red.stdout ?? '')))
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log('')
console.log(fail === 0 ? 'cli-0006 oracle：**全部通过**（' + pass + ' 条判据）' : 'cli-0006 oracle：**不合格**（' + fail + ' 条不过）')
process.exit(fail === 0 ? 0 : 1)
