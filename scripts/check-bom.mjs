// check-bom: 全项目 UTF-8 BOM 守卫。
//
// 为什么要它：
//   DSH 启动链上有多处 `JSON.parse(readFileSync(pkgJson, "utf8"))`
//   （dsh-app-boot: app anchor / profile manifest / 每个 bundle 的 manifest）。
//   UTF-8 BOM(EF BB BF) 会让 JSON.parse 在首字节抛
//     SyntaxError: Unexpected token '\uFEFF'
//   → 整个 gen 起不来（实测见 docs/gen-plugin-tree-partial-failure.md §2：gen-3085 / gen-3091）。
//   同一类坑还会击穿：带 shebang 的 .mjs/.cjs（`#!/usr/bin/env node` 前有 BOM 会 exec 失败）、
//   `node --check` 之外的多数 JSON 消费方、pnpm/npm 的部分解析路径。
//
//   BOM 的典型来源：Windows 侧写入方 —— PowerShell 5.1 的 `Set-Content -Encoding UTF8`、
//   记事本"UTF-8"、部分编辑器/脚本。所以只要工具链里有 PowerShell 写文件，就值得常扫。
//
// ★ 唯一的反向例外：`.ps1` **必须带 BOM**。
//   PowerShell 5.1 不按 UTF-8 读无 BOM 的 .ps1，而是按 ANSI(GBK) 解码 → 中文乱码 →
//   GBK 双字节吃掉引号 → 语法错误（实测：normalize-design-canvas.ps1 初版报 12 处语法错误）。
//   所以本脚本对 .ps1 做**反向检查**：缺 BOM 也报错，--fix 会补上。
//   ⇒ 同一份"编码"问题，在不同消费方要**相反**的处理：数据文件剥 BOM，PowerShell 脚本加 BOM。
//
// 用法：
//   node scripts/check-bom.mjs           # 扫描；BOM 违规或 .ps1 缺 BOM → 打印清单并 exit 1（适合 CI/pre-commit）
//   node scripts/check-bom.mjs --fix     # 就地修正：剥 JSON/源码的 BOM、给 .ps1 补 BOM；exit 0
//   node scripts/check-bom.mjs --quiet   # 只打印汇总
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/project_develop/dsh-brain'
const DSH_HOME = 'C:/Users/Admin/.dsh'

const fix = process.argv.includes('--fix')
const quiet = process.argv.includes('--quiet')

// 扫描根：只覆盖"我们会写、且启动链会读"的地方，刻意不进 node_modules（体积大且非我们维护）。
const ROOTS = [
  { dir: `${ROOT}/packages`, depth: 6 },      // 我们自己的插件包（含 package.json / cordis.patch.yml / src）
  { dir: `${ROOT}/scripts`, depth: 2 },
  { dir: `${ROOT}/patches`, depth: 2 },
  { dir: DSH_HOME, depth: 5 },                // profile 配置、settings、credentials 等
]

const EXT = /\.(json|jsonl|yml|yaml|mjs|cjs|js|ts|mts|cts)$/
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.tools',
  '.workbuddy', 'design-canvas-dev', 'dsh-pet-miyako-extract', 'package',
])
// 自动生成的大索引，不进版本控制，扫它没意义
const SKIP_FILES = new Set(['dsh-brain.dsl.json', 'dsh-brain-context.dsl.json'])

const found = []
let scanned = 0

function walk(dir, depth) {
  if (depth < 0) return
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    // 关键：跳过符号链接/junction，否则会从 ~/.dsh/profiles/node_modules 走进整个 dsh-brain/node_modules
    if (e.isSymbolicLink()) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, depth - 1)
      continue
    }
    if (!e.isFile()) continue
    if (SKIP_FILES.has(e.name)) continue
    if (!EXT.test(e.name)) continue

    let fd
    try { fd = fs.openSync(p, 'r') } catch { continue }
    try {
      const head = Buffer.alloc(3)
      const n = fs.readSync(fd, head, 0, 3, 0)
      scanned += 1
      if (n === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        const size = fs.statSync(p).size
        found.push({ p, size })
      }
    } catch { /* 读不了就跳过 */ } finally {
      fs.closeSync(fd)
    }
  }
}

