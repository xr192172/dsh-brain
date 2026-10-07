#!/usr/bin/env node
/**
 * check-undeclared-deps.mjs —— **常驻守卫**：源码里 import 了、但 `package.json` 没声明的依赖（幻影依赖）。
 *
 * ★ 为什么要它（2026-10-07 实测，两个真缺陷都是这条）：
 *   ① `agent-io-bridge`：`lib/index.js` 第 12 行 `import { CallId } from '@deepseek-ai/dsh-llm'`
 *      —— **四类键里一处都没有** ⇒ 每代启动都 `failed to import`（`warning: 2 entries did not activate`）。
 *   ② `key-pool-proxy`：`import { z } from 'zod'` —— 同样一处都没声明。
 *   两例的**共同点**：都不是"装没装上"，而是**压根没声明** ⇒ 装与不装都无据可依 ⇒
 *   一旦依赖树重算（本次全量重装），它就**从"侥幸能解析"变成"解析不到"**。
 *
 * 判据（**每个包只认它自己的四个键**：dependencies / peerDependencies / optionalDependencies / devDependencies）：
 *   · 取该包 `src/**` 与 `lib/**` 里出现的裸模块说明符（`from '…'` / `require('…')` / `import('…')`）
 *   · 剥掉子路径（`zod/v4` → `zod`；`@scope/pkg/sub` → `@scope/pkg`）、跳过 Node 内置
 *   · 不在该包声明集里 ⇒ **违规**
 *   ★ **根 package.json 的声明不算数** —— 那正是"幻影"的定义（借别人的声明过日子）。
 *   ★ 同时报**阳性计数**（扫了多少包/多少文件）—— 免得判据"从未为真"（那等于假绿）。
 *
 * 判据优先级（本仓规矩：用下一级必须写明为什么上一级不行）：
 *   ① 运行时数据 —— 不适用：要判"声明与实际是否一致"，必须先取实际 import 面。
 *   ② 内核结构化 API（TS compiler）—— **不可用**：Tree 里是 typescript@7.0.2（原生版），
 *      JS 侧只暴露 version，`preProcessFile` / `createSourceFile` 实测均为 `undefined`。
 *   ③ AST 遍历 —— **不可用**：Tree 内无任何 JS/TS 解析器
 *      （acorn / es-module-lexer / @babel/parser 均 MODULE_NOT_FOUND）。
 *   ④ 词法提取 —— 采用。理由：**import 说明符是词法层结构**，不需要语义解析即可无歧义取得；
 *      本门只问"有没有声明"，不问"指向对不对"。
 *
 * ★ 正则在**结构**上容易翻车（本仓记录在案的坑），故加了强锚定：
 *   说明符必须出现在 `import` / `export` 语句里（`(?:^|[\n;{}])\s*(?:import|export)`）或 `require(` / `import(` 调用里。
 *   反例（已实测踩到）：`skill-tree/src/text/tokenize.ts` 有一张停用词表 `'at', 'by', 'from', 'as'` ——
 *   无锚定的正则会把那个 `from` 当 import，抽出 `", "` 这种垃圾。`--selftest` 里有这条反例的回归。
 *
 * 用法：node scripts/check-undeclared-deps.mjs [--json]
 *       node scripts/check-undeclared-deps.mjs --selftest   （含消融：种植违规 ⇒ 必须变红）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const argv = process.argv.slice(2)

const BUILTINS = new Set([
  'assert','buffer','child_process','cluster','console','constants','crypto','dgram','dns','domain',
  'events','fs','http','http2','https','inspector','module','net','os','path','perf_hooks','process',
  'punycode','querystring','readline','repl','stream','string_decoder','sys','timers','tls','trace_events',
  'tty','url','util','v8','vm','wasi','worker_threads','zlib','sqlite','test',
])

/** 锚定在 import/export 语句或 require()/import() 调用上的说明符提取 */
const SPEC_PATTERNS = [
  /(?:^|[\n;{}])\s*(?:import|export)[^;]{0,300}?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /(?:^|[\n;{}])\s*import\s*['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
]

/** 'zod/v4' -> 'zod'；'@scope/pkg/sub' -> '@scope/pkg'；相对路径/node: 内置 -> null */
export function pkgNameOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null
  if (spec.startsWith('node:')) return null
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  if (BUILTINS.has(name)) return null
  return name
}

export function specsIn(text) {
  const out = new Set()
  for (const re of SPEC_PATTERNS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) {
      const n = pkgNameOf(m[1])
      if (n) out.add(n)
    }
  }
  return out
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, out)
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

