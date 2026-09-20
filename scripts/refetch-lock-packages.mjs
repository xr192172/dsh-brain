#!/usr/bin/env node
/**
 * refetch-lock-packages.mjs —— 按 `package-lock.json` **重取指定包**（覆盖残缺副本）
 *
 * ## 为什么要它（2026-09-20 实测的两种"残缺形态"）
 *
 * `node_modules` 被清过一场，留下的不是"干净缺失"，而是**两种残缺**：
 *   ① **整个包不在**（如 `@img/colour`）⇒ `Cannot find package`
 *   ② ★ **包在、但文件不全**（如 `@img/sharp-win32-x64` **缺 `index.cjs`**）⇒
 *      `sharp` 报 `Could not load the "sharp" module using the win32-x64 runtime`
 * ② 比 ① 更难发现：**目录存在**，`ls` 看不出来，只有对着它 `package.json` 的 `files` 才看得见。
 *
 * ⇒ 而 `npm install` **可能修不了 ②**（它的判断是"目录在 + 版本对"就跳过）。
 * ⇒ 所以本脚本：**按 lock 的 resolved + integrity 重新取，直接覆盖**。**不用 npm，不动 P2。**
 *
 * ## 用法
 *   node scripts/refetch-lock-packages.mjs --list                       # 列出可重取的包
 *   node scripts/refetch-lock-packages.mjs @img/sharp-win32-x64         # 干跑
 *   node scripts/refetch-lock-packages.mjs @img/sharp-win32-x64 --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project_develop/dsh-brain'
const APPLY = process.argv.includes('--apply')
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'))

const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'))
const pkgs = lock.packages ?? {}

if (names.length === 0) {
  console.log('可重取的包（示例：任何 lock 里有 resolved+integrity 的条目）')
  console.log(`  lock 共 ${Object.keys(pkgs).length} 条`)
  console.log('\n用法：node scripts/refetch-lock-packages.mjs <pkg> [<pkg>...] [--apply]')
  process.exit(0)
}

let failed = 0
for (const name of names) {
  const key = `node_modules/${name}`
  const ent = pkgs[key]
  console.log('─'.repeat(68))
  if (!ent?.resolved || !ent?.integrity) {
    console.log(`  ✗ ${name}：lock 里没有 \`${key}\`（或缺 resolved/integrity）⇒ 跳过`)
    failed++
    continue
  }
  const dest = path.join(REPO, 'node_modules', name)
  const before = fs.existsSync(dest)
  console.log(`  ${name}@${ent.version}`)
  console.log(`    来源: ${ent.resolved}`)
  console.log(`    落点: ${path.relative(REPO, dest)}  （当前${before ? '存在' : '不存在'}）`)
  if (!APPLY) { console.log('    [dry-run] 将下载 → 校验 sha512 → 覆盖落点'); continue }

  const tmp = path.join(REPO, 'out', 'tmp-refetch')
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true })
  const tgz = path.join(tmp, 'p.tgz')
  try {
    execFileSync('curl', ['-fsSL', '--max-time', '120', '-o', tgz, ent.resolved], { stdio: 'pipe' })
  } catch (e) { console.log(`    ✗ 下载失败`); failed++; continue }
  const [algo, b64] = ent.integrity.split('-', 2)
  const actual = crypto.createHash(algo).update(fs.readFileSync(tgz)).digest('base64')
  if (actual !== b64) { console.log(`    ✗ integrity 不符 ⇒ 停`); failed++; continue }
  console.log(`    ✓ 下载 ${fs.statSync(tgz).size}B，integrity 匹配`)
  execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'pipe' })
  const inner = path.join(tmp, 'package')
  if (!fs.existsSync(path.join(inner, 'package.json'))) { console.log('    ✗ tarball 无 package/package.json'); failed++; continue }
  fs.rmSync(dest, { recursive: true, force: true })       // 覆盖残缺副本
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(inner, dest, { recursive: true })
  fs.rmSync(tmp, { recursive: true, force: true })
  // 对账：它自己声明的 files（★ 只查【字面】项 —— glob 与 `!` 排除项判不了，
  //   拿它们当"要求存在"就是假红。同一课在 audit-partial-packages.mjs 里也踩过：
  //   `dist-*/*` / `lib/*.js` 是 glob，`!x.map` 是排除项，都不是"必须存在"。）
  const pj = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'))
  const want = (Array.isArray(pj.files) ? pj.files : [])
    .filter((f) => !/[*?[\]]/.test(f) && !f.startsWith('!'))
  const missing = want.filter((f) => !fs.existsSync(path.join(dest, f)))
  const skipped = (Array.isArray(pj.files) ? pj.files.length : 0) - want.length
  console.log(`    字面 files ${want.length} 个 → 缺 ${missing.length} 个${missing.length ? '：' + missing.join(',') : ' ✓'}` +
    (skipped ? `（跳过 ${skipped} 个 glob/排除项）` : ''))
  if (missing.length) failed++
}

console.log('─'.repeat(68))
console.log(APPLY ? (failed ? `★ 有 ${failed} 个未达标` : '✓ 全部就位') : '（dry-run）')
process.exit(failed && APPLY ? 1 : 0)