for (const r of ROOTS) walk(r.dir, r.depth)

// ── 反向检查：.ps1 必须【带】BOM ──────────────────────────────────────────
// 这条和上面的"剥 BOM"方向相反，但同源：
//   PowerShell 5.1 **不会**按 UTF-8 读无 BOM 的 .ps1，而是按 ANSI(GBK) 解码
//   → 中文注释/字符串变乱码 → GBK 双字节会吃掉后面的引号 → AST 解析报语法错误。
//   实测：scripts/normalize-design-canvas.ps1 初版无 BOM，AST 报 12 处语法错误；
//         加 EF BB BF 后一次通过。（这就是"同一份数据，两种消费方要相反处理"的实例。）
// 注意：.ps1 不在上面的 EXT 里，所以不会被"剥 BOM"那半边误伤。
const ps1Missing = []
let ps1Scanned = 0
function walkPs1(dir, depth) {
  if (depth < 0) return
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkPs1(p, depth - 1)
      continue
    }
    if (!e.isFile() || !e.name.endsWith('.ps1')) continue
    let fd
    try { fd = fs.openSync(p, 'r') } catch { continue }
    try {
      const st = fs.statSync(p)
      // 空文件无需 BOM（也不要给它加，否则"空文件"会变成只有 3 字节 BOM 的文件）
      if (st.size === 0) continue
      const head = Buffer.alloc(3)
      const n = fs.readSync(fd, head, 0, 3, 0)
      ps1Scanned += 1
      const hasBom = n === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
      if (!hasBom) ps1Missing.push({ p, size: st.size })
    } catch { /* 读不了就跳过 */ } finally {
      fs.closeSync(fd)
    }
  }
}
for (const r of ROOTS) walkPs1(r.dir, r.depth)

const lines = []
lines.push(`scanned: ${scanned} files`)
lines.push(`BOM found: ${found.length}`)
for (const f of found) lines.push(`  ${f.p}  (${f.size} B)`)
lines.push(`ps1 scanned: ${ps1Scanned}`)
lines.push(`ps1 MISSING BOM: ${ps1Missing.length}`)
for (const f of ps1Missing) lines.push(`  ${f.p}  (${f.size} B)`)

if (fix && found.length) {
  lines.push('--- fixing (strip) ---')
  let ok = 0
  for (const f of found) {
    try {
      const buf = fs.readFileSync(f.p)
      fs.writeFileSync(f.p, buf.subarray(3))   // 只剥 3 字节，其余原样（不碰 CRLF）
      ok += 1
      lines.push(`  stripped: ${f.p}`)
    } catch (e) {
      lines.push(`  FAILED: ${f.p} :: ${String(e && e.message)}`)
    }
  }
  lines.push(`stripped ${ok}/${found.length}`)
}

if (fix && ps1Missing.length) {
  lines.push('--- fixing (add BOM to .ps1) ---')
  let ok = 0
  for (const f of ps1Missing) {
    try {
      const buf = fs.readFileSync(f.p)
      fs.writeFileSync(f.p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]))
      ok += 1
      lines.push(`  bom-added: ${f.p}`)
    } catch (e) {
      lines.push(`  FAILED: ${f.p} :: ${String(e && e.message)}`)
    }
  }
  lines.push(`bom-added ${ok}/${ps1Missing.length}`)
}

const report = lines.join('\n')
fs.writeFileSync(path.join(ROOT, 'out', 'bom-check.txt'), report, 'utf8')
if (!quiet) console.log(report)
else console.log(`BOM check: scanned=${scanned} found=${found.length} | ps1 checked=${ps1Scanned} missingBom=${ps1Missing.length}${fix ? ' fixed=yes' : ''}`)

if ((found.length && !fix) || (ps1Missing.length && !fix)) {
  console.log('\n提示：加 --fix 就地处理（剥 JSON/源码的 BOM、给 .ps1 补 BOM）。')
  console.log('      BOM 常见来源：PowerShell 5.1 的 Set-Content -Encoding UTF8（必加 BOM）。')
  process.exit(1)
}
