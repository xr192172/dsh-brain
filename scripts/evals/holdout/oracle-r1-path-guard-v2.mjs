#!/usr/bin/env node
/**
 * oracle-r1-path-guard-v2.mjs —— l3-0001 的判据：
 *   检查 scripts/eval-holdout-run.mjs 中 R1 路径守卫的实现强度。
 *
 * ★ 判据（全部必须满足，缺一不可）：
 *   1. 存在 holdoutAbs.startsWith(repoAbs 的调用（不是 includes/===）
 *   2. 调用中包含 path.sep（防止 /a/b 误匹配 /a/bc）
 *   3. 存在 console.error 输出包含 "R1" 或 "路径守卫" 或 "隔离"
 *   4. 存在 process.exit(1)（拒绝运行）
 *
 * 为什么是这些判据：
 *   - startsWith 而不 include：includes 可以用子串绕过（如 holdoutRoot=/repoX 命中 /repo）
 *   - + path.sep：防止 /repo/sub 被当成 /repo 的子路径（实际不是）
 *   - process.exit(1)：确认是"拒绝"不是"警告后继续"
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const RUNNER = path.join(ROOT, 'scripts/eval-holdout-run.mjs')

const src = fs.readFileSync(RUNNER, 'utf8')

const problems = []

// 判据 1：startsWith 检查
const hasStartsWith = /holdoutAbs\.startsWith\s*\(\s*repoAbs/.test(src)
if (!hasStartsWith) problems.push('缺 holdsoutAbs.startsWith(repoAbs) 调用 —— 路径守卫不存在')

// 判据 2：path.sep 隔离
const hasSep = /path\.sep/.test(src)
if (!hasSep) problems.push('缺 path.sep 分隔符 —— 存在 /a/b 误匹配 /a/bc 的风险')

// 判据 3：错误信息含 R1/隔离关键词
const hasReason = /R1|路径守卫|隔离|Agent够不到/.test(src)
if (!hasReason) problems.push('缺 R1/隔离原因说明 —— 错误信息不明确')

// 判据 4：exit(1) 拒绝
const hasExit = /\bexit\s*\(\s*1\s*\)/.test(src)
if (!hasExit) problems.push('缺 process.exit(1) —— 守卫没有真正拒绝运行')

if (problems.length > 0) {
  console.log('FAIL  l3-0001：R1 路径守卫不完整或有缺陷')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0001：R1 路径守卫完整（startsWith+path.sep+exit(1)+R1说明）')
process.exit(0)
