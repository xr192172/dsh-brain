// remove-desktop-pets: 彻底移除两个桌宠插件（不是禁用，是拆除）。
//
// 为什么必须"删除"而不是"disabled":
//   1) `@linxin666/dsh-pet` 在 dsh.profile.bundles 里 → 仍会被 loader 装配（即使 row 被 disabled），
//      占用一次 bundle 解析 + 一个 loader entry；
//   2) `catpet-desktop-pet` 虽已不在 bundles，但它的 package.json 声明了 `dsh.client`，
//      而 DSH 的 web 侧会扫描 node_modules 里所有声明 `dsh.client` 的包注入前端 roster
//      —— 只要目录还在，前端仍可能加载它。且它没有 `dsh.bundle`，
//      一旦被写进 bundles 就触发 `declares no dsh.bundle` → 整棵插件树装配失败。
//
// 本脚本做四件事（幂等、可回滚）：
//   1) 备份 package.json / cordis.patch.yml
//   2) 把两个包目录【移动】到备份区（不是删除）
//   3) 从 profile package.json 移除依赖与 bundle 注册
//   4) 从 cordis.patch.yml 移除 `- id: pet` 覆盖块
//
// 备份区必须与 profile 同盘（C:）——跨盘 fs.rename 会 EXDEV。
// 且放在 ~/.dsh/.backup/ 而不是 profiles/ 下：DSH 不扫该目录，
// 若放在 profiles/ 内会被误当 profile 或参与 node_modules 扫描。
//
// 写入一律 UTF-8【无 BOM】—— DSH readProfileManifest 对 BOM 会 JSON.parse 崩。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/project_develop/dsh-brain'
const PROFILE = 'C:/Users/Admin/.dsh/profiles/web'
const PKG = path.join(PROFILE, 'package.json')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const NM = path.join(PROFILE, 'node_modules')

const REMOVE_PACKAGES = ['@linxin666/dsh-pet', 'catpet-desktop-pet']

const ts = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = path.join('C:/Users/Admin/.dsh/.backup', `removed-desktop-pets-${ts}`)

// 先判"有没有活要干"：全都没有就干净退出，不产生空备份目录（本脚本要能安全重复跑）
const probeManifest = JSON.parse(fs.readFileSync(PKG, 'utf8').replace(/^\uFEFF/, ''))
const probePatch = fs.readFileSync(PATCH, 'utf8').replace(/^\uFEFF/, '')
const work = [
  ...REMOVE_PACKAGES.map((n) => fs.existsSync(path.join(NM, ...n.split('/')))),
  ...REMOVE_PACKAGES.map((n) => n in (probeManifest.dependencies ?? {})),
  ...REMOVE_PACKAGES.map((n) => (probeManifest.dsh?.profile?.bundles ?? []).includes(n)),
  // 必须顶格匹配：替换后的说明注释里也含 "- id: pet" 字样，用 includes 会误判成"还有活"
  /^- id: pet\s*$/m.test(probePatch),
].some(Boolean)

if (!work) {
  console.log('already removed — nothing to do (两个桌宠均已不在 profile 中)')
  process.exit(0)
}

fs.mkdirSync(backupDir, { recursive: true })

const log = []
const say = (s) => { log.push(s); console.log(s) }

// 读取（剥掉可能的 BOM，避免自己成为 BOM 的搬运工）
const readNoBom = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const writeNoBom = (p, s) => fs.writeFileSync(p, s, { encoding: 'utf8' })
const hasBom = (p) => fs.readFileSync(p)[0] === 0xef && fs.readFileSync(p)[1] === 0xbb && fs.readFileSync(p)[2] === 0xbf

say(`backup dir: ${backupDir}`)

// ── 1) 备份 ──────────────────────────────────────────────
for (const f of [PKG, PATCH]) {
  const dst = path.join(backupDir, path.basename(f))
  fs.copyFileSync(f, dst)
  say(`backup  ${path.basename(f)}  (BOM: ${hasBom(f) ? 'PRESENT' : 'none'})`)
}

