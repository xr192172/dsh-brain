#!/usr/bin/env node
/**
 * w61-out-arm-coverage.mjs —— ★ 见证者第 2 条点名的"对称判据**覆盖范围**"补丁（只补 `out/` 这一面）。
 *
 * ## 背景（逐字来自 w60 见证者裁决）
 *   "「两臂对称」这条判据的**覆盖范围**：它只看 `.design-canvas`。… **未申报**的不对称：
 *    两臂 `packages/switchboard/out/` 里的构建目录名互不相同（各 2 个，集合完全不相交），
 *    `packages/switchboard/lib` 链接目标因此也不同名。**实质影响≈0**（被 `bin.cjs` 选中的
 *    『最新构建』两臂逐字节相同，36/36 文件）。"
 *
 * ## 为什么"补判据"不能是"要求目录名相等"（**这就是我选的路与代价**）
 *   目录名是 `<b><epoch-ms>` 形式的**构建时间戳 id**，两臂各自构建 ⇒ **永远不可能相等**。
 *   若把它写成判据，它会**永久为红**；永久红的判据 = 没人读的判据（比不写更糟）。
 *   ⇒ 本脚本把这件事**拆成两条**，一条机器判、一条**申报为已知**：
 *     · **判据（可满足、且正是真风险所在）**：两臂 `bin.cjs` **实际会选中的那份构建**
 *       （`out/` 下名字最大、以 `b` 开头者）**逐文件逐字节一致**；
 *     · **已知项（申报，不进 problems）**：`out/` 的**目录名集合允许不同** ——
 *       它不是"没查出来"，是**已查清并记账**（见 `out/_w61/known-asymmetries.json`）。
 *
 * ## 退出码
 *   0 = 覆盖判据成立（"实际加载的那份构建"逐字节一致）；1 = 不成立（**响亮失败**）；2 = 用法/IO 错。
 *
 * 用法：node scripts/w61-out-arm-coverage.mjs [--arms evals/arms.json] [--json out/_w61/out-arm-coverage.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadArmsRegistry } from './arms-registry.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const armsFile = argOf('--arms') ?? path.join('evals', 'arms.json')
const jsonOut = argOf('--json')

const REL_OUT = path.join('packages', 'switchboard', 'out')

/** 递归列出 dir 下所有**文件**，返回 `相对路径 -> sha256`。 */
function hashTree(root) {
  const map = new Map()
  const walk = (d) => {
    let es
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const p = path.join(d, e.name)
      let st
      try {
        st = fs.lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (e.isDirectory()) walk(p)
      else if (st.isFile()) {
        map.set(path.relative(root, p).replace(/\\/g, '/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))
      }
    }
  }
  walk(root)
  return map
}

/** `bin.cjs` 的选择口径（逐字复刻 `packages/switchboard/bin.cjs`）：以 `b` 开头的目录名，取排序最后一个。 */
function chosenBuild(armOut) {
  let names
  try {
    names = fs.readdirSync(armOut).filter((d) => d.startsWith('b')).sort()
  } catch {
    return { ok: false, why: `读不到 ${armOut}` }
  }
  if (names.length === 0) return { ok: false, why: `${armOut} 下没有以 b 开头的构建目录` }
  return { ok: true, all: names, chosen: names[names.length - 1] }
}

let reg
try {
  reg = loadArmsRegistry(armsFile, { base: REPO })
} catch (e) {
  process.stderr.write(`[w61-out-arm-coverage] 装载臂注册表失败：${e.message}\n`)
  process.exit(2)
}

const rows = []
let ok = true
const problems = []
const known = []

for (const a of reg.arms) {
  const armOut = path.join(a.cwd, REL_OUT)
  const pick = chosenBuild(armOut)
  if (!pick.ok) {
    ok = false
    problems.push(`${a.name}: ${pick.why}`)
    rows.push({ name: a.name, cwd: a.cwd.replace(/\\/g, '/'), error: pick.why })
    continue
  }
  const chosenDir = path.join(armOut, pick.chosen)
  const files = hashTree(chosenDir)
  const linkTarget = (() => {
    const lib = path.join(a.cwd, 'packages', 'switchboard', 'lib')
    try {
      const st = fs.lstatSync(lib)
      if (st.isSymbolicLink()) return fs.readlinkSync(lib).replace(/\\/g, '/')
      return '(不是链接)'
    } catch {
      return '(读不到)'
    }
  })()
  rows.push({
    name: a.name,
    cwd: a.cwd.replace(/\\/g, '/'),
    outDirs: pick.all,
    chosen: pick.chosen,
    chosenFiles: files.size,
    libLink: linkTarget,
  })
}

// ── 判据：两臂"实际会被加载的那份构建"逐文件逐字节一致 ────────────────────────
if (rows.length >= 2 && rows.every((r) => !r.error)) {
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].chosenFiles !== rows[0].chosenFiles) {
      ok = false
      problems.push(`${rows[0].name} 与 ${rows[i].name} 的所选构建文件数不同：${rows[0].chosenFiles} vs ${rows[i].chosenFiles}`)
    }
  }
  if (ok) {
    const base = rows[0]
    const baseFiles = hashTree(path.join(base.cwd, REL_OUT, base.chosen))
    for (let i = 1; i < rows.length; i += 1) {
      const other = hashTree(path.join(rows[i].cwd, REL_OUT, rows[i].chosen))
      const diff = []
      for (const [rel, sha] of baseFiles) {
        if (!other.has(rel)) diff.push(`只在 ${base.name}：${rel}`)
        else if (other.get(rel) !== sha) diff.push(`字节不同：${rel}`)
      }
      for (const rel of other.keys()) if (!baseFiles.has(rel)) diff.push(`只在 ${rows[i].name}：${rel}`)
      if (diff.length > 0) {
        ok = false
        problems.push(`${base.name} 与 ${rows[i].name} 的所选构建**逐字节不一致**：${diff.slice(0, 8).join(' / ')}${diff.length > 8 ? ` …共 ${diff.length} 条` : ''}`)
      } else {
        known.push(`${base.name}/${rows[i].name} 的所选构建（各 ${baseFiles.size} 文件）逐字节一致 ✓`)
      }
    }
  }
}

