#!/usr/bin/env node
/**
 * face-audit.mjs —— O27：**face 指纹** 的定义 + 只读「陈旧宣称」审计（可复跑）
 *
 * ## 它回答什么
 *
 * spec §17.3：给工具面一个短指纹并写进 runtime-context 快照文本
 *   ⇒ 换来一条**可机验的判据**：把「日志里模型当时看到的 face 指纹」
 *     与「当时真实注册表的 face 指纹」比对 ⇒ 自动检出**陈旧宣称**。
 * 上游的判据是**纯文本等值比较**（`dsh-agent-loop/lib/index.js:70` `this.retained?.text === snapshot`
 *   ⇒ 变了才注入，O28 的判重就在这一行），所以**指纹里绝不能掺时间戳/会话 id/序号**：
 * 掺了就让"每步都变"，快照每步重发，前缀安全性与去重同时失效。
 *
 * ## 指纹算法（dsh-face/v1，确定性）
 *
 *   face = sha256(  "dsh-face/v1\n"
 *                 + "|S|" + <system 文本的 UTF-16 长度> + "\n" + <system 原文> + "\n"
 *                 + "|T|" + <去重后的工具名个数> + "\n"
 *                 + 对【名字按字典序排序】后的每个工具：<名> + "\n" + canonicalJSON(整个工具对象) + "\n"
 *              ).slice(0, 8)          // 8 个 hex 字符
 *
 *   namesHash = sha256(名字按字典序用 \n 连接).slice(0, 8)   // 只含名字，用来给变化点分类
 *
 *   · canonicalJSON = 递归、对象键按码位升序、无空白 —— 消除"键序不同"这种**假**差异。
 *   · 输入含 **system 全文 + 工具 schema 全文**（不只是名字）：
 *     见报告 §"指纹算法与假阴/假阳"——本机实测"脸逐字相同才命中缓存"（spec §12.4/12.5），
 *     只哈希名字会漏掉"描述/参数改了 ⇒ 前缀砸了但名字没变"的**假阴性**。
 *   · 不含任何时间戳 / 会话 id / 请求序号 / 事件 seq —— 见文件头第一段。
 *
 * ## 它做什么（只读，不改任何东西）
 *
 *   [1] 会话总览                [2] 每会话的 face 指纹**时间序列**
 *   [3] 会话内变化点（相邻请求指纹不同 ⇒ 变了什么）
 *   [3b] 跨会话变化点（子代首请求 face vs 父代最后请求 face）
 *   [4] 陈旧宣称审计（runtime-context 宣称的 face vs 当时真实 face）
 *   [5] 汇总（写 out/face-audit.txt + stdout 一行）
 *
 * 用法：
 *   node scripts/face-audit.mjs                 # 全量扫
 *   node scripts/face-audit.mjs --only 436fde97 # 只看含该子串的会话
 *   node scripts/face-audit.mjs --series 200    # 每会话序列最多打多少行（默认 30，超出打头尾）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT_TXT = 'D:/project_develop/dsh-brain/out/face-audit.txt'
const SOURCE_PLUGIN = '@deepseek-ai/dsh-system-prompt'
const FACE_VERSION = 'dsh-face/v1'

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : argv[i + 1]
}
const ONLY = argOf('--only')
const SERIES_MAX = Number(argOf('--series') ?? 30) || 30

// ───────────────────────── 指纹 ─────────────────────────

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

/** 算一次请求的 face 指纹。输入必须是**该次请求实际发出的** system 文本与 tools 数组。 */
function faceOf(system, tools) {
  const sys = typeof system === 'string' ? system : String(system ?? '')
  const list = Array.isArray(tools) ? tools : []
  const byName = new Map()
  for (const t of list) {
    const n = toolNameOf(t)
    if (!byName.has(n)) byName.set(n, t) // 同名取首个（已知假阴性，见报告）
  }
  const names = [...byName.keys()].sort() // ★ 字典序
  const parts = [FACE_VERSION, '|S|' + sys.length, sys, '|T|' + names.length]
  for (const n of names) parts.push(n, canonical(byName.get(n)))
  return {
    face: sha8(parts.join('\n')),
    namesHash: sha8(names.join('\n')),
    names,
    count: list.length,
    sysLen: sys.length,
    system: sys,
  }
}

/** 会话目录名 ⇒ 短标签。⚠ 不能直接 slice(0,8)：顶层会话目录名带 `session-` 前缀，
 *  直接切会把所有顶层会话都显示成 `session-`（可分不开谁是谁 —— 踩过一次）。 */
