/**
 * probe-dc-resolve-cost.mjs —— 单独量 resolveCrossFileCalls 的成本（它是"补齐 42s"的头号嫌疑）
 *
 * 背景：用户质疑"补齐 42s vs 全量冷启 12s"。拆解后怀疑收尾的跨文件解析是主因。
 * 本探针：建好 N 个文件的索引（syncProject，一次事务）→ 单独计时 resolveCrossFileCalls，
 * 并分别计时"预载符号表"与"处理 pending"两段。
 *
 * 用法：node scripts/probe-dc-resolve-cost.mjs [N1,N2,...]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const src = 'D:/project_develop/design-canvas/src'
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])
const sizes = (process.argv[2] ?? '40,120,298').split(',').map(Number)

const { openDb } = await import(`file:///${DC}/dist/src/db/db.js`)
const { syncProject, resolveCrossFileCalls } = await import(`file:///${DC}/dist/src/db/symbols.js`)
const { beginBatch, endBatch } = await import(`file:///${DC}/dist/src/db/db.js`)
const { walkSourceFiles } = await import(`file:///${DC}/dist/src/tools/refs_text.js`)

function copyTree(from, to) {
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
      }
    }
  }
  walk(from)
}

const out = ['resolveCrossFileCalls 单独成本（源：' + src + '）']
for (const n of sizes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rc-${n}-`))
  copyTree(src, root)
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'))
  const files = walkSourceFiles(root).slice(0, n)

  let t = Date.now()
  beginBatch(db)
  try {
    await syncProject(db, root, files.map((r) => path.join(root, r)))
  } finally {
    endBatch(db)
  }
  const syncMs = Date.now() - t

  const nodes = db.prepare('SELECT COUNT(*) c FROM nodes').get().c
  const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c
  const pending = db.prepare("SELECT COUNT(*) c FROM unresolved_refs WHERE status='pending'").get().c

  // 预载（模拟该函数内部的两次查询）
  t = Date.now()
  const symRows = db.prepare("SELECT name, file_path FROM nodes WHERE kind != 'file'").all()
  const typeRows = db.prepare("SELECT name, file_path FROM nodes WHERE kind IN ('interface','type','class')").all()
  const preloadMs = Date.now() - t

  t = Date.now()
  resolveCrossFileCalls(db, root)
  const resolveMs = Date.now() - t

  out.push(
    `  N=${String(n).padStart(3)} ｜ sync ${syncMs}ms ｜ nodes=${nodes} edges=${edges} pending=${pending}` +
      ` ｜ 预载 ${preloadMs}ms（${symRows.length}+${typeRows.length} 行） ｜ **resolve ${resolveMs}ms**`,
  )
  db.close()
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

out.push('')
out.push('  读法：若 resolve 远大于 sync，说明"跨文件解析"是补齐/冷启的主要成本；')
out.push('        若预载占大头，则任何"按文件 scope"的调用都省不下来（预载是全表）。')
fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
fs.writeFileSync('D:/project_develop/dsh-brain/out/resolve-cost.txt', out.join('\n'), 'utf8')
console.log(out.join('\n'))
