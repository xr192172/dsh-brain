#!/usr/bin/env node
/**
 * scan-unknown-tool.mjs —— 扫全量会话，量化 `unknown tool "<x>": only run_code is callable directly`
 *
 * 对应 docs/upstream-defects.md §2.8（待查项）。只读 ~/.dsh/sessions，产出写到 out/。
 *
 * 统计维度：会话 / 工具名 / 该次失败时模型看到的 request/header 工具面
 *   ★ 关键量：失败的工具【当时有没有被列在工具面里】（列了却拒收 = 工具面与运行时不一致）
 *   ★ 关键量：当时的 system prompt 有没有上游那条 CODE_ONLY_INSTRUCTION（`run_code` is the only tool…）
 *
 * 用法： node scripts/scan-unknown-tool.mjs [--verbose]
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const SESSION_ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/unknown-tool-scan.txt'
const VERBOSE = process.argv.includes('--verbose')

/** 报错形态识别：upstream dsh-tools 的 ToolNotFoundError 文案 */
const REJECT_RE = /only `run_code` is callable directly/
const NAME_RE = /unknown tool "([^"]+)"/
/** 上游 dsh-tools/lib/index.js:2407 的 CODE_ONLY_INSTRUCTION 判句 */
const CODE_ONLY_MARK = 'is the only tool you can call directly'
/** 我们自己写在 code-council persona 里的硬规则判句（.agent-presets/code-council/agent.cordis.yml:37） */
const OUR_RULE_MARK = '本会话的工具入口只有一个'

