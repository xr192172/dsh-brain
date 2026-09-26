// test-sentinel-pool.mjs —— 哨兵模型判据（2026-09-26）
//
// 用户裁决（逐字，见 docs/launcher-sentinel-impl-2026-09-26.md §0）：
//   · *"就只有一个端口是，就是 3080 是主端……其他的页面的话保留端口信息即可……
//      但是**不要求强制提拔到 3080 前门**。"*          ⇒ 立哨【绝不 flip】
//   · *"立哨和提拔肯定要拆呀，不拆的话那岂不是一给他立好了他就要自动提拔了。"*  ⇒ 两动作必须分开
//   · *"只有当前这一代**选择退役了**之后，才提拔那个当前哨兵选定的下一代哨兵作为新的主代。"*
//                                                    ⇒ 提拔 ⇒ primary 变、sentinel 归空
//
// ★ 本判据带【消融自证】（铁律 21）：每个 check 都能指出"撤掉什么它会变红"。

import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import assert from 'node:assert'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..', 'packages', 'switchboard', 'src')
const rd = (p) => readFileSync(join(SRC, p), 'utf8')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    console.log('  ok  ' + name)
    pass++
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + (e?.message ?? e))
    fail++
  }
}
async function ta(name, fn) {
  try {
    await fn()
    console.log('  ok  ' + name)
    pass++
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + (e?.message ?? e))
    fail++
  }
}

console.log('\n哨兵模型判据（pool.ts 行为 + coordinator/main 接线）\n')

// ─────────────────────────────────────────────────────────────
// 行为层：直接 import 编译产物跑真行为（不是读注释 —— 铁律 11）
// ─────────────────────────────────────────────────────────────
const LIB = join(HERE, '..', '..', 'packages', 'switchboard', 'lib')
const poolMod = await import(pathToFileURL(join(LIB, 'pool.js')).href).catch(() => null)
if (!poolMod) {
  console.error('找不到 packages/switchboard/lib/pool.js —— 先构建：cd packages/switchboard && node scripts/build.mjs')
  process.exit(2)
}
const { PoolStore } = poolMod

// ★ 每个用例**独立目录** —— PoolStore 是持久化的（load 磁盘），
//   共用 dir 会让上一个用例的 sentinel 泄漏到下一个（我自己踩过：②⑤⑥ 三连假红）。
function freshDir() {
  return mkdtempSync(join(tmpdir(), 'sentinel-pool-'))
}
const TMP = []
function inDir(fn) {
  const d = freshDir()
  TMP.push(d)
  try {
    fn(d)
  } finally {
    /* 末尾统一清 */
  }
}

