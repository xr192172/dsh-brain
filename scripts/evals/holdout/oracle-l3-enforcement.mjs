#!/usr/bin/env node
/**
 * oracle-l3-enforcement.mjs —— l3-0001 的判据：
 *   检查 scripts/capability-gate.mjs 里 L3 的 enforced 字段是否为 true。
 *
 * ★ 判据：LADDER 中存在 level='L3' 且 enforced: true
 * 种子：把 enforced:true 改成 enforced:false
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ★ 路径修正：脚本在 scripts/evals/holdout/，往上两级到 wt 根，再进 scripts/
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..') // D:/project_develop/_l3/wt
const GATE = path.join(ROOT, 'scripts', 'capability-gate.mjs')

const src = fs.readFileSync(GATE, 'utf8')

// 检查 L3 的 enforced 是否为 true（精确匹配，不接受注释掉的）
const l3LineMatch = src.match(/^\s*\{ level: 'L3',.*enforced:\s*(true|false).*\},?\s*$/m)
if (!l3LineMatch) {
  console.log('FAIL  l3-0001：找不到 L3 LADDER 条目')
  process.exit(1)
}
const enforced = l3LineMatch[1]
if (enforced !== 'true') {
  console.log(`FAIL  l3-0001：L3 enforced=${enforced}（必须为 true）`)
  process.exit(1)
}

console.log('PASS  l3-0001：L3 enforced=true（L3 激活）')
process.exit(0)