function listSessions() {
  const out = []
  for (const d of fs.readdirSync(SESSION_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dp = path.join(SESSION_ROOT, d.name)
    let kids = []
    try { kids = fs.readdirSync(dp, { withFileTypes: true }) } catch { continue }
    for (const s of kids) {
      if (!s.isDirectory()) continue
      const f = path.join(dp, s.name, 'session.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const st = fs.statSync(f)
      out.push({ rel: `${d.name}/${s.name}`, file: f, size: st.size, mtime: st.mtime })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function resultTextOf(ev) {
  const c0 = ev?.data?.message?.content?.[0]
  if (Array.isArray(c0?.content)) return c0.content.map((x) => x?.text ?? '').join('')
  return String(c0?.content ?? c0?.text ?? '')
}

function toolNamesOf(header) {
  const h = header?.data?.header ?? header ?? {}
  let tools = h.tools ?? h.toolSchemas ?? h.functions ?? h.api?.tools ?? null
  if (!Array.isArray(tools) && tools && typeof tools === 'object') tools = Object.values(tools)
  if (!Array.isArray(tools)) return null
  return tools.map((t) => t?.name ?? t?.function?.name ?? t?.id ?? '?')
}

/** header 事件里的 system prompt 文本 */
function systemOf(header) {
  const h = header?.data?.header ?? {}
  const sys = h.system ?? h.systemPrompt
  if (typeof sys === 'string') return sys
  if (Array.isArray(sys)) return sys.map((p) => p?.text ?? String(p ?? '')).join('\n')
  return ''
}

/** 会话首事件里找 preset / profile 之类的归属信息 */
function metaOf(firstEvent, rawText) {
  const meta = {}
  const collect = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object') return
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (/preset|profile|model|agentId|kind|plugin/i.test(k) && (typeof v === 'string' || typeof v === 'number' || Array.isArray(v))) {
        meta[key] = Array.isArray(v) ? v.slice(0, 6).join(',') : String(v).slice(0, 60)
      }
      if (prefix === '' && v && typeof v === 'object') collect(v, key)
    }
  }
  collect(firstEvent)
  // 兜底：整段文本里找 preset 名字
  const found = [...new Set(String(rawText).match(/"(?:agentPreset|preset|presetId)"\s*:\s*"([^"]+)"/g) ?? [])]
  if (found.length) meta.rawPresetHits = found.slice(0, 5).join(' | ')
  return meta
}

const rows = []
const sessionRows = []
const skipped = []
for (const s of listSessions()) {
  if (s.size > 40 * 1048576) { skipped.push(s.rel); continue }
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(s.file))).toString('utf8') } catch (e) { skipped.push(`${s.rel} (解压失败)`); continue }

  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    ev.__raw = line
    events.push(ev)
  }
  if (!events.length) { skipped.push(`${s.rel} (无事件)`); continue }

  const meta = metaOf(events[0], text.slice(0, 200000))
  const preset = JSON.parse(JSON.stringify(meta)).agentPreset ?? JSON.parse(JSON.stringify(meta)).preset ?? '(未知)'
  let curPreset = preset
  let curHeader = null
  let curHeaderSeq = -1
  const callName = new Map()
  let hitCount = 0
  let resultCount = 0
  let firstTime = Infinity
  let lastTime = 0

  for (const ev of events) {
    const t = Number(ev.time)
    if (Number.isFinite(t)) { firstTime = Math.min(firstTime, t); lastTime = Math.max(lastTime, t) }
    // ★ preset 会中途切换 ⇒ 取「最近一次」出现的 agentPreset，而不是会话首个事件
    const pm = /"agentPreset"\s*:\s*"([^"]+)"/.exec(ev.__raw ?? '')
    if (pm) curPreset = pm[1]
    if (ev.type === 'request/header') {
      curHeader = ev
      curHeaderSeq = ev.seq ?? -1
      continue
    }
    if (ev.type === 'tool/call') {
      const cid = ev?.data?.callId ?? ev?.data?.message?.content?.[0]?.toolCallId
      if (cid) callName.set(cid, ev?.data?.name ?? ev?.data?.message?.content?.[0]?.name ?? '?')
      continue
    }
    if (ev.type !== 'tool/result') continue
    resultCount++
    const text0 = resultTextOf(ev)
    if (!REJECT_RE.test(text0)) continue
    const c0 = ev?.data?.message?.content?.[0]
    const cid = c0?.toolCallId ?? ev?.data?.message?.source?.callId
    const named = NAME_RE.exec(text0)?.[1]
    const tool = named ?? callName.get(cid) ?? '?'
    const toolsAt = toolNamesOf(curHeader)
    const sysAt = systemOf(curHeader)
    hitCount++
    rows.push({
      mtime: s.mtime,
      time: Number.isFinite(t) ? t : 0,
      iso: Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '?',
      date: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '?',
      preset: curPreset,
      ourRule: sysAt.includes(OUR_RULE_MARK),
      rel: s.rel,
      seq: ev.seq ?? -1,
      headerSeq: curHeaderSeq,
      tool,
      toolListed: toolsAt === null ? 'no-header' : (toolsAt.includes(tool) ? 'YES' : 'no'),
      toolsCount: toolsAt ? toolsAt.length : -1,
      hasRunCode: toolsAt ? toolsAt.includes('run_code') : null,
      toolsSample: toolsAt ? toolsAt.join(',') : '',
      codeOnlyRule: sysAt.includes(CODE_ONLY_MARK),
      systemLen: sysAt.length,
      isError: c0?.isError === true,
      meta: JSON.stringify(meta),
      raw: text0.slice(0, 220).replace(/\n/g, '\\n'),
    })
  }
  if (hitCount) {
    sessionRows.push({ rel: s.rel, preset: curPreset, hits: hitCount, results: resultCount,
      rate: resultCount ? (hitCount * 100 / resultCount).toFixed(1) : 'n/a',
      date: Number.isFinite(firstTime) ? new Date(firstTime).toISOString().slice(0, 10) : '?' })
  }
  if (VERBOSE && hitCount) process.stdout.write(`${s.rel} hits=${hitCount}\n`)
}

