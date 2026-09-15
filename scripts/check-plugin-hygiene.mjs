#!/usr/bin/env node
/**
 * check-plugin-hygiene.mjs —— 插件「装得干净、卸得干净」的卫生门（2026-09-15）
 *
 * ## 为什么需要它
 *
 * 设计依据：`docs/capability-registry-evolution.md` §6.5。
 * 上游把 host 侧 HMR 关了（`cordis-plugin-hmr` 被 `disabled`），**"能不能卸干净"那半边
 * 恰恰是没被测过的那一半**。所以在插件层，我们只能靠**检查**来维持这个性质。
 *
 * 而本项目反复验证过一条：**要靠门，不靠记性。**
 *
 * ## 判据口径
 *
 * - **每条都要能指名「哪个包 / 哪一步」**，不出总分（沿用 §5 的 fail-closed 逐项纪律）。
 * - `ERROR` ⇒ 非 0 退出；`WARN` ⇒ 退出 0 但**大声打印**并计数。
 *   （为什么 WARN 不失败：有些项是"可能有意为之"，例如 `packages/` 里留一个未启用的
 *    在开发中的包。把这类一律判红，门就会被绕过 —— 那比不设门更糟。）
 * - `--strict` ⇒ 让 WARN 也失败（CI 里想要更严时用）。
 *
 * ## 用法
 *
 *   node scripts/check-plugin-hygiene.mjs
 *   node scripts/check-plugin-hygiene.mjs --strict
 *   node scripts/check-plugin-hygiene.mjs --json
 *   node scripts/check-plugin-hygiene.mjs --profile-dir <p> --packages-dir <p>   # 供自证夹具使用
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const REPO = 'D:/project_develop/dsh-brain'
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i < 0 ? d : argv[i + 1]
}
const STRICT = argv.includes('--strict')
const JSON_OUT = argv.includes('--json')

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const PROFILE_DIR = opt('profile-dir', path.join(HOME, 'profiles', 'web'))
const PACKAGES_DIR = opt('packages-dir', path.join(REPO, 'packages'))
const SCOPE = '@dsh-brain/'

const findings = []
const err = (id, what, detail) => findings.push({ level: 'ERROR', id, what, detail })
const warn = (id, what, detail) => findings.push({ level: 'WARN', id, what, detail })
const info = (id, what, detail) => findings.push({ level: 'INFO', id, what, detail })

// ── 读 profile manifest ──────────────────────────────────────────────────────
const manifestPath = path.join(PROFILE_DIR, 'package.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`X 找不到 profile manifest：${manifestPath}`)
  process.exit(1)
}
let manifest
try {
  const raw = fs.readFileSync(manifestPath, 'utf8')
  if (raw.charCodeAt(0) === 0xfeff) err('profile', 'manifest 带 UTF-8 BOM', 'DSH 读 profile 时会 JSON.parse 崩')
  manifest = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
} catch (e) {
  console.error(`X profile manifest 解析失败：${e.message}`)
  process.exit(1)
}

const bundles = manifest.dsh?.profile?.bundles ?? []
const deps = manifest.dependencies ?? {}
const ourBundles = bundles.filter((b) => typeof b === 'string' && b.startsWith(SCOPE))

// ── 从 bundle 名取仓库目录名（@dsh-brain/design-canvas-bridge → design-canvas-bridge）──
const dirOf = (bundleName) => bundleName.slice(SCOPE.length)

const pkgDirs = fs.existsSync(PACKAGES_DIR)
  ? fs.readdirSync(PACKAGES_DIR).filter((d) => {
      try { return fs.statSync(path.join(PACKAGES_DIR, d)).isDirectory() } catch { return false }
    })
  : []

/**
 * 从 `pnpm-lock.yaml` 里取 `importers` 段第一条 importer 的 `dependencies` 键名。
 *
 * 为什么要自己解析：`check:profile` 只看装配结果、不看 lock，
 * 于是 lock 与 manifest 不一致时没人发现（2026-09-15 实测该 lock 两个方向都脏）。
 * 不引 yaml 依赖，因为只需要这一小段结构 —— 但**解析不出来要如实说**，不许假装通过。
 *
 * @returns {{ok: true, deps: string[]} | {ok: false}}
 */
