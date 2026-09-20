#!/usr/bin/env node
/**
 * drop-conveyor-from-profile.mjs —— 从 `profiles/web` 摘掉 `@dsh-brain/conveyor-context`
 *
 * ## 为什么（2026-09-20 用户口述）
 *
 * `conveyor-context` 是**用户自己做的**，用来**替换 DSH 自带的上下文管理**；后来**自研的那个被删了**
 * ⇒ 现在要用回**上游自带的**。而 `profiles/web` 仍引用已删的包 ⇒
 * `dsh --profile web --dump-config` 报 `cannot resolve profile bundle "@dsh-brain/conveyor-context"`
 * ⇒ **`profiles/web` 起不来 ⇒ 任何重启都会失败**（不只卡一条线，是全局）。
 *
 * ## 上游自带的上下文管理（本地实测，不必去外面找）
 *
 *   dsh-compaction · **dsh-compaction-basic**（★ 有我们 500 行补丁 = O3「兜底后端」）·
 *   dsh-compaction-tool-result-pruner · dsh-command-compact
 *   （外加 dsh-session-projection / -cache、dsh-session-query）
 * ⇒ **摘掉 conveyor 后这套仍在链上**（由 @deepseek-ai/dsh-web-app 带进来）。
 *
 * ## 安全
 *
 * · `~/.dsh/profiles/web` 是 **P2 安全层** ⇒ **先备份**（时间戳副本，与源同目录）；
 * · **只摘 package.json 里两处**（`dependencies` + `dsh.profile.bundles`）——
 *   `cordis.patch.yml` 实测**没有** conveyor 引用，不动；
 * · **默认干跑**；改完**立刻验证**（`--dump-config`：exit 0 / stderr 空 / 行数 / pet 0 / dup 0）。
 *
 * 用法：
 *   node scripts/drop-conveyor-from-profile.mjs           # 干跑
 *   node scripts/drop-conveyor-from-profile.mjs --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project_develop/dsh-brain'
/**
 * profile 名：`--profile <name>`，缺省 `web`。
 * （2026-09-20 追加：`candidate` profile 也引用了同一个已删包 ⇒ 它同样会装配失败，
 *   故本脚本泛化为可对任意 profile 执行。）
 */
const argProfile = (() => {
  const i = process.argv.indexOf('--profile')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'web'
})()
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', argProfile)
const MANIFEST = path.join(PROFILE, 'package.json')
const TARGET = '@dsh-brain/conveyor-context'
const APPLY = process.argv.includes('--apply')
/**
 * ⚠️ **不把行数当断言**。
 * 起初我写死 `EXPECT_LINES = 575`，来源是"靶场会话造的 `exp-base` 变体（web − conveyor）实测 575 行"——
 * **但那不是同一个 profile**（名字/路径/其它差异都会影响 dump）⇒ 直接照搬别人的数当基线是错的，
 * 实测改完 `web` 是 **565 行**。
 * ⇒ 判据只认**实质**：exit 0 / stderr 空 / pet 0 / dup 0 / conveyor 引用 0 处；
 *   **行数只打印、不断言**（基线要来自"同一个 profile 的未改版本"，不是别人的变体）。
 */

console.log(`profile: ${PROFILE}`)
console.log(`模式: ${APPLY ? '★ APPLY' : 'dry-run'}`)
console.log('')

const raw = fs.readFileSync(MANIFEST, 'utf8')
const J = JSON.parse(raw)

const inDeps = Object.prototype.hasOwnProperty.call(J.dependencies ?? {}, TARGET)
const inBundles = Array.isArray(J.dsh?.profile?.bundles) && J.dsh.profile.bundles.includes(TARGET)

console.log(`── ${TARGET}`)
console.log(`   在 dependencies: ${inDeps ? '是（' + J.dependencies[TARGET] + '）' : '否'}`)
console.log(`   在 bundles:      ${inBundles ? '是' : '否'}`)
console.log('')

if (!inDeps && !inBundles) {
  console.log('两处都不在 ⇒ 无需改动（幂等）。')
  process.exit(0)
}

if (!APPLY) {
  console.log('[dry-run] 将：① 从 dependencies 删掉该键；② 从 dsh.profile.bundles 删掉该项')
  console.log('          然后验证 --dump-config 的**实质判据**：exit 0 / stderr 空 / pet 0 / dup 0 /')
  console.log('          conveyor 引用 0 处 / compaction 在链上（行数只打印、不作断言）')
  console.log('确认后加 --apply。')
  process.exit(0)
}

// ① 备份（P2 安全层，必备份）
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const bak = path.join(PROFILE, `package.json.bak-${stamp}`)
fs.copyFileSync(MANIFEST, bak)
console.log(`① 已备份 → ${path.basename(bak)}`)

// ② 摘两处
if (inDeps) delete J.dependencies[TARGET]
if (inBundles) J.dsh.profile.bundles = J.dsh.profile.bundles.filter((b) => b !== TARGET)
// 保持原文件风格：JSON.stringify(_, null, 2) + 末尾换行（与原文件一致，diff 才干净）
fs.writeFileSync(MANIFEST, JSON.stringify(J, null, 2) + '\n', 'utf8')
console.log('② 已摘掉 dependencies + bundles 两处')

// ③ 立刻验证
console.log('③ 验证 --dump-config …')
let out = '', err = '', code = 0
try {
  out = execFileSync(process.execPath, ['node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--dump-config'], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout ?? '')
  err = String(e.stderr ?? '')
}
const lines = out.split('\n').filter((l) => l.length > 0).length
const pet = (out.match(/pet/g) ?? []).length
const dup = (out.match(/duplicate loader entry id/g) ?? []).length
const conveyorLeft = (out.match(/conveyor/g) ?? []).length
// ★ 上游上下文管理必须在链上（本地实测：dsh-compaction / -basic / -tool-result-pruner）
const compaction = (out.match(/compaction/g) ?? []).length

console.log(`   exit=${code}  stderr=${err.trim() ? '★非空' : '空 ✓'}  pet=${pet}  dup=${dup}`)
console.log(`   行数=${lines}（仅供参考，不作断言）  conveyor 残留=${conveyorLeft}  compaction 出现=${compaction}`)
const ok = code === 0 && !err.trim() && pet === 0 && dup === 0 && conveyorLeft === 0 && compaction > 0
console.log(ok ? '  ✓ 实质全部达标（错因消除 + 上游上下文管理在链上）' : '  ★ 未达标 —— 见上')
if (!ok && err.trim()) console.log('   stderr: ' + err.trim().split('\n').slice(0, 4).join('\n           '))
console.log('')
console.log(`校验失败：${code} / 隔离门：${dup} 个重复 id`)
console.log(`回退：把 ${path.basename(bak)} 拷回 package.json 即可。`)
process.exit(ok ? 0 : 1)
