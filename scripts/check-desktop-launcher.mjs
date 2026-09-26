#!/usr/bin/env node
/**
 * check-desktop-launcher.mjs —— ★★★ 桌面那份启动器，**必须与仓库源文件逐字一致**。
 *
 * ## 为什么必须单独立一道门（2026-09-26 真事故）
 *
 * 用户双击桌面那个图标，回来贴了一屏：
 *     '-click' 不是内部或外部命令，也不是可运行的程序
 *     'icon' 不是内部或外部命令
 *     'equired' …  'witchboard.cmd).' …  '-' …  '-25' …
 *     系统无法接受输入的时间。输入新时间:
 *
 * **病因**：`scripts/dsh-up.cmd` 我修好了（纯 ASCII + 全 CRLF，0/0），
 * 但桌面那份 `DSH 启动 (双击).cmd` **从来没有被重新生成过**
 * （实测指纹：非 ASCII **243** + 纯 LF **66**，与源文件的 0/0 完全脱节）。
 * 而**用户双击的恰恰是桌面那份** —— 源文件修得再干净，他碰到的还是旧的。
 *
 * ## 为什么现有的门全都抓不到它
 *
 * `scripts/check-cmd-lineendings.mjs` 只扫**仓库内**的 `.cmd`/`.bat`，
 * 桌面在 `C:\Users\<user>\Desktop\` ⇒ **不在扫描范围**。
 * ⇒ 于是出现了最坏的形状：**被检查的都干净，用户碰的那个没人管**。
 *
 * ## 本门的判据（★ 用指纹，不用名字 —— 铁律 18）
 *
 * 不从"文件叫什么/存不存在"下结论，而是**重算**桌面那份应该是什么：
 *   期望内容 = 源文件 + `rem DSH-ONE-CLICK-LAUNCHER` 标记行 + `DSH_REPO_OVERRIDE` 填成绝对路径
 * 然后与桌面那份做**逐字节比较**。不一致 ⇒ 红。
 *
 * 另外独立查桌面那份自身的两条硬性质（判据 A/B 的镜像）：
 *   · 纯 LF 行数必须为 0（否则 cmd.exe 吃掉 rem 前缀、执行注释碎片）
 *   · 非 ASCII 字节必须为 0（否则按 OEM 码页切错行）
 *
 * ## 三态（★ 铁律 33：不确定要显式记，不许当通过、也不许当失败）
 *
 *   PASS   —— 在且逐字一致
 *   STALE  —— 在但不一致 ⇒ **红**（就是本次事故的形状）
 *   SKIP   —— 桌面不存在（换了机器/用户删了）⇒ 显式记 `skip`，**不当"通过"**
 *
 * 用法：
 *   node scripts/check-desktop-launcher.mjs
 *   node scripts/check-desktop-launcher.mjs --json
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')          // ★ 本脚本所在的仓库 = 装出桌面那份的那个仓库
const SRC = path.join(HERE, 'dsh-up.cmd')
const FILENAME = 'DSH 启动 (双击).cmd'
const FLAG = 'DSH-ONE-CLICK-LAUNCHER'
const AS_JSON = process.argv.includes('--json')

/** 桌面目录（与 install-desktop-icon.mjs 保持同一套候选，兼容 OneDrive 重定向）。 */
function desktopDirs() {
  const home = os.homedir()
  return [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive - Personal', 'Desktop'),
  ].filter((d) => fs.existsSync(d))
}

function fp(p) {
  const b = fs.readFileSync(p)
  const t = b.toString('utf8')
  const crlf = (t.match(/\r\n/g) || []).length
  const lf = (t.match(/\n/g) || []).length
  return { bytes: b.length, nonAscii: b.filter((x) => x > 0x7f).length, pureLf: lf - crlf, text: t }
}

/**
 * ★ 重算"桌面那份应该长什么样"。
 *   ⚠️ 这里必须与 `install-desktop-icon.mjs` 的变换**逐字同构**，
 *     否则本门会因为"我算的期望与安装器写的不一样"而恒红（假红）。
 *     ⇒ 两处都改的时候必须一起改；下面有一步"安装器与本源一致"的自检注释。
 */
function expectedDesktopText(sourceText, repoAbs) {
  let s = sourceText.includes(FLAG) ? sourceText : sourceText.replace('@echo off', `@echo off\r\nrem ${FLAG}`)
  s = s.replace(/^set "DSH_REPO_OVERRIDE=[^"\r\n]*"$/m, `set "DSH_REPO_OVERRIDE=${repoAbs}"`)
  return s
}

const results = []

