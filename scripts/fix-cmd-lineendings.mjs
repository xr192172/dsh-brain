// 把指定 .cmd/.bat 的行尾转成 CRLF（**不加 BOM** —— .cmd 不要 BOM）。
// 逐个文件、幂等、可重复跑。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? '.'
const SKIP = new Set(['node_modules', '.git', 'out', 'lib', 'dist'])
const fixed = []
const seen = []

function walk(dir, depth) {
  if (depth > 5) return
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, depth + 1); continue }
    if (!/\.(cmd|bat)$/i.test(e.name)) continue
    seen.push(p)

    const buf = readFileSync(p)
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    let t = buf.toString('utf8')
    if (hasBom) t = t.slice(1) // .cmd 不要 BOM（本机 PS 5.1 会加，见铁律 1）

    // 归一化：先把已有 CRLF 压成 LF，再统一展开成 CRLF（幂等）
    const norm = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const crlf = norm.replace(/\n/g, '\r\n')

    const before = (t.match(/\r\n/g) || []).length
    const after = (crlf.match(/\r\n/g) || []).length
    const pureBefore = (t.match(/\n/g) || []).length - before

    if (pureBefore > 0 || hasBom) {
      writeFileSync(p, crlf, 'utf8') // writeFileSync 不写 BOM ⇒ 顺带修 BOM
      fixed.push({ p, pureBefore, after, hadBom: hasBom })
    }
  }
}

walk(ROOT, 0)

console.log(`扫描 .cmd/.bat：${seen.length} 个`)
if (fixed.length === 0) console.log('  （无需修：全部已是 CRLF 且无 BOM）')
for (const f of fixed) {
  console.log(`  ✓ 修好 ${f.p}  纯LF ${f.pureBefore} → 0，CRLF → ${f.after}${f.hadBom ? '（并去掉 BOM）' : ''}`)
}
