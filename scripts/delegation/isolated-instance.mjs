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
//   · node_modules 是**自己的真实目录 + 逐项符号链接**（不再共享现役那份目录）。
//   · 目标非空已存在 ⇒ 拒绝（除非 --force）。
//   · 臂定义缺字段 ⇒ 报错停下。
//   · 端口与现役冲突 ⇒ 拒绝（防误起）。
//
// ★ 2026-09-25 改动：
//   · node_modules 由「junction 指现役」改为「真实目录 + 逐项 symlink」，并在其中
//     额外加入 @dsh-brain/arm-isolation（工具层护栏，dev 模式唯一安全屏障）。
//   · 启动规格与终端命令中追加 DSH_ARM_SELF / DSH_ARM_DENY（训练场身份）。
//   · DSH_ARM_DENY 来源：evals/arms.json（经 loadArmsRegistry，不自己 parse）。

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
/** ★ 2026-09-25：默认给隔离实例挂上自进化的两席；`--no-evo-seats` 可关掉（判据要用它来自证"是我们写的"）。 */
const noEvoSeats = hasFlag('--no-evo-seats')
/**
 * 自进化两席的路由，形如 `agnes/agnes-2.5-flash`（`provider/model`）。
 * ★★ 防串供（`docs/revised-architecture-2026-09-20.md:218` 逐字"产变更方不能与审批方同源"）
 *    要求两席**不同源** ⇒ 所以**分两个 flag 给**，而不是一个共用的。
 */
const parseRoute = (s) => {
  const v = (s ?? '').trim()
  if (!v) return { provider: '', model: '' }
  const i = v.indexOf('/')
  return i < 0 ? { provider: '', model: v } : { provider: v.slice(0, i), model: v.slice(i + 1) }
}
const routeDev = parseRoute(argOf('--evo-route-dev'))
const routeReview = parseRoute(argOf('--evo-route-review'))

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
/**
 * ★★ 2026-09-25 加：**防"把隔离实例当成现役"**。
 *   本脚本要用「现役的 DSH_HOME」当**源**（拷 profile / settings / 自建 preset）。
 *   但起隔离实例的那串 env 里**有 `DSH_HOME`** ⇒ 如果它在当前 shell 里还export着，
 *   再跑本脚本就会把**隔离实例**当现役 ⇒ 源与目标同一个 ⇒ 复制成空转、还可能把配置搞乱。
 *   ⇒ 判据：`DSH_HOME` 若等于本实例自己的 `<root>/dshhome` ⇒ **直接拒跑**并说明。
 */
if (optRoot && path.resolve(DSH_HOME_ACTIVE) === path.resolve(path.join(rootDir, 'dshhome'))) {
  console.error(
    `[失败] 当前 shell 里的 DSH_HOME 指向的就是【本隔离实例自己】（${DSH_HOME_ACTIVE}）⇒\n` +
      `  本脚本要拿【现役】当源，这样会把隔离实例当现役（空转/搞乱）。\n` +
      `  ⇒ 请先 \`Remove-Item Env:DSH_HOME\`（或新开一个终端）再跑。`,
  )
  process.exit(2)
}
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
/**
 * ★★ 2026-09-25 改：**端口不再手写**，改为**由「一个 base」派生**。
 *
 * 为什么要改（用户 2026-09-25 的质疑，逐字）：
 *   *"为什么我们没有一个统一的启动脚本？每一次都会出现不同样的 bug，而且按理来说不管怎么改，
 *    启动脚本是不会变的呀，为什么还要这回又多出了这种各种各样的变量？那不是应该在 Switchboard 内部吗？"*
 * ⇒ 他的诊断是对的：**变量不该由外部一件件给**。**臂名 → 端口段**是纯推导，
 *   所以只留一个自变量（`--port-base`，默认 33080；`arm-up.mjs` 会按臂序号算）。
 * ★ `POOL_PORT` **必须在同一段内**（+21）—— 实测它曾因为"没被算进段里"而**抢了现役的 3101**。
 */
