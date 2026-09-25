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
  // 谁被 import 了？（只看 scripts/ 内部。★ 排除"自己 import 自己"那种注释/字符串误命中）
  const imported = new Map()
  for (const [f, s] of src) {
    for (const m of s.matchAll(/from\s+['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) {
      const target = path.resolve(path.dirname(f), m[1])
      if (!src.has(target) || target === f) continue
      const key = path.basename(target)
      if (!imported.has(key)) imported.set(key, [])
      imported.get(key).push(path.relative(SCRIPTS, f))
    }
  }
  const rows = []
  for (const [f, s] of src) {
    const base = path.basename(f)
    const importers = imported.get(base) ?? []
    if (importers.length === 0) continue
    // ★★ 2026-09-25 修（我第一版是**坏的尺子**）：判"顶层派发"必须**锚定行首** ——
    //   第一版用 `/process\.exit\(|process\.argv/` 全文匹配 ⇒ 文件里**提到**它（注释/函数体）就算
    //   ⇒ 报出 2 个**假阳性**（实测：那两个文件顶层派发行是 **0**）。
    const topLevelCli = /^(?:process\.exit\(|const argv = process\.argv|if \(argv\.includes\()/m.test(s)
    if (!topLevelCli) continue
    // ★★ 判"有守卫"必须认**真正的谓词**，不能只查字符串 `isMain` ——
    //   第一版只查 `s.includes('isMain')` ⇒ 我把 const 那行删掉、"if (isMain) {" 还在 ⇒ 仍算"有"
    //   ⇒ **消融永远翻不动**（实测消融 FAIL）。
    const hasGuard = /path\.resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)/.test(s)
    rows.push({ file: path.relative(SCRIPTS, f).replace(/\\/g, '/'), importers, hasGuard })
  }
  // 阳性计数：整个 scripts/ 里有多少文件带**真正的守卫谓词**
  const guarded = [...src.values()].filter((s) => /path\.resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)/.test(s)).length
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
    // ★★ 消融要撤**真正的谓词**（撤掉后 `hasGuard` 必须变 false）——
    //   我第一版撤的是 `const isMain = …` 那行，而 `if (isMain) {` 还在 ⇒ 字符串判定仍算"有" ⇒ **消融翻不动**。
    const PRED = /path\.resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)/
    const PRED_G = new RegExp(PRED.source, 'g') // ★ 用 /g 版本做替换：谓词在文件里可能**出现不止一次**
    const nHits = (bak.match(PRED_G) ?? []).length
    console.log(`  （skill-sieve 里守卫谓词出现 ${nHits} 次）`)
    if (!PRED.test(bak)) {
      console.log('  ★ 消融锚点失配：skill-sieve 里找不到守卫谓词 —— 必须重写这条消融')
    } else {
      fs.writeFileSync(target, bak.replace(PRED_G, 'true /* ABLATED */'), 'utf8')
      const out = (spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 60000 }).stdout ?? '')
      // ★★ 断言要认**报告路径真正打的字**：报告打 `❌ <file>（被 … import）`，
      //   而 `FAIL` 只出现在本自测自己的行里 ⇒ 我第一版断言 `FAIL skill-sieve.mjs` ⇒
      //   **永远匹配不上 = 假消融**（手工复现才看出来：机制其实是好的）。
      ablOk = /(❌|FAIL)\s+skill-sieve\.mjs/.test(out)
      console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 撤掉 skill-sieve 的守卫谓词 ⇒ 它被报 FAIL ${ablOk ? '✓' : '（没报 ⇒ 这条判据没接线）'}`)
    }
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
