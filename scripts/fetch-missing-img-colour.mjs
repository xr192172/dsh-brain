#!/usr/bin/env node
/**
 * fetch-missing-img-colour.mjs —— 就地补上 `@img/colour`（`sharp` 的依赖，被漏装）
 *
 * ## 是什么把栈打挂的（2026-09-20 实测）
 *
 * `gen-3082/boot.log`：
 *   failed to import loader entry attachment-local (@deepseek-ai/dsh-attachment-local):
 *     Cannot find package '@img/colour' imported from node_modules/sharp/dist/colour.mjs
 * ⇒ `sharp` 要 `@img/colour@^1.1.0`，而 `node_modules/@img/` 下**只有 `sharp-win32-x64`**
 * ⇒ `dsh-attachment-local` 装配失败 ⇒ **gen 起不来 ⇒ 前门 502**。
 *
 * 它和 `@deepseek-ai/*` 那次是**同一场"依赖被清空"事件的受害者**（靶场会话的子代理补了
 * `@deepseek-ai/*` ~200 个，**漏了 `@img/colour`**）。
 *
 * ## 为什么不用 `npm install`
 *
 * `npm install` 会 **reify 整棵树**（可能动到别人刚补好的东西），而且会跑 **postinstall** ——
 * 那 5 个 patch 脚本会改 `~/.dsh/profiles/web/`（**P2 安全层**）。
 * ⇒ 本脚本**只把这一个包取回来**，别的一律不碰。
 *
 * ## 安全
 *
 * · `resolved` 是 **registry.npmmirror.com**（国内镜像）⇒ 直连可下，不用代理；
 * · **校验 lock 里的 integrity（sha512）**，不符就停；
 * · 解包只落在 `node_modules/@img/colour`；
 * · 默认干跑；装完**真解一次**（`import.meta.resolve('sharp')` 链路）。
 *
 * 用法：
 *   node scripts/fetch-missing-img-colour.mjs           # 干跑
 *   node scripts/fetch-missing-img-colour.mjs --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project_develop/dsh-brain'
const NAME = '@img/colour'
const DEST = path.join(REPO, 'node_modules', '@img', 'colour')
const APPLY = process.argv.includes('--apply')

// ① 从 lock 取权威信息（版本 / resolved / integrity）——**不猜**
const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'))
const ent = lock.packages?.[`node_modules/${NAME}`]
if (!ent) { console.error(`✗ lock 里没有 node_modules/${NAME} —— 停。`); process.exit(1) }
console.log(`目标: ${NAME}@${ent.version}`)
console.log(`来源: ${ent.resolved}`)
console.log(`完整性: ${ent.integrity}`)
console.log(`落点: ${DEST}`)
console.log(`模式: ${APPLY ? '★ APPLY' : 'dry-run'}`)
console.log('')

// ② 已存在就不动（幂等）
if (fs.existsSync(path.join(DEST, 'package.json'))) {
  const v = JSON.parse(fs.readFileSync(path.join(DEST, 'package.json'), 'utf8')).version
  console.log(`✓ 已存在（v${v}）⇒ 无需改动（幂等）。`)
  process.exit(0)
}

if (!APPLY) {
  console.log('[dry-run] 将：下载 tarball → 校验 sha512 → 解包到上述落点 → 真解一次验证')
  console.log('确认后加 --apply。')
  process.exit(0)
}

// ③ 下载
const tmpDir = path.join(REPO, 'out', 'tmp-img-colour')
fs.rmSync(tmpDir, { recursive: true, force: true })
fs.mkdirSync(tmpDir, { recursive: true })
const tgz = path.join(tmpDir, 'colour.tgz')

console.log('① 下载 tarball …')
try {
  execFileSync('curl', ['-fsSL', '--max-time', '90', '-o', tgz, ent.resolved], { stdio: 'inherit' })
} catch (e) {
  console.error(`✗ 下载失败（${e.status ?? '?'}）。若网络不通，可换 registry 或走代理后重试。`)
  process.exit(1)
}
const size = fs.statSync(tgz).size
console.log(`   ✓ ${size} 字节`)

// ④ 校验 integrity（不校验就装 = 盲信网络）
console.log('② 校验 integrity …')
const [algo, b64] = ent.integrity.split('-', 2)
const actual = crypto.createHash(algo.replace('sha', 'sha')).update(fs.readFileSync(tgz)).digest('base64')
const ok = actual === b64
console.log(`   ${algo}: ${ok ? '匹配 ✓' : '★ 不匹配（期望 ' + b64.slice(0, 16) + '… 实得 ' + actual.slice(0, 16) + '…）'}`)
if (!ok) { console.error('✗ integrity 不符 ⇒ 停（不装来源可疑的东西）'); process.exit(1) }

// ⑤ 解包（npm tarball 惯例：顶层是 package/）
console.log('③ 解包 …')
execFileSync('tar', ['-xzf', tgz, '-C', tmpDir], { stdio: 'inherit' })
const inner = path.join(tmpDir, 'package')
if (!fs.existsSync(path.join(inner, 'package.json'))) { console.error('✗ tarball 里没有 package/package.json'); process.exit(1) }
fs.mkdirSync(path.dirname(DEST), { recursive: true })
fs.cpSync(inner, DEST, { recursive: true })
fs.rmSync(tmpDir, { recursive: true, force: true })
console.log(`   ✓ 已落到 ${path.relative(REPO, DEST)}`)

// ⑥ 真解一次（不靠"我觉得装好了"）
console.log('④ 验证（真解 sharp 的依赖链）…')
try {
  const r = execFileSync(process.execPath, ['--input-type=module', '-e',
    `console.log(import.meta.resolve('${NAME}'))`], { cwd: REPO, encoding: 'utf8' }).trim()
  console.log(`   ✓ ${r}`)
} catch (e) {
  console.error(`   ✗ 仍解析不到：${String(e.stderr || e.message).split('\n')[0]}`)
  process.exit(1)
}
try {
  const r = execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import('sharp'); console.log('sharp 可加载')`], { cwd: REPO, encoding: 'utf8' }).trim()
  console.log(`   ✓ ${r}`)
} catch (e) {
  console.error(`   ✗ sharp 仍加载失败：${String(e.stderr || e.message).split('\n')[0]}`)
  process.exit(1)
}
console.log('')
console.log('✓ 完成。接下来请重启栈（用户终端）：node scripts/relaunch-switchboard.mjs')
