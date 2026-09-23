#!/usr/bin/env node
/**
 * scripts/memory-effect-judge.mjs —— 记忆效果【判据机器骨架】（O42 的落地形状）
 *
 * 设计依据：docs/memory-effect-judge-design.md
 *   §2 两条腿（(甲) 序列/学习曲线型 + (乙) 单次型，两条都要报）
 *   §2.4 k=1 应无差别 ⇒ 它是【阳性对照】，不是顺带的观察
 *   §3.2 两臂同器具、同一张脸，只让【记忆库内容】不同
 *   §3.3 三条对照断言（任一不满足 ⇒ 该批数据作废）
 *   §5   缺读数一律 NEEDS-EVIDENCE，绝不许当通过
 *   §6   判据自身的门（有信号 / 对照体检 / 无证据不冒充 / 可复算）
 *
 * ── 它是什么 ─────────────────────────────────────────────────────────────
 *   把上面那份设计落成一台**可跑、能自证、不会假绿**的机器骨架：
 *     · 两臂：臂 A = 控制（空库）/ 臂 B = 处理（累积），**每臂一个独立 db 文件**
 *     · 逐题读数表：(甲) 序列型（k≥2 相对 k=1 的差）+ (乙) 单次型
 *     · 每格读数四态：OK / NEEDS-EVIDENCE / FAIL / N/A
 *     · 对照体检三断言 + 阳性对照（k=1 应无差别）
 *   ★ 它**不驱动任何真实会话**（那是后续驱动器的事），也**不产任何结论**：
 *     输出只有「机器读数 + 断言结果」。
 *
 * ── 四个模式 ─────────────────────────────────────────────────────────────
 *   node scripts/memory-effect-judge.mjs --plan      只打印计划：不建库/不写报告/不调面/不开会话
 *   node scripts/memory-effect-judge.mjs --selftest  注入假读数 + **真调面** 跑完整流程做机器自检
 *   node scripts/memory-effect-judge.mjs             REAL 模式（骨架态）：无真实读数 ⇒ 逐格 NEEDS-EVIDENCE，
 *                                                    只对两臂 db 做**只读** count
 *   node scripts/memory-effect-judge.mjs --face "<cmd>"
 *                                                    REAL·**面驱动**：真调 --face 那条记忆面做
 *                                                    reset/remember/count 排练 ⇒ **三条对照断言有真读数**
 *   node scripts/memory-effect-judge.mjs --face "<cmd>" --face-readonly
 *                                                    REAL·**面驱动·只读**（第 ⑧ 格新增）：**绝不**
 *                                                    reset/remember，只对**已经存在的真实 store**
 *                                                    读 count ⇒ 判据机器能读真 store 而**不改动它**。
 *                                                    见下面「--face-readonly」一节。
 *
 * 其它参数：
 *   --readings <file>   用外部读数 JSON 取代内置假数据（schema 见 loadReadings）
 *   --face "<cmd>"      ★ 记忆面命令（默认 = node scripts/memory-stub.mjs）。
 *                       给了它 ⇒ REAL 模式由「骨架态」变「面驱动」（见下）。
 *                       ★ 不带 --face 时，本脚本行为与加它之前**逐字相同**。
 *   --face-readonly     ★★ **只读开关**（必须与 --face 一起用）：本模式下**只调面的 count**，
 *                       **不 reset、不 remember** ⇒ 可以安全指向**别人的真实 store**。
 *                       · `--arm-a/--arm-b` 在本模式下可给**逗号分隔的多个 db 路径**
 *                         （= 各检查点 k 的 store 快照）⇒ A2/A3 拿到**逐 k 的真 count**；
 *                         给单一路径时，每个检查点读同一个库（值相同，A3 自然不递增 ⇒ 如实报）。
 *                       · 本模式**额外产**一项完整性证据：读 count 前后对每个 db 目录做
 *                         **逐文件 sha256**，报 `unchanged` ⇒ 「读数没有改动 store」可被机器复核。
 *                       · ★ 判据口径（A1/A2/A3、四态、退出码）**一字未改**；本次只**加**了
 *                         「读得到」的能力（第 ⑧ 格前置 A）。
 *   --arm-a/--arm-b <p> 两臂 db 路径（默认 out/memory-judge/arm-a.json / arm-b.json；
 *                       --selftest 时默认落到 out/memory-judge/selftest/ 下，避免误写真实臂的库；
 *                       --face 时默认落到 out/memory-judge/face/arm-a / arm-b ——★ 面驱动的
 *                       面是**目录型 store**，不带 .json 后缀，免得把一个目录叫成 .json 文件）
 *   --out <path>        报告路径（默认 out/memory-judge-report.txt）
 *   --break <name>      ★ 故意破坏注入数据（只许配 --selftest）：
 *                         control-nonempty  让控制臂 count>0      ⇒ 应 BATCH-INVALID（exit 1）
 *                         k1-differs        让 k=1 两臂就有差别  ⇒ 应 CONTROL-FAILED（exit 3）
 *
 * ── ★★ --face：它把哪一格变成真读数，以及它【不】碰哪一格 ────────────────────
 *   记忆面的 CLI 契约（4 条子命令，形状 = 将来真 MCP 面的形状）：
 *     <face> count    --db <p>                            → 单行 JSON {"db":..,"count":N}
 *     <face> recall   --db <p> --query <t> [--limit N]     → 单行 JSON 数组 [{text,kind,at}]
 *     <face> remember --db <p> --text <t> [--kind <k>]     → 单行 JSON {"db":..,"count":N}
 *     <face> reset    --db <p>                            → 单行 JSON {"db":..,"count":0}
 *   给了 --face 后，REAL 模式会**真调**它（不是假设它可用）：
 *     · 两臂各一个独立 db ⇒ 真 `reset` 建库、臂 B 逐 k 真 `remember`、每个 k 真 `count`
 *       ⇒ §3.3 的 **A2（控制臂 count==0）/ A3（处理臂 count 随 k 严格递增）拿到真读数**；
 *     · 面自身先被**实测**一次（四条子命令各打一发在 probe 库上）⇒ **A1（两臂 face 指纹
 *       相同）** 用「这个面实测暴露的工具面 + 面命令逐字行」算 dsh-face/v1 指纹。
 *   ★★ 它【不】碰任务级读数：toolCalls / tokens / wallClock / rework / oracle / regression
 *      仍然**逐格 NEEDS-EVIDENCE** —— 那些要**真实会话驱动**，本脚本不驱动会话（属后续）。
 *   ⚠️ A1 的诚实边界（写进报告，不藏着）：两臂共用**同一条** --face ⇒ 「两臂脸相同」在当前
 *      参数形态下是**构造性成立**的；实测的部分是「这个面到底暴露了什么」。它**不是**真实
 *      会话 request/header 的 system+tools 快照（那条路要真实会话，未接入）。
 *
 * 退出码：0 = 无硬失败（VALID 或 NEEDS-EVIDENCE）／1 = BATCH-INVALID／2 = 用法错误／
 *         3 = CONTROL-FAILED／4 = 自检机器自身坏了（注入数据被污染、禁用词泄漏等）
 *
 * ── 不变量（改这个文件必须保住） ──────────────────────────────────────────
 *   1. 报告顶部固定那句免责声明；脚本自身**绝不**输出任何「关于效果的结论」
 *   2. 缺读数 ⇒ NEEDS-EVIDENCE，**绝不当 OK**
 *   3. 汇总区不出现「通过」二字（避免「缺读数冒充通过」）
 *   4. --plan 无任何副作用
 *
 * ── face 指纹：为什么是【本地移植】而不是【调用 face-audit.mjs】 ──────────
 *   1) scripts/face-audit.mjs 是**无任何导出的顶层脚本**：import 它就会跑完整套会话扫描，
 *      并重写 out/face-audit.txt（一个既有产物）⇒ 与本任务「--plan 什么都不做 / 只新增两个文件」冲突；
 *   2) 它没有「给一份 system+tools 算 face」的 CLI，而两臂的 face 输入在骨架期
 *      **还不存在于任何日志里**（没有真实会话可言）。
 *   ⇒ 照它的算法（dsh-face/v1）移植一份，并加【漂移哨兵】：每次运行都检查上游源码里
 *     算法锚点字面量是否还在；缺失就在报告里显式报警（**不静默**）。
 *   ⚠ 哨兵只查锚点，**不证明逐字等价** —— 这条进报告的「不确定/未验证」。
 *   · 与上游的**唯一有意差异**：断言用的指纹先做**端口归一化**（设计 §3.3 明确要求，
 *     spec §21.4 / O33 的实测教训：端口是能力无关的易变量）。
 *     报告里 raw（逐字同构上游，可与日志比对）与 normalized（用于断言）两个值都打印。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ───────────────────────── 常量 ─────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STUB = path.join(ROOT, 'scripts', 'memory-stub.mjs')
const FACE_AUDIT_SRC = path.join(ROOT, 'scripts', 'face-audit.mjs')
const DEFAULT_REPORT = path.join(ROOT, 'out', 'memory-judge-report.txt')
const DEFAULT_ARM_DB = {
  A: path.join(ROOT, 'out', 'memory-judge', 'arm-a.json'),
  B: path.join(ROOT, 'out', 'memory-judge', 'arm-b.json'),
}
const SELFTEST_ARM_DB = {
  A: path.join(ROOT, 'out', 'memory-judge', 'selftest', 'arm-a.json'),
  B: path.join(ROOT, 'out', 'memory-judge', 'selftest', 'arm-b.json'),
}
/** ★ 面驱动（--face）时的默认落点：**目录**（面 = 目录型 store），故意不带 .json。 */
const FACE_ARM_DB = {
  A: path.join(ROOT, 'out', 'memory-judge', 'face', 'arm-a'),
  B: path.join(ROOT, 'out', 'memory-judge', 'face', 'arm-b'),
}
/** 面自身的 probe 库（量「面暴露了什么」用；打在这里，不碰两臂的库）。 */
const FACE_PROBE_DB = path.join(ROOT, 'out', 'memory-judge', 'face', 'probe')
/**
 * ★ `--selftest` + `--face` 时的落点。
 *   不能沿用 SELFTEST_ARM_DB：那两条路径带 `.json` 后缀（stub 眼里是文件），
 *   而面驱动默认把 --db 当**目录**（见 FACE_ARM_DB 的注释）⇒ 会在同一个路径上
 *   「文件 vs 目录」撞车。这里给面驱动的自检另开一个沙箱。
 */
