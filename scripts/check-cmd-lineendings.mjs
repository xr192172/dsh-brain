// check-cmd-lineendings.mjs —— `.cmd`/`.bat` **必须是 CRLF**。
//
// ★ 为什么单独立一条判据（2026-09-26 实测踩到）：
//   `scripts/dsh-up.cmd` 一直是 **LF-only**（0 个 CRLF / 66 个 LF）⇒
//   **cmd.exe 会把行切错、把 `rem` 前缀吃掉**，于是把注释里的英文单词当成命令执行：
//       输入 `icon`、`-click`、`equired`、`witchboard.cmd).` → "'icon' 不是内部或外部命令"
//   ★ 这不只是刷屏：它会**真的执行**被切出来的片段（实测出现过 `输入新时间:` 的 TIME 提示），
//     且 `%ERRORLEVEL%` 被搅乱 ⇒ 启动器**报成功/失败都不可信**。
//   ★ 这个 bug **不是新引入的**：`git show HEAD:scripts/dsh-up.cmd` 同样炸。
//     它一直藏着，因为**双击时的窗口一闪而过**，没人看输出。
//
// ⇒ 判据 A：仓库里所有 `.cmd`/`.bat` 的**纯 LF 行数必须为 0**（即全部 CRLF 结尾）。
//   消融自证：把任一 `.cmd` 改回 LF ⇒ 本条必红。
//
// ★★★ 判据 B（2026-09-26 补，同一个病根的另一半）：**.cmd/.bat 里不许有非 ASCII 字节**。
//   已实测（`node out/_repeat.mjs 25`）：`scripts/dsh-up.cmd` 在
//   **同一通道、同一参数、同一路径**下 25 次里有 **1 次**输出
//       The system cannot find the path specified.
//       'll-desktop-icon.mjs' is not recognized as an internal or external command,
//   ⇒ 是**间歇**复现（≈4%），不是确定性解析错误。间歇性说明它是**竞态/编码**类，
//   而不是"某一行写错了"。
//   机制：文件顶部的 `chcp 65001` **在 cmd.exe 读完文件之后才生效** ——
//   cmd.exe 是按**当前 OEM 代码页**流式读取并切分命令的，遇到非 ASCII 字节
//   （`★`/`⇒`/中文）时字节边界可能落错位置 ⇒ 把相邻的 ASCII 片段（`ll-desktop-icon.mjs`）
//   切出来当命令执行。
//   ★ 这就是为什么"窗口一闪而过"时永远发现不了：它只错 4%，而双击的人根本看不到输出。
//   ⇒ 纪律：**`.cmd` 里只有 ASCII**；要写中文说明就写进同目录的 `.md`，或用 `rem` 引用它的路径。
//   （仓库里 `relaunch-switchboard.cmd` 的注释写明 "ASCII-only on purpose"，正是这条。）
//
//   消融自证：往任一 `.cmd` 里塞一个 `★` ⇒ 判据 B 必红。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.argv[2] ?? '.'
const SKIP = new Set(['node_modules', '.git', 'out', 'lib', 'dist', '.workbuddy'])
const offenders = []
const nonAscii = []
let scanned = 0

function walk(dir, depth) {
  if (depth > 5) return
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { walk(p, depth + 1); continue }
    if (!/\.(cmd|bat)$/i.test(e.name)) continue
    const buf = readFileSync(p)
    const t = buf.toString('utf8')
    const crlf = (t.match(/\r\n/g) || []).length
    const lf = (t.match(/\n/g) || []).length
    const pureLf = lf - crlf
    scanned++
    const rel = relative(ROOT, p).replace(/\\/g, '/')
    if (pureLf > 0) offenders.push({ rel, pureLf, crlf })
    // 判据 B：非 ASCII 字节（>0x7F）一个都不许有
    const bad = buf.filter((b) => b > 0x7f)
    if (bad.length > 0) {
      // 找出第一处非 ASCII 所在的行号，方便定位
      let line = 1
      let seen = 0
      for (const b of buf) {
        if (b === 0x0a) line++
        if (b > 0x7f) { seen++; if (seen === 1) break }
      }
      nonAscii.push({ rel, count: bad.length, firstLine: line, sample: t.split(/\r?\n/)[line - 1]?.slice(0, 70) ?? '' })
    }
  }
}

walk(ROOT, 0)

let failed = false
console.log(`\n.cmd/.bat 体检 —— 扫了 ${scanned} 个文件（判据 A：必须 CRLF；判据 B：必须纯 ASCII）\n`)

if (offenders.length === 0) {
  console.log('  ok   [A] 全部 CRLF ✓')
} else {
  failed = true
  console.log(`  ★★★ [A] ${offenders.length} 个文件是 LF-only（cmd.exe 会切错行、把 rem 吃掉、执行注释片段）：\n`)
  for (const o of offenders) console.log(`      ${o.rel}  纯LF=${o.pureLf}  CRLF=${o.crlf}`)
  console.log('\n  修法：把行尾转成 CRLF（不是加 BOM！.cmd 不要 BOM）。')
}

if (nonAscii.length === 0) {
  console.log('  ok   [B] 全部纯 ASCII ✓')
} else {
  failed = true
  console.log(`\n  ★★★ [B] ${nonAscii.length} 个文件含非 ASCII 字节（chcp 晚于读取 ⇒ 偶发切错行）：\n`)
  for (const o of nonAscii) {
    console.log(`      ${o.rel}  非ASCII字节=${o.count}  首处约在第 ${o.firstLine} 行`)
    console.log(`          ${JSON.stringify(o.sample)}`)
  }
  console.log('\n  修法：把注释里的非 ASCII 全部改成 ASCII；需要中文说明就另写一个 .md。')
  console.log('  ★ 只加 chcp 65001 是**不够的** —— 它生效时 cmd.exe 已经把文件读完了。')
}

console.log('')
process.exit(failed ? 1 : 0)