try {
  // ① 立哨：sentinel 为空 ⇒ 成为"被选定的下一代"；primary **不动**
  t('① 立哨：sentinel 空 ⇒ 占 sentinel；★ primary 不变（不自动提拔）', () => inDir((dir) => {
    const p = new PoolStore(dir)
    p.syncPrimary({ gen: 'gen-3082', port: 3082, pid: 111 })
    p.stand({ gen: 'gen-3083', port: 3083, pid: 222 })
    const s = p.current
    assert.strictEqual(s.primary?.gen, 'gen-3082', '★ primary 必须【不变】—— 变了就是"立好即提拔"（用户禁止）')
    assert.strictEqual(s.sentinel?.gen, 'gen-3083', 'sentinel 应是被立的那一代')
    assert.deepStrictEqual(s.others, [], 'others 应为空')
  }))

  // ② 再立哨 ⇒ 进 others（不挤掉 sentinel）
  t('② 再立哨 ⇒ 进 others（都只是"下一代"，不干扰已选定的）', () => inDir((dir) => {
    const p = new PoolStore(dir)
    p.syncPrimary({ gen: 'gen-3082', port: 3082, pid: 111 })
    p.stand({ gen: 'gen-3083', port: 3083, pid: 222 })
    p.stand({ gen: 'gen-3084', port: 3084, pid: 333 })
    const s = p.current
    assert.strictEqual(s.sentinel?.gen, 'gen-3083', 'sentinel 应仍是第一个（不被挤掉）')
    assert.deepStrictEqual(s.others.map((g) => g.gen), ['gen-3084'], '第二个应进 others')
  }))

  // ③ 提拔：sentinel ⇒ primary；sentinel 归空
  t('③ 提拔：sentinel ⇒ primary，sentinel 归空（用户裁决 R-c）', () => inDir((dir) => {
    const p = new PoolStore(dir)
    p.syncPrimary({ gen: 'gen-3082', port: 3082, pid: 111 })
    p.stand({ gen: 'gen-3083', port: 3083, pid: 222 })
    const r = p.promote()
    assert.strictEqual(r.ok, true, '有 sentinel 时应能提拔')
    assert.strictEqual(r.next?.gen, 'gen-3083')
    const s = p.current
    assert.strictEqual(s.primary?.gen, 'gen-3083', 'primary 应变成原 sentinel')
    assert.strictEqual(s.sentinel, null, 'sentinel 应归空（等下一次选定）')
  }))

  // ④ ★ 无 sentinel 时提拔必须【拒绝】，不许乱挑一个
  t('④ 无 sentinel 时提拔 ⇒ 拒绝（模型里没有"算哪个最好"，不许乱挑）', () => inDir((dir) => {
    const p = new PoolStore(dir)
    p.syncPrimary({ gen: 'gen-3082', port: 3082, pid: 111 })
    p.stand({ gen: 'gen-3083', port: 3083, pid: 222 })
    p.promote() // 用掉 sentinel
    const r = p.promote() // 再提拔一次：sentinel 已空
    assert.strictEqual(r.ok, false, 'sentinel 为空时必须拒绝')
    assert.ok(/stand/.test(r.reason ?? ''), '拒绝理由应指引去立哨：' + r.reason)
  }))

  // ⑤ 选定：把 others 里的提为 sentinel（原 sentinel 退回 others）
  t('⑤ 选定：others ⇒ sentinel（原 sentinel 退回 others，不丢）', () => inDir((dir) => {
    const p = new PoolStore(dir)
    p.stand({ gen: 'gen-3083', port: 3083, pid: 222 })
    p.stand({ gen: 'gen-3084', port: 3084, pid: 333 })
    const r = p.designate('gen-3084')
    assert.strictEqual(r.ok, true)
    const s = p.current
    assert.strictEqual(s.sentinel?.gen, 'gen-3084')
    assert.deepStrictEqual(s.others.map((g) => g.gen), ['gen-3083'], '原 sentinel 应退回 others，不消失')
  }))

  // ⑥ 陈旧清理：死代从池里摘掉（★ 且**不重复计入**）
  t('⑥ pruneDead：探活为 false 的哨兵被摘掉，且每代只探活一次', () => inDir((dir) => {
    const p = new PoolStore(dir)
    p.stand({ gen: 'gen-3083', port: 3083, pid: 222 })
    p.stand({ gen: 'gen-3084', port: 3084, pid: 333 })
    let calls = 0
    const { dropped } = p.pruneDead((g) => {
      calls++
      return g.gen !== 'gen-3084'
    })
    assert.deepStrictEqual(dropped.map((g) => g.gen), ['gen-3084'], '死代应恰好记一次（不许重复计数）')
    assert.strictEqual(calls, 2, `两代应各探活一次，实际 ${calls} 次`)
    const s = p.current
    assert.strictEqual(s.sentinel?.gen, 'gen-3083', '活着的哨兵应留下')
    assert.deepStrictEqual(s.others, [], '死的应被摘掉')
  }))

  // ⑦ 端口信息保留（用户裁决 4 的物理要求：能"复制端口自己去打开"）
  t('⑦ ★ 池里每一项都带 port（用户："保留端口信息即可"）', () => inDir((dir) => {
    const p = new PoolStore(dir)
    p.stand({ gen: 'gen-3083', port: 3083, pid: 222 })
    p.stand({ gen: 'gen-3084', port: 3084, pid: 333 })
    const s = p.current
    for (const g of [s.sentinel, ...s.others]) {
      assert.ok(g && typeof g.port === 'number' && g.port > 0, '每项必须有可用端口：' + JSON.stringify(g))
    }
  }))
} finally {
  for (const d of TMP) rmSync(d, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────
// 接线层：源码级断言（消融自证见每组后面的 ★ 说明）
// ─────────────────────────────────────────────────────────────
console.log('\n接线层（源码级）\n')

t('⑧ ★★ 立哨【绝不 flip】：stand() 体内不得出现 setActive / swapActive', () => {
  const c = rd('coordinator.ts')
  // 取 stand 方法体（从 `async stand(` 到下一个 `async promoteSentinel(`）
  const m = c.match(/async stand\([\s\S]*?\n  async promoteSentinel\(/)
  assert.ok(m, '应能定位 stand 方法体')
  const body = m[0]
  assert.ok(!/setActive|swapActive/.test(body), '★ stand 里出现 flip ⇒ 违反用户裁决 4（不要求提拔到 3080）')
  assert.ok(!/\.promote\(/.test(body), '★ stand 里出现 promote ⇒ 等于"立好即提拔"（用户明确禁止）')
})

t('⑨ ★★ 提拔【不 spawn】：promoteSentinel() 体内不得出现 spawnStaging / spawnGen', () => {
  const c = rd('coordinator.ts')
  const start = c.indexOf('async promoteSentinel(')
  assert.ok(start > 0, '应能定位 promoteSentinel')
  // 方法体 = 从这里到下一个"顶层方法"（两个空格缩进的 /** 或 花括号收口）
  const rest = c.slice(start)
  const endRel = rest.search(/\n  \/\*\*/)
  const body = endRel > 0 ? rest.slice(0, endRel) : rest
  assert.ok(body.length > 200, '方法体应足够长（定位正确）：' + body.length)
  assert.ok(!/spawnStaging|spawnGen/.test(body), '★ promote 里出现 spawn ⇒ 违反 I-c（提拔只换人不造人）')
})

t('⑩ 两条路共用同一份 spawn 实现（不许各写一遍 —— 铁律 37 的落点）', () => {
  const c = rd('coordinator.ts')
  const standStart = c.indexOf('async stand(')
  const standEnd = c.indexOf('async promoteSentinel(')
  const standBody = c.slice(standStart, standEnd)
  const hoStart = c.indexOf('async handover(')
  const hoEnd = c.indexOf("this.stage = 'freeze'", hoStart)
  const hoBody = c.slice(hoStart, hoEnd)
  assert.match(standBody, /this\.spawnStaging\(/, 'stand 应走 spawnStaging')
  assert.match(hoBody, /this\.spawnStaging\(/, 'handover 应走 spawnStaging（同一份实现）')
  // 反向：handover 里不该再有裸 spawnGen（那说明还有第二份实现）
  assert.ok(!/spawnGen\(/.test(hoBody), 'handover 里不该再直接调 spawnGen（应已抽进 spawnStaging）')
})

t('⑪ main.ts 接线：?cmd=pool / stand / promote 三条都在', () => {
  const m = rd('main.ts')
  assert.match(m, /cmd === 'pool'/, '缺 ?cmd=pool')
  assert.match(m, /coord\.poolView/, 'pool 应读 coord.poolView（只读投影）')
  assert.match(m, /cmd === 'stand'/, '缺 ?cmd=stand')
  assert.match(m, /coord\s*\n?\s*\.stand\(/, 'stand 应调 coord.stand（异步）')
  assert.match(m, /cmd === 'promote'/, '缺 ?cmd=promote')
  assert.match(m, /coord\s*\n?\s*\.promoteSentinel\(/, 'promote 应调 coord.promoteSentinel')
})

t('⑫ ★ pool.json 有单一写者纪律说明（与 lease.ts 同族，铁律 31）', () => {
  const p = rd('pool.ts')
  assert.match(p, /单一写者/, 'pool.ts 头部应写明单一写者纪律')
  assert.match(p, /lease\.json/, '应说明为什么另立文件而不动 lease.json')
})

t('⑬ ★★ 提拔仅由"退役/调用方"触发，模型内【没有】"算哪个最好"', () => {
  const p = rd('pool.ts')
  const start = p.indexOf('promote()')
  assert.ok(start > 0, '应能定位 promote()')
  const body = p.slice(start, p.indexOf('\n  }', start))
  assert.ok(!/score|sort\(|best|最优|评分/.test(body), '★ promote 里出现打分/排序 ⇒ 模型里混进了"算哪个最好"')
})

// ─────────────────────────────────────────────────────────────
// 正交正向对照（铁律 13）：与"立哨/提拔"无关的既有行为必须仍正常
// ─────────────────────────────────────────────────────────────
console.log('\n正交对照（铁律 13）\n')
t('⑭ [对照] PoolStore 的持久化是可重入的（新实例读回同一状态）', () => {
  const d2 = mkdtempSync(join(tmpdir(), 'sentinel-pool2-'))
  try {
    const a = new PoolStore(d2)
    a.syncPrimary({ gen: 'gen-1', port: 1, pid: 1 })
    a.stand({ gen: 'gen-2', port: 2, pid: 2 })
    const b = new PoolStore(d2)
    assert.strictEqual(b.current.sentinel?.gen, 'gen-2', '新实例应读回 sentinel')
    assert.strictEqual(b.current.primary?.gen, 'gen-1', '新实例应读回 primary')
  } finally {
    rmSync(d2, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────
// ★★★ 回归门：跨实例不许共享内部数组
//
// 这是本文件真正的"病根判据" —— ⑤/⑥ 曾假红，根因就是 `load()` 用 `{ ...EMPTY }`
// **浅拷贝** ⇒ 同进程所有空池共用**同一个 `others` 数组** ⇒ 每 `new` 一个实例就多一份幻影条目。
// 上面 ①–⑦ 每个用例都 `new PoolStore(dir)`，所以它们**只有在存在多个实例时才可能为真**。
// ⇒ 本条判据把"为什么红"钉死成一个**可独立复现**的断言，不再依赖"整条跑下来的巧合"。
//
// 消融自证（铁律 21）：把 `freshEmpty` 改回 `{ ...EMPTY }` ⇒ ② 必红（实测：12 ok / 2 FAIL）。
// ─────────────────────────────────────────────────────────────
t('⑮ ★★★ 跨实例隔离：两个 PoolStore 不得共享 others 数组（浅拷贝病根）', () => {
  const da = mkdtempSync(join(tmpdir(), 'sentinel-iso-a-'))
  const db = mkdtempSync(join(tmpdir(), 'sentinel-iso-b-'))
  try {
    const a = new PoolStore(da)
    const b = new PoolStore(db)
    assert.notStrictEqual(a.current.others, b.current.others, '两个不同目录的空池不得共享同一 others 数组')
    // ① 在 a 上立哨不得让 b 看见
    a.stand({ gen: 'gen-A', port: 1, pid: 1 })
    a.stand({ gen: 'gen-B', port: 2, pid: 2 })
    assert.deepStrictEqual(a.current.others.map((g) => g.gen), ['gen-B'], 'a 自己应只有 1 项')
    assert.deepStrictEqual(b.current.others, [], '★ b 必须仍是空（空了 ⇒ 就是共享了）')
    // ② 实例数不得影响结果：再造一个空实例，a 的读数不许变
    const c = new PoolStore(mkdtempSync(join(tmpdir(), 'sentinel-iso-c-')))
    void c
    assert.deepStrictEqual(a.current.others.map((g) => g.gen), ['gen-B'], '★ 新建实例后 a 不得多出幻影条目')
    // ③ current 必须是快照，不是活对象
    const snap = a.current
    a.stand({ gen: 'gen-C', port: 3, pid: 3 })
    assert.deepStrictEqual(snap.others.map((g) => g.gen), ['gen-B'], '★ 早先取到的 current 不应被后续写入改动')
  } finally {
    rmSync(da, { recursive: true, force: true })
    rmSync(db, { recursive: true, force: true })
  }
})

t('⑯ ★★ 源码级：pool.ts 不得用 `{ ...模板 }` 造空状态', () => {
  const p = rd('pool.ts')
  // ★ 只认"字面量形态"，不依赖模板常量叫什么名字
  //   （否则消融实验一改名本条就假绿 —— 我实测踩过：改成 `__T2` 后本条仍 ok，是条哑门）
  const spreadEmpty = /others\s*:\s*\[\s*\]\s*\}\s*\}?\s*$|\{\s*\.\.\.\s*[A-Za-z_$]/
  const offenders = p
    .split('\n')
    .map((l, i) => ({ l, i: i + 1 }))
    .filter((x) => /return\s*\{\s*\.\.\.\s*[A-Za-z_$]/.test(x.l))
  assert.ok(
    offenders.length === 0,
    '★ 出现浅拷贝返回 ⇒ 病根复发：' + offenders.map((o) => `L${o.i}: ${o.l.trim()}`).join(' | '),
  )
  // 空状态必须是"每次新建"，且形如字面量（含独立 others 数组）
  assert.match(p, /freshEmpty\s*=\s*\(\)\s*:\s*PoolState\s*=>\s*\(\s*\{\s*primary\s*:\s*null\s*,\s*sentinel\s*:\s*null\s*,\s*others\s*:\s*\[\s*\]\s*\}\s*\)/, 'freshEmpty 必须是每次新建字面量')
  void spreadEmpty
})

console.log(`\n${pass} ok / ${fail} FAIL\n`)
process.exit(fail === 0 ? 0 : 1)
