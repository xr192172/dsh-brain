#!/usr/bin/env node
/**
 * make-profile-variant.mjs —— 造一份**脑 profile 变体**（同 build、只少/多装配某个包）。
 *
 * 为什么需要它：本方向的实验轴是「**我们这一层**」（见 `docs/eval-challenger-arm.md` §11），
 * 而 switchboard **本来就支持按次指定 profile**（`?cmd=handover&profile=<name>`，
 * 见 `coordinator.handover(…, profileOverride, …)`）⇒ "能力开/关"两臂 = 两份 profile + 一次换代。
 *
 * 规矩（照 `topics/runtime-and-launch.md` / `guard.ts` 的 P2 边界）：
 *  · **绝不改 `profiles/web`**（它是 P2 安全层，护栏明令禁止就地修改）——本脚本只**新建**目标目录。
 *  · `disabled ≠ 移除`：控制"装不装"的是 `package.json` 的 `dsh.profile.bundles`（**决定装配**）
 *    与 `dependencies`（决定能不能解析）。两个都要动，缺一不可。
 *  · `node_modules` 用 **junction 指向源 profile 的**（不复制、不重装、零网络）。
 *
 * 用法：
 *   node scripts/make-profile-variant.mjs --from web --to web-notev --drop @dsh-brain/tool-evolution
 *   node scripts/make-profile-variant.mjs --from web --to web-notev --drop X --drop Y --force
 *   node scripts/make-profile-variant.mjs --list            # 列出所有 profile 与其 bundles 数
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PROFILES = 'C:/Users/Admin/.dsh/profiles'
const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : argv[i + 1]
}
const drops = argv.reduce((acc, a, i) => (a === '--drop' ? [...acc, argv[i + 1]] : acc), [])

if (argv.includes('--list')) {
  for (const d of fs.readdirSync(PROFILES, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'node_modules') continue
    let n = '?'
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PROFILES, d.name, 'package.json'), 'utf8'))
      n = (j?.dsh?.profile?.bundles ?? []).length
    } catch {
      /* ignore */
    }
    console.log(`  ${d.name.padEnd(18)} bundles=${n}`)
  }
  process.exit(0)
}

const from = argOf('--from')
const to = argOf('--to')
if (!from || !to || !drops.length) {
  console.error('用法: --from <src> --to <dst> --drop <包名> [--drop …] [--force]')
  process.exit(1)
}
const fromDir = path.join(PROFILES, from)
const toDir = path.join(PROFILES, to)
if (!fs.existsSync(fromDir)) {
  console.error(`源 profile 不存在: ${fromDir}`)
  process.exit(1)
}
if (fs.existsSync(toDir) && !argv.includes('--force')) {
  console.error(`目标已存在（要覆盖加 --force）: ${toDir}`)
  process.exit(1)
}

// ① 复制定义文件（不碰 node_modules）
fs.mkdirSync(toDir, { recursive: true })
const DEF_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']
for (const f of DEF_FILES) {
  const s = path.join(fromDir, f)
  if (!fs.existsSync(s)) continue
  fs.copyFileSync(s, path.join(toDir, f))
  console.log(`  复制 ${f}`)
}

// ② 从 dependencies + dsh.profile.bundles 里删掉要 drop 的包
const pkgPath = path.join(toDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const removed = []
for (const d of drops) {
  if (pkg.dependencies?.[d]) {
    delete pkg.dependencies[d]
    removed.push(`dependencies:${d}`)
  }
  const b = pkg?.dsh?.profile?.bundles
  if (Array.isArray(b)) {
    const i = b.indexOf(d)
    if (i >= 0) {
      b.splice(i, 1)
      removed.push(`bundles:${d}`)
    }
  }
}
// 名字区分开，免得到处认错 profile
pkg.name = String(pkg.name ?? 'dsh-profile').replace(/-[^-]*$/, '') + `-${to}`
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.variantOf = from
pkg.dsh.profile.dropped = drops
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`  改 package.json：移除 ${removed.length} 处（deps+bundles 各一次才算干净）`)
for (const r of removed) console.log(`    - ${r}`)
if (removed.length !== drops.length * 2) {
  console.warn(`  ⚠ 期望移除 ${drops.length * 2} 处，实际 ${removed.length} 处 —— 检查包名拼写`)
}

// ③ node_modules 用 junction 指向源 profile（零复制、零安装）
const nmTo = path.join(toDir, 'node_modules')
const nmFrom = path.join(fromDir, 'node_modules')
if (!fs.existsSync(nmTo) && fs.existsSync(nmFrom)) {
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', nmTo.replace(/\//g, '\\'), nmFrom.replace(/\//g, '\\')], {
    encoding: 'utf8',
  })
  console.log(r.status === 0 ? '  node_modules = junction → 源 profile ✓' : `  ⚠ junction 失败: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`)
}

console.log(`\n已造好 profile 变体：${toDir}`)
console.log(`用它起一代（控制面）：curl "http://127.0.0.1:31800/?cmd=handover&profile=${to}"`)
console.log(`验"没装"的判据：新 gen 的 boot.log 里**不应**出现该包的启动行（例如 tool-evolution 的 '[tool-evolution] apply running'）`)
