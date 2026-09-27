// R3 门：租约 / 池的**活体守卫**必须真的在工作（消融自证 + 阳性对照）。
//
// 判据分两层（★ 铁律 11：数"判据为真的次数"，不读意图）：
//   A. 行为层（主判据）—— 直调**真实产物**的 PoolStore / 真实探针语义，
//      喂死 pid / 活 pid，看读数是否**不同**（判据必须能红）。
//   B. 接线层（防"函数写了但从没接线" —— 这正是 R3 第二半的原始病）——
//      静态断言 `main.ts` 真的调了 `pruneStaleSentinels()`、`ensureActiveLease()` 的返回值被检查。
//
// ★ 铁律 21：消融自证 —— 本门末尾会**把守卫撤掉再判一次**，必须变红；否则门是假的。

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const WT = 'D:/project_develop/dsh-brain'
const results = []
const check = (id, ok, detail) => {
  results.push({ id, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`)
}

const rd = (rel) => readFileSync(join(WT, rel), 'utf8')

// ── 载入真实产物 ────────────────────────────────────────────────────────────
const { PoolStore } = await import(pathToFileURL(join(WT, 'packages/switchboard/lib/pool.js')).href)
const { LeaseStore } = await import(pathToFileURL(join(WT, 'packages/switchboard/lib/lease.js')).href)
check('P0 载入真实产物（PoolStore/LeaseStore，不是源码文本）', typeof PoolStore === 'function' && typeof LeaseStore === 'function')

// 复刻生产探针（= coordinator.ts 里的 pidAliveFrom，逐字同款语义）
const pidAliveFrom = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// 拿一个**确定已死**的 pid + 一个**确定活着**的 pid
const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' }).pid
const livePid = process.pid
check('P0b 基线自证：deadPid 真的死 / livePid 真的活',
  !pidAliveFrom(deadPid) && pidAliveFrom(livePid), `dead=${deadPid}(alive=${pidAliveFrom(deadPid)}) live=${livePid}(alive=${pidAliveFrom(livePid)})`)

const dirs = []
const inDir = (fn) => {
  const d = mkdtempSync(join(tmpdir(), 'r3-gate-'))
  dirs.push(d)
  try { return fn(d) } finally { rmSync(d, { recursive: true, force: true }) }
}

// ── A. 行为层 ───────────────────────────────────────────────────────────────

// A1 ★★ 主判据：pruneDead + 真探针，**死哨兵必须被摘、活哨兵必须留下**
const a1 = inDir((dir) => {
  const p = new PoolStore(dir)
  p.stand({ gen: 'gen-dead', port: 3090, pid: deadPid })
  p.stand({ gen: 'gen-live', port: 3091, pid: livePid })
  const before = p.current
  const { dropped } = p.pruneDead((g) => pidAliveFrom(g.pid))
  const after = p.current
  return { before, dropped: dropped.map((g) => g.gen), after }
})
check(
  'A1 死哨兵被摘、活哨兵留下（真实探针 + 真实 PoolStore）',
  a1.dropped.includes('gen-dead') &&
    !a1.dropped.includes('gen-live') &&
    JSON.stringify(a1.after).includes('gen-live') &&
    !JSON.stringify(a1.after).includes('gen-dead'),
  `dropped=[${a1.dropped.join(',')}] 剩余含 live=${JSON.stringify(a1.after).includes('gen-live')} 残留 dead=${JSON.stringify(a1.after).includes('gen-dead')}`,
)

// A2 ★ 判据有效性：探针必须**能读出差别**（若探针恒返回同一值，A1 就是同义反复）
const probeReads = new Set([pidAliveFrom(deadPid), pidAliveFrom(livePid)])
check('A2 判据有效性：探针对死/活 pid 读数必须不同', probeReads.size === 2, `读数集合=${JSON.stringify([...probeReads])}`)

// A3 ensureActiveLease 语义：尸体 ⇒ 拒绝授予（lease 保持空）
const a3 = inDir((dir) => {
  const l = new LeaseStore(dir)
  l.grant('gen-dead', 3090, deadPid, 60_000, 0, 'replay')
  l.clear()
  // 复刻修好后的 ensureActiveLease：先探活
  const guarded = (gen, pid) => {
    if (l.isHeld()) return false
    if (!pidAliveFrom(pid)) return false
    l.grant(gen, 3090, pid, 60_000, -1, 'replay')
    return true
  }
  const deadGranted = guarded('gen-dead', deadPid)
  const deadLease = l.current.activeGen.gen
  l.clear()
  const liveGranted = guarded('gen-live', livePid)
  return { deadGranted, deadLease, liveGranted }
})
check('A3 尸体 ⇒ 拒绝授予租约（lease 不指向 corpse）', a3.deadGranted === false, `granted=${a3.deadGranted}`)
check('A4 ★ 阳性对照（正交）：活 pid ⇒ 照常授予（护栏不是"逢事必拦"）', a3.liveGranted === true, `granted=${a3.liveGranted}`)

// ── B. 接线层（防"写了但从没接线"）──────────────────────────────────────────

const coordSrc = rd('packages/switchboard/src/coordinator.ts')
const mainSrc = rd('packages/switchboard/src/main.ts')

// B1 ensureActiveLease 体内必须有活体守卫
const ealBody = (() => {
  const i = coordSrc.indexOf('ensureActiveLease():')
  if (i < 0) return ''
  return coordSrc.slice(i, coordSrc.indexOf('getLease():', i))
})()
check('B1 ensureActiveLease 体内有 pidAliveFrom 守卫', /pidAliveFrom\s*\(/.test(ealBody), `体内含 pidAliveFrom=${/pidAliveFrom\s*\(/.test(ealBody)}`)
check('B2 ensureActiveLease 的返回值类型是 boolean（调用方可分流）', /ensureActiveLease\(\):\s*boolean/.test(coordSrc))

// B3 ★★ pruneStaleSentinels 必须**真的被 main.ts 调用**（第二半原始病 = 函数写好了没接线）
check('B3 pruneStaleSentinels 被定义', /pruneStaleSentinels\s*\(\)/.test(coordSrc))
check('B4 ★★ pruneStaleSentinels 被 main.ts 真的调用（接线，不是死代码）',
  /coord\.pruneStaleSentinels\s*\(/.test(mainSrc),
  `main.ts 命中=${/coord\.pruneStaleSentinels\s*\(/.test(mainSrc)}`)

// B5 main.ts 必须检查 ensureActiveLease 的返回值（不静默吞掉"拒绝"）
check('B5 ★ main.ts 检查了 ensureActiveLease 的返回值（拒绝不被静默吞掉）',
  /if\s*\(\s*!\s*coord\.ensureActiveLease\s*\(\s*\)\s*\)/.test(mainSrc))

// B6 `?cmd=pool` 必须把剪枝结果如实回给调用方（pruned 字段）
const poolHandler = (() => {
  const i = mainSrc.indexOf("cmd === 'pool'")
  return i < 0 ? '' : mainSrc.slice(i, i + 1400)
})()
check('B6 ?cmd=pool 回传 pruned 字段（摘掉什么如实登记，不静默丢）', /\bpruned\b\s*:/.test(poolHandler))

// B7 ★★★ 防"用文件注入去测剪枝"这个**假红陷阱**（我本轮真踩过）。
//   事实：`PoolStore` 在**内存里缓存 state**（构造时 load 一次），
//   且 `pool.json` 是**单一写者**文件（铁律 31）⇒ 外部改盘上的 json **永远到不了活实例**，
//   反而会被实例下一次 `commit()` **覆盖**。
//   ⇒ 于是"往 pool.json 塞一个死哨兵，再请求 ?cmd=pool"这个测法**测不到任何东西**：
//     `pruned` 必然是空（不是剪枝生效，是注入根本没进去）。
//   本判据把这个事实**钉住**：如果哪天有人（包括我）在门或探针里用文件注入冒充验证，
//   这条会红。判据落在**行为**上（真造一个实例，验证注入确实无效）。
const b7 = inDir((dir) => {
  const p = new PoolStore(dir)
  p.stand({ gen: 'gen-REAL', port: 3091, pid: livePid })
  const onDisk = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8'))
  onDisk.sentinel = { gen: 'gen-INJECT', port: 3099, pid: deadPid }
  writeFileSync(join(dir, 'pool.json'), JSON.stringify(onDisk, null, 2), 'utf8')
  const seenByInstance = JSON.stringify(p.current) // 实例仍读内存
  p.pruneDead(() => true) // 任意一次 commit
  const afterCommit = readFileSync(join(dir, 'pool.json'), 'utf8')
  return { seenByInstance, injectedSurvives: afterCommit.includes('gen-INJECT') }
})
check(
  'B7 ★★★ 文件注入对池【无效】（证明剪枝只能走真实 stand 路径验证，防"假红测法"再犯）',
  b7.injectedSurvives === false && !b7.seenByInstance.includes('gen-INJECT'),
  `一次 commit 后注入项仍在?=${b7.injectedSurvives}（应为 false ⇒ 注入被覆盖，故文件注入测不出剪枝）`,
)

// ── C. 消融自证（★ 铁律 21：撤掉修复，判据必须变红）────────────────────────
// 把 coordinator.ts 的**守卫**从内存文本里删掉，再对同一组文本判据跑一遍。
// 若删完后判据仍然全绿 ⇒ 本门的文本判据是同义反复（铁律 28）。
//
// ★ 踩过的坑：仓库源文件是 **CRLF**（`\r\n`），第一版消融正则以 `\n\s*\}` 结尾 ⇒ **永不匹配**
//   ⇒ "撤掉后仍含 pidAliveFrom=true" 假红。**是消融脚本错了，不是守卫错了。**
//   ⇒ 修法：统一 `\r\n → \n` 后再匹配（行尾无关）。
const normalizeEol = (s) => s.replace(/\r\n/g, '\n')
const normCoord = normalizeEol(coordSrc)
const ablated = normCoord.replace(
  /if \(!pidAliveFrom\(this\.active\.inst\.pid\)\) \{[\s\S]*?\n    \}\n/,
  '',
)
const ablatedBody = (() => {
  const i = ablated.indexOf('ensureActiveLease():')
  return i < 0 ? '' : ablated.slice(i, i + 400)
})()
const ablatedStillGuarded = /pidAliveFrom\s*\(/.test(ablatedBody)
check('C1 ★ 消融：撤掉守卫后 B1 必须变红（否则门是同义反复）', ablatedStillGuarded === false,
  `撤掉后仍含 pidAliveFrom=${ablatedStillGuarded}（应为 false）`)
// ★ C1b 反面自证：**不**撤掉时 B1 必须仍绿（证明 C1 的删除真的生效、且 B1 判的是同一段文本）
check('C1b ★ 消融有效性：未撤掉时同一段文本必须仍判"有守卫"（否则 C1 是假红）',
  /pidAliveFrom\s*\(/.test((() => {
    const i = normCoord.indexOf('ensureActiveLease():')
    return i < 0 ? '' : normCoord.slice(i, i + 400)
  })()) === true)

const ablatedMain = mainSrc.replace(/coord\.pruneStaleSentinels\s*\(\s*\)/g, 'null')
check('C2 ★ 消融：撤掉接线后 B4 必须变红',
  /coord\.pruneStaleSentinels\s*\(/.test(ablatedMain) === false)

for (const d of dirs) rmSync(d, { recursive: true, force: true })

const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