const PORT_BASE = Number(argOf('--port-base') ?? 33080)
const DEFAULT_PORTS = {
  SWITCH_PORT: String(PORT_BASE),
  GEN_PORT_BASE: String(PORT_BASE + 1),
  POOL_PORT: String(PORT_BASE + 21),
  SWITCH_ADMIN_PORT: String(PORT_BASE + 100),
  HANDOVER_ADMIN_PORT_BASE: String(PORT_BASE + 110),
  DSH_PUBLIC_WEB_URL: `http://127.0.0.1:${PORT_BASE}`,
}

// ★ 端口冲突检查：若任一端口命中现役端口段，拒绝（防止误起在现役上）
const LIVE_PORTS = new Set(['3080', '3081', '3101', '31800', '31810'])
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

// ── 训练场身份（DSH_ARM_SELF / DSH_ARM_DENY）──────────────────────────────────
// DSH_ARM_SELF = 当前臂名
const ARM_SELF = arm.name.trim()
// DSH_ARM_DENY = 其它臂的 cwd + store，逗号分隔（★ 不含自己）
const OTHER_ARMS = registry.arms.filter((a) => a.name !== ARM_SELF)
const denyRoots = []
for (const a of OTHER_ARMS) {
  if (a.cwd && String(a.cwd).trim()) denyRoots.push(path.resolve(a.cwd))
  if (a.store && String(a.store).trim()) denyRoots.push(path.resolve(a.store))
}
const ARM_DENY = denyRoots.join(',')

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

/**
 * 把 srcDir 下的文件递归复制到 dstDir（只复制文件，不递归链接目标）。
 * 用于复制 pnpm 内部目录（.bin、.pnpm 等）和 hoisted 包。
 */
function copyDirRecursive(srcDir, dstDir) {
  ensureDir(dstDir)
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const e of entries) {
    const src = path.join(srcDir, e.name)
    const dst = path.join(dstDir, e.name)
    if (e.isDirectory()) {
      // 跳过 .pnpm 内部（太大），只复制顶层
      if (e.name === '.pnpm') {
        console.warn(`  [跳过] .pnpm 内部不递归复制（太大）`)
        continue
      }
      copyDirRecursive(src, dst)
    } else if (e.isFile()) {
      copyFile(src, dst)
    }
  }
}

/**
 * 准备 node_modules：真实目录 + 逐项符号链接。
 * 不再共享现役那份 node_modules 目录本身（避免改现役）。
 *
 * 做法：
 *  1. 把现役 node_modules 里的「非 @ 作用域 + 非 pnpm 内部」包按原样复制过来（hoisted 包）。
 *  2. 把现役 node_modules/@dsh-brain/* 的 symlink 目标（= dsh-brain 仓库路径）逐项建立。
 *  3. 额外添加 @dsh-brain/arm-isolation symlink。
 *  4. 复制 .bin、.modules.yaml、.pnpm-workspace-state-v1.json。
 *
 * 返回 { ok: true, built: [...], skipped: [...] } 或 { ok: false, reason }。
 */