// ── 2) 移动包目录到备份区 ────────────────────────────────
for (const name of REMOVE_PACKAGES) {
  const src = path.join(NM, ...name.split('/'))
  if (!fs.existsSync(src)) { say(`skip    ${name}  (未安装)`) ; continue }
  const dst = path.join(backupDir, 'node_modules', ...name.split('/'))
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.renameSync(src, dst)
  say(`moved   ${name}  ->  backup/node_modules/${name}`)
}

// 2b) 清掉因移走作用域包而变空的 scope 目录（如 node_modules/@linxin666/）
//     留着空目录会让后续 grep/扫描误以为包还在
for (const name of REMOVE_PACKAGES) {
  const parts = name.split('/')
  if (parts.length < 2) continue
  const scopeDir = path.join(NM, parts[0])
  if (!fs.existsSync(scopeDir)) continue
  try {
    if (fs.readdirSync(scopeDir).length === 0) {
      fs.rmdirSync(scopeDir)
      say(`rmdir   ${parts[0]}/  (空 scope 目录)`)
    }
  } catch { /* 非空或占用则保留 */ }
}

// ── 3) profile package.json：移除依赖 + bundle 注册 ──────
{
  const j = JSON.parse(readNoBom(PKG))
  const deps = j.dependencies ?? {}
  for (const name of REMOVE_PACKAGES) {
    if (name in deps) { delete deps[name]; say(`deps    - ${name}`) }
  }
  j.dependencies = deps

  const bundles = j.dsh?.profile?.bundles ?? []
  const kept = bundles.filter((b) => !REMOVE_PACKAGES.includes(b))
  if (kept.length !== bundles.length) {
    for (const b of bundles) if (REMOVE_PACKAGES.includes(b)) say(`bundles - ${b}`)
    j.dsh.profile.bundles = kept
  }
  writeNoBom(PKG, JSON.stringify(j, null, 2) + '\n')
  say(`wrote   package.json   deps=[${Object.keys(deps).join(', ')}]`)
  say(`wrote   package.json   bundles=[${kept.join(', ')}]`)
}

// ── 4) cordis.patch.yml：移除 `- id: pet` 覆盖块 ─────────
{
  let y = readNoBom(PATCH)
  const anchor = [
    '# 桌宠已全部禁用（catpet 客户端打包不注册；@linxin666/dsh-pet 亦 disabled）',
    '# 禁用原桌宠插件（与catpet冲突，二选一）',
    '- id: pet',
    '  disabled: true',
    '',
  ].join('\n')

  const replacement = [
    '# 两个桌宠均已【彻底移除】（2026-09-14，见 scripts/remove-desktop-pets.mjs）：',
    '#   - @linxin666/dsh-pet   ← 已从 dsh.profile.bundles 与 dependencies 移除',
    '#   - catpet-desktop-pet   ← 已从 dependencies 移除，且 node_modules 目录已移走',
    '# 不再需要 `- id: pet` 覆盖块：包不装配时，针对它的 id 覆盖会变成悬空引用。',
    '# 两个包目录已备份至 ~/.dsh/.backup/removed-desktop-pets-<ts>/node_modules/，可原样还原。',
    '',
  ].join('\n')

  if (!y.includes(anchor)) {
    say('WARN    cordis.patch.yml 未找到 pet 覆盖块锚点，未改动（请人工确认）')
  } else {
    y = y.replace(anchor, replacement)
    writeNoBom(PATCH, y)
    say('wrote   cordis.patch.yml  (- id: pet 覆盖块已移除)')
  }
}

// ── 5) 自检 ──────────────────────────────────────────────
say('--- self-check ---')
for (const f of [PKG, PATCH]) {
  say(`BOM ${path.basename(f)}: ${hasBom(f) ? 'PRESENT(bad)' : 'none(ok)'}`)
}
const after = JSON.parse(readNoBom(PKG))
const stillDeps = REMOVE_PACKAGES.filter((n) => n in (after.dependencies ?? {}))
const stillBundles = REMOVE_PACKAGES.filter((n) => (after.dsh?.profile?.bundles ?? []).includes(n))
say(`残留依赖: ${stillDeps.length ? stillDeps.join(', ') : '无'}`)
say(`残留 bundle: ${stillBundles.length ? stillBundles.join(', ') : '无'}`)

fs.writeFileSync(path.join(ROOT, 'out', 'remove-desktop-pets.txt'), log.join('\n'), 'utf8')
