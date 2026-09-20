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
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
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

// ① 行为不变
const r = spawnSync('node', ['index.js', '--selftest'], { cwd: HERE, encoding: 'utf8' })
const got = (r.stdout ?? '').trim()
if (got !== BASELINE) {
  problems.push(`① 行为变了：selftest 输出与基线不一致\n     期望:\n${BASELINE.split('\n').map((l) => '       ' + l).join('\n')}\n     实际:\n${got.split('\n').map((l) => '       ' + l).join('\n')}${r.stderr ? '\n     stderr: ' + r.stderr.slice(0, 300) : ''}`)
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
