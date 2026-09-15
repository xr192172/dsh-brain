// patch-profile-deps.mjs —— 修正 web profile manifest（幂等 + **后置校验** + **先备份**）
//
//  1) 移除悬空的 @dsh-brain/handover-agent 依赖（包已并入 @dsh-brain/switchboard）
//  2) 显式钉住 @deepseek-ai/dsh-base（原生工具来源，摆脱 hoist 隐式依赖）
//  3) 确保无 UTF-8 BOM（DSH readProfileManifest 的 JSON.parse 会因 BOM 崩溃 → gen 起不来）
//  4) ★ 2026-09-15：**把每个 @dsh-brain/* bundle 都声明进 dependencies**
//     —— 由卫生门 `scripts/check-plugin-hygiene.mjs` 抓出：有 4 个 bundle 只在
//     `dsh.profile.bundles` 里、没进 `dependencies`，于是它们**只靠
//     `profiles/web/node_modules/@dsh-brain/*` 的符号链接解析**。
//     而 profile 的 `pnpm-lock.yaml` 只认得已声明的包 ⇒
//     **跑一次 `pnpm install` 就会把它们剪掉，那几个 bundle 静默失效。**
//     （与我们在 boot 层、配置层修过的"静默失效"是同一类失败，只是换了层。）
//
//     ⚠️ 边界：只处理 `@dsh-brain/*`（**我们自己的**包）。`@deepseek-ai/*` 从
//     `profiles/node_modules/` 那棵**上游共享树**解析，不归这里管。
//
// ★ 三处硬化（2026-09-15）：
//   · **只在内容真的变化时才写** —— 旧版无条件 `writeFileSync`，每次 `npm install`
//     都会重写 profile manifest 并刷新 mtime（无谓副作用）。
//   · **写之前先备份** —— 这个文件在 `~/.dsh/` 下、**不在 git 里**，
//     改坏了没有版本历史可回滚。
//   · **后置校验**：旧版把自检 `BOM: PRESENT(bad)` 打印出来却不当回事，
//     等于自己报了红还照样成功退出。任何一条不成立 ⇒ 非 0 退出
//     （`DSH_PATCH_STRICT=0` 可降级为仅告警）。
import fs from 'node:fs'
import path from 'node:path'
import { STRICT } from './patch-anchors.mjs'

const file = 'C:/Users/Admin/.dsh/profiles/web/package.json'
const HOME_DIR = 'C:/Users/Admin/.dsh'
const BACKUP_DIR = `${HOME_DIR}/.backup`
const BASE = '@deepseek-ai/dsh-base'
const DANGLING = '@dsh-brain/handover-agent'
const OWN_SCOPE = '@dsh-brain/'
const REPO_PKGS = 'D:/project_develop/dsh-brain/packages'

if (!fs.existsSync(file)) {
  console.error(`✗ 找不到 profile manifest：${file}\n  （profile 未初始化？本脚本不该在此时运行）`)
  process.exit(1)
}

const raw = fs.readFileSync(file, 'utf8')
const hadBom = raw.charCodeAt(0) === 0xfeff
const j = JSON.parse(hadBom ? raw.slice(1) : raw)

// ── ① 依赖：去悬空、钉住 dsh-base、补齐我方 bundle 的声明 ────────────────────
j.dependencies = j.dependencies ?? {}
delete j.dependencies[DANGLING]
j.dependencies[BASE] = `link:C:/Users/Admin/.dsh/profiles/node_modules/${BASE}`

const bundles = j.dsh?.profile?.bundles ?? []
/** 我方每个 bundle 应当声明的 `link:` 依赖（包目录不存在的**不编造**）。 */
const ownDeps = {}
for (const b of bundles) {
  if (typeof b !== 'string' || !b.startsWith(OWN_SCOPE)) continue
  const abs = `${REPO_PKGS}/${b.slice(OWN_SCOPE.length)}`
  if (fs.existsSync(abs)) ownDeps[b] = `link:${abs}`
}
for (const [k, v] of Object.entries(ownDeps)) j.dependencies[k] = v

// ── ② bundles：确保 dsh-base 在（原生工具 bundle）────────────────────────────
j.dsh = j.dsh ?? {}
j.dsh.profile = j.dsh.profile ?? {}
if (!(j.dsh.profile.bundles ?? []).includes(BASE)) j.dsh.profile.bundles = [BASE, ...bundles]

const after = JSON.stringify(j, null, 2)
const body = after + '\n'
const changed = hadBom || body !== raw

if (changed) {
  // 先备份：该文件不在 git 里，改坏了没有历史可回滚
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = path.join(BACKUP_DIR, `profile-web-package.json.${stamp}.bak`)
  fs.writeFileSync(bak, raw, 'utf8')
  fs.writeFileSync(file, body, 'utf8')
  console.log(`[patch-profile-deps] 已写入（旧版已备份到 .backup/${path.basename(bak)}）`)
} else {
  console.log('[patch-profile-deps] 无变化（跳过写）')
}

// ── 后置校验：任何一条不成立都必须报出来，不能只打印 ──────────────────────────
const problems = []
const finalRaw = fs.readFileSync(file, 'utf8')
const final = JSON.parse(finalRaw)
const fdeps = final.dependencies ?? {}
const fbundles = final.dsh?.profile?.bundles ?? []
if (finalRaw.charCodeAt(0) === 0xfeff) problems.push('仍带 UTF-8 BOM（会让 DSH 读 profile 时崩）')
if (DANGLING in fdeps) problems.push(`悬空依赖仍在：${DANGLING}`)
if (fdeps[BASE] !== `link:C:/Users/Admin/.dsh/profiles/node_modules/${BASE}`) problems.push(`${BASE} 的链接依赖未就位`)
if (!fbundles.includes(BASE)) problems.push(`bundles 里没有 ${BASE}`)
for (const [k, v] of Object.entries(ownDeps)) {
  if (fdeps[k] !== v) problems.push(`我方 bundle 未声明依赖：${k}（期望 ${v}，实得 ${JSON.stringify(fdeps[k])}）`)
}

const ownTotal = fbundles.filter((b) => String(b).startsWith(OWN_SCOPE)).length
console.log(`[patch-profile-deps] ${path.basename(file)}`)
console.log(`  deps    : ${Object.keys(fdeps).join(', ')}`)
console.log(`  bundles : ${fbundles.join(', ')}`)
console.log(`  BOM     : ${finalRaw.charCodeAt(0) === 0xfeff ? 'PRESENT(bad)' : 'none(ok)'}`)
console.log(`  我方 bundle 声明: ${Object.keys(ownDeps).length}/${ownTotal} 已声明`)
console.log(`  ⚠️ pnpm-lock.yaml 尚未同步（新增声明后它与 package.json 不再一致）：`)
console.log(`     普通 pnpm install 会同步它；--frozen-lockfile 会**明确报错**（响亮 >> 静默）。`)

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
