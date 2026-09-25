#!/usr/bin/env node
/**
 * oracle-intersection-guard.mjs —— l3-0003 的判据：
 *   检查 scripts/eval-holdout-run.mjs 中交集守卫的实现是否正确。
 *
 * ★ 判据：
 *   1. 存在 holdoutIds.filter + pilotIds.includes 的正确组合（不是 every/ some 混用）
 *   2. 存在 console.error 输出包含 "交集" 或 "重叠" 或 "相同 id"
 *   3. 存在 process.exit(1)（拒绝运行）
 *
 * 为什么不用 some()：some() 返回 true 即停止，适合"是否存在交集"的布尔判断，
 *   但我们需要的是"列出具体哪些 id 重叠"以便报错，所以用 filter 更合适。
 *   种子用 every() 是故意混淆：every() 需要"所有元素都满足"才返回 true，
 *   与"是否存在交集"的语义完全相反。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RUNNER = path.join(ROOT, 'scripts/eval-holdout-run.mjs')

const src = fs.readFileSync(RUNNER, 'utf8')

const problems = []

// 判据 1：正确的 filter+includes 组合（不是 every/some）
const hasCorrectFilter = /holdoutIds\.filter\s*\(\s*\(id\)\s*=>\s*pilotIds\.includes/.test(src)
if (!hasCorrectFilter) problems.push('交集守卫实现有误：应为 filter+includes，而非 every/some')

// 判据 2：错误信息含关键词
const hasReason = /交集|重叠|相同 id|overlap/i.test(src)
if (!hasReason) problems.push('缺交集守卫的原因说明')

// 判据 3：exit(1)
const hasExit = /\bexit\s*\(\s*1\s*\)/.test(src)
if (!hasExit) problems.push('缺 process.exit(1) —— 守卫没有真正拒绝运行')

if (problems.length > 0) {
  console.log('FAIL  l3-0003：交集守卫不完整或有缺陷')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0003：交集守卫完整（filter+includes + exit(1)）')
process.exit(0)