// ─────────────────────────── 汇总 ───────────────────────────
// ───────── 口径核对：同一个现象可以有好几种数法（解释数量差异） ─────────
const utotal = new Map()
for (const s of listSessions()) {
  if (s.size > 40 * 1048576) continue
  let text
  try { text = Buffer.from(decompress(fs.readFileSync(s.file))).toString('utf8') } catch { continue }
  const bump = (k, n) => utotal.set(k, (utotal.get(k) ?? 0) + n)
  bump('raw: 文本里出现 "unknown tool \\"" 的次数（含后续轮次把结果回喂 prompt 的重复）',
    (String(text).match(/unknown tool \\"/g) ?? []).length)
  bump('raw: 文本里出现 "only `run_code` is callable directly" 的次数',
    (String(text).match(/only `run_code` is callable directly/g) ?? []).length)
}

const L = []
L.push(`扫会话数: ${listSessions().length}（跳过 ${skipped.length}）`)
L.push(`报错总条数: ${rows.length}（tool/result 事件口径）`)
L.push(`涉及会话数: ${new Set(rows.map((r) => r.rel)).size}`)
L.push('')
L.push('===== 口径核对（解释为什么别的数法会得到更大的数）=====')
for (const [k, v] of utotal) L.push(`  ${String(v).padStart(5)}  ${k}`)
L.push('')

function tally(keyFn, title) {
  const m = new Map()
  for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) ?? 0) + 1) }
  L.push(`===== ${title} =====`)
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) L.push(`  ${String(v).padStart(5)}  ${k}`)
  L.push('')
  return m
}

tally((r) => r.tool, '按工具名')
tally((r) => r.toolListed + ' / toolsCount=' + r.toolsCount, '失败工具当时是否被列在工具面（★ 关键）')
tally((r) => `toolsSample=[${r.toolsSample}] hasRunCode=${r.hasRunCode}`, '★ 失败瞬间工具面的实际内容')
tally((r) => `codeOnlyRule=${r.codeOnlyRule} systemLen=${r.systemLen === 0 ? 0 : '>0'}`, '当时 system 里有没有上游那条 code-only 规则')
tally((r) => r.meta.length > 2 ? r.meta : '(会话首事件无归属字段)', '按会话首事件归属字段')
L.push('===== 按会话 TOP20 =====')
const bySess = new Map()
for (const r of rows) bySess.set(r.rel, (bySess.get(r.rel) ?? 0) + 1)
for (const [k, v] of [...bySess.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const sample = rows.find((r) => r.rel === k)
  L.push(`  ${String(v).padStart(5)}  ${k}`)
  L.push(`        工具面=${sample.toolsCount}个 listed=${sample.toolListed} codeOnlyRule=${sample.codeOnlyRule} meta=${sample.meta.slice(0, 160)}`)
}
L.push('')
tally((r) => `${r.iso} preset=${r.preset} 我方硬规则=${r.ourRule}`, '★ 逐日（精到秒）/ preset / 我方 persona 硬规则是否在场')
tally((r) => `${r.date}  preset=${r.preset}  我方硬规则=${r.ourRule}`, '★ 按 日期 / preset / 我方 persona 硬规则是否在场')
tally((r) => `preset=${r.preset} 我方硬规则=${r.ourRule}`, '★ 按 preset × 我方硬规则')
tally((r) => `上游规则=${r.codeOnlyRule} 我方硬规则=${r.ourRule}`, '★ 两条规则的组合（在场即算有，失败说明规则没挡住模型）')
L.push('===== 每会话：拒收数 / 该会话工具结果数（拒收率）=====')
for (const s of sessionRows.sort((a, b) => b.hits - a.hits)) {
  L.push(`  ${String(s.hits).padStart(4)} / ${String(s.results).padStart(5)} 条工具结果  =  ${String(s.rate).padStart(5)}%   ${s.date}  preset=${s.preset}`)
  L.push(`        ${s.rel}`)
}
L.push('')
L.push('===== 报错原文样例（前 3 条）=====')
for (const r of rows.slice(0, 3)) L.push(`  [${r.rel}] ${r.raw}`)

fs.writeFileSync(OUT, L.join('\n'), 'utf8')
console.log(L.slice(0, 40).join('\n'))
console.log('\n详情 -> ' + OUT)
