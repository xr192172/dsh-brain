#!/usr/bin/env node
/**
 * oracle-fail-closed.mjs —— l3-0003 的判据：
 *   检查 l3Holdout 里有 fail-closed 逻辑：读不到结果文件时直接 return（blocked）。
 *
 * ★ 判据：
 *   1. l3Holdout 函数体内有 "读不到结果文件" 描述
 *   2. 紧接着有 return { checks ... }（不是注释掉的）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const GATE = path.join(ROOT, 'scripts', 'capability-gate.mjs')

const src = fs.readFileSync(GATE, 'utf8')

// 提取 l3Holdout 函数体
let braceCount = 0
let inFunc = false
let funcStart = -1
let funcEnd = -1
for (let i = 0; i < src.length; i++) {
  if (!inFunc && src.slice(i).startsWith('function l3Holdout(cap)')) {
    inFunc = true
    funcStart = i
    braceCount = 0
  }
  if (inFunc) {
    if (src[i] === '{') braceCount++
    else if (src[i] === '}') {
      braceCount--
      if (braceCount === 0) {
        funcEnd = i + 1
        break
      }
    }
  }
}
if (funcStart === -1) {
  console.log('FAIL  l3-0003：找不到 l3Holdout 函数')
  process.exit(1)
}
const l3Body = src.slice(funcStart, funcEnd)

// 找"读不到结果文件"后的 return 语句（不能是注释掉的）
// 用多行匹配：从 "读不到结果文件" 开始，到下一个非注释的 return { checks
const nonCommentReturn = /读不到结果文件[\s\S]{0,300}?\/\/.*\n[\s\S]{0,300}?return\s*\{\s*checks/.test(l3Body)
const hasActiveReturn = /读不到结果文件[\s\S]{0,300}?return\s*\{\s*checks/.test(l3Body)
const hasCommentedOut = /return\s*\{\s*checks/.test(l3Body) && /\/\/.*return\s*\{\s*checks/.test(l3Body)

const problems = []
if (!hasActiveReturn) problems.push('l3Holdout 内缺 fail-closed return 语句（读不到结果应直接 blocked）')
if (hasCommentedOut && !hasActiveReturn) problems.push('l3Holdout 内 return 被注释掉（fail-closed 被破坏）')

if (problems.length > 0) {
  console.log('FAIL  l3-0003：fail-closed 逻辑缺失或被注释')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0003：fail-closed 完整（读不到结果文件时直接 return blocked）')
process.exit(0)
