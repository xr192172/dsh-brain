// launch-arm.mjs —— 按臂起代（两种模式：print | flip，必须显式选）
//
// 用法：
//   node scripts/delegation/launch-arm.mjs --arm <arm> [--arms evals/arms.json] --mode print|flip
//     [--record] [--i-know-this-flips-live]
//
// - 读 evals/arms.json（用 arms-registry.mjs 的 loadArmsRegistry，不自己 parse）
// - 产出该臂这一代的启动规格
// - --mode print（缺省）：只打印，不做任何副作用
// - --mode flip：调现役前门的换代入口（必须同时给 --i-know-this-flips-live，否则拒绝运行）
// - 每次成功（或 print 模式带 --record）都往 out/arm-gen-index.json 追加一条
// - 若臂定义里字段不全 => 报错停下（不许静默降级）
//
// 绝对不许真的换现役代：--mode flip 不给 --i-know-this-flips-live => 非 0 退出

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── CLI 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const hasFlag = (k) => argv.includes(k)

const armName = argOf('--arm')
const armsFile = argOf('--arms') ?? 'evals/arms.json'
const mode = argOf('--mode') ?? 'print'
const record = hasFlag('--record')
const knowThisFlips = hasFlag('--i-know-this-flips-live')

if (!armName) {
  console.error('[用法] 需要 --arm <arm>')
  process.exit(3)
}
if (!['print', 'flip'].includes(mode)) {
  console.error('[用法] --mode 只能是 print 或 flip')
  process.exit(3)
}

// ── 加载 arms-registry.mjs ─────────────────────────────────────────────────────
const registryRequire = createRequire('D:/project_develop/dsh-brain/scripts/arms-registry.mjs')
const { loadArmsRegistry } = registryRequire('D:/project_develop/dsh-brain/scripts/arms-registry.mjs')

let registry
try {
  registry = loadArmsRegistry(armsFile, { base: process.cwd() })
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

// ── 生成启动规格 ───────────────────────────────────────────────────────────────
const ts = new Date().toISOString()
const gen = `gen-${Date.now()}`
const profile = arm.preset ?? 'standard'
const isolationHome = path.resolve(process.cwd(), 'out', `${arm.name.toLowerCase()}-dshhome`)
const overlayDir = path.resolve(process.cwd(), 'out', `arm-overlay-${arm.name.toLowerCase()}`)

const launchSpec = {
  arm: arm.name,
  role: arm.role,
  label: arm.label,
  cwd: arm.cwd,
  store: arm.store,
  profile,
  isolationHome,
  overlayDir,
  env: {
    ARM_ISOLATION_SELF: arm.name,
    DSH_HOME: isolationHome,
    DSH_PERMISSION_MODE: 'workspace-write',
    _overlayDir: overlayDir,
  },
  at: ts,
}

// ── 打印隔离实例启动命令 ───────────────────────────────────────────────────────
const startCmd = [
  '# 臂 ' + arm.name + ' 隔离实例启动命令（请在你的终端手动执行）',
  '',
  '# 1. 建隔离 DSH_HOME',
  'mkdir -p "' + isolationHome.replace(/\\/g, '/') + '"',
  '',
  '# 2. 初始化 capability registry',
  'node scripts/capability-registry.mjs init --home "' + isolationHome.replace(/\\/g, '/') + '"',
  '',
  '# 3. 起隔离实例（独立端口段，不与现役冲突）',
  'DSH_HOME="' + isolationHome.replace(/\\/g, '/') + '" node scripts/start-switchboard.mjs',
].join('\n')

// ── --mode print ────────────────────────────────────────────────────────────────
if (mode === 'print') {
  const sep = '='.repeat(61)
  console.log('')
  console.log(sep)
  console.log('  arm=' + arm.name + ' 启动规格（print 模式，无副作用）')
  console.log(sep)
  console.log('  arm     : ' + arm.name)
  console.log('  role    : ' + arm.role)
  console.log('  label   : ' + arm.label)
  console.log('  cwd     : ' + arm.cwd.replace(/\\/g, '/'))
  console.log('  store   : ' + arm.store.replace(/\\/g, '/'))
  console.log('  profile : ' + profile)
  console.log('  isolation DSH_HOME: ' + isolationHome.replace(/\\/g, '/'))
  console.log('  overlay : ' + overlayDir.replace(/\\/g, '/'))
  console.log('')
  console.log('  隔离实例启动命令（请复制到终端执行）：')
  console.log(startCmd)
  console.log(sep)

  if (record) {
    const indexPath = path.resolve(process.cwd(), 'out', 'arm-gen-index.json')
    fs.mkdirSync(path.dirname(indexPath), { recursive: true })
    let index = []
    if (fs.existsSync(indexPath)) {
      try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) } catch { index = [] }
    }
    index.push({ arm: arm.name, gen, profile, cwd: arm.cwd, store: arm.store, at: ts, mode, note: 'print+record' })
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
    console.log('[record] appended to ' + indexPath.replace(/\\/g, '/'))
  }

  process.exit(0)
}

// ── --mode flip ────────────────────────────────────────────────────────────────
if (mode === 'flip') {
  if (!knowThisFlips) {
    const sep = '='.repeat(61)
    console.log('')
    console.log(sep)
    console.log('  REJECTED: --mode flip without --i-know-this-flips-live')
    console.log(sep)
    console.log('  arm  : ' + arm.name)
    console.log('  reason: --mode flip calls the live front door handover entry')
    console.log('          (?cmd=handover&profile=<name>), which REPLACES the current active gen.')
    console.log('          Must pass --i-know-this-flips-live explicitly to allow.')
    console.log('  fix   : node scripts/delegation/launch-arm.mjs --arm ' + arm.name + ' --mode flip --i-know-this-flips-live')
    console.log(sep)
    process.exit(1)
  }

  // 安全约束：即使给了 flag，也不真的发起 handover 请求
  const sep = '='.repeat(61)
  console.log('')
  console.log(sep)
  console.log('  arm=' + arm.name + ' 启动规格（flip 模式，已给 --i-know-this-flips-live）')
  console.log(sep)
  console.log('  arm      : ' + arm.name)
  console.log('  role     : ' + arm.role)
  console.log('  profile  : ' + profile)
  console.log('  cwd      : ' + arm.cwd.replace(/\\/g, '/'))
  console.log('  store    : ' + arm.store.replace(/\\/g, '/'))
  console.log('  isolation DSH_HOME: ' + isolationHome.replace(/\\/g, '/'))
  console.log('')
  console.log('  换代入口命令（请手动在终端执行，本脚本不自动发起）：')
  console.log('  curl "http://127.0.0.1:3080/?cmd=handover&profile=' + profile + '"')
  console.log('')
  console.log('  NOTE: 已跳过实际 handover 调用（任务安全约束：不碰现役）')
  console.log(sep)

  // 写索引
  const indexPath = path.resolve(process.cwd(), 'out', 'arm-gen-index.json')
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  let index = []
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) } catch { index = [] }
  }
  index.push({ arm: arm.name, gen, profile, cwd: arm.cwd, store: arm.store, at: ts, mode, note: 'flip-safe-skipped-handover' })
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  console.log('[record] appended to ' + indexPath.replace(/\\/g, '/'))

  process.exit(0)
}