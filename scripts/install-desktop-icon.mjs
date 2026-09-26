#!/usr/bin/env node
/**
 * install-desktop-icon.mjs —— 把「一键启动」放到**桌面**上。
 *
 * 用户的要求（2026-09-25 逐字）：
 *   *"点击一下桌面图标我们直接启动后端服务那种。我不要求你把它打包成 Electron 因为它很重，
 *    但是你至少要像它一样很简单的触发一条就直接启动吧。"*
 *
 * ★ 为什么**不需要** Electron / 也不需要生成 `.lnk`：
 *   · Electron 给的那三样东西（**固定入口** + **入口自己备好环境** + **起完直接开界面**）
 *     **跟 Electron 无关** —— 我们已经有 `scripts/arm-up.mjs`（一个入口、两种模式、自检），
 *     再加一个**无参的 `.cmd` 皮肤**就够了。
 *   · 生成 `.lnk` 要 COM（PowerShell / 脚本宿主），而**本机这两条通道都不可靠**
 *     （实测：PS 的 stdout 被吞、安全策略会拦）。⇒ **改为直接把 `.cmd` 拷到桌面**：
 *     双击 `.cmd` 就是"一键"，行为与快捷方式等价，且**纯文件操作、可审计、可一键删除**。
 *
 * 用法：
 *   node scripts/install-desktop-icon.mjs            # 只打印它会做什么（dry-run）
 *   node scripts/install-desktop-icon.mjs --yes      # 真的拷到桌面
 *   node scripts/install-desktop-icon.mjs --remove --yes   # 从桌面删掉（只删它自己拷的那份）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, 'dsh-up.cmd')
const FILENAME = 'DSH 启动 (双击).cmd'
const FLAG = 'DSH-ONE-CLICK-LAUNCHER' // ★ 认领标记：只删自己写的那份

/** 桌面目录（兼容 OneDrive 重定向）。 */
function desktopDirs() {
  const home = os.homedir()
  const cands = [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive - Personal', 'Desktop')]
  return cands.filter((d) => fs.existsSync(d))
}

const argv = process.argv.slice(2)
const yes = argv.includes('--yes')
const remove = argv.includes('--remove')

if (!fs.existsSync(SRC)) {
  console.error(`[失败] 找不到皮肤文件 ${SRC}`)
  process.exit(2)
}
const desks = desktopDirs()
if (desks.length === 0) {
  console.error('[失败] 找不到桌面目录（试过 Desktop / OneDrive\\Desktop）')
  process.exit(2)
}

if (remove) {
  let n = 0
  for (const d of desks) {
    const t = path.join(d, FILENAME)
    if (!fs.existsSync(t)) continue
    const head = fs.readFileSync(t, 'utf8').slice(0, 400)
    if (!head.includes(FLAG)) {
      console.error(`[拒绝] ${t} 存在但**不是本工具写的**（没有 ${FLAG} 标记）⇒ 不删别人的东西`)
      continue
    }
    if (!yes) console.log(`  (dry-run) 会删：${t}`)
    else { fs.unlinkSync(t); console.log(`  已删：${t}`); n++ }
  }
  console.log(`\n${yes ? `删了 ${n} 个。` : '（dry-run，没动任何东西；加 --yes 真删）'}`)
  process.exit(0)
}

// ★ 写之前做两处**打标记**：
//   ① 认领标记（`--remove` 靠它认出是自己写的）
//   ② ★★ **把绝对仓库路径写进去** —— 这是本工具存在的**真正理由**：
//      桌面那份与 `scripts\` 的**相对关系不成立**（`%~dp0..` 在桌面 = `C:\Users\Admin\`）
//      ⇒ 必须把 `%DSH_REPO_OVERRIDE%` 填成绝对路径，否则双击会报 `Cannot find module …\scripts\arm-up.mjs`。
const REPO = path.resolve(HERE, '..')
const body = fs.readFileSync(SRC, 'utf8')
let stamped = body.includes(FLAG) ? body : body.replace('@echo off', `@echo off\r\nrem ${FLAG}`)
// ★ 匹配必须**锚定整行且不跨行** —— 我第一版用 `[^"]*`，它**跨过了换行**把下一行的 `if not` 也吞了，
//   产出 `set "DSH_REPO_OVERRIDE=D:\…"%DSH_REPO_OVERRIDE%"=="" (` 这种坏行 ✗
const OVERRIDE_LINE = /^set "DSH_REPO_OVERRIDE=[^"\r\n]*"$/m
if (!OVERRIDE_LINE.test(stamped)) {
  console.error('[失败] 源文件里找不到独立的 `set "DSH_REPO_OVERRIDE=…"` 行 ⇒ 装了也没用，拒绝继续')
  process.exit(2)
}
stamped = stamped.replace(OVERRIDE_LINE, `set "DSH_REPO_OVERRIDE=${REPO}"`)
if (!stamped.includes(`set "DSH_REPO_OVERRIDE=${REPO}"`)) {
  console.error('[失败] 绝对路径没写进去 ⇒ 拒绝继续（宁可报错也不要留一个会崩的图标）')
  process.exit(2)
}
// ★ 坏形态的**精确**判据：引号**在同行闭合之后还有多余内容**（即"吞掉了下一行"那种）。
//   ⚠️ 我第一版写成 /…"=="" \(/ ⇒ 把**正常那行** `if not "%DSH_REPO_OVERRIDE%"=="" (` 也判成坏 ⇒ **假红**。
if (/^set "DSH_REPO_OVERRIDE=[^"\r\n]*"[ \t]*\S/m.test(stamped)) {
  console.error('[失败] 检测到被吞坏的续行（引号闭合后同行仍有多余内容）⇒ 拒绝继续')
  process.exit(2)
}

