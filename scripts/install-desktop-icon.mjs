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

// ★ 写之前先把认领标记注进去（这样 --remove 能认出是自己写的）
const body = fs.readFileSync(SRC, 'utf8')
const stamped = body.includes(FLAG) ? body : body.replace('@echo off', `@echo off\r\nrem ${FLAG}`)

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
  console.log(`  ✅ 已放好：${t}`)
}
console.log('\n★ 以后**双击桌面那个图标**即可：起服务 → 自检 → 自动打开界面（不需要任何参数）。')
console.log('★ 想删掉：右键删除即可，或 `node scripts/install-desktop-icon.mjs --remove --yes`。')
