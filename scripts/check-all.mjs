#!/usr/bin/env node
/**
 * check-all.mjs —— 全部门禁的统一入口（2026-09-15）
 *
 * ## 为什么需要它
 *
 * 到 2026-09-15 已有 12 道门散在 `scripts/` 与 package.json 里，**却没有统一入口**。
 * 那本身就是"开发起来会混乱"的新来源 —— 而混乱正是我们刚花一天在收的东西。
 *
 * ## 口径（沿用 `gate-authoring` 的纪律）
 *
 * - **逐项报告 + 末尾汇总**：每道门单独一行（✓/✗ + 耗时），失败时把它的尾部输出贴出来。
 * - **任一失败 ⇒ 非 0 退出**。
 * - **有副作用的门要如实标注** —— 例如 `capability-gate run --all` 会**写回执**。
 *   把"检查"和"会改东西的检查"混为一谈，是让人不敢跑总检查的常见原因。
 * - `--only <substr>` 跑子集（调试用）；`--list` 只列不跑。
 *
 * 用法：
 *   node scripts/check-all.mjs
 *   node scripts/check-all.mjs --only capability
 *   node scripts/check-all.mjs --list
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const REPO = 'D:/project_develop/dsh-brain'
const argv = process.argv.slice(2)
const only = (() => {
  const i = argv.indexOf('--only')
  return i < 0 ? null : argv[i + 1]
})()
const listOnly = argv.includes('--list')

/** 门列表。`side` 非空表示**会改动磁盘**，必须如实标注。 */
const GATES = [
  {
    id: 'bom',
    what: '无 UTF-8 BOM（数据文件）+ .ps1 必须带 BOM',
    cmd: ['node', 'scripts/check-bom.mjs'],
  },
  {
    id: 'plugin-hygiene',
    what: '插件卫生：包完整性 / 残留 / deps 与 bundles / lock 一致 / 遗留物',
    cmd: ['node', 'scripts/check-plugin-hygiene.mjs'],
  },
  {
    id: 'profile',
    what: 'profile 装配（--dump-config）：exit 0 / stderr 空 / 582 行 / pet 0 / dup 0',
    cmd: ['node', 'node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--dump-config'],
    expect: { lines: 582, forbid: ['duplicate loader entry id'], forbidCount: { pet: 0 } },
  },
  {
    id: 'registry',
    what: '能力库数据层校验（capability-registry check）',
    cmd: ['node', 'scripts/capability-registry.mjs', 'check'],
  },
  {
    id: 'capability-gate',
    what: '注册门：判据阶梯 L0/L1（**会写回执到 registry.json**）',
    cmd: ['node', 'scripts/capability-gate.mjs', 'run', '--all'],
    side: '写 registry.json 的 acceptance 回执',
  },
  {
    id: 'test:patch-anchors',
    what: '上游补丁锚点严格化（两方向）',
    cmd: ['node', 'scripts/test-patch-anchors.mjs'],
  },
  {
    id: 'test:boot-health',
    what: '启动健康检查三态（含真实 gen-3083 文本）',
    cmd: ['node', 'scripts/test-boot-health.mjs'],
  },
  {
    id: 'test:config-tolerance',
    what: '插件 Config 容忍缺 config（经 cordis 真实 resolveConfig）',
    cmd: ['node', 'scripts/check-config-tolerance.mjs'],
  },
  {
    id: 'test:capability-gate',
    what: '注册门自证（两方向）',
    cmd: ['node', 'scripts/test-capability-gate.mjs'],
  },
  {
    id: 'test:notice-core',
    what: '能力通知折叠内核（幂等 / 快照非增量 / 顺序无关）',
    cmd: ['node', 'scripts/test-capability-notice.mjs'],
  },
  {
    id: 'test:notice-wiring',
    what: '能力通知接线（mock ctx 真调 apply）',
    cmd: ['node', 'scripts/test-capability-notice-wiring.mjs'],
  },
  {
    id: 'test:plugin-hygiene',
    what: '插件卫生门自证（两方向）',
    cmd: ['node', 'scripts/test-plugin-hygiene.mjs'],
  },
  {
    id: 'test:message-shape',
    what: '注入会话的消息必须带身份（id/source）+ 反模式扫描',
    cmd: ['node', 'scripts/test-injected-message-shape.mjs'],
  },
]

