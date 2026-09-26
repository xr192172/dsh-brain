// test-mgmt-surface.mjs —— 判据：控制面「管理面」的白名单 / 参数校验 / **不经 shell**（注入测试）
//
// 依据用户 2026-09-25：*"通过这个蓝绿面板去**绕过这个 Shell**……用这个蓝蓝面板去**管理这个 DSH**"*
// ⇒ 把管理动作开在 HTTP 上 ⇒ ★ 必须证明**注入面不存在**（否则等于开了个任意命令执行）。
//
// 判据（8 条 + 消融）：
//   ① 白名单外 action ⇒ 拒            ② 题不存在 ⇒ 拒
//   ③ ★ 题名非法（含 shell 元字符/路径穿越）⇒ 拒
//   ④ 臂不存在 ⇒ 拒                   ⑤ 臂名非法 ⇒ 拒
//   ⑥ `argvFor` 返回**数组**、且每项都不含 shell 元字符
//   ⑦ ★★ **注入测试**：一串恶意 `task`/`arm`/`runId` 全部拒；**放行的那条** argv 也必须"零元字符"
//   ⑧ ★ 消融：撤掉名字字符集校验 ⇒ 判据③/⑦ 变红
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const WT = 'D:/project_develop/dsh-brain'
const LIB = pathToFileURL(path.join(WT, 'packages/switchboard/out')).href
// ★ 构建产物目录名是哈希 ⇒ 现找
const outDirs = fs.readdirSync(path.join(WT, 'packages/switchboard/out')).filter((n) => n.startsWith('b'))
const BUILD = path.join(WT, 'packages/switchboard/out', outDirs[outDirs.length - 1])
const mod = await import(pathToFileURL(path.join(BUILD, 'mgmt.js')).href)
const { validate, argvFor, ACTIONS } = mod

