#!/usr/bin/env node
/**
 * relink-node-modules.mjs —— 重建仓库 `node_modules/` 下两条**指向共享树**的链接
 *
 * ## 为什么需要（2026-09-20 20:19–20:43 实测事故）
 *
 * 三条线同时在跑（靶场 / 工具完善 / 架构线）。20:19 时我跑 `check-all` 还是 **15/15 全绿**；
 * 20:43 再跑，**15 门里 8 门红**，全是 `ERR_MODULE_NOT_FOUND`。实测：
 *
 *   ~/.dsh/profiles/node_modules/@deepseek-ai        → ~200 个包  ✓ **完整**
 *   ~/.dsh/profiles/web/node_modules/@deepseek-ai    → dsh-base, dsh-mcp-client
 *   仓库 node_modules/@deepseek-ai                   → ★ ENOENT
 *   仓库 node_modules/@dsh-brain                     → ★ ENOENT
 *
 * ⇒ **不是共享树没了，是仓库 `node_modules/` 下那两个「指向它」的链接没了。**
 * 证据：`.gitignore` 第 37-38 行自己写着
 * 「`@dsh-brain` 分包产物（**junction-link 到 profile node_modules**，构建产物不入库）」。
 *
 * ## 纪律
 *
 * · **默认干跑**（`--apply` 才动手）；· **只建链接，绝不删/改共享树**（那棵树是只读来源）；
 * · 幂等（已是链接就跳过）；· 建完**立刻验证**（解一次真实依赖：`require.resolve` 一个上游包）。
 *
 * ## 用法
 *   node scripts/relink-node-modules.mjs          # 干跑
 *   node scripts/relink-node-modules.mjs --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project_develop/dsh-brain'
const HOME = os.homedir()
const SHARED = path.join(HOME, '.dsh', 'profiles', 'node_modules')   // 上游共享树
const APPLY = process.argv.includes('--apply')

/** 要建的链接：仓库 node_modules/<name> → <target> */
const LINKS = [
  { name: '@deepseek-ai', target: path.join(SHARED, '@deepseek-ai'), what: '上游 DSH 包（约 200 个）' },
  { name: '@dsh-brain', target: path.join(SHARED, '@dsh-brain'), what: '我们自己的包（构建产物 junction 到 profile）' },
]

function kindOf(p) {
  try {
    const s = fs.lstatSync(p)
    if (s.isSymbolicLink()) return 'symlink'
    if (s.isDirectory()) return 'dir'
    return 'other'
  } catch { return 'missing' }
}

console.log(`仓库: ${REPO}`)
console.log(`共享树: ${SHARED}`)
console.log(`模式: ${APPLY ? '★ APPLY' : 'dry-run'}`)
console.log('')

// 前置：共享树必须在
if (kindOf(SHARED) !== 'dir') {
  console.error(`✗ 共享树不存在（${SHARED}）—— 本脚本只负责"重建链接"，不负责"重建树"。停止。`)
  process.exit(1)
}
const sharedCount = fs.readdirSync(path.join(SHARED, '@deepseek-ai')).length
console.log(`共享树自检：@deepseek-ai 下 ${sharedCount} 个包 ✓`)
console.log('')

let todo = 0
for (const L of LINKS) {
  const dest = path.join(REPO, 'node_modules', L.name)
  const cur = kindOf(dest)
  const tgtOk = kindOf(L.target) === 'dir'
  console.log(`── ${L.name}（${L.what}）`)
  console.log(`   目标: ${L.target}  [${tgtOk ? '存在 ✓' : '★ 不存在'}]`)
  console.log(`   现状: ${dest} → ${cur}`)
  if (!tgtOk) { console.log('   ⚠️ 目标不存在 ⇒ 跳过（不建悬空链接）\n'); continue }
  if (cur === 'symlink' || cur === 'dir') { console.log('   已存在 ⇒ 幂等跳过\n'); continue }
  todo++
  if (!APPLY) { console.log(`   [dry-run] 将建 junction：node_modules/${L.name} → ${L.target}\n`); continue }

  // Windows 上用 mklink /J（目录 junction，不需要管理员）；Node 的 symlink(type:'junction') 亦可
  fs.symlinkSync(L.target, dest, 'junction')
  console.log(`   ✓ 已建 junction\n`)
}

console.log('─'.repeat(70))
if (!APPLY) {
  console.log(`dry-run 结束：待建 ${todo} 条链接。确认后加 --apply。`)
  process.exit(0)
}

// 落盘后**立刻验证**：真解一次依赖（不靠"我觉得建好了"）
console.log('验证（真解一次上游依赖）…')
let ok = true
for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/cordis']) {
  try {
    const r = execFileSync(process.execPath, ['-e', `console.log(require.resolve(${JSON.stringify(name)}))`], {
      cwd: REPO, encoding: 'utf8',
    }).trim()
    console.log(`  ✓ ${name}\n      → ${r}`)
  } catch (e) {
    ok = false
    console.log(`  ✗ ${name} —— 仍解析不到`)
  }
}
console.log('')
if (!ok) { console.error('✗ 验证未过 —— 链接没生效（查：目标是否可为 junction / 权限）'); process.exit(1) }
console.log('✓ 链接已重建并验证通过。请再跑 `node scripts/check-all.mjs` 确认 15 门恢复。')