function readLockImporterDeps(text) {
  const lines = text.split('\n')
  let inDep = false
  let depIndent = -1
  let sawDependencies = false
  const out = []
  for (const l of lines) {
    if (!inDep && /^\s*dependencies:\s*$/.test(l)) {
      inDep = true
      depIndent = l.match(/^\s*/)[0].length
      sawDependencies = true
      continue
    }
    if (!inDep) continue
    // 顶层段边界：importers 之后就是 packages / snapshots
    if (/^(packages|snapshots):/.test(l)) break
    const ind = l.match(/^\s*/)[0].length
    if (l.trim() && ind <= depIndent) { inDep = false; continue }
    const m = l.match(/^\s*'([^']+)':\s*$/)
    if (m) out.push(m[1])
  }
  return sawDependencies ? { ok: true, deps: [...new Set(out)] } : { ok: false }
}

// ── ① 正查：每个 bundle 真正可用吗（目录 / 产物 / patch / dsh.bundle 声明）─────────
for (const b of ourBundles) {
  const dir = dirOf(b)
  const base = path.join(PACKAGES_DIR, dir)
  if (!fs.existsSync(base)) { err(dir, 'bundle 指向的包目录不存在', `${b} → ${base}`); continue }

  const libEntry = path.join(base, 'lib', 'index.js')
  if (!fs.existsSync(libEntry)) {
    err(dir, '缺编译产物 lib/index.js', '该 bundle 装载时会 import 失败 → gen 起不来。先构建该包')
  }
  if (!fs.existsSync(path.join(base, 'cordis.patch.yml'))) {
    err(dir, '缺 cordis.patch.yml', 'bundle 靠它 insert 自己，缺了不会被装配')
  }
  try {
    const m = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
    if (!m.dsh?.bundle) err(dir, 'package.json 缺 dsh.bundle 声明', 'loader 会报 "declares no dsh.bundle"')
  } catch (e) {
    err(dir, 'package.json 读不出/解析失败', e.message)
  }

  // 源码比产物新 ⇒ 提醒没重建（改了源码没生效，是"看起来改了其实没改"的高发区）
  try {
    const srcDir = path.join(base, 'src')
    if (fs.existsSync(srcDir) && fs.existsSync(libEntry)) {
      const latest = fs.readdirSync(srcDir)
        .map((f) => path.join(srcDir, f))
        .filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
        .reduce((mx, p) => Math.max(mx, fs.statSync(p).mtimeMs), 0)
      if (latest > fs.statSync(libEntry).mtimeMs) {
        warn(dir, '源码比编译产物新', '改了源码但没重建 → 运行时用的还是旧产物')
      }
    }
  } catch { /* mtime 读不到就算了，不误报 */ }
}

// ── ② profile 侧符号链接：存在且不悬空 ───────────────────────────────────────
const linkDir = path.join(PROFILE_DIR, 'node_modules', SCOPE)
for (const b of ourBundles) {
  const dir = dirOf(b)
  const link = path.join(linkDir, dir)
  if (!fs.existsSync(link)) {
    err(dir, 'profile 里没有该包的链接', `${link} 不存在 → loader 解析不到该 bundle`)
  } else if (!fs.existsSync(path.join(link, 'package.json'))) {
    err(dir, 'profile 里的链接悬空', `${link} 存在但目标不可读（符号链接指向已删除的目录？）`)
  }
}

// ── ③ 反查残留：packages/ 里有、但没被任何 bundle 启用 ────────────────────────
for (const d of pkgDirs) {
  if (!ourBundles.includes(SCOPE + d)) {
    warn(d, '存在但未被任何 bundle 启用', '残留（装了没用）？还是开发中的新包（WIP）？——请自行甄别后处理')
  }
}

// ── ④ deps 与 bundles 的一致性 ───────────────────────────────────────────────
for (const b of ourBundles) {
  if (!(b in deps)) {
    warn(dirOf(b), 'bundle 未在 profile dependencies 里声明', '靠 node_modules 符号链接解析 —— 跑 pnpm install 可能被剪掉，该 bundle 会静默失效')
  }
}
for (const d of Object.keys(deps)) {
  if (d.startsWith(SCOPE) && !bundles.includes(d)) {
    info(d, '在 dependencies 里但不是 bundle', '若它本该提供能力，检查是否漏加进 bundles')
  }
}

