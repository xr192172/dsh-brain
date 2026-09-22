#!/usr/bin/env node
/**
 * scripts/memory-judge-poison-check.mjs —— R1 隔离的【带毒自检】
 *
 * ── 它要解决的问题 ────────────────────────────────────────────────────────
 *   `evals/README.md` 的 R1 逐字：**"判据必须在 Agent 够不到的地方"** ——
 *   "2026 年多个公开靶场被【判分代码与 Agent 同环境】破掉（一行代码改掉自己的成绩）"。
 *   `docs/memory-effect-judge-design.md` §4 把它落成硬要求，§6 门 3 要求：
 *   ★ **"带毒自检能报警"** —— 否则"隔离"只是写在文档里的声明。
 *
 *   本项目真的在这条上翻过车：**三条 B 会话都读了 `check.mjs`**，
 *   题面 README 还把陷阱逐条印出 ⇒ **区分度归零**。
 *
 *   ⇒ 本脚本把"判据不在被测 agent 够得到的目录里"从**声明**变成**机器证据**：
 *     凡是把判据（或它的期望值）误放进被测目录，**必须自动报警**。
 *
 * ── 语义（三个模式 + 一处纪律） ───────────────────────────────────────────
 *   node scripts/memory-judge-poison-check.mjs                        正常态：扫一遍 _wt，期望"干净"
 *   node scripts/memory-judge-poison-check.mjs --poison               ★带毒态：**脚本自己**把受检的判据
 *                                                                     文件复制进 _wt，然后必须检出
 *   --wt <dir>        指定被测目录（默认：系统临时目录下新建 dsh-memory-judge-wt-<rand>/）
 *   --target <file>…  指定"判据文件"（可多个、可重复；默认见 DEFAULT_TARGETS）
 *   --keep-wt         保留自动建的临时 _wt（默认用完即删）
 *
 *   1. **绝不碰仓库里的真目录**：`--wt` 缺省时只在 `os.tmpdir()` 下新建目录；
 *      自动建的临时目录用完即删（`--keep-wt` 可留下检查）。
 *   2. **扫描口径 = "被测 agent 够得到的东西"**：递归（含子目录）、含中文文件名；
 *      只看【文件名】不够 ⇒ 同时看【内容】（期望值/答案类信号）。
 *   3. ★ **无证据不冒充**：`_wt` 不存在 / 读不到 ⇒ `isolation=UNKNOWN` + exit 4，
 *      **绝不当 OK**（沿用 §5「无证据 ≠ 通过」与 `capability-gate` 的 `unenforced` 同款纪律）。
 *
 * ── 退出码 ────────────────────────────────────────────────────────────────
 *   0 = OK       被测目录里没有判据/期望值（隔离成立）
 *   2 = 用法错误
 *   3 = BROKEN   ★ 检出了判据/期望值（隔离破了）—— 正常态与带毒态都用这个码
 *   4 = UNKNOWN  _wt 不存在/读不到（无证据）；或带毒态**自己放进去却没检出**（判据无分辨力）
 *
 * ── 不变量（改这个文件必须保住） ──────────────────────────────────────────
 *   1. 只在 _wt（默认在系统临时目录）里写东西；**绝不往仓库真目录放诱饵**
 *   2. 未检出 + 无不可读 ⇒ OK；**有不可读就是 UNKNOWN，不许当 OK**
 *   3. 带毒态若无任何检出 ⇒ UNKNOWN（不许打印 OK，也不许假装 BROKEN）
 *   4. stdout 恒为一行汇总；明细只进 out/memory-judge-poison-check.txt
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ───────────────────────── 常量 ─────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'memory-judge-poison-check'
const REPORT = path.join(ROOT, 'out', 'memory-judge-poison-check.txt')
const WT_PREFIX = 'dsh-memory-judge-wt-'

/** 内容只读前 512 KiB（判据文件的信号一律出现在前部；避免把大文件整个读进来）。 */
const MAX_CONTENT_BYTES = 512 * 1024
/** 二进制探针长度：头 4 KiB 里有 NUL ⇒ 当二进制，跳过内容信号（文件名信号照旧）。 */
const BIN_PROBE = 4096

