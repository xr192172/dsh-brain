/**
 * probe-dc-locality.mjs —— 「拼图式局部索引」可行性测量
 *
 * 用户的想法（2026-09-14）：「**不用预建立，而是及时建立**：从模型选中的那个文件/符号为起点，
 * 沿边向周围拓展，直到撞上**已经建好的索引**，把两块拼图**连通在一起**。」
 *
 * 本探针用真实数据回答三个问题：
 *   ① 一块"拼图"到底多大？（从种子出发，沿 import 边 N 跳的文件数）
 *   ② 局部索引的代价是多少？（按实测 41ms/文件的冷启成本折算）
 *   ③ 缝合点好不好找？（有多少邻居**已经在索引里**）
 *
 * 方法：把 design-canvas/src 复制到临时目录 → 建好索引 → 只读地用索引图算闭包规模。
 * 用法：node scripts/probe-dc-locality.mjs [srcDir] [--seed 相对路径]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const srcArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `${DC}/src`
const seedArg = process.argv.indexOf('--seed')
const seedRel = seedArg > 0 ? process.argv[seedArg + 1] : undefined

const { ensureProjectIndex } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)

const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.go', '.py', '.java', '.rs', '.cs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])

function copyTree(from, to) {
  let n = 0
  const walk = (d) => {
    let es = []
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue
        walk(p)
      } else if (EXTS.has(path.extname(e.name))) {
        const dst = path.join(to, path.relative(from, p))
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(p, dst)
        n++
      }
    }
  }
  walk(from)
  return n
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locality-'))
const copied = copyTree(path.resolve(srcArg), root)

// ── 模式 B（--tile）：**真跑**拼图式局部索引，测"选中一个文件"的首调延迟 ──
if (process.argv.includes('--tile')) {
  const { ensureIndexAroundSeed } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)
  // 注意：copyTree 把 src 的**内容**复制到 root ⇒ 种子路径不带 src/ 前缀
  const depthArg = process.argv.indexOf('--depth')
  const tileDepth = depthArg > 0 ? Number(process.argv[depthArg + 1]) : 2
  const impArg = process.argv.indexOf('--importers')
  const tileImporters = impArg > 0 ? Number(process.argv[impArg + 1]) : 20
  const seeds = ['tools/edit_code.ts', 'db/symbols.ts', 'observe/instrument.ts', 'tools/import_project.ts']
  const out = []
  out.push(`拼图式局部索引（S1 实测）—— 源：${path.resolve(srcArg)}（复制 ${copied} 文件）`)
  out.push(`  语义：以 1 个文件为种子、双向 ${tileDepth} 跳、预算 200 文件、入边靠文本反查（并入者为终点）`)
  out.push('')
  out.push('  种子'.padEnd(40) + '新建  失败  缝合  访问  耗时     状态')
  let total = 0
  for (const s of seeds) {
    const t = Date.now()
    const r = await ensureIndexAroundSeed(root, [s], { depth: tileDepth, maxFiles: 200, maxTextImporters: tileImporters })
    const ms = Date.now() - t
    total += ms
    out.push(
      '  ' + s.padEnd(36) + String(r.newFiles).padStart(4) + String(r.failed).padStart(6) +
        String(r.stitched).padStart(6) + String(r.visited).padStart(6) +
        `${String(ms).padStart(7)}ms   ${r.partial ? `partial(${r.stopReason})` : 'ready'}`,
    )
  }
  out.push('')
  out.push(`  参考：同项目**全量冷启 12151ms**（296 文件）⇒ 拼图首调省 ${(100 - (total / seeds.length / 12151) * 100).toFixed(0)}%`)
  fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
  fs.writeFileSync('D:/project_develop/dsh-brain/out/locality-tile.txt', out.join('\n'), 'utf8')
  console.log(out.join('\n'))
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}
  process.exit(0)
}

// ── 模式 C（--flow）：完整复现"首次读 → 后台续建补齐"的用户流程 ──
if (process.argv.includes('--flow')) {
  const { ensureIndexAroundSeed } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)
  const { scheduleBackfill, backfillState } = await import(`file:///${DC}/dist/src/tools/index_backfill.js`)
  const seed = 'observe/instrument.ts'
  const out = []
  out.push(`首次读 → 后台续建（S2 判定）—— 源：${path.resolve(srcArg)}（复制 ${copied} 文件）`)
  out.push('')
  const t0 = Date.now()
  const tile = await ensureIndexAroundSeed(root, [seed], { depth: 1, maxFiles: 80, maxTextImporters: 6, maxMs: 4000 })
  const firstMs = Date.now() - t0
  out.push(`① 首次读建块（seed=${seed}，时长上限 4000ms）`)
  out.push(`   新建 ${tile.newFiles} ｜ 缝合 ${tile.stitched} ｜ 访问 ${tile.visited} ｜ 状态 ${tile.partial ? `partial(${tile.stopReason})` : 'ready'}`)
  out.push(`   ★ 实测耗时：**${firstMs}ms**（读得到 = 最重要）`)
  out.push('')
  const t1 = Date.now()
  scheduleBackfill(root, { batch: 20, intervalMs: 50 })
  for (;;) {
    const s = backfillState(root)
    if (!s || !s.running) break
    if (Date.now() - t1 > 300000) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const bf = backfillState(root)
  out.push(`② 后台续建（batch=20 / 50ms 间隔，空闲时跑）`)
  out.push(`   ${bf ? `总数 ${bf.total} ｜ 完成 ${bf.done} ｜ 本轮新建 ${bf.synced} ｜ 失败 ${bf.failed} ｜ 轮次 ${bf.rounds}` : '(未起)'}`)
  out.push(`   ★ 补齐用时：**${Date.now() - t1}ms**（与前台读并行/空闲时进行，不阻塞读）`)
  fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
  fs.writeFileSync('D:/project_develop/dsh-brain/out/locality-flow.txt', out.join('\n'), 'utf8')
  console.log(out.join('\n'))
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}
  process.exit(0)
}

const t0 = Date.now()
const { db } = await ensureProjectIndex(root)
const bootMs = Date.now() - t0
const perFileMs = bootMs / Math.max(1, copied)

// ── 闭包规模：沿 edges(kind='import'/'call') 双向 N 跳 ──
const importOut = db.prepare("SELECT source, target FROM edges WHERE kind='import'").all()
const callOut = db.prepare("SELECT source, target FROM edges WHERE kind='call'").all()
const fileOf = (nodeId) => nodeId.split('#')[0]

const outAdj = new Map()
const inAdj = new Map()
const push = (m, k, v) => m.set(k, [...(m.get(k) ?? []), v])
for (const e of importOut) {
  const s = fileOf(e.source)
  const t = fileOf(e.target)
  if (s === t) continue
  push(outAdj, s, t)
  push(inAdj, t, s)
}
for (const e of callOut) {
  const s = fileOf(e.source)
  const t = fileOf(e.target)
  if (s === t) continue
  push(outAdj, s, t)
  push(inAdj, t, s)
}

function closure(seed, depth, dir) {
  const adj = dir === 'in' ? inAdj : dir === 'out' ? outAdj : null
  const seen = new Set([seed])
  let frontier = [seed]
  for (let d = 0; d < depth; d++) {
    const next = []
    for (const f of frontier) {
      const nb = dir === 'both' ? [...(outAdj.get(f) ?? []), ...(inAdj.get(f) ?? [])] : adj?.get(f) ?? []
      for (const t of nb) if (!seen.has(t)) {
        seen.add(t)
        next.push(t)
      }
    }
    frontier = next
  }
  return seen
}

const indexed = new Set(db.prepare('SELECT path FROM files').all().map((r) => r.path))
const allFiles = [...indexed].sort()
const seeds = seedRel ? [seedRel] : [allFiles[0], allFiles[Math.floor(allFiles.length / 3)], allFiles[Math.floor(allFiles.length / 2)], allFiles[allFiles.length - 1]].filter(Boolean)

const lines = []
lines.push(`局部索引（拼图）可行性测量 —— 源：${path.resolve(srcArg)}`)
lines.push(`  源文件 ${copied} ｜ 全量冷启 ${bootMs}ms ⇒ **${perFileMs.toFixed(1)}ms/文件**（这是所有折算的基数）`)
lines.push(`  索引内文件 ${indexed.size} ｜ 图：import 边 ${importOut.length} ｜ call 边 ${callOut.length}`)
lines.push('')
lines.push('① 一块"拼图"多大 / 折算代价（沿 import+call 边扩展）：')
lines.push('  种子（相对路径）'.padEnd(46) + '出1跳  出2跳  出3跳  入1跳  双向2跳  双向2跳折算')
for (const s of seeds) {
  const o1 = closure(s, 1, 'out').size
  const o2 = closure(s, 2, 'out').size
  const o3 = closure(s, 3, 'out').size
  const i1 = closure(s, 1, 'in').size
  const b2 = closure(s, 2, 'both').size
  lines.push(
    '  ' + s.padEnd(44) + String(o1).padStart(4) + String(o2).padStart(7) + String(o3).padStart(7) +
      String(i1).padStart(7) + String(b2).padStart(8) + `  ${(b2 * perFileMs).toFixed(0)}ms`,
  )
}
lines.push('')
lines.push('② 与全量对比（同一基数）')
lines.push(`  全量（${indexed.size} 文件）：${bootMs}ms`)
for (const s of seeds.slice(0, 2)) {
  const b2 = closure(s, 2, 'both').size
  lines.push(`  双向 2 跳（${b2} 文件）：${(b2 * perFileMs).toFixed(0)}ms  ⇒ 省 ${(100 - (b2 / indexed.size) * 100).toFixed(0)}%`)
}
lines.push('')
lines.push('③ 缝合点模拟：假设"已有索引"= 字母序前 30 个文件，从种子双向 2 跳会新增多少、又缝合多少')
const preIndexed = new Set(allFiles.slice(0, 30))
for (const s of seeds) {
  const cl = closure(s, 2, 'both')
  const fresh = [...cl].filter((f) => !preIndexed.has(f)).length
  const stitch = cl.size - fresh
  lines.push(
    `  ${s.padEnd(44)} 闭包 ${String(cl.size).padStart(3)} ｜ 需新建 ${String(fresh).padStart(3)} ｜ 缝合（已在索引）${String(stitch).padStart(3)} ｜ 折算 ${(fresh * perFileMs).toFixed(0)}ms`,
  )
}

fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
fs.writeFileSync('D:/project_develop/dsh-brain/out/locality.txt', lines.join('\n'), 'utf8')
console.log(lines.join('\n'))

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* Windows 占用留给 OS */
}
