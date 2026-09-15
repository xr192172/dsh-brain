#!/usr/bin/env node
/**
 * test-plugin-hygiene.mjs —— 插件卫生门的**自证**
 *
 * 依 `gate-authoring` 的纪律：**写完门一定要构造一个「应该红」的输入看它是否真的红。**
 * 否则门可能是个"一律绿"的摆设 —— 那是比没有门更坏的假绿。
 *
 * 证两个方向：
 *   ① 该红的红：目录缺失 / 缺产物 / 缺 patch / 缺 dsh.bundle / 缺链接 / 悬空链接 / 带 BOM
 *      ⇒ `ERROR` 且退出码非 0；
 *   ② 该绿的绿：干净夹具 ⇒ 0 ERROR、退出 0；且 **WARN 默认不让门失败**
 *      （"可能有意为之"的项一律判红 ⇒ 门会被绕过 ⇒ 比不设门更糟）。
 *
 * 做法：用 `--profile-dir / --packages-dir / --json` 指向 `out/` 里的夹具，
 * `DSH_HOME` 也指向夹具 ⇒ **绝不触碰真实 profile 与真实 ~/.dsh**（开头结尾双向断言）。
 *
 * 用法：node scripts/test-plugin-hygiene.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/project_develop/dsh-brain'
const GATE = path.join(REPO, 'scripts/check-plugin-hygiene.mjs')
const FIX = path.join(REPO, 'out/hygiene-fixtures')
const REAL_HOME = 'C:/Users/Admin/.dsh'
const REAL_PROFILE = path.join(REAL_HOME, 'profiles/web')

let pass = 0
let fail = 0
const failures = []
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log('  FAIL ' + n + ' — ' + d) }
const eq = (n, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(n)
  else bad(n, `期望 ${w}，实得 ${g}`)
}
const truthy = (n, v, d = '') => (v ? ok(n) : bad(n, d || `期望为真，实得 ${JSON.stringify(v)}`))

// 双向保险：真实状态快照
const snap = (p) => {
  try {
    const st = fs.statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch { return 'MISSING' }
}
const before = { home: snap(path.join(REAL_HOME, 'pet.json')), prof: snap(path.join(REAL_PROFILE, 'package.json')) }

const SCOPE = '@dsh-brain/'

/**
 * 造一套夹具。
 * @param {object} o
 *  - bundles: string[]（bundle 名，不带 scope）
 *  - link: (name) => 'ok'|'missing'|'dangling'
 *  - breakPkg: (name) => null | 'no-dir' | 'no-lib' | 'no-patch' | 'no-bundle-decl' | 'stale-src'
 *  - extraPkg: string[]  仓库里有、但没启用的包目录
 *  - bom: boolean        manifest 是否带 BOM
 *  - residue: boolean    放一个 pet.json
 */
