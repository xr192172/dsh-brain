/**
 * dump-dc-tool-catalog.mjs —— 从 design-canvas 编译产物导出真实工具目录（name/title/description）
 *
 * 用途：为 capability_map 的「单一真相源」改造做现状盘点——先看清注册表里到底有多少工具、
 * 描述长什么样（新的 `when` 由描述派生，必须先验证派生质量）。
 *
 * 用法：node scripts/dump-dc-tool-catalog.mjs
 */
import fs from 'node:fs'

const DC = 'D:/project_develop/design-canvas'
const OUT = 'D:/project_develop/dsh-brain/out/dc-tool-catalog.json'
const DIST = `${DC}/dist/src/server_registry.js`

const mod = await import(`file:///${DIST}`)
const defs = mod.TOOL_DEFS
const rows = defs.map((d) => ({
  name: d.name,
  title: d.title,
  descLen: (d.description ?? '').length,
  description: (d.description ?? '').slice(0, 200),
}))

fs.writeFileSync(OUT, JSON.stringify({ total: rows.length, builtAt: fs.statSync(DIST).mtime.toISOString(), tools: rows }, null, 2), 'utf8')
console.log(`total=${rows.length} -> ${OUT}`)
console.log(rows.map((r) => `${r.name}\t${r.title}\t${r.descLen}`).join('\n'))
