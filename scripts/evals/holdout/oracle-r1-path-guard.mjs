#!/usr/bin/env node
/**
 * oracle-r1-path-guard.mjs —— L3 验收题 l3-0002：
 *   检查 eval-holdout-run.mjs 里有路径守卫：holdout 根落在被测仓库树内 ⇒ 直接 exit 1。
 *
 * 判据：源码里必须出现"holdoutRoot 与 wt 比较"的逻辑，exit code 为 1，且原因说明含 "R1"。
 *   ★ 如果这段被删掉（种子编辑），exit 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const RUNNER = path.join(ROOT, 'scripts/eval-holdout-run.mjs')

const src = fs.readFileSync(RUNNER, 'utf8')

// 路径守卫的三个要素：
// 1. 对 holdoutRoot 与 wt 的关系做判断（startsWith 之类）
// 2. 退出码是 1（拒绝运行）
// 3. 原因说明提到 "R1" 或 "隔离"
const hasGuardCheck = /holdoutRoot.*startsWith.*wt|wt.*startsWith.*holdoutRoot|hostDir/.test(src)
const hasExitOne = /\bexit\s*\(\s*1\s*\)/.test(src)
const hasR1Reason = /R1|隔离|Agent够不到/.test(src)

const problems = []
if (!hasGuardCheck) problems.push('源码缺 holdoutRoot 与 wt 的比较逻辑')
if (!hasExitOne) problems.push('源码缺 exit(1) 拒绝运行')
if (!hasR1Reason) problems.push('源码缺 R1/隔离原因说明')

if (problems.length > 0) {
  console.log('FAIL  l3-0002：eval-holdout-run.mjs 路径守卫不完整')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0002：eval-holdout-run.mjs 有 R1 路径守卫（holdout 根不在 wt 内才允许运行）')
process.exit(0)
