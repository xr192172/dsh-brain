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
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// ★ 端口/根目录的**唯一定义**（纯模块，无副作用可安全 import）
import { LIVE_PORTS, LIVE_SPEC, portsForArm as sharedPortsForArm, rootForArm as sharedRootForArm } from './arm-ports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, '..')
const NODE = process.execPath
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const hasFlag = (k) => argv.includes(k)

/** ★ `LIVE_PORTS` / `LIVE_SPEC` / `portsForArm` / `rootForArm` 都定义在 `./arm-ports.mjs`（**唯一一份**）。 */
export { LIVE_PORTS, LIVE_SPEC }

/**
 * ★★ **唯一的推导**：臂名 + 臂序号 ⇒ 整段端口。**外部不再给任何端口变量。**
 * 步长 40 ⇒ 段内布局：switch / gen / pool(+21) / admin(+100) / handover(+110)。
 */
export function portsForArm(armName, allArms) {
  // ★★ 2026-09-25：**算法已抽到 `scripts/arm-ports.mjs`**（唯一一份）——
  //   因为 `dsh-delegate.mjs` 也要按臂名推出同一个 front/DSH_HOME，
  //   绝不能各写一遍（那正是"每回不一致"的根源）。这里只做转调。
  return sharedPortsForArm(armName, allArms)
}

/**
 * 该臂的根目录。
 * ★★ 默认必须与 `isolated-instance.mjs` 的 `DEFAULT_ROOT` **一致**：`D:/project_develop/_arms/<臂名小写>`。
 *    （我第一版拿 `path.resolve(WT)` 当根 ⇒ 算成了**仓库里**的 `dsh-brain/a` ⇒ 准备阶段直接失败。）
 */
export const rootForArm = (armName) => sharedRootForArm(armName)

/**
 * ★★ 2026-09-25 加：**现役模式**（`--live`）。
 *
 * 用户的要求（逐字）：*"能不能借鉴这个桌面应用的启动思路，把这启动的脚本全都统合成那种程度，
 * 就是说**点击一下桌面图标我们直接启动后端服务**那种。我不要求你把它打包成 Electron 因为它很重，
 * 但是你至少要像它一样**很简单的触发一条就直接启动**吧。你像这样各种调参数，而且还每回都不一致，
 * 这显得我们**非常的管理混乱**。"*
 *
 * ⇒ **不新增第二个启动器**（那正是"不一致"的来源）：本脚本**只留一个入口**，`--live` 只是它的另一个模式 ——
 *   · **不需要任何参数**（它自己知道现役的 DSH_HOME 与端口）；
 *   · 与臂模式**共用同一套自检**（臂专属那几条对现役不适用 ⇒ 见 judgeSelfCheck 的 mode 参数）。
 * ★ 定义见 `./arm-ports.mjs`（与 `portsForArm` 同一份，避免两套算法漂移）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 自检（★ 把今天踩的坑逐条固化）
// ─────────────────────────────────────────────────────────────────────────────
/**
 * ★★ 2026-09-26 修：**探针必须带超时 + 有界重试，并且**分类**失败原因**。
 *
 * 实证（我复现过）：`run-experiment.mjs` → `arm-up.mjs A` 的自检 ⑦ 会去探**现役 `:3080`**；
 * 而**现役此刻正在跑发起这次实验的那个会话**（= 被我们占着）⇒ 前门排队 ⇒
 * **同一个探针在负载下 5/6 次返回 `http:0`（TimeoutError）** ⇒ ⑦ 假红 ⇒ `不敢发题` ⇒ **整条链自锁**。
 *
 * ★ 这**不是**"现役不稳"（现役 pid 未变、连测 10/10 成功），是**探针太脆**。
 * ★ 修法纪律（不许把假红转成假绿）：
 *   · **不许**"重试到绿就算过" —— 那是把假红换成假绿（违反铁律 7/15）。
 *   · 正解 = ① **带超时**（单次有上限）② **有界重试**（吸收偶发抖动）③ ★ **分类**：
 *     `ok`（答对了）/ `slow`（答了但非 200 或不 ok）/ `unreachable`（一次都没探到）。
 *     判据**只**把 `unreachable` 或 `slow` 当红；`unreachable` 与 `slow` 在报告里**分开写**，
 *     因为"探不通"（看不到）与"探得通但答错"（看到了坏结果）是**两件不同的事**（铁律 12）。
 */
