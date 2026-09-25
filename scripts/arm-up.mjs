#!/usr/bin/env node
/**
 * arm-up.mjs —— **训练场的唯一入口**：`node scripts/arm-up.mjs <臂名>`
 *
 * ★ 为什么要它（用户 2026-09-25 的质疑，逐字）：
 *   *"为什么我们没有一个统一的启动脚本？每一次都会出现不同样的 bug，而且按理来说不管怎么改，
 *    启动脚本是不会变的呀，为什么还要这回又多出了这种各种各样的变量？**那不是应该在 Switchboard 内部吗？**"*
 *
 * ⇒ 他的诊断是对的，根因有两条：
 *   ① **"启动"其实被拆到了 6 处**（手抄的 env / profile 的 bundles / profile patch 的覆盖块 /
 *      settings.yaml 的 default / `.agent-presets/` / switchboard 自己的 lib）——
 *      **没有任何一处对"整体能不能起来"负责** ⇒ 每次运行都能踩到不同的那一处。
 *   ② **这套派生机制本来就在 Switchboard 内部**（`gen-assembly.poolPortOf()` 会由 gen 端口派生池端口），
 *      **是我们用"裸 env + 无清单"绕过了它** ⇒ 插件退回包内硬编码 ⇒ 才逼出那些"新变量"。
 *
 * ⇒ 本脚本把这 6 处**收敛成一个入口**，并且：
 *   · **只吃一个自变量**：臂名（端口段由**臂序号**派生，不再手抄；
 *     臂身份/deny 由 switchboard 内部的 overlay 注入，不由外部给）；
 *   · ★★ **"起来了"的定义 = 自检全过**（把今天踩的每个坑固化成一条自检项，
 *     而不是"看着起来了、半小时后发现隔离层根本没拦"）。
 *
 * 用法：
 *   node scripts/arm-up.mjs <臂名> [--port-base <n>] [--no-start] [--json]
 *   node scripts/arm-up.mjs --selftest        # 只跑自检（不准备、不起）
 *
 * 退出码：0 = 全过；1 = 有自检项没过；2 = 用法/环境错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, '..')
const NODE = process.execPath
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const hasFlag = (k) => argv.includes(k)

/** ★ 现役占用的端口 —— 派生结果**不许落在**这里面（实测：池端口曾抢现役的 3101，现役前门整个掉）。 */
export const LIVE_PORTS = new Set([3080, 3081, 3101, 31800, 31810])

/**
 * ★★ **唯一的推导**：臂名 + 臂序号 ⇒ 整段端口。**外部不再给任何端口变量。**
 * 步长 40 ⇒ 段内布局：switch / gen / pool(+21) / admin(+100) / handover(+110)。
 */
export function portsForArm(armName, allArms) {
  const idx = Math.max(0, allArms.indexOf(armName))
  const base = 33080 + idx * 40
  return {
    base,
    env: {
      SWITCH_PORT: String(base),
      GEN_PORT_BASE: String(base + 1),
      SWITCH_ADMIN_PORT: String(base + 100),
      HANDOVER_ADMIN_PORT_BASE: String(base + 110),
      DSH_PUBLIC_WEB_URL: `http://127.0.0.1:${base}`,
    },
    front: `http://127.0.0.1:${base}`,
    admin: `http://127.0.0.1:${base + 100}`,
    pool: base + 21,
    genBase: base + 1,
  }
}

/**
 * 该臂的根目录。
 * ★★ 默认必须与 `isolated-instance.mjs` 的 `DEFAULT_ROOT` **一致**：`D:/project_develop/_arms/<臂名小写>`。
 *    （我第一版拿 `path.resolve(WT)` 当根 ⇒ 算成了**仓库里**的 `dsh-brain/a` ⇒ 准备阶段直接失败。）
 */
export const rootForArm = (armName) => path.join('D:/project_develop/_arms', armName.toLowerCase())