const shortId = (dir) => String(dir ?? '').replace(/^session-/, '').slice(0, 8)

/** 两段文本的公共前缀长度（用于定位"断在第几字符"）。 */
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/** 把"Web GUI 端口"这种**与能力无关**的易变量归一化，用来判"差异是否只在端口"。
 *  本机实测：system 里含 `http://127.0.0.1:<port>`，每次换代端口不同 ⇒ 脸变了但能力集没变。 */
const PORT_RE = /127\.0\.0\.1:\d+/g
const normalizePorts = (t) => t.replace(PORT_RE, '127.0.0.1:PORT')

// ───────────────────────── 读日志 ─────────────────────────

function listSessionFiles() {
  const files = []
  for (const p of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!p.isDirectory()) continue
    const pp = path.join(ROOT, p.name)
    for (const s of fs.readdirSync(pp, { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const f = path.join(pp, s.name, 'session.jsonl.zstd')
      if (fs.existsSync(f)) files.push({ proj: p.name, dir: s.name, file: f })
    }
  }
  return files
}

function readEvents(file) {
  const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  const events = []
  let badLines = 0
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    let o
    try {
      o = JSON.parse(l)
    } catch {
      badLines++
      continue
    }
    if (!o || typeof o !== 'object') continue
    events.push(o)
  }
  return { events, badLines }
}

/** 会话头事件里的字段可能在 event 顶层，也可能在 event.data —— 两边都找。 */
function pick(ev, key) {
  for (const c of [ev, ev?.data, ev?.data?.session]) {
    if (c && typeof c === 'object' && c[key] !== undefined && c[key] !== null) return c[key]
  }
  return null
}

function textOfContent(c) {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' ? (p.text ?? '') : String(p))).join('\n')
  if (typeof c === 'object' && typeof c.text === 'string') return c.text
  return ''
}

// ───────────────────────── 扫描 ─────────────────────────

const out = []
const say = (s = '') => out.push(s)

const files = listSessionFiles().filter((s) => !ONLY || s.dir.includes(ONLY) || s.proj.includes(ONLY))

const sessions = [] // { proj, dir, events, meta, headers[], claims[] }
let failed = 0

for (const f of files) {
  let events
  let badLines = 0
  try {
    ;({ events, badLines } = readEvents(f.file))
  } catch (e) {
    failed++
    sessions.push({ ...f, events: [], meta: {}, headers: [], claims: [], readError: String(e?.message ?? e) })
    continue
  }
  const head = events.find((e) => e.type === 'session') ?? events[0] ?? {}
  const desc = events.find((e) => e.type === 'subagent/descriptor')?.data ?? {}
  const meta = {
    id: String(pick(head, 'id') ?? f.dir),
    parent: pick(head, 'parentSession'),
    depth: pick(head, 'delegationDepth'),
    seedLength: pick(head, 'seedLength'),
    preset: pick(head, 'agentPreset'),
    createdAt: pick(head, 'createdAt'),
    provider: desc.provider ?? null,
    mode: desc.mode ?? null,
    badLines,
  }

  // ① 每次 request/header ⇒ 一个 face
  const headers = []
  for (const e of events) {
    if (e.type !== 'request/header') continue
    const h = e.data?.header ?? {}
    const fp = faceOf(h.system, h.tools)
    headers.push({ seq: e.seq, time: e.time, reason: e.data?.reason ?? null, config: h.config ?? null, ...fp })
  }

  // ② runtime-context 宣称（我们自己注入的那条 owned 快照）
  const claims = []
  for (const e of events) {
    if (e.type !== 'user/message') continue
    const d = e.data ?? {}
    const src = d.source ?? d.message?.source ?? null
    if (!src || src.kind !== 'plugin' || src.plugin !== SOURCE_PLUGIN) continue
    const text = textOfContent(d.content ?? d.message?.content ?? d.message)
    if (!/runtime context/i.test(text)) continue
    const m = /face\s*=\s*([0-9a-fA-F]{6,64})/.exec(text)
    claims.push({ seq: e.seq, time: e.time, claimed: m ? m[1].toLowerCase() : null, text })
  }

  sessions.push({ ...f, events, meta, headers, claims })
}

// ───────────────────────── 输出 ─────────────────────────

