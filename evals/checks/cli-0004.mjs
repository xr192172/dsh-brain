#!/usr/bin/env node
/**
 * evals/checks/cli-0004.mjs —— cli-0004 的 oracle（**真跑，不读源码**）
 *
 * ## 题目
 *
 * 让 `scripts/verify-drain-after-swap.mjs` 支持 `--json`：
 *   ① `--json` 时 **stdout 只输出一个 JSON 对象**（诊断走 stderr）
 *   ② 对象里**每条判据一个键**，值为 `{ status: 'ok'|'warn'|'fail', detail: '<一句话>' }`
 *   ③ 另含 `{ ok: <bool>, fails: <number> }` 汇总
 *   ④ **不带 `--json` 时的输出与退出码必须一字不变**
 *   ⑤ 退出码语义不变（0=通过 / 1=换代了没生效 / 2=还没到能验收）
 *
 * ## 为什么这题**没有 git 捷径**（写题时就核对过）
 *
 * `grep -c -- '--json' scripts/verify-drain-after-swap.mjs` ⇒ **0**
 * ⇒ 该能力在 HEAD 里**本来就不存在** ⇒ `git checkout` 救不了（与前 3 题"反向打回一行"不同）
 * ⇒ 所以本题的 `seed.edits` 为**空**，`eval-validate` 走 `isEmptySeed` 分支：
 *   判据换成「**在 HEAD 上跑本 oracle 必须红**」。
 *
 * ## ★★ 判据全集必须**从真代码核过**，不能照抄设计草案
 *
 * 草案写的是 `R0a…R9b`，但核对真文件后实为**15 个**：
 *   `R0a R0b R0c` + `R1..R9` + `R8b` + `R9b`
 * 而且它们**两种形态不同**：
 *   · `R1..R9b`（11 个）走统一的结构（`scripts/verify-drain-after-swap.mjs:181-182`
 *     用 `r.id` / `r.level` / `r.what` 打印）⇒ 收集现成数组即可
 *   · ★ **`R0a/R0b/R0c` 是裸 `console.log`（无 id/level 结构）** ⇒ 要额外结构化，**最容易漏**
 * ⇒ 所以本 oracle **必须查全 15 个** —— 否则"只改那 11 个"也能蒙过，题目就失去区分度。
 *
 * 用法：node evals/checks/cli-0004.mjs                        # 退出 0 = 通过；非 0 = 不通过（并逐条打印原因）
 *       node evals/checks/cli-0004.mjs --repo <被测工作树>      # ★ 判**指定那棵树**的 scripts/verify-drain-after-swap.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ── ★★ 格 ⑩（O117）：oracle 必须能指向**被测的那棵树** ──────────────────────
 *
 * **原来的问题**：`REPO = 自身路径/../..` ⇒ **硬编码判据根** ⇒ 无论隔离工作树里有什么，
 *   它只判判据根那一份 ⇒ **把靶文件搬进 wt 也没用**（oracle 看都不看）。
 *   判据机器（`scripts/eval-task-applicability.mjs`）把这一条报成 `oracleBindsWt=false`。
 *
 * **现在的优先级**：`--repo` ＞ `DSH_EVAL_REPO` ＞ **自身相对路径**（= 判据根，**逐字回退，行为不变**）。
 *   ⇒ 不给参数时与改动前**逐字相同**（判据、退出码、输出都不变）；给了才换靶。
 * ★ 本文件把"用的是哪棵树"**打印出来**（含靶文件存不存在）—— 否则"oracle 到底判了谁"没法复核。
 * ★ 靶文件不在指定树里 ⇒ **大声报错并非零退出**（不弱化：判不了就是不合格，不是通过）。
 */
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url))
function resolveRepoArgv() {
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--repo') return { repo: a[i + 1] ?? null, src: '--repo' }
    if (a[i].startsWith('--repo=')) return { repo: a[i].slice('--repo='.length), src: '--repo=' }
  }
  if (process.env.DSH_EVAL_REPO) return { repo: process.env.DSH_EVAL_REPO, src: 'DSH_EVAL_REPO（环境变量）' }
  return { repo: path.resolve(HERE_DIR, '../..'), src: '自身相对路径（默认 = 判据根；与改动前逐字相同）' }
}
const _resolved = resolveRepoArgv()
const REPO = path.resolve(_resolved.repo ?? '')
const TARGET = path.join(REPO, 'scripts', 'verify-drain-after-swap.mjs')

console.log(`cli-0004 oracle —— REPO = ${REPO.replace(/\\/g, '/')}`)
console.log(`  来源：${_resolved.src}`)
console.log(`  靶文件：${TARGET.replace(/\\/g, '/')}  存在=${fs.existsSync(TARGET)}`)
if (!fs.existsSync(TARGET)) {
  console.log('')
  console.log(`cli-0004 oracle：**不合格** —— 指定树里没有靶文件（${TARGET}）⇒ 判不了（不弱化：判不了 ≠ 通过）`)
  process.exit(1)
}

