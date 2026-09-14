// session-tail.mjs — 解码 DSH 会话（多帧 zstd），打印事件直方图 + 末尾事件摘要。
// 用法： node scripts/session-tail.mjs <sessionDirName> [tailN]
//   sessionDirName 例：--D-project_develop-elv--/session-28f50f57-...
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const root = 'C:/Users/Admin/.dsh/sessions'
const rel = process.argv[2]
const tailN = Number(process.argv[3] ?? 25)
if (!rel) { console.log('usage: node scripts/session-tail.mjs <relPath> [tailN]'); process.exit(1) }
const file = path.join(root, rel, 'session.jsonl.zstd')
if (!fs.existsSync(file)) { console.log('missing', file); process.exit(1) }
const raw = fs.readFileSync(file)
let text
try { text = Buffer.from(decompress(raw)).toString('utf8') } catch (e) { console.log('decode fail:', e.message); process.exit(1) }
const lines = text.split('\n').filter((l) => l.trim())
console.log('file bytes:', raw.length, ' events:', lines.length)

const hist = new Map()
const seqs = []
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  hist.set(e.type, (hist.get(e.type) ?? 0) + 1)
  if (typeof e.seq === 'number') seqs.push(e.seq)
}
console.log('max seq:', seqs.length ? Math.max(...seqs) : '-')
console.log('--- event histogram (top 30) ---')
;[...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, v]) => console.log(String(v).padStart(6), k))

console.log(`\n--- last ${tailN} events ---`)
for (const l of lines.slice(-tailN)) {
  let e
  try { e = JSON.parse(l) } catch { console.log(l.slice(0, 200)); continue }
  const s = JSON.stringify(e)
  console.log(`[seq ${e.seq ?? '-'}] ${e.type}: ${s.length > 320 ? s.slice(0, 320) + '…' : s}`)
}

// 找带 token 用量字段的事件
console.log('\n--- usage-ish events ---')
let shown = 0
for (let i = lines.length - 1; i >= 0 && shown < 8; i--) {
  if (!/inputTokens|input_tokens|promptTokens|usage|contextWindow|exceeds/i.test(lines[i])) continue
  console.log(lines[i].slice(0, 500))
  shown++
}
