// list-external-deps.mjs —— 列出指定脚本（含其本地相对 import 递归）用到的**非 node 内建**模块
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

const ROOT = path.resolve(process.argv[2] ?? 'D:/project_develop/_l2/wt')
const ENTRIES = process.argv.slice(3)
if (ENTRIES.length === 0) { console.error('用法: node list-external-deps.mjs <root> <相对脚本...>'); process.exit(3) }

const builtin = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
const ext = new Map() // pkg -> Set(引用者)
const seen = new Set()

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const c of [base, base + '.mjs', base + '.js', base + '.cjs', base + '.ts',
    path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c } catch { /* 继续 */ }
  }
  return null
}

function scan(file) {
  if (seen.has(file)) return
  seen.add(file)
  let src = ''
  try { src = fs.readFileSync(file, 'utf8') } catch { return }
  const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] ?? m[2]
    if (!spec) continue
    if (builtin.has(spec)) continue
    const local = resolveSpec(file, spec)
    if (local) scan(local)
    else {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!ext.has(pkg)) ext.set(pkg, new Set())
      ext.get(pkg).add(path.relative(ROOT, file).replace(/\\/g, '/'))
    }
  }
}

for (const e of ENTRIES) {
  const f = path.resolve(ROOT, e)
  if (!fs.existsSync(f)) { console.log(`⚠️ 不存在: ${e}`); continue }
  scan(f)
}

console.log(`扫描根: ${ROOT.replace(/\\/g, '/')}`)
console.log(`递归到 ${seen.size} 个本地文件；外部包 ${ext.size} 个\n`)
if (ext.size === 0) console.log('★ 无外部依赖（只用 node 内建）⇒ 没有 node_modules 也能跑')
for (const [pkg, who] of [...ext.entries()].sort()) console.log(`  ${pkg.padEnd(24)} ← ${[...who].join(', ')}`)

const nm = path.join(ROOT, 'node_modules')
console.log(`\n${ROOT.replace(/\\/g, '/')}/node_modules ${fs.existsSync(nm) ? '存在' : '★ 不存在'}`)