// ─────────────────────────────────────────────────────────────────────────────
// 自检（★ 把今天踩的坑逐条固化）
// ─────────────────────────────────────────────────────────────────────────────
const rpc = async (front, method, payload = {}) => {
  const { randomUUID } = await import('node:crypto')
  try {
    const r = await fetch(`${front}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    })
    const j = await r.json()
    return { http: r.status, ok: !!j?.result?.ok, value: j?.result?.value, error: j?.result?.error }
  } catch (e) {
    return { http: 0, ok: false, error: { message: String(e.message) } }
  }
}
const get = async (url) => {
  try {
    const r = await fetch(url)
    return { http: r.status, text: await r.text() }
  } catch (e) {
    return { http: 0, text: String(e.message) }
  }
}

/**
 * ★★ 2026-09-25 修：**"最新一代"不许靠猜 mtime** —— 实测：按**目录** mtime 排会选中**旧代**
 *   （追加写不改目录 mtime：`gen-33084` dir=11:34:22 > `gen-33085` dir=11:33:50，
 *    而真正的现行代是 33085）⇒ 我据此报了一次**假红**（说池端口不对，其实读的是旧代的日志）。
 * ⇒ 正解：**问控制面要 `activeGen`**（唯一权威），拿不到再退化成"按 boot.log 文件 mtime"。
 */
export function latestBootLog(root, activeGenName) {
  const dir = path.join(root, 'dshhome', 'switchboard')
  if (!fs.existsSync(dir)) return null
  const gens = fs.readdirSync(dir).filter((n) => n.startsWith('gen-'))
  let pick = activeGenName && gens.includes(activeGenName) ? activeGenName : null
  if (!pick) {
    // 退化：按 **boot.log 文件**的 mtime 排（不是目录 mtime）
    const scored = gens
      .map((n) => {
        const f = path.join(dir, n, 'boot.log')
        return { n, m: fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0 }
      })
      .sort((a, b) => b.m - a.m)
    pick = scored[0]?.n ?? null
  }
  if (!pick) return null
  const f = path.join(dir, pick, 'boot.log')
  if (!fs.existsSync(f)) return null
  const all = fs.readFileSync(f, 'utf8').split('\n')
  const last = all.map((l, i) => (l.includes('===== BOOT') ? i : -1)).filter((i) => i >= 0).pop() ?? 0
  return { file: f, gen: pick, text: all.slice(last).join('\n') }
}

/**
 * 自检（纯函数化的核心）：给定"读数"，判 6 条。★ 读数取自真实探测，**不读注释、不读意图**。
 */
export function judgeSelfCheck({ ports, front, admin, poolLogOk, ownerLogOk, seatsLogOk, isolationLogOk, denyCount, liveOk }) {
  const rows = []
  const add = (name, ok, detail) => rows.push({ name, ok, detail })
  // ① 端口段不许落进现役
  const clash = Object.values(ports.env)
    .map((v) => Number(String(v).replace(/\D/g, '')))
    .filter((n) => LIVE_PORTS.has(n))
  add('① 端口段不撞现役', clash.length === 0 && !LIVE_PORTS.has(ports.pool), clash.length ? `撞了：${clash.join(',')}` : `base=${ports.base} pool=${ports.pool}`)
  // ② 前门
  add('② 前门应答', front.http === 200 && front.ok, `HTTP ${front.http}`)
  // ③ 控制面
  add('③ 控制面应答', admin.http === 200, `HTTP ${admin.http}`)
  // ④ ★ 隔离层**真的**在跑（且 deny 非空 —— 空的等于不拦）
  add('④ 隔离层 apply 且 deny ≥ 1', isolationLogOk && denyCount >= 1, `apply=${isolationLogOk} denyRoots=${denyCount}`)
  // ⑤ ★ 两席注册
  add('⑤ 自进化两席已注册', seatsLogOk, seatsLogOk ? 'evo-dev + evo-review' : '★ 缺席（自进化不可用）')
  // ⑥ ★ 池在**本段内**（不是包内硬编码的 3101）
  add('⑥ 池端口在本段内', poolLogOk, `期望 ${ports.pool}`)
  // ⑦ 现役仍健康（隔离实例不许把现役搞掉）
  add('⑦ 现役仍健康', liveOk, liveOk ? '前门 200' : '★ 现役受影响（这绝不该发生）')
  return rows
}

const selftest = async () => {
  const ports = portsForArm('A', ['A', 'B'])
  const rows = judgeSelfCheck({
    ports,
    front: { http: 200, ok: true },
    admin: { http: 200 },
    isolationLogOk: true,
    denyCount: 2,
    seatsLogOk: true,
    poolLogOk: true,
    liveOk: true,
  })
  const ok = rows.every((r) => r.ok)
  console.log('=== arm-up 自检器自测（全绿情形）===')
  for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name} — ${r.detail}`)
  // ★ 消融：把"隔离层 deny=0"喂进去 ⇒ ④ 必须变红（空 deny = 不拦 = 最坏的假绿）
  const rows2 = judgeSelfCheck({ ports, front: { http: 200, ok: true }, admin: { http: 200 }, isolationLogOk: true, denyCount: 0, seatsLogOk: true, poolLogOk: true, liveOk: true })
  const row4 = rows2.find((r) => r.name.startsWith('④'))
  const rows3 = judgeSelfCheck({ ports: { ...ports, pool: 3101 }, front: { http: 200, ok: true }, admin: { http: 200 }, isolationLogOk: true, denyCount: 2, seatsLogOk: true, poolLogOk: true, liveOk: true })
  const row1 = rows3.find((r) => r.name.startsWith('①'))
  console.log(`  ${!row4.ok ? 'ok  ' : 'FAIL'} 消融：deny=0 ⇒ ④ 变红 ${!row4.ok ? '✓' : ''}`)
  console.log(`  ${!row1.ok ? 'ok  ' : 'FAIL'} 消融：池端口=3101（撞现役）⇒ ① 变红 ${!row1.ok ? '✓' : ''}`)
  const total = ok && !row4.ok && !row1.ok
  console.log(`\n结果：${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (hasFlag('--selftest')) process.exit(await selftest())

const armName = argv.find((a) => !a.startsWith('--'))
if (!armName) {
  console.error('[用法] node scripts/arm-up.mjs <臂名> [--port-base <n>] [--no-start] [--json]')
  process.exit(2)
}

// ── 臂清单：**必须来自注册表，读不到就拒跑**（★ 我第一版这里静默退化 ⇒ 臂 B 拿到臂 A 的端口段）──
//    为什么不能退化：`indexOf` 失败会返回 -1 ⇒ `Math.max(0,-1)=0` ⇒ **base 永远是 33080**
//    ⇒ 与臂 A **撞段**，还会把 A 的前门当成自己的（"已在跑"⇒跳过启动）⇒ **自检去看空气**。
let allArms = null
try {
  const { createRequire } = await import('node:module')
  const req = createRequire(path.join(WT, 'scripts', 'arms-registry.mjs'))
  const { loadArmsRegistry } = req(path.join(WT, 'scripts', 'arms-registry.mjs'))
  allArms = (loadArmsRegistry('evals/arms.json', { base: WT }).arms ?? []).map((a) => a.name)
} catch (e) {
  console.error(`[失败] 读不到臂注册表（evals/arms.json）⇒ **拒绝猜臂序号**：${e?.message ?? e}`)
  process.exit(2)
}
if (!allArms.includes(armName)) {
  console.error(`[失败] 臂 "${armName}" 不在注册表里 ⇒ 拒绝猜它的序号（猜错会撞别的臂的端口段）。\n  可用的臂：${allArms.join(', ')}\n  ⇒ 要么用现成的臂名，要么先把它加进 evals/arms.json。`)
  process.exit(2)
}

const ports = portsForArm(armName, allArms)
const root = rootForArm(armName)
console.log(`\n===== arm-up · 臂 ${armName} =====`)
console.log(`  ★ 唯一自变量 = 臂名；端口段由臂序号派生（不再手抄）`)
console.log(`  臂序号   : ${allArms.indexOf(armName)}（注册表 ${allArms.join(', ')}）`)
console.log(`  根目录   : ${root}`)
console.log(`  端口段   : switch=${ports.base}  gen=${ports.genBase}+  pool=${ports.pool}  admin=${ports.base + 100}  handover=${ports.base + 110}`)
console.log(`  现役占用 : ${[...LIVE_PORTS].join(', ')}（派生结果不许落进来）`)

// ── ★★ 段位归属前置断言：那一段若有人在应答，**必须证明是本实例的**（看本 root 有没有 lease）──
//    否则就是"别人占着这段"（我第一版正是把臂 A 的前门当成了臂 B 的）⇒ **拒跑**。
const rootHasLease = (() => {
  // ★ 2026-09-25 修：lease 在 **`<root>/dshhome/switchboard/lease.json`**（**不在** `<gen>/lease.json`）。
  //   我第一版找 `<gen>/lease.json` ⇒ 恒 false ⇒ **把自己的实例误判成"别人占着"⇒ 误拒**。
  //   （误拒比误放好，但仍是错的 —— 读数路径没核对就拿来判，正是今天反复踩的那类。）
  const f = path.join(root, 'dshhome', 'switchboard', 'lease.json')
  if (!fs.existsSync(f)) return false
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return !!j?.activeGen?.gen
  } catch { return false }
})()
const preFront = await rpc(ports.front, 'session.list')
const preAdmin = await get(`${ports.admin}/?cmd=status`)
const someoneThere = preFront.http === 200 || preAdmin.http === 200
if (someoneThere && !rootHasLease) {
  console.error(
    `[失败] 端口段 ${ports.base} 已经**有人在应答**，但 ${path.join(root, 'dshhome')} 里没有 lease ⇒\n` +
      `  那一段**不是本实例的**（很可能是别的臂占着）⇒ 拒跑。\n` +
      `  ⇒ 请换一个臂名，或先把那一段上的实例停掉。`,
  )
  process.exit(2)
}
if (someoneThere) console.log(`  （前置：本段已在应答，且本 root 有 lease ⇒ 确认是**本实例**，将继续）`)

// ① 准备（复用 isolated-instance，端口只传 base）
if (!hasFlag('--no-start')) {
  console.log('\n-- ① 准备（复用 isolated-instance --port-base）--')
  const r = spawnSync(NODE, [path.join(HERE, 'delegation', 'isolated-instance.mjs'), '--arm', armName, '--root', root, '--port-base', String(ports.base), '--force'], { encoding: 'utf8', timeout: 600000 })
  const tail = (r.stdout ?? '').split('\n').filter((l) => /自建 preset|端口覆盖|自进化两席|arm-isolation:|准备完成/.test(l))
  for (const l of tail) console.log('  ' + l.trim())
  if (r.status !== 0) {
    console.error(`\n[失败] 准备阶段 exit=${r.status}。★ 无论我的过滤有没有命中，都把它的原始输出贴全：`)
    console.error('---- stdout ----')
    console.error((r.stdout ?? '(空)').split('\n').slice(-20).join('\n'))
    console.error('---- stderr ----')
    console.error((r.stderr ?? '(空)').split('\n').slice(-20).join('\n'))
    process.exit(1)
  }

  // ② 起（★ 用派生出的 env 起，不经人手）
  //    ★★ 用**已核过 lease 的** `someoneThere`（上面那段前置断言），不再自己重新探一遍 ——
  //    语义差别很大：只有"本 root 有 lease"才算"本实例已在跑"。
  if (someoneThere) {
    console.log('\n-- ② 起 —— **跳过**：本实例已在应答（lease 已核 ⇔ 是它自己；只做自检，不重启）--')
  } else {
    console.log('\n-- ② 起（用**准备阶段吐出的**身份/端口 env 起，不经人手）--')
    // ★★ 身份与端口**只信准备阶段那一处**（本脚本不再自己算一遍 deny —— 两套算法必然漂移）。
    //    实测：只传 DSH_ARM_SELF、不传 DSH_ARM_DENY ⇒ 护栏走"显式 no-op" ⇒ **不拦任何东西**。
    const armEnvLine = (r.stdout ?? '').split('\n').find((l) => l.includes('[arm-env] '))
    if (!armEnvLine) {
      console.error('[失败] 没从准备阶段拿到 [arm-env]（训练场身份 + 端口）⇒ **拒绝在"身份不明"下去起服务**')
      process.exit(1)
    }
    let armEnv
    try {
      armEnv = JSON.parse(armEnvLine.slice(armEnvLine.indexOf('[arm-env] ') + '[arm-env] '.length))
    } catch (e) {
      console.error(`[失败] [arm-env] 不是合法 JSON ⇒ 拒跑：${e?.message ?? e}`)
      process.exit(1)
    }
    // 三道一致性/非空断言（★ 最后一条正是刚才那个洞的守卫）
    if (armEnv.DSH_ARM_SELF !== armName) {
      console.error(`[失败] 准备阶段给的身份是 "${armEnv.DSH_ARM_SELF}"，与臂名 "${armName}" 不符 ⇒ 拒跑`)
      process.exit(1)
    }
    if (String(armEnv.SWITCH_PORT) !== String(ports.base)) {
      console.error(`[失败] 端口推导**两边不一致**（准备阶段 ${armEnv.SWITCH_PORT} ≠ 本脚本 ${ports.base}）⇒ 拒跑`)
      process.exit(1)
    }
    if (!armEnv.DSH_ARM_DENY || String(armEnv.DSH_ARM_DENY).trim() === '') {
      console.error(`[失败] DSH_ARM_DENY 为空 ⇒ 护栏会走"显式 no-op"**什么都不拦** ⇒ 拒跑（这一条是实测踩出来的）`)
      process.exit(1)
    }
    console.log(`  身份 : DSH_ARM_SELF=${armEnv.DSH_ARM_SELF}  DSH_ARM_DENY=${armEnv.DSH_ARM_DENY}`)
    const env = { ...process.env, ...armEnv, ...ports.env }
    const l = spawnSync('cmd', ['/c', path.join(WT, 'scripts', 'relaunch-switchboard.cmd')], { encoding: 'utf8', env, timeout: 120000 })
    console.log(`  relaunch exit=${l.status}（它自己返回后服务在后台起）`)
  }
}

// ③ 等它起来
console.log('\n-- ③ 等前门应答（最多 90s）--')
let front = { http: 0, ok: false }
for (let i = 0; i < 18; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  front = await rpc(ports.front, 'session.list')
  if (front.http === 200 && front.ok) break
  process.stdout.write('.')
}
console.log('')

// ④ 自检（★ "起来了"的定义）
const admin = await get(`${ports.admin}/?cmd=status`)
// ★ 问控制面要现行代（权威）—— 不靠猜 mtime（见 latestBootLog 的注释）
let activeGenName = null
try { activeGenName = JSON.parse(admin.text)?.lease?.activeGen?.gen ?? null } catch { /* 控制面没答 */ }
const boot = latestBootLog(root, activeGenName)
console.log(`  现行代（控制面权威）= ${activeGenName ?? '(拿不到，退化为按 boot.log mtime)'}`)
const t = boot?.text ?? ''
const isolationLogOk = /\[arm-isolation\] apply running/.test(t)
const denyCount = Number((t.match(/denyRoots=(\d+) 条/) ?? [])[1] ?? 0)
const seatsLogOk = /provider="evo-dev"/.test(t) && /provider="evo-review"/.test(t)
const poolLogOk = new RegExp(`\\[key-pool-proxy\\] listening 127\\.0\\.0\\.1:${ports.pool}\\b`).test(t)
const live = await rpc('http://127.0.0.1:3080', 'session.list')
const rows = judgeSelfCheck({ ports, front, admin, isolationLogOk, denyCount, seatsLogOk, poolLogOk, liveOk: live.http === 200 && live.ok })

console.log('-- ④ 自检（"起来了" = 这些全过）--')
for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.detail}`)
console.log(`\n  boot.log = ${boot?.file ?? '(没找到)'}`)
const allOk = rows.every((r) => r.ok)
console.log(`\n===== ${allOk ? '✅ 起来了（自检全过）' : '❌ 没起来（照上面 ❌ 那条查）'} =====`)
if (hasFlag('--json')) console.log(JSON.stringify({ arm: armName, ports, root, rows, gen: boot?.gen }, null, 2))
process.exit(allOk ? 0 : 1)
