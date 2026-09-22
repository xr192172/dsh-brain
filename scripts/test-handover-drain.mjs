#!/usr/bin/env node
/**
 * test-handover-drain.mjs —— 「换代前必须真的停写」的回归守卫（2026-09-15 事故）
 *
 * ## 守的是什么
 *
 * `session-3d8ea18d`（2026-09-15 22:30）出现了 **seq 回退 + 区间重叠**，成因是：
 * `freeze` 只发了个通知 + 睡 400ms，**既没停正在跑的回合，也没等落盘**，
 * 于是旧代照写、新代（按磁盘前缀懒加载同一会话）照接 —— 两代并发追加同一份日志。
 * `dsh-session` 的 seq 就是 `log.length`，所以这不是"小概率竞态"，是**必然重叠**。
 *
 * ## 两段 + 三方向
 *
 * A. **直测** `packages/switchboard/lib/drain.js` 的产物（假 agent / 假 session 注入）：
 *    - 该红的红：有回合在跑却报"已静止"必须被拦；`maintenance` 不得被当成空闲；flush 失败不得算停写。
 *    - 该绿的不红：cancel 后确实 idle ⇒ 必须报"可以交出"，且 lastSeq/主会话正确。
 * B. **接线与顺序**（源码级）：freeze 必须走 drain；封口必须在**释放前门锁之前**。
 *    这一段的判据函数是**两方向自证**的：把真实源码喂进去必须过，把"去掉强杀"和
 *    "把强杀挪到解锁之后"两处植错喂进去必须**报红** —— 否则它只是一句口号。
 *
 * 用法：node scripts/test-handover-drain.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * ★★ 2026-09-22（O69 / R1「判据必须在 Agent 够不到的地方」）——
 * 本题（cli-0002 / cli-0003）的 oracle 也必须能被**指向你指定的工作树**。
 * 优先级：`--repo <path>` ＞ 环境变量 `DSH_EVAL_REPO` ＞ **原来的硬编码值**（fallback）。
 * ★ **不许弱化判据**：两个都没给时 `REPO` **就是改动前那个字符串** ⇒ 输出与退出码逐字不变。
 */
const REPO_GIVEN = (() => {
  const i = process.argv.indexOf('--repo')
  return (i < 0 ? null : (process.argv[i + 1] ?? null)) ?? process.env.DSH_EVAL_REPO ?? null
})()
const REPO = REPO_GIVEN ? path.resolve(REPO_GIVEN) : 'D:/project_develop/dsh-brain'
const LIB = path.join(REPO, 'packages/switchboard/lib/drain.js')
const IDX = path.join(REPO, 'packages/switchboard/src/index.ts')
const COORD = path.join(REPO, 'packages/switchboard/src/coordinator.ts')

let pass = 0
let fail = 0
const failures = []
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log('  FAIL ' + n + ' — ' + d) }
const truthy = (n, v, d = '') => (v ? ok(n) : bad(n, d || `期望为真，实得 ${JSON.stringify(v)}`))