function prepareNodeModules(profileSrc, profileDst) {
  const srcNm = path.join(profileSrc, 'node_modules')
  const dstNm = path.join(profileDst, 'node_modules')

  // 现役 node_modules 不存在 ⇒ 建一个最小版
  if (!fs.existsSync(srcNm)) {
    console.warn('[警告] 现役 profile node_modules 不存在，建最小 node_modules')
    ensureDir(dstNm)
    return { ok: true, built: [], skipped: ['source-node-modules-missing'] }
  }

  // 目标 node_modules 已存在 ⇒ 分两种：
  // ★★ 2026-09-25 修：如果它是【符号链接/目录联接】——那是**旧版形状**（旧实现把整个 node_modules 联接指现役）
  //    ⇒ **必须拒跑**，不能"幂等跳过"：跳过会产出"**旧联接 + 新脚本**"的混合体（看起来成功，
  //      实际仍共享现役那层，违反本脚本"自己的真目录 + 逐项 symlink"的设计）。
  //    ★ 这里**故意不写任何删除代码**：递归删一个联接会**顺着链接删掉现役那层**（灾难）。
  //      要让操作者自己摘，且**只摘链接本身**（不是递归）。
  if (fs.existsSync(dstNm)) {
    try {
      if (fs.lstatSync(dstNm).isSymbolicLink()) {
        return {
          ok: false,
          reason:
            'existing-node-modules-is-a-symlink：目标 node_modules 是【符号链接/目录联接】（旧版形状）⇒ 拒绝继续。\n' +
            '  ★ 请先**手动摘掉那个链接**（只摘链接本身，**绝不要递归删** —— 递归会顺着链接删掉现役那层），\n' +
            '    再重跑本脚本；它会按新形状重建「自己的真目录 + 逐项符号链接」。',
        }
      }
    } catch { /* lstat 失败 ⇒ 交给下面的常规幂等检查 */ }
  }
  // 目标 node_modules 已存在且非空 ⇒ 幂等跳过
  if (fs.existsSync(dstNm)) {
    try {
      const existing = fs.readdirSync(dstNm, { withFileTypes: true })
      const hasContent = existing.some((e) => e.name !== '.' && e.name !== '..')
      if (hasContent) {
        console.log('  [幂等] node_modules 已存在且非空，跳过重建')
        return { ok: true, built: [], skipped: ['already-exists'] }
      }
    } catch { /* 读不到，继续 */ }
  }

  ensureDir(dstNm)
  const built = []
  const skipped = []

  // ── ① 复制 pnpm 元数据 + .bin ────────────────────────────────────────────────
  const metaFiles = ['.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json']
  for (const name of metaFiles) {
    const src = path.join(srcNm, name)
    const dst = path.join(dstNm, name)
    if (fs.existsSync(src)) {
      if (fs.statSync(src).isDirectory()) {
        copyDirRecursive(src, dst)
        built.push(name)
      } else {
        copyFile(src, dst)
        built.push(name)
      }
    }
  }

  // ── ② 复制 hoisted 包（非 @ 作用域、非 pnpm 内部）─────────────────────────────
  const skipPrefixes = new Set(['.', '@dsh-brain', '@deepseek-ai'])
  const srcEntries = fs.readdirSync(srcNm, { withFileTypes: true })
  for (const e of srcEntries) {
    if (e.name === '.pnpm') continue // 太大，跳过
    const src = path.join(srcNm, e.name)
    const dst = path.join(dstNm, e.name)
    if (e.isDirectory()) {
      // 跳过 dsh-brain（用 symlink 处理）
      if (e.name.startsWith('@dsh-brain')) continue
      if (e.name.startsWith('@deepseek-ai')) continue
      // 直接复制（hoisted 包如 clsx、cosmokit、schemastery 等）
      copyDirRecursive(src, dst)
      built.push(e.name)
    }
  }

  // ── ③ 为 @dsh-brain/* 建符号链接（指向 dsh-brain 仓库）───────────────────────
  const dshBrainSrc = path.join(srcNm, '@dsh-brain')
  const dshBrainDst = path.join(dstNm, '@dsh-brain')
  if (fs.existsSync(dshBrainSrc)) {
    ensureDir(dshBrainDst)
    const dbEntries = fs.readdirSync(dshBrainSrc, { withFileTypes: true })
    for (const e of dbEntries) {
      if (!e.isSymbolicLink() && !e.isDirectory()) continue
      const src = path.join(dshBrainSrc, e.name)
      const dst = path.join(dshBrainDst, e.name)
      try {
        // 读源 symlink 的 target，在新位置建立同样的 symlink
        let target
        try {
          target = fs.readlinkSync(src)
        } catch {
          // 不是 symlink，跳过（可能是坏链接）
          skipped.push(`@dsh-brain/${e.name}（非 symlink，跳过）`)
          continue
        }
        // 建立 symlink（用绝对路径，避免相对路径在跨卷时失效）
        const absTarget = path.isAbsolute(target) ? target : path.resolve(srcNm, target)
        fs.symlinkSync(absTarget, dst)
        built.push(`@dsh-brain/${e.name}`)
      } catch (err) {
        skipped.push(`@dsh-brain/${e.name}: ${err.message}`)
      }
    }
  }

  // ── ④ 为 @deepseek-ai/* 建符号链接（指向 dsh-brain 仓库 node_modules）────────
  const deepseekSrc = path.join(srcNm, '@deepseek-ai')
  const deepseekDst = path.join(dstNm, '@deepseek-ai')
  if (fs.existsSync(deepseekSrc)) {
    ensureDir(deepseekDst)
    const daEntries = fs.readdirSync(deepseekSrc, { withFileTypes: true })
    for (const e of daEntries) {
      const src = path.join(deepseekSrc, e.name)
      const dst = path.join(deepseekDst, e.name)
      try {
        let target
        try {
          target = fs.readlinkSync(src)
        } catch {
          skipped.push(`@deepseek-ai/${e.name}（非 symlink，跳过）`)
          continue
        }
        const absTarget = path.isAbsolute(target) ? target : path.resolve(srcNm, target)
        fs.symlinkSync(absTarget, dst)
        built.push(`@deepseek-ai/${e.name}`)
      } catch (err) {
        skipped.push(`@deepseek-ai/${e.name}: ${err.message}`)
      }
    }
  }

  // ── ⑤ ★ 额外添加 @dsh-brain/arm-isolation ─────────────────────────────────────
  const armIsolationPkg = 'D:/project_develop/dsh-brain/packages/arm-isolation'
  const armIsolationTarget = path.join(dshBrainDst, 'arm-isolation')
  try {
    if (fs.existsSync(armIsolationTarget)) {
      // 已存在 ⇒ 幂等
      const existingStat = fs.lstatSync(armIsolationTarget)
      if (existingStat.isSymbolicLink()) {
        const existingTarget = fs.readlinkSync(armIsolationTarget)
        if (existingTarget === armIsolationPkg) {
          console.log('  [幂等] @dsh-brain/arm-isolation 已存在，跳过')
        } else {
          // target 不同 ⇒ 删除旧链接重建
          fs.unlinkSync(armIsolationTarget)
          fs.symlinkSync(armIsolationPkg, armIsolationTarget)
          built.push('@dsh-brain/arm-isolation（重建）')
        }
      } else {
        skipped.push('@dsh-brain/arm-isolation（已存在但不是 symlink）')
      }
    } else {
      fs.symlinkSync(armIsolationPkg, armIsolationTarget)
      built.push('@dsh-brain/arm-isolation')
    }
  } catch (err) {
    skipped.push(`@dsh-brain/arm-isolation: ${err.message}`)
  }

  console.log(`  [node_modules] 成功建立 ${built.length} 项，跳过 ${skipped.length} 项`)
  for (const b of built) console.log(`    ✓ ${b}`)
  for (const s of skipped) console.log(`    ✗ ${s}`)

  return { ok: true, built, skipped }
}

