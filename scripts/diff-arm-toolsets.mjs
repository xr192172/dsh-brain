#!/usr/bin/env node
/**
 * diff-arm-toolsets.mjs —— 比较两个（或多个）`arm-probe` 证据 JSON 的工具面差异。
 *
 * 为什么要有它：`arm-probe` 只报**家族计数**，而"计数差 5 个"不等于"我知道少了哪 5 个"。
 * 关掉一个能力后**多**少了东西（甚至少了不该少的），必须逐名看 —— 那是判"这个旋钮
 * 到底动了什么"的唯一办法。
 *
 * 用法：node scripts/diff-arm-toolsets.mjs <a.json> <b.json> [more.json …]
 *       （第一个是基准；后面每个都与它比）
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'D:/project_develop/dsh-brain'
const files = process.argv.slice(2)
if (files.length < 2) {
  console.error('用法: node scripts/diff-arm-toolsets.mjs <base.json> <b.json> [c.json …]')
  process.exit(1)
}
const load = (f) => {
  const p = path.isAbsolute(f) ? f : path.join(REPO, f)
  if (!fs.existsSync(p)) throw new Error('不存在: ' + p)
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  // 取**最后一次**采样的工具面（此时最可能已经稳；也比"第一次"更保守）
  const last = (j.samplesList ?? []).filter((s) => Array.isArray(s.toolSet)).pop()
  const first = (j.samplesList ?? []).filter((s) => Array.isArray(s.toolSet))[0]
  return { file: path.basename(p), label: j.label, tag: j.tag, set: new Set(last?.toolSet ?? []), firstSet: new Set(first?.toolSet ?? []), sizes: j.samplesList?.map((s) => s.toolSetSize ?? 0) ?? [] }
}
const arms = files.map(load)
const base = arms[0]
console.log(`基准: ${base.label ?? base.tag}  (${base.file})  工具面 ${base.set.size} 个  采样 ${JSON.stringify(base.sizes)}`)
for (const a of arms.slice(1)) {
  const missing = [...base.set].filter((t) => !a.set.has(t)).sort()
  const added = [...a.set].filter((t) => !base.set.has(t)).sort()
  console.log(`\n=== ${base.label ?? base.tag}  →  ${a.label ?? a.tag}  (${a.file}) ===`)
  console.log(`  工具面 ${base.set.size} → ${a.set.size}   采样 ${JSON.stringify(a.sizes)}`)
  console.log(`  ★ 少了 ${missing.length} 个:`)
  for (const t of missing) console.log(`      - ${t}`)
  console.log(`  ★ 多了 ${added.length} 个:`)
  for (const t of added) console.log(`      + ${t}`)
  // 该臂内首末采样是否一致（防"迟到挂载"被当成稳定）
  const inner = [...a.firstSet].filter((t) => !a.set.has(t))
  const inner2 = [...a.set].filter((t) => !a.firstSet.has(t))
  console.log(
    `  该臂内 首↔末 采样差异: ${inner.length + inner2.length === 0 ? '无（首末一致）' : `有 少${inner.length}/多${inner2.length}`}`,
  )
}
