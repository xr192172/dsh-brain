// patch-profile-deps.mjs —— 修正 web profile manifest（幂等 + **后置校验**）
//
//  1) 移除悬空的 @dsh-brain/handover-agent 依赖（包已并入 @dsh-brain/switchboard）
//  2) 显式钉住 @deepseek-ai/dsh-base（原生工具来源，摆脱 hoist 隐式依赖）
//  3) 确保无 UTF-8 BOM（DSH readProfileManifest 的 JSON.parse 会因 BOM 崩溃 → gen 起不来）
//
// ★ 2026-09-15 两处硬化：
//   · **只在内容真的变化时才写** —— 旧版无条件 `writeFileSync`，
//     每次 `npm install` 都会重写 profile manifest 并刷新 mtime（无谓副作用）。
//   · **加后置校验**：旧版把自检结果 `BOM: PRESENT(bad)` **打印出来却不当回事**，
//     等于自己报了红还照样成功退出。现在任何一条不成立 ⇒ 非 0 退出
//     （`DSH_PATCH_STRICT=0` 可降级为仅告警）。
import fs from 'node:fs'
import path from 'node:path'
import { STRICT } from './patch-anchors.mjs'

const file = 'C:/Users/Admin/.dsh/profiles/web/package.json'
const BASE = '@deepseek-ai/dsh-base'
const DANGLING = '@dsh-brain/handover-agent'

if (!fs.existsSync(file)) {
  console.error(`✗ 找不到 profile manifest：${file}\n  （profile 未初始化？本脚本不该在此时运行）`)
  process.exit(1)
}

const raw = fs.readFileSync(file, 'utf8')
const hadBom = raw.charCodeAt(0) === 0xfeff
const j = JSON.parse(hadBom ? raw.slice(1) : raw)

const before = JSON.stringify(j, null, 2)

// ① 依赖：去悬空、钉住 dsh-base
j.dependencies = j.dependencies ?? {}
delete j.dependencies[DANGLING]
j.dependencies[BASE] = `link:C:/Users/Admin/.dsh/profiles/node_modules/${BASE}`

// ② bundles：确保 dsh-base 在（原生工具 bundle）
j.dsh = j.dsh ?? {}
j.dsh.profile = j.dsh.profile ?? {}
const bundles = j.dsh.profile.bundles ?? []
if (!bundles.includes(BASE)) j.dsh.profile.bundles = [BASE, ...bundles]

const after = JSON.stringify(j, null, 2)
const body = after + '\n'
const changed = hadBom || body !== raw

if (changed) fs.writeFileSync(file, body, 'utf8') // 无 BOM

// ── 后置校验：任何一条不成立都必须报出来，不能只打印 ──────────────────────────
const problems = []
const finalRaw = fs.readFileSync(file, 'utf8')
const final = JSON.parse(finalRaw)
if (finalRaw.charCodeAt(0) === 0xfeff) problems.push('仍带 UTF-8 BOM（会让 DSH 读 profile 时崩）')
if (DANGLING in (final.dependencies ?? {})) problems.push(`悬空依赖仍在：${DANGLING}`)
if (final.dependencies?.[BASE] !== `link:C:/Users/Admin/.dsh/profiles/node_modules/${BASE}`) {
  problems.push(`${BASE} 的链接依赖未就位`)
}
if (!(final.dsh?.profile?.bundles ?? []).includes(BASE)) problems.push(`bundles 里没有 ${BASE}`)

console.log(`[patch-profile-deps] ${path.basename(file)}  ${changed ? '已写入' : '无变化（跳过写）'}`)
console.log(`  deps    : ${Object.keys(final.dependencies ?? {}).join(', ')}`)
console.log(`  bundles : ${(final.dsh?.profile?.bundles ?? []).join(', ')}`)
console.log(`  BOM     : ${finalRaw.charCodeAt(0) === 0xfeff ? 'PRESENT(bad)' : 'none(ok)'}`)

if (problems.length) {
  const msg = `[patch-profile-deps] ✗ 后置校验未过：\n` + problems.map((p) => `    · ${p}`).join('\n')
  if (STRICT) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(msg + '\n    （DSH_PATCH_STRICT=0：仅告警）')
} else {
  console.log('[patch-profile-deps] ✓ 后置校验通过')
}
