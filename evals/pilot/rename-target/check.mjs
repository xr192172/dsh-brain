#!/usr/bin/env node
/**
 * cli-0005 的 oracle —— **全机验、真跑不读源码意图**（规格见 ./README.md）。
 *
 * ① 行为不变：`node index.js --selftest` 的输出必须**逐字**等于基线（基线里只有数据，不含任何符号名）；
 * ② 已改名：`digestOf` 必须出现在 math.js 的导出、store.js / index.js 的导入与调用里；
 * ③ 旧名**标识符**零残留：把字符串字面量剥掉后再查 `\bcomputeHash\b` ——
 *    唯一允许的残留是 math.js 里 `legacyAlias()` 的那个**局部变量**（它本来就叫这个，不许跟着改）；
 *    ★ 注释里的名字也会被这条抓到（注释不是字符串）⇒ "注释要跟改"自动成立；
 * ④ 字符串常量 `'computeHash-v1'` 必须**原样保留**（它被当作持久化命名空间，改了会让旧数据失效）。
 *
 * 退出码：0 = 通过；1 = 失败（并打印每条判据的读数）。
 *
 * 用法：node evals/pilot/rename-target/check.mjs                  # 判判据根那一份（不带参数时与改动前逐字相同）
 *       node evals/pilot/rename-target/check.mjs --repo <被测工作树>   # ★ 判**指定那棵树**里的靶文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/**
 * ── ★★ 格 ⑩（O117）：oracle 必须能指向**被测的那棵树** ──────────────────────
 *
 * **原来的问题**：`HERE = 自身所在目录` ⇒ **硬编码判据根那一份** `math.js/store.js/index.js`
 *   ⇒ 无论隔离工作树里有什么，它只判判据根 ⇒ **把靶文件搬进 wt 也没用**。
 *
 * **现在的优先级**：`--repo` ＞ `DSH_EVAL_REPO` ＞ **自身相对路径**（= 判据根，**逐字回退，行为不变**）。
 *   `--repo` / `DSH_EVAL_REPO` 给的是**仓库根**（与 `eval-validate.mjs --repo` 同口径），
 *   靶目录 = `<repo>/evals/pilot/rename-target`。不给参数时 `HERE` 与改动前**逐字相同**。
 * ★ 靶文件不在指定树里 ⇒ **大声报错并非零退出**（判不了就是不合格，不是通过）。
 */
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url))
function resolveRepoArgv() {
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--repo') return { repo: a[i + 1] ?? null, src: '--repo' }
    if (a[i].startsWith('--repo=')) return { repo: a[i].slice('--repo='.length), src: '--repo=' }
  }
  if (process.env.DSH_EVAL_REPO) return { repo: process.env.DSH_EVAL_REPO, src: 'DSH_EVAL_REPO（环境变量）' }
  return { repo: path.resolve(HERE_DIR, '../../..'), src: '自身相对路径（默认 = 判据根；与改动前逐字相同）' }
}
const _resolved = resolveRepoArgv()
const REPO = path.resolve(_resolved.repo ?? '')
const HERE = path.join(REPO, 'evals', 'pilot', 'rename-target')

console.log(`cli-0005 oracle —— REPO = ${REPO.replace(/\\/g, '/')}`)
console.log(`  来源：${_resolved.src}`)
console.log(`  靶目录：${HERE.replace(/\\/g, '/')}`)
const _missing = ['math.js', 'store.js', 'index.js'].filter((f) => !fs.existsSync(path.join(HERE, f)))
if (_missing.length) {
  console.log('')
  console.log(`cli-0005 oracle：**不合格** —— 指定树里缺靶文件 ${_missing.join(', ')}（目录 ${HERE.replace(/\\/g, '/')}）⇒ 判不了（判不了 ≠ 通过）`)
  process.exit(1)
}

const OLD = 'computeHash'
const NEW = 'digestOf'
const NS = "'computeHash-v1'"
const BASELINE = ['h=1a47e90b', 'd=computeHash-v1/1a47e90b', 'put/get=one@computeHash-v1', 'size=1', 'legacy=legacy:computeHash-v1'].join('\n')