const SELFTEST_FACE_ARM_DB = {
  A: path.join(ROOT, 'out', 'memory-judge', 'selftest-face', 'arm-a'),
  B: path.join(ROOT, 'out', 'memory-judge', 'selftest-face', 'arm-b'),
}
const REPORT_NAME = 'memory-effect-judge'

/**
 * ★ 记忆面命令的 argv。默认 = `node scripts/memory-stub.mjs` ——
 *   与加 --face 之前**逐字同一条调用**（parseArgs 后若给了 --face 才被替换）。
 */
let FACE_ARGV = [process.execPath, STUB]
/** 面的人类可读描述（进报告）。 */
let FACE_DESC = 'scripts/memory-stub.mjs（默认桩）'
/** 是否显式给了 --face（决定 REAL 走骨架态还是面驱动；也决定若干叙述用词）。 */
let FACE_GIVEN = false

const DISCLAIMER = '★ 本报告只证明判据机器可用，不构成关于记忆效果的结论'
const SELFTEST_BANNER = 'SELFTEST — 数据为注入的假读数，无任何外部含义'

/** 四态（§5 纪律：缺读数一律 NEEDS-EVIDENCE）。 */
const ST = { OK: 'OK', NE: 'NEEDS-EVIDENCE', FAIL: 'FAIL', NA: 'N/A' }

/** (甲) 序列型要逐题读的指标。 */
const METRICS_SEQ = ['toolCalls', 'tokens', 'wallClock', 'rework']
/** (乙) 单次型要逐题读的指标。 */
const METRICS_ONE = ['oracle', 'regression']

/** ★ 脚本自证：报告里**不许**出现这些断言式说法（机器自检 S6 会扫）。 */
const FORBIDDEN_IN_REPORT = [
  /记忆有效/,
  /记忆无效/,
  /记忆起作用/,
  /证明记忆/,
  /记忆提升/,
  /记忆没有效果/,
  /记忆是有效/,
  /记忆是无效/,
]

const BREAKS = {
  'control-nonempty': '让控制臂（臂 A）的 count>0 ⇒ 断言 2 应变红',
  'k1-differs': '让 k=1 两臂读数就有差别 ⇒ 阳性对照应变红',
}

const USAGE = `${REPORT_NAME} —— 记忆效果判据机器骨架（不驱动真实会话，不产结论）

用法：
  node scripts/memory-effect-judge.mjs --plan
  node scripts/memory-effect-judge.mjs --selftest
  node scripts/memory-effect-judge.mjs                       # REAL 模式（无真实读数 ⇒ 全部 NEEDS-EVIDENCE）
  node scripts/memory-effect-judge.mjs --face "<cmd>"        # REAL·面驱动（三条对照断言有真读数）
  node scripts/memory-effect-judge.mjs --face "<cmd>" --face-readonly
                                                             # REAL·面驱动·只读（读真实 store 的 count，不 reset）

参数：
  --readings <file>   外部读数 JSON 取代内置假数据
  --face <cmd>        ★ 记忆面命令（默认 node scripts/memory-stub.mjs）；
                      给了它 ⇒ REAL 模式变「面驱动」，真调该面做 reset/remember/count
  --face-readonly     ★ 只读开关（必须配 --face）：只调 count，不 reset / 不 remember；
                      --arm-a/--arm-b 可给逗号分隔的多个 db（各 k 的 store 快照）⇒ 逐 k 真 count；
                      报告里额外给「读数前后 store 逐文件 sha256 一致」的完整性证据
  --arm-a <path>      臂 A（控制，空库）的 db 路径（--face-readonly 下可逗号分隔多个）
  --arm-b <path>      臂 B（处理，累积）的 db 路径（同上）
  --out <path>        报告路径（默认 ${path.relative(ROOT, DEFAULT_REPORT)}）
  --break <name>      故意破坏注入数据（仅配 --selftest）：${Object.keys(BREAKS).join(' | ')}

退出码：0 无硬失败 / 1 BATCH-INVALID / 2 用法错误 / 3 CONTROL-FAILED / 4 自检机器自身坏了
`

// ───────────────────────── 参数 ─────────────────────────

function parseArgs(argv) {
  const opts = Object.create(null)
  const flags = new Set()
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 2) {
      opts[a.slice(2, eq)] = a.slice(eq + 1)
      continue
    }
    const key = a.slice(2)
    const val = argv[i + 1]
    if (val === undefined || val.startsWith('--')) {
      flags.add(key)
      continue
    }
    opts[key] = val
    i++
  }
  return { opts, flags, rest }
}

function usage(msg) {
  process.stderr.write(`[${REPORT_NAME}] 用法错误：${msg}\n\n${USAGE}`)
  process.exit(2)
}

// ───────────────────────── face 指纹（dsh-face/v1，本地移植） ─────────────────────────
// 逐字同构 scripts/face-audit.mjs 的 canonical / sha8 / toolNameOf / faceOf。

const FACE_VERSION = 'dsh-face/v1'

/** 递归规范化 JSON：对象键按码位升序、无空白；数组保序。 */
function canonical(v) {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v)
    return s === undefined ? 'null' : s
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

const sha8 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)
const toolNameOf = (t) => t?.name ?? t?.function?.name ?? ''
const PORT_RE = /127\.0\.0\.1:\d+/g
const normalizePorts = (t) => String(t).replace(PORT_RE, '127.0.0.1:PORT')

/**
 * 算一次「脸」。normalize=true 时先做端口归一化（**断言用**；raw 对得上日志里的 face）。
 * @returns {{face:string,namesHash:string,names:string[],count:number,sysLen:number}}
 */
function faceOf(system, tools, { normalize = false } = {}) {
  const sysRaw = typeof system === 'string' ? system : String(system ?? '')
  const sys = normalize ? normalizePorts(sysRaw) : sysRaw
  const list = Array.isArray(tools) ? tools : []
  const byName = new Map()
  for (const t of list) {
    const n = toolNameOf(t)
    if (!byName.has(n)) byName.set(n, t) // 同名取首个（上游已知假阴性，照搬）
  }
  const names = [...byName.keys()].sort() // ★ 字典序
  const parts = [FACE_VERSION, '|S|' + sys.length, sys, '|T|' + names.length]
  for (const n of names) {
    const body = canonical(byName.get(n))
    parts.push(n, normalize ? normalizePorts(body) : body)
  }
  return {
    face: sha8(parts.join('\n')),
    namesHash: sha8(names.join('\n')),
    names,
    count: list.length,
    sysLen: sys.length,
  }
}

/** 漂移哨兵：只查上游源码里的算法锚点字面量（**不证明逐字等价**，见文件头）。 */
function facePortSentinel() {
  const anchors = [
    ['版本头 dsh-face/v1', /dsh-face\/v1/],
    ['system 长度前缀 |S|', /\|S\|/],
    ['工具数前缀 |T|', /\|T\|/],
    ['8 位 hex 截断 .slice(0, 8)', /\.slice\(0,\s*8\)/],
    ['工具名字典序 .sort()', /\.sort\(\)/],
    ['端口字面量 127.0.0.1', /127\\\.0\\\.0\\\.1/],
    ['递归规范化 function canonical', /function canonical/],
  ]
  let src
  try {
    src = fs.readFileSync(FACE_AUDIT_SRC, 'utf8')
  } catch (e) {
    return { state: ST.NE, detail: `读不到上游源码 ${FACE_AUDIT_SRC}：${e?.message ?? e}` }
  }
  const miss = anchors.filter(([, re]) => !re.test(src)).map(([n]) => n)
  if (miss.length) {
    return {
      state: ST.FAIL,
      detail: `上游 ${path.basename(FACE_AUDIT_SRC)} 里找不到锚点：${miss.join('、')} ⇒ 本地移植可能已漂移，需人工比对（不静默）`,
    }
  }
  return {
    state: ST.OK,
    detail: `上游 ${path.basename(FACE_AUDIT_SRC)} 的 ${anchors.length} 个算法锚点字面量都在（⚠ 只查锚点，不证明逐字等价）`,
  }
}

// ───────────────────────── 面的调用（真调，不是假设） ─────────────────────────
//
// ★ 默认 FACE_ARGV = [node, scripts/memory-stub.mjs] ⇒ 不带 --face 时这一层的行为
//   与加 --face 之前**完全一致**（同一个 execFileSync 调用形态、同一套 stdout 解析）。
// ★ 给了 --face ⇒ 换成用户给的命令；argv 用 shell-like 拆分（支持引号包裹的路径）。

/** 把 `--face "<cmd>"` 拆成 argv。支持单/双引号分组（不解释转义）；空 token 丢弃。 */
function splitCmd(s) {
  const out = []
  let cur = ''
  let quote = null
  let started = false
  for (const ch of String(s)) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
  }
  if (quote) throw new Error(`--face 的引号没有闭合：${s}`)
  if (started || cur) out.push(cur)
  return out
}

/** 面命令的逐字行（进 face 指纹的 system 部分）。 */
function faceArgvLine() {
  return FACE_ARGV.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')
}