/**
 * 准备 package.json：从现役复制，并额外添加 @dsh-brain/arm-isolation 依赖。
 * 返回 { ok, addedDep } 表示是否成功添加了依赖。
 */
function preparePackageJson(profileSrc, profileDst) {
  const srcPkg = path.join(profileSrc, 'package.json')
  const dstPkg = path.join(profileDst, 'package.json')

  if (!fs.existsSync(srcPkg)) {
    // 现役没有 package.json ⇒ 建一个最小版
    const minimalPkg = {
      name: 'dsh-profile',
      version: '0.0.0',
      private: true,
      type: 'module',
      dsh: {
        profile: {
          bundles: ['@dsh-brain/arm-isolation'],
        },
      },
      dependencies: {
        '@dsh-brain/arm-isolation': 'link:D:/project_develop/dsh-brain/packages/arm-isolation',
      },
    }
    fs.writeFileSync(dstPkg, JSON.stringify(minimalPkg, null, 2) + '\n', 'utf8')
    console.log('  [package.json] 创建最小版（现役无 package.json）')
    return { ok: true, addedDep: '@dsh-brain/arm-isolation' }
  }

  // 读取并复制现役 package.json
  const raw = fs.readFileSync(srcPkg, 'utf8')
  const pkg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)

  // 确保 dependencies 对象存在
  pkg.dependencies = pkg.dependencies ?? {}

  // ★ 添加 @dsh-brain/arm-isolation 依赖
  const armIsolationDep = 'link:D:/project_develop/dsh-brain/packages/arm-isolation'
  pkg.dependencies['@dsh-brain/arm-isolation'] = armIsolationDep

  // 确保 dsh.profile.bundles 包含 arm-isolation
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  const bundles = pkg.dsh.profile.bundles ?? []
  if (!bundles.includes('@dsh-brain/arm-isolation')) {
    bundles.push('@dsh-brain/arm-isolation')
    pkg.dsh.profile.bundles = bundles
  }

  fs.writeFileSync(dstPkg, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('  [package.json] 已添加 @dsh-brain/arm-isolation 依赖')
  return { ok: true, addedDep: '@dsh-brain/arm-isolation' }
}