say('face-audit —— 只读审计：日志里模型当时看到的 face vs 当时真实的注册表 face')
say(`算法   : ${FACE_VERSION} = sha256(版本头 + "|S|"+len(system) + system 原文 + "|T|"+工具数 + 字典序工具名+canonicalJSON(工具对象)).slice(0,8)`)
say('         ★ 输入 = system 全文 + 工具 schema 全文（名字按字典序排序）')
say('         ★ 不掺时间戳 / 会话 id / 请求序号 / 事件 seq（上游判重是纯文本等值比较，掺易变量会每步失效）')
say(`根目录 : ${ROOT}`)
say(`会话数 : 目录里 ${listSessionFiles().length} 个${ONLY ? `，本次过滤 "--only ${ONLY}" ⇒ ${sessions.length} 个` : ''}`)
say('')

const readable = sessions.filter((s) => !s.readError)
const withHeader = readable.filter((s) => s.headers.length > 0)

// [1] 会话总览
say('==================== [1] 会话总览（有 request/header 的会话）====================')
say('   会话 id（前 8）  请求  人脸  工具数(首→末)      system长度(首→末)    provider/mode      preset')
say('   ─────────────────────────────────────────────────────────────────────────────────────────────')
const sortedByHeader = [...withHeader].sort((a, b) => b.headers.length - a.headers.length)
for (const s of sortedByHeader) {
  const hs = s.headers
  const faces = new Set(hs.map((h) => h.face))
  const c0 = hs[0].count
  const c1 = hs[hs.length - 1].count
  const l0 = hs[0].sysLen
  const l1 = hs[hs.length - 1].sysLen
  say(
    `   ${shortId(s.dir).padEnd(10)} ${String(hs.length).padStart(5)} ${String(faces.size).padStart(5)}` +
      `   ${String(c0).padStart(4)}→${String(c1).padEnd(4)}        ${String(l0).padStart(6)}→${String(l1).padEnd(6)}` +
      `   ${String((s.meta.provider ?? '-') + '/' + (s.meta.mode ?? '-')).padEnd(18)} ${s.meta.preset ?? '-'}`,
  )
}
say(`   ⇒ 共 ${sortedByHeader.length} 个会话有请求头；无请求头（未真正发过）的 ${readable.length - withHeader.length} 个`)
if (failed) say(`   ⚠ 解码失败的会话 ${failed} 个`)
say('')

// [2] 指纹时间序列
say('==================== [2] 每会话的 face 指纹【时间序列】====================')
say('   （位置 = 该 request/header 在日志里的 seq；人脸数 >1 的会话是变化点候选）')
let shownSeries = 0
for (const s of sortedByHeader) {
  if (!s.headers.length) continue
  shownSeries++
  const faces = new Set(s.headers.map((h) => h.face))
  say('')
  say(`---- ${s.dir}  (proj=${s.proj}) ----`)
  say(
    `     请求=${s.headers.length}  人脸数=${faces.size}  depth=${s.meta.depth ?? '-'}  seedLength=${s.meta.seedLength ?? '(缺键)'}` +
      `  provider=${s.meta.provider ?? '-'}  mode=${s.meta.mode ?? '-'}  preset=${s.meta.preset ?? '-'}`,
  )
  say('     idx   seq      face      工具数  system长度  namesHash   prev-face 是否变化')
  const rows = s.headers
  const head = rows.slice(0, SERIES_MAX)
  const tail = rows.length > SERIES_MAX * 2 ? rows.slice(-SERIES_MAX) : rows.length > SERIES_MAX ? rows.slice(SERIES_MAX) : []
  const emit = (h, i) => {
    const prev = i > 0 ? rows[i - 1].face : null
    say(
      `     ${String(i).padStart(3)}  ${String(h.seq).padStart(5)}   ${h.face}` +
        `    ${String(h.count).padStart(5)}  ${String(h.sysLen).padStart(9)}   ${h.namesHash}` +
        `   ${prev == null ? '(首)' : prev + (prev === h.face ? ' 同' : ' ✗变')}`,
    )
  }
  head.forEach((h, i) => emit(h, i))
  if (tail.length) {
    say(`     ...省略 ${rows.length - head.length - tail.length} 行（--series 调整）...`)
    tail.forEach((h, k) => emit(h, head.length + k))
  }
}
say('')
say(`   ⇒ 共打印 ${shownSeries} 个会话的指纹序列`)
say('')

