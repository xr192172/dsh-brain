#!/usr/bin/env node
/**
 * check-import-safe.mjs —— **常驻守卫**：`scripts/` 下的脚本**必须 import-safe**。
 *
 * ★ 为什么要它（**同一个 bug 已踩三次**）：
 *   ① `skill-sieve.mjs`：被 `skill-factory.mjs` import ⇒ 它拿 **import 方的 argv** 跑了自己的 CLI ⇒
 *      把工厂的判据**截断**（看起来 PASS，其实一条没跑）。
 *   ② `arm-up.mjs`：同理（幸好在 import 之前就被发现）。
 *   ③ `skill-factory.mjs`：又被 `skill-to-preset.mjs` import ⇒ 同样截断。
 *   ⇒ 三次都是**同一条**：**在模块顶层派发 CLI + `process.exit()`**。
 *
 * 判据（**只对"真的被 import 的"文件提出要求** —— 不被 import 的脚本随便派发）：
 *   对每个 `scripts/**\/*.mjs`：
 *     · 若它 **被别的脚本 import**（`scripts/` 里出现 `from '…/<basename>'`）
 *     · 且它 **顶层有 CLI 派发迹象**（含 `process.exit(` 或 `process.argv`）
 *   则它 **必须含 `isMain`**（`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`）。
 *
 * ★ 同时报**阳性计数**（有几个文件真的带了守卫）—— 免得这条判据"从未为真"（那等于假绿）。
 *
 * 用法：node scripts/check-import-safe.mjs [--json]
 *       node scripts/check-import-safe.mjs --selftest   （含消融）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = HERE

/** 收集 scripts/ 下所有 .mjs（递归，跳过 node_modules 与临时消融件）。 */
function collect(dir = SCRIPTS, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('_')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collect(p, acc)
    else if (e.name.endsWith('.mjs')) acc.push(p)
  }
  return acc
}

export function scan() {
  const files = collect()
  const src = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))
  // 谁被 import 了？（只看 scripts/ 内部）
  const imported = new Map() // basename(no ext) -> [importer…]
  for (const [f, s] of src) {
    for (const m of s.matchAll(/from\s+['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[1])
      if (!src.has(target)) continue
      const key = path.basename(target)
      if (!imported.has(key)) imported.set(key, [])
      imported.get(key).push(path.relative(SCRIPTS, f))
    }
  }
  const rows = []
  for (const [f, s] of src) {
    const base = path.basename(f)
    const importers = imported.get(base) ?? []
    if (importers.length === 0) continue // 不被 import ⇒ 不要求
    const looksCli = /process\.exit\(|process\.argv/.test(s)
    if (!looksCli) continue // 纯函数模块 ⇒ 没这个问题
    const hasGuard = s.includes('isMain')
    rows.push({ file: path.relative(SCRIPTS, f).replace(/\\/g, '/'), importers, hasGuard })
  }
  // ★ 阳性计数：整个 scripts/ 里有多少文件带守卫（含未被 import 的）
  const guarded = [...src.values()].filter((s) => s.includes('isMain')).length
  return { rows, total: src.size, guarded, importedCount: imported.size }
}

function selftest() {
  const { rows, total, guarded, importedCount } = scan()
  const bad = rows.filter((r) => !r.hasGuard)
  console.log(`脚本总数 ${total}；被 scripts/ 内部 import 的 ${importedCount} 个；带 isMain 守卫的 ${guarded} 个`)
  console.log('★ 需要守卫的文件（被 import 且顶层有 CLI 迹象）：')
  for (const r of rows) console.log(`  ${r.hasGuard ? 'ok  ' : 'FAIL'} ${r.file}  ← 被 ${r.importers.join(', ')} import`)
  // ★ 阳性对照：这条判据必须**真的在检查东西**（有被 import 且有 CLI 迹象的文件）
  const notVacuous = rows.length > 0
  if (!notVacuous) console.log('  ★★ 判据可能空转：没有任何"被 import 且顶层有 CLI"的文件 ⇒ 这条守卫此刻无法证明什么')
  // ★★ 消融：把 skill-sieve.mjs 里的 isMain 守卫临时去掉 ⇒ 它必须被报为 FAIL
  console.log('\n=== 消融自证 ===')
  const target = path.join(SCRIPTS, 'skill-sieve.mjs')
  const bak = fs.readFileSync(target, 'utf8')
  let ablOk = false
  try {
    fs.writeFileSync(target, bak.replace(/const isMain = [^\n]*\n/, '// ABLATED: isMain 已撤\n'), 'utf8')
    const out = (spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 60000 }).stdout ?? '')
    ablOk = /FAIL skill-sieve\.mjs/.test(out)
    console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 撤掉 skill-sieve 的 isMain ⇒ 它被报 FAIL ${ablOk ? '✓' : '（没报 ⇒ 这条判据没接线）'}`)
  } finally {
    fs.writeFileSync(target, bak, 'utf8')
  }
  const pass = bad.length === 0 && notVacuous && ablOk
  console.log(`\n结果：违规 ${bad.length} 个；判据非空转=${notVacuous}；消融 ${ablOk ? '通过' : '未通过'} ⇒ ${pass ? 'PASS' : 'FAIL'}`)
  return pass ? 0 : 1
}

const argv = process.argv.slice(2)
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (argv.includes('--selftest')) process.exit(selftest())
  const { rows, total, guarded } = scan()
  const bad = rows.filter((r) => !r.hasGuard)
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ total, guarded, rows, violations: bad.length }, null, 2))
  } else {
    console.log(`scripts/ 下 ${total} 个 .mjs；带 isMain 守卫 ${guarded} 个；需要但缺失 ${bad.length} 个`)
    for (const r of bad) console.log(`  ❌ ${r.file}（被 ${r.importers.join(', ')} import）⇒ 必须在顶层 CLI 派发前加 isMain 守卫`)
  }
  process.exit(bad.length ? 1 : 0)
}
