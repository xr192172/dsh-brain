#!/usr/bin/env node
/**
 * oracle-prooflevel-stays-l1.mjs —— L3 验收题 l3-0001：
 *   proofLevel 在 L2 未实施时必须停在 'L1'（绝不在 L2 跳过时跳到 L3）。
 *
 * 判据：registry 里任何一个 active 能力的 acceptance.proofLevel == 'L1'（且 unenforced 含 'L3'）。
 *   ★ 如果 proofLevel 被改成 'L3'（假绿），exit 1。
 *   ★ 如果 acceptance 缺失或 proofLevel 为 null，exit 1（fail-closed）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const HOME = process.env.DSH_HOME ?? path.join(ROOT, 'out', '_l3tmp')
const REGISTRY = path.join(HOME, 'capabilities', 'registry.json')

const raw = fs.readFileSync(REGISTRY, 'utf8')
const db = JSON.parse(raw)

const problems = []
const activeCaps = db.capabilities?.filter((c) => c.status === 'active') ?? []

if (activeCaps.length === 0) {
  // 没 active 能力时看 pending 的 acceptance 字段
  const pendingCaps = db.capabilities?.filter((c) => c.status === 'pending') ?? []
  for (const cap of pendingCaps) {
    const acc = cap.acceptance
    if (!acc) {
      problems.push(`${cap.id}: 无 acceptance 回执`)
      continue
    }
    if (acc.proofLevel === 'L3') {
      problems.push(`${cap.id}: proofLevel='L3'（L2 未实施，不许跳到 L3 = 假绿）`)
    } else if (acc.proofLevel !== 'L1') {
      problems.push(`${cap.id}: proofLevel='${acc.proofLevel}'（期望 'L1'）`)
    }
    if (acc.unenforced) {
      const hasL3 = acc.unenforced.includes('L3')
      if (hasL3) problems.push(`${cap.id}: unenforced 仍含 'L3'（L3 应已实施并从 unenforced 移除）`)
    }
  }
} else {
  for (const cap of activeCaps) {
    const acc = cap.acceptance
    if (!acc) {
      problems.push(`${cap.id}: active 但无 acceptance 回执`)
      continue
    }
    if (acc.proofLevel === 'L3') {
      problems.push(`${cap.id}: proofLevel='L3'（L2 未实施，不许跳到 L3 = 假绿）`)
    } else if (acc.proofLevel !== 'L1') {
      problems.push(`${cap.id}: proofLevel='${acc.proofLevel}'（期望 'L1'）`)
    }
    // unenforced 不含 L3 才是对的（L3 已实施）
    if (acc.unenforced?.includes('L3')) {
      problems.push(`${cap.id}: unenforced 仍含 'L3'（L3 应已从 unenforced 移除）`)
    }
  }
}

if (problems.length > 0) {
  console.log('FAIL  l3-0001：proofLevel 不在 L1')
  for (const p of problems) console.log(`  · ${p}`)
  process.exit(1)
}

console.log('PASS  l3-0001：proofLevel 停在 L1（L2 未实施，L3 通过不计入 proofLevel）')
process.exit(0)