function buildFixture(tag, o) {
  const root = path.join(FIX, tag)
  fs.rmSync(root, { recursive: true, force: true })
  const home = path.join(root, 'home')
  const profile = path.join(home, 'profiles', 'web')
  const packages = path.join(root, 'packages')
  fs.mkdirSync(path.join(profile, 'node_modules', SCOPE), { recursive: true })
  fs.mkdirSync(packages, { recursive: true })

  for (const name of o.bundles) {
    const brk = o.breakPkg?.(name) ?? null
    if (brk === 'no-dir') continue // 干脆不建目录
    const base = path.join(packages, name)
    fs.mkdirSync(base, { recursive: true })
    if (brk !== 'no-lib') {
      fs.mkdirSync(path.join(base, 'lib'), { recursive: true })
      fs.writeFileSync(path.join(base, 'lib', 'index.js'), 'export const x = 1\n', 'utf8')
    }
    if (brk !== 'no-patch') fs.writeFileSync(path.join(base, 'cordis.patch.yml'), '- insert: []\n', 'utf8')
    const pkg = { name: SCOPE + name, version: '0.0.0' }
    if (brk !== 'no-bundle-decl') pkg.dsh = { bundle: {} }
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')

    if (brk === 'stale-src') {
      const src = path.join(base, 'src')
      fs.mkdirSync(src, { recursive: true })
      const f = path.join(src, 'index.ts')
      fs.writeFileSync(f, 'export const y = 2\n', 'utf8')
      const future = Date.now() + 60_000
      fs.utimesSync(f, future / 1000, future / 1000)
    }

    // profile 侧链接
    const mode = o.link?.(name) ?? 'ok'
    const link = path.join(profile, 'node_modules', SCOPE, name)
    if (mode === 'missing') continue
    const target = mode === 'dangling' ? path.join(root, 'gone', name) : base
    try {
      fs.symlinkSync(target, link, 'junction')
    } catch {
      try { fs.symlinkSync(target, link) } catch { /* 无权限则跳过该夹具的链接 */ }
    }
  }

  for (const name of o.extraPkg ?? []) {
    const base = path.join(packages, name)
    fs.mkdirSync(path.join(base, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(base, 'lib', 'index.js'), '', 'utf8')
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: SCOPE + name, version: '0.0.0' }), 'utf8')
  }

  // manifest 的 dependencies = 各 bundle 的 link 声明（干净夹具就应当一致）
  const depsObj = {}
  for (const n of o.bundles) depsObj[SCOPE + n] = `link:${path.join(packages, n).replace(/\\/g, '/')}`

  const manifest = {
    name: 'fixture-profile',
    dsh: { profile: { bundles: o.bundles.map((n) => SCOPE + n) } },
    dependencies: depsObj,
  }
  const body = JSON.stringify(manifest, null, 2) + '\n'
  fs.writeFileSync(path.join(profile, 'package.json'), o.bom ? '\uFEFF' + body : body, 'utf8')

  // lock：match（一致）| missing（漏一条）| stale（多一条陈旧）| absent（没有）
  const lockMode = o.lock ?? 'match'
  if (lockMode !== 'absent') {
    const lockDeps = { ...depsObj }
    if (lockMode === 'missing') delete lockDeps[SCOPE + o.bundles[0]]
    if (lockMode === 'stale') lockDeps[SCOPE + 'ghost'] = 'link:Z:/nope'
    const L = [
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: false',
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
    ]
    for (const [k, v] of Object.entries(lockDeps)) {
      L.push(`      '${k}':`, `        specifier: ${v}`, `        version: ${v}`)
    }
    L.push('', 'packages:', '')
    fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), L.join('\n'), 'utf8')
  }

  if (o.residue) fs.writeFileSync(path.join(home, 'pet.json'), '{}\n', 'utf8')

  return { root, home, profile, packages }
}

function run(f, extraEnv = {}, args = []) {
  const r = spawnSync(process.execPath, [GATE, '--profile-dir', f.profile, '--packages-dir', f.packages, '--json', ...args], {
    env: { ...process.env, DSH_HOME: f.home, ...extraEnv },
    encoding: 'utf8',
  })
  let parsed = null
  try { parsed = JSON.parse(r.stdout) } catch { /* 留给断言看 stdout */ }
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? ''), json: parsed }
}
const levels = (j) => (j?.findings ?? []).map((f) => f.level)
const idsOf = (j, level) => (j?.findings ?? []).filter((f) => f.level === level).map((f) => f.id)

fs.rmSync(FIX, { recursive: true, force: true })

console.log('== ① 干净夹具 ⇒ 该绿就绿 ==')
{
  const f = buildFixture('clean', { bundles: ['alpha', 'beta'], residue: false })
  const r = run(f)
  eq('干净 ⇒ 退出 0', r.code, 0)
  eq('干净 ⇒ 0 ERROR', idsOf(r.json, 'ERROR'), [])
  truthy('有 JSON 输出（可机读）', r.json !== null, r.out.slice(0, 200))
}

console.log('== ② 各种坏法 ⇒ 该红就红 ==')
const cases = [
  ['no-dir', '包目录整个缺失', (o) => o.bundles.includes('beta')],
  ['no-lib', '缺编译产物 lib/index.js', () => true],
  ['no-patch', '缺 cordis.patch.yml', () => true],
  ['no-bundle-decl', 'package.json 缺 dsh.bundle', () => true],
]
for (const [brk, label] of cases) {
  const f = buildFixture(`brk-${brk}`, { bundles: ['alpha'], breakPkg: () => brk })
  const r = run(f)
  eq(`${label} ⇒ 退出 1`, r.code, 1)
  truthy(`${label} ⇒ 报 ERROR`, idsOf(r.json, 'ERROR').includes('alpha'), JSON.stringify(idsOf(r.json, 'ERROR')))
}