/** 调一次面，解析 stdout 的单行 JSON。失败 ⇒ {ok:false}，调用方按 NEEDS-EVIDENCE 处理。 */
function faceRun(args) {
  try {
    const out = execFileSync(FACE_ARGV[0], [...FACE_ARGV.slice(1), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const line = String(out).split('\n').find((l) => l.trim())
    if (!line) return { ok: false, error: '面 stdout 为空' }
    return { ok: true, value: JSON.parse(line) }
  } catch (e) {
    const err = String(e?.stderr ?? '').trim() || String(e?.message ?? e)
    return { ok: false, error: err }
  }
}

/** 读某臂在某检查点的条目数。**真调面的 count**（count 是只读的）。 */
function readCount(dbPath, k) {
  const r = faceRun(['count', '--db', dbPath])
  return {
    k,
    count: r.ok ? r.value.count : null,
    err: r.ok ? null : r.error,
    dbExists: fs.existsSync(dbPath),
  }
}

/** ★ 只读模式的完整性证据：递归列目录下每个文件的相对路径 + sha256（**只读，不写**）。 */
function dirHashes(dir) {
  const out = []
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p, r)
      else if (e.isFile()) {
        out.push({
          rel: r,
          bytes: fs.statSync(p).size,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
        })
      }
    }
  }
  walk(dir, '')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 量「面」：四条子命令各真打一发（写操作打在 probe 库上，**不碰两臂的库**），
 * 记下这个面**实测暴露的工具面**。返回 {ok, surface, detail}。
 *
 * ★ 为什么不是「两臂会话日志的 system+tools 快照」：那要**真实会话**（本脚本不驱动会话，
 *   属后续）。这里量的是「面自身可观测到的面」—— 它是**实测**的，不是注入的常量。
 * ★ 判据：每条子命令都要按契约形状回话；任一不回 ⇒ ok=false ⇒ A1 记 NEEDS-EVIDENCE（不当 OK）。
 */
function probeFace() {
  const surface = []
  const bad = []
  const add = (name, contract, good) => {
    surface.push({ name, contract, measured: good ? 'ok' : 'not-ok' })
    if (!good) bad.push(name)
  }

  const reset = faceRun(['reset', '--db', FACE_PROBE_DB])
  add('reset', '{db,count}', reset.ok && typeof reset.value?.count === 'number')

  const c0 = faceRun(['count', '--db', FACE_PROBE_DB])
  add('count', '{db,count}', c0.ok && typeof c0.value?.count === 'number')

  const rem = faceRun(['remember', '--db', FACE_PROBE_DB, '--text', '（面探测）这一条只为量出面暴露了什么', '--kind', 'probe'])
  add('remember', '{db,count}', rem.ok && typeof rem.value?.count === 'number')

  const c1 = faceRun(['count', '--db', FACE_PROBE_DB])
  add('count#after-remember', '{db,count}', c1.ok && typeof c1.value?.count === 'number')

  const rec = faceRun(['recall', '--db', FACE_PROBE_DB, '--query', '面', '--limit', '5'])
  add('recall', '[{text,kind,at}]', rec.ok && Array.isArray(rec.value))

  const reset2 = faceRun(['reset', '--db', FACE_PROBE_DB])
  add('reset#cleanup', '{db,count}', reset2.ok && typeof reset2.value?.count === 'number')

  const ok = bad.length === 0
  return {
    ok,
    state: ok ? ST.OK : ST.NE, // 面不可用 ⇒ A1 记 NEEDS-EVIDENCE（不当 OK）
    surface,
    detail: ok
      ? `面「${faceArgvLine()}」实测暴露 ${surface.length} 个契约点，全部按契约形状回话`
      : `面「${faceArgvLine()}」有 ${bad.length} 个契约点没按形状回话：${bad.join('、')}`,
  }
}

// ───────────────────────── 注入数据（假读数） ─────────────────────────

/** 骨架期的任务序列：**同一族**的 5 题（见 evals/pilot/tasks.jsonl §2.4）。 */
function taskList() {
  return [
    { k: 1, id: 'cli-0001-injected-message-identity', title: '注入会话的消息必须带 id 与 source', shape: 'sequence' },
    { k: 2, id: 'cli-0002-seal-before-unlock', title: '交接封口：先强杀未确认停写的旧代再放锁', shape: 'sequence' },
    { k: 3, id: 'cli-0003-prepareswitch-real-phase', title: 'defer 判断要直读 agent 真实阶段', shape: 'sequence' },
    { k: 4, id: 'cli-0005-symbol-rename-design-canvas', title: '按语义重命名，行为逐字不变', shape: 'sequence' },
    { k: 5, id: 'cli-0004-verify-drain-json-output', title: '给验收脚本加 --json，旧行为一字不变', shape: 'sequence' },
  ]
}

/**
 * 内置假读数。★ 它是**注入的假数据**，只用来证明「判据机器可用」，无任何外部含义。
 * 特意埋了三处，让四态都出现：
 *   · 臂 A k=3 oracle='fail'        ⇒ FAIL（读数命中不了期望值）
 *   · 臂 A k=4 缺 wallClock          ⇒ NEEDS-EVIDENCE
 *   · 臂 B k=3 缺 tokens             ⇒ NEEDS-EVIDENCE
 *   · k=1 两臂逐字相同               ⇒ Δ 无定义（N/A），且阳性对照应 OK
 */
function selftestData() {
  const sysA = '（假）两臂 system 完全相同，除端口外逐字一致。web gui = http://127.0.0.1:3083/mcp'
  const sysB = '（假）两臂 system 完全相同，除端口外逐字一致。web gui = http://127.0.0.1:3999/mcp'
  const tools = () => [
    { name: 'bash', description: 'run a shell command', inputSchema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
    { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'memory_recall', description: '检索记忆', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'memory_remember', description: '写入记忆', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ]
  const A1 = { toolCalls: 42, tokens: 51000, wallClock: 380, rework: 1, oracle: 'pass', regression: 'pass' }
  return {
    label: SELFTEST_BANNER,
    source: '脚本内置常量 selftestData()',
    tasks: taskList(),
    arms: {
      A: {
        role: '控制臂（空库）',
        faceInput: { system: sysA, tools: tools() },
        // 每一 k 在读数【之前】要往库里追加的条目（控制臂：一条都不加）
        addBeforeK: [[], [], [], [], []],
      },
      B: {
        role: '处理臂（累积）',
        faceInput: { system: sysB, tools: tools() },
        // ★ k=1 起点也是空的 —— 这正是「k=1 两臂应无差别」的原因
        addBeforeK: [
          [],
          ['假读数：cli-0001 的坑 = 注入会话的消息必须带 id 与 source，否则整份会话历史读不出来'],
          ['假读数：cli-0002 的坑 = 交接必须先把未确认停写的旧代强杀，再放门锁'],
          ['假读数：cli-0003 的坑 = defer 判断必须直读 agent 真实阶段，不能跨插件事件'],
          ['假读数：cli-0005 的坑 = 语义重命名要跨导出/导入/调用跟改，局部同名变量与字符串常量不许动'],
        ],
      },
    },
    readings: {
      A: {
        1: A1,
        2: { toolCalls: 55, tokens: 63000, wallClock: 470, rework: 2, oracle: 'pass', regression: 'pass' },
        3: { toolCalls: 48, tokens: 58000, wallClock: 430, rework: 1, oracle: 'fail', regression: 'pass' },
        4: { toolCalls: 27, tokens: 31000, rework: 0, oracle: 'pass', regression: 'pass' }, // 故意缺 wallClock
        5: { toolCalls: 33, tokens: 39000, wallClock: 290, rework: 1, oracle: 'pass', regression: 'pass' },
      },
      B: {
        1: { ...A1 }, // ★ 与臂 A 的 k=1 逐字相同 ⇒ 阳性对照
        2: { toolCalls: 41, tokens: 47000, wallClock: 350, rework: 1, oracle: 'pass', regression: 'pass' },
        3: { toolCalls: 35, wallClock: 300, rework: 0, oracle: 'pass', regression: 'pass' }, // 故意缺 tokens
        4: { toolCalls: 19, tokens: 22000, wallClock: 170, rework: 0, oracle: 'pass', regression: 'pass' },
        5: { toolCalls: 24, tokens: 27000, wallClock: 200, rework: 0, oracle: 'pass', regression: 'pass' },
      },
    },
  }
}

/** REAL 模式的空骨架：没有真实会话 ⇒ 没有 face 输入、没有读数、没有检查点。 */
function realData() {
  return {
    label: null,
    source: '（无）骨架期没有真实会话读数',
    tasks: taskList(),
    arms: {
      A: { role: '控制臂（空库）', faceInput: null, checkpointsK: [], addBeforeK: [] },
      B: { role: '处理臂（累积）', faceInput: null, checkpointsK: [], addBeforeK: [] },
    },
    readings: { A: {}, B: {} },
  }
}

/**
 * REAL + --face：**面驱动**。判据真调那条面做一轮「累积排练」，好让 §3.3 的三条对照断言
 * 拿到真读数（真 `reset` 建库 / 臂 B 逐 k 真 `remember` / 每个 k 真 `count`）。
 *
 * ★ 它【只】产对照体检要的读数（两臂 count 序列 + 面指纹）；
 *   ★ **任务级读数一格都不产**（toolCalls/tokens/wallClock/rework/oracle/regression）——
 *     那些要真实会话驱动 ⇒ 继续 NEEDS-EVIDENCE（**不许填**）。
 *
 * ★ 排练的文本取自 taskList()（真实的任务 id/标题），不是凭空编的观测值：
 *   它要证的只有一件事 —— **这条面的写入口真的会让条目数增长**。
 *
 * @param {{ok:boolean, surface:Array<{name:string,contract:string,measured:string}>, detail:string}} probe
 */
function faceData(probe) {
  const tasks = taskList()
  const note = (t) => `k=${t.k} [${t.id}] ${t.title}`
  // 两臂的「面」= 同一个**实测**面（同一条面命令）⇒ A1 的输入不是注入的常量。
  // ★ 面若不可用（probe.ok=false）⇒ faceInput 留 null ⇒ A1 记 NEEDS-EVIDENCE（不当 OK）。
  const faceInput = probe.ok
    ? { system: `dsh-memory-face/v1\nargv: ${faceArgvLine()}`, tools: probe.surface }
    : null
  const ks = tasks.map((t) => t.k)
  return {
    label: null,
    source: `面驱动（${FACE_DESC}）：真调面做 reset/remember/count 排练 ⇒ 对照体检三条断言有真读数；任务级读数仍无（无真实会话）`,
    tasks,
    arms: {
      A: { role: '控制臂（空库）', faceInput, checkpointsK: ks, addBeforeK: tasks.map(() => []) },
      B: {
        role: '处理臂（累积，面驱动）',
        faceInput,
        checkpointsK: ks,
        // ★ k=1 起点也是空的 —— 与 selftest 同形状（0→1→2→3→4）
        addBeforeK: tasks.map((t, i) => (i === 0 ? [] : [note(t)])),
      },
    },
    readings: { A: {}, B: {} },
  }
}

/** 外部读数 JSON（将来驱动器产出的形状）。宽松校验：缺字段 ⇒ 缺读数 ⇒ NEEDS-EVIDENCE。 */
function loadReadings(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    usage(`读不到 --readings 文件 ${file}：${e?.message ?? e}`)
  }
  let d
  try {
    d = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch (e) {
    usage(`--readings 文件不是合法 JSON：${e?.message ?? e}`)
  }
  if (!d || typeof d !== 'object') usage('--readings 顶层必须是对象')
  if (!Array.isArray(d.tasks)) usage('--readings 缺 tasks 数组')
  if (!d.arms || typeof d.arms !== 'object') usage('--readings 缺 arms 对象')
  if (!d.readings || typeof d.readings !== 'object') usage('--readings 缺 readings 对象')
  return {
    label: typeof d.label === 'string' ? d.label : null,
    source: typeof d.source === 'string' ? d.source : file,
    tasks: d.tasks,
    arms: d.arms,
    readings: d.readings,
  }
}

/** ★ 故意破坏注入数据（只用于证明判据有分辨力）。 */
function applyBreak(data, name) {
  const d = structuredClone(data)
  if (name === 'control-nonempty') {
    if (!Array.isArray(d.arms.A.addBeforeK) || !d.arms.A.addBeforeK.length) {
      d.arms.A.addBeforeK = d.tasks.map(() => [])
    }
    d.arms.A.addBeforeK[0] = ['★ 注入的坏数据：控制臂不该有任何记忆，这里故意塞一条']
  } else if (name === 'k1-differs') {
    const k1 = d.readings.B[1] ?? d.readings.B['1']
    if (!k1 || typeof k1.toolCalls !== 'number') {
      usage(`--break k1-differs 需要注入数据里存在 臂B k=1 的 toolCalls（当前是 ${JSON.stringify(k1 ?? null)}）`)
    }
    k1.toolCalls = k1.toolCalls - 7
  }
  return d
}

// ───────────────────────── 读数/四态 ─────────────────────────

function reading(data, arm, k, metric) {
  const g = data.readings?.[arm]
  if (!g) return undefined
  const row = g[k] ?? g[String(k)]
  if (!row || typeof row !== 'object') return undefined
  const v = row[metric]
  return v === undefined ? undefined : v
}

/** 数值/文本读数：有 ⇒ OK，没有 ⇒ NEEDS-EVIDENCE。 */
function readCell(v) {
  return v === undefined || v === null
    ? { state: ST.NE, text: '(缺读数)' }
    : { state: ST.OK, text: String(v) }
}

/** 期望值类读数（oracle/regression 的 expect 是 'pass'）：不符 ⇒ FAIL。 */
function expectCell(v, expect) {
  if (v === undefined || v === null) return { state: ST.NE, text: '(缺读数)' }
  return { state: String(v) === expect ? ST.OK : ST.FAIL, text: String(v) }
}

/** (甲) 的 Δ = B − A：负数=处理臂读数更小。缺任一侧 ⇒ NEEDS-EVIDENCE。 */
function deltaCell(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) {
    return { state: ST.NE, text: '(缺读数)' }
  }
  const n = Number(b) - Number(a)
  return { state: ST.OK, text: (n > 0 ? '+' : '') + String(n) }
}

function sameTextCell(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) {
    return { state: ST.NE, text: '(缺读数)' }
  }
  return { state: ST.OK, text: String(a) === String(b) ? '一致' : '不一致' }
}