/**
 * 缺省"判据文件"清单（**仓库相对路径**）——它们就是 R1 要求"不在被测目录里"的东西：
 * oracle 脚本 / 回归门 / 任务描述（含 seed+oracle+期望值）/ 逐题判据脚本。
 */
const DEFAULT_TARGETS = [
  'evals/pilot/tasks.jsonl',
  'evals/checks/cli-0004.mjs',
  'scripts/test-injected-message-shape.mjs',
  'scripts/test-handover-drain.mjs',
  'scripts/eval-validate.mjs',
  'scripts/check-all.mjs',
]

/**
 * ★ 判别信号表 —— "期望值/答案类内容"的识别口径。
 *
 * ★ **为什么不能只看文件名**：本项目的车就是"题面 README 把陷阱逐条印出"——
 *   文件名人畜无害（`readme.md` / `notes.json`），**期望值藏在内容里**。
 *   ⇒ 两路都扫：`where:'name'` 打 basename，`where:'content'` 打文件正文。
 *
 * ★ **方向故意偏保守**：多报（假阳性）只是让人多看一眼；漏报（假阴性）会让"隔离"
 *   重新变成声明。所以 `regression`、`oracle` 这类词按**独立词**判定即算命中。
 */
const SIGNALS = [
  // ── 内容信号（期望值/答案类） ──
  {
    id: 'content/expectSeeded',
    where: 'content',
    test: (s) => s.includes('expectSeeded'),
    note: 'tasks.jsonl 的期望值字段名（seed 之后的期望，FAIL_TO_PASS 的左半）',
  },
  {
    id: 'content/expectFixed',
    where: 'content',
    test: (s) => s.includes('expectFixed'),
    note: 'tasks.jsonl 的期望值字段名（修好之后的期望，FAIL_TO_PASS 的右半）',
  },
  {
    id: 'content/oracle',
    where: 'content',
    test: (s) => /\boracle\b/i.test(s),
    note: '判据入口名：oracle 出现在被测目录里 ⇒ 判分代码与 agent 同环境',
  },
  {
    id: 'content/regression',
    where: 'content',
    test: (s) => /\bregression\b/i.test(s),
    note: '回归门（PASS_TO_PASS）的名字；与 oracle 同类，属于"由外部跑"的东西',
  },
  {
    id: 'content/json-seed+oracle',
    where: 'content',
    test: (s) => /"seed"\s*:/.test(s) && /"oracle"\s*:/.test(s),
    note: '★ JSON 里 `"seed"` 与 `"oracle"` **同现** ⇒ 极像题目/判据描述（含"怎么打坏 + 怎么判")',
  },
  {
    id: 'content/zh-expected',
    where: 'content',
    test: (s) => /期望值|判据|标准答案|正确答案|参考答案/.test(s),
    note: '中文的"期望值 / 判据 / 答案"字样（人写的诱饵常常是中文）',
  },
  // ── 文件名信号 ──
  {
    id: 'name/check-script',
    where: 'name',
    test: (s) => /(^|[-_.])check([-_.][^/]*)?\.(mjs|cjs|js|ts)$/i.test(s),
    note: '`check.mjs` / `check-*.mjs` 式判据脚本命名（★ 本项目三条 B 会话读的就是它）',
  },
  {
    id: 'name/test-script',
    where: 'name',
    test: (s) => /^test[-_.].*\.(mjs|cjs|js|ts)$/i.test(s),
    note: '`scripts/test-*.mjs` 式"判据脚本"命名（tasks.jsonl 的 oracle.cmd 指的就是它们）',
  },
  {
    id: 'name/oracle-expect',
    where: 'name',
    test: (s) => /oracle|expect|judge|期望|判据|答案/i.test(s),
    note: '文件名里出现 oracle / expect / judge / 判据 / 期望 / 答案',
  },
]