/**
 * ★★ 2026-09-25：给**隔离实例的 profile** 挂上「自进化的两个固定子 agent」（开发脑 / 审批脑）。
 *
 * 依据：`docs/training-ground-and-skill-sieve-2026-09-25.md` §11（用户口述）
 *       + `docs/revised-architecture-2026-09-20.md` §7（三段流水线）。
 *
 * ★ 为什么写**两条** `insert` 而不是一条 `seats:['dev','review']`：
 *   防串供（文档 `:218` 逐字「**产变更方不能与审批方同源**」）要求两席能各给路由 ⇒ 两条条目才装得下两套路由。
 * ★ **id 必须互不相同**（本项目铁律：同名 loader 条目 ⇒ `duplicate loader entry id` ⇒ **整树装配失败**）。
 * ★ **只写隔离实例自己的 profile** ⇒ 现役一个字都不动。
 * ★ 幂等：文件里已有 `# [evo-seats]` 标记就跳过（`--force` 重建时会重写整份 profile，不会重复追加）。
 */
function prepareEvolutionSeats(profileDst, { routeDev, routeReview } = {}) {
  const patch = path.join(profileDst, 'cordis.patch.yml')
  if (!fs.existsSync(patch)) return { evoSeats: 'skipped（profile 里没有 cordis.patch.yml）' }
  const cur = fs.readFileSync(patch, 'utf8')
  if (cur.includes('# [evo-seats]')) return { evoSeats: '已存在（幂等跳过）' }

  const seatLines = (seat, route) => {
    const l = [`    - id: evo-${seat}`, `      name: '@dsh-brain/subagent-council'`, '      config:', `        seat: ${seat}`]
    if (route.model) l.push(`        model: ${JSON.stringify(route.model)}`)
    if (route.provider) l.push(`        provider: ${JSON.stringify(route.provider)}`)
    return l
  }
  const out = [
    '',
    '# [evo-seats] 自进化的两个固定子 agent（开发脑 / 审批脑）—— 由 isolated-instance 注入（**只写隔离实例**）',
    '#   依据 docs/revised-architecture-2026-09-20.md §7 与 docs/training-ground-and-skill-sieve-2026-09-25.md §11',
    '#   ★ 用户裁决（开发期一律 AGNES）：**独立性主要靠【出发点不同】**，不是靠换模型；',
    '#     两条条目分开写，是为了**将来能给两席各自的路由**（可选加强），也为了 id 互不相同。',
    '- insert:',
  ]
  out.push(...seatLines('dev', routeDev ?? { provider: '', model: '' }))
  out.push(...seatLines('review', routeReview ?? { provider: '', model: '' }))
  fs.appendFileSync(patch, out.join('\n') + '\n', 'utf8')

  const same =
    (routeDev?.provider ?? '') === (routeReview?.provider ?? '') &&
    (routeDev?.model ?? '') === (routeReview?.model ?? '')
  return {
    evoSeats: same
      ? '已注入 evo-dev / evo-review ★ 两席路由相同 ⇒ 独立性只到【跨会话】档（未到【跨模型】，文档 §6 三级阶梯）'
      : '已注入 evo-dev / evo-review（两席路由不同 ⇒ 独立性更强）',
  }
}