// ───────────────────────── 断言（纯函数：输入是读数，不含副作用） ─────────────────────────

/**
 * 对照体检（§3.3 三条断言）。**纯函数**：counts 由调用方给（真跑时来自面，自检电池里来自常量）。
 * @param {{faceNormA:string|null,faceNormB:string|null,faceRawA:string|null,faceRawB:string|null,
 *          countsA:Array<{k:number,count:number|null,dbExists:boolean}>,
 *          countsB:Array<{k:number,count:number|null,dbExists:boolean}>}} ins
 * @param {string} cntLabel count 读数的**来源标签**（只影响叙述；默认 'stub count' ⇒ 电池输出不变）
 * @param {string} portNote face 不同的尾巴注释（默认逐字同以前 ⇒ 电池与骨架态输出不变）
 */
function assessBatch(ins, cntLabel = 'stub count', portNote = '；归一化抹掉 Web GUI 端口差') {
  const assertions = []

  // ── 断言 1：两臂 face 指纹相同（用归一化后的脸）
  if (!ins.faceNormA || !ins.faceNormB) {
    assertions.push({
      id: 'A1',
      name: '两臂 face 指纹相同',
      state: ST.NE,
      detail: '缺两臂的 system+tools 快照 ⇒ 算不出脸（骨架期没有真实会话）',
    })
  } else {
    const same = ins.faceNormA === ins.faceNormB
    const rawSame = ins.faceRawA === ins.faceRawB
    assertions.push({
      id: 'A1',
      name: '两臂 face 指纹相同',
      state: same ? ST.OK : ST.FAIL,
      detail: `normalized ${ins.faceNormA} vs ${ins.faceNormB} ⇒ 相同=${same ? '是' : '否'}；raw ${ins.faceRawA} vs ${ins.faceRawB}（raw 相同=${rawSame ? '是' : '否'}${portNote}）`,
    })
  }

  // ── 断言 2：控制臂（臂 A）记忆真的空（真调面读 count）
  if (!ins.countsA.length) {
    assertions.push({ id: 'A2', name: '控制臂（臂 A）记忆 count == 0', state: ST.NE, detail: '没有任何检查点读数' })
  } else {
    const bad = ins.countsA.filter((c) => c.count === null)
    const missingDb = ins.countsA.filter((c) => c.count !== null && !c.dbExists)
    const nonZero = ins.countsA.filter((c) => c.count !== null && c.count !== 0)
    const seq = ins.countsA.map((c) => (c.count === null ? '?' : c.count)).join(',')
    let state = ST.OK
    let why = `${cntLabel} 序列(k=1..)= ${seq}`
    if (bad.length) {
      state = ST.NE
      why = `${cntLabel} 读失败(${bad.length} 个检查点)：${bad[0].err}；序列= ${seq}`
    } else if (missingDb.length) {
      state = ST.NE
      why = `db 文件不存在（该臂从未初始化/未跑）⇒ 0 只是「文件缺失」的默认值，不算空库证据；序列= ${seq}`
    } else if (nonZero.length) {
      state = ST.FAIL
      why = `存在非 0 检查点 k=${nonZero.map((c) => `${c.k}:${c.count}`).join(' ')}；序列= ${seq}`
    }
    assertions.push({ id: 'A2', name: '控制臂（臂 A）记忆 count == 0', state, detail: why })
  }

  // ── 断言 3：处理臂（臂 B）记忆 count 随 k 严格递增，且末项 > 0
  if (ins.countsB.length < 2) {
    assertions.push({
      id: 'A3',
      name: '处理臂（臂 B）记忆 count 随 k 严格递增',
      state: ST.NE,
      detail: `只有 ${ins.countsB.length} 个检查点 ⇒ 「随 k 增长」无法判定`,
    })
  } else {
    const bad = ins.countsB.filter((c) => c.count === null)
    const seq = ins.countsB.map((c) => (c.count === null ? '?' : c.count)).join('→')
    let state = ST.OK
    let why = `${cntLabel} 序列(k 递增)= ${seq}`
    if (bad.length) {
      state = ST.NE
      why = `${cntLabel} 读失败(${bad.length} 个检查点)：${bad[0].err}；序列= ${seq}`
    } else {
      const nums = ins.countsB.map((c) => c.count)
      const inc = nums.every((n, i) => i === 0 || n > nums[i - 1])
      const last = nums[nums.length - 1]
      if (!inc) {
        state = ST.FAIL
        why = `不严格递增；序列= ${seq}`
      } else if (!(last > 0)) {
        state = ST.FAIL
        why = `末项不是正的（末项=${last}）⇒「非空」不成立；序列= ${seq}`
      } else {
        why = `序列= ${seq}（严格递增=是，末项=${last}>0=是）`
      }
    }
    assertions.push({ id: 'A3', name: '处理臂（臂 B）记忆 count 随 k 严格递增', state, detail: why })
  }

  const verdict = assertions.some((a) => a.state === ST.FAIL)
    ? 'BATCH-INVALID'
    : assertions.some((a) => a.state === ST.NE)
      ? 'NEEDS-EVIDENCE'
      : 'VALID'
  return { assertions, verdict }
}

/** 阳性对照（§2.4）：k=1 两臂应无差别。纯函数。 */
function assessPositiveControl(data) {
  const k = 1
  const metrics = [...METRICS_SEQ, ...METRICS_ONE]
  const diffs = []
  const missing = []
  for (const m of metrics) {
    const a = reading(data, 'A', k, m)
    const b = reading(data, 'B', k, m)
    if (a === undefined || b === undefined) {
      missing.push(m)
      continue
    }
    if (String(a) !== String(b)) diffs.push(`${m}: A=${a} B=${b}`)
  }
  if (diffs.length) {
    return { state: 'CONTROL-FAILED', diffs, missing, detail: `k=1 就有差别的指标：${diffs.join('；')}` }
  }
  if (missing.length) {
    return {
      state: ST.NE,
      diffs,
      missing,
      detail: `k=1 上缺读数 ⇒ 无法声称「k=1 无差别」（缺：${missing.join('、')}；A 侧或 B 侧任一缺即算缺）`,
    }
  }
  return { state: ST.OK, diffs, missing, detail: `k=1 上 ${metrics.length} 个指标两臂逐字相同 ⇒ 阳性对照成立（A/B 干净：起点一致）` }
}

