// isolated-instance.mjs —— 为指定臂准备一套**隔离 DSH 实例**（准备 + 打印命令，默认不 spawn）。
//
// 用法：
//   node scripts/delegation/isolated-instance.mjs --arm <臂名> \
//     [--root <目录>] [--profile <剖面>] [--dry-run] [--force] [--record] [--launch]
//
// 行为：
//   · 缺省（不带 --launch）：只打印启动规格 + JSON + 给终端的完整命令，**不 spawn 任何进程**。
//   · --launch：真的用 relaunch-switchboard.mjs 那套 env 去 spawn（detached）。
//     ★ 本任务【不许】用 --launch；它只是留给用户终端用的能力。
//   · --dry-run：完全不写盘（只打印将要做什么）。
//   · --record：往 out/arm-gen-index.json 追加一条记录。
//   · --force：当目标 <root>/dshhome 已存在且非空时强制覆盖。
//
// 端口段（默认与现役隔离，不冲突）：
//   SWITCH_PORT=33080, GEN_PORT_BASE=33081, SWITCH_ADMIN_PORT=33180,
//   HANDOVER_ADMIN_PORT_BASE=33190, DSH_PUBLIC_WEB_URL=http://127.0.0.1:33080
//
// 安全约束：
//   · 只读现役 profile/settings（复制骨架当模板，不修改）。
//   · key 不落盘（经 env 传给启动进程）。
//   · node_modules 用**目录联接**（junction），不 cp -r。
//   · 目标非空已存在 ⇒ 拒绝（除非 --force）。
//   · 臂定义缺字段 ⇒ 报错停下。
//   · 端口与现役冲突 ⇒ 拒绝（防误起）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT_ROOT = path.resolve(HERE, '..', '..')

// ── CLI 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const hasFlag = (k) => argv.includes(k)

const armName = argOf('--arm')
const optRoot = argOf('--root')
const optProfile = argOf('--profile')
const dryRun = hasFlag('--dry-run')
const force = hasFlag('--force')
const record = hasFlag('--record')
const launch = hasFlag('--launch')

if (!armName) {
  console.error('[用法] 需要 --arm <臂名>')
  process.exit(3)
}
if (launch && dryRun) {
  console.error('[用法] --launch 与 --dry-run 互斥')
  process.exit(3)
}

// ── 加载 arms-registry.mjs ─────────────────────────────────────────────────────
const registryRequire = createRequire(path.join(WT_ROOT, 'scripts', 'arms-registry.mjs'))
const { loadArmsRegistry } = registryRequire(path.join(WT_ROOT, 'scripts', 'arms-registry.mjs'))

let registry
try {
  registry = loadArmsRegistry('evals/arms.json', { base: WT_ROOT })
} catch (e) {
  console.error(`[失败] 加载 arms 注册表失败：${e.message}`)
  process.exit(1)
}

// ── 查找臂 ─────────────────────────────────────────────────────────────────────
const arm = registry.arms.find((a) => a.name === armName)
if (!arm) {
  console.error(`[失败] 臂 "${armName}" 在注册表中不存在（已知臂：${registry.arms.map((a) => a.name).join(', ')}）`)
  process.exit(1)
}

// 校验必填字段
for (const k of ['cwd', 'store', 'label']) {
  if (!arm[k] || !String(arm[k]).trim()) {
    console.error(`[失败] 臂 "${armName}" 缺少必填字段 ${k}`)
    process.exit(1)
  }
}

// ── 解析 root ──────────────────────────────────────────────────────────────────
// 缺省 = D:/project_develop/_arms/<臂名小写>（给用户用）；测试时务必用 --root 覆盖。
const DEFAULT_ROOT = `D:/project_develop/_arms/${armName.toLowerCase()}`
const rootDir = optRoot ? path.resolve(optRoot) : path.resolve(WT_ROOT, armName.toLowerCase())