/**
 * ★★ 2026-09-25 补（**实测事故**）：把本实例的**端口**写进 profile，覆盖包自带的硬编码。
 *
 * · 必须覆盖的那个：**`key-pool-proxy` 的 `port`** —— 它包自带的 `cordis.patch.yml`
 *   **硬编码 `port: 3101`**，而池端口**只有在「代装配清单」声明了 `pool.enabled` 时才由 gen 端口派生**
 *   （`poolPortOf`）。本实例**没有清单** ⇒ 插件就用自带的 3101 ⇒ ★ **抢走现役的池端口**
 *   （实测后果：**现役前门整个掉**，`netstat` 里 `:3101` 的 pid 变成隔离实例那个 gen）。
 * · 形状用【**覆盖 config**】（`- id: <同名>` + `config:`）—— 铁律 2：同一个 id 只能 `insert` 一次；
 *   实测：写成 `insert` 会 `duplicate loader entry id` ⇒ **整树装配失败**（首跑就是这么死的）。
 * · 幂等：见到 `# [iso-ports]` 标记就跳过。
 */
function prepareIsoPorts(profileDst) {
  const patch = path.join(profileDst, 'cordis.patch.yml')
  if (!fs.existsSync(patch)) return { isoPorts: 'skipped（profile 里没有 cordis.patch.yml）' }
  const poolPort = Number(DEFAULT_PORTS.POOL_PORT)
  const NEW_POOL = `http://127.0.0.1:${poolPort}`
  let cur = fs.readFileSync(patch, 'utf8')

  // ── ① 就地改【拷贝里的那一行】（design-canvas MCP 的 LLM 上游）——**不加 override 块** ──
  //   ★★ 为什么不加 override 块：**实测"部分 config 是整体替换、不是深合并"** ——
  //      加 `- id: mcp-client` + 只给 env ⇒ 会把它的 command/args/cwd 全冲掉 ⇒ design-canvas 直接坏。
  //      ⇒ 改的是**我们自己那份拷贝**，就地替换值即可（也就没有替换语义的风险）。
  let touched = 0
  cur = cur.replace(/AGNES_UPSTREAM_BASE:\s*http:\/\/127\.0\.0\.1:3101/g, () => {
    touched++
    return `AGNES_UPSTREAM_BASE: ${NEW_POOL}`
  })

  // ── ② 自愈式重写 [iso-ports] 段（去掉旧版那段坏掉的，再追加新的）──
  const lines = cur.split('\n')
  const start = lines.findIndex((l) => l.includes('# [iso-ports]'))
  if (start >= 0) {
    const from = start > 0 && lines[start - 1].trim() === '' ? start - 1 : start
    lines.splice(from)
    cur = lines.join('\n')
  }

  const out = [
    '',
    '# [iso-ports] 本隔离实例的端口覆盖 —— 由 isolated-instance 注入（**只写隔离实例**）',
    '#   ★ 为什么必须覆盖：key-pool-proxy 包自带的 patch 硬编码 port=3101（**现役的池端口**）⇒',
    '#     不覆盖会抢现役的端口（实测 2026-09-25：现役前门一度整个掉）。',
    '#   ★ 形状是【覆盖 config】不是 insert（写成 insert 会 duplicate loader entry id ⇒ 整树装配失败）。',
    '#   ★★ **必须"重述完整 config"** —— 实测：部分 `config:` 是【**整体替换**】、**不是深合并**！',
    '#      只给 `port:` 会把 bundle 的 poolEnv/fallbackEnvs/upstreamBase 全冲掉 ⇒ 插件报',
    '#      `empty key pool: poolEnv=AGNES_KEY_POOL` ⇒ **整树装配失败**（实测踩过，前门 502）。',
    '#      ⇒ 下面几行是**照 packages/key-pool-proxy/cordis.patch.yml 逐字抄**，只改 port；',
    '#        并由判据断言"与包内逐字一致（除 port）"来防漂移。',
    '- id: key-pool-proxy',
    '  config:',
    '    poolEnv: AGENTSHELL_MAIN_LLM_API_KEYS',
    '    fallbackEnvs:',
    '      - AGENTSHELL_MAIN_LLM_API_KEY',
    '    upstreamBase: https://apihub.agnes-ai.com',
    `    port: ${poolPort}`,
    '    cooldownMs: 15000',
    '    maxRetries: 3',
    '    retryStatuses: [429, 500, 502, 503, 504]',
  ]
  fs.writeFileSync(patch, cur + out.join('\n') + '\n', 'utf8')
  return {
    isoPorts: `key-pool-proxy.port=${poolPort}（**重述完整 config**）；并就地把 ${touched} 处 AGNES_UPSTREAM_BASE 改成 ${NEW_POOL}`,
  }
}