// ── ④b lock 与 manifest 的一致性 ─────────────────────────────────────────────
// 为什么必须查：2026-09-15 实测发现该 lock **两个方向都脏** ——
//   漏了 4 个我们自己的包（⇒ 一次 pnpm install 会被剪掉），
//   又留着两个早已删掉的条目（@dsh-brain/handover-agent、@linxin666/dsh-pet，连其依赖树）。
//   而 `check:profile` 只看装配**结果**、不看 lock ⇒ 这个不一致一直没人发现。
const lockPath = path.join(PROFILE_DIR, 'pnpm-lock.yaml')
if (fs.existsSync(lockPath)) {
  const parsed = readLockImporterDeps(fs.readFileSync(lockPath, 'utf8'))
  if (!parsed.ok) {
    warn('pnpm-lock.yaml', '解析不出 importers 依赖段', '跳过一致性核对（**不假装通过**）')
  } else {
    for (const k of Object.keys(deps)) {
      if (!parsed.deps.includes(k)) {
        err(k, 'lock 里没有该依赖', '`--frozen-lockfile` 会明确失败；普通 `pnpm install` 会补上（改 manifest 后应同步 lock）')
      }
    }
    for (const k of parsed.deps) {
      if (!(k in deps)) {
        warn(k, 'lock 里有、但 manifest 已删（陈旧条目）', '`pnpm install` 会把它 prune 掉 —— 属"卸不干净"的残留')
      }
    }
  }
} else {
  warn('pnpm-lock.yaml', '没有 lock 文件', '无法核对依赖一致性（**不假装通过**）')
}

// ── ⑤ 已移除插件的遗留物（"卸不干净"的直接证据）───────────────────────────────
const KNOWN_RESIDUE = [
  { file: 'pet.json', why: '桌宠插件已移除，这是它的状态文件' },
]
for (const r of KNOWN_RESIDUE) {
  if (fs.existsSync(path.join(HOME, r.file))) {
    warn(r.file, '已移除插件的遗留状态文件', `${r.why}；留着无害，但属于"卸不干净"（再装回来会继承旧状态）`)
  }
}
const backupDir = path.join(HOME, '.backup')
if (fs.existsSync(backupDir)) {
  const items = fs.readdirSync(backupDir)
  warn('.backup', '存在移除时的备份目录', `${items.length} 项：${items.slice(0, 3).join(', ')}${items.length > 3 ? ' …' : ''}`)
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const errs = findings.filter((f) => f.level === 'ERROR')
const warns = findings.filter((f) => f.level === 'WARN')
const infos = findings.filter((f) => f.level === 'INFO')

if (JSON_OUT) {
  console.log(JSON.stringify({ profile: PROFILE_DIR, bundles: ourBundles.length, findings }, null, 2))
} else {
  console.log('== 插件卫生（装得干净 / 卸得干净）==')
  console.log(`  profile : ${PROFILE_DIR}`)
  console.log(`  包目录  : ${PACKAGES_DIR}`)
  console.log(`  我方 bundle：${ourBundles.length} 个 / 仓库包目录：${pkgDirs.length} 个\n`)

  if (!findings.length) console.log('  ✅ 无问题')
  for (const f of [...errs, ...warns, ...infos]) {
    const tag = f.level === 'ERROR' ? '✗ ERROR' : f.level === 'WARN' ? '⚠ WARN ' : '· INFO '
    console.log(`  ${tag}  ${f.id}`)
    console.log(`           ${f.what}`)
    if (f.detail) console.log(`           ${f.detail}`)
  }
  console.log('')
  console.log(`  ERROR ${errs.length} ｜ WARN ${warns.length} ｜ INFO ${infos.length}`)
  console.log('  （ERROR 立刻坏装配；WARN 是"可能有意为之"，请自行甄别 —— 一律判红会让门被绕过）')
}

const failed = errs.length > 0 || (STRICT && warns.length > 0)
process.exit(failed ? 1 : 0)
