/**
 * probe-dc-backfill-profile.mjs —— 后台续建的耗时剖面：同步 / 跨文件解析 / 其余，各占多少
 *
 * 回答用户质疑：「补齐 42s vs 全量冷启 12s，是算法的问题吗？」
 * 本探针用 `backfillState()` 里新增的计时字段把时间拆开，而不是猜。
 *
 * 用法：node scripts/probe-dc-backfill-profile.mjs [--batch 20] [--interval 50]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const src = 'D:/project_develop/design-canvas/src'
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])

const arg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? Number(process.argv[i + 1]) : def
}
const batch = arg('--batch', 20)
const intervalMs = arg('--interval', 50)

const { ensureIndexAroundSeed } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)
const { scheduleBackfill, backfillState } = await import(`file:///${DC}/dist/src/tools/index_backfill.js`)

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bfprof-'))
copyTree(src, root)

await ensureIndexAroundSeed(root, ['observe/instrument.ts'], { depth: 1, maxFiles: 80, maxTextImporters: 6, maxMs: 4000 })
const t0 = Date.now()
scheduleBackfill(root, { batch, intervalMs })
for (;;) {
  const s = backfillState(root)
  if (!s || !s.running) break
  await new Promise((r) => setTimeout(r, 100))
}
const wall = Date.now() - t0
const s = backfillState(root)
const other = wall - (s?.syncMs ?? 0) - (s?.resolveMs ?? 0) - (s?.overheadMs ?? 0)

const lines = [
  `后台续建耗时剖面（源：${src}；batch=${batch} interval=${intervalMs}ms）`,
  `  总墙钟            : ${wall}ms`,
  `  其中 同步(syncFile): ${s?.syncMs ?? 0}ms（${((s?.syncMs ?? 0) / Math.max(1, s?.synced ?? 1)).toFixed(1)}ms/文件）`,
  `  其中 跨文件解析    : ${s?.resolveMs ?? 0}ms`,
  `  其中 扫描/让出/其他 : ${s?.overheadMs ?? 0}ms（其余 ${other}ms ≈ 定时器间隔空等）`,
  `  轮次 ${s?.rounds ?? 0} ｜ 新建 ${s?.synced ?? 0} ｜ 失败 ${s?.failed ?? 0}`,
  `  参考：同项目一次性 syncProject（冷启口径）11659ms / 298 文件 = 39ms/文件`,
]
fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
fs.writeFileSync('D:/project_develop/dsh-brain/out/backfill-profile.txt', lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* ignore */
}