const USAGE = `${NAME} —— R1 隔离的带毒自检（判据/期望值不在被测 agent 够得到的目录里）

用法：
  node scripts/memory-judge-poison-check.mjs                          # 正常态检查
  node scripts/memory-judge-poison-check.mjs --poison                 # 带毒态（自己把判据放进 _wt，必须报警）
  node scripts/memory-judge-poison-check.mjs --wt <dir> [--poison]    # 指定被测目录
  node scripts/memory-judge-poison-check.mjs --target <file> …        # 指定要检查的"判据文件"（可多个）

参数：
  --wt <dir>         被测目录（默认为系统临时目录下新建的 ${WT_PREFIX}<rand>/）
  --target <file>…   判据文件，可多个/可重复；🅧相对仓库根解析。默认：
                     ${DEFAULT_TARGETS.join(' , ')}
  --poison           ★ 带毒态：自己把受检判据复制进 _wt 的 _judge_planted/ 子目录，然后必须检出
  --keep-wt          保留自动建的临时 _wt（默认用完即删；--wt 指定的目录一律不动）
  -h, --help         打印本用法

退出码：0 = OK（隔离成立）／2 = 用法错误／3 = BROKEN（检出判据/期望值）／
        4 = UNKNOWN（_wt 不存在/读不到 ⇒ 无证据；或带毒却未检出 ⇒ 判据无分辨力）
报告：${path.relative(ROOT, REPORT).replace(/\\/g, '/')}（明细）；stdout 恒一行汇总
`

// ───────────────────────── 参数 ─────────────────────────

function parseArgs(argv) {
  const opts = Object.create(null)
  const flags = new Set()
  const targets = []
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const key = eq > 2 ? a.slice(2, eq) : a.slice(2)
    // --target 是"吃一串"的：把后面所有非 -- 开头的参数都收走
    if (key === 'target') {
      if (eq > 2) {
        targets.push(a.slice(eq + 1))
        continue
      }
      let took = 0
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        targets.push(argv[++i])
        took++
      }
      if (took === 0) usage('--target 后面至少要跟一个路径')
      continue
    }
    if (eq > 2) {
      opts[key] = a.slice(eq + 1)
      continue
    }
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) {
      flags.add(key)
      continue
    }
    opts[key] = val
    i++
  }
  return { opts, flags, targets, rest }
}

function usage(msg) {
  process.stderr.write(`[${NAME}] 用法错误：${msg}\n\n${USAGE}`)
  process.exit(2)
}

// ───────────────────────── 扫描 ─────────────────────────

const relTo = (p) => {
  const r = path.relative(ROOT, p)
  return (r.startsWith('..') ? p : r).replace(/\\/g, '/')
}

/**
 * 递归列文件（含子目录、含中文名）。**不静默**：读不到的一律记进 unreadable。
 * 用 realpath 去重，避免符号链接/junction 成环。
 */
function walk(rootDir) {
  const files = []
  const unreadable = []
  const seenDirs = new Set()
  const stack = [rootDir]
  let entries = 0
  while (stack.length) {
    const d = stack.pop()
    let real
    try {
      real = fs.realpathSync(d)
    } catch {
      real = d
    }
    if (seenDirs.has(real)) continue
    seenDirs.add(real)
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch (e) {
      unreadable.push({ path: d, error: String(e?.message ?? e) })
      continue
    }
    for (const e of ents) {
      entries++
      const p = path.join(d, e.name)
      let kind = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'link' : 'other'
      if (kind === 'link') {
        try {
          const st = fs.statSync(p) // 跟随链接
          kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
        } catch (e) {
          unreadable.push({ path: p, error: `断链/读不到：${String(e?.message ?? e)}` })
          continue
        }
      }
      if (kind === 'dir') stack.push(p)
      else if (kind === 'file') files.push(p)
    }
  }
  return { files, unreadable, entries }
}