const problems = []
const ok = []
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
/** 剥掉字符串字面量与模板串（保留长度无关，只去内容） */
const stripStrings = (s) => s.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``')
const countIdent = (s, id) => (stripStrings(s).match(new RegExp(`\\b${id}\\b`, 'g')) ?? []).length

// ① 行为不变（★ 用 **in-process 调用**，不起子进程、不用管道 stdio ——
//    否则在 workspace-write 沙箱里会被 EPERM 拦，做题的 agent 就跑不动这个 oracle，只能去申请提权 ⇒ 卡死）
const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href)
const got = mod.selftestLines().join('\n').trim()
if (got !== BASELINE) {
  problems.push(`① 行为变了：selftest 输出与基线不一致\n     期望:\n${BASELINE.split('\n').map((l) => '       ' + l).join('\n')}\n     实际:\n${got.split('\n').map((l) => '       ' + l).join('\n')}`)
} else ok.push('① 行为不变（selftest 输出逐字等于基线）')

// ② 已改名
const math = read('math.js')
const store = read('store.js')
const index = read('index.js')
const checks2 = [
  ['math.js 导出新名', /export\s+function\s+digestOf\s*\(/.test(math)],
  ['store.js 导入并调用新名', new RegExp(`import\\s*\\{[^}]*\\b${NEW}\\b`).test(store) && countIdent(store, NEW) >= 2],
  ['index.js 导入并调用新名', new RegExp(`import\\s*\\{[^}]*\\b${NEW}\\b`).test(index) && countIdent(index, NEW) >= 2],
]
for (const [name, pass] of checks2) {
  if (pass) ok.push(`② ${name}`)
  else problems.push(`② 未完成：${name}`)
}

// ③ 旧名标识符的**去处**必须精确（★ 这一条 2026-09-20 修过一次：
//    原先写"math.js 里旧名必须只剩 1 处"，但**同名局部变量的声明与其使用处共 2 处**，
//    且描述该局部变量的注释**本来就该保持原样** ⇒ 那条判据是**假红**。现在改成逐项断言，不留歧义。
const cStore = countIdent(store, OLD)
const cIndex = countIdent(index, OLD)
const keepLocalDecl = /const\s+computeHash\s*=\s*'legacy'/.test(math)
const keepLocalUse = /return\s+computeHash\s*\+/.test(math)
const headerUpdated = /^\/\/[^\n]*`digestOf`/.test(math) && !/^\/\/[^\n]*`computeHash`/.test(math)
const problems3 = []
if (cStore !== 0) problems3.push(`store.js 仍有旧名标识符 ${cStore} 处（期望 0 —— 注释也要跟改）`)
if (cIndex !== 0) problems3.push(`index.js 仍有旧名标识符 ${cIndex} 处（期望 0 —— 注释也要跟改）`)
if (!keepLocalDecl || !keepLocalUse) problems3.push('math.js 里 legacyAlias 的**同名局部变量**被改掉了（它必须原样保留）')
if (!headerUpdated) problems3.push('math.js 文件头注释没跟改（应把 `computeHash` 改成 `digestOf`）')
if (problems3.length) for (const p of problems3) problems.push(`③ ${p}`)
else ok.push('③ 旧名的去处精确：另两文件零残留、同名局部变量保留、文件头注释已跟改')

// ④ 字符串常量必须原样保留
if (math.includes(`KEY_NAMESPACE = ${NS}`)) ok.push('④ 字符串常量 computeHash-v1 原样保留')
else problems.push(`④ 字符串常量被改了：KEY_NAMESPACE 必须仍是 ${NS}（它是持久化命名空间，改了旧数据就失效）`)

// 结果
for (const l of ok) console.log('  ✓ ' + l)
for (const l of problems) console.log('  ✗ ' + l)
console.log('')
if (problems.length) {
  console.log(`cli-0005 oracle：**不合格**（${problems.length} 条不过）`)
  process.exit(1)
}
console.log('cli-0005 oracle：**全部通过**（4 条判据）')
process.exit(0)