// ───────────────────────── 自检电池（纯函数级：证明判据有分辨力） ─────────────────────────

function battery() {
  const out = []
  const data = selftestData()
  const tasks = data.tasks
  const faces = (d) => {
    const fa = d.arms.A.faceInput
    const fb = d.arms.B.faceInput
    const rA = fa ? faceOf(fa.system, fa.tools, { normalize: false }) : null
    const rB = fb ? faceOf(fb.system, fb.tools, { normalize: false }) : null
    const nA = fa ? faceOf(fa.system, fa.tools, { normalize: true }) : null
    const nB = fb ? faceOf(fb.system, fb.tools, { normalize: true }) : null
    return { faceRawA: rA?.face ?? null, faceRawB: rB?.face ?? null, faceNormA: nA?.face ?? null, faceNormB: nB?.face ?? null }
  }

  // ★ 正常数据（合成 count：A 全 0，B 0→1→2→3→4）
  const goodB = tasks.map((t) => ({ k: t.k, count: t.k - 1, dbExists: true }))
  const good = assessBatch({
    ...faces(data),
    countsA: tasks.map((t) => ({ k: t.k, count: 0, dbExists: true })),
    countsB: goodB,
  })
  out.push({
    id: 'S3',
    name: '正常数据下三断言应全 OK ⇒ VALID',
    state: good.verdict === 'VALID' ? ST.OK : ST.FAIL,
    detail: `verdict=${good.verdict}；断言状态 ${good.assertions.map((a) => `${a.id}:${a.state}`).join(' ')}`,
  })

  // ★ 坏数据 1：控制臂 count>0 ⇒ 必须 BATCH-INVALID
  const b1 = assessBatch({
    ...faces(data),
    countsA: tasks.map((t) => ({ k: t.k, count: 1, dbExists: true })),
    countsB: goodB,
  })
  out.push({
    id: 'S4',
    name: '坏数据（控制臂 count>0）应变红 ⇒ BATCH-INVALID',
    state: b1.verdict === 'BATCH-INVALID' ? ST.OK : ST.FAIL,
    detail: `verdict=${b1.verdict}（期望 BATCH-INVALID）；A2 state=${b1.assertions.find((a) => a.id === 'A2')?.state}`,
  })

  // ★ 坏数据 2：两臂脸不同（多一个工具）⇒ 必须 BATCH-INVALID
  const drift = structuredClone(data)
  drift.arms.B.faceInput.tools.push({ name: 'extra_tool', description: '多出来的工具', inputSchema: { type: 'object' } })
  const b2 = assessBatch({
    ...faces(drift),
    countsA: tasks.map((t) => ({ k: t.k, count: 0, dbExists: true })),
    countsB: goodB,
  })
  out.push({
    id: 'S5',
    name: '坏数据（两臂脸不同）应变红 ⇒ BATCH-INVALID',
    state: b2.verdict === 'BATCH-INVALID' ? ST.OK : ST.FAIL,
    detail: `verdict=${b2.verdict}（期望 BATCH-INVALID）；A1 state=${b2.assertions.find((a) => a.id === 'A1')?.state}`,
  })

  // ★ 坏数据 3：k=1 就有差别 ⇒ 必须 CONTROL-FAILED
  const p = assessPositiveControl(applyBreak(data, 'k1-differs'))
  out.push({
    id: 'S6',
    name: '坏数据（k=1 就有差别）应变红 ⇒ CONTROL-FAILED',
    state: p.state === 'CONTROL-FAILED' ? ST.OK : ST.FAIL,
    detail: `${p.detail}`,
  })

  // face 移植自身有分辨力：同输入同脸；改一个工具 ⇒ 脸变；只差端口 ⇒ raw 变 / normalized 不变
  const fa = data.arms.A.faceInput
  const f1 = faceOf(fa.system, fa.tools, { normalize: true }).face
  const f2 = faceOf(fa.system, structuredClone(fa.tools), { normalize: true }).face
  const f3 = faceOf(fa.system, [...structuredClone(fa.tools), { name: 'extra_tool' }], { normalize: true }).face
  const rawA = faceOf(data.arms.A.faceInput.system, fa.tools, { normalize: false }).face
  const rawB = faceOf(data.arms.B.faceInput.system, data.arms.B.faceInput.tools, { normalize: false }).face
  const okFace = f1 === f2 && f1 !== f3 && rawA !== rawB
  out.push({
    id: 'S7',
    name: 'face 移植有分辨力（确定性 / 加工具就变 / 仅端口差不影响归一化脸）',
    state: okFace ? ST.OK : ST.FAIL,
    detail: `确定性=${f1 === f2 ? '是' : '否'}；加一个工具后变化=${f1 !== f3 ? '是' : '否'}；raw(仅端口差)=${rawA}/${rawB} 不同=${rawA !== rawB ? '是' : '否'}；normalized 相同=${f1 === faceOf(data.arms.B.faceInput.system, data.arms.B.faceInput.tools, { normalize: true }).face ? '是' : '否'}`,
  })

  return { checks: out, ok: out.every((c) => c.state === ST.OK) }
}

// ───────────────────────── 采集两臂状态 ─────────────────────────

/**
 * 臂状态。
 *   selftest / face    ：**建库**（reset + remember，都是真调面）
 *   face-readonly      ：★★ **只读**：只调 count；读前后对每个 db 目录做逐文件 sha256 做完整性证据
 *   real               ：只**只读** count（骨架期属实没有真实会话；记忆由将来的真实运行写入）
 */
function collectArm(data, arm, dbPaths, mode) {
  const dbPath = dbPaths[0]
  const role = data.arms?.[arm]?.role ?? arm
  const fi = data.arms?.[arm]?.faceInput ?? null
  const fRaw = fi ? faceOf(fi.system, fi.tools, { normalize: false }) : null
  const fNorm = fi ? faceOf(fi.system, fi.tools, { normalize: true }) : null
  let counts = []
  let seeded = false
  let seedErr = null

  if (mode === 'selftest' || mode === 'face') {
    const r = faceRun(['reset', '--db', dbPath])
    if (!r.ok) seedErr = `reset 失败：${r.error}`
    seeded = r.ok
    const add = Array.isArray(data.arms?.[arm]?.addBeforeK) ? data.arms[arm].addBeforeK : []
    for (const t of data.tasks) {
      const adds = Array.isArray(add[t.k - 1]) ? add[t.k - 1] : []
      for (const txt of adds) {
        const w = faceRun(['remember', '--db', dbPath, '--text', String(txt), '--kind', 'note'])
        if (!w.ok && !seedErr) seedErr = `remember 失败：${w.error}`
      }
      counts.push(readCount(dbPath, t.k))
    }
    return {
      arm,
      role,
      db: dbPath,
      dbList: [dbPath],
      seeded,
      seedErr,
      faceInput: fi,
      faceRaw: fRaw?.face ?? null,
      faceNorm: fNorm?.face ?? null,
      namesHash: fNorm?.namesHash ?? null,
      toolCount: fRaw ? fRaw.count : null,
      sysLen: fRaw ? fRaw.sysLen : null,
      counts,
      storeIntegrity: null,
    }
  }

  if (mode === 'face-readonly') {
    // ★★ 只读：**绝不** reset / remember。只调 count。
    const ks = Array.isArray(data.arms?.[arm]?.checkpointsK) ? data.arms[arm].checkpointsK : []
    const integrity = dbPaths.map((p) => ({ db: p, before: dirHashes(p), after: null, unchanged: null }))
    counts = ks.map((k, i) => readCount(dbPaths[Math.min(i, dbPaths.length - 1)], Number(k)))
    for (const it of integrity) it.after = dirHashes(it.db)
    for (const it of integrity) it.unchanged = JSON.stringify(it.before) === JSON.stringify(it.after)
    return {
      arm,
      role,
      db: dbPath,
      dbList: dbPaths,
      seeded: false,
      seedErr: null,
      faceInput: fi,
      faceRaw: fRaw?.face ?? null,
      faceNorm: fNorm?.face ?? null,
      namesHash: fNorm?.namesHash ?? null,
      toolCount: fRaw ? fRaw.count : null,
      sysLen: fRaw ? fRaw.sysLen : null,
      counts,
      storeIntegrity: integrity,
    }
  }

  const ks = Array.isArray(data.arms?.[arm]?.checkpointsK) ? data.arms[arm].checkpointsK : []
  counts = ks.map((k) => readCount(dbPath, Number(k)))
  return {
    arm,
    role,
    db: dbPath,
    dbList: [dbPath],
    seeded,
    seedErr,
    faceInput: fi,
    faceRaw: fRaw?.face ?? null,
    faceNorm: fNorm?.face ?? null,
    namesHash: fNorm?.namesHash ?? null,
    toolCount: fRaw ? fRaw.count : null,
    sysLen: fRaw ? fRaw.sysLen : null,
    counts,
    storeIntegrity: null,
  }
}

// ───────────────────────── 渲染 ─────────────────────────

const pad = (s, n) => String(s ?? '').padEnd(n)
const relPath = (p) => path.relative(ROOT, p).replace(/\\/g, '/')

