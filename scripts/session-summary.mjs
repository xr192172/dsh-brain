// 汇总 DSH 会话目录：header 摘要 (id/preset/parent/seed/events)
import fs from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = 'C:/Users/Admin/.dsh/sessions/--D-project_develop-dsh-brain--'
const dirs = fs.readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, mod: fs.statSync(path.join(root, d.name)).mtimeMs }))
  .sort((a, b) => b.mod - a.mod)
  .slice(0, 10)

for (const d of dirs) {
  const f = path.join(root, d.name, 'session.jsonl.zstd')
  if (!fs.existsSync(f)) { console.log(`${d.name}: <no zstd>`); continue }
  try {
    const s = zstdDecompressSync(fs.readFileSync(f)).toString('utf8')
    const lines = s.split('\n').filter((l) => l.trim())
    const h = JSON.parse(lines[0])
    const n = lines.length - 1
    const dt = new Date(d.mod).toLocaleString('zh-CN', { hour12: false })
    console.log(`${d.name}\n   mod=${dt} events=${n} preset=${h.agentPreset} parent=${h.parentSession ?? '-'} seed=${h.seedLength ?? '-'}`)
  } catch (e) {
    console.log(`${d.name}: err ${e.message}`)
  }
}