/**
 * probe-dc-backfill-cost.mjs —— 诊断：为什么"后台续建"比"一次性冷启"慢那么多？
 *
 * 用户质疑（2026-09-14）：「怎么补齐需要 42 秒？之前不是 12 秒吗？补齐其实变相拖慢了速度，对不对？
 * 是算法的问题吗？」
 *
 * 本探针把成本拆开量，而不是猜：
 *   A. 20 个文件走 syncProject（一个事务，= 冷启口径）
 *   B. 20 个文件逐个 syncFile（各自提交，= 续建口径）
 *   C. 纯 overhead：walkSourceFiles + indexedSet 各一次
 *   D. 单文件解析成本（parseFileFull）作为下界参考
 *
 * 用法：node scripts/probe-dc-backfill-cost.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const src = 'D:/project_develop/design-canvas/src'
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])

const { openDb } = await import(`file:///${DC}/dist/src/db/db.js`)
const { syncFile, syncProject } = await import(`file:///${DC}/dist/src/db/symbols.js`)
const { walkSourceFiles } = await import(`file:///${DC}/dist/src/tools/refs_text.js`)
const { beginBatch, endBatch } = await import(`file:///${DC}/dist/src/db/db.js`)
const { parseFileFull } = await import(`file:///${DC}/dist/src/tools/ts_kernel/index.js`)

function copyTree(from, to) {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
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

const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfcost-'))
  copyTree(src, root)
  return root
}

// A: syncProject（一个事务）
const rootA = mk()
const dbA = openDb(path.join(rootA, '.design-canvas', 'cache.db'))
const filesA = walkSourceFiles(rootA)
let t = Date.now()
await (async () => {
  beginBatch(dbA)
  try {
    await syncProject(dbA, rootA, filesA.slice(0, 20).map((r) => path.join(rootA, r)))
  } finally {
    endBatch(dbA)
  }
})()
const msA = Date.now() - t
dbA.close()

// B: 逐个 syncFile（各自提交）
const rootB = mk()
const dbB = openDb(path.join(rootB, '.design-canvas', 'cache.db'))
const filesB = walkSourceFiles(rootB)
t = Date.now()
for (const rel of filesB.slice(0, 20)) await syncFile(dbB, rootB, path.join(rootB, rel))
const msB = Date.now() - t
dbB.close()

// B2: 逐个 syncFile + 一个事务（= 续建现在的做法）
const rootB2 = mk()
const dbB2 = openDb(path.join(rootB2, '.design-canvas', 'cache.db'))
const filesB2 = walkSourceFiles(rootB2)
t = Date.now()
beginBatch(dbB2)
try {
  for (const rel of filesB2.slice(0, 20)) await syncFile(dbB2, rootB2, path.join(rootB2, rel))
} finally {
  endBatch(dbB2)
}
const msB2 = Date.now() - t
dbB2.close()

// C: overhead（walk + indexedSet）
const rootC = mk()
const dbC = openDb(path.join(rootC, '.design-canvas', 'cache.db'))
t = Date.now()
for (let i = 0; i < 16; i++) {
  const all = walkSourceFiles(rootC)
  const idx = new Set(dbC.prepare('SELECT path FROM files').all().map((r) => r.path))
  void all
  void idx
}
const msC = Date.now() - t
dbC.close()

// D: 纯解析下界
const filesD = walkSourceFiles(rootC)
t = Date.now()
for (const rel of filesD.slice(0, 20)) {
  const s = fs.readFileSync(path.join(rootC, rel), 'utf8')
  await parseFileFull(path.join(rootC, rel), s)
}
const msD = Date.now() - t

const lines = [
  `后台续建成本拆解（各 20 文件，源：${src}）`,
  `  A. syncProject（**一个事务**，冷启口径）      : ${msA}ms  → ${(msA / 20).toFixed(1)}ms/文件`,
  `  B. syncFile × 20（**各自提交**）              : ${msB}ms  → ${(msB / 20).toFixed(1)}ms/文件`,
  `  B2. syncFile × 20（**外层一个事务**）         : ${msB2}ms  → ${(msB2 / 20).toFixed(1)}ms/文件`,
  `  C. 16 轮 walk+indexedSet 的纯 overhead        : ${msC}ms（摊到 16 轮 ≈ ${(msC / 16).toFixed(0)}ms/轮）`,
  `  D. 纯解析 20 文件（无 DB 写）                 : ${msD}ms  → ${(msD / 20).toFixed(1)}ms/文件`,
  '',
  `  ⇒ B/A = ${(msB / Math.max(1, msA)).toFixed(1)}×；B2/A = ${(msB2 / Math.max(1, msA)).toFixed(1)}×`,
  '  结论用法：谁最接近 42s/290 文件（≈145ms/文件）的观测值，谁就是主因。',
]

// E: 模拟续建循环（每轮 20 文件，一轮一事务），看"每文件成本是否随索引变大而上升"
{
  const rootE = mk()
  const dbE = openDb(path.join(rootE, '.design-canvas', 'cache.db'))
  const allE = walkSourceFiles(rootE)
  const rounds = []
  for (let r = 0; r < 6; r++) {
    const idx = new Set(dbE.prepare('SELECT path FROM files').all().map((x) => x.path))
    const take = allE.filter((x) => !idx.has(x)).slice(0, 20)
    if (!take.length) break
    const t0 = Date.now()
    beginBatch(dbE)
    try {
      for (const rel of take) await syncFile(dbE, rootE, path.join(rootE, rel))
    } finally {
      endBatch(dbE)
    }
    const nodes = dbE.prepare('SELECT COUNT(*) c FROM nodes').get().c
    const edges = dbE.prepare('SELECT COUNT(*) c FROM edges').get().c
    rounds.push(`  轮 ${r + 1}: ${take.length} 文件 ${Date.now() - t0}ms（${((Date.now() - t0) / take.length).toFixed(0)}ms/文件）｜库内 nodes=${nodes} edges=${edges}`)
  }
  const tR = Date.now()
  try {
    const { resolveCrossFileCalls } = await import(`file:///${DC}/dist/src/db/symbols.js`)
    resolveCrossFileCalls(dbE, rootE)
  } catch {
    /* ignore */
  }
  rounds.push(`  收尾 resolveCrossFileCalls: ${Date.now() - tR}ms`)
  dbE.close()
  lines.push('', '  E. 模拟续建循环（每轮 20 文件 / 一轮一事务）—— 关键：**每文件成本是否随索引变大而上升**')
  lines.push(...rounds)
  try {
    fs.rmSync(rootE, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
fs.writeFileSync('D:/project_develop/dsh-brain/out/backfill-cost.txt', lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
for (const r of [rootA, rootB, rootB2, rootC]) {
  try {
    fs.rmSync(r, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