// ⚠️ 刻意**不**收录 `scripts/verify-p4-after-swap.mjs`：
//   它在换代之前**本来就该是红的**（判据是"新代码有没有上"），
//   收进来会让 `check:all` 在换代前恒红 ⇒ 门被当成噪音 ⇒ 门被绕过。
//   它由 `npm run verify:p4` 单独跑（换代后跑）。

const selected = only ? GATES.filter((g) => g.id.includes(only)) : GATES
if (!selected.length) {
  console.error(`--only ${only} 没匹配到任何门。可用：${GATES.map((g) => g.id).join(', ')}`)
  process.exit(1)
}

if (listOnly) {
  console.log(`共 ${GATES.length} 道门${only ? `（匹配 ${only}：${selected.length}）` : ''}：`)
  for (const g of selected) {
    console.log(`  ${g.side ? '⚙ ' : '  '}${g.id.padEnd(24)} ${g.what}`)
    if (g.side) console.log(`  ${' '.repeat(24)} └ ⚙ 有副作用：${g.side}`)
  }
  console.log('\n  ⚙ = 会改动磁盘；其余为纯检查。')
  process.exit(0)
}

const t0 = Date.now()
const rows = []
for (const g of selected) {
  const start = Date.now()
  const r = spawnSync(g.cmd[0], g.cmd.slice(1), { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  let ok = (r.status ?? 1) === 0
  const notes = []

  // profile 门额外核几个硬指标（只看 exit code 会漏掉"装上了但内容不对"）
  if (ok && g.expect) {
    if (g.expect.lines !== undefined) {
      const n = (r.stdout ?? '').split('\n').length - 1
      if (n !== g.expect.lines) { ok = false; notes.push(`行数 ${n} ≠ 期望 ${g.expect.lines}`) }
    }
    for (const bad of g.expect.forbid ?? []) {
      if (out.includes(bad)) { ok = false; notes.push(`出现了不该有的：${bad}`) }
    }
    for (const [k, want] of Object.entries(g.expect.forbidCount ?? {})) {
      const n = out.split('\n').filter((l) => l.includes(k)).length
      if (n !== want) { ok = false; notes.push(`${k} 出现 ${n} 次 ≠ ${want}`) }
    }
  }

  // 提取"结果：N passed, M failed"之类的关键行当摘要
  const summary =
    out.split('\n').reverse().find((l) => /结果：|✅|Done|全部锚点就位|无问题/.test(l)) ?? ''
  rows.push({ g, ok, ms: Date.now() - start, out, notes, summary: summary.trim() })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${g.id.padEnd(24)} ${String(Date.now() - start).padStart(5)}ms  ${summary.slice(0, 52)}\n`)
}

const bad = rows.filter((r) => !r.ok)
console.log('')
console.log('─'.repeat(78))
console.log(`  ${rows.length - bad.length} 通过 / ${bad.length} 失败   总耗时 ${Date.now() - t0}ms`)
if (bad.length) {
  console.log('')
  for (const r of bad) {
    console.log(`  ✗ ${r.g.id} —— ${r.g.what}`)
    if (r.notes.length) for (const n of r.notes) console.log(`      · ${n}`)
    const tail = r.out.trim().split('\n').slice(-6)
    for (const l of tail) console.log(`      | ${l}`)
    console.log('')
  }
} else {
  console.log('  全部通过。')
}
console.log(`  （⚙ 有副作用的门：${selected.filter((g) => g.side).map((g) => g.id).join(', ') || '无'}）`)
process.exit(bad.length ? 1 : 0)