function planLines() {
  const L = []
  L.push(`${REPORT_NAME} —— 计划（--plan：**什么都不做**）`)
  L.push('')
  L.push(DISCLAIMER)
  L.push('')
  L.push('本次运行不做的事（已由代码保证）：')
  L.push('  · 不建库、不 reset/remember 任何记忆库')
  L.push('  · 不写报告、不建 out/ 下任何目录')
  L.push('  · 不调用 scripts/memory-stub.mjs')
  L.push('  · 不驱动、不启动任何 DSH 会话')
  L.push('')
  L.push('当真正跑一轮时，这台机器会做：')
  L.push('  [1] 两臂结构：臂 A = 控制（空库）/ 臂 B = 处理（累积），每臂一个独立 db 文件')
  L.push(`      默认 A = ${path.relative(ROOT, DEFAULT_ARM_DB.A).replace(/\\/g, '/')}`)
  L.push(`      默认 B = ${path.relative(ROOT, DEFAULT_ARM_DB.B).replace(/\\/g, '/')}`)
  L.push(`      （--selftest 时默认落到 ${path.relative(ROOT, SELFTEST_ARM_DB.A).replace(/\\/g, '/')} 之下，避免误写真实臂的库）`)
  L.push('  [2] 真调 stub 读 count（对照体检的证据，不靠「我们以为空」）')
  L.push('  [3] 算两臂 face 指纹（dsh-face/v1 本地移植；断言用端口归一化后的脸）')
  L.push('  [4] 对照体检三断言（任一 FAIL ⇒ BATCH-INVALID + 非零退出）：')
  L.push('        A1 两臂 face 指纹相同')
  L.push('        A2 控制臂（臂 A）记忆 count == 0')
  L.push('        A3 处理臂（臂 B）记忆 count 随 k 严格递增（末项 > 0）')
  L.push('  [5] 阳性对照（§2.4）：k=1 两臂应无差别；有差别 ⇒ CONTROL-FAILED + 非零退出')
  L.push('  [6] 逐题读数表，两种形态都要报：')
  L.push('        (甲) 序列/学习曲线型：k≥2 相对 k=1 的差（Δ = B − A），指标 ' + METRICS_SEQ.join('/'))
  L.push('        (乙) 单次型：' + METRICS_ONE.join('/') + '（预期「无差别」本身是有用信息）')
  L.push('  [7] 每格读数四态：OK / NEEDS-EVIDENCE / FAIL / N/A；★ 缺读数一律 NEEDS-EVIDENCE')
  L.push('  [8] 写 ' + path.relative(ROOT, DEFAULT_REPORT).replace(/\\/g, '/') + '，stdout 一行汇总')
  L.push('')
  L.push(`任务序列（同一族，逐题对比第 k 题）共 ${taskList().length} 题：`)
  for (const t of taskList()) L.push(`  k=${t.k}  ${pad(t.id, 42)} ${t.title}`)
  L.push('')
  L.push('当前骨架态：★ 还没有真实会话 ⇒ 真实读数一律 NEEDS-EVIDENCE。')
  L.push('用 --selftest 可以证明这台机器本身可用（注入假读数 + 真调 stub），但它**不产结论**。')
  // ★ 只在真带了 --face 时才多印这几行 ⇒ 不带 --face 的 --plan 输出与加 --face 之前逐字相同。
  if (FACE_GIVEN) {
    L.push('')
    L.push(`★ 本次带了 --face：${FACE_DESC}`)
    if (READONLY) {
      L.push('  ⇒ REAL 模式变【面驱动·只读】：**只调 count**（不 reset / 不 remember）⇒ A1/A2/A3 有真读数，')
      L.push('    且**目标 store 一字未动**（报告里给「读数前后逐文件 sha256 一致」的完整性证据）；')
      L.push('    ★ 逐 k 的 count 来自 --arm-a / --arm-b 给的多个 db 路径（各 k 的 store 快照）。')
    } else {
      L.push('  ⇒ REAL 模式变【面驱动】：真调该面做 reset/remember/count 排练 ⇒ 三条对照断言有真读数；')
    }
    L.push('    ★ 任务级读数（' + [...METRICS_SEQ, ...METRICS_ONE].join('/') + '）仍一律 NEEDS-EVIDENCE（要真实会话，本脚本不驱动）；')
    L.push('    ★ 面自身也会被实测一次（四条子命令各一发打在 probe 库上）⇒ A1 的输入不是注入常量。')
    L.push(`  ⇒ 面驱动默认落点（面 = 目录型 store，故意不带 .json）：`)
    L.push(`      A = ${relPath(FACE_ARM_DB.A)}`)
    L.push(`      B = ${relPath(FACE_ARM_DB.B)}`)
    L.push(`      probe = ${relPath(FACE_PROBE_DB)}`)
    L.push(`  ⇒ 不带 --face 时，本脚本行为与加它之前**逐字相同**（默认面 = node scripts/memory-stub.mjs）。`)
  }
  return L
}