// ============================================================================
// ★★★ 2026-09-26 补（真事故：用户投诉满屏弹窗 + 满屏"不是内部或外部命令"）：
//
//   病因 = **桌面那份是旧版本，而安装器照单全收地把它拷了过去**。
//   实测指纹：桌面 `DSH 启动 (双击).cmd` 一直是 243 个非 ASCII + 66 个纯 LF，
//   而仓库 `scripts/dsh-up.cmd` 已经修好了（0 / 0）—— **两者脱节了整整一段时间**。
//   症状（用户逐字贴回来的）：
//       '-click' 不是内部或外部命令      ← "double-click" 被切成 '-click'
//       'icon'  不是内部或外部命令      ← "icon"
//       'equired' …                     ← "required"
//       'witchboard.cmd).' …            ← "relaunch-switchboard.cmd)."
//       '-25' …                         ← "2026-09-25"
//       系统无法接受输入的时间。输入新时间:  ← "every time" 里的 `time` 当成 TIME 命令执行
//
//   ⇒ **安装器必须自己把关**，不能"源文件是什么就照抄什么"：
//     ① **纯 LF** ⇒ 直接**归一到 CRLF**（纯机械动作：不改语义，只改行尾）。
//        这一条**不拒绝**，因为拒绝会让桌面上留着那个**更坏的旧版**（正是本次事故）。
//     ② **非 ASCII** ⇒ **拒绝安装**。这一条**不能**自动修（要去改注释文字，属内容修改），
//        自动剥字符会毁掉原文 ⇒ 必须让人看见并去改。
//        （`.cmd` 里任何 >0x7F 的字节都可能被 cmd.exe 按 OEM 码页切错行。）
//   ★ 判据出处：`scripts/check-cmd-lineendings.mjs`（判据 A / B）。
// ============================================================================
const preNonAscii = Buffer.from(stamped, 'utf8').filter((b) => b > 0x7f).length
const prePureLf = (stamped.match(/\n/g) || []).length - (stamped.match(/\r\n/g) || []).length

if (prePureLf > 0) {
  console.log(`  ⚠ 源文件有 ${prePureLf} 个纯 LF 行 ⇒ **自动归一到 CRLF**（.cmd 必须 CRLF，否则 cmd.exe 会吃掉 rem 前缀）`)
  stamped = stamped.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
}
if (preNonAscii > 0) {
  console.error(`\n[失败] 源文件含 ${preNonAscii} 个非 ASCII 字节 ⇒ **拒绝装到桌面**。`)
  console.error('       原因：cmd.exe 按**当前 OEM 代码页**流式读取 .cmd，chcp 生效更晚，')
  console.error('       非 ASCII 字节会让它偶发切错行、执行注释里的碎片（实测 4% 概率）。')
  console.error('       修法：把 dsh-up.cmd 注释里的非 ASCII 全换成 ASCII（中文说明写进 README-dsh-up.md）。')
  console.error('       自查：node scripts/check-cmd-lineendings.mjs .')
  process.exit(2)
}

console.log(`源文件 : ${SRC}`)
for (const d of desks) {
  const t = path.join(d, FILENAME)
  console.log(`桌面   : ${t}${fs.existsSync(t) ? '（已存在，将覆盖同一份）' : ''}`)
}
if (!yes) {
  console.log('\n（dry-run：没动任何东西。加 --yes 真的拷到桌面）')
  process.exit(0)
}
for (const d of desks) {
  const t = path.join(d, FILENAME)
  fs.writeFileSync(t, stamped, 'utf8')
  // ★ 写完**立刻复验**（不信 writeFileSync 的返回；铁律 15：写入类要当场校验）
  const rb = fs.readFileSync(t)
  const rt = rb.toString('utf8')
  const rbNonAscii = rb.filter((b) => b > 0x7f).length
  const rbPureLf = (rt.match(/\n/g) || []).length - (rt.match(/\r\n/g) || []).length
  const ok = rbNonAscii === 0 && rbPureLf === 0 && rt.includes(`set "DSH_REPO_OVERRIDE=${REPO}"`)
  console.log(`  ${ok ? '✅' : '✗✗'} 已放好：${t}`)
  console.log(`      指纹 bytes=${rb.length} 非ASCII=${rbNonAscii} 纯LF=${rbPureLf} 绝对路径=已写入`)
  if (!ok) {
    console.error('      ★ 复验不通过 ⇒ 桌面那份可能是坏的，请立刻报告（不要双击它）')
    process.exitCode = 1
  }
}
console.log('\n★ 以后**双击桌面那个图标**即可：起服务 → 自检 → 自动打开界面（不需要任何参数）。')
console.log('★ 想删掉：右键删除即可，或 `node scripts/install-desktop-icon.mjs --remove --yes`。')
console.log('★ ★ 改过 scripts/dsh-up.cmd 之后，**必须重跑本脚本**，否则桌面那份还是旧的。')
console.log('   此刻不会再靠记性：`node scripts/check-desktop-launcher.mjs` 会比对两者指纹。')
