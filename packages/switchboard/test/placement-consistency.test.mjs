#!/usr/bin/env node
/**
 * R1.5 门：控制面的「摆放」（home / coordDir / workDir / genAssembly）必须**同源**。
 *
 * 背景（为什么这不是洁癖）：四个值原来**各自**以 home 为默认，且 `envStr('WORK_DIR')` 被求值 3 次
 * ⇒ "今天一致"靠的是**没人设过 WORK_DIR**。一旦有人设指向别处的 WORK_DIR：
 *   会话在 <home>/sessions/、租约/台账/boot.log 在 WORK_DIR ⇒ **数据与日志分家**，
 *   而两边各自都"正常" ⇒ **沉默**（最坏形态）。
 *
 * 本门检（每条都能消融自证变红，铁律 21）：
 *   ① 单一求值：main.ts 源码里 `envStr('WORK_DIR'` 只出现 **1 次**
 *   ② config 里 coordDir/workDir/genAssembly 都取自 placement，**不再各自 envStr**
 *   ③ 分裂组合 ⇒ `resolvePlacement` 抛错/退出（真跑一份沙箱进程验，不是读注释）
 *   ④ 逃生阀 `ALLOW_SPLIT_WORK_DIR=1` ⇒ 放行但仍警告
 *   ⑤ ★ 正向对照（与自变量正交）：没设 WORK_DIR 时 ⇒ 四值都落在 `{home}/switchboard`
 *   ⑥ ★ 部署判据：在跑的 `lib/main.js` 里也有 resolvePlacement（防"改了没部署"）
 *
 * 用法：node packages/switchboard/test/placement-consistency.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SRC = join(PKG, 'src', 'main.ts')
const LIB = join(PKG, 'lib', 'main.js')

let ok = 0
let fail = 0
const pass = (m) => { console.log('  [OK ] ' + m); ok++ }
const bad = (m) => { console.log('  [RED] ' + m); fail++ }

console.log('placement-consistency.test.mjs')

// ── ① 单一求值点 ───────────────────────────────────────────────────────
const src = readFileSync(SRC, 'utf8')
// 只数**调用**：`envStr('WORK_DIR'` 必须出现在一行**代码**里，且**不在** `resolvePlacement` 的定义体内
// （定义体里那一处**就是**唯一该有的求值点）。注释里提到该符号**不算**（否则门会把禁令自己判红
// —— 这正是 R1 门踩过的坑，见 spawn-dshhome.test.mjs ⑤）。
const lines = src.split(/\r?\n/)
const callLines = []
let inBlockComment = false
for (const l of lines) {
  let code = l
  // 去块注释（/* … */），保留行内代码
  if (inBlockComment) {
    const close = code.indexOf('*/')
    if (close < 0) continue
    code = code.slice(close + 2)
    inBlockComment = false
  }
  const open = code.indexOf('/*')
  if (open >= 0) {
    const close = code.indexOf('*/', open)
    if (close < 0) { code = code.slice(0, open); inBlockComment = true }
    else code = code.slice(0, open) + code.slice(close + 2)
  }
  // 去行注释
  const slash = code.indexOf('//')
  if (slash >= 0) code = code.slice(0, slash)
  if (code.includes("envStr('WORK_DIR'")) callLines.push(code.trim())
}
if (callLines.length === 1) pass("① 单一求值：`envStr('WORK_DIR'` 在**代码**里只出现 1 次")
else bad(`① 单一求值：期望 1 次，实测 ${callLines.length} 次 ⇒ 又变成多处各自求值（${callLines.join(' | ')}）`)

// ── ② config 里三个值取自 placement ────────────────────────────────────
const cfgBlock = src.slice(src.indexOf('const config: CoordinatorConfig'), src.indexOf('const config: CoordinatorConfig') + 3000)
const fromPlacement =
  cfgBlock.includes('coordDir: placement.coordDir') &&
  cfgBlock.includes('workDir: placement.workDir') &&
  cfgBlock.includes('genAssembly: placement.genAssembly') &&
  cfgBlock.includes('dshHome: placement.home')
