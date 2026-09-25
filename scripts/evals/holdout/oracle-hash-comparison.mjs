#!/usr/bin/env node
/**
 * oracle-hash-comparison.mjs —— l3-0002 的判据：
 *   检查 l3Holdout 里是否有真实的 SHA-256 hash 比较逻辑。
 *
 * ★ 判据（全部满足才算真比较）：
 *   1. crypto.createHash('sha256') 出现在 l3Holdout 函数体内
 *   2. .update(fs.readFileSync(...)) 出现在函数体内（真读文件）
 *   3. cap.holdoutHash 引用出现（跟记录值比较）
 *   4. 没有 'always_matches' 或类似硬编码绕过字符串
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const GATE = path.join(ROOT, 'scripts', 'capability-gate.mjs')

const src = fs.readFileSync(GATE, 'utf8')

// 提取 l3Holdout 函数体（从 function l3Holdout(cap) { 到匹配的 }）
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
  console.log('FAIL  l3-0002：找不到 l3Holdout 函数')
  process.exit(1)
}
const l3Body = src.slice(funcStart, funcEnd)

const problems = []

// 判据 1：crypto.createHash('sha256') 在函数体内
const hasCryptoHash = /crypto\.createHash\s*\(\s*['"]sha256['"]\s*\)/.test(l3Body)
if (!hasCryptoHash) problems.push('l3Holdout 内缺 crypto.createHash(\'sha256\') 调用')

// 判据 2：.update(fs.readFileSync(...)) 在函数体内
const hasFileUpdate = /\.update\s*\(\s*fs\.readFileSync\s*\(/.test(l3Body)
if (!hasFileUpdate) problems.push('l3Holdout 内缺 .update(fs.readFileSync(...)) 调用（没真读文件）')

// 判据 3：cap.holdoutHash 引用
const hasHoldoutHashRef = /cap\.holdoutHash/.test(l3Body)
if (!hasHoldoutHashRef) problems.push('l3Holdout 内缺 cap.holdoutHash 引用（没跟记录值比较）')

// 判据 4：没有绕过字符串
const hasBypass = /always_matches|hardcoded_hash|FAKE_HASH|dummy_hash/.test(l3Body)
if (hasBypass) problems.push('l3Holdout 内有绕过字符串（hash 比较被伪造）')

if (problems.length > 0) {
  console.log('FAIL  l3-0002：hash 比较不完整或有绕过')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0002：hash 比较完整（crypto+readFileSync+cap.holdoutHash，无绕过）')
process.exit(0)
