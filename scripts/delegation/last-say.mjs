// last-say.mjs —— 打印某个 DSH 会话**最近的 assistant 文本**（人读用；不做任何判定）
// 用法: node out/_probe/last-say.mjs <sessionId> [n=3]
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const sid = process.argv[2]
const n = Number(process.argv[3] ?? 3)
const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
if (!sid) { console.error('用法: node last-say.mjs <sessionId> [n]'); process.exit(3) }

const root = path.join(HOME, 'sessions')
let file = null
for (const d of fs.readdirSync(root)) {
  const pp = path.join(root, d)
  if (!fs.statSync(pp).isDirectory()) continue
  for (const s of fs.readdirSync(pp)) {
    if (s !== sid) continue
    for (const f of ['session.jsonl.zstd', 'session.v3.jsonl.zstd']) {
      const p = path.join(pp, s, f)
      if (fs.existsSync(p)) file = p
    }
  }
}
if (!file) { console.error('找不到会话文件: ' + sid); process.exit(1) }

const evs = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  .split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

function collect(node, acc) {
  if (node == null || typeof node === 'string') return
  if (Array.isArray(node)) { for (const x of node) collect(x, acc); return }
  if (typeof node === 'object') {
    if (node.type === 'text' && typeof node.text === 'string') { acc.push(node.text); return }
    for (const k of Object.keys(node)) collect(node[k], acc)
  }
}

const msgs = evs.filter((e) => e.type === 'assistant/message')
const texts = []
for (const m of msgs) { const acc = []; collect(m.data, acc); const t = acc.join('').trim(); if (t) texts.push(t) }

console.log(`会话 ${sid}\n文件 ${file}\nassistant/message 事件 ${msgs.length}，有文本的 ${texts.length}\n`)
for (const t of texts.slice(-n)) {
  console.log('────────────────────────────────────────')
  console.log(t.length > 6000 ? t.slice(0, 3000) + '\n…[中略]…\n' + t.slice(-3000) : t)
}