// [3] 会话内变化点
say('==================== [3] 变化点（相邻两次请求指纹不同 ⇒ 到底变了什么）====================')
let totalChanges = 0
let onlyPortChanges = 0
for (const s of sortedByHeader) {
  const rows = s.headers
  const changes = []
  for (let i = 1; i < rows.length; i++) if (rows[i].face !== rows[i - 1].face) changes.push([i - 1, i])
  if (!changes.length) continue
  say('')
  say(`---- ${s.dir}  (proj=${s.proj})  变化点 ${changes.length} 个 ----`)
  for (const [a, b] of changes) {
    totalChanges++
    const A = rows[a]
    const B = rows[b]
    const setA = new Set(A.names)
    const setB = new Set(B.names)
    const added = B.names.filter((n) => !setA.has(n))
    const removed = A.names.filter((n) => !setB.has(n))
    const cpl = commonPrefixLen(A.system, B.system)
    say(`   ● 位置 seq=${A.seq} → seq=${B.seq} : face ${A.face} → ${B.face}`)
    say(`       工具数 ${A.count} → ${B.count}   名字集合变: ${setA.size !== setB.size || added.length || removed.length ? '是' : '否'}`)
    say(`       新增工具(${added.length}): ${added.length ? added.join(', ') : '(无)'}`)
    say(`       删除工具(${removed.length}): ${removed.length ? removed.join(', ') : '(无)'}`)
    say(`       namesHash ${A.namesHash} → ${B.namesHash} (${A.namesHash === B.namesHash ? '同名集' : '名字集也变了'})`)
    say(`       system 长度 ${A.sysLen} → ${B.sysLen}；公共前缀断在第 ${cpl} 字符`)
    if (cpl < Math.min(A.sysLen, B.sysLen)) {
      const ctxA = JSON.stringify(A.system.slice(Math.max(0, cpl - 30), cpl + 40))
      const ctxB = JSON.stringify(B.system.slice(Math.max(0, cpl - 30), cpl + 40))
      say(`         断点上下文 A: ${ctxA}`)
      say(`         断点上下文 B: ${ctxB}`)
    }
    const namesSame = A.namesHash === B.namesHash
    const sysSame = A.system === B.system
    const onlyPort = !sysSame && normalizePorts(A.system) === normalizePorts(B.system)
    if (onlyPort) onlyPortChanges++
    say(`       system 逐字相同: ${sysSame ? '是' : '否'}；差异是否**只在** Web GUI 端口: ${onlyPort ? '★是（能力无关的易变量）' : '否'}`)
    say(
      `       ⇒ 分类: ${!namesSame ? '★能力集变化（工具名增删）' : sysSame ? '★能力集没变、system 没变，只有 tools 条目内容变了（描述/schema）' : '脸变化但名字集不变（system 变了）'}`,
    )
  }
}
if (!totalChanges) say('   （本机样本内未检出会话内变化点）')
say('')
say(`   ⇒ 会话内变化点合计 = ${totalChanges}，其中**差异只在 Web GUI 端口**的 ${onlyPortChanges} 个（⇒ 能力没变、脸被易变量污染）`)
say('')

// [3b] 跨会话变化点：子代首请求 vs 父代最后请求
say('==================== [3b] 跨会话变化点（子代首请求 face vs 父代最后请求 face）====================')
const norm = (v) => String(v ?? '').replace(/^session-/, '')
const byKey = new Map()
for (const s of readable) {
  byKey.set(norm(s.meta.id), s)
  byKey.set(norm(s.dir), s)
}
function findParent(raw) {
  if (!raw) return null
  const k = norm(raw)
  if (byKey.has(k)) return byKey.get(k)
  const pre = k.slice(0, 8)
  for (const [key, s] of byKey) if (key.startsWith(pre)) return s
  return null
}
let crossChanges = 0
let crossPairs = 0
for (const s of readable) {
  if (!s.meta.parent || !s.headers.length) continue
  const p = findParent(s.meta.parent)
  if (!p || !p.headers.length) continue
  crossPairs++
  const A = p.headers[p.headers.length - 1]
  const B = s.headers[0]
  if (A.face === B.face) continue
  crossChanges++
  const setA = new Set(A.names)
  const setB = new Set(B.names)
  const added = B.names.filter((n) => !setA.has(n))
  const removed = A.names.filter((n) => !setB.has(n))
  const cpl = commonPrefixLen(A.system, B.system)
  say('')
  say(`   ● 子代 ${shortId(s.dir)} (${s.meta.provider ?? '-'}/${s.meta.mode ?? '-'}, depth=${s.meta.depth ?? '-'})  首请求 face=${B.face}`)
  say(`     父代 ${shortId(p.dir)} 最后请求 face=${A.face}   （父代请求 ${p.headers.length} 次，id=${p.meta.id}）`)
  say(`     工具数 ${A.count} → ${B.count}   新增: ${added.length ? added.join(', ') : '(无)'}   删除: ${removed.length ? removed.join(', ') : '(无)'}`)
  say(`     system 长度 ${A.sysLen} → ${B.sysLen}；公共前缀断在第 ${cpl} 字符`)
}
if (!crossPairs) say('   （没有"父子都有请求头"的样本对）')
else if (!crossChanges) say(`   （${crossPairs} 对父子样本里，子代首请求与父代最后请求 face 全都相同）`)
say('')
say(`   ⇒ 跨会话变化点 = ${crossChanges}（可比的父子对 = ${crossPairs}）`)
say('')

