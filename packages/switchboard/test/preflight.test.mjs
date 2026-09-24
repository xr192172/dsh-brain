/**
 * 格⑮ · 预演体检的**纯函数单测**（无需起进程，直接 node 跑）。
 *
 *   node packages/switchboard/test/preflight.test.mjs
 *
 * 覆盖的是本子系统里**最容易退化成假绿**的两处：
 *   ① `collectInventory`：服务缺装配时必须产出**可分辨的** `unavailable`，
 *      而不是悄悄返回空数组（"观测不到"若与"没有"同形，判据就没有意义）；
 *   ② loader 条目 id 归一化 + Fiber phase 映射（真机上 id 是 `include:xxx`，配置里写的是 `xxx`）。
 * 这两条一旦坏了，判据 2/6 会**恒红**或**恒绿**。
 */
import assert from 'node:assert/strict'
import { collectInventory } from '../lib/inventory.js'
import { allocGenPort, RESERVED_GEN_PORTS } from '../lib/coordinator.js'
import { BUILD_STAMP } from '../lib/build-stamp.js'

let n = 0
function t(name, fn) {
  n += 1
  try {
    fn()
    console.log(`  [OK ] ${name}`)
  } catch (e) {
    console.error(`  [RED] ${name}\n        ${e && e.message}`)
    process.exitCode = 1
  }
}

console.log('preflight.test.mjs')

// ── ① 三个服务都缺 ⇒ 必须三项都标 unavailable，且数组为空（可分辨的"观测不到"） ──
t('全部服务缺失 ⇒ 三项 unavailable，绝不冒充"没有"', () => {
  const inv = collectInventory({ gen: 'g', mode: 'staging' })
  assert.equal(inv.tools.length, 0)
  assert.equal(inv.commands.length, 0)
  assert.equal(inv.unavailable?.tools, 'service-unavailable')
  assert.equal(inv.unavailable?.commands, 'service-unavailable')
  assert.equal(inv.unavailable?.plugins, 'service-unavailable')
})

// ── ② 只有 commands 缺 ⇒ 只有 commands 标 unavailable（互不牵连） ──
t('只缺一个服务 ⇒ 只标一项，另两项照常读数', () => {
  const inv = collectInventory({
    gen: 'g',
    mode: 'active',
    loader: { entries: () => [{ id: 'include:switchboard', options: { name: '@dsh-brain/switchboard' }, disabled: false, fiber: { state: 2 } }] },
    tools: { schemas: () => [{ name: 'tool_apply' }, { name: 'zzz' }] },
  })
  assert.deepEqual(inv.unavailable, { commands: 'service-unavailable' })
  assert.deepEqual(inv.tools, ['tool_apply', 'zzz']) // 已排序
  assert.equal(inv.plugins.length, 1)
})

// ── ③ id 归一化（剥 include: 前缀） + phase 映射 + rawId 保留 ──
t('id 归一化/Fiber phase 映射/rawId 取证', () => {
  const inv = collectInventory({
    gen: 'g',
    mode: 'active',
    loader: {
      entries: () => [
        { id: 'include', options: { name: 'cordis:include' }, disabled: false, fiber: { state: 2 } },
        { id: 'include:hmr', options: { name: '@deepseek-ai/cordis-plugin-hmr' }, disabled: true, fiber: { state: 0 } },
        { id: 'include:a:b', options: { name: 'x' }, disabled: false, fiber: { state: 3 } },
        { id: 'include:gone', options: { name: 'y' }, disabled: false, fiber: { state: 4 } },
        { id: 'include:grouped', options: { name: 'z', group: true }, disabled: false, fiber: { state: 2 } },
      ],
    },
  })
  const by = Object.fromEntries(inv.plugins.map((p) => [p.id, p]))
  assert.equal(by['switchboard'], undefined) // 没给
  assert.equal(by['hmr'].enabled, false)
  assert.equal(by['hmr'].phase, 'pending')
  assert.equal(by['hmr'].rawId, 'include:hmr')
  assert.equal(by['a:b'].phase, 'failed') // 只剥一层：更深的分组保留（不让人为同形）
  assert.equal(by['gone'].phase, null) // DISPOSED ⇒ 无生命
  assert.equal(by['grouped'], undefined) // group 行不是插件
  assert.equal(by['include'].id, 'include') // 根条目保留原名
})

// ── ④ 服务查询抛错 ⇒ 标 unavailable 而不是静默空（抛出也必须可分辨） ──
t('服务查询抛错 ⇒ entries-threw / schemas-threw 可见', () => {
  const inv = collectInventory({
    gen: 'g',
    mode: 'active',
    loader: {
      entries: () => {
        throw new Error('boom-loader')
      },
    },
    tools: {
      schemas: () => {
        throw new Error('boom-tools')
      },
    },
    commands: { list: () => [{ name: 'goal' }] },
  })
  assert.match(inv.unavailable.plugins, /entries-threw: boom-loader/)
  assert.match(inv.unavailable.tools, /schemas-threw: boom-tools/)
  assert.equal(inv.unavailable.commands, undefined)
  assert.deepEqual(inv.commands, ['goal'])
})

// ── ⑤ 端口分配仍跳过保留端口且严格单调（预演代与代际共用同一分配器） ──
t('allocGenPort 跳过保留端口（预演代复用同一分配器）', () => {
  for (let slot = 1; slot <= 60; slot++) {
    const p = allocGenPort(3100, slot)
    assert.ok(!RESERVED_GEN_PORTS.includes(p), `slot ${slot} 撞保留端口 ${p}`)
  }
  const seq = []
  for (let slot = 1; slot <= 10; slot++) seq.push(allocGenPort(3100, slot))
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b))
  assert.equal(new Set(seq).size, seq.length)
})

// ── ⑥ build stamp 存在且非空（预演报告的对账字段不能是空串） ──
t('BUILD_STAMP 非空', () => {
  assert.equal(typeof BUILD_STAMP, 'string')
  assert.ok(BUILD_STAMP.length > 0)
})

console.log(process.exitCode ? '\n有 RED' : `\n${n}/${n} OK`)