export function declaredOf(pkgJsonPath) {
  if (!fs.existsSync(pkgJsonPath)) return { set: new Set(), empty: true }
  let j
  try { j = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) } catch { return { set: new Set(), empty: true } }
  const s = new Set()
  for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    for (const n of Object.keys(j[k] ?? {})) s.add(n)
  }
  return { set: s, empty: false }
}

/** 对一个仓库根扫描；返回 { pkgs, files, violations } */
export function scan(repoRoot) {
  const pkgDir = path.join(repoRoot, 'packages')
  if (!fs.existsSync(pkgDir)) return { pkgs: 0, files: 0, violations: [], rows: [] }
  const names = fs.readdirSync(pkgDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const rows = []
  const violations = []
  let files = 0
  for (const name of names) {
    const dir = path.join(pkgDir, name)
    const { set: declared, empty } = declaredOf(path.join(dir, 'package.json'))
    const src = walkFiles(path.join(dir, 'src'))
    const lib = walkFiles(path.join(dir, 'lib'))
    files += src.length + lib.length
    const miss = new Map() // spec -> { layer, file }
    for (const [layer, list] of [['src', src], ['lib', lib]]) {
      for (const f of list) {
        let text
        try { text = fs.readFileSync(f, 'utf8') } catch { continue }
        for (const spec of specsIn(text)) {
          if (declared.has(spec)) continue
          if (!miss.has(spec)) miss.set(spec, { layer, file: path.relative(repoRoot, f) })
        }
      }
    }
    rows.push({ name, declaredCount: declared.size, noPackageJson: empty, misses: [...miss] })
    for (const [spec, where] of miss) violations.push({ pkg: name, spec, ...where })
  }
  return { pkgs: names.length, files, violations, rows }
}

function report(res, asJson) {
  if (asJson) {
    console.log(JSON.stringify(res, null, 2))
    return
  }
  console.log(`扫了 ${res.pkgs} 个包 / ${res.files} 个文件；未声明依赖 ${res.violations.length} 处`)
  for (const r of res.rows) {
    if (!r.misses.length) continue
    console.log(`◆ ${r.name}${r.noPackageJson ? '（无 package.json！）' : ''}`)
    for (const [spec, w] of r.misses) console.log(`   ❌ ${spec} ← ${w.file}`)
  }
}

/** 出生证：干净夹具必须绿；植入违规必须红；★ 回归本仓踩过的"停用词表 from"假命中 */
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'undec-deps-'))
  let failed = 0
  const mk = (name, pkg, files) => {
    const dir = path.join(tmp, 'packages', name)
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'src', n), body)
  }
  // ① 干净：声明的用、内置的用、相对路径用 ⇒ 必须 0 违规
  mk('clean', { name: 'clean', dependencies: { zod: '^4' } }, {
    'a.ts': "import { z } from 'zod'\nimport fs from 'node:fs'\nimport { b } from './b'\n",
    'b.ts': "import path from 'path'\nexport const b = 1\n",
  })
  // ② 植入违规：import 了没声明的 lodash ⇒ 必须 1 违规
  mk('planted', { name: 'planted', dependencies: {} }, {
    'a.ts': "import _ from 'lodash'\n",
  })
  // ③ 反例回归：停用词表里的 'from' **不许**被当成 import（本仓 skill-tree 实测踩过）
  mk('wordlist', { name: 'wordlist', dependencies: {} }, {
    'a.ts': "const STOP = [\n  'at', 'by', 'from', 'as', 'can',\n  'to', 'of', 'in',\n]\nexport default STOP\n",
  })
  // ④ 反例回归：子路径必须归并到包名
  mk('subpath', { name: 'subpath', dependencies: {} }, {
    'a.ts': "import { x } from 'zod/v4/core'\n",
  })

  const res = scan(tmp)
  const byPkg = Object.fromEntries(res.rows.map((r) => [r.name, r.misses.map(([s]) => s)]))
  const expect = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failed++
    console.log(`  ${ok ? '✅' : '❌'} ${label}：得到 ${JSON.stringify(got)}；期望 ${JSON.stringify(want)}`)
  }
  console.log('消融（在临时夹具上跑，不动本仓）：')
  expect('干净包 0 违规', byPkg.clean, [])
  expect('植入 lodash ⇒ 命中', byPkg.planted, ['lodash'])
  expect('停用词表 from ⇒ 不误报', byPkg.wordlist, [])
  expect('子路径 zod/v4/core ⇒ 归并为 zod', byPkg.subpath, ['zod'])
  console.log(`\n消融结论：${failed === 0 ? '全部符合预期' : `${failed} 项不符`}`)
  return failed === 0 ? 0 : 1
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (argv.includes('--selftest')) process.exit(selftest())
  const res = scan(REPO)
  report(res, argv.includes('--json'))
  process.exit(res.violations.length ? 1 : 0)
}
