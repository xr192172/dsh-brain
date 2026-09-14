import fs from 'node:fs'
import { decompress } from 'fzstd'

const rel = process.argv[2]
const file = `C:/Users/Admin/.dsh/sessions/${rel}/session.jsonl.zstd`
const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
const evs = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

// 1) header 序列：每个 header 的形态指纹
const out = []
out.push('## header 序列（形态指纹）')
out.push('seq | reason | systemLen | toolsCount | 指纹')
const headers = evs.filter((e) => e.type === 'request/header')
for (const h of headers) {
  const d = h.data ?? {}
  const hd = d.header ?? {}
  const sysLen = (hd.system ?? '').length
  const tools = Array.isArray(hd.tools) ? hd.tools.length : (hd.tools == null ? 0 : -1)
  const fp = `${sysLen}|${tools}`
  out.push(`${h.seq} | ${d.reason} | ${sysLen} | ${tools} | ${fp}`)
}
out.push('')

// 2) 形态指纹分组
const fps = new Map()
for (const h of headers) {
  const hd = h.data?.header ?? {}
  const fp = `${(hd.system ?? '').length}|${Array.isArray(hd.tools) ? hd.tools.length : 0}`
  fps.set(fp, (fps.get(fp) || 0) + 1)
}
out.push('## 形态指纹汇总')
for (const [k, n] of [...fps.entries()].sort((a, b) => b[1] - a[1])) out.push(`  x${n}  systemLen|toolsCount = ${k}`)
out.push('')

// 3) 骤降点 vs header 对应
const turns = []
for (const e of evs) {
  if (e.type !== 'assistant/message') continue
  const u = e.data?.usage
  if (!u) continue
  const input = u.inputTokens ?? 0, cr = u.cacheReadTokens ?? 0, cw = u.cacheWriteTokens ?? 0
  const billed = input + cr + cw
  turns.push({ seq: e.seq, turn: e.data?.turn, billed, hit: billed > 0 ? cr / billed : 0, input, cr })
}
out.push('## 骤降点 vs 前置 header')
let drops = 0
for (let i = 1; i < turns.length; i++) {
  const p = turns[i - 1], c = turns[i]
  if (c.billed < 2000) continue
  if (p.hit - c.hit < 0.3) continue
  drops++
  // 找 c.seq 之前最近的 header
  let lastH = null
  for (const h of headers) { if (h.seq < c.seq) lastH = h; else break }
  const hd = lastH?.data?.header ?? {}
  const fp = hd.system == null ? '?' : `${(hd.system ?? '').length}|${Array.isArray(hd.tools) ? hd.tools.length : 0}`
  const dist = lastH ? c.seq - lastH.seq : -1
  out.push(`  drop seq=${c.seq} ${(p.hit * 100).toFixed(1)}%→${(c.hit * 100).toFixed(1)}% | 最近header seq=${lastH?.seq} reason=${lastH?.data?.reason} fp=${fp} 距离=${dist}`)
}
out.push(`骤降点总数: ${drops}`)
out.push('')

// 4) 前缀形态切换次数（相邻 header 指纹不同的次数）
let switches = 0
for (let i = 1; i < headers.length; i++) {
  const a = headers[i - 1].data?.header ?? {}, b = headers[i].data?.header ?? {}
  const fa = `${(a.system ?? '').length}|${Array.isArray(a.tools) ? a.tools.length : 0}`
  const fb = `${(b.system ?? '').length}|${Array.isArray(b.tools) ? b.tools.length : 0}`
  if (fa !== fb) switches++
}
out.push(`前缀形态切换次数（相邻 header 指纹不同）: ${switches} / ${headers.length - 1}`)
out.push(`会话总轮数: ${turns.length}`)

fs.writeFileSync('D:/project_develop/dsh-brain/out/probe-header.txt', out.join('\n'), 'utf8')
console.log('ok')