/**
 * ★★ 2026-09-25 补（实测：隔离实例**起得来、但建不了会话** —— `agent-preset-not-found: council`）：
 *   **用户自建的 preset 住在 `$DSH_HOME/.agent-presets/<名>/{preset.yml, agent.cordis.yml}`**
 *   —— 既不在 profile 里、也不在 `storages/` 里。复制 DSH_HOME 时**必须一并带过去**，
 *   否则 `settings.yaml` 的 `agent-presets.default: council` 指到一个**不存在**的 preset
 *   ⇒ `session.create` 直接失败（实测报错原文就是这个）。
 */
function prepareAgentPresets(srcHome, dstHome) {
  const src = path.join(srcHome, '.agent-presets')
  const dst = path.join(dstHome, '.agent-presets')
  if (!fs.existsSync(src)) return { agentPresets: 'skipped（现役没有 .agent-presets/）' }
  const names = fs.readdirSync(src).filter((n) => fs.statSync(path.join(src, n)).isDirectory())
  let files = 0
  for (const name of names) {
    fs.mkdirSync(path.join(dst, name), { recursive: true })
    for (const f of fs.readdirSync(path.join(src, name))) {
      fs.copyFileSync(path.join(src, name, f), path.join(dst, name, f))
      files++
    }
  }
  return { agentPresets: `已复制 ${names.length} 个自建 preset（${names.join(', ')}）／${files} 个文件` }
}