/** 判据全集（15 个）—— 从真代码核出来的，**不是**照抄草案 */
const CRITERIA = ['R0a', 'R0b', 'R0c', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R8b', 'R9', 'R9b']
const STATUS = new Set(['ok', 'warn', 'fail'])
const ALLOWED_EXIT = new Set([0, 1, 2]) // 0=通过 / 1=换代了没生效 / 2=还没到能验收

let pass = 0
let fail = 0
const say = (ok, id, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(4)} ${what}${detail ? '  —— ' + detail : ''}`)
  ok ? pass++ : fail++
}
const run = (args) => spawnSync(process.execPath, [TARGET, ...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

// ── ① 旧行为没坏：`--selftest` 仍 0 退出 ────────────────────────────────────────
{
  const r = run(['--selftest'])
  say(r.status === 0, 'C1', '--selftest 仍 0 退出（旧行为没坏）', r.status === 0 ? '' : `exit=${r.status}`)
}

// ── ② `--json` 的 stdout 必须能 JSON.parse（诊断可走 stderr）──────────────────────
const jr = run(['--json'])
let obj = null
let parseErr = ''
try {
  obj = JSON.parse(jr.stdout ?? '')
} catch (e) {
  parseErr = String(e.message).slice(0, 80)
}
say(obj !== null, 'C2', '--json 的 stdout 能 JSON.parse', obj !== null ? '' : `解析失败：${parseErr}`)

// ── ③ 15 条判据**全在**（★ 含最容易漏的 R0a/R0b/R0c），且每项有 status/detail ────
// ★ 2026-09-21 修：原先 C3/C4 被包在 `if (obj)` 里 ⇒ **JSON 解析失败时它们被静默跳过**
//   ⇒ 只报"1 条不过"，**不过的条数虚低**（在 HEAD 上实测就是 1 条）。现在改为**如实计入失败**。
if (!obj) {
  say(false, 'C3a', `JSON 里含全部 ${CRITERIA.length} 条判据`, 'JSON 都解析不出 ⇒ 判据一条都不在')
  say(false, 'C3b', '每条判据都有 status∈{ok,warn,fail} 与非空 detail', '同上')
  say(false, 'C4a', '含汇总 ok:<bool> 与 fails:<number>', '同上')
  say(false, 'C4b', 'fails 与实际 fail 条数一致', '同上')
  say(false, 'C4c', 'ok 与“无 fail”一致', '同上')
} else {
  const miss = CRITERIA.filter((k) => !(k in obj))
  say(miss.length === 0, 'C3a', `JSON 里含全部 ${CRITERIA.length} 条判据`, miss.length ? `缺：${miss.join(', ')}` : '')

  const badShape = []
  for (const k of CRITERIA) {
    const v = obj[k]
    if (!v || typeof v !== 'object') { badShape.push(`${k}: 不是对象`); continue }
    if (!STATUS.has(v.status)) badShape.push(`${k}: status=${JSON.stringify(v.status)} 不在 {ok,warn,fail}`)
    if (typeof v.detail !== 'string' || !v.detail.trim()) badShape.push(`${k}: detail 不是非空字符串`)
  }
  say(badShape.length === 0, 'C3b', '每条判据都有 status∈{ok,warn,fail} 与非空 detail',
    badShape.length ? badShape.slice(0, 3).join(' ｜ ') : '')

  // ── ④ 汇总：ok(bool) 与 fails(number)，且 fails 与实际 fail 条数一致 ───────────
  const hasTypes = typeof obj.ok === 'boolean' && typeof obj.fails === 'number'
  say(hasTypes, 'C4a', '含汇总 ok:<bool> 与 fails:<number>', hasTypes ? '' : `ok=${typeof obj.ok} fails=${typeof obj.fails}`)

  const realFails = CRITERIA.filter((k) => obj[k]?.status === 'fail').length
  const consistent = hasTypes && obj.fails === realFails
  say(consistent, 'C4b', `fails 与实际 fail 条数一致（应 ${realFails}）`, consistent ? '' : `fails=${obj.fails} ≠ ${realFails}`)

  const okConsistent = hasTypes && obj.ok === (realFails === 0)
  say(okConsistent, 'C4c', 'ok 与“无 fail”一致', okConsistent ? '' : `ok=${obj.ok} 但 fails=${realFails}`)
}

// ── ⑤ 不带 `--json` 时：**判据行仍在** 且 退出码语义没变 ─────────────────────────
{
  const r = run([])
  const text = (r.stdout ?? '') + (r.stderr ?? '')
  const gone = CRITERIA.filter((k) => !new RegExp(`\\b${k}\\b`).test(text))
  say(gone.length === 0, 'C5a', `不带 --json 时 ${CRITERIA.length} 条判据行仍全部出现`,
    gone.length ? `缺：${gone.join(', ')}` : '')

  say(ALLOWED_EXIT.has(r.status ?? -1), 'C5b', '不带 --json 时退出码语义未变（0/1/2）',
    ALLOWED_EXIT.has(r.status ?? -1) ? '' : `exit=${r.status}`)

  // 旧行为的关键形态：R0a/R0b/R0c 在非 json 模式下仍是人读文本（不是被顺手改成 JSON）
  const human = /R0a[^\n]*在|R0a[^\n]*没在跑/.test(text) && /R0b/.test(text) && /R0c/.test(text)
  say(human, 'C5c', '不带 --json 时 R0a/R0b/R0c 仍是人读文本（没被顺手改成 JSON）')
}

console.log('')
console.log(fail === 0 ? `cli-0004 oracle：**全部通过**（${pass} 条判据）` : `cli-0004 oracle：**不合格**（${fail} 条不过）`)
process.exit(fail === 0 ? 0 : 1)
