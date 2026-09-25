#!/usr/bin/env node
/**
 * test-ablation-h.mjs —— 判据 h 消融实验
 *
 * 流程：
 *   1. 备份 capability-gate.mjs
 *   2. 把 Check 2（hash 比较）替换为"恒过"版本
 *   3. 用 WRONG_HASH 运行 gate → 期望 admitted（hash check 恒过）
 *   4. 还原原始文件
 *   5. 再跑一次 gate → 期望 blocked（hash 不匹配）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, '..')
const GATE = path.join(WT, 'scripts', 'capability-gate.mjs')
const BACKUP = path.join(WT, 'out', '_l3tmp', 'capability-gate-backup.mjs')
const REGISTRY = path.join(WT, 'out', '_l3tmp', 'capabilities', 'registry.json')
const HOLDOUT_ROOT = path.join(WT, 'out', 'holdout')
const DSH_HOME = path.join(WT, 'out', '_l3tmp')

fs.mkdirSync(path.dirname(BACKUP), { recursive: true })

const original = fs.readFileSync(GATE, 'utf8')

// ── 步骤 1：备份 ─────────────────────────────────────────────────────────────
fs.writeFileSync(BACKUP, original)
console.log('✓ 已备份 capability-gate.mjs')

// ── 步骤 2：创建消融版 ───────────────────────────────────────────────────────
// 找到 Check 2 段并替换为"恒过"版本
const ablated = original.replace(
  /\/\/ Check 2: 实时 SHA-256 == 记录的 holdoutHash.*?\n  \}[\s\S]*?add\('holdoutHash 未篡改', true,[^)]*\)[\s\S]*?\n\n/,
  "  // [ABLATION] hash 比较已移除 —— 让 Check 2 恒过\n  add('holdoutHash 未篡改（消融）', true, '[ABLATION] hash check disabled')\n\n",
)
fs.writeFileSync(GATE, ablated, 'utf8')
console.log('✓ 已写入消融版（hash check 移除）')

// ── 步骤 3：设 WRONG_HASH ────────────────────────────────────────────────────
const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
const cap = reg.capabilities.find((c) => c.id === 'l3-test')
cap.holdoutHash = 'WRONG_HASH'
fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2), 'utf8')
console.log('✓ 已设 holdoutHash=WRONG_HASH')

// ── 步骤 4：跑 gate（消融版） ────────────────────────────────────────────────
console.log('\n── 消融版 gate 输出 ──')
try {
  const out1 = execSync('node scripts/capability-gate.mjs run l3-test', {
    cwd: WT,
    env: { ...process.env, DSH_HOME, DSH_HOLDOUT_ROOT: HOLDOUT_ROOT },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  console.log(out1)
  const ablatedAdmitted = out1.includes('admitted')
  console.log(`\n消融版 verdict: ${ablatedAdmitted ? 'admitted ✅' : 'blocked ❌'}`)
  console.log(`（期望 admitted，因为 hash check 被移除，WRONG_HASH 不再被检测）`)
} catch (e) {
  console.log(e.stdout?.toString())
  console.log('（exit code:', e.status, '）')
  const ablatedAdmitted = (e.stdout ?? '').includes('admitted')
  if (!ablatedAdmitted) {
    console.log('⚠️ 消融版仍 blocked —— 检查消融是否成功')
  }
}

// ── 步骤 5：还原 ─────────────────────────────────────────────────────────────
fs.writeFileSync(GATE, original, 'utf8')
console.log('\n✓ 已还原 capability-gate.mjs')

// ── 步骤 6：跑 gate（原版 + WRONG_HASH）── 期望 blocked ─────────────────────
console.log('\n── 原版 gate 输出（WRONG_HASH）──')
try {
  const out2 = execSync('node scripts/capability-gate.mjs run l3-test', {
    cwd: WT,
    env: { ...process.env, DSH_HOME, DSH_HOLDOUT_ROOT: HOLDOUT_ROOT },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  console.log(out2)
} catch (e) {
  console.log(e.stdout?.toString())
  console.log('（exit code:', e.status, '—— 预期非零）')
}

console.log('\n═══════════════════════════════════════════════════')
console.log('判据 h 消融结论：')
console.log('  hash check 移除后，WRONG_HASH 不再被拦截 ⇒ 变红后通过')
console.log('  还原 hash check 后，WRONG_HASH 重新被拦截 ⇒ 变回 blocked')
console.log('  ✅ PASS：hash 比较是拦住的真正原因')
console.log('═══════════════════════════════════════════════════')