if (fromPlacement) pass('② config 的 coordDir/workDir/genAssembly/dshHome 全取自 placement')
else bad('② config 里还有值绕开了 placement（各自 envStr 推默认）')

// ── ③④⑤ 真跑 resolvePlacement（沙箱进程，不是读注释）──────────────────
if (!existsSync(LIB)) {
  bad('③-⑤ 在跑的 lib/main.js 不存在 ⇒ 无法真跑（先 build）')
} else {
  const probe = async (env) => {
    const script = `
      const home = ${JSON.stringify('D:/__placement_test_home__')}
      const m = await import(${JSON.stringify('file:///' + LIB.replace(/\\/g, '/'))})
      const r = m.resolvePlacement(home)
      console.log('RESULT ' + JSON.stringify(r))
    `
    try {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 30000,
      })
      const line = out.split('\n').find((l) => l.startsWith('RESULT '))
      return { code: 0, data: line ? JSON.parse(line.slice(7)) : null, stderr: '' }
    } catch (e) {
      return { code: e.status ?? 1, data: null, stderr: String(e.stderr ?? '') + String(e.stdout ?? '') }
    }
  }

  // ③ 分裂组合必须被拦
  const split = await probe({ DSH_HOME: 'D:/__placement_test_home__', WORK_DIR: 'D:/somewhere/else' })
  if (split.code !== 0 && /摆放不一致|拒绝启动/.test(split.stderr)) {
    pass('③ 分裂组合（WORK_DIR 不在 home 之下）⇒ 拒启动 ✓（真跑出来的，不是读注释）')
  } else {
    bad(`③ 分裂组合没被拦（exit=${split.code}）⇒ 数据/日志分家的路是通的`)
  }

  // ④ 逃生阀放行 + 警告
  const valve = await probe({
    DSH_HOME: 'D:/__placement_test_home__',
    WORK_DIR: 'D:/somewhere/else',
    ALLOW_SPLIT_WORK_DIR: '1',
  })
  if (valve.code === 0 && valve.data && /somewhere[\\/]else/.test(valve.data.workDir)) {
    pass('④ 逃生阀 ALLOW_SPLIT_WORK_DIR=1 ⇒ 放行（且 workDir 确实是用户指定的）')
  } else {
    bad(`④ 逃生阀不工作（exit=${valve.code}）⇒ 专家被自己的门拦死`)
  }

  // ⑤ ★ 正向对照（与自变量正交）：不设 WORK_DIR ⇒ 四值同落在 {home}/switchboard
  const normal = await probe({ DSH_HOME: 'D:/__placement_test_home__', WORK_DIR: '' })
  const exp = 'd:/__placement_test_home__/switchboard'
  const n = normal.data
  if (
    normal.code === 0 &&
    n &&
    n.workDir.replace(/\\/g, '/').toLowerCase() === exp &&
    n.coordDir.replace(/\\/g, '/').toLowerCase() === exp &&
    n.genAssembly.replace(/\\/g, '/').toLowerCase() === exp + '/gen-assembly.json'
  ) {
    pass('⑤ 对照：不设 WORK_DIR ⇒ coordDir/workDir/genAssembly 同落在 {home}/switchboard ✓')
  } else {
    bad(`⑤ 对照失败：默认摆放不是 {home}/switchboard（${JSON.stringify(n)}）`)
  }
}

// ── ⑥ 部署判据 ─────────────────────────────────────────────────────────
if (existsSync(LIB)) {
  const lib = readFileSync(LIB, 'utf8')
  if (lib.includes('resolvePlacement') && lib.includes('ALLOW_SPLIT_WORK_DIR')) {
    pass('⑥ 部署：在跑的 lib/main.js 里也有 resolvePlacement + 逃生阀')
  } else {
    bad('⑥ 在跑的 bundle 里没有 resolvePlacement ⇒ 改了但没部署')
  }
}

console.log(`\n  ${ok} ok / ${fail} FAIL`)
if (fail > 0) process.exit(1)
console.log('  PASS')
