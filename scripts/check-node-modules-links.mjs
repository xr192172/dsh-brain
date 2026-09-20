#!/usr/bin/env node
/**
 * check-node-modules-links.mjs —— 依赖树诊断（**只读，不写任何东西**）
 *
 * ## 由来（2026-09-20 一次我自己的误诊，记下来）
 *
 * 仓库 `node_modules/@deepseek-ai` 缺失 ⇒ `check-all` 15 门里 8 门红（`ERR_MODULE_NOT_FOUND`）。
 * 我当时**推断错了方向**：以为"共享树是源、仓库只是缺了指向它的链接"，
 * 于是建了一条 `仓库/node_modules/@deepseek-ai → ~/.dsh/profiles/node_modules/@deepseek-ai`。
 *
 * **实际方向是反的**：
 *   · 仓库 `node_modules/@deepseek-ai/*`   = **真目录（源）** ← **被删的是这个**
 *   · `~/.dsh/profiles/node_modules/@deepseek-ai/*` = **指向仓库的链接**（现在全悬空）
 *
 * ⇒ 我那条链接造成了**自指循环**，把"缺失"变成了"循环"，**比原来更坏**（已撤销）。
 *
 * ## 教训（写进本文件，免得下次再犯）
 *
 * **在"改共享环境"之前，先把「原来的结构是什么样」验证清楚。**
 * 我当时只看了 `.gitignore` 的一句注释 + "树里有 232 个包"，就推断了方向，
 * **没有去验证那 232 个条目到底是真目录还是链接** —— 而那一步就能戳破我的推断。
 * **一步就能验证的事，别跳过。**
 *
 * ## 用法
 *   node scripts/check-node-modules-links.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const REPO = 'D:/project_develop/dsh-brain'
const HOME = os.homedir()
const SHARED = path.join(HOME, '.dsh', 'profiles', 'node_modules')

function kind(p) {
  try {
    const s = fs.lstatSync(p)
    if (s.isSymbolicLink()) return { k: 'link', to: fs.readlinkSync(p) }
    if (s.isDirectory()) return { k: 'dir' }
    return { k: 'other' }
  } catch (e) { return { k: 'MISSING', code: e.code } }
}
function count(p) { try { return fs.readdirSync(p).length } catch { return null } }

console.log('依赖树诊断（只读）')
console.log('─'.repeat(72))

// ① 仓库侧
for (const name of ['@deepseek-ai', '@dsh-brain']) {
  const p = path.join(REPO, 'node_modules', name)
  const k = kind(p)
  const n = count(p)
  console.log(`仓库 node_modules/${name}`)
  console.log(`   状态: ${k.k}${k.to ? ' → ' + k.to : ''}${k.code ? ' (' + k.code + ')' : ''}`)
  console.log(`   条目: ${n === null ? '—' : n}`)
}

// ② 共享树侧（关键：抽查看它到底是真目录还是链接）
const sharedAi = path.join(SHARED, '@deepseek-ai')
const sk = kind(sharedAi)
console.log(`\n共享树 ${SHARED.replace(HOME, '~')}/@deepseek-ai`)
console.log(`   状态: ${sk.k}   条目: ${count(sharedAi) ?? '—'}`)
if (sk.k === 'dir') {
  const sample = fs.readdirSync(sharedAi).slice(0, 3)
  console.log('   抽查（★ 这一步就能定方向 —— 它们是"真目录"还是"指向别处的链接"）:')
  let links = 0
  for (const s of sample) {
    const kk = kind(path.join(sharedAi, s))
    if (kk.k === 'link') links++
    console.log(`     ${s.padEnd(24)} ${kk.k}${kk.to ? ' → ' + kk.to : ''}`)
  }
  // 全量统计方向
  let nLink = 0, nDir = 0, nDead = 0
  for (const s of fs.readdirSync(sharedAi)) {
    const kk = kind(path.join(sharedAi, s))
    if (kk.k === 'link') { nLink++; if (kind(path.join(SHARED, '@deepseek-ai', s)).k === 'MISSING') nDead++ }
    else if (kk.k === 'dir') nDir++
  }
  console.log(`   ⇒ 全量：链接 ${nLink} 个 / 真目录 ${nDir} 个`)
  if (nLink > nDir) {
    console.log('   ⇒ **方向：共享树是【链接方】，它指向的目标才是【源】**')
    const one = fs.readdirSync(sharedAi).find((s) => kind(path.join(sharedAi, s)).k === 'link')
    if (one) {
      const to = kind(path.join(sharedAi, one)).to
      const toK = kind(to)
      console.log(`      例：${one} → ${to}`)
      console.log(`      该目标现状: ${toK.k}${toK.code ? ' (' + toK.code + ')' : ''}`)
      console.log(`      ⇒ ${toK.k === 'MISSING' ? '★ 目标不存在：**源被删了**，建反向链接只会造成自指循环！' : '目标存在（正常）'}`)
    }
  }
}

// ③ 结论与建议
console.log('\n' + '─'.repeat(72))
const repoAi = kind(path.join(REPO, 'node_modules', '@deepseek-ai'))
if (repoAi.k === 'MISSING') {
  console.log('★ 仓库 node_modules/@deepseek-ai 不存在。')
  console.log('  恢复路径（**不要建反向链接，那会自指循环**）：')
  console.log('    a) 按 lock 重装：核对 package-lock.json 里 @deepseek-ai/ 条目数（本仓库有 204 条），')
  console.log('       然后 `npm install`（⚠️ 会跑 postinstall ⇒ 那 5 个 patch 脚本会动 ~/.dsh/profiles/web/，属 P2）；')
  console.log('    b) 或从**备份/另一份完整检出**整体拷回 node_modules/@deepseek-ai/。')
  console.log('  ⚠️ 跑 npm install 前先确认没有别的会话在用这个仓库（多会话共用一个 index）。')
} else {
  console.log('✓ 仓库 node_modules/@deepseek-ai 存在（' + repoAi.k + '，' + (count(path.join(REPO, 'node_modules', '@deepseek-ai')) ?? '—') + ' 条目）')
}
process.exit(0)
