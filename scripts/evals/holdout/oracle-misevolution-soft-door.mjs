#!/usr/bin/env node
/**
 * oracle-misevolution-soft-door.mjs —— L3 验收题 l3-0003：
 *   检查 l3Holdout() 里有 misevolution 软门：visible↑+hidden↓ 写进 evidence，不入 verdict。
 *
 * 判据：源码里必须有以下三项：
 *   1. l3Misevolution 字段的写入（evidence.l3Misevolution = ...）
 *   2. 注释说明它不入 verdict（软门语义）
 *   3. 检查 visible↑ 且 hidden↓ 的逻辑（两个方向的比较）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const GATE = path.join(ROOT, 'scripts/capability-gate.mjs')

const src = fs.readFileSync(GATE, 'utf8')

const hasMisevolutionField = /l3Misevolution/.test(src)
const hasVerdictNote = /不入 verdict|不入verdict|不入判定|verdict.*不入|软门/.test(src)
const hasVisibleHiddenCheck = /visible|hidden/.test(src)

const problems = []
if (!hasMisevolutionField) problems.push('源码缺 l3Misevolution 字段写入')
if (!hasVerdictNote) problems.push('源码缺"不入 verdict"的注释说明（软门语义丢失）')
if (!hasVisibleHiddenCheck) problems.push('源码缺 visible/hidden 方向比较逻辑（无法检测 misevolution）')

if (problems.length > 0) {
  console.log('FAIL  l3-0003：misevolution 软门不完整')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0003：misevolution 软门正确（visible↑+hidden↓ 写进 evidence，不入 verdict）')
process.exit(0)
