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

/**
 * ★★★ 2026-09-27（R5）新增：**按结构**判"顶层有没有 CLI 派发"。
 *
 * 为什么不能只看缩进（我在这上面先假绿后假红各一次，见 `scan()` 里的长注释）：
 *   · 只看"行首无缩进"   ⇒ 漏掉被合法包进 `if (isMain) { … }` 的派发（**假绿**）；
 *   · 只看"任意缩进"     ⇒ 把**函数体内**的 `process.exit(1)` 当成派发（**假红**，实证 `patch-anchors.mjs`）。
 *   ⇒ 缩进本身不带"我在哪个块里"的信息 ⇒ 必须**按块结构**判。
 *
 * 做法（足够简单且可复核 —— 不写完整 JS 解析器）：
 *   逐行扫，维护一个"当前是否处在 `if (isMain…) {` 块内"的标志（按花括号配对退出）。
 *   派发行（`process.exit(` / `const argv = process.argv` / `if (argv.includes(`）若满足：
 *     (a) 该行缩进为 0（真·顶层裸派发），或
 *     (b) 当前处在 `if (isMain…) {` 块内，
 *   则算"顶层 CLI 派发"。函数体内（缩进 ≥2 且不在 isMain 块）的派发**不算**。
 *
 * @param {string} src 文件全文
 * @returns {boolean}
 */