function renderReport({ mode, data, arms, batch, control, cells, batteryResult, sentinel, breakName, probe }) {
  const L = []
  const now = new Date().toISOString()
  // ★ 不带 --face 时这两条标签与加 --face 之前逐字相同（向后兼容）。
  const modeLabel =
    mode === 'selftest'
      ? FACE_GIVEN
        ? `SELFTEST（注入假读数 + 真调面：${FACE_DESC}）`
        : 'SELFTEST（注入假读数 + 真调 memory-stub）'
      : mode === 'face'
        ? `REAL·面驱动（真调面：${FACE_DESC}；任务级读数仍无）`
        : mode === 'face-readonly'
          ? `REAL·面驱动·只读（只调 count，不 reset/remember；面：${FACE_DESC}；任务级读数仍无）`
          : 'REAL（骨架态，无真实会话）'
  const buildLabel =
    mode === 'selftest'
      ? `是（reset + remember，全部真调${FACE_GIVEN ? '面' : ' stub'}）`
      : mode === 'face'
        ? '是（reset + remember + 逐 k count，全部真调面）'
        : mode === 'face-readonly'
          ? '★ 否 —— 只读模式：**只调 count**，一次 reset / remember 都没发（见下表完整性证据）'
          : '否（只读；真实臂的记忆由真实运行写入）'
  L.push('='.repeat(100))
  L.push(`${REPORT_NAME} · 记忆效果判据机器骨架报告`)
  L.push(`生成时间 : ${now}`)
  L.push(`模式     : ${modeLabel}`)
  L.push(`数据来源 : ${data.source}`)
  if (breakName) L.push(`★ 破坏注入 : --break ${breakName}（${BREAKS[breakName]}）—— 本轮数据是**故意做坏的**`)
  L.push(DISCLAIMER)
  L.push('='.repeat(100))
  if (data.label) L.push(`[${data.label}]`)
  L.push('')
  L.push('四态语义（§5 纪律）：')
  L.push('  OK              = 该格有读数（或断言满足）')
  L.push('  NEEDS-EVIDENCE  = 缺读数/无法判定 —— ★ 绝不当成 OK，也绝不当成 FAIL')
  L.push('  FAIL            = 有读数且与期望不符（只会在 oracle/regression 与断言上出现）')
  L.push('  N/A             = 该格在本形态下无定义（例如 k=1 的 Δ）')
  L.push('')

  // [0] 机器自检
  if (batteryResult) {
    L.push('='.repeat(100))
    L.push('[0] 机器自检（judge 自身的门 §6）—— ★ 只关于「这台机器」，不关于记忆')
    L.push('='.repeat(100))
    for (const c of batteryResult.checks) L.push(`  [${c.id}] ${pad(c.state, 15)} ${c.name}\n        ${c.detail}`)
    L.push(`  [S8] ${pad(sentinel.state, 15)} face 移植的漂移哨兵\n        ${sentinel.detail}`)
    L.push(`  ⇒ 电池 ${batteryResult.checks.filter((c) => c.state === ST.OK).length}/${batteryResult.checks.length} OK` +
      (batteryResult.checks.some((c) => c.state === ST.FAIL) ? '  ★ 有 FAIL ⇒ 这台机器本身有问题，结论只是「机器不可用」' : ''))
    L.push('')
  } else {
    L.push('='.repeat(100))
    L.push('[0] 机器自检：REAL 模式不做（用 --selftest）')
    L.push('='.repeat(100))
    L.push('')
  }

  // [1] 两臂
  L.push('='.repeat(100))
  L.push('[1] 两臂结构（§3.2：同器具、同一张脸，只让【记忆库内容】不同）')
  L.push('='.repeat(100))
  for (const a of [arms.A, arms.B]) {
    const list = a.dbList ?? [a.db]
    L.push(`  ── 臂 ${a.arm}（${a.role}）`)
    // ★ 不带 --face 时这一行与加 --face 之前逐字相同（'db 文件'）；面驱动时才改称「目录」。
    if (list.length === 1) {
      const rel = path.relative(ROOT, list[0]).replace(/\\/g, '/')
      L.push(
        mode === 'face' || mode === 'face-readonly'
          ? `     db 目录   : ${rel}${fs.existsSync(list[0]) ? '' : '  （不存在）'}  ★ 面驱动：这是【数据目录】`
          : `     db 文件   : ${rel}${fs.existsSync(list[0]) ? '' : '  （不存在）'}`,
      )
    } else {
      L.push(`     db 目录   : ★ ${list.length} 个（逐检查点 k 各一个 = store 快照）`)
      for (let i = 0; i < list.length; i++) {
        L.push(`       k=${i + 1}  ${path.relative(ROOT, list[i]).replace(/\\/g, '/')}${fs.existsSync(list[i]) ? '' : '  （不存在）'}`)
      }
    }
    L.push(`     建库动作   : ${buildLabel}${a.seedErr ? `  ⚠ ${a.seedErr}` : ''}`)
    if (a.faceInput) {
      L.push(`     face raw  : ${a.faceRaw}   （逐字同构 face-audit，可与日志比对）`)
      L.push(`     face norm : ${a.faceNorm}   （★ 断言用；先做端口归一化）`)
      L.push(`     namesHash : ${a.namesHash}   工具数=${a.toolCount}   system 长度=${a.sysLen}`)
    } else {
      L.push('     face      : (缺 system+tools 快照) ⇒ NEEDS-EVIDENCE')
    }
    if (!a.counts.length) {
      L.push(`     ${CNT_LABEL}: (无检查点) ⇒ NEEDS-EVIDENCE`)
    } else {
      L.push(`     ${CNT_LABEL}: ` + a.counts.map((c) => `k=${c.k}:${c.count === null ? `读失败(${c.err})` : c.count}`).join('  '))
    }
    // ★★ 只读模式的完整性证据（第 ⑧ 格前置 A 的判据）：读数前后 store 逐文件 sha256 一致
    if (a.storeIntegrity) {
      for (const it of a.storeIntegrity) {
        const files = it.after.map((f) => `${f.rel}:${f.sha256.slice(0, 12)}(${f.bytes}B)`).join(' , ') || '(空目录)'
        L.push(
          `     完整性     : ${path.relative(ROOT, it.db).replace(/\\/g, '/')}  读前=读后(逐文件 sha256) ⇒ ${it.unchanged ? '★ 一致（本次读数没有改动 store）' : '**不一致 ⇒ 读数有副作用！**'}`,
        )
        L.push(`                  ${files}`)
      }
    }
  }
  if (probe) {
    L.push('')
    L.push(`  面实测（A1 的输入）: ${probe.state}  ${probe.detail}`)
    for (const s of probe.surface ?? []) L.push(`      · ${pad(s.name, 22)} 契约 ${pad(s.contract, 18)} 实测 ${s.measured}`)
    L.push('  ★ 这条量的是「面自身实测暴露了什么」，**不是**真实会话 request/header 的 system+tools 快照；')
    L.push('    后者要真实会话（本脚本不驱动会话）⇒ 未接入。两臂共用同一条 --face ⇒ A1 的「相同」是构造性成立的。')
  }
  L.push('')

  // [2] 对照体检
  L.push('='.repeat(100))
  L.push('[2] 对照体检（§3.3 三条断言，任一 FAIL ⇒ 该批数据作废）')
  L.push('='.repeat(100))
  for (const a of batch.assertions) L.push(`  [${a.id}] ${pad(a.state, 15)} ${a.name}\n        ${a.detail}`)
  L.push(`  ⇒ 批次裁决 = ${batch.verdict}`)
  L.push('')

  // [3] 阳性对照
  L.push('='.repeat(100))
  L.push('[3] 阳性对照（§2.4：k=1 应无差别 —— 它是两臂的共同起点）')
  L.push('='.repeat(100))
  L.push(`  [P1] ${pad(control.state, 15)} ${control.detail}`)
  L.push('')

  // [4] (甲)
  L.push('='.repeat(100))
  L.push('[4] 逐题读数表 · (甲) 序列/学习曲线型（k≥2 相对 k=1 的差）')
  L.push('═'.repeat(100))
  L.push('  Δ = B − A（负数=处理臂读数更小）。★ 只给读数，不给任何「有没有效果」的判语；n=5 不足以声称显著。')
  L.push('')
  L.push(`  ${pad('k', 4)}${pad('任务 id', 40)}${pad('指标', 11)}${pad('A', 9)}${pad('B', 9)}${pad('Δ', 9)}四态`)
  L.push('  ' + '-'.repeat(96))
  for (const row of cells.seq) {
    L.push(`  ${pad('k=' + row.k, 4)}${pad(row.id, 40)}${pad(row.metric, 11)}${pad(row.aText, 9)}${pad(row.bText, 9)}${pad(row.dText, 9)}${row.state}`)
  }
  L.push('')

  // [5] (乙)
  L.push('='.repeat(100))
  L.push('[5] 逐题读数表 · (乙) 单次型（预期「无差别」，而「无差别」本身是有用信息）')
  L.push('═'.repeat(100))
  L.push('  ★ 本骨架不把「不一致」判为 FAIL：那是读数，不是机器故障。')
  L.push('')
  L.push(`  ${pad('k', 4)}${pad('任务 id', 40)}${pad('指标', 11)}${pad('A', 9)}${pad('B', 9)}${pad('一致?', 9)}四态`)
  L.push('  ' + '-'.repeat(96))
  for (const row of cells.one) {
    L.push(`  ${pad('k=' + row.k, 4)}${pad(row.id, 40)}${pad(row.metric, 11)}${pad(row.aText, 9)}${pad(row.bText, 9)}${pad(row.dText, 9)}${row.state}`)
  }
  L.push('')

  // [6] 汇总
  const c = cells.counts
  L.push('='.repeat(100))
  L.push('[6] 汇总（★ 本节不使用任何结论式措辞：逐格只有上面那四态）')
  L.push('='.repeat(100))
  L.push(`  批次裁决   : ${batch.verdict}`)
  L.push(`  对照体检   : ${batch.assertions.map((a) => `${a.id}=${a.state}`).join('  ')}`)
  L.push(`  阳性对照   : P1=${control.state}`)
  L.push(`  格子计数   : OK=${c.OK}  NEEDS-EVIDENCE=${c[ST.NE]}  FAIL=${c[ST.FAIL]}  N/A=${c[ST.NA]}（合计 ${c.total}）`)
  L.push(`  ★ 缺读数的格子 ${c[ST.NE]} 个：一律 NEEDS-EVIDENCE，未当成 OK。`)
  L.push(`  两臂 face  : normalized ${arms.A.faceNorm ?? '(缺)'} / ${arms.B.faceNorm ?? '(缺)'}`)
  L.push(`  记忆条目数 : A=[${arms.A.counts.map((x) => (x.count === null ? '?' : x.count)).join(',')}]  B=[${arms.B.counts.map((x) => (x.count === null ? '?' : x.count)).join(',')}]`)
  L.push('')

  // [7] 需要什么才能填上
  L.push('='.repeat(100))
  L.push('[7] 「需要什么才能填上」—— 这就是本骨架的用途：把格子先立出来')
  L.push('='.repeat(100))
  const needs = c[ST.NE] > 0 || batch.verdict === 'NEEDS-EVIDENCE'
  if (needs) {
    L.push('  当前 NEEDS-EVIDENCE 的格子，各需要什么：')
    if (FACE_GIVEN) {
      L.push(`  · 两臂 face 指纹：★ 本轮已给出（面实测，见 [1] 面实测 与 [2] A1）；`)
      L.push('    仍缺的是**真实会话** request/header 里的 system + tools 快照 —— 那条路要真实会话，未接入')
      L.push(`  · 记忆条目数随 k：★ 本轮已真调面读到（见 [1] ${CNT_LABEL} 与 [2] 的 A2 / A3）`)
    } else {
      L.push('  · 两臂 face 指纹：需要两臂各一次真实会话的 request/header 里的 system + tools 快照')
      L.push('    （日志侧已有取法：scripts/face-audit.mjs 的读法；骨架期没有会话 ⇒ 算不出脸）')
      L.push('  · 记忆条目数随 k：需要对两臂真实跑完各自序列后的 db 调 memory-stub count（本机器已能读，只是没有 k 的读数）')
    }
    L.push(`  · (甲) 序列指标 ${METRICS_SEQ.join('/')}：需要两臂各跑【同一题目顺序】的真实会话，`)
    L.push('    并从会话日志按题取 toolCalls / tokens / wallClock / 返工次数（返工=同一题重复尝试次数）')
    L.push('  · (乙) oracle/regression：需要在每题上真跑 evals/pilot/tasks.jsonl 的 oracle.cmd / regression.cmd，')
    L.push('    取退出码与 expectSeeded/expectFixed 比（判据由编排层在 _wt 之外执行，见 §4 R1）')
    L.push('  · 驱动器尚未建：本骨架**不**驱动会话，也不产出上面这些读数')
    L.push('  · --readings <file> 就是将来驱动器的输出接口（schema 见脚本内 loadReadings）')
  } else {
    L.push('  本轮没有 NEEDS-EVIDENCE 的格子（这一轮的读数来自注入的假数据）。')
    L.push('  ★ 但「假数据下格子能填满」≠「真实读数可得」：真实读数仍需上面列的那些运行时产物。')
  }
  L.push('')
  L.push('─'.repeat(100))
  L.push('不确定 / 未验证（本报告的自我申报）：')
  L.push('  · face 指纹是**本地移植** dsh-face/v1（不是调用 face-audit.mjs，理由见脚本文件头）；')
  L.push('    漂移哨兵只查上游算法锚点字面量，**不证明逐字等价**。')
  if (FACE_GIVEN) {
    L.push(`  · ★ A1 的输入是「面命令逐字行 + 该面实测暴露的契约点」，**不是**真实会话的 system+tools 快照；`)
    L.push('    两臂共用同一条 --face ⇒ 「两臂脸相同」在当前参数形态下**构造性成立**、不是实测两臂各自的脸；')
    L.push('    在**没有真实会话**之前，它**不可能**因为「两臂脸不同」变红（要变红需 per-arm 的面或会话快照）。')
    L.push(`  · ★ A2 / A3 的 count 真读数来自面「${FACE_DESC}」，其值随该面背后的存储而定：`)
    L.push('    不同实现（stub 的 JSON 文件 / Go 侧知识库目录）**值可以不同**，这不是分歧，是各自的存储。')
    if (mode === 'face-readonly') {
      L.push('  · ★★ 只读模式：对**两臂的 db** 只调了 count —— **一次 reset / remember 都没发**（见 [1] 完整性证据）。')
      L.push('    probe（面实测）仍会跑，但它只打在 scratch 库上（out/memory-judge/face/probe），**不碰两臂的库**。')
      L.push('  · ★ 只读模式下逐 k 的 count 来自调用方给的**多个 db 路径**（各 k 的 store 快照）；')
      L.push('    若只给一个路径，则每个检查点读同一个库（A3 不会递增，如实报）—— 这**不是**判据的判语。')
    } else {
      L.push('  · ★ 臂 B 的「累积排练」文本取自本脚本的 taskList()（任务 id/标题），**不是**被测 agent 真写进去的记忆；')
      L.push('    它只用于说明「这条面的写入口会让条目数增长」这件事本身。')
      L.push(`  · 本轮真调了面的 count / remember / reset${probe ? ' / recall（面实测那一次）' : ''}。`)
    }
  } else {
    L.push('  · 本骨架不驱动真实会话、不调 memory-stub 的 recall（只用了 count/remember/reset）。')
    L.push('  · 上面这些读数在没有真实会话之前都只是**格子的形状**，不是证据。')
  }
  L.push(DISCLAIMER)
  L.push('─'.repeat(100))
  return L.join('\n') + '\n'
}

// ───────────────────────── 主流程 ─────────────────────────