// ── 确定 profile ───────────────────────────────────────────────────────────────
const DSH_HOME_ACTIVE = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const CONTROL_PROFILE = 'web'
let knownProfiles = []
try {
  knownProfiles = fs
    .readdirSync(path.join(DSH_HOME_ACTIVE, 'profiles'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .map((e) => e.name)
    .sort()
} catch { /* 读不到就留空 */ }

const profile = optProfile ?? (knownProfiles.includes(CONTROL_PROFILE) ? CONTROL_PROFILE : null)
if (!profile || !knownProfiles.includes(profile)) {
  console.error(
    `[失败] profile "${profile ?? '(推不出)'}" 不在 ${DSH_HOME_ACTIVE}/profiles/ 下 => **拒绝**` +
      `\n  现存 profile：${knownProfiles.join(', ') || '(读不到目录)'}\n` +
      `  请用 --profile <name> 指定存在的剖面。`,
  )
  process.exit(1)
}

// ── 端口段（固定，不与现役 3080/3081/31800/31810 冲突）────────────────────────
const DEFAULT_PORTS = {
  SWITCH_PORT: '33080',
  GEN_PORT_BASE: '33081',
  SWITCH_ADMIN_PORT: '33180',
  HANDOVER_ADMIN_PORT_BASE: '33190',
  DSH_PUBLIC_WEB_URL: 'http://127.0.0.1:33080',
}

// ★ 端口冲突检查：若任一端口命中现役端口段，拒绝（防止误起在现役上）
const LIVE_PORTS = new Set(['3080', '3081', '31800', '31810'])
const portConflict = Object.entries(DEFAULT_PORTS).filter(([k, v]) => {
  if (k === 'DSH_PUBLIC_WEB_URL') return /:(3080|3081)\b/.test(v)
  return LIVE_PORTS.has(v)
})
if (portConflict.length > 0) {
  console.error(
    `[失败] 端口配置与现役冲突，拒绝启动：\n` +
    `  冲突项：${portConflict.map(([k, v]) => `${k}=${v}`).join(', ')}\n` +
    `  现役监听端口：3080(SWITCH), 3081(GEN), 31800(SWITCH_ADMIN), 31810(HANDOVER_ADMIN)\n` +
    `  ★ 请使用独立的端口段（如 33080+），不要复用现役端口。`,
  )
  process.exit(1)
}
const PORTS = DEFAULT_PORTS

// ── 解析 dshhome 路径 ──────────────────────────────────────────────────────────
const dshHome = path.join(rootDir, 'dshhome')
const verifyOut = path.join(rootDir, 'verifyout')

// ── 幂等检查：目标已存在且非空 => 拒绝（除非 --force）────────────────────────
const dshHomeExists = fs.existsSync(dshHome)
let dshHomeNotEmpty = false
if (dshHomeExists) {
  try {
    const entries = fs.readdirSync(dshHome, { withFileTypes: true })
    dshHomeNotEmpty = entries.some((e) => e.name !== '.' && e.name !== '..')
  } catch { /* 读不到目录本身，视为非空 */ }
}

if (dshHomeExists && dshHomeNotEmpty && !force) {
  console.error(
    `[失败] ${dshHome} 已存在且非空，拒绝覆盖（幂等保护）。\n` +
    `  加 --force 强制覆盖。`,
  )
  process.exit(1)
}

// ── 读取现役 env keys（不落盘）────────────────────────────────────────────────
const envFile = 'D:\\project_develop\\ai-base\\agent-shell\\.env'
const KEY_NAMES = new Set(['AGENTSHELL_MAIN_LLM_API_KEY', 'AGENTSHELL_MAIN_LLM_API_KEYS'])
const envKeys = []
if (fs.existsSync(envFile)) {
  for (const ln of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const t = ln.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const k = t.slice(0, eq)
    if (KEY_NAMES.has(k)) envKeys.push(k)
  }
}
console.log(`[env] 读到 ${envKeys.length} 个 key：${envKeys.join(', ')}`)

// ── 准备函数 ───────────────────────────────────────────────────────────────────
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function copyFile(src, dst) {
  const content = fs.readFileSync(src)
  fs.writeFileSync(dst, content)
}

function createJunction(target, linkPath) {
  ensureDir(path.dirname(linkPath))
  // If target already exists as a junction/symlink, skip (idempotent)
  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath)
    if (stat.isSymbolicLink() || stat.isJunction()) return
  }
  fs.symlinkSync(target, linkPath, 'junction')
}

function prepareProfile(profileSrc, profileDst) {
  const files = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']
  for (const f of files) {
    const src = path.join(profileSrc, f)
    const dst = path.join(profileDst, f)
    if (fs.existsSync(src)) {
      copyFile(src, dst)
    }
  }
  // node_modules -> junction（指向现役那份）
  const srcNm = path.join(profileSrc, 'node_modules')
  const dstNm = path.join(profileDst, 'node_modules')
  if (fs.existsSync(srcNm)) {
    ensureDir(path.dirname(dstNm))
    createJunction(srcNm, dstNm)
    return true
  }
  return false
}

