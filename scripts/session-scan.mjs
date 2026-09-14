// 解码并扫描 DSH 会话事件流，找交接边界附近的重复 user/message 与 assistant 前缀
import fs from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const sid = process.argv[2]
const p = `C:/Users/Admin/.dsh/sessions/--D-project_develop-dsh-brain--/${sid}/session.jsonl.zstd`
if (!fs.existsSync(p)) { console.log('missing', p); process.exit(1) }
let out
try { out = zstdDecompressSync(fs.readFileSync(p)).toString('utf8') }
catch (e) { console.log('zstd decompress fail:', e.message); process.exit(1) }
const lines = out.split('\n').filter((l) => l.trim())
console.log('total events:', lines.length)

const outLines = []
let userSeqs = []
let shown = 0
for (let i = 0; i < lines.length; i++) {
  let e
  try { e = JSON.parse(lines[i]) } catch { continue }
  if (e.type === 'user/message') {
    const txt = JSON.stringify(e.data).slice(0, 160)
    outLines.push(`[L${i}][seq ${e.seq}] USER: ${txt}`)
    userSeqs.push(e.seq)
  } else if (e.type === 'assistant/message') {
    const role = e.data && e.data.role || '?'
    const txt = JSON.stringify(e.data).slice(0, 110)
    outLines.push(`[L${i}][seq ${e.seq}] ASST(${role}): ${txt}`)
  } else if (['turn/start', 'turn/end', 'request/header', 'compaction/end', 'compaction/start'].includes(e.type)) {
    outLines.push(`[L${i}][seq ${e.seq}] ${e.type}`)
  }
  if (++shown > 120) break
}
console.log(outLines.join('\n'))
console.log('\n=== user seqs ===')
console.log(userSeqs.join(', '))