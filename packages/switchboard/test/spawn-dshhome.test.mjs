/**
 * R1 判据：`DSH_HOME` 必须是 spawn 的**显式入参**（而不是从 `process.env` 继承）。
 *
 *   node packages/switchboard/test/spawn-dshhome.test.mjs
 *
 * ## 为什么这条判据必须有（而不是"看看代码就行"）
 *
 * 本项目的真事故：`spawner.ts` 不设 `DSH_HOME` ⇒ 子代继承控制面的 home
 * ⇒ **一个协调器只能服务一个训练场** ⇒ `arm-up` 只好自己重建 `dshhome`
 * （`isolated-instance --force`）⇒ **绕开整台协调器**（不切流量、不自证、不 retire、不回滚）
 * ⇒ 一条旁路长出六个症状。见 `docs/handover-bypass-structural-diagnosis-2026-09-26.md`。
 *
 * ★ 关键："代码里写了 `DSH_HOME: opts.dshHome`" **不足以**说明它生效 ——
 *   还要过**部署**这一关（本项目踩过"修了但没部署"：
 *   `src/mgmt.ts` 有 `childEnv()`，而当时每个在跑的 bundle 里 grep = 0 命中）。
 *   所以本判据**同时检查源码与在跑的 bundle**。
 *
 * ## 覆盖的四条
 *   ① 源码 `SpawnOptions` 有 `dshHome`，且 `spawnGen` 内显式赋值（不是靠继承）
 *   ② 赋值写在 `...opts.envExtra` **之后**（契约值赢，不留歧义）
 *   ③ ★ 部署判据：`lib/spawner.js`（= 在跑的那份）里能读到显式赋值
 *   ④ ★ 语义判据：`main.ts` 传的是**控制面自己的 `home`**（不是"每代一个 home"）
 *      —— 这条是防"误解成每代独立 home ⇒ 中继器静默失效"（盘查 §2.3）
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SRC = join(PKG, 'src')

let n = 0
let red = 0
function t(name, fn) {
  n += 1
  try {
    fn()
    console.log(`  [OK ] ${name}`)
  } catch (e) {
    red += 1
    console.error(`  [RED] ${name}\n        ${e && e.message}`)
    process.exitCode = 1
  }
}

const rd = (p) => readFileSync(p, 'utf8')

console.log('spawn-dshhome.test.mjs')

// ── ① 源码：dshHome 是 SpawnOptions 的必填字段 + spawnGen 里显式赋值 ──
t('① SpawnOptions 声明了 dshHome，且 spawnGen 显式赋值（不靠继承）', () => {
  const s = rd(join(SRC, 'spawner.ts'))
  // 必填：接口里必须有 `dshHome: string`（**不是** `dshHome?:`）
  assert.match(s, /\n\s*dshHome:\s*string\b/, 'SpawnOptions 应有必填 dshHome: string')
  assert.doesNotMatch(s, /\n\s*dshHome\?:\s*string\b/, 'dshHome 不该是可选的（可选 = 漏传不报错 = 回到继承）')
  // spawnGen 函数体内必须真的赋值
  const fnBody = s.slice(s.indexOf('export function spawnGen'))
  assert.match(fnBody, /\bDSH_HOME:\s*opts\.dshHome\b/, 'spawnGen 内应有 DSH_HOME: opts.dshHome')
})

// ── ② 赋值位置：在 ...opts.envExtra 之后（契约值必须赢） ──
t('② DSH_HOME 赋值在 `...opts.envExtra` 之后 ⇒ 契约值赢，不留歧义', () => {
  const s = rd(join(SRC, 'spawner.ts'))
  const fnBody = s.slice(s.indexOf('export function spawnGen'))
  const iSpread = fnBody.indexOf('...opts.envExtra')
  const iHome = fnBody.indexOf('DSH_HOME: opts.dshHome')
  assert.ok(iSpread > -1, '应能找到 ...opts.envExtra')
  assert.ok(iHome > -1, '应能找到 DSH_HOME: opts.dshHome')
  assert.ok(iHome > iSpread, `DSH_HOME 必须在 envExtra 之后（否则清单能压掉契约）: spread@${iSpread} home@${iHome}`)
})

// ── ③ 部署判据：在跑的 bundle（lib/）里也要有 ──
t('③ ★ 部署判据：lib/spawner.js（在跑的那份）里有显式赋值', () => {
  const libSpawner = join(PKG, 'lib', 'spawner.js')
  assert.ok(existsSync(libSpawner), `lib/spawner.js 不存在（${libSpawner}）⇒ 还没构建`)
  const real = realpathSync(libSpawner)
  const s = rd(libSpawner)
  assert.match(s, /DSH_HOME:\s*opts\.dshHome\b/, `在跑的 bundle 里没读到显式赋值 ⇒ "改了但没部署"。real=${real}`)
  console.log(`        lib -> ${real}`)
})

// ── ④ 语义判据：main.ts 传的是控制面自己的 home ──
t('④ ★ 语义：main.ts 传 config.dshHome，且 config.dshHome = 控制面的 home', () => {
  const m = rd(join(SRC, 'main.ts'))
  // 必须传下去
  assert.match(m, /\bdshHome:\s*config\.dshHome\b/, 'main.ts 应把 config.dshHome 传给 spawnGen')
  // 必须是"控制面自己的 home"：dshHome: home（home 由 main.ts:378 的 envStr('DSH_HOME', …) 推）
  assert.match(m, /\bdshHome:\s*home\b/, 'config.dshHome 应 = main.ts 里的 home（控制面自己的 home）')
  // 而 home 的来源必须是 envStr('DSH_HOME', …) —— 即"和现役同一个 home"
  assert.match(m, /const home = envStr\('DSH_HOME'/, 'home 应由 envStr(\'DSH_HOME\', …) 推出')
})

// ── ⑤ 防误用：不许把 childEnv 用在 spawnGen 上（盘查 §2.6） ──
t('⑤ spawner.ts 不得【调用】childEnv（"控制面→脚本"专用；混用会让代失去 home）', () => {
  const s = rd(join(SRC, 'spawner.ts'))
  // 在注释里**提到**它名字是可以的（那正是禁令本身）；**调用**它不行 ⇒ 只禁调用形状。
  //   识别：把每行的 // 注释与 /* */ 注释剥掉后再看有没有 `childEnv(`。
  //   ★ 只在**代码**里匹配，注释里的名字不算（否则禁令自己会把判据判红）。
  const stripLineComment = (l) => {
    const i = l.indexOf('//')
    return i === -1 ? l : l.slice(0, i)
  }
  const offenders = s
    .split('\n')
    .map((l, i) => ({ code: stripLineComment(l).replace(/\/\*[\s\S]*?\*\//g, ''), i: i + 1 }))
    .filter(({ code }) => /\bchildEnv\s*\(/.test(code))
  assert.equal(
    offenders.length,
    0,
    `spawner.ts 调用了 childEnv（第 ${offenders.map((o) => o.i).join(',')} 行）—— 见盘查 §2.6 的禁令`,
  )
  // ★ 阳性对照：确认这道判据**真的在量东西** —— 拿一行真的调用喂进去，必须被逮住。
  const ctrl = '  const env = childEnv(process.env)'
  assert.ok(
    /\bchildEnv\s*\(/.test(stripLineComment(ctrl)),
    '阳性对照失败：这道判据逮不住真的 childEnv 调用 ⇒ 它是假绿',
  )
})

console.log(`\n  ${n - red} ok / ${red} FAIL`)
if (red === 0) console.log('  PASS')