const rpcOnce = async (front, method, payload, timeoutMs) => {
  const { randomUUID } = await import('node:crypto')
  try {
    const r = await fetch(`${front}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await r.json()
    return { http: r.status, ok: !!j?.result?.ok, value: j?.result?.value, error: j?.result?.error }
  } catch (e) {
    return { http: 0, ok: false, unreachable: true, error: { message: String(e.message) } }
  }
}

/** ★ 带超时（默认 20s/次）+ 有界重试（默认 5 次，间隔 2s）的探针；返回**分类后**的结果。 */
const rpc = async (front, method, payload = {}, { tries = 5, timeoutMs = 20000, gapMs = 2000 } = {}) => {
  const attempts = []
  for (let i = 0; i < tries; i++) {
    const r = await rpcOnce(front, method, payload, timeoutMs)
    attempts.push(r)
    if (r.http === 200 && r.ok) {
      return { ...r, kind: 'ok', tries: i + 1, attempts }
    }
    if (i < tries - 1) await new Promise((s) => setTimeout(s, gapMs))
  }
  // 一次都没成功 ⇒ 分类：**有没有一次探到**（探到 = 通道没断，只是答得不对）
  const anyReached = attempts.some((a) => a.http !== 0)
  const last = attempts[attempts.length - 1]
  return { ...last, kind: anyReached ? 'slow' : 'unreachable', tries, attempts }
}
/** ★ 2026-09-26：`get` 同样**带超时 + 有界重试**（原因同 `rpc`；控制面偶发排队不该判成"没起来"）。 */
const getOnce = async (url, timeoutMs) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { http: r.status, text: await r.text() }
  } catch (e) {
    return { http: 0, text: String(e.message), unreachable: true }
  }
}
const get = async (url, { tries = 5, timeoutMs = 20000, gapMs = 2000 } = {}) => {
  let last = { http: 0, text: '(未探测)' }
  for (let i = 0; i < tries; i++) {
    last = await getOnce(url, timeoutMs)
    if (last.http === 200) return { ...last, tries: i + 1 }
    if (i < tries - 1) await new Promise((s) => setTimeout(s, gapMs))
  }
  return { ...last, tries }
}

/**
 * ★★ 2026-09-25 修：**"最新一代"不许靠猜 mtime** —— 实测：按**目录** mtime 排会选中**旧代**
 *   （追加写不改目录 mtime：`gen-33084` dir=11:34:22 > `gen-33085` dir=11:33:50，
 *    而真正的现行代是 33085）⇒ 我据此报了一次**假红**（说池端口不对，其实读的是旧代的日志）。
 * ⇒ 正解：**问控制面要 `activeGen`**（唯一权威），拿不到再退化成"按 boot.log 文件 mtime"。
 */
export function latestBootLog(sbDir, activeGenName) {
  const dir = sbDir
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
export function judgeSelfCheck({ ports, front, admin, poolLogOk, ownerLogOk, seatsLogOk, isolationLogOk, denyCount, liveOk, liveKind = null, mode = 'arm', htmlOk = null }) {
  const rows = []
  const add = (name, ok, detail) => rows.push({ name, ok, detail })
  if (mode === 'live') {
    // ★ 现役模式：**只判"服务可用"** —— 臂专属那几条（隔离层/两席/池在本段内）对现役**不适用**
    //   （现役不是训练场：没有 DSH_ARM_SELF/DENY、池就在 3101）。**不许把不适用的判据硬套**（那会造假红）。
    add('① 前门应答', front.http === 200 && front.ok, `HTTP ${front.http}`)
    add('② 控制面应答', admin.http === 200, `HTTP ${admin.http}`)
    add('③ 池端口在听（现役的 3101）', poolLogOk !== false, poolLogOk === true ? '在听' : '★ 池没起 ⇒ LLM 路由会退化')
    add('④ 前端可取（点了就有界面）', htmlOk === true, htmlOk === true ? 'HTML 200' : `★ 取不到（${htmlOk}）`)
    return rows
  }
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
  // ★ 2026-09-26：判据**只**吃 `liveOk`（布尔），但 `detail` 必须**分辨**"探不通"与"探得通但答错"
  //   —— 这两件事的处置完全不同（前者是通道问题，后者是现役真的坏了）。见 rpc() 的 kind。
  add('⑦ 现役仍健康', liveOk === true, liveKind === 'ok' ? '前门 200' : liveKind === 'unreachable'
    ? '★ 探不通（通道不可用）—— 不等于现役坏了；先别下结论（见 rpc 的超时/重试）'
    : `★ 探得通但答不对（kind=${liveKind}）—— 这才是"现役受影响"该有的样子`)
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
    liveKind: 'ok',
  })
  const ok = rows.every((r) => r.ok)
  console.log('=== arm-up 自检器自测（全绿情形）===')
  for (const r of rows) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name} — ${r.detail}`)
  // ★ 消融：把"隔离层 deny=0"喂进去 ⇒ ④ 必须变红（空 deny = 不拦 = 最坏的假绿）
  const rows2 = judgeSelfCheck({ ports, front: { http: 200, ok: true }, admin: { http: 200 }, isolationLogOk: true, denyCount: 0, seatsLogOk: true, poolLogOk: true, liveOk: true, liveKind: 'ok' })
  const row4 = rows2.find((r) => r.name.startsWith('④'))
  const rows3 = judgeSelfCheck({ ports: { ...ports, pool: 3101 }, front: { http: 200, ok: true }, admin: { http: 200 }, isolationLogOk: true, denyCount: 2, seatsLogOk: true, poolLogOk: true, liveOk: true, liveKind: 'ok' })
  const row1 = rows3.find((r) => r.name.startsWith('①'))
  // ★★ 新增消融（2026-09-26，对应真事故）：⑦ 的 detail 必须**分辨**两种失败，且**两种都判红**
  const rowsU = judgeSelfCheck({ ports, front: { http: 200, ok: true }, admin: { http: 200 }, isolationLogOk: true, denyCount: 2, seatsLogOk: true, poolLogOk: true, liveOk: false, liveKind: 'unreachable' })
  const rowsS = judgeSelfCheck({ ports, front: { http: 200, ok: true }, admin: { http: 200 }, isolationLogOk: true, denyCount: 2, seatsLogOk: true, poolLogOk: true, liveOk: false, liveKind: 'slow' })
  const r7u = rowsU.find((r) => r.name.startsWith('⑦'))
  const r7s = rowsS.find((r) => r.name.startsWith('⑦'))
  const kindDistinguished = r7u.detail !== r7s.detail && /探不通/.test(r7u.detail) && /答不对/.test(r7s.detail)
  console.log(`  ${!row4.ok ? 'ok  ' : 'FAIL'} 消融：deny=0 ⇒ ④ 变红 ${!row4.ok ? '✓' : ''}`)
  console.log(`  ${!row1.ok ? 'ok  ' : 'FAIL'} 消融：池端口=3101（撞现役）⇒ ① 变红 ${!row1.ok ? '✓' : ''}`)
  console.log(`  ${!r7u.ok && !r7s.ok ? 'ok  ' : 'FAIL'} 消融（2026-09-26 真事故）：liveOk=false ⇒ ⑦ 变红（两种 kind 都红）`)
  console.log(`  ${kindDistinguished ? 'ok  ' : 'FAIL'} 消融：⑦ 的 detail **分辨**"探不通"与"答不对"（不许混为一谈）`)
  // ★★ 2026-09-26 加：**僵尸 lease 检测**（真事故：lease.pid 指向不存在的进程 ⇒ 臂永久卡死）
  const selfAlive = pidAlive(process.pid)                 // 自己一定活着
  const ghostAlive = pidAlive(99999999)                   // 一个几乎不可能存在的 pid
  const badAlive = pidAlive(0) && pidAlive(-1) && pidAlive('abc')
  const pidOk = selfAlive === true && ghostAlive === false && badAlive === false
  console.log(`  ${pidOk ? 'ok  ' : 'FAIL'} 僵尸 lease 判据：pidAlive(自己)=${selfAlive}（须 true）/ pidAlive(99999999)=${ghostAlive}（须 false）/ 非法输入=${badAlive}（须 false）`)
  const total = ok && !row4.ok && !row1.ok && !r7u.ok && !r7s.ok && kindDistinguished && pidOk
  console.log(`\n结果：${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (hasFlag('--selftest')) process.exit(await selftest())

/**
 * ★★ 2026-09-25：**两个模式、一个入口**（用户要求"点一下图标就直接起、别每回参数都不一样"）。
 *   · `--live`   ⇒ 起**现役**（**不需要任何参数**）
 *   · ` <臂名>`  ⇒ 起一个**训练场**
 * ⇒ **不再有第二个启动器**（那正是"管理混乱"的来源）。
 */
const LIVE_MODE = hasFlag('--live')
const armName = LIVE_MODE ? LIVE_SPEC.arm : argv.find((a) => !a.startsWith('--'))
if (!LIVE_MODE && !armName) {
  console.error(
    '[用法]\n' +
      '  node scripts/arm-up.mjs --live                 # 起现役（无参，最常用）\n' +
      '  node scripts/arm-up.mjs <臂名>                 # 起某个训练场（如 A / B）\n' +
      '  可选：[--port-base <n>] [--no-start] [--open] [--json]\n' +
      '  ★ 双击 `scripts\\dsh-up.cmd` 等价于 `--live --open`（桌面图标的做法见该文件注释）。',
  )
  process.exit(2)
}

// ── 臂清单：**必须来自注册表，读不到就拒跑**（★ 我第一版这里静默退化 ⇒ 臂 B 拿到臂 A 的端口段）──
//    为什么不能退化：`indexOf` 失败会返回 -1 ⇒ `Math.max(0,-1)=0` ⇒ **base 永远是 33080**
//    ⇒ 与臂 A **撞段**，还会把 A 的前门当成自己的（"已在跑"⇒跳过启动）⇒ **自检去看空气**。
//    ★ 现役模式**不需要**注册表（它没有臂身份）⇒ 整块跳过。
let allArms = null
if (!LIVE_MODE) {
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
}

// ── ★ 两种模式只在这一处分叉（**其余全部共用**，避免"两套算法"漂移）──────────────
const ports = LIVE_MODE ? LIVE_SPEC.ports : portsForArm(armName, allArms)
const root = LIVE_MODE ? LIVE_SPEC.dshHome : rootForArm(armName)
const sbDir = LIVE_MODE ? LIVE_SPEC.switchboardDir : path.join(root, 'dshhome', 'switchboard')
const frontUrl = LIVE_MODE ? LIVE_SPEC.front : ports.front
const adminUrl = LIVE_MODE ? LIVE_SPEC.admin : ports.admin
console.log(`\n===== arm-up · ${LIVE_MODE ? '现役（--live）' : '臂 ' + armName} =====`)
if (LIVE_MODE) {
  console.log('  ★ 现役模式：**不需要任何参数**（端口固定 3080 / 池 3101 / 控制面 31800）')
  console.log(`  前端     : ${frontUrl}`)
} else {
  console.log(`  ★ 唯一自变量 = 臂名；端口段由臂序号派生（不再手抄）`)
  console.log(`  臂序号   : ${allArms.indexOf(armName)}（注册表 ${allArms.join(', ')}）`)
  console.log(`  根目录   : ${root}`)
  console.log(`  端口段   : switch=${ports.base}  gen=${ports.genBase}+  pool=${ports.pool}  admin=${ports.base + 100}  handover=${ports.base + 110}`)
  console.log(`  现役占用 : ${[...LIVE_PORTS].join(', ')}（派生结果不许落进来）`)
}

// ── ★★ 段位归属前置断言（**仅臂模式**）：那一段若有人在应答，**必须证明是本实例的**（看 lease）──
//    否则就是"别人占着这段"（我第一版正是把臂 A 的前门当成了臂 B 的）⇒ **拒跑**。
//    ★ 现役模式不适用：现役就是 3080，不存在"段位归属"这个问题。
//
// ★★★ 2026-09-26 加：**lease 里的那个 pid 必须是活的**，否则就是"僵尸 lease"。
//   真事故（我三路交叉验过）：臂 A 的 `lease.json` 写 `activeGen.pid = 9224`，而
//   `tasklist /FI "PID eq 9224"` ⇒ **进程不存在**；`:33082`/`:33101` 实际握在 **pid 16520** 手里。
//   成因：`arm-up` 走 `isolated-instance … --force` ⇒ 每次**重新准备+重新起代**，但**旧代从不停** ⇒
//   新代绑不上池（boot.log：`33101 被占 … 连续 9 次拿不到 ⇒ 本代没有池`）⇒ 新代死；
//   **而 lease 已被改写成新代（死掉的）pid** ⇒ 从此 lease 指向**尸体**。
//   ⇒ 而**旧检查只看 `lease.activeGen.gen` 是不是非空字符串** ⇒ 僵尸 lease 被当成"这是我的实例⇒安全"。
//   ★ 后果 = **臂永久卡死**：第一次 arm-up 成功，之后每次都在 ⑥/⑦ 上红（而根因被这一条掩盖）。
//   ★ 判据（不许读注释、不许读意图）：**去系统里问那个 pid 还在不在跑**。
/** 该 pid 是否在运行（`process.kill(pid, 0)` 不发信号、只做存在性探测 —— 跨平台可用）。 */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    // EPERM = 进程在、但没权限（也算"活着"）；ESRCH = 真的不在
    return e?.code === 'EPERM'
  }
}

const leaseInfo = (() => {
  // ★ 2026-09-25 修：lease 在 **`<root>/dshhome/switchboard/lease.json`**（**不在** `<gen>/lease.json`）。
  //   我第一版找 `<gen>/lease.json` ⇒ 恒 false ⇒ **把自己的实例误判成"别人占着"⇒ 误拒**。
  const f = path.join(sbDir, 'lease.json')
  if (!fs.existsSync(f)) return { exists: false, gen: null, pid: null, alive: false }
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    const gen = j?.activeGen?.gen ?? null
    const pid = j?.activeGen?.pid ?? null
    return { exists: true, gen, pid, alive: pid ? pidAlive(pid) : false }
  } catch { return { exists: true, gen: null, pid: null, alive: false } }
})()
const rootHasLease = !!leaseInfo.gen
const preFront = await rpc(frontUrl, 'session.list')
const preAdmin = await get(`${adminUrl}/?cmd=status`)
const someoneThere = preFront.http === 200 || preAdmin.http === 200
if (!LIVE_MODE && someoneThere && !rootHasLease) {
  console.error(
    `[失败] 端口段 ${ports.base} 已经**有人在应答**，但 ${path.join(root, 'dshhome')} 里没有 lease ⇒\n` +
      `  那一段**不是本实例的**（很可能是别的臂占着）⇒ 拒跑。\n` +
      `  ⇒ 请换一个臂名，或先把那一段上的实例停掉。`,
  )
  process.exit(2)
}
// ★★★ 僵尸 lease：有 lease，但**它指的 pid 已经不在跑** ⇒ 拒跑并**指名道姓**（别让它默默继续）。
//   为什么必须拒：继续下去会"重新起一代"，而端口实际被**另一个还活着的进程**握着 ⇒
//   新代绑不上池、当场死掉、lease 又被改写成新的尸体 ⇒ **僵尸状态自我延续**（实测如此）。
if (!LIVE_MODE && leaseInfo.exists && rootHasLease && !leaseInfo.alive) {
  const holder = leaseInfo.pid ? `（lease 说 pid=${leaseInfo.pid}）` : ''
  console.error(
    `[失败] **僵尸 lease**：${path.join(sbDir, 'lease.json')} 指向 gen=${leaseInfo.gen}${holder}，\n` +
      `  但**那个进程已经不在运行** ⇒ 若继续"起一代"，新代多半绑不上端口（旧代还没退）⇒ 又留一个尸体。\n` +
      `  ⇒ 先收拾干净再跑：把仍在监听本段端口的进程停掉（本段的 front=${ports.front} pool=:${ports.pool}），\n` +
      `     或删掉 ${path.join(sbDir, 'lease.json')} 后重跑（★ 只在确认没有活着的旧代时才这么做）。`,
  )
  process.exit(2)
}
if (someoneThere) {
  const aliveNote = LIVE_MODE ? '' : `，且本 root 有 lease${leaseInfo.alive ? '（pid 活着）' : ''}`
  console.log(`  （前置：已在应答${aliveNote} ⇒ 确认是**本实例**，将继续；② 会跳过启动）`)
}

// ── 现役：不需要"准备"（不复制 profile、不带臂身份）⇒ 已在跑就跳过，否则 relaunch ──
if (LIVE_MODE && !hasFlag('--no-start')) {
  if (someoneThere) {
    console.log('\n-- 起 —— **跳过**：现役已在应答（只做自检）--')
  } else {
    console.log('\n-- 起（现役：relaunch，不带臂身份）--')
    const l = spawnSync('cmd', ['/c', path.join(WT, 'scripts', 'relaunch-switchboard.cmd')], { encoding: 'utf8', timeout: 120000 })
    console.log(`  relaunch exit=${l.status}（它自己返回后服务在后台起）`)
  }
}

// ① 准备（复用 isolated-instance，端口只传 base）—— **仅臂模式**
if (!hasFlag('--no-start') && !LIVE_MODE) {
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
  front = await rpc(frontUrl, 'session.list')
  if (front.http === 200 && front.ok) break
  process.stdout.write('.')
}
console.log('')

// ④ 自检（★ "起来了"的定义）
const admin = await get(`${adminUrl}/?cmd=status`)
// ★ 问控制面要现行代（权威）—— 不靠猜 mtime（见 latestBootLog 的注释）
let activeGenName = null
try { activeGenName = JSON.parse(admin.text)?.lease?.activeGen?.gen ?? null } catch { /* 控制面没答 */ }
const boot = latestBootLog(sbDir, activeGenName)
console.log(`  现行代（控制面权威）= ${activeGenName ?? '(拿不到，退化为按 boot.log mtime)'}`)
const t = boot?.text ?? ''
const isolationLogOk = /\[arm-isolation\] apply running/.test(t)
const denyCount = Number((t.match(/denyRoots=(\d+) 条/) ?? [])[1] ?? 0)
const seatsLogOk = /provider="evo-dev"/.test(t) && /provider="evo-review"/.test(t)
const poolLogOk = new RegExp(`\\[key-pool-proxy\\] listening 127\\.0\\.0\\.1:${ports.pool}\\b`).test(t)
// 现役模式还要判"前端可取"（点了就有界面）—— 臂模式不判这条
let htmlOk = null
if (LIVE_MODE) {
  const h = await get(`${frontUrl}/`)
  htmlOk = h.http === 200 && /<html|<!doctype/i.test(h.text)
}
// ★ 2026-09-26：⑦ 的探针**带超时 + 有界重试**（5×20s），并把结果**分类**（ok/slow/unreachable）。
//   起因是实测的真假红：现役正在跑"发起本实验的那个会话"时，裸探针 5/6 次 `http:0` ⇒ 整条链自锁。
const live = await rpc('http://127.0.0.1:3080', 'session.list')
const rows = judgeSelfCheck({
  ports, front, admin, isolationLogOk, denyCount, seatsLogOk, poolLogOk,
  liveOk: live.http === 200 && live.ok, liveKind: live.kind ?? null,
  mode: LIVE_MODE ? 'live' : 'arm', htmlOk,
})

console.log('-- ④ 自检（"起来了" = 这些全过）--')
for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name} — ${r.detail}`)
console.log(`\n  boot.log = ${boot?.file ?? '(没找到)'}`)
const allOk = rows.every((r) => r.ok)
console.log(`\n===== ${allOk ? '✅ 起来了（自检全过）' : '❌ 没起来（照上面 ❌ 那条查）'} =====`)

// ★★ `--open`：起完**直接把界面打开** —— 这就是"像桌面应用那样，点了就有界面"
//    （`dsh-up.cmd` 默认带这个开关 ⇒ 双击桌面图标 = 起服务 + 开界面，不需要任何参数）
if (hasFlag('--open') && allOk) {
  try {
    spawn('cmd', ['/c', 'start', '""', frontUrl], { detached: true, stdio: 'ignore', shell: false }).unref()
    console.log(`  🌐 已打开界面：${frontUrl}`)
  } catch (e) {
    console.log(`  （自动开界面失败，请手动打开 ${frontUrl}：${e?.message ?? e}）`)
  }
}
if (hasFlag('--json')) console.log(JSON.stringify({ mode: LIVE_MODE ? 'live' : 'arm', arm: armName, ports, root, rows, gen: boot?.gen }, null, 2))
process.exit(allOk ? 0 : 1)
