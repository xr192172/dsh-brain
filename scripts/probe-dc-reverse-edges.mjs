/**
 * probe-dc-reverse-edges.mjs —— 「双向摊开」可行性测量：入边（谁引用我）能不能不用 AST 就拿到？
 *
 * 背景（用户问题 2026-09-14）：
 *   「本来想能不能通过一个文件的**引用方向**和**被引用方向**，像一张网一样往四面摊开，
 *    但后面又想到 **AST 解析可能不支持**这种事情 —— 想支持的话该从什么方向入手？」
 *
 * 本探针量三件事（同一批真实文件）：
 *   ① **AST 全解析**成本（基线，= 今天的冷启动主成本）
 *   ② **文本级反查**成本：只找 `import/require/from` 语句（**不需要 AST**）
 *   ③ **轻量提及扫描**成本：把"本文件里出现过的标识符"落成一张提及表（正则，粗但便宜）
 * 用于回答："入边（谁引用我）"到底对不对得起"必须解析"这个价。
 *
 * 用法：node scripts/probe-dc-reverse-edges.mjs [srcDir]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const srcArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `${DC}/src`

const { parseFileFull } = await import(`file:///${DC}/dist/src/tools/ts_kernel/index.js`)

const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])

function collect(root) {
  const out = []
  const walk = (d) => {
    let es = []
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue
        walk(p)
      } else if (EXTS.has(path.extname(e.name))) out.push(p)
    }
  }
  walk(root)
  return out
}

const files = collect(path.resolve(srcArg))
const texts = files.map((f) => ({ f, src: fs.readFileSync(f, 'utf8') }))
const bytes = texts.reduce((n, t) => n + t.src.length, 0)

// ① AST 全解析（基线）
let t = Date.now()
for (const { f, src } of texts) await parseFileFull(f, src)
const astMs = Date.now() - t

// ② 文本级 import 反查（不需要 AST）
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;\n]*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
let imports = 0
t = Date.now()
for (const { src } of texts) {
  IMPORT_RE.lastIndex = 0
  let m
  while ((m = IMPORT_RE.exec(src)) !== null) imports++
}
const importScanMs = Date.now() - t

// ③ 轻量提及扫描：把标识符落成"文件 → 提及名集合"（粗，但足以做入边候选）
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g
const STOP = new Set(['const', 'export', 'import', 'return', 'function', 'interface', 'string', 'number', 'boolean', 'await', 'async', 'throw', 'catch', 'class', 'extends', 'typeof', 'null', 'true', 'false', 'undefined'])
let mentions = 0
const mentionIndex = new Map() // 标识符 → 提及它的文件数
t = Date.now()
for (const { f, src } of texts) {
  const seen = new Set()
  IDENT_RE.lastIndex = 0
  let m
  while ((m = IDENT_RE.exec(src)) !== null) {
    const id = m[0]
    if (STOP.has(id)) continue
    mentions++
    seen.add(id)
  }
  for (const id of seen) mentionIndex.set(id, (mentionIndex.get(id) ?? 0) + 1)
}
const mentionScanMs = Date.now() - t

const lines = [
  `「双向摊开」成本测量 —— 源：${path.resolve(srcArg)}`,
  `  文件 ${files.length} ｜ 合计 ${(bytes / 1048576).toFixed(1)}MB`,
  '',
  '  ① AST 全解析（基线）            : ' + `${astMs}ms`.padEnd(9) + ` （${(astMs / files.length).toFixed(1)}ms/文件）`,
  '  ② 文本级 import 反查（无 AST）  : ' + `${importScanMs}ms`.padEnd(9) + ` （${(importScanMs / files.length).toFixed(2)}ms/文件，命中 ${imports} 条 import）`,
  '  ③ 轻量提及扫描（正则，无 AST）  : ' + `${mentionScanMs}ms`.padEnd(9) + ` （${(mentionScanMs / files.length).toFixed(2)}ms/文件，提及 ${mentions} 次 → ${mentionIndex.size} 个不同名）`,
  '',
  `  ⇒ ②/① = ${(importScanMs / Math.max(1, astMs) * 100).toFixed(1)}% ｜ ③/① = ${(mentionScanMs / Math.max(1, astMs) * 100).toFixed(1)}%（**入边方向不必付 AST 的价**）`,
  '',
  '  举例：反向查找（谁提及某符号）的候选从 "提及表" 里 O(1) 取，',
  '        ' +
    [...mentionIndex.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, n]) => `${id}(${n} 文件)`)
      .join('、'),
]

fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
fs.writeFileSync('D:/project_develop/dsh-brain/out/reverse-edges.txt', lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
