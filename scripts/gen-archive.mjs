#!/usr/bin/env node
/**
 * gen-archive.mjs —— ★★★ 把**一代**的实验结果【存档】成一个目录（跨代对比的地基）。
 *
 * ## 用户的洞见（这一批的核心）
 *   "我们做这个只是为了对比【进化前后两代】的数据；每一代测完了都可以【存档】——
 *    把每一题的数据都存起来，并且标注【这一代做了什么进化】。"
 *   ⇒ 所以"两臂"不是两个固定槽位，而是**两个代 / 两个比赛区**；**代与代之间**才是要比的东西。
 *   本脚本负责"把一代钉在盘上"：**逐题数据 + 元信息（含人写的一句话：这代做了什么进化）**。
 *
 * ## 落点（默认）
 *   `out/generations/<gen-id>/readings.json`   逐题数据（逐臂 × 逐题）
 *   `out/generations/<gen-id>/meta.json`       元信息：gen-id / 时间 / **做了什么进化** /
 *                                              preset 或工具面指纹 / **臂配置快照**
 *
 * ## 读数 schema（`--readings <file>`，UTF-8，允许带 BOM）
 *   ```json
 *   { "gen": "<gen-id>",                     // 可选（不给就用 --gen）
 *     "tasks": ["t1","t2"],                  // 可选（不给就从各臂的题号里取并集、排序）
 *     "arms": {
 *       "<臂名>": {
 *         "<题号>": { "ok": true, "toolCalls": 3, "tokens": 1200, "wallMs": 4500, "dangerous": 0 }
 *       }
 *     } }
 *   ```
 *   · 五个指标各自**可缺**（缺 = `null` = 没读到，**不是 0**）；`ok` 可以是 `true|false|null`。
 *   · 一台机器**只认这五个**；多出来的键照抄进存档（不丢信息），但不参与对比。
 *
 * ## 纪律
 *   · ★ **不许静默覆盖**：目标代目录已存在 ⇒ 拒写（要覆盖必须显式 `--force`，且 `meta.json` 里记 `overwritten:true`）；
 *   · ★ **"做了什么进化"必须是真句子**：空 / 占位符 / 与 gen-id 相同 / 太短 ⇒ 拒写（*不许* 变成机器生成的空话）；
 *   · ★ **臂配置快照原样存**（注册表给什么存什么）—— 没有注册表就是 `null`（= 未声明，**不是**"没有臂"）。
 *
 * ## 用法
 *   node scripts/gen-archive.mjs --gen g1 --readings out/_w59/sample-gen1.json \
 *        --evolution "把记忆注入从 AGENTS.md 改成 pre-step 注入" [--arms evals/arms.json] [--tools <工具体声明 json>] [--note "..."] [--force]
 *   退出码：0 存档成功 / 2 用法或数据非法 / 3 目标已存在（未给 --force）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ArmsRegistryError, loadArmsRegistry } from './arms-registry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'gen-archive'
const METRICS = ['ok', 'toolCalls', 'tokens', 'wallMs', 'dangerous']

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const has = (k) => argv.includes(k)

const die = (msg, code = 2) => {
  process.stderr.write(`[${NAME}] ${msg}\n`)
  process.exit(code)
}

const GEN = argOf('--gen')
const READINGS = argOf('--readings')
const EVOLUTION = argOf('--evolution')
const ARMS_FILE = argOf('--arms')
const TOOLS_FILE = argOf('--tools')
const NOTE = argOf('--note')
const OUT_ROOT = path.resolve(ROOT, argOf('--out-root') ?? path.join('out', 'generations'))
const FORCE = has('--force')

if (!GEN) die('必须给 --gen <gen-id>')
if (!READINGS) die('必须给 --readings <逐题读数 JSON>')
if (!EVOLUTION) {
  die(
    '★★ 必须给 --evolution "<这一代做了什么进化>" —— 这是【人写的一句话】，不是可选项：\n' +
      '   没有它，两代存档就无法回答"这两代到底差在哪"。例：--evolution "把记忆注入从 AGENTS.md 改成 pre-step 注入"',
  )
}
/** gen-id 必须能当目录名（否则会把存档写进别处）。 */
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(GEN)) {
  die(`--gen 只能是 [A-Za-z0-9._-] 且以字母数字开头（否则会写到目录之外）：${GEN}`)
}
/** ★ "人写的一句话"的机器下限（不是审美判断，是**拦住占位符**）： */
const evo = String(EVOLUTION).trim()
const PLACEHOLDER = /^(n\/?a|tbd|todo|none|null|-+|不明|待填|待补|略|无|fix|wip)$/i
if (evo.length < 6) die(`--evolution 太短（${evo.length} 字）⇒ 那不是"一句话"，是占位符；请写清楚这一代做了什么进化`)
if (PLACEHOLDER.test(evo)) die(`--evolution 是占位符（"${evo}"）⇒ 拒写：存档里的"做了什么进化"必须是真句子`)
if (evo === GEN) die('--evolution 与 --gen 逐字相同 ⇒ 那不是"做了什么进化"，请写清楚这一代改了什么')
if (!/[\u4e00-\u9fff]/.test(evo) && evo.split(/\s+/).length < 3) {
  die(`--evolution 看不出是人写的一句话（"${evo}"）：至少给一句完整描述（中文或有 ≥3 个词的英文句子）`)
}

