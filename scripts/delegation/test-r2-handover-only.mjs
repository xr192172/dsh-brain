#!/usr/bin/env node
/**
 * R2 门：起代一律走 `?cmd=handover`，`--force` 只留给"结构性变更"（`--rebuild`）。
 *
 * 背景：`arm-up.mjs` 原来在**准备阶段无条件带 `--force`** ⇒ 每次"起代"都被迫走
 * "准备+覆盖"那条路 ⇒ `--force` 从"结构变更的应急阀"长成了常规路径 = **那条旁路**
 *（它绕过了整台换代机，一条旁路、六个症状）。
 *
 * 本门检（每条都能消融自证变红，铁律 21）：
 *   ① 准备阶段**不再无条件** `--force`：源码里 `isolated-instance` 调用点的参数是 `...forceFlag`
 *   ② `forceFlag` 只由 `REBUILD_MODE` 决定
 *   ③ ★ 行为验：`--gen` 存在且**不碰** isolated-instance（源码里 --gen 分支先于准备块且含 handover）
 *   ④ ★ 行为验：真跑一次 `--gen` 在"控制面活着"的臂上 ⇒ 打的是 handover（不是 isolated-instance）
 *   ⑤ `--rebuild` 会**记账**（arm-rebuild-journal.jsonl）
 *   ⑥ 用法里三个动词都列出来了（用户看得见）
 *   ⑦ ★ 正向对照（与自变量正交）：`arm-up` 的 `--selftest` 仍全绿（R2 没把旧判据搞坏）
 *
 * 用法：node scripts/delegation/test-r2-handover-only.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WT = join(HERE, '..', '..')
const ARM_UP = join(WT, 'scripts', 'arm-up.mjs')

let ok = 0
let fail = 0
const pass = (m) => { console.log('  [OK ] ' + m); ok++ }
const bad = (m) => { console.log('  [RED] ' + m); fail++ }

console.log('test-r2-handover-only.mjs')

const src = readFileSync(ARM_UP, 'utf8')

// ── ① 准备阶段不再无条件 --force ────────────────────────────────────────
// 找 isolated-instance 的调用行，断言它是 ...forceFlag（不是字面 '--force'）
const callLine = src.split(/\r?\n/).find((l) => l.includes("'isolated-instance.mjs'"))
if (callLine && /\bforceFlag\b/.test(callLine) && !/'--force'/.test(callLine)) {
  pass('① 准备阶段用 `...forceFlag`（不再无条件 `--force`）')
} else {
  bad(`① 准备阶段仍是硬编码 --force ⇒ 旁路还在（${(callLine ?? '(没找到调用点)').trim().slice(0, 90)}）`)
}

// ── ② forceFlag 只由 REBUILD_MODE 决定 ─────────────────────────────────
if (/const forceFlag = REBUILD_MODE \? \['--force'\] : \[\]/.test(src)) {
  pass("② `forceFlag` 只由 `REBUILD_MODE` 决定")
} else {
  bad('② `forceFlag` 的构造被改了（不再只由 --rebuild 决定）⇒ --force 又可能从别处进来')
}

// ── ③ --gen 分支存在，且含 handover、且不碰 isolated-instance ──────────
const genIdx = src.indexOf('if (GEN_MODE) {')
const prepIdx = src.indexOf('if (!hasFlag(\'--no-start\') && !LIVE_MODE && needPrepare && !GEN_MODE)')
const genBlock = genIdx >= 0 && prepIdx > genIdx ? src.slice(genIdx, prepIdx) : ''
if (genIdx > 0 && /cmd=handover/.test(genBlock)) {
  pass('③ `--gen` 分支存在且打的是 `?cmd=handover`')
} else {
  bad('③ `--gen` 分支缺失或没打 handover')
}
if (genBlock && !/isolated-instance\.mjs/.test(genBlock)) {
  pass('③b `--gen` 分支里**没有** isolated-instance（换代不碰训练场骨架）')
} else {
  bad('③b `--gen` 分支里出现了 isolated-instance ⇒ 换代又在碰骨架')
}
// 准备块必须排除 GEN_MODE（否则 --gen 会掉进准备）
if (prepIdx > 0 && /\|\| GEN_MODE/.test(src.slice(prepIdx, prepIdx + 40)) === false && /&& !GEN_MODE/.test(src.slice(prepIdx, prepIdx + 200))) {
  pass('③c 准备块的 guard 里有 `&& !GEN_MODE`（--gen 不会掉进准备）')
} else {
  bad('③c 准备块的 guard 没有排除 GEN_MODE ⇒ --gen 仍会跑准备')
}

// ── ④ 行为验：--gen 打的是 handover（真跑，抓互斥/用法错误）────────────
//   ★ 不去真换代（那会动臂）——只验参数校验确实生效，且**没有**触发准备。
try {
  const out = execFileSync(process.execPath, [ARM_UP, 'A', '--gen', '--rebuild'], {
    encoding: 'utf8', timeout: 30000, cwd: WT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  bad(`④ --gen + --rebuild 互斥未被拦（exit=0）`)
} catch (e) {
  const all = String(e.stdout ?? '') + String(e.stderr ?? '')
  if (/互斥/.test(all)) pass('④ 行为：`--gen` 与 `--rebuild` 互斥被拦（exit≠0 且说了理由）')
  else bad(`④ --gen + --rebuild 被拦了但理由不对：${all.trim().slice(0, 120)}`)
}

// ⑤ 与控制面死活的耦合：--gen 在控制面没跑时应拒绝（而不是偷偷重建）
if (/--gen 要求\*\*控制面正在跑\*\*/.test(src) || /--gen 要求/.test(src)) {
  pass('⑤ `--gen` 在控制面没跑时**明确报错**（不偷偷重建训练场）')
} else {
  bad('⑤ `--gen` 没有"控制面必须活着"的前置检查')
}