// ── A. 直测 drain 产物 ─────────────────────────────────────────────────────
console.log('== A. drain.js：静止判据的三方向 ==')
if (!fs.existsSync(LIB)) {
  bad('编译产物存在', `${LIB} 不存在 —— 先构建 switchboard（packages/switchboard/scripts/build.mjs）`)
} else {
  const { drainForHandover, agentPhase, sealPlan } = await import(pathToFileURL(LIB).href)
  truthy('drainForHandover / agentPhase / sealPlan 已导出', typeof drainForHandover === 'function' && typeof agentPhase === 'function' && typeof sealPlan === 'function')

  // 假件：agent 的 phase 用 runner 控制；session 的 seq 由 test 指定
  const mkAgent = (id, sessionId, phaseKind, { goesIdle = true, neverSettles = false } = {}) => {
    const a = {
      id,
      sessionId,
      phaseKind,
      cancelled: 0,
      cancel() {
        a.cancelled += 1
        if (goesIdle) a.phaseKind = 'idle'
      },
      whenIdle: () => (neverSettles ? new Promise(() => {}) : Promise.resolve()),
    }
    return a
  }
  const mkSession = (id, seq) => ({ id, seq })
  const flushOk = async () => true
  const flushThrow = async (s) => { throw new Error('flush failed for ' + s.id) }

  // A1 ★ 红方向（该红必须红）：回合在跑、cancel 之后**没有**回到 idle（主线程被占/僵死）
  {
    const stuck = mkAgent('a1', 'session-A', 'running', { goesIdle: false, neverSettles: true })
    const r = await drainForHandover({
      agents: [stuck],
      sessions: [mkSession('session-A', 630)],
      flush: flushOk,
      turnTimeoutMs: 40,
      maintenanceTimeoutMs: 40,
    })
    truthy('A1 卡住的回合 ⇒ quiesced=false（不许报"已静止"）', r.quiesced === false, JSON.stringify(r))
    truthy('A1 仍然发出了 cancel（尽力去停）', stuck.cancelled === 1, String(stuck.cancelled))
    truthy('A1 stillBusy 点名了它（可观测，不静默）', r.stillBusy.includes('a1'), JSON.stringify(r.stillBusy))
    truthy('A1 runningAtEntry 记到了"有活在跑"', r.runningAtEntry === 1, String(r.runningAtEntry))
  }

  // A2 ★ 绿方向（该绿不能红）：cancel 后确实回到 idle
  {
    const a = mkAgent('a2', 'session-A', 'running')
    const r = await drainForHandover({
      agents: [a],
      sessions: [mkSession('session-A', 630), mkSession('session-B', 12)],
      flush: flushOk,
      lastActiveSessionId: 'session-B',
      turnTimeoutMs: 40,
      maintenanceTimeoutMs: 40,
    })
    truthy('A2 停住了 ⇒ quiesced=true', r.quiesced === true, JSON.stringify(r))
    truthy('A2 lastSeq = max(seq)-1 = 629', r.lastSeq === 629, String(r.lastSeq))
    truthy('A2 主活跃会话 = 那个**在跑**的 agent 的会话（不是 lastActive 的 B）', r.primarySessionId === 'session-A', r.primarySessionId)
    truthy('A2 sessions 全量上报（含各自 lastSeq）', r.sessions.length === 2 && r.sessions.some((s) => s.id === 'session-B' && s.seq === 11), JSON.stringify(r.sessions))
  }

  // A3 ★ maintenance 不是 idle：`status` 会把 maintenance 也算成 'idle'，只看 status 就会漏
  {
    const m = mkAgent('m1', 'session-M', 'maintenance', { goesIdle: false, neverSettles: true })
    const r = await drainForHandover({ agents: [m], sessions: [], flush: flushOk, turnTimeoutMs: 40, maintenanceTimeoutMs: 40 })
    truthy('A3 维护中（压缩等）⇒ 不许算静止', r.quiesced === false, JSON.stringify(r))
    truthy('A3 维护**不被 cancel**（半途中断可能留悬空 compaction 标记）', m.cancelled === 0, String(m.cancelled))
    truthy('A3 maintenanceAtEntry=1 且超时被点名', r.maintenanceAtEntry === 1 && r.maintenanceTimedOut === true, JSON.stringify(r))
    truthy('A3 agentPhase 认得出 maintenance（不靠 status）', agentPhase({ phaseKind: 'maintenance', status: 'idle' }) === 'maintenance')
    truthy('A3 拿不到 phase 时保守当 running（宁可多等，不许误判没在写）', agentPhase({ status: undefined }) === 'running')
  }

  // A4 ★ 落盘失败 ⇒ 不算停写（"没落盘"和"还在写"对读者等价）
  {
    const a = mkAgent('a4', 'session-A', 'running')
    const r = await drainForHandover({ agents: [a], sessions: [mkSession('session-A', 5)], flush: flushThrow, turnTimeoutMs: 40 })
    truthy('A4 flush 抛错 ⇒ quiesced=false', r.quiesced === false, JSON.stringify(r))
    truthy('A4 失败的会话被点名', r.flushFailed.includes('session-A'), JSON.stringify(r.flushFailed))
  }

  // A5 ★ sealPlan 两方向：没停写就必须强杀
  {
    truthy('A5 未停写 ⇒ killNow=true', sealPlan(false).killNow === true, JSON.stringify(sealPlan(false)))
    truthy('A5 已确认停写 ⇒ killNow=false（留作回滚网）', sealPlan(true).killNow === false, JSON.stringify(sealPlan(true)))
  }

  // A6 ★ 观察不到 agent 时**不许**报"停写"：空列表 ≠ 空闲（这是最容易长出来的假绿）
  {
    const r = await drainForHandover({ agentsObservable: false, agents: [], sessions: [], flush: flushOk, turnTimeoutMs: 20 })
    truthy('A6 看不到 agent ⇒ quiesced=false（宁可多杀，不许假绿）', r.quiesced === false, JSON.stringify(r))
    truthy('A6 诊断里能看到"不可观察"这件事', r.agentsObservable === false, JSON.stringify(r))
    // 反向：服务在、只是没 agent ⇒ 这才是真 idle，必须报 true（否则每次换代都白杀旧代、丢回滚网）
    const r2 = await drainForHandover({ agentsObservable: true, agents: [], sessions: [], flush: flushOk, turnTimeoutMs: 20 })
    truthy('A6-反向 可观察且真无 agent ⇒ quiesced=true', r2.quiesced === true, JSON.stringify(r2))
  }

  // A7 ★★ 2026-09-20 真机验收抓到的假绿：**看不到会话服务**时也不许报"停写"
  //     （真机上 `ctx.sessions` 未 inject ⇒ undefined ⇒ sessions=0 / lastSeq=-1 / **flush 从没跑过**，
  //      而空闲场景照样报 quiesced=true）
  {
    const r = await drainForHandover({ agentsObservable: true, sessionsObservable: false, agents: [], sessions: [], flush: flushOk, turnTimeoutMs: 20 })
    truthy('A7 看不到 sessions 服务 ⇒ quiesced=false（"没法确认落盘" ≠ "已落盘"）', r.quiesced === false, JSON.stringify(r))
    truthy('A7 诊断里能看到"会话不可观察"', r.sessionsObservable === false, JSON.stringify(r))
  }

  // A8 ★★ 真机验收抓到的假红：阶段必须是**实时读**，不能用建列表时的快照
  //     （现场：cancel 已经把回合停掉、日志里都写了 `turn/end aborted(hook)`，却仍报 stillBusy=[…]）
  {
    let live = 'running'
    const fake = {
      id: 'a8',
      sessionId: 'session-A8',
      readPhase: () => live,
      cancel() {
        live = 'idle' // 取消之后真的停了
      },
      whenIdle: () => Promise.resolve(),
    }
    const r = await drainForHandover({ agents: [fake], sessions: [], sessionsObservable: true, flush: flushOk, turnTimeoutMs: 40 })
    truthy('A8 cancel 后实时读到 idle ⇒ quiesced=true、stillBusy 为空（不许拿旧快照判）', r.quiesced === true && r.stillBusy.length === 0, JSON.stringify(r))
    truthy('A8 runningAtEntry 仍如实记到"开工时有 1 个在跑"', r.runningAtEntry === 1, String(r.runningAtEntry))
  }
}