export function hasTopLevelCliDispatch(src) {
  const lines = src.split('\n')
  const DISPATCH = /(?:process\.exit\(|const argv = process\.argv|if \(argv\.includes\()/
  // 注释行不参与（但注释行里的花括号也要跳过，免得把配对算乱）
  const isComment = (l) => /^[ \t]*(?:\/\/|\*|\/\*)/.test(l)
  let inIsMain = false
  let depth = 0 // isMain 块内的花括号深度（>0 表示还在块里）
  for (const raw of lines) {
    const l = raw.replace(/\r$/, '')
    if (isComment(l)) continue
    const indent = (l.match(/^[ \t]*/) ?? [''])[0].length
    if (!inIsMain) {
      // 进入 `if (isMain ...) {` 块？
      if (/^if \(isMain[^\n]*\{\s*$/.test(l)) {
        inIsMain = true
        depth = 1
        continue
      }
      // 真·顶层裸派发（缩进 0）
      if (indent === 0 && DISPATCH.test(l)) return true
    } else {
      // 在 isMain 块内：先记账花括号，再判派发
      for (const ch of l) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      if (DISPATCH.test(l)) return true
      if (depth <= 0) { inIsMain = false; depth = 0 }
    }
  }
  return false
}

/**
 * ★★★ 2026-09-27（R5）新增：判"这个文件有没有**真正的** isMain 守卫谓词"。
 *
 * 为什么单独成函数：原先同一个正则**抄了两遍**（`scan()` 里判每个文件 + `guarded` 阳性计数里），
 *   我一改就会漂移（本仓库的老毛病：两套算法各写一遍）。
 *
 * ★ 为什么要"按结构"而不是"逐字"：实测**三种等价写法**都在用，逐字正则只认第一种 ⇒ 另两种**假红**：
 *   ① `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`   ← 原判据只认这个
 *   ② `path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))`  ← `change-classify.mjs:502`
 *   ③ 换行写：`const isMain =\n  process.argv[1] && path.resolve(…) === path.resolve(fileURLToPath(…))`
 *      ← `gate-impl-reference.mjs:495`
 *
 * ★ 但要**保持能消融**（这是原判据的硬要求：`selftest` 会撤掉谓词看是否翻红）：
 *   所以判据必须是"**同时**出现 `process.argv[1]`、`fileURLToPath(import.meta.url)` 与 `===` 比较"，
 *   而不是"含 `isMain` 这个词"（后者撤掉判定式、只剩 `if (isMain) {` 时仍会算"有" ⇒ 消融翻不动）。
 *   ⇒ 做法：把注释剥掉、把 `import.meta.url` 那一层多余的 `path.resolve(` **归一化掉**（可嵌套），
 *     再在**同一行**（把多行赋值合成一行后）里找"`process.argv[1]` … `===` … `fileURLToPath(import.meta.url)`"。
 *
 * @param {string} s 文件全文
 * @returns {boolean}
 */
export function hasIsMainGuard(s) {
  // ① 剥注释行（避免注释里的示例被当成真守卫）
  let t = s
    .split('\n')
    .filter((l) => !/^[ \t]*(?:\/\/|\*|\/\*)/.test(l))
    .join('\n')
  // ② 把 `path.resolve(fileURLToPath(import.meta.url))` 归一成 `fileURLToPath(import.meta.url)`
  //    （允许任意层数的 path.resolve 包裹 —— 写法变体②③）
  t = t.replace(/path\.resolve\(\s*fileURLToPath\(import\.meta\.url\)\s*\)/g, 'fileURLToPath(import.meta.url)')
  // ③ 把 `const isMain =\n …` 这种**跨行赋值**合成一行（写法变体③）：
  //    统一把换行+缩进折成单个空格（这会让"同一行"判据对多行写法也成立）。
  const flat = t.replace(/\n[ \t]*/g, ' ')
  // ④ 真谓词：必须在 **同一个表达式** 里同时出现三件事
  return /process\.argv\[1\][^]{0,200}?===[^]{0,200}?fileURLToPath\(import\.meta\.url\)/.test(flat)
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
    //
    // ★★★ 2026-09-27 再修（R5）—— 我在这里**先制造了一次假绿、又制造了一次假红**，两次都记下：
    //
    //   **假绿**：原判据 `^(?:process\.exit\(|…)` 要求**行首**。但当 CLI 派发被**合法地**包进
    //     `if (isMain) { … }` 时，这些行都缩进了 ⇒ 行首不匹配 ⇒ 判"顶层没有派发" ⇒ **跳过该文件**
    //     ⇒ 风险被漏掉。实证：R5 给 `arm-up.mjs` 加守卫并把主流程缩进后，它**从被检列表消失**了
    //     —— 而它恰恰是最需要守卫的那类（`arm-ports.mjs:4` / `arm-stop.mjs:14` 的注释逐字在抱怨）。
    //
    //   **假红**：我把判据放松成"任意缩进"⇒ 立刻把 `patch-anchors.mjs` 报成违规 ——
    //     但它的 `process.exit(1)` 在 **`reportAndExit()` 函数体内部**，顶层只定义导出
    //     （实测：`grep '^export'` 只有 STRICT/applyAnchors/reportAndExit）⇒ **它 import-safe，是我误报**。
    //     ⇒ 缩进**无法**区分"函数体内的派发"与"`if (isMain)` 块内的派发"。
    //
    //   ★ 正确判据：**按结构** —— 只看两类行：
    //     (a) **缩进 0 的行**里出现派发语句（真·顶层裸派发）；或
    //     (b) 落在 **`if (isMain …) {` 块**（缩进 0，按花括号配对到块尾）内的派发语句。
    //     函数体内（缩进 ≥2、且在非 `isMain` 块中）的派发**不算**。
    const topLevelCli = hasTopLevelCliDispatch(s)
    if (!topLevelCli) continue
    // ★★ 判"有守卫"必须认**真正的谓词**，不能只查字符串 `isMain` ——
    //   第一版只查 `s.includes('isMain')` ⇒ 我把 const 那行删掉、"if (isMain) {" 还在 ⇒ 仍算"有"
    //   ⇒ **消融永远翻不动**（实测消融 FAIL）。
    const hasGuard = hasIsMainGuard(s)
    rows.push({ file: path.relative(SCRIPTS, f).replace(/\\/g, '/'), importers, hasGuard })
  }
  // 阳性计数：整个 scripts/ 里有多少文件带**真正的守卫谓词**
  const guarded = [...src.values()].filter((s) => hasIsMainGuard(s)).length
  return { rows, total: src.size, guarded, importedCount: imported.size }
}

function selftest() {
  const { rows, total, guarded, importedCount } = scan()
  const bad = rows.filter((r) => !r.hasGuard)
  console.log(`脚本总数 ${total}；被 scripts/ 内部 import 的 ${importedCount} 个；带 isMain 守卫的 ${guarded} 个`)
  console.log('★ 需要守卫的文件（被 import 且顶层有 CLI 迹象）：')
  for (const r of rows) console.log(`  ${r.hasGuard ? 'ok  ' : 'FAIL'} ${r.file}  ← 被 ${r.importers.join(', ')} import`)
  // ★★ 阳性对照：这条判据必须**真的在检查东西**（有被 import 且有 CLI 迹象的文件）
  const notVacuous = rows.length > 0
  if (!notVacuous) console.log('  ★★ 判据可能空转：没有任何"被 import 且顶层有 CLI"的文件 ⇒ 这条守卫此刻无法证明什么')
  // ★★★ 2026-09-27（R5）加：**已知阳性对照必须在列表里** ——
  //   `arm-up.mjs` 是"被 import + 有 CLI 派发"的**教科书样本**（`arm-ports.mjs:4` 的注释逐字在说它）
  //   ⇒ 它**必须**出现在 `rows` 里。这条对照专治我刚发现的假绿：
  //     判据若又把"缩进进 `if (isMain)`"的派发漏掉 ⇒ `arm-up.mjs` 会消失 ⇒ 本对照**变红**。
  const mustCheck = ['arm-up.mjs']
  const missing = mustCheck.filter((n) => !rows.some((r) => r.file === n))
  const controlOk = missing.length === 0
  console.log(`  阳性对照：${mustCheck.join(', ')} 必须在被检列表里 ${controlOk ? '✓' : `✗ 缺 ${missing.join(',')}`}`)
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
  const pass = bad.length === 0 && notVacuous && controlOk && ablOk
  console.log(`\n结果：违规 ${bad.length} 个；判据非空转=${notVacuous}；阳性对照=${controlOk}；消融 ${ablOk ? '通过' : '未通过'} ⇒ ${pass ? 'PASS' : 'FAIL'}`)
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