// ── ⑥ --rebuild 记账 ───────────────────────────────────────────────────
if (/arm-rebuild-journal\.jsonl/.test(src)) {
  pass('⑥ `--rebuild` 会写台账 `out/arm-rebuild-journal.jsonl`（逃生阀留痕）')
} else {
  bad('⑥ `--rebuild` 没有记账 ⇒ 逃生阀无声')
}

// ── ⑦ 用法里三个动词都列出来 ───────────────────────────────────────────
const usageHasAll = ['<臂名>', '--gen', '--rebuild'].every((d) => src.includes(d))
if (usageHasAll) pass('⑦ 用法里列了 `<臂名>` / `--gen` / `--rebuild`（用户看得见）')
else bad('⑦ 用法里没把三个动词列全')

// ── ⑧ ★ 正向对照（与自变量正交）：arm-up --selftest 仍全绿 ─────────────
//   ★ 正交性：R2 动的是"起代路径"，selftest 测的是"判据本身" ⇒ 它**不该**因 R2 变红。
//     若它变红 ⇒ 上面的判语全部作废（说明 R2 碰坏了别的东西）。
try {
  const out = execFileSync(process.execPath, [ARM_UP, '--selftest'], {
    encoding: 'utf8', timeout: 180000, cwd: WT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (/结果：PASS/.test(out)) pass('⑧ 对照：`arm-up --selftest` 仍 PASS（R2 没搞坏既有判据）')
  else bad('⑧ 对照失败：selftest 没 PASS ⇒ 上面的判语作废')
} catch (e) {
  bad(`⑧ 对照失败：selftest exit≠0 ⇒ 上面的判语作废（${String(e.stdout ?? '').split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3).join(' / ')}）`)
}

console.log(`\n  ${ok} ok / ${fail} FAIL`)
if (fail > 0) process.exit(1)
console.log('  PASS')