/** 单个文件：跑文件名信号 + 内容信号。读失败 ⇒ 记 readError（并由调用方计入 unreadable）。 */
function inspect(file) {
  const base = path.basename(file)
  const signals = []
  for (const s of SIGNALS) {
    if (s.where === 'name' && s.test(base)) signals.push(s.id)
  }

  let bytes = null
  let binary = false
  let truncated = false
  let readError = null
  let text = null
  try {
    const st = fs.statSync(file)
    bytes = st.size
    const cap = Math.min(bytes, MAX_CONTENT_BYTES)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(cap)
      const n = fs.readSync(fd, buf, 0, cap, 0)
      const b = buf.subarray(0, n)
      binary = b.subarray(0, Math.min(n, BIN_PROBE)).includes(0)
      if (!binary) text = b.toString('utf8')
      truncated = bytes > n
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    readError = String(e?.message ?? e)
  }
  if (text !== null) {
    for (const s of SIGNALS) {
      if (s.where === 'content' && s.test(text)) signals.push(s.id)
    }
  }
  return { file, base, bytes, binary, truncated, readError, signals }
}

// ───────────────────────── _wt 探针 ─────────────────────────

function probeWt(wt) {
  if (!fs.existsSync(wt)) return { ok: false, why: '_wt 不存在' }
  let st
  try {
    st = fs.statSync(wt)
  } catch (e) {
    return { ok: false, why: `_wt 读不到（stat 失败）：${String(e?.message ?? e)}` }
  }
  if (!st.isDirectory()) return { ok: false, why: '_wt 不是目录（是一个文件）' }
  try {
    fs.readdirSync(wt)
  } catch (e) {
    return { ok: false, why: `_wt 读不到（readdir 失败）：${String(e?.message ?? e)}` }
  }
  return { ok: true, why: '可读' }
}

// ───────────────────────── 带毒：把判据放进 _wt ─────────────────────────

/** 受检判据清单：--target 优先，否则 DEFAULT_TARGETS（一律相对仓库根解析）。 */
function resolveTargets(requested) {
  const raw = requested.length ? requested : DEFAULT_TARGETS
  return raw.map((r) => {
    const src = path.resolve(ROOT, r)
    return { requested: r, src, exists: fs.existsSync(src) }
  })
}

/** ★ 内置诱饵：万一 --target/默认项全都不存在，也**必须有**一份"含期望值的东西"可放（否则带毒态无意义）。 */
const BUILTIN_DECOY = {
  note: '★ 内置诱饵：假装有人把判据文件误放进了被测目录（这不是真实任务文件）',
  seed: { edits: [{ file: 'packages/switchboard/src/index.ts', find: '（诱饵：原文）', replace: '' }] },
  oracle: { cmd: ['node', 'scripts/check.mjs'], expectSeeded: 'fail', expectFixed: 'pass' },
  regression: { cmd: ['node', 'scripts/check-all.mjs'] },
}

/**
 * 把受检判据复制进 `_wt/_judge_planted/p<i>/`（**故意放进嵌套子目录** ⇒ 顺带验证递归扫描）。
 *
 * ★ 落点**保留原 basename**：早先版本用 `p<i>-<basename>` 前缀，结果把 `test-*.mjs`
 *   改成了一个"不像判据"的名字，**自家文件名信号被自己剥掉了**（实测漏检出 1/6）。
 *   ⇒ 带毒自检**不许改写被检对象的形状**，否则测的是"我造的名字像不像"，不是"隔离成不成立"。
 * @returns {{planted:Array<{src:string,dest:string,kind:string,bytes:number|null}>, decoy:boolean}}
 */