// ---- 前置：源文件自己得是干净的（否则"一致"毫无意义）----
if (!fs.existsSync(SRC)) {
  results.push({ state: 'FAIL', what: 'find-source', msg: `找不到源文件 ${SRC}` })
}
const src = fs.existsSync(SRC) ? fp(SRC) : null

const dirs = desktopDirs()
if (dirs.length === 0) {
  results.push({ state: 'SKIP', what: 'desktop-dir', msg: '找不到任何桌面目录（Desktop / OneDrive\\Desktop）' })
}

for (const d of dirs) {
  const target = path.join(d, FILENAME)
  if (!fs.existsSync(target)) {
    results.push({ state: 'SKIP', what: target, msg: '桌面没有这个文件（用户可能删了，或这台机器不装桌面图标）' })
    continue
  }

  const got = fp(target)

  // ① 桌面那份自身的两条硬性质
  const prob = []
  if (got.pureLf > 0) prob.push(`纯LF=${got.pureLf}（必须 0）`)
  if (got.nonAscii > 0) prob.push(`非ASCII=${got.nonAscii}（必须 0）`)

  // ② 逐字节比对（用指纹重算，不看名字）
  let exact = null
  if (src) {
    const want = expectedDesktopText(src.text, REPO)
    exact = want === got.text
    if (!exact) {
      // 给出**可读的差异诊断**，而不是只抛一个 false
      const wl = want.split('\r\n')
      const gl = got.text.split(/\r\n|\n/)
      let firstDiff = -1
      for (let i = 0; i < Math.max(wl.length, gl.length); i++) {
        if (wl[i] !== gl[i]) { firstDiff = i; break }
      }
      const absLine = /^set "DSH_REPO_OVERRIDE=([^"]*)"/m.exec(got.text)
      results.push({
        state: 'FAIL',
        what: target,
        msg: '桌面那份与源文件**不一致**（它是旧版本，或从未重新生成）',
        detail: [
          `第一个不同的行（0 基 #${firstDiff}）：`,
          `  期望: ${JSON.stringify(String(wl[firstDiff] ?? '(无此行)').slice(0, 100))}`,
          `  实际: ${JSON.stringify(String(gl[firstDiff] ?? '(无此行)').slice(0, 100))}`,
          `桌面 OVERRIDE = ${absLine ? absLine[1] : '(无)'}`,
        ],
        fix: 'node scripts/install-desktop-icon.mjs --yes',
      })
      continue
    }
  }

  if (prob.length === 0 && exact !== false) {
    results.push({
      state: 'PASS',
      what: target,
      msg: `逐字一致 + 纯 ASCII + 全 CRLF（bytes=${got.bytes}）`,
    })
  } else if (prob.length > 0) {
    results.push({
      state: 'FAIL',
      what: target,
      msg: '桌面那份自身就是坏的：' + prob.join('；'),
      fix: '先修源文件，再 node scripts/install-desktop-icon.mjs --yes',
    })
  }
}

// ---- 报告 ----
const fails = results.filter((r) => r.state === 'FAIL')
const passes = results.filter((r) => r.state === 'PASS')
const skips = results.filter((r) => r.state === 'SKIP')

if (AS_JSON) {
  console.log(JSON.stringify({ repo: REPO, src: SRC, results }, null, 2))
  process.exit(fails.length ? 1 : 0)
}

console.log('\n桌面启动器体检 —— 桌面那份必须与仓库源文件**逐字一致**')
console.log(`  源文件（判据根）: ${SRC}`)
console.log(`  源的指纹        : ${src ? `bytes=${src.bytes} 非ASCII=${src.nonAscii} 纯LF=${src.pureLf}` : '（读不到）'}`)
console.log('')

for (const r of passes) console.log(`  ok    [PASS] ${r.what}\n        ${r.msg}`)
for (const r of fails) {
  console.log(`  ★★★   [FAIL] ${r.what}\n        ${r.msg}`)
  for (const d of r.detail ?? []) console.log(`        ${d}`)
  if (r.fix) console.log(`        修法: ${r.fix}`)
}
for (const r of skips) console.log(`  --    [SKIP] ${r.what}\n        ${r.msg}  ★ 这不是"通过"，是本机无法判定`)

console.log('')
console.log('─'.repeat(78))
console.log(`  ${passes.length} 通过 / ${fails.length} 失败 / ${skips.length} 跳过`)
if (fails.length) {
  console.log('')
  console.log('  ★ 记住形状：**被检查的都干净、而用户双击的那个没人管** —— 这正是本次事故。')
  console.log('    桌面那份是【派生物】，改了源文件就必须重装：node scripts/install-desktop-icon.mjs --yes')
}
console.log('')
process.exit(fails.length ? 1 : 0)
