#!/usr/bin/env node
/**
 * oracle-count-guard.mjs —— l3-0002 的判据：
 *   检查 scripts/eval-holdout-run.mjs 中条数守卫的实现是否正确。
 *
 * ★ 判据：
 *   1. 存在 `tasks.length < 3` 的严格检查（不能是 `< 2` 或 `<= 3` 等弱形式）
 *   2. 存在 console.error 输出包含 "条数" 或 "少于" 或 "3 条"
 *   3. 存在 process.exit(1)（拒绝运行）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RUNNER = path.join(ROOT, 'scripts/eval-holdout-run.mjs')

const src = fs.readFileSync(RUNNER, 'utf8')

const problems = []

// 判据 1：严格的 < 3 检查（必须恰好是 < 3，不是 < 2 或其他）
const hasStrictCount = /tasks\.length\s*<\s*3\b/.test(src)
if (!hasStrictCount) problems.push('缺 `tasks.length < 3` 严格检查（可能是 < 2 或其他弱形式）')

// 判据 2：错误信息含关键词
const hasReason = /条数|少于.*3|3 条|task.*count/i.test(src)
if (!hasReason) problems.push('缺条数守卫的原因说明')

// 判据 3：exit(1)
const hasExit = /\bexit\s*\(\s*1\s*\)/.test(src)
if (!hasExit) problems.push('缺 process.exit(1) —— 守卫没有真正拒绝运行')

if (problems.length > 0) {
  console.log('FAIL  l3-0002：条数守卫不完整或有缺陷')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0002：条数守卫完整（tasks.length < 3 + exit(1)）')
process.exit(0)
