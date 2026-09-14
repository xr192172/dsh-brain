/**
 * dump-request-tools.mjs —— 从会话的 request/header 事件里取「模型实际看到的工具清单」
 *
 * 这是权威来源：request/header 是发给 LLM 的真实 header（system + tools）。
 * 用途：验收某个 preset 到底把哪些工具交到了模型手里。
 *
 * 用法： node scripts/dump-request-tools.mjs <sessionDirRelPath>
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/request-tools.txt'
const rel = process.argv[2]
if (!rel) { console.log('usage: node scripts/dump-request-tools.mjs <relPath>'); process.exit(1) }

const file = path.join(ROOT, rel, 'session.jsonl.zstd')
if (!fs.existsSync(file)) { console.log('missing', file); process.exit(1) }

const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
const evs = text.split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter(Boolean)

const out = []
out.push(`会话: ${rel}`)
out.push(`事件数: ${evs.length}`)
out.push('')

// ── request/header：模型看到的工具 ─────────────────────────────
const headers = evs.filter((e) => e.type === 'request/header')
out.push(`===== request/header 事件数: ${headers.length} =====`)
for (const [i, e] of headers.entries()) {
  const h = e.data?.header ?? {}
  out.push(`--- header #${i}  seq=${e.seq} ---`)
  out.push(`  header keys: ${Object.keys(h).join(', ')}`)

  // 工具列表的各种可能位置
  let tools = h.tools ?? h.toolSchemas ?? h.functions ?? h.api?.tools ?? null
  if (!Array.isArray(tools) && h.tools && typeof h.tools === 'object') tools = Object.values(h.tools)
  if (Array.isArray(tools)) {
    const names = tools.map((t) => t?.name ?? t?.function?.name ?? t?.id ?? '?')
    out.push(`  ★ 工具数: ${tools.length}`)
    out.push(`  ★ 工具名全量:`)
    for (const n of names) out.push(`      ${n}`)
    const delegation = names.filter((n) => /subagent|agent_|delegate|list_agents|interrupt_agent|workflow|ralph/i.test(String(n)))
    out.push(`  ★ 委派/编排相关: ${delegation.length ? delegation.join(', ') : '【无】'}`)
  } else {
    out.push(`  工具字段未直接找到；header 顶层键值类型: ` +
      Object.entries(h).map(([k, v]) => `${k}:${Array.isArray(v) ? `array(${v.length})` : typeof v}`).join(', '))
  }
  if (typeof h.system === 'string') {
    out.push(`  system 长度: ${h.system.length}`)
    out.push(`  system 是否含 subagent 字样: ${/subagent/i.test(h.system)}`)
  }
  out.push('')
}

// ── system 里的委派相关段落（若有）─────────────────────────────
const sys = headers[0]?.data?.header?.system
if (typeof sys === 'string') {
  const lines = sys.split('\n')
  const hits = lines.map((l, i) => [i, l]).filter(([, l]) => /subagent|委派|delegat/i.test(l))
  out.push('===== system prompt 中委派相关行 =====')
  out.push(hits.length ? hits.map(([i, l]) => `  ${i}: ${l.slice(0, 220)}`).join('\n') : '  【无】')
  out.push('')
}

// ── assistant/message：模型的回答文本 ─────────────────────────
const ams = evs.filter((e) => e.type === 'assistant/message')
out.push(`===== assistant/message 事件数: ${ams.length} =====`)
for (const e of ams) {
  const content = e.data?.message?.content ?? []
  for (const c of content) {
    if (c?.type === 'text') { out.push('--- text ---'); out.push(c.text) }
    if (c?.type === 'reasoning') out.push(`--- reasoning（前 300 字）--- \n${String(c.text).slice(0, 300)}`)
    if (c?.type === 'tool-call') out.push(`--- tool-call: ${c.name ?? c.toolName} ---`)
  }
  out.push('')
}

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log('ok -> ' + OUT)