console.log('== ③ 链接问题 ==')
{
  const f = buildFixture('link-missing', { bundles: ['alpha'], link: () => 'missing' })
  const r = run(f)
  eq('profile 缺链接 ⇒ 退出 1', r.code, 1)
  truthy('报出缺链接', idsOf(r.json, 'ERROR').includes('alpha'))
}
{
  const f = buildFixture('link-dangling', { bundles: ['alpha'], link: () => 'missing' })
  // ★ 悬空链接那条分支（link 在、但目标不可读）没法用真符号链接验（本机无权限），
  //   但它的判据是「link 路径存在 且 link/package.json 不存在」——
  //   用一个**空目录**当 link 就能命中同一条分支，不必依赖符号链接权限。
  fs.mkdirSync(path.join(f.profile, 'node_modules', SCOPE, 'alpha'), { recursive: true })
  const r = run(f)
  eq('链接目标不可读 ⇒ 退出 1', r.code, 1)
  truthy('报出悬空/不可读', idsOf(r.json, 'ERROR').includes('alpha'), JSON.stringify(r.json?.findings))
  eq('不误报成"缺链接"', (r.json?.findings ?? []).some((x) => x.what.includes('没有该包的链接')), false)
}

console.log('== ④ BOM ==')
{
  const f = buildFixture('bom', { bundles: ['alpha'], bom: true })
  const r = run(f)
  eq('manifest 带 BOM ⇒ 退出 1', r.code, 1)
  truthy('报出 BOM', idsOf(r.json, 'ERROR').includes('profile'))
}

console.log('== ⑤ WARN 默认不让门失败（关键：一律判红会让门被绕过）==')
{
  const f = buildFixture('warn-only', { bundles: ['alpha'], extraPkg: ['orphan'], residue: true })
  const r = run(f)
  eq('只有 WARN ⇒ 退出 0', r.code, 0)
  truthy('仍报出未启用包', idsOf(r.json, 'WARN').includes('orphan'))
  truthy('仍报出遗留状态文件', idsOf(r.json, 'WARN').includes('pet.json'))
  const r2 = run(f, {}, ['--strict'])
  eq('--strict ⇒ WARN 也失败', r2.code, 1)
}

console.log('== ⑥ 源码比产物新 ⇒ WARN ==')
{
  const f = buildFixture('stale', { bundles: ['alpha'], breakPkg: (n) => (n === 'alpha' ? 'stale-src' : null) })
  const r = run(f)
  truthy('报出源码比产物新', idsOf(r.json, 'WARN').includes('alpha'), JSON.stringify(r.json?.findings))
  eq('仅为 WARN，不失败', r.code, 0)
}

console.log('== ⑥b lock 与 manifest 一致性（卫生门此前没查的盲区）==')
{
  const f = buildFixture('lock-match', { bundles: ['alpha'] })
  const r = run(f)
  eq('lock 一致 ⇒ 退出 0', r.code, 0)
  eq('lock 一致 ⇒ 无 ERROR', idsOf(r.json, 'ERROR'), [])
}
{
  const f = buildFixture('lock-missing', { bundles: ['alpha', 'beta'], lock: 'missing' })
  const r = run(f)
  eq('lock 漏依赖 ⇒ 退出 1', r.code, 1)
  truthy('报出"lock 里没有该依赖"', (r.json?.findings ?? []).some((x) => x.level === 'ERROR' && x.what.includes('lock 里没有')))
}
{
  const f = buildFixture('lock-stale', { bundles: ['alpha'], lock: 'stale' })
  const r = run(f)
  eq('陈旧 lock 条目 ⇒ 不失败（WARN）', r.code, 0)
  truthy('报出陈旧条目', idsOf(r.json, 'WARN').includes(SCOPE + 'ghost'), JSON.stringify(idsOf(r.json, 'WARN')))
}
{
  const f = buildFixture('lock-absent', { bundles: ['alpha'], lock: 'absent' })
  const r = run(f)
  eq('没有 lock ⇒ 不失败（WARN）', r.code, 0)
  truthy(
    '明确说"无法核对"而非假装通过',
    (r.json?.findings ?? []).some((x) => `${x.what} ${x.detail ?? ''}`.includes('无法核对')),
  )
}

console.log('== ⑦ 安全：未触碰真实 profile / ~/.dsh ==')
{
  const after = { home: snap(path.join(REAL_HOME, 'pet.json')), prof: snap(path.join(REAL_PROFILE, 'package.json')) }
  eq('真实 pet.json 未变', after.home, before.home)
  eq('真实 profile manifest 未变', after.prof, before.prof)
}

fs.rmSync(FIX, { recursive: true, force: true })

console.log('\n=========================================')
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) for (const f of failures) console.log('  · ' + f)
process.exit(fail ? 1 : 0)