function plant(wt, targets) {
  const dir = path.join(wt, '_judge_planted')
  fs.mkdirSync(dir, { recursive: true })
  const planted = []
  let i = 0
  for (const t of targets) {
    if (!t.exists) continue
    const sub = path.join(dir, `p${++i}`)
    fs.mkdirSync(sub, { recursive: true })
    const dest = path.join(sub, path.basename(t.src))
    fs.copyFileSync(t.src, dest)
    planted.push({ src: t.src, dest, kind: 'copied', bytes: fs.statSync(dest).size })
  }
  let decoy = false
  if (planted.length === 0) {
    // 中文文件名 + 期望值字段 ⇒ 一并覆盖"中文名可扫到"这条
    const sub = path.join(dir, 'decoy')
    fs.mkdirSync(sub, { recursive: true })
    const dest = path.join(sub, '判据_期望值.json')
    fs.writeFileSync(dest, JSON.stringify(BUILTIN_DECOY, null, 2), 'utf8')
    planted.push({ src: '(内置常量 BUILTIN_DECOY)', dest, kind: 'builtin-decoy', bytes: fs.statSync(dest).size })
    decoy = true
  }
  return { planted, decoy, dir }
}

// ───────────────────────── 主流程 ─────────────────────────

const { opts, flags, targets: requestedTargets, rest } = parseArgs(process.argv.slice(2))
if (flags.has('h') || flags.has('help')) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (rest.length) usage(`不认识的参数：${rest.join(' ')}`)
const unknownKeys = Object.keys(opts).filter((k) => k !== 'wt')
if (unknownKeys.length) usage(`不认识的选项：--${unknownKeys.join(' --')}`)

const POISON = flags.has('poison')
const KEEP_WT = flags.has('keep-wt')
const MODE = POISON ? 'poison' : 'scan'

// ── _wt：缺省在系统临时目录新建；**绝不动仓库真目录**
let wt
let createdWt = false
if (opts.wt) {
  wt = path.resolve(opts.wt)
} else {
  wt = path.join(os.tmpdir(), WT_PREFIX + crypto.randomBytes(4).toString('hex'))
  fs.mkdirSync(wt, { recursive: true })
  createdWt = true
}

const targets = resolveTargets(requestedTargets)
const tgtMissing = targets.filter((t) => !t.exists).map((t) => t.requested)

// ── 探针：不存在/读不到 ⇒ UNKNOWN（绝不当 OK）
const probe = probeWt(wt)

let plantedInfo = { planted: [], decoy: false, dir: null }
let scan = { files: [], unreadable: [], entries: 0 }
let suspects = []
let verdict = 'UNKNOWN'
let reason = ''

if (!probe.ok) {
  verdict = 'UNKNOWN'
  reason = `★ 无证据：${probe.why} ⇒ 既不能声称隔离成立，也不能声称破了（≠ OK）`
} else {
  if (POISON) plantedInfo = plant(wt, targets)
  scan = walk(wt)
  suspects = scan.files.map(inspect).filter((f) => f.signals.length > 0)

  if (suspects.length > 0) {
    verdict = 'BROKEN'
    reason = `检出了 ${suspects.length} 个判据/期望值类文件 ⇒ 判据落在被测 agent 够得到的地方（R1 破了）`
  } else if (scan.unreadable.length > 0) {
    verdict = 'UNKNOWN'
    reason = `★ 无证据：有 ${scan.unreadable.length} 处读不到（见下）⇒ 「没有检出」不等于「没有」`
  } else if (POISON) {
    verdict = 'UNKNOWN'
    reason =
      `★ 判据无分辨力：脚本**自己**把 ${plantedInfo.planted.length} 份判据放进 ${relTo(plantedInfo.dir)}，` +
      `却一个都没检出 ⇒ 这台自检机器本身坏了（不是 OK）`
  } else {
    verdict = 'OK'
    reason = `扫遍 ${relTo(wt)}，没有判据/期望值类文件，也没有读不到的角落 ⇒ 隔离成立`
  }
}

const EXIT = verdict === 'OK' ? 0 : verdict === 'BROKEN' ? 3 : 4