function prepareProfile(profileSrc, profileDst) {
  const files = ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']
  for (const f of files) {
    const src = path.join(profileSrc, f)
    const dst = path.join(profileDst, f)
    if (fs.existsSync(src)) {
      copyFile(src, dst)
    }
  }
  // package.json 单独处理（要加 arm-isolation 依赖）
  const pkgResult = preparePackageJson(profileSrc, profileDst)

  // node_modules → 真实目录 + 逐项符号链接
  const nmResult = prepareNodeModules(profileSrc, profileDst)

  // ★ 自进化两席（开发脑 / 审批脑）—— **只写隔离实例的 profile**，现役不动
  const evoResult = noEvoSeats
    ? { evoSeats: '已跳过（--no-evo-seats）' }
    : prepareEvolutionSeats(profileDst, { routeDev, routeReview })

  // ★ 端口覆盖（必须**无条件**做：否则会抢现役的 3101 池端口）
  const portResult = prepareIsoPorts(profileDst)

  return { ...pkgResult, ...nmResult, ...evoResult, ...portResult }
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
console.log(`  DSH_ARM_SELF = ${ARM_SELF}`)
console.log(`  DSH_ARM_DENY = ${ARM_DENY || '(无其他臂)'}`)
console.log(sep)

// 源路径（现役 DSH_HOME 下的 profile）
const profileSrc = path.join(DSH_HOME_ACTIVE, 'profiles', profile)
const settingsSrc = path.join(DSH_HOME_ACTIVE, 'settings.yaml')

// 校验源文件存在
for (const f of ['cordis.yml', 'cordis.patch.yml']) {
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
  console.log('  2. 复制 profile 骨架（node_modules = 真实目录 + 逐项 symlink）：')
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
  console.log('  5. 训练场身份（写入启动 env）：')
  console.log(`     DSH_ARM_SELF=${ARM_SELF}`)
  console.log(`     DSH_ARM_DENY=${ARM_DENY || '(无其他臂)'}`)
  console.log('')
  console.log('  端口配置（写入启动 env）：')
  console.log(JSON.stringify(PORTS, null, 2))
  console.log('')
  console.log('  完整启动命令（请在终端执行）：')
  console.log('')
  const escapedHome = dshHome.replace(/\\/g, '/').replace(/"/g, '\\"')
  console.log(`  DSH_HOME="${escapedHome}" \`
    DSH_ARM_SELF=${ARM_SELF} \`
    DSH_ARM_DENY="${ARM_DENY}" \`
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
    index.push({ arm: arm.name, gen, profile, root: rootDir, dshHome, ports: PORTS, at: ts, mode: 'dry-run+record', armSelf: ARM_SELF, armDeny: ARM_DENY })
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

// 2. 复制 profile 骨架 + node_modules（真实目录 + 符号链接）
const nmResult = prepareProfile(profileSrc, path.join(dshHome, 'profiles', profile))
if (!nmResult.ok) {
  // ★★ 这一类是**致命的**（会产出"旧联接 + 新脚本"的混合体）⇒ **fail-closed 退出**，不是 warn 后继续
  if (String(nmResult.reason).startsWith('existing-node-modules-is-a-symlink')) {
    console.error(`[失败] ${nmResult.reason}`)
    process.exit(1)
  }
  console.warn(`[警告] node_modules 准备失败：${nmResult.reason}`)
}

// 3. 复制 settings.yaml（修改 default preset）
prepareSettings(settingsSrc, path.join(dshHome, 'settings.yaml'), armPreset)

// 3b. ★★ 复制【用户自建的 preset】—— 少了它，`agent-presets.default` 会指向一个不存在的 preset
const presetResult = dryRun ? { agentPresets: '(dry-run 跳过)' } : prepareAgentPresets(DSH_HOME_ACTIVE, dshHome)

// 4. verifyout 已创建（空目录）

// ── 打印规格 ───────────────────────────────────────────────────────────────────
console.log('  准备完成：')
console.log('  arm         : ' + arm.name)
console.log('  role        : ' + arm.role)
console.log('  label       : ' + arm.label)
console.log('  root        : ' + rootDir.replace(/\\/g, '/'))
console.log('  dshHome     : ' + dshHome.replace(/\\/g, '/'))
console.log('  profile     : ' + profile)
console.log('  node_modules: ' + (nmResult.built?.length ?? 0) + ' 项已建' +
  (nmResult.skipped?.length ? '，' + nmResult.skipped.length + ' 项跳过' : ''))
// ★★ 2026-09-25 修：按【实际存在】判，不看 `built` 列表 ——
//   幂等跳过时 `built` 是空的，原来那行会**误报"⚠ 未加入"**（明明联接可用）。
const armIsoPath = path.join(dshHome, 'profiles', profile, 'node_modules', '@dsh-brain', 'arm-isolation')
console.log('  arm-isolation: ' + (fs.existsSync(armIsoPath) ? '✓ 已在（联接可用）' : '⚠ 未加入'))
console.log('  自进化两席  : ' + (nmResult.evoSeats ?? '(未处理)'))
console.log('  端口覆盖    : ' + (nmResult.isoPorts ?? '(未处理)'))
console.log('  自建 preset : ' + (presetResult.agentPresets ?? '(未处理)'))
console.log('  verifyout   : ' + verifyOut.replace(/\\/g, '/'))
console.log('')
console.log('  训练场身份：')
console.log('  DSH_ARM_SELF = ' + ARM_SELF)
console.log('  DSH_ARM_DENY = ' + (ARM_DENY || '(无其他臂)'))
console.log('')
console.log('  端口配置：')
console.log(JSON.stringify(PORTS, null, 2))
console.log('')
console.log('  完整启动命令（请在终端执行）：')
console.log('')
const escapedHome2 = dshHome.replace(/\\/g, '/').replace(/"/g, '\\"')
console.log(`  DSH_HOME="${escapedHome2}" \`
    DSH_ARM_SELF=${ARM_SELF} \`
    DSH_ARM_DENY="${ARM_DENY}" \`
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
  index.push({ arm: arm.name, gen, profile, root: rootDir, dshHome, ports: PORTS, at: ts, mode: 'prepared', armSelf: ARM_SELF, armDeny: ARM_DENY })
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
    DSH_ARM_SELF: ARM_SELF,
    DSH_ARM_DENY: ARM_DENY,
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