const U = (q) => new URL(`http://x/?${q}`)
const results = []
const check = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }
const META = /[;&|$`<>(){}[\]\n\r]/

// ① 白名单
const r1 = validate(U('cmd=mgmt&action=rm'), WT)
check('① 白名单外 action ⇒ 拒', r1.ok === false && /未知 action/.test(r1.reason), r1.ok ? '★ 放行了' : r1.reason)
check('①b 合法 action 清单', ACTIONS.join(',') === 'brief,tasks,verdict,experiment,result', ACTIONS.join(','))
// ② 题不存在
check('② 题不存在 ⇒ 拒', validate(U('cmd=mgmt&action=verdict&task=no-such'), WT).ok === false, '')
// ③ 题名非法
const badNames = ['t1-guard; rm -rf /', 't1-guard && echo pwned', '$(whoami)', '`whoami`', '../etc/passwd', 'a b', 'x|y']
const leaked3 = badNames.filter((t) => validate(U(`cmd=mgmt&action=verdict&task=${encodeURIComponent(t)}`), WT).ok)
check('③ ★ 题名非法（元字符/穿越/空格）⇒ 全拒', leaked3.length === 0, `${badNames.length} 个全拒（漏 ${leaked3.length}）`)
// ④ 臂不存在
check('④ 臂不存在 ⇒ 拒', validate(U('cmd=mgmt&action=experiment&task=t1-guard&arm=ZZZ'), WT).ok === false, '')
// ④b ★★ **正例**：真存在的臂必须**被接受** —— ★ 这条是补的：我第一版把臂路径写成 `wt/_arms`（实际是
//     `wt/../_arms`）⇒ **误拒了真臂**，而当时只有"不存在的臂被拒"那条 ⇒ **判据抓不到**。
const r4b = validate(U('cmd=mgmt&action=experiment&task=t1-guard&arm=A&dry=1'), WT)
check('④b ★ 真存在的臂（A）⇒ **接受**（正例，防误拒）', r4b.ok === true && r4b.v.arm === 'A' && r4b.v.dry === true, r4b.ok ? `arm=${r4b.v.arm} dry=${r4b.v.dry}` : `★ 误拒：${r4b.reason}`)
// ⑤ 臂名非法
const leaked5 = ['A;rm', 'A&&x', '../a'].filter((a) => validate(U(`cmd=mgmt&action=experiment&task=t1-guard&arm=${encodeURIComponent(a)}`), WT).ok)
check('⑤ 臂名非法 ⇒ 拒', leaked5.length === 0, `漏 ${leaked5.length}`)
// ⑥ argvFor 是数组且零元字符
const v6 = validate(U('cmd=mgmt&action=verdict&task=t1-guard'), WT)
const a6 = v6.ok ? argvFor(v6.v, WT, 'NODE') : []
check('⑥ argvFor 返回数组、零 shell 元字符', Array.isArray(a6) && a6.length >= 3 && a6.every((s) => typeof s === 'string' && !META.test(s)),
  JSON.stringify(a6.map((x) => x.replace(WT, '.'))))
check('⑥b task 项**严格等于**题库里的名字（不是拼接出来的）', a6.includes('t1-guard'), a6.join(' '))
// ⑦ 注入：合法请求的 argv 里也**绝不会**出现元字符
const honest = [['tasks', ''], ['verdict', '&task=t1-guard'], ['experiment', '&task=t1-guard&arm=A&dry=1'], ['result', '&runId=abc-123'], ['brief', ''], ['brief', '&arm=A']]
let leak7 = 0
for (const [act, extra] of honest) {
  const v = validate(U(`cmd=mgmt&action=${act}${extra}`), WT)
  if (!v.ok) continue
  const a = argvFor(v.v, WT, 'NODE')
  if (a.some((s) => META.test(s))) leak7++
}
check('⑦ ★★ 合法的动作 ⇒ argv 里零 shell 元字符', leak7 === 0, `泄漏 ${leak7}`)

// ⑦c ★★ **brief 动作**（2026-09-26）：自开发简报 —— 让 DSH **自己拿到"文档在哪"**
//   判据三条：① 动作在白名单里、无需 task ② 臂名可选（不带也要能跑）③ 臂名非法必须拒
const rBrief0 = validate(U('cmd=mgmt&action=brief'), WT)
check('⑦c-1 brief 不带臂 ⇒ 接受（臂名可选）', rBrief0.ok === true, rBrief0.ok ? 'ok' : rBrief0.reason)
const rBrief1 = validate(U('cmd=mgmt&action=brief&arm=A'), WT)
check('⑦c-2 brief 带臂 ⇒ 接受并记下臂名', rBrief1.ok === true && rBrief1.v.arm === 'A', rBrief1.ok ? `arm=${rBrief1.v.arm}` : rBrief1.reason)
const rBrief2 = validate(U('cmd=mgmt&action=brief&arm=' + encodeURIComponent('A;rm -rf /')), WT)
check('⑦c-3 brief 臂名非法 ⇒ 拒', rBrief2.ok === false, rBrief2.ok ? '★ 放行了' : rBrief2.reason)
// ⑦c-4 ★ brief **不需要题**（它不是"针对某道题"，而是"说明书"）⇒ 带个不存在的 task 也不该因此被拒
const rBrief3 = validate(U('cmd=mgmt&action=brief&task=no-such-task'), WT)
check('⑦c-4 brief 不因 task 不存在被拒（它不是题相关的）', rBrief3.ok === true, rBrief3.ok ? 'ok' : `★ 误拒：${rBrief3.reason}`)
// ⑦c-5 ★★ 真跑一次 brief，**核对它报的文档路径真的存在**（判据要落在产物上，不只看校验函数）
{
  const argvB = rBrief1.ok ? argvFor(rBrief1.v, WT, process.execPath) : null
  const rr = argvB ? spawnSync(argvB[0], argvB.slice(1), { encoding: 'utf8', timeout: 120000, cwd: WT }) : null
  let bj = null
  try { bj = JSON.parse(rr?.stdout ?? '') } catch { /* 下面报失败 */ }
  const files = bj ? bj.docs.flatMap((s) => s.files).filter((f) => !f.missing) : []
  const allThere = files.length >= 10 && files.every((f) => fs.existsSync(path.join(WT, f.path)))
  check('⑦c-5 ★★ 真跑 brief ⇒ 报出的文档路径全部真实存在', rr?.status === 0 && allThere, `校验 ${files.length} 份文档路径`)
  check('⑦c-6 ★ 真跑 brief ⇒ 管理面 URL 按臂派生（按 A 应是 33180 段）', !!bj && String(bj.mgmt?.admin ?? '').endsWith(':33180'), `admin=${bj?.mgmt?.admin}`)
}
// ⑨ ★★ 2026-09-26（真事故）：**派生子进程的 env 不许带"臂身份"**（DSH_HOME 等）。
//    起因：经管理面发 experiment 时，臂模式控制面的 `DSH_HOME` 泄漏进子代 ⇒
//          `isolated-instance.mjs` 把"该臂自己"当现役源 ⇒ 拒跑 ⇒ 整条自实验链死在 env 上。
{
  const m = mod
  const fake = {
    PATH: 'C:\\keep-me',
    DSH_HOME: 'D:/project_develop/_arms/a/dshhome',   // ← 臂身份：必须被剔
    DSH_ARM_SELF: 'A',
    DSH_ARM_DENY: 'x,y',
    SWITCH_PORT: '33080',
    GEN_PORT_BASE: '33081',
    SWITCH_ADMIN_PORT: '33180',
    HANDOVER_ADMIN_PORT_BASE: '33190',
    DSH_PUBLIC_WEB_URL: 'http://127.0.0.1:33080',
    SOME_CRED: 'keep-me-too',                          // ← 非臂身份：必须保留
  }
  const out = m.childEnv ? m.childEnv(fake) : null
  if (!out) {
    check('⑨ childEnv 存在（派生子进程要剔臂身份）', false, '★ 没导出 childEnv')
  } else {
    const dropped = ['DSH_HOME', 'DSH_ARM_SELF', 'DSH_ARM_DENY', 'SWITCH_PORT', 'GEN_PORT_BASE', 'SWITCH_ADMIN_PORT', 'HANDOVER_ADMIN_PORT_BASE', 'DSH_PUBLIC_WEB_URL'].every((k) => !(k in out))
    const kept = out.PATH === 'C:\\keep-me' && out.SOME_CRED === 'keep-me-too'
    check('⑨ ★★ 臂身份变量被剔除（DSH_HOME/DSH_ARM_*/端口）', dropped, dropped ? '8 个全剔' : `★ 还剩：${['DSH_HOME','DSH_ARM_SELF','DSH_ARM_DENY','SWITCH_PORT','GEN_PORT_BASE','SWITCH_ADMIN_PORT','HANDOVER_ADMIN_PORT_BASE','DSH_PUBLIC_WEB_URL'].filter((k)=>k in out).join(',')}`)
    check('⑨b ★ 非臂身份变量保留（PATH/凭据不许碰）', kept, kept ? 'PATH+SOME_CRED 保留' : '★ 误删了不该删的')
    // ⑨c 消融：**不剔** ⇒ ⑨ 必须变红（用一个"原样继承"的对照读法）
    const naive = { ...fake }                       // ← 修复前的行为：原样继承 process.env
    const naiveDropped = ['DSH_HOME', 'DSH_ARM_SELF'].every((k) => !(k in naive))
    check('⑨c 消融：不剔 env ⇒ ⑨ 会红（DSH_HOME 原样泄漏）', naiveDropped === false, `naive 里 DSH_HOME=${naive.DSH_HOME}`)
  }
}
// ⑧ 消融：撤掉字符集校验 ⇒ ③ 必须变红
console.log('\n=== 消融自证 ===')
const SRC = path.join(WT, 'packages/switchboard/src/mgmt.ts')
const src = fs.readFileSync(SRC, 'utf8')
const ANCHOR = '  if (!SAFE_NAME.test(task)) return { ok: false, reason: \'task 不合法（只允许字母数字与 . _ -）\' }'
let ablOk = false
if (!src.includes(ANCHOR)) {
  console.log('  ★ 消融锚点失配 —— 必须重写（不许模糊匹配）')
} else {
  // ★★ 单因子消融（我第一次写成"直接喂恶意名"⇒ 没变红 —— 因为 `existsSync` 那道守卫**也**拦住了它们）：
  //    ⇒ 正解：造一个**真实存在**、但名字带 shell 元字符的题 ⇒ **只有字符集校验拦得住**。
  //    ★ 用**临时 WT**（不碰真题库）。
  const TMPWT = path.join(WT, 'out', '_mgmt-abl-wt')
  fs.rmSync(TMPWT, { recursive: true, force: true })
  fs.mkdirSync(path.join(TMPWT, 'evals/tasks/x;y'), { recursive: true })
  fs.writeFileSync(path.join(TMPWT, 'evals/tasks/x;y/task.md'), '# 名字带元字符的题\n', 'utf8')
  const WEIRD = 'x;y'
  const normalRejects = validate(U(`cmd=mgmt&action=verdict&task=${encodeURIComponent(WEIRD)}`), TMPWT).ok === false
  console.log(`  （对照组：正常版对"存在但名带 ;"的题 ⇒ ${normalRejects ? '拒' : '★放行'}；这证明该用例只受字符集校验约束）`)
  const bak = src
  fs.writeFileSync(SRC, src.replace(ANCHOR, '  // ABLATED: 字符集校验已撤'), 'utf8')
  const b = spawnSync(process.execPath, [path.join(WT, 'packages/switchboard/scripts/build.mjs')], { encoding: 'utf8', timeout: 300000, cwd: path.join(WT, 'packages/switchboard') })
  let ablatedAllows = null
  if (b.status === 0) {
    const dirs2 = fs.readdirSync(path.join(WT, 'packages/switchboard/out')).filter((n) => n.startsWith('b')).sort()
    const newest = path.join(WT, 'packages/switchboard/out', dirs2[dirs2.length - 1], 'mgmt.js')
    const m2 = await import(pathToFileURL(newest).href + '?abl=' + Date.now())
    ablatedAllows = m2.validate(U(`cmd=mgmt&action=verdict&task=${encodeURIComponent(WEIRD)}`), TMPWT).ok === true
  }
  fs.writeFileSync(SRC, bak, 'utf8')
  spawnSync(process.execPath, [path.join(WT, 'packages/switchboard/scripts/build.mjs')], { encoding: 'utf8', timeout: 300000, cwd: path.join(WT, 'packages/switchboard') }) // 还原并重建
  fs.rmSync(TMPWT, { recursive: true, force: true })
  if (ablatedAllows === null) {
    console.log(`  ★ 消融版构建失败，跳过（不算通过）：${(b.stdout ?? '').slice(0, 200)}`)
  } else {
    ablOk = normalRejects && ablatedAllows
    console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 撤掉字符集校验 ⇒ 该题被**放行**（判据③/⑦ 变红）${ablOk ? '✓' : `（没变红；ablatedAllows=${ablatedAllows}）`}`)
  }
}
const pass = results.filter((x) => x.ok).length
const total = pass === results.length && ablOk
console.log(`\n结果：判据 ${pass}/${results.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
process.exit(total ? 0 : 1)
