/**
 * probe-dc-observe-points.mjs —— 推荐器的"最小真用例"：对指定项目跑一遍，看它推荐哪些观测点
 *
 * 默认目标 = D:\project_develop\dsh-brain（压缩/缓存真身所在：packages/conveyor-context、
 * spill-policy、cache 相关）。用途：与"作者手写的 10 个真正想看的点"做 holdout 对照（判据：命中 ≥80%）。
 *
 * 用法：
 *   node scripts/probe-dc-observe-points.mjs [projectDir] [--points 40]
 */
import fs from 'node:fs'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const targetArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'D:/project_develop/dsh-brain'
const target = path.resolve(targetArg)
const pointsArg = process.argv.indexOf('--points')
const maxPoints = pointsArg > 0 ? Number(process.argv[pointsArg + 1]) : 40
const focusArg = process.argv.indexOf('--focus')
const focus = focusArg > 0 ? process.argv[focusArg + 1] : undefined
const OUT = `D:/project_develop/dsh-brain/out/observe-points-${path.basename(target)}${focus ? '-' + focus.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 24) : ''}.txt`

const { openDb } = await import(`file:///${DC}/dist/src/db/db.js`)
const { ensureProjectIndex } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)
const { recommendObservePoints } = await import(`file:///${DC}/dist/src/tools/observe_points.js`)

const t0 = Date.now()

// 零前置：空库就地冷启建索引（推荐器建立在索引之上）
const { db } = await ensureProjectIndex(target)
// 默认落盘（产出可交给 observe_instrument 的 contractProbes 清单）；--dry 只算不写
const r = await recommendObservePoints(db, target, {
  maxPoints,
  write: !process.argv.includes('--dry'),
  focus,
})

const lines = [
  `观测点推荐 —— 目标：${target}`,
  `耗时 ${Date.now() - t0}ms ｜ 打分符号 ${r.stats.symbolsScored} ｜ 扫描文件 ${r.stats.filesScanned} ｜ 站点 ${r.stats.sitesFound}`,
  `返回 ${r.stats.returned} 个${r.stats.truncated ? `（按分数截断 ${r.stats.truncated} 个）` : ''}`,
  '',
  r.summary,
  '',
  '──── 前 20 个（分数 / 探针名 / 文件 / 依据）────',
  ...r.points.slice(0, 20).map(
    (p) => `  ${p.score.toFixed(2)}  ${p.key.padEnd(46)} ${p.file.padEnd(34)} ${p.reasons.map((x) => `${x.signal}(${x.detail})`).join(' + ')}`,
  ),
  '',
  '──── 与「缓存/压缩/上下文」相关的推荐（人工 holdout 的对照面）────',
  ...r.points
    .filter((p) => /cache|spill|compact|context|conveyor|token|prefix|hit/i.test(p.key + ' ' + p.file))
    .slice(0, 20)
    .map((p) => `  ${p.score.toFixed(2)}  ${p.key.padEnd(46)} ${p.file}`),
]

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.slice(0, 40).join('\n'))
console.log(`\nok -> ${OUT}`)
process.exit(0)
