// 扫描全仓同族隐患：`return { ...CONST }`（浅拷贝共享内部数组/对象）。
// 依据：pool.ts 刚被这条形态咬了一口（跨实例共享 others 数组）。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.argv[2] ?? '.'
const SKIP = new Set(['node_modules', 'out', 'lib', '.git', 'dist', 'coverage'])
const hits = []
const sharedConsts = []

function walk(dir, depth) {
  if (depth > 5) return
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, depth + 1); continue }
    if (!/\.(ts|tsx|mts|cts)$/.test(e.name)) continue
    const lines = readFileSync(p, 'utf8').split('\n')
    lines.forEach((l, i) => {
      // 形态 1：return { ...SOMECONST }
      const m1 = l.match(/return\s*\{\s*\.\.\.\s*([A-Z][A-Z0-9_]{2,})/)
      if (m1) hits.push({ rel: relative(ROOT, p), line: i + 1, kind: 'spread-return', constName: m1[1], text: l.trim() })
      // 形态 2：const X = { ... , arr: [] }  ← 模块级模板（后续若被浅拷贝就是隐患）
      const m2 = l.match(/^const\s+([A-Z][A-Z0-9_]{2,})\s*:\s*\w+\s*=\s*\{/)
      if (m2) sharedConsts.push({ rel: relative(ROOT, p), line: i + 1, constName: m2[1], text: l.trim() })
    })
  }
}

walk(ROOT, 0)

console.log('=== 形态 1：return { ...CONST }（浅拷贝返回，内部数组会被共享）===')
console.log(hits.length ? hits.map((h) => `  ${h.rel}:${h.line}  [${h.constName}]  ${h.text}`).join('\n') : '  （无）')

console.log('\n=== 形态 2：模块级常量对象模板（被上面浅拷贝时会连数组一起共享）===')
console.log(sharedConsts.length ? sharedConsts.map((h) => `  ${h.rel}:${h.line}  [${h.constName}]  ${h.text}`).join('\n') : '  （无）')

// 交叉：某个 CONST 既被定义又出现在 return {...CONST} 里 ⇒ 高危
const names = new Set(hits.map((h) => h.constName))
const danger = sharedConsts.filter((c) => names.has(c.constName))
console.log('\n=== ★ 交叉判定：既定义模板、又被浅拷贝返回（高危）===')
console.log(danger.length ? danger.map((d) => `  ★ ${d.rel}:${d.line}  [${d.constName}]`).join('\n') : '  （无交叉）')
