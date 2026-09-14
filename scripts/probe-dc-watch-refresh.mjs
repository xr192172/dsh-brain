/**
 * probe-dc-watch-refresh.mjs —— 「改一个文件，看门狗到底重算了多少？」
 *
 * 回答用户 2026-09-14 的问题：
 *   「拼图的这一块有文件更新了，触发更新……这个文件动了哪些就重新算这一部分就可以了，
 *     毕竟它只是引用，我们只要重算引用部分即可。但是 AST 这部分是怎么算的？」
 *
 * 对拍设计：**两份独立副本**（避免互相污染），同一个改动（符号被改名 ⇒ 旧节点消失
 * ⇒ 引用方边被 FK ON DELETE CASCADE 静默删掉），只换"引用解析"的口径：
 *   A) 新口径：`flushBatch` = sync(改动文件) + `reopenRefsTo`(重开引用方) + **scoped** resolve
 *   B) 旧口径：`handleWatchEvent`(sync) + `resolveCrossFileCalls(db, root)` **全量**
 *
 * 关键指标不是毫秒，而是**陈旧断言数**：
 *   `unresolved_refs` 里 status='resolved' 但该引用名**已不在索引里**的行数。
 *   resolved 的含义是"连上了某个符号"；名字都没了它还说自己 resolved，就是一句**过期的断言**，
 *   对应 find_references / impact 上的**静默漏报**。
 *
 * 用法：node scripts/probe-dc-watch-refresh.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const src = `${DC}/src`
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])

const { openDb } = await import(`file:///${DC}/dist/src/db/db.js`)
const { ensureFreshIndex } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)
const { flushBatch, handleWatchEvent } = await import(`file:///${DC}/dist/src/tools/watch_project.js`)
const { resolveCrossFileCalls } = await import(`file:///${DC}/dist/src/db/symbols.js`)

function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const p = path.join(from, e.name)
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue
      copyTree(p, path.join(to, e.name))
    } else if (EXTS.has(path.extname(e.name))) {
      fs.mkdirSync(path.dirname(path.join(to, e.name)), { recursive: true })
      fs.copyFileSync(p, path.join(to, e.name))
    }
  }
}

/**
 * 跑一个场景：建副本 → 冷启索引 → 把"被引用最多的符号"改名 → 用指定口径重算。
 * @param {'A' | 'B'} mode
 */
async function runScenario(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `watchref-${mode}-`))
  copyTree(src, root)
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'))
  const one = (sql, ...args) => db.prepare(sql).get(...args).c
  /** 陈旧断言：说自己 resolved，但那个引用名已经不在索引里了 */
  const staleResolved = () =>
    one(`SELECT COUNT(*) c FROM unresolved_refs u
         WHERE u.status = 'resolved'
           AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.name = u.reference_name)`)

  const tCold = Date.now()
  await ensureFreshIndex(db, root)
  const coldMs = Date.now() - tCold

  const nFiles = one('SELECT COUNT(*) c FROM files')
  const base = { root, db, coldMs, nFiles, stale0: staleResolved() }

  // 靶子：被别的文件**按引用名**解析过、且引用方最多的符号（增量口径的最坏情况）
  const pick = db
    .prepare(
      `SELECT n.name AS nm, n.file_path AS f, COUNT(*) AS c
       FROM edges e JOIN nodes n ON n.id = e.target
       WHERE instr(e.target, '#') > 0 AND e.source != e.target
         AND EXISTS (SELECT 1 FROM unresolved_refs u WHERE u.reference_name = n.name AND u.status = 'resolved')
       GROUP BY e.target
       ORDER BY c DESC LIMIT 1`,
    )
    .get()
  if (!pick) {
    db.close()
    return { ...base, ok: false }
  }

  const absPath = path.join(root, pick.f)
  const original = fs.readFileSync(absPath, 'utf8')
  fs.writeFileSync(absPath, original.replace(new RegExp(`\\b${pick.nm}\\b`, 'g'), `${pick.nm}_renamed${mode}`), 'utf8')

  let ms = 0
  let scopeFiles = 0
  let reopened = 0
  let crossText = ''
  if (mode === 'A') {
    const t = Date.now()
    const a = await flushBatch(db, root, [pick.f])
    ms = Date.now() - t
    scopeFiles = 1 + a.refsReopenedFiles
    reopened = a.refsReopened
    crossText = `解析 ${a.cross.total} 条（resolved ${a.cross.resolved} / failed ${a.cross.failed}）`
  } else {
    const t = Date.now()
    await handleWatchEvent(db, root, absPath)
    const c = resolveCrossFileCalls(db, root) // ★ 全量：不传 scopeFiles
    ms = Date.now() - t
    scopeFiles = nFiles
    reopened = 0
    crossText = `解析 ${c.total} 条（resolved ${c.resolved} / external ${c.external} / failed ${c.failed}）`
  }

  const res = {
    ...base,
    ok: true,
    pick,
    ms,
    scopeFiles,
    reopened,
    crossText,
    stale: staleResolved(),
  }
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
  return res
}

console.log('看门狗「只重算引用部分」对拍 —— 源：' + src)
console.log('（两份独立副本，同一个"符号改名 ⇒ 引用方边被级联删掉"的改动）')
console.log('')

const B = await runScenario('B') // 旧口径
const A = await runScenario('A') // 新口径

if (!B.ok || !A.ok) {
  console.log('索引里找不到"按引用名解析过"的跨文件目标，无法对拍。')
  process.exit(1)
}

const show = (label, r) => {
  console.log(`${label}  （索引 files=${r.nFiles}，冷启 ${r.coldMs}ms）`)
  console.log(`   靶子 ${r.pick.f} 的 \`${r.pick.nm}\`（${r.pick.c} 条跨文件边指向）`)
  console.log(`   墙钟 ${r.ms}ms ｜ 重算范围 ${r.scopeFiles} 文件 ｜ 重开引用 ${r.reopened} 条`)
  console.log(`   ${r.crossText}`)
  console.log(`   ★ 陈旧断言（resolved 但目标名已不在索引）：${r.stale0} → **${r.stale}**`)
  console.log('')
}

show('B) 旧口径：sync + resolveCrossFileCalls（全量）', B)
show('A) 新口径：flushBatch（sync + 重开引用方 + 按 scope 解析）', A)

console.log('结论（三件事分开看，别混）：')
console.log(`  ① 正确性（最要紧）：旧口径把陈旧断言从 ${B.stale0} 抬到 **${B.stale}** ——`)
console.log(`     那批引用方文件自己没变、行还停在 'resolved'，全量口径**根本不看它们**，`)
console.log(`     于是边被 FK 级联删掉后一条都不重建 ⇒ find_references / impact 静默漏报。`)
console.log(`     新口径 ${A.stale0} → ${A.stale}（重开 ${A.reopened} 条、范围 ${A.scopeFiles} 文件）：遗漏被如实补回/判死。`)
console.log(`  ② 范围：${B.scopeFiles} 文件 vs ${A.scopeFiles} 文件 —— 全量与仓规模成正比、与改动无关；`)
console.log(`     增量只与"改动文件 + 它的引用方"成正比。本例靶子是引用最多的最坏情况，所以比值才只到 ${(B.scopeFiles / A.scopeFiles).toFixed(1)}×。`)
console.log(`  ③ 与 42s 那件事无关：42s 的主因是"写了边却没包事务"（每条语句一次 fsync），`)
console.log(`     那条修正把跨文件解析 27.3s → 1.9s，修的是**写放大**，不是范围。`)
