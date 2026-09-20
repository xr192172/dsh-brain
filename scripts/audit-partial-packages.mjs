#!/usr/bin/env node
/**
 * audit-partial-packages.mjs —— **只读**扫描：`node_modules` 里有没有"在但不完整"的包
 *
 * ## 为什么需要（2026-09-20 实测教训）
 *
 * 依赖被清过一场后，留下的不只是"干净缺失"，还有**更难发现的第二种**：
 * 包目录在、`ls` 看不出问题，但**它自己声明的文件不全**。
 * 实例：`@img/sharp-win32-x64` **缺 `index.cjs`** ⇒ `sharp` 报
 * `Could not load the "sharp" module using the win32-x64 runtime`。
 *
 * ⇒ 靠"被绊一次修一次"太慢（今天已经绊了三次：`@deepseek-ai` → `@img/colour` → `sharp` 平台包）。
 * ⇒ 本脚本**一次全树扫**，把这些提前找出来。
 *
 * ## 判据（对着包**自己声明的** `files` / `main` / `exports`，不猜）
 *
 * 1. lock 里有、而 `node_modules` 下**完全没有** ⇒ 缺失
 * 2. 目录在，但 `package.json` 的 `files` 数组里**有文件/目录不存在** ⇒ **残缺**
 * 3. 目录在，且 `main` 指向的文件不存在 ⇒ 残缺
 *
 * ⚠️ **跨平台包会误报**：lock 含 darwin/linux 等平台的 optional 包，本机本就不装 ⇒
 * 那类**只报"缺失"、不算错**（用 `[optional]` 标注区分）。
 *
 * 用法：node scripts/audit-partial-packages.mjs [--top 20]
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'D:/project_develop/dsh-brain'
const NM = path.join(REPO, 'node_modules')
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'))
const pkgs = lock.packages ?? {}

const limit = (() => { const i = process.argv.indexOf('--top'); return i >= 0 ? Number(process.argv[i + 1]) || 20 : 20 })()

const missing = []   // lock 有、目录无
const partial = []   // 目录在、入口不可用（**真残缺**）
const badMain = []   // main 解析后不存在（**真残缺**）
const declaredButAbsent = []   // files 声明但不在（★ **仅供参考，不算错** —— 见下方说明）

for (const [key, ent] of Object.entries(pkgs)) {
  if (!key.startsWith('node_modules/')) continue
  if (key.split('node_modules/').length - 1 > 1) continue   // 跳过嵌套的
  const name = key.slice('node_modules/'.length)
  if (name.split('/').length > 2) continue                  // 只查顶层 + @scope/name
  const dir = path.join(NM, name)
  const pjPath = path.join(dir, 'package.json')

  if (!fs.existsSync(pjPath)) { missing.push({ name, optional: !!ent.optional }); continue }

  let pj
  try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')) } catch { partial.push({ name, why: 'package.json 解不开' }); continue }

  // ★★ 关于 `files`：**它不是"必须都在"的清单，而是"打包白名单"**。
  //   它**允许包含从未存在**的条目（上游改了目录结构却没更新 files —— 实测 `semver`
  //   声明 `lib/` 而实际是 `classes/`+`functions/`+`ranges/`，`import('semver')` 完全正常）。
  //   ⇒ **"声明了但不在" ≠ "残缺"**。所以这一项**只作参考、不计入"残缺"**，
  //     真正的判据是下面的 ③（入口能不能解析）与"真 import 一次"。
  const want = (Array.isArray(pj.files) ? pj.files : [])
    .filter((f) => !/[*?[\]]/.test(f) && !f.startsWith('!'))
  const gone = want.filter((f) => !fs.existsSync(path.join(dir, f)))
  if (gone.length) declaredButAbsent.push({ name, why: `files 声明但不在：${gone.slice(0, 4).join(', ')}` })

  // ★ main 不带扩展名时 Node 会补 ⇒ 逐候选判，别拿字面量当路径
  if (typeof pj.main === 'string' && pj.main) {
    const cands = [pj.main, `${pj.main}.js`, `${pj.main}.json`, `${pj.main}.cjs`, `${pj.main}.mjs`,
      path.join(pj.main, 'index.js'), path.join(pj.main, 'index.json')]
    if (!cands.some((c) => fs.existsSync(path.join(dir, c)))) {
      badMain.push({ name, why: `main="${pj.main}" 各候选扩展名均不存在` })
    }
  }
}

console.log('依赖完整性扫描（只读）')
console.log('─'.repeat(72))
console.log(`lock 顶层条目: ${Object.keys(pkgs).filter((k) => k.startsWith('node_modules/')).length}`)
console.log(`  ① 目录缺失: ${missing.length}（其中 [optional] ${missing.filter((m) => m.optional).length} 个 —— 跨平台包本就不装，不算错）`)
console.log(`  ② ★ 真残缺（入口不可用）: ${partial.length + badMain.length}`)
console.log(`  ③ files 声明但不在: ${declaredButAbsent.length}  ← **仅供参考，不算错**（files 是打包白名单，见脚本头）`)

const show = (title, arr) => {
  if (!arr.length) return
  console.log('\n' + title)
  for (const x of arr.slice(0, limit)) console.log(`  · ${x.name}${x.optional ? ' [optional]' : ''}  ${x.why ?? ''}`)
  if (arr.length > limit) console.log(`  …另有 ${arr.length - limit} 个`)
}
show('★ ② 真残缺（要修的就是这些）', [...partial, ...badMain])
show('③ files 声明但不在（参考；多为上游遗留声明，不代表坏）', declaredButAbsent)
show('① 缺失（非 optional 的要留意）', missing.filter((m) => !m.optional))

console.log('')
console.log(partial.length || badMain.length
  ? `⇒ ${partial.length + badMain.length} 个入口不可用。可用：node scripts/refetch-lock-packages.mjs <pkg> --apply`
  : '⇒ ✓ 没有发现「入口不可用」的包（注：③ 那类不算错）')