/* ── 读逐题读数 ─────────────────────────────────────────────── */
const readJson = (p, label) => {
  let text
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch (e) {
    die(`读不到${label} ${p}：${e?.message ?? e}`)
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(body)
  } catch (e) {
    die(`${label} ${p} 不是合法 JSON：${e?.message ?? e}`)
  }
}

const readingsPath = path.resolve(ROOT, String(READINGS))
const raw = readJson(readingsPath, '逐题读数')
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) die('逐题读数顶层必须是对象')
if (!raw.arms || typeof raw.arms !== 'object' || Array.isArray(raw.arms)) die('逐题读数缺 arms 对象（`arms: { "<臂名>": { "<题号>": {...} } }`）')
const armNames = Object.keys(raw.arms)
if (!armNames.length) die('逐题读数的 arms 是空的 ⇒ 没有可存档的读数')
if (raw.gen && String(raw.gen) !== GEN) die(`逐题读数里写的 gen="${raw.gen}" 与 --gen "${GEN}" 不一致（别让存档名与数据对不上）`)

/** 规范化：只认那五个指标；其余键原样留档（`extra`）。 */
const tasks = new Set(Array.isArray(raw.tasks) ? raw.tasks.map(String) : [])
const armsNorm = {}
const problems = []
for (const arm of armNames) {
  const byTask = raw.arms[arm]
  if (!byTask || typeof byTask !== 'object' || Array.isArray(byTask)) { problems.push(`臂 ${arm} 的不是"题号→读数"的对象`); continue }
  armsNorm[arm] = {}
  for (const task of Object.keys(byTask)) {
    tasks.add(task)
    const v = byTask[task] ?? {}
    if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(`臂 ${arm} 题 ${task} 的读数不是对象`); continue }
    const row = { ok: null, toolCalls: null, tokens: null, wallMs: null, dangerous: null }
    if (v.ok === true || v.ok === false || v.ok === null) row.ok = v.ok
    else if (v.ok !== undefined) problems.push(`臂 ${arm} 题 ${task} 的 ok 只能是 true/false/null；收到 ${JSON.stringify(v.ok)}`)
    for (const m of ['toolCalls', 'tokens', 'wallMs', 'dangerous']) {
      if (v[m] === undefined || v[m] === null) continue
      if (typeof v[m] !== 'number' || !Number.isFinite(v[m])) { problems.push(`臂 ${arm} 题 ${task} 的 ${m} 不是有限数；收到 ${JSON.stringify(v[m])}`); continue }
      row[m] = v[m]
    }
    const extra = Object.fromEntries(Object.entries(v).filter(([k]) => !METRICS.includes(k)))
    if (Object.keys(extra).length) row.extra = extra
    armsNorm[arm][task] = row
  }
}
if (problems.length) die(`逐题读数有 ${problems.length} 处不合法：\n  · ${problems.join('\n  · ')}`)
const taskList = [...tasks].sort()

/* ── 臂配置快照 + preset / 工具面指纹 ────────────────────────── */
let armsSnapshot = null
let armsRegistryFile = null
let controlled = null
const presetByArm = {}
if (ARMS_FILE) {
  let reg
  try {
    reg = loadArmsRegistry(String(ARMS_FILE), { base: ROOT })
  } catch (e) {
    if (e instanceof ArmsRegistryError) die(e.message)
    throw e
  }
  armsSnapshot = reg.arms
  controlled = reg.controlled
  armsRegistryFile = path.relative(ROOT, reg.file).replace(/\\/g, '/')
  for (const a of reg.arms) presetByArm[a.name] = a.preset
}
for (const arm of armNames) if (!(arm in presetByArm)) presetByArm[arm] = null

