#!/usr/bin/env node
/**
 * oracle-l3-holdout-hash.mjs —— L3 验收题 l3-0004：
 *   检查 scripts/capability-gate.mjs 里的 l3Holdout() 真的用了 SHA-256 对 holdout 文件算 hash。
 *
 * 判据：源码里必须出现以下**三项组合**（缺一不可）：
 *   1. crypto.createHash('sha256')        —— 真实哈希函数调用
 *   2. .update( fs.readFileSync(...) )    —— 对文件内容做 update
 *   3. holdoutTasksPath 或其等价引用     —— 读的是 holdout 任务集文件（不是写死的字符串）
 *
 * 为什么这三项是必要而非充分：只出现 (1) 和 (2) 但读的是硬编码字符串 = 恒真；
 * 只出现 (1) 但对写死字符串算 = 同上。三者结合才是"对真实 holdout 文件做真实哈希"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const GATE = path.join(ROOT, 'scripts/capability-gate.mjs')

const src = fs.readFileSync(GATE, 'utf8')

// 三项必须同时满足
const hasCryptoHash = /crypto\.createHash\s*\(\s*['"]sha256['"]\s*\)/.test(src)
const hasFileRead = /fs\.readFileSync\s*\(/.test(src)
const hasHoldoutRef = /holdoutTasksPath|holdoutPath|_HOLDOUT_TASKS/.test(src)

const problems = []
if (!hasCryptoHash) problems.push('源码缺 crypto.createHash(\'sha256\') 调用 —— 不是真实 SHA-256')
if (!hasFileRead) problems.push('源码缺 fs.readFileSync 调用 —— 没对文件内容做 update')
if (!hasHoldoutRef) problems.push('源码缺 holdout 文件路径引用 —— hash 可能对着硬编码字符串算')

if (problems.length > 0) {
  console.log('FAIL  l3-0004：l3Holdout 未用真实 SHA-256 对 holdout 任务集文件算 hash')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0004：l3Holdout 有 crypto.createHash(\'sha256\') + fs.readFileSync + holdout 引用')
process.exit(0)
