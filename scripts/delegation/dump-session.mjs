// dump-session.mjs —— 把某个 DSH 会话的事件按序打出来（诊断用，纯文件通道）
// 用法: node out/_probe/dump-session.mjs <sessionId> [--home C:/Users/Admin/.dsh] [--full]
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const argv = process.argv.slice(2)
const sid = argv[0]
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const HOME = argOf('--home') ?? 'C:/Users/Admin/.dsh'
const full = argv.includes('--full')

if (!sid) { console.error('用法: node dump-session.mjs <sessionId>'); process.exit(3) }

const root = path.join(HOME, 'sessions')
let found = null
for (const d of fs.readdirSync(root)) {
  const pp = path.join(root, d)
  if (!fs.statSync(pp).isDirectory()) continue
  for (const s of fs.readdirSync(pp)) {
    if (s !== sid) continue
    const f = path.join(pp, s, 'session.jsonl.zstd')
    if (fs.existsSync(f)) found = f
  }
}
if (!found) { console.error('未找到会话文件: ' + sid); process.exit(1) }

const raw = fs.readFileSync(found)
let text
try { text = Buffer.from(decompress(raw)).toString('utf8') }
catch (e) { console.error('解压失败: ' + e.message); process.exit(1) }

const lines = text.split('\n').filter((l) => l.trim())
console.log(`file: ${found.replace(/\\/g, '/')}`)
console.log(`events: ${lines.length}`)
console.log('')

lines.forEach((l, i) => {
  let e
  try { e = JSON.parse(l) } catch { console.log(`#${i} <非 JSON> ${l.slice(0, 200)}`); return }
  const s = JSON.stringify(e)
  if (!full && s.length > 1200) {
    console.log(`#${i} type=${e.type} seq=${e.seq ?? '?'} keys=${Object.keys(e).join(',')}`)
    console.log(`     ${s.slice(0, 900)} ... [截断 ${s.length}]`)
  } else {
    console.log(`#${i} ${full ? '' : 'type=' + e.type + ' '}${s.slice(0, 3000)}`)
  }
  console.log('')
})