const { opts, flags, rest } = parseArgs(process.argv.slice(2))
if (rest.length) usage(`不认识的参数：${rest.join(' ')}`)
if (flags.has('help') || flags.has('h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const PLAN = flags.has('plan')
const SELFTEST = flags.has('selftest')
if (PLAN && SELFTEST) usage('--plan 与 --selftest 互斥')
const BREAK = opts.break ?? null
if (BREAK && !SELFTEST) usage('--break 只能与 --selftest 一起用（它改的是注入的假数据，不许拿它改真实数据）')
if (BREAK && !Object.prototype.hasOwnProperty.call(BREAKS, BREAK)) {
  usage(`--break 只认识 ${Object.keys(BREAKS).join(' / ')}，收到 ${BREAK}`)
}

// ── ★ --face：换掉「面」。不带它时 FACE_ARGV 保持默认（node scripts/memory-stub.mjs）⇒ 行为不变。
const FACE = opts.face ?? null
if (FACE !== null) {
  if (!String(FACE).trim()) usage('--face 需要一个非空命令（默认 node scripts/memory-stub.mjs）')
  try {
    const argv = splitCmd(FACE)
    if (!argv.length) usage('--face 解析后没有可执行文件')
    FACE_ARGV = argv
  } catch (e) {
    usage(String(e?.message ?? e))
  }
  FACE_GIVEN = true
  FACE_DESC = FACE
}

// ── ★★ 第 ⑧ 格新增：`--face-readonly` —— 只调 count，**不 reset / 不 remember**。
//    它解决的真问题：判据机器原先读不到「外部真实 store」的 count —— 带 --face 会 reset（毁库）、
//    不带 --face 就用桩。加上本开关后，判据机器可以安全地读真 store，且**证明自己没改动它**。
const READONLY = flags.has('face-readonly')
if (READONLY && !FACE_GIVEN) usage('--face-readonly 必须与 --face 一起用（它改的是「怎么调这条面」）')

const MODE = PLAN ? 'plan' : SELFTEST ? 'selftest' : FACE_GIVEN ? (READONLY ? 'face-readonly' : 'face') : 'real'
/** count 读数的来源标签（只影响叙述；不带 --face 时逐字同以前）。 */
const CNT_LABEL = FACE_GIVEN ? (READONLY ? '面 count（只读）' : '面 count') : 'stub count'

// ── --plan：真正的空操作 ⇒ 直接返回
if (MODE === 'plan') {
  process.stdout.write(planLines().join('\n') + '\n')
  process.exit(0)
}

// ── ★ 面实测（只在面驱动 / 面驱动·只读时做）：量出「这条面暴露了什么」⇒ A1 的输入。
//    ⚠ 它真调面（打在 FACE_PROBE_DB 上），**不碰两臂的库** —— 只读模式下两臂的库一字未动。
const probe = (MODE === 'face' || MODE === 'face-readonly') ? probeFace() : null

// ── 数据
let data
if (opts.readings) data = loadReadings(opts.readings)
else if (SELFTEST) data = selftestData()
else if (MODE === 'face' || MODE === 'face-readonly') data = faceData(probe)
else data = realData()
if (MODE === 'face-readonly') {
  data.source =
    `面驱动·只读（${FACE_DESC}）：只调 count 读**已存在的真实 store**（不 reset / 不 remember）⇒ A2/A3 有真读数；` +
    `逐 k 的 count 来自 --arm-a/--arm-b 给的多个 db（各 k 的 store 快照）；任务级读数仍无（无真实会话）`
}
const dataNote = data.source
if (BREAK) data = applyBreak(data, BREAK)

const resolveDbs = (arm) => {
  const cliKey = arm === 'A' ? 'arm-a' : 'arm-b'
  if (opts[cliKey]) {
    // ★ 只读模式：允许逗号分隔的多个 db（各检查点 k 的 store 快照）。
    const raw = String(opts[cliKey])
    const parts = READONLY ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [raw]
    return parts.map((p) => path.resolve(ROOT, p))
  }
  const fromData = data.arms?.[arm]?.db
  if (fromData) return [path.resolve(ROOT, fromData)]
  if (SELFTEST) return [FACE_GIVEN ? SELFTEST_FACE_ARM_DB[arm] : SELFTEST_ARM_DB[arm]]
  if (MODE === 'face' || MODE === 'face-readonly') return [FACE_ARM_DB[arm]] // ★ 面驱动默认落点
  return [DEFAULT_ARM_DB[arm]]
}
const dbA = resolveDbs('A')
const dbB = resolveDbs('B')

// ── 采集
const arms = { A: collectArm(data, 'A', dbA, MODE), B: collectArm(data, 'B', dbB, MODE) }
const batch = assessBatch(
  {
    faceNormA: arms.A.faceNorm,
    faceNormB: arms.B.faceNorm,
    faceRawA: arms.A.faceRaw,
    faceRawB: arms.B.faceRaw,
    countsA: arms.A.counts,
    countsB: arms.B.counts,
  },
  CNT_LABEL,
  // ★ 面驱动下两臂的脸里不含端口（面命令逐字行 + 实测契约点）⇒ 不印那句端口注释。
  MODE === 'face' || MODE === 'face-readonly' ? '；本条比的是面命令逐字行 + 面实测暴露的契约点，与端口无关' : undefined,
)
const control = assessPositiveControl(data)

// ── 格子
const seq = []
const one = []
const counts = { OK: 0, [ST.NE]: 0, [ST.FAIL]: 0, [ST.NA]: 0, total: 0 }
const tally = (cells) => {
  for (const c of cells) {
    counts[c.state] = (counts[c.state] ?? 0) + 1
    counts.total++
  }
}
for (const t of data.tasks) {
  for (const m of METRICS_SEQ) {
    const a = reading(data, 'A', t.k, m)
    const b = reading(data, 'B', t.k, m)
    const ca = readCell(a)
    const cb = readCell(b)
    const cd = t.k === 1 ? { state: ST.NA, text: 'N/A' } : deltaCell(a, b)
    seq.push({ k: t.k, id: t.id, metric: m, aText: ca.text, bText: cb.text, dText: cd.text, state: [ca.state, cb.state, cd.state].includes(ST.FAIL) ? ST.FAIL : [ca.state, cb.state, cd.state].includes(ST.NE) ? ST.NE : [ca.state, cb.state, cd.state].includes(ST.NA) ? ST.NA : ST.OK })
    tally([ca, cb, cd])
  }
}
for (const t of data.tasks) {
  for (const m of METRICS_ONE) {
    const a = reading(data, 'A', t.k, m)
    const b = reading(data, 'B', t.k, m)
    const ca = expectCell(a, 'pass')
    const cb = expectCell(b, 'pass')
    const cd = sameTextCell(a, b)
    one.push({ k: t.k, id: t.id, metric: m, aText: ca.text, bText: cb.text, dText: cd.text, state: [ca.state, cb.state].includes(ST.FAIL) ? ST.FAIL : [ca.state, cb.state].includes(ST.NE) ? ST.NE : ST.OK })
    tally([ca, cb, cd])
  }
}

// ── 自检电池（只在 selftest 跑；用**纯净**的内置数据，与 --break 无关）
const batteryResult = SELFTEST ? battery() : null
const sentinel = facePortSentinel()

// ── 组装 + 禁令自检
data.source = dataNote
const report = renderReport({ mode: MODE, data, arms, batch, control, cells: { seq, one, counts }, batteryResult, sentinel, breakName: BREAK, probe })

const leaked = FORBIDDEN_IN_REPORT.filter((re) => re.test(report)).map(String)
if (leaked.length) {
  process.stderr.write(`[${REPORT_NAME}] ★ 自检机器自身坏了：报告里出现了被禁的断言式说法 ${leaked.join(' ')} ⇒ 拒绝产出\n`)
  process.exit(4)
}
// ★ 汇总段落里不许出现「通过」二字（「缺读数冒充通过」是 §6 门 4 要堵的洞）。
//   范围 = [6] 汇总 段落本体（到 [7] 为止），不含标题行以外的其它章节。
const summaryBlock = (report.split('[6] 汇总')[1] ?? '').split('[7] 「需要什么')[0] ?? ''
if (summaryBlock === '') {
  process.stderr.write(`[${REPORT_NAME}] ★ 自检机器自身坏了：报告里找不到 [6] 汇总 段落 ⇒ 拒绝产出\n`)
  process.exit(4)
}
if (/通过/.test(summaryBlock)) {
  process.stderr.write(`[${REPORT_NAME}] ★ 自检机器自身坏了：汇总区出现了「通过」二字 ⇒ 拒绝产出\n`)
  process.exit(4)
}

const outPath = opts.out ? path.resolve(ROOT, opts.out) : DEFAULT_REPORT
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, report, 'utf8')

// ── 退出码
let code = 0
if (batch.verdict === 'BATCH-INVALID') code = 1
else if (control.state === 'CONTROL-FAILED') code = 3
if (SELFTEST && batteryResult && !batteryResult.ok && code === 0) code = 4

const relOut = path.relative(ROOT, outPath).replace(/\\/g, '/')
process.stdout.write(
  `${REPORT_NAME} mode=${MODE} batch=${batch.verdict} control=${control.state} ` +
    `cells=OK:${counts.OK}/NEEDS-EVIDENCE:${counts[ST.NE]}/FAIL:${counts[ST.FAIL]}/N-A:${counts[ST.NA]} ` +
    `assertions=${batch.assertions.map((a) => `${a.id}:${a.state}`).join(',')} ` +
    `faceA=${arms.A.faceNorm ?? '-'} faceB=${arms.B.faceNorm ?? '-'} ` +
    `countA=[${arms.A.counts.map((x) => (x.count === null ? '?' : x.count)).join(',')}] countB=[${arms.B.counts.map((x) => (x.count === null ? '?' : x.count)).join(',')}] ` +
    `battery=${batteryResult ? `${batteryResult.checks.filter((c) => c.state === ST.OK).length}/${batteryResult.checks.length}` : 'n/a'} ` +
    (FACE_GIVEN ? `faceCmd="${FACE_DESC}" faceProbe=${probe ? probe.state : 'skipped'} ` : '') +
    `exit=${code} report=${relOut}\n`,
)
process.exit(code)