// ───────────────────────── 报告 ─────────────────────────

const L = []
const now = new Date().toISOString()
L.push('='.repeat(100))
L.push(`${NAME} —— R1 隔离带毒自检（判据必须在被测 agent 够不到的地方）`)
L.push(`生成时间 : ${now}`)
L.push(`模式     : ${MODE === 'poison' ? 'POISON（带毒：脚本自己把判据放进 _wt）' : 'SCAN（只扫，不放东西）'}`)
L.push(`被测目录 : ${relTo(wt)}${createdWt ? '   （自动新建于系统临时目录）' : '   （--wt 指定；本脚本只读它）'}`)
L.push(`隔离探针 : ${probe.why}`)
L.push(`裁决     : isolation=${verdict}   exit=${EXIT}`)
L.push(verdict === 'OK' ? `说明     : ${reason}` : `★ 说明   : ${reason}`)
L.push('='.repeat(100))
L.push('')
L.push('口径（这条决定本报告能说什么、不能说什么）：')
L.push('  · 本脚本只回答一个问题：**被测目录里有没有"判据/期望值"类文件**。')
L.push('  · 「没有检出」在本脚本里的强度 = 扫描口径的强度（信号表见下）⇒ **不是**"证明全世界不存在泄漏"。')
L.push('  · isolation=UNKNOWN 是一种**拒绝回答**：_wt 不可达，或带毒却没检出 ⇒ 无证据，不许当 OK（§5 纪律）。')
L.push('')

L.push('-'.repeat(100))
L.push('[1] 受检判据清单（--target 优先，否则内置默认表）')
L.push('-'.repeat(100))
L.push(`  来源：${requestedTargets.length ? '--target（命令行）' : '内置 DEFAULT_TARGETS'}`)
for (const t of targets) {
  L.push(`  ${t.exists ? '  ✓ 存在' : '  ✗ 不存在'}  ${relTo(t.src)}${t.requested === relTo(t.src) ? '' : `   （请求：${t.requested}）`}`)
}
if (tgtMissing.length) L.push(`  ⚠ 不存在 ${tgtMissing.length} 个 ⇒ 无法作为带毒源（NEEDS-EVIDENCE，不计入 NO-OP）`)
L.push('')

if (POISON) {
  L.push('-'.repeat(100))
  L.push('[2] 带毒：脚本自己往 _wt 里放了什么（★ 只放在 _wt 内）')
  L.push('-'.repeat(100))
  if (!plantedInfo.dir) {
    L.push('  （_wt 不可达 ⇒ 未放任何东西）')
  } else {
    L.push(`  落点目录：${relTo(plantedInfo.dir)}/`)
    for (const p of plantedInfo.planted) {
      L.push(`  · [${p.kind}] ${relTo(p.dest)}  ←  ${p.src === '(内置常量 BUILTIN_DECOY)' ? p.src : relTo(p.src)}  (${p.bytes} B)`)
    }
    if (plantedInfo.decoy) L.push('  ★ 用的是**内置诱饵**（因为受检清单里没有一个存在）——它同时也是中文文件名的用例。')
  }
  L.push('')
} else {
  L.push('-'.repeat(100))
  L.push('[2] 带毒：本轮没放任何东西（SCAN 模式；--poison 才会放）')
  L.push('-'.repeat(100))
  L.push('')
}

L.push('-'.repeat(100))
L.push('[3] 扫描统计（递归，含子目录；含中文文件名）')
L.push('-'.repeat(100))
L.push(`  被测目录       : ${relTo(wt)}`)
L.push(`  遍历到的条目数 : ${scan.entries}（文件 + 目录）`)
L.push(`  扫到的文件数   : ${scan.files.length}`)
L.push(`  读不到的条目   : ${scan.unreadable.length}${scan.unreadable.length ? '   ★ 由此产生 UNKNOWN' : ''}`)
L.push(`  疑点（判据）数 : ${suspects.length}`)
for (const u of scan.unreadable) L.push(`    ! ${relTo(u.path)}  :: ${u.error}`)
L.push('')