let toolsFace = null
let toolsFaceSource = null
if (TOOLS_FILE) {
  const tp = path.resolve(ROOT, String(TOOLS_FILE))
  const rawTools = readJson(tp, '工具体声明')
  toolsFace = crypto.createHash('sha256').update(stableJson(rawTools), 'utf8').digest('hex').slice(0, 8)
  toolsFaceSource = path.relative(ROOT, tp).replace(/\\/g, '/')
}
/** 规范化 JSON（键排序）—— 指纹必须与键序无关。 */
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}'
}
const fingerprint = {
  preset: presetByArm,
  toolFace: toolsFace,
  toolFaceSource: toolsFaceSource,
  controlled,
  sha8: crypto.createHash('sha256').update(stableJson({ preset: presetByArm, toolFace: toolsFace, controlled }), 'utf8').digest('hex').slice(0, 8),
}

/* ── 落盘 ───────────────────────────────────────────────────── */
const genDir = path.join(OUT_ROOT, GEN)
if (fs.existsSync(genDir) && !FORCE) {
  die(`存档目录已存在：${genDir}\n   ⇒ 拒写（**不许静默覆盖**）。要覆盖请显式加 --force（meta.json 里会记 overwritten:true）`, 3)
}
const overwritten = fs.existsSync(genDir)
fs.mkdirSync(genDir, { recursive: true })

const readingsOut = {
  gen: GEN,
  arms: armsNorm,
  tasks: taskList,
}
const readingsText = JSON.stringify(readingsOut, null, 2) + '\n'
fs.writeFileSync(path.join(genDir, 'readings.json'), readingsText, 'utf8')

const meta = {
  genId: GEN,
  at: new Date().toISOString(),
  /** ★★ 用户点名要的：**人写的一句话**（本脚本只做"是不是占位符"的下限校验，不做生成）。 */
  evolution: evo,
  sourceReadings: path.relative(ROOT, readingsPath).replace(/\\/g, '/'),
  readingsSha256: crypto.createHash('sha256').update(readingsText, 'utf8').digest('hex'),
  arms: armNames,
  tasks: taskList,
  perArmTaskCount: Object.fromEntries(armNames.map((a) => [a, Object.keys(armsNorm[a]).length])),
  /** ★ 臂配置快照（注册表原样；没给注册表就是 null = 未声明）。 */
  armsSnapshot,
  armsRegistryFile,
  controlled,
  fingerprint,
  note: NOTE ? String(NOTE) : null,
  overwritten,
}
fs.writeFileSync(path.join(genDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')

console.log(`[${NAME}] 存档完成：${path.relative(ROOT, genDir).replace(/\\/g, '/')}/`)
console.log(`  gen       : ${GEN}`)
console.log(`  进化标注  : ${evo}`)
console.log(`  臂        : ${armNames.join(' , ')}（各臂题数：${armNames.map((a) => `${a}=${meta.perArmTaskCount[a]}`).join(' ')}）`)
console.log(`  题        : ${taskList.length} 题${taskList.length ? ` —— ${taskList.join(' , ')}` : ''}`)
console.log(`  臂配置快照: ${armsSnapshot ? `${armsRegistryFile}（${armsSnapshot.length} 臂）` : 'null（未给 --arms ⇒ 未声明）'}`)
console.log(`  preset指纹: ${JSON.stringify(presetByArm)}`)
console.log(`  工具面指纹: ${toolsFace ?? 'null（未给 --tools ⇒ 未声明）'}${toolsFaceSource ? `  ← ${toolsFaceSource}` : ''}`)
console.log(`  指纹      : sha8=${fingerprint.sha8}`)
console.log(`  readings  : ${path.relative(ROOT, path.join(genDir, 'readings.json')).replace(/\\/g, '/')}  sha256=${meta.readingsSha256.slice(0, 16)}…`)
console.log(`  meta      : ${path.relative(ROOT, path.join(genDir, 'meta.json')).replace(/\\/g, '/')}${overwritten ? '   ★ 覆盖了旧代（overwritten=true）' : ''}`)
