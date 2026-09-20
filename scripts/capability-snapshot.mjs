#!/usr/bin/env node
/**
 * capability-snapshot.mjs —— **能力库**的快照 / 还原 / 差异（`eval-validate` 那套 seed/restore 的能力库版）。
 *
 * 为什么需要：`~/.dsh/capabilities/registry.json` 是**共享可变状态**（运行中的 gen、自进化子 agent、
 * 别的会话都可能写它；实测我的实验窗口内它就被改过，且目录里留着 `.tmp` 残留）。
 * 实验前后不把它按住，就没有"同一个起点"可言 —— 与工作区的 seed/restore 同理。
 *
 * 纪律（与 `eval-validate.mjs` 一致）：
 *  · 还原前比对**sha256**：当前内容既不是快照、也不是快照 ⇒ **拒绝覆盖**并报告（疑似并发写者）；
 *    `--force`（给实验台用）才无条件写回，写完再**校验一次** sha。
 *  · 绝不"删掉再建"：直接写字节（保留原子性交给调用方/系统）。
 *
 * 用法：
 *   node scripts/capability-snapshot.mjs --save                 # 存快照
 *   node scripts/capability-snapshot.mjs --restore [--force]    # 还原
 *   node scripts/capability-snapshot.mjs --diff                 # 快照 vs 现状（能力增删）
 *   node scripts/capability-snapshot.mjs --show                 # 现状摘要
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const REPO = 'D:/project_develop/dsh-brain'
const CAPDIR = 'C:/Users/Admin/.dsh/capabilities'
const REG = path.join(CAPDIR, 'registry.json')
const SNAP = path.join(REPO, 'out/capability-snapshot.json')
const SNAP_BYTES = path.join(REPO, 'out/capability-snapshot.registry.json')

const argv = process.argv.slice(2)
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)
const readReg = () => fs.readFileSync(REG)
const parse = (b) => JSON.parse(b.toString('utf8'))
const ids = (j) => (j?.capabilities ?? []).map((c) => c.id)

function show(label, j, bytes) {
  console.log(`  ${label}: sha=${sha(bytes)} 能力数=${ids(j).length} updatedAt=${j?.updatedAt ?? '?'}`)
  console.log(`    ids: ${ids(j).join(', ')}`)
}

if (argv.includes('--save')) {
  const b = readReg()
  fs.mkdirSync(path.dirname(SNAP), { recursive: true })
  fs.writeFileSync(SNAP_BYTES, b)
  const j = parse(b)
  fs.writeFileSync(SNAP, JSON.stringify({ at: new Date().toISOString(), sha256: sha(b), count: ids(j).length, ids: ids(j) }, null, 2), 'utf8')
  show('已存快照', j, b)
  process.exit(0)
}

if (argv.includes('--restore')) {
  if (!fs.existsSync(SNAP_BYTES)) {
    console.error('没有快照（先 --save）')
    process.exit(1)
  }
  const snap = fs.readFileSync(SNAP_BYTES)
  const cur = readReg()
  const same = sha(cur) === sha(snap)
  console.log(`  现状 sha=${sha(cur)}  快照 sha=${sha(snap)}`)
  if (same) {
    console.log('  已与快照一致（幂等，无需还原）')
    process.exit(0)
  }
  const force = argv.includes('--force')
  if (!force) {
    console.error(
      '  ✗ 拒绝还原：当前能力库与快照不同 —— 可能是**自进化/别的会话刚写过**（并发写者）。\n' +
        '     要强制回到快照请加 --force（实验台用），或先 --diff 看清改了什么。',
    )
    process.exit(1)
  }
  fs.writeFileSync(REG, snap)
  const after = readReg()
  const ok = sha(after) === sha(snap)
  console.log(`  已还原（force）⇒ 校验 ${ok ? 'sha 一致 ✓' : '**sha 不一致 ✗**'}`)
  process.exit(ok ? 0 : 1)
}

if (argv.includes('--diff')) {
  if (!fs.existsSync(SNAP_BYTES)) {
    console.error('没有快照（先 --save）')
    process.exit(1)
  }
  const a = parse(fs.readFileSync(SNAP_BYTES))
  const b = parse(readReg())
  const A = new Set(ids(a))
  const B = new Set(ids(b))
  const added = [...B].filter((x) => !A.has(x))
  const removed = [...A].filter((x) => !B.has(x))
  show('快照', a, fs.readFileSync(SNAP_BYTES))
  show('现状', b, readReg())
  console.log(`  新增: ${added.join(', ') || '(无)'}`)
  console.log(`  消失: ${removed.join(', ') || '(无)'}`)
  process.exit(added.length || removed.length ? 2 : 0)
}

// 默认 --show
{
  const b = readReg()
  show('现状', parse(b), b)
  const extra = fs.readdirSync(CAPDIR).filter((f) => f !== 'registry.json')
  if (extra.length) console.log(`  ⚠ 目录里还有别的文件（含残留 .tmp？）：${extra.join(', ')}`)
}