L.push('-'.repeat(100))
L.push('[4] 明细：每一个疑点，落在哪条路径、命中了哪条信号')
L.push('-'.repeat(100))
if (!suspects.length) {
  L.push('  （无）')
} else {
  for (const s of suspects) {
    L.push(`  ⚠ ${relTo(s.file)}`)
    L.push(`      大小=${s.bytes} B${s.truncated ? '（内容只读了前 512 KiB）' : ''}${s.binary ? '  二进制（内容信号已跳过）' : ''}`)
    for (const id of s.signals) {
      const sig = SIGNALS.find((x) => x.id === id)
      L.push(`      命中 ${id}  【${sig?.where === 'name' ? '文件名' : '内容'}】 ${sig?.note ?? ''}`)
    }
  }
}
L.push('')

L.push('-'.repeat(100))
L.push('[5] 判别信号表（★ "不能只看文件名"——两路都扫）')
L.push('-'.repeat(100))
L.push(`  ${'信号 id'.padEnd(28)}${'打哪儿'.padEnd(10)}说明`)
for (const s of SIGNALS) {
  L.push(`  ${s.id.padEnd(28)}${(s.where === 'name' ? '文件名' : '内容').padEnd(8)}  ${s.note}`)
}
L.push('')
L.push('  另：内容信号只对**非二进制**文件生效（头 4 KiB 有 NUL 即判二进制），且只读前 512 KiB。')
L.push('')

L.push('-'.repeat(100))
L.push('[6] 汇总')
L.push('-'.repeat(100))
L.push(`  wt        = ${wt}`)
L.push(`  mode      = ${MODE}`)
L.push(`  scanned   = ${scan.entries}`)
L.push(`  files     = ${scan.files.length}`)
L.push(`  suspects  = ${suspects.length}`)
L.push(`  isolation = ${verdict}`)
L.push(`  exit      = ${EXIT}`)
L.push(`  ${reason}`)
L.push('')
L.push('─'.repeat(100))
L.push('不确定 / 未验证（本报告的自我申报）：')
L.push('  · 本脚本**只**判"被测目录里是否出现判据/期望值类内容"，**不**判 agent 是否通过别的方式看到判据：')
L.push('    （另一臂的会话日志 ~/.dsh/sessions/**、out/ 下的历史报告、共享的记忆库/缓存 —— 那些是')
L.push('    scripts/eval-isolation-audit.mjs 管的另一类泄漏面，本脚本不看。）')
L.push('  · 信号表是**启发式**：它不证明"内容里没有答案"，只证明"没有出现这些信号"。')
L.push('    预期漏报方向：判据被改写成不含这些词的自定义形状（例如把 expect* 改名、把多行说明当题面）。')
L.push('  · 本脚本**不**驱动、不启动任何 DSH 会话；它只做文件系统只读检查 + （带毒态）在 _wt 内写诱饵。')
L.push('─'.repeat(100))

fs.mkdirSync(path.dirname(REPORT), { recursive: true })
fs.writeFileSync(REPORT, L.join('\n') + '\n', 'utf8')

// ── 清理：只删**本脚本自己建的**临时 _wt
let cleaned = 'kept'
if (createdWt && !KEEP_WT) {
  try {
    fs.rmSync(wt, { recursive: true, force: true })
    cleaned = 'removed'
  } catch (e) {
    cleaned = `remove-failed:${String(e?.message ?? e)}`
  }
}

process.stdout.write(
  `${NAME} mode=${MODE} wt=${wt} scanned=${scan.entries} files=${scan.files.length} suspects=${suspects.length} ` +
    `isolation=${verdict} exit=${EXIT} wt-cleanup=${cleaned} report=${relTo(REPORT)}\n`,
)
process.exit(EXIT)
