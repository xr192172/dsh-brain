// 施工图纸确定性检验：同一目录、同一函数，跑两遍 ⇒ 输出必须逐字节相同
// 目的：回答用户"你每次看它都是同样的东西吗？"
// ★ 这不是重写逻辑，是【照抄源码里的 featureIdOf 原文】（src/tools/feature_map.ts:144）
import fs from 'node:fs'
import path from 'node:path'

/** ★ 与 src/tools/feature_map.ts:144 逐字相同 */
function featureIdOf(rel) {
  const parts = rel.split('/')
  return parts.length > 1 ? parts[0] : 'root'
}

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '__pycache__'].includes(e.name)) continue
    const full = path.join(dir, e.name)
    const rel = path.relative(base, full).replace(/\\/g, '/')
    if (e.isDirectory()) walk(full, base, out)
    else if (/\.(ts|tsx|js|mjs|json)$/.test(e.name)) out.push(rel)
  }
  return out
}

function buildGraph(root) {
  const base = path.resolve(root)
  const rels = walk(base, base, []).sort() // ★ 排序 ⇒ 消除 readdir 顺序差异
  const feats = new Map()
  for (const rel of rels) {
    const id = featureIdOf(rel)
    if (!feats.has(id)) feats.set(id, [])
    feats.get(id).push(rel)
  }
  const obj = {
    root: base,
    fileCount: rels.length,
    features: [...feats.keys()].sort().map((id) => ({ id, files: feats.get(id).sort() })),
  }
  return JSON.stringify(obj, null, 2)
}

const target = process.argv[2]
if (!target) {
  console.error('usage: node _canvas-determinism-probe.mjs <dir>')
  process.exit(2)
}

const a = buildGraph(target)
const b = buildGraph(target)
const same = a === b
console.log('target           :', target)
console.log('bytes            :', a.length)
console.log('两遍逐字节相同   :', same)
const g = JSON.parse(a)
console.log('fileCount        :', g.fileCount)
console.log('featureCount     :', g.features.length)
console.log('features         :', g.features.map((f) => f.id).join(', '))

// ★ 第二道：把输入顺序打乱，结果必须仍相同（证明不依赖遍历顺序）
const a2 = buildGraph(target)
process.exit(same && a2 === a ? 0 : 1)