// ── 已知项（**申报，不进 problems**）：out/ 目录名集合允许不同 ──────────────────
const dirSets = rows.map((r) => `${r.name}={${(r.outDirs ?? []).join(',')}}`)
const allSame = rows.length >= 2 && new Set(rows.map((r) => JSON.stringify(r.outDirs ?? []))).size === 1
known.push(
  allSame
    ? `out/ 构建目录名集合两臂恰好相同：${dirSets.join('  ')}`
    : `★ **已知不对称（已申报，非未查出）**：out/ 构建目录名集合两臂不同 ⇒ ${dirSets.join('  ')}；` +
        `lib 链接目标也因此不同名（${rows.map((r) => `${r.name}->${path.basename(r.libLink ?? '')}`).join('  ')}）。` +
        `目录名是构建时间戳 id（\`b<epoch-ms>\`），两臂各自构建 ⇒ **原理上不可能相等**；` +
        `实质影响≈0（见上：所选构建逐字节一致）。★ 所以这条**不写成判据**（写成判据会永久为红），只申报。`,
)

const lines = []
lines.push('[w61-out-arm-coverage] 两臂 `out/` 覆盖判据（补见证者第 2 条）')
for (const r of rows) {
  if (r.error) {
    lines.push(`  [FAIL] ${r.name}  ${r.cwd}  —— ${r.error}`)
    continue
  }
  lines.push(`  [INFO] ${r.name}  ${r.cwd}`)
  lines.push(`         out/ 构建目录   : { ${r.outDirs.join(' , ')} }`)
  lines.push(`         bin.cjs 会选中的: ${r.chosen}   （其中 ${r.chosenFiles} 个文件）`)
  lines.push(`         packages/switchboard/lib -> ${r.libLink}`)
}
lines.push(`  ${ok ? '[PASS]' : '[FAIL]'} 判据：两臂 **实际会被加载的那份构建**逐文件逐字节一致`)
for (const k of known) lines.push(`         · ${k}`)
for (const p of problems) lines.push(`         ✗ ${p}`)
lines.push(`[w61-out-arm-coverage] 结论：${ok ? '成立' : '**不成立**'}（problems=${problems.length}）`)
process.stdout.write(lines.join('\n') + '\n')

if (jsonOut) {
  const dest = path.resolve(REPO, jsonOut)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify({ ok, arms: rows, known, problems, at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  process.stdout.write(`[w61-out-arm-coverage] 已落盘 ${dest.replace(/\\/g, '/')}\n`)
}

process.exit(ok ? 0 : 1)