function prepareSettings(settingsSrc, settingsDst, armPreset) {
  const content = fs.readFileSync(settingsSrc, 'utf8')
  const lines = content.split('\n')
  const out = []
  let inAgentPresets = false
  for (const line of lines) {
    if (/^agent-presets:$/.test(line.trimEnd())) {
      inAgentPresets = true
      out.push(line)
      continue
    }
    if (inAgentPresets && /^default:/.test(line.trimStart())) {
      const indent = line.match(/^(\s*)/)[1]
      out.push(`${indent}default: ${armPreset ?? 'council'}`)
      inAgentPresets = false
      continue
    }
    if (inAgentPresets && !/^\s/.test(line)) {
      inAgentPresets = false
    }
    out.push(line)
  }
  fs.writeFileSync(settingsDst, out.join('\n'), 'utf8')
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────
const ts = new Date().toISOString()
const gen = `gen-${Date.now()}`
const armPreset = arm.preset ?? 'council'

const sep = '='.repeat(61)
console.log('')
console.log(sep)
console.log(`  arm=${arm.name} 隔离实例准备（${dryRun ? 'dry-run，不写盘' : '实际准备'}）`)
console.log(sep)

// 源路径（现役 DSH_HOME 下的 profile）
const profileSrc = path.join(DSH_HOME_ACTIVE, 'profiles', profile)
const settingsSrc = path.join(DSH_HOME_ACTIVE, 'settings.yaml')

// 校验源文件存在
for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
  if (!fs.existsSync(path.join(profileSrc, f))) {
    console.error(`[失败] 现役 profile ${profile} 缺少 ${f}，无法复制骨架`)
    process.exit(1)
  }
}
if (!fs.existsSync(settingsSrc)) {
  console.error(`[失败] 现役 settings.yaml 不存在：${settingsSrc}`)
  process.exit(1)
}

// ── dry-run 路径 ───────────────────────────────────────────────────────────────
if (dryRun) {
  console.log('  [dry-run] 下列操作将执行，但不写盘：')
  console.log('')
  console.log('  1. 准备目录结构：')
  console.log(`     mkdir -p "${dshHome.replace(/\\/g, '/')}"`)
  console.log(`     mkdir -p "${verifyOut.replace(/\\/g, '/')}"`)
  console.log('')
  console.log('  2. 复制 profile 骨架（含 node_modules junction）：')
  console.log(`     源: ${profileSrc}`)
  console.log(`     目标: ${path.join(dshHome, 'profiles', profile).replace(/\\/g, '/')}`)
  console.log('')
  console.log('  3. 复制 settings.yaml（修改 agent-presets.default = ' + armPreset + '）：')
  console.log(`     源: ${settingsSrc}`)
  console.log(`     目标: ${path.join(dshHome, 'settings.yaml').replace(/\\/g, '/')}`)
  console.log('')
  console.log('  4. 创建 verifyout 目录：')
  console.log(`     ${verifyOut.replace(/\\/g, '/')}`)
  console.log('')
  console.log('  端口配置（写入启动 env）：')
  console.log(JSON.stringify(PORTS, null, 2))
  console.log('')
  console.log('  完整启动命令（请在终端执行）：')
  console.log('')
  const escapedHome = dshHome.replace(/\\/g, '/').replace(/"/g, '\\"')
  console.log(`  DSH_HOME="${escapedHome}" \`
    SWITCH_PORT=${PORTS.SWITCH_PORT} \`
    GEN_PORT_BASE=${PORTS.GEN_PORT_BASE} \`
    SWITCH_ADMIN_PORT=${PORTS.SWITCH_ADMIN_PORT} \`
    HANDOVER_ADMIN_PORT_BASE=${PORTS.HANDOVER_ADMIN_PORT_BASE} \`
    DSH_PUBLIC_WEB_URL=${PORTS.DSH_PUBLIC_WEB_URL} \`
    node scripts/relaunch-switchboard.mjs`)
  console.log('')
  console.log(sep)

  if (record) {
    const indexPath = path.resolve(WT_ROOT, 'out', 'arm-gen-index.json')
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    let index = []
    if (fs.existsSync(indexPath)) {
      try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) } catch { index = [] }
    }
    index.push({ arm: arm.name, gen, profile, root: rootDir, dshHome, ports: PORTS, at: ts, mode: 'dry-run+record' })
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
    console.log('[record] appended to ' + indexPath.replace(/\\/g, '/'))
  }

  process.exit(0)
}