// ── B. 接线与顺序（源码级，判据自身也要两方向自证）────────────────────────
console.log('')
console.log('== B. 接线：freeze 走 drain；封口必须在释放前门锁之前 ==')

/**
 * 去掉注释后再断言（**必须**）。
 * 教训（2026-09-20 当场踩到）：我在 `preseed.ts` 的注释里**写了旧 bug 的名字**
 * （说明"旧实现依赖上游不存在的 `listSessions`"），于是负向断言 `!/listSessions/` 直接**假红**。
 * 更危险的是反向：正向断言（"某段代码在"）会被**注释里的示例**满足 ⇒ 假绿。
 * ⇒ 凡是对源码做**文本**断言，一律先剥注释；能只对代码做断言就不要对文本做。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * 判据函数：给定 coordinator 源码文本，返回问题列表（空 = 过）。
 * 抽成函数是为了**自证**：真实源码喂进来必须过，植错的两份必须报红。
 */
function checkSealOrdering(src) {
  const problems = []
  const iKill = src.indexOf('if (seal.killNow) {')
  const iRetain = src.indexOf('setTimeout(() => void old.spawned.stop(), cfg.retainMs)')
  const iUnlock = src.indexOf('this.front.setLocked(false)')
  if (iKill < 0) problems.push('找不到 `if (seal.killNow) {` —— 封口分支被删了？')
  if (iRetain < 0) problems.push('找不到 retainMs 分支（已确认停写时的优雅退役）')
  if (iUnlock < 0) problems.push('找不到 `this.front.setLocked(false)`（finally 解锁）')
  if (iKill >= 0) {
    const killBlock = src.slice(iKill, src.indexOf('} else {', iKill) > 0 ? src.indexOf('} else {', iKill) : iKill + 2000)
    if (!/await old\.spawned\.stop\(/.test(killBlock)) problems.push('killNow 分支里没有 `await old.spawned.stop(` —— 强杀没落地（或没等它）')
    if (iUnlock >= 0 && iKill > iUnlock) problems.push('封口被挪到解锁之后 —— 前门先放锁，等于没封')
  }
  return problems
}

if (!fs.existsSync(COORD)) {
  bad('coordinator 源码可读', COORD)
} else {
  const src = fs.readFileSync(COORD, 'utf8')
  const probs = checkSealOrdering(src)
  if (probs.length) { bad('B1 真实源码通过顺序判据', probs.join('；')) } else { ok('B1 真实源码通过顺序判据（封口在解锁之前，且 await 了强杀）') }

  // ★ 判据自证：两份植错必须被同一判据抓出来（否则 B1 只是"关键词在场"）
  const plantedNoKill = src.replace(/if \(seal\.killNow\) \{/, 'if (false) {')
  const plantedLate = (() => {
    const i = src.indexOf('this.front.setLocked(false)')
    return src.slice(0, i) + '/* unlock-early */\n' + src.slice(i)
  })()
  truthy('B1-自证①「去掉强杀」必须报红', checkSealOrdering(plantedNoKill).length > 0, JSON.stringify(checkSealOrdering(plantedNoKill)))
  truthy('B1-自证②「强杀挪到解锁之后」必须报红（畸形源码：先解锁后强杀）', (() => {
    // 构造"解锁在前、封口在后"的顺序：把 finally 块整段前移
    const iUnlock = src.indexOf('this.front.setLocked(false)')
    const iKill = src.indexOf('if (seal.killNow) {')
    if (iUnlock < 0 || iKill < 0) return false
    const moved = src.slice(0, iKill) + src.slice(iUnlock, iUnlock + 40) + src.slice(iKill, iUnlock) + src.slice(iUnlock + 40)
    return checkSealOrdering(moved).length > 0
  })())
}

if (!fs.existsSync(IDX)) {
  bad('index.ts 源码可读', IDX)
} else {
  const src = fs.readFileSync(IDX, 'utf8')
  const code = stripComments(src) // ★ 负向/文本断言一律看**剥掉注释**的代码
  truthy('B2 freeze 走 drainForHandover（不再自己 emit + 睡 400ms）', /freeze:[\s\S]{0,4000}?drainForHandover\(/.test(code))
  truthy('B2 freeze 回报 quiesced（判据上车，不只写在注释里）', /quiesced: outcome\.quiesced/.test(code))
  truthy('B2 旧的假判据 evaluateStatic 已不在 freeze 路径上', !/evaluateStatic/.test(code))
  truthy('B2 死掉的 turn/start 跨插件监听已移除（实测 204 次 defer、0 次生效）', !/['"]turn\/(start|end)['"]/.test(code))
  truthy('B2 prepareSwitch 用真实 phase 判"有没有活在跑"', /agentPhase\(a\) === 'running'/.test(code))
  // ★ 2026-09-20：进度读数换成**真能答**的那个（旧的依赖上游不存在的 listSessions ⇒ 恒 0）
  truthy('B2 进度读数走 liveMaxSeq（本进程 live 会话），不再走那个恒 0 的暖机读数', /liveMaxSeq\(sessionsRef\.current\)/.test(code) && !/computeCaughtUpSeq/.test(code))
  // ★★ 2026-09-20 真机验收抓到：`ctx.sessions` 未 inject ⇒ undefined ⇒ sessions=0 / flush 从没跑过 / lastSeq 恒 -1
  truthy('B5 sessions 服务经 ctx.inject([\'sessions\']) 取得（不得裸读 ctx.sessions）', /inject\?\.\(\['sessions'\]/.test(code))
  truthy('B5 会话不可观察时必须传 sessionsObservable 给 drain（否则空闲场景会报假绿）', /sessionsObservable[,\s]/.test(code) && /sessionsObservable,/.test(code))
  truthy('B5 flush 走 sessionsRef（拿不到就 throw，不静默跳过）', /sessions service unavailable/.test(code))
}

const PRESEED = path.join(REPO, 'packages/switchboard/src/preseed.ts')
if (fs.existsSync(PRESEED)) {
  const p = stripComments(fs.readFileSync(PRESEED, 'utf8'))
  truthy('B3 preseed 不再依赖**上游不存在**的 sessionPersistence.listSessions', !/listSessions/.test(p))
  truthy('B3 preseed 改读 ctx.sessions.list()（本进程真实持有的会话）', /sessions\?\.list/.test(p) || /sessions\.list/.test(p))
}

if (fs.existsSync(COORD)) {
  const c = stripComments(fs.readFileSync(COORD, 'utf8'))
  truthy('B4 ready 阶段已改成结构性就绪（waitReady），不再拿 seq 读数当门槛', /waitReady\(b\)/.test(c) && !/waitCatchUp\(b, targetSeq\)/.test(c))
  truthy('B4 waitCatchUp 只作为"有界观测"保留', /waitCatchUp\(b, fr\.lastSeq, \d+\)/.test(c))
}

// ── C. 上游形状断言：drain 依赖的那几个 API 必须还在 ────────────────────────
// 这一段是"把假设变成可执行的检查"。drain 依赖 `agent.phase` / `cancel` / `whenIdle` 与
// `session.seq`(=log.length) / `sessions.flush()` —— 全是从上游源码里读出来的**形状依赖**。
// 一旦哪天合并上游改动把它们改掉，drain 会**静默退化**成 "quiesced=false"（每次都强杀旧代、
// 丢掉回滚网），而不是报错。所以这里用最小代价把它钉住。
console.log('')
console.log('== C. 上游形状：drain 依赖的 API 是否还在（退化会很安静，所以必须钉住）==')
const upstream = [
  ['node_modules/@deepseek-ai/dsh-agent/lib/index.js', /list\(\)\s*\{\s*return \[\.\.\.this\.store\.values\(\)\]\.map\(\(entry\) => entry\.agent\);/, 'agents.list() 仍返回**活的 agent 本体**'],
  ['node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /get status\(\)\s*\{\s*return this\.phase\.kind === "idle" \|\| this\.phase\.kind === "maintenance" \? "idle" : "running";/, 'agent.status 仍把 maintenance 算作 idle（所以我们必须读 phase）'],
  ['node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /this\.phase = \{\s*kind: "idle",\s*lastTurn\s*\};/, 'agent.phase.kind 仍存在（drain 的真实阶段判据）'],
  ['node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /cancel\(cause, options = \{\}\) \{/, 'agent.cancel(cause, options) 仍在（停回合的唯一手段）'],
  ['node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js', /async whenIdle\(\) \{/, 'agent.whenIdle() 仍在（等它真的停）'],
  // ★ 语义判据，**不锁字面量**：0.1.5 把返回值包成了名牌类型（`return SessionLogOffset(this.log.length)`）
  //   —— 语义没变，但旧的字面量正则会当场变**假红**（2026-09-20 上游漂移体检实测）。
  //   判据要盯"seq 仍由 log.length 派生"，不盯写法。
  ['node_modules/@deepseek-ai/dsh-session/lib/index.js', /get seq\(\)\s*\{\s*return [^;{]*log\.length[^;]*;\s*\}/, 'session.seq 仍由 log.length 派生（"seq 是下一个序号"这个推理的全部依据）'],
  ['node_modules/@deepseek-ai/dsh-session/lib/index.js', /async flush\(session\) \{/, 'sessions.flush(session) 仍是可 await 的落盘入口'],
]
for (const [rel, re, what] of upstream) {
  const p = path.join(REPO, rel)
  if (!fs.existsSync(p)) { bad('上游文件可读 ' + rel, '不存在'); continue }
  truthy(what, re.test(fs.readFileSync(p, 'utf8')), `在 ${rel} 里没找到该形状 —— 上游改了？请复核 packages/switchboard/src/drain.ts 的用法，别让它静默退化`)
}

console.log('')
console.log('=========================================')
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) for (const f of failures) console.log('  · ' + f)
process.exit(fail ? 1 : 0)