// [4] 陈旧宣称审计
say('==================== [4] 陈旧宣称审计（runtime-context 宣称的 face vs 当时真实 face）====================')
say(`判据：对 source.plugin === "${SOURCE_PLUGIN}" 且文本含 "runtime context" 的 user/message，`)
say('      取它文本里的 face=<指纹>，与"该宣称之后第一次装配请求"的真实 face 比对。')
say('')
let claimCount = 0
let staleCount = 0
let claimNA = 0
for (const s of readable) {
  if (!s.claims.length) continue
  say(`---- ${s.dir}  (proj=${s.proj})  宣称 ${s.claims.length} 条 ----`)
  for (const c of s.claims) {
    claimCount++
    const real = s.headers.find((h) => h.seq > c.seq) ?? null
    const after = !real
    const fallback = after ? [...s.headers].reverse().find((h) => h.seq < c.seq) ?? null : null
    const ref = real ?? fallback
    let verdict
    if (!c.claimed) verdict = 'n/a（文本里没有 face=）'
    else if (!ref) verdict = 'n/a（该会话没有任何请求头可比）'
    else verdict = c.claimed === ref.face ? 'false' : 'true'
    if (verdict === 'true') staleCount++
    else if (verdict.startsWith('n/a')) claimNA++
    say(`   ● 宣称在 seq=${c.seq}  claimed face=${c.claimed ?? '(无)'}`)
    say(`     当时真实 face=${ref ? ref.face : '(无可比请求)'}${ref ? `（取 ${after ? '之前' : '之后'}第一/末次请求 seq=${ref.seq}，工具数=${ref.count}）` : ''}`)
    if (after) say('     ⚠ 该宣称之后没有任何 request/header ⇒ 无法判它是否被模型看到时已失效，按"无后继请求"处理')
    say(`     stale claim = ${verdict}`)
    say(`     文本: ${JSON.stringify(c.text.replace(/\s+/g, ' ').slice(0, 300))}`)
  }
  say('')
}
if (!claimCount) {
  say('   本机样本无宣称可审计')
  say('   （即：没有任何 user/message 同时满足 source.plugin=@deepseek-ai/dsh-system-prompt 且文本含 "runtime context"。')
  say('     这是正常的 —— §17.4 的 child-scoped provider 还没落地，没有注入过带 face= 的快照。）')
}
say('')
say(`   ⇒ 宣称条数=${claimCount}，其中 stale=true 的 ${staleCount} 条，n/a 的 ${claimNA} 条`)
if (claimCount && claimNA === claimCount) {
  say('   ⇒ ★ 0 条可判 **不是"审计通过"**：这些快照是**上游自带**的 runtime-context（内容是')
  say('     "Current DSH file policy: workspace-write…"，见 §17.2），文本里**没有我们 §17.4 的 face= 段**')
  say('     ⇒ 更准确的说法是：**本机样本里暂无带 face 指纹的宣称可审计**（审计脚本就绪，等 provider 落地）。')
}
say('')

// [5] 汇总
say('==================== [5] 汇总 ====================')
const summary = `scanned=${readable.length} sessions, face-changes=${totalChanges + crossChanges}, stale-claims=${staleCount}`
say(summary)
say(`   明细: 目录里会话文件=${listSessionFiles().length}, 成功解码=${readable.length}, 解码失败=${failed}`)
say(`         有 request/header 的会话=${withHeader.length}，其中出现 >1 个人脸的=${withHeader.filter((s) => new Set(s.headers.map((h) => h.face)).size > 1).length}`)
say(`         会话内变化点=${totalChanges}（其中差异只在端口的 ${onlyPortChanges} 个），跨会话变化点=${crossChanges}，合计=${totalChanges + crossChanges}`)
say(`         runtime-context 宣称=${claimCount}，stale=${staleCount}，n/a=${claimNA}`)

fs.mkdirSync(path.dirname(OUT_TXT), { recursive: true })
fs.writeFileSync(OUT_TXT, out.join('\n'), 'utf8')
console.log(summary)
console.log(`written: ${OUT_TXT}`)