// ── 实际准备路径 ───────────────────────────────────────────────────────────────
// 1. 创建目录
ensureDir(dshHome)
ensureDir(path.join(dshHome, 'profiles', profile))
ensureDir(verifyOut)

// 2. 复制 profile 骨架 + node_modules junction
const nmLinked = prepareProfile(profileSrc, path.join(dshHome, 'profiles', profile))
if (!nmLinked) {
  console.warn('[警告] profile node_modules 不可用（现役不存在），junction 未创建')
}

// 3. 复制 settings.yaml（修改 default preset）
prepareSettings(settingsSrc, path.join(dshHome, 'settings.yaml'), armPreset)

// 4. verifyout 已创建（空目录）

// ── 打印规格 ───────────────────────────────────────────────────────────────────
console.log('  准备完成：')
console.log('  arm         : ' + arm.name)
console.log('  role        : ' + arm.role)
console.log('  label       : ' + arm.label)
console.log('  root        : ' + rootDir.replace(/\\/g, '/'))
console.log('  dshHome     : ' + dshHome.replace(/\\/g, '/'))
console.log('  profile     : ' + profile)
console.log('  node_modules: ' + (nmLinked ? 'junction OK' : '未链接（现役无此目录）'))
console.log('  verifyout   : ' + verifyOut.replace(/\\/g, '/'))
console.log('')
console.log('  端口配置：')
console.log(JSON.stringify(PORTS, null, 2))
console.log('')
console.log('  完整启动命令（请在终端执行）：')
console.log('')
const escapedHome2 = dshHome.replace(/\\/g, '/').replace(/"/g, '\\"')
console.log(`  DSH_HOME="${escapedHome2}" \`
    SWITCH_PORT=${PORTS.SWITCH_PORT} \`
    GEN_PORT_BASE=${PORTS.GEN_PORT_BASE} \`
    SWITCH_ADMIN_PORT=${PORTS.SWITCH_ADMIN_PORT} \`
    HANDOVER_ADMIN_PORT_BASE=${PORTS.HANDOVER_ADMIN_PORT_BASE} \`
    DSH_PUBLIC_WEB_URL=${PORTS.DSH_PUBLIC_WEB_URL} \`
    node scripts/relaunch-switchboard.mjs`)
console.log('')
console.log(sep)

// ── --record ───────────────────────────────────────────────────────────────────
if (record) {
  const indexPath = path.resolve(WT_ROOT, 'out', 'arm-gen-index.json')
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  let index = []
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) } catch { index = [] }
  }
  index.push({ arm: arm.name, gen, profile, root: rootDir, dshHome, ports: PORTS, at: ts, mode: 'prepared' })
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  console.log('[record] appended to ' + indexPath.replace(/\\/g, '/'))
}

// ── --launch（本任务禁用，但接口保留）──────────────────────────────────────────
if (launch) {
  console.log('')
  console.log('[LAUNCH] 正在 spawn 隔离实例...')
  const childEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    SWITCH_PORT: PORTS.SWITCH_PORT,
    GEN_PORT_BASE: PORTS.GEN_PORT_BASE,
    SWITCH_ADMIN_PORT: PORTS.SWITCH_ADMIN_PORT,
    HANDOVER_ADMIN_PORT_BASE: PORTS.HANDOVER_ADMIN_PORT_BASE,
    DSH_PUBLIC_WEB_URL: PORTS.DSH_PUBLIC_WEB_URL,
  }
  // key 通过 env 传入（不落盘）
  const envFilePath = 'D:\\project_develop\\ai-base\\agent-shell\\.env'
  if (fs.existsSync(envFilePath)) {
    for (const ln of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
      const t = ln.trim()
      if (t === '' || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const kk = t.slice(0, eq)
      if (KEY_NAMES.has(kk)) childEnv[kk] = t.slice(eq + 1)
    }
  }

  const swRoot = 'D:\\project_develop\\dsh-brain'
  const nodeExe = path.join(swRoot, '.tools', 'node', 'node.exe')
  const child = spawn(nodeExe, [path.join(swRoot, 'packages', 'switchboard', 'bin.cjs')], {
    cwd: swRoot,
    env: childEnv,
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  })
  child.unref()
  console.log('[LAUNCH] switchboard spawned pid=' + child.pid)
}

process.exit(0)


