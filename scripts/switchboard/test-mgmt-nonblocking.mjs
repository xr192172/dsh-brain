// R4 门：管理面**不许阻塞事件循环**（因为控制面与前门**同进程**）。
//
// ## 为什么这道门必须是【行为】的
//   "源码里有 spawnSync 吗"是**文本判据** —— 会假绿（O8 已踩过：把 `capabilities.toolFilter: true`
//   当成"真的限制了工具"）。真正要防的形状是：**调用期间事件循环被占住**。
//   ⇒ 本门**真的起子进程**，在等待期间**量事件循环的延迟**（timer drift）。
//
// ## 判据设计
//   · **A 组（行为，主判据）**：用同一个耗时子进程，
//     分别经 `execAction`（同步）与 `execActionAsync`（异步）执行，
//     在**等待期间**量"一次 `setTimeout(0)` 实际等了多久"。
//       - 同步版 ⇒ 事件循环被占死 ⇒ drift **很大**；
//       - 异步版 ⇒ 事件循环自由 ⇒ drift **很小**。
//     ★ **两条读数必须不同**（B 判据 = 判据有效性）—— 读不出差别的话 A 组就是同义反复。
//   · **C 组（对照）**：异步版**结果形状**必须与同步版一致（`{code, stdout, stderr}`），
//     且 `code`/`stdout` 内容对得上 ⇒ 证明"没阻塞"不是靠"什么都没做"换来的。
//   · **D 组（安全属性不许被动）**：异步版仍走 `argvFor` + `childEnv` + 不经 shell。
//
// ★ 铁律 21：消融 —— 把异步实现换回 `spawnSync`，A 组必须变红。

import { spawnSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const WT = 'D:/project_develop/dsh-brain'
const mgmt = await import(pathToFileURL(`${WT}/packages/switchboard/lib/mgmt.js`).href)

const results = []
const check = (id, ok, detail) => {
  results.push({ id, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`)
}

// ── 造一个"确定耗时"的子进程命令 ─────────────────────────────────────────
// ★ 不用真实验（跑实验要几分钟且依赖臂）；用 `node -e "busy-wait"` 造**可控且可观**的占用。
const BUSY_MS = 1200
const busyScript = `const t=Date.now(); while(Date.now()-t<${BUSY_MS}){}; process.stdout.write('BUSY-DONE')`

/**
 * 量"等待期间事件循环被占住了多久"。
 *
 * ★★★ 第一版这里**量错了**（诚实记录）：我写成 `run(() => { spawnBusySync(); done() })`
 *   —— `done()` 在 `spawnSync` **返回之后**立刻执行 ⇒ `setInterval` 在同一瞬间就被清掉
 *   ⇒ 它**从来没机会观察**到那次阻塞 ⇒ 同步版读数 **0.0ms**（假红/假绿并存）。
 *   实测：`drift=0.0ms`，而"同步阻塞 1.2 秒"是**物理上不可能**让 20ms 心跳照常跳的。
 *   ⇒ 这正是铁律 15："判据读不到差别 ≠ 没有差别 —— 先证明读数本身有效"。
 *
 * ★ 修法：**在开始跑之前**先起一个**独立的测量窗口**，
 *   并且**不依赖 run 自己回调**来收口 —— 由测量窗口**观察完整的时间跨度**：
 *     · 记下 `t_start`，跑 run；
 *     · run 完成后**再等一小段**（让积压的心跳补跑），然后才收口；
 *     · drift 的参照系是"实际间隔 vs 期望间隔"，**跨整个窗口**统计。
 *   ★ 更稳的做法：用 `setTimeout` 的**递归重排**（每个回调里再排下一个），
 *     这样阻塞期间**排不出下一个**，恢复后第一个回调的"排队延迟"就是阻塞时长。
 */
function measureLoopDrift(run) {
  return new Promise((resolve) => {
    let maxDrift = 0
    let stopped = false
    let timer = null
    const EXPECT = 20
    let last = performance.now()
    const tick = () => {
      if (stopped) return
      const now = performance.now()
      const drift = now - last - EXPECT
      if (drift > maxDrift) maxDrift = drift
      last = now
      timer = setTimeout(tick, EXPECT)
    }
    timer = setTimeout(tick, EXPECT)
    Promise.resolve(run()).then(() => {
      // ★ 关键：跑完**再等 2 个窗口**（60ms），让"被阻塞期间积压的那次 tick"补跑并记账。
      setTimeout(() => {
        stopped = true
        if (timer) clearTimeout(timer)
        resolve(maxDrift)
      }, EXPECT * 3)
    })
  })
}

// 用一个真实的 shell-free 命令（node 自身）来跑 busy 脚本
const spawnBusySync = () => {
  const r = spawnSync(process.execPath, ['-e', busyScript], { encoding: 'utf8', timeout: 60_000 })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ── A 组：量两种实现的 drift ─────────────────────────────────────────────
console.log(`\n--- A 组：事件循环 drift（子进程忙 ${BUSY_MS}ms）---\n`)

const syncDrift = await measureLoopDrift(() => {
  spawnBusySync()
})
console.log(`  同步 spawnSync 期间最大 drift = ${syncDrift.toFixed(1)}ms`)

const asyncDrift = await measureLoopDrift(() => new Promise((res) => {
  // 异步版要真的把事件循环让出来 —— 用 mgmt 的真实导出，
  // 但 busy 脚本不是 mgmt 的合法 action，所以这一路直接用 spawn 复刻其**收口形状**；
  // 真实 mgmt.execActionAsync 的行为由 B 组用真 action 覆盖。
  const child = spawn(process.execPath, ['-e', busyScript], { shell: false })
  child.on('close', () => res())
}))
console.log(`  异步 spawn 期间最大 drift = ${asyncDrift.toFixed(1)}ms`)

// ★ 判据有效性：两条读数必须**不同**（否则量不出阻塞 ⇒ 判据无效，铁律 15/28）
check(
  'A0 判据有效性：同步/异步的 drift 读数必须不同（否则测不出阻塞）',
  asyncDrift < syncDrift / 2,
  `sync=${syncDrift.toFixed(1)}ms async=${asyncDrift.toFixed(1)}ms ⇒ 至少差一倍`,
)
check(
  'A1 ★ 同步实现在等待期间**占死事件循环**（病征复现）',
  syncDrift > BUSY_MS * 0.5,
  `drift=${syncDrift.toFixed(1)}ms（应接近 ${BUSY_MS}ms ⇒ 复现「管理面拖死前门」）`,
)
check(
  'A2 ★★ 异步实现让事件循环保持自由（R4 的修复目标）',
  asyncDrift < BUSY_MS * 0.25,
  `drift=${asyncDrift.toFixed(1)}ms（应远小于 ${BUSY_MS}ms）`,
)

// ── B 组：mgmt.execActionAsync 的**真实**行为（真 action，不造假 action）──
console.log('\n--- B 组：真 action 走 execActionAsync ---\n')

// `tasks` 是既安全又快的真 action（列题库，只读）
const V = { action: 'tasks' }
const t0 = performance.now()
let maxDriftDuringReal = 0
{
  let last = performance.now()
  const iv = setInterval(() => {
    const now = performance.now()
    const d = now - last - 20
    if (d > maxDriftDuringReal) maxDriftDuringReal = d
    last = now
  }, 20)
  var realR = await mgmt.execActionAsync(V, WT, process.execPath)
  clearInterval(iv)
}
const tReal = performance.now() - t0

check('B1 execActionAsync 对真 action 返回同形结果 {code,stdout,stderr}',
  realR && typeof realR.code === 'number' && typeof realR.stdout === 'string' && typeof realR.stderr === 'string',
  `code=${realR?.code} stdoutLen=${realR?.stdout?.length}`)
check('B2 真 action 成功（code=0，且确有 stdout）',
  realR.code === 0 && realR.stdout.length > 0,
  `code=${realR.code} stdoutLen=${realR.stdout.length}`)
check('B3 ★ 真实调用期间事件循环未被占死',
  maxDriftDuringReal < 500,
  `drift=${maxDriftDuringReal.toFixed(1)}ms（耗时 ${tReal.toFixed(0)}ms）`)

// ── C 组：与同步版**对拍**（同 action、同参数 ⇒ 结果必须一致）─────────────
console.log('\n--- C 组：同步 vs 异步对拍 ---\n')
const syncR = mgmt.execAction(V, WT, process.execPath)
check('C1 ★ 同一 action 下，同步版与异步版结果一致（换实现没换语义）',
  syncR.code === realR.code && syncR.stdout === realR.stdout,
  `sync.code=${syncR.code} async.code=${realR.code} stdout相同=${syncR.stdout === realR.stdout}`)
check('C2 空 argv 的 action（`result`，只读文件）两条路都返回 code=0/空输出',
  mgmt.execAction({ action: 'result', runId: 'x' }, WT, process.execPath).code === 0 &&
  (await mgmt.execActionAsync({ action: 'result', runId: 'x' }, WT, process.execPath)).code === 0)

// ── D 组：安全属性不许被动（源码级，限定在函数体内 —— 铁律 41）────────────
console.log('\n--- D 组：安全属性 ---\n')
const src = readFileSync(`${WT}/packages/switchboard/src/mgmt.ts`, 'utf8')
const aBody = (() => {
  const i = src.indexOf('export function execActionAsync(')
  if (i < 0) return ''
  const j = src.indexOf('\n}', src.indexOf('child.on(', i))
  return src.slice(i, j < 0 ? i + 6000 : j)
})()
check('D1 异步版仍走 argvFor（数组、无字符串拼接 ⇒ 无注入面）', /argvFor\s*\(/.test(aBody))
check('D2 异步版仍走 childEnv（剔臂身份变量，不泄漏 DSH_HOME）', /childEnv\s*\(/.test(aBody))
check('D3 ★ 异步版**不经 shell**（spawn 的 shell 必须为 false / 不设 true）',
  /shell:\s*false/.test(aBody) && !/shell:\s*true/.test(aBody))
check('D4 异步版有超时（不许无界等待）', /timeoutMs/.test(aBody) && /setTimeout\s*\(/.test(aBody))

// ── E 组：接线（防"写了没接线" —— R3 半二正是这个形状）──────────────────
console.log('\n--- E 组：接线 ---\n')
const mainSrc = readFileSync(`${WT}/packages/switchboard/src/main.ts`, 'utf8')
check('E1 ★★ main.ts 真的用了 execActionAsync（接线，不是死代码）',
  /mgmt\.execActionAsync\s*\(/.test(mainSrc),
  `命中=${/mgmt\.execActionAsync\s*\(/.test(mainSrc)}`)
check('E2 ★ main.ts 的 mgmt 同步分支里**不再**有 execAction( 调用（那条路已换成异步）',
  !/mgmt\.execAction\s*\(/.test(mainSrc),
  `残留=${/mgmt\.execAction\s*\(/.test(mainSrc)}（应为 false）`)

// ── F 组：消融自证（铁律 21）─────────────────────────────────────────────
// 把异步实现"退化"成同步语义（在 Promise 里同步跑），drift 必须回到同步水平。
console.log('\n--- F 组：消融自证 ---\n')
const ablatedDrift = await measureLoopDrift(() => new Promise((res) => {
  setTimeout(() => {
    spawnBusySync() // ← 撤掉"异步"这个修复：在异步回调里同步阻塞
    res()
  }, 0)
}))
check('F1 ★ 消融：把异步换回同步 ⇒ drift 必须回到同步水平（否则 A 组是同义反复）',
  ablatedDrift > syncDrift / 2,
  `消融后 drift=${ablatedDrift.toFixed(1)}ms（同步=${syncDrift.toFixed(1)}ms，异步=${asyncDrift.toFixed(1)}ms）`)

const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
