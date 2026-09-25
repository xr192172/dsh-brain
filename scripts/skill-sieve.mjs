#!/usr/bin/env node
/**
 * skill-sieve.mjs —— **筛**：给一个 skill 定级，并决定它下一步去哪。
 *
 * 依据（结论固化，逐字）：`docs/training-ground-and-skill-sieve-2026-09-25.md` §7。
 * 用户口径原话：
 *   · **判据框架** = "一个 skill 和一个 agent **一一对应**的地方有哪些，然后**缺多少**：
 *       **一一对应的就是一等**；**少了某一项、或需要我们自己去补的就二等**；
 *       **什么都没有、只是一段提示词就三等**。"
 *   · "有些有**脚本**，有些是**内嵌片段**，有些是**指导**，这三个基本只有这三个吧，**这三个齐了就可以了**。"
 *   · "**用过的 skill 就打上标记说用过了，后续就不用再去碰它了。**"
 *   · **退役留存**："退役后**只用保留 GitHub 上的来源**即可……**留一个哈希值**放在硬盘上**去重**，
 *       就是**防止它重回**；我觉得**用 GitHub 的链接是最合理的**。"
 *   · **进化在子 agent 上**：一等/二等 ⇒ 建 agent；三等 ⇒ 优化同方向**已有** agent 的提示词。
 *
 * ★ 本脚本**只判定 + 记账**，**绝不删除任何东西**（"退役不留本体"是一条**独立的、需要人确认的**动作，见 §8）。
 *
 * 用法：
 *   node scripts/skill-sieve.mjs --in <skill_tree.json | nodes.jsonl>          # 打印分级表
 *   node scripts/skill-sieve.mjs --in <...> --json                             # 机器可读
 *   node scripts/skill-sieve.mjs --in <...> --emit-seen out/seen-hashes.json   # 落"已见哈希"台账（去重用）
 *   node scripts/skill-sieve.mjs --selftest                                    # 自测 + 消融自证
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 等级键（英文键给代码用；中文给人看）。 */
export const TIER_LABEL = { first: '一等', second: '二等', third: '三等', skip: '跳过' }

const hasText = (v) => typeof v === 'string' && v.trim().length > 0
const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0

/**
 * ★ 核心判据（纯函数）：给定一个 `SkillNode` ⇒ `{ tier, key, why }`。
 *
 * **判定顺序很重要**（先"跳过"，再定级）—— 因为"用过的/吸收过的不再碰"是**纪律**，
 * 而"它够几等"是**分级**；纪律优先，否则会反复处理已经处理过的东西。
 *
 * @param {object} node   `packages/skill-tree` 的 `SkillNode`（字段名逐字一致）
 * @param {{seenHashes?: Set<string>|string[], self?: string}} [opts]
 *   `seenHashes` = 已经见过的 `SourceHash`（**防重回**的去重集合）
 * @returns {{tier:'first'|'second'|'third'|'skip', key:string, why:string, missing:string[]}}
 */
export function classifySkill(node, opts = {}) {
  const n = node ?? {}
  const seen = opts.seenHashes instanceof Set ? opts.seenHashes : new Set(opts.seenHashes ?? [])
  const status = String(n.Status ?? '').trim().toLowerCase()

  // ── ① 跳过（纪律优先）──────────────────────────────────────────────────────
  if (status === 'absorbed') return r('skip', 'retired', `已被吸收（Status=absorbed${hasText(n.AbsorbedBy) ? ' → ' + n.AbsorbedBy : ''}）⇒ 不再碰`, [])
  if (status === 'archived') return r('skip', 'retired', '已归档（Status=archived）⇒ 不再碰', [])
  if (Number(n.UseCount ?? 0) >= 1) return r('skip', 'used', `用过（UseCount=${Number(n.UseCount)}）⇒ 不再碰`, [])
  const hash = String(n.SourceHash ?? '').trim()
  if (hash && seen.has(hash)) return r('skip', 'duplicate', `来源哈希已见过（SourceHash=${hash.slice(0, 12)}…）⇒ **防重回**，不再处理`, [])

  // ── ② 定级：数"skill 与 agent 一一对应"缺几格 ──────────────────────────────
  const guide = hasText(n.Principle) || hasText(n.Fix) // 指导（Principle / Fix）
  const script = hasText(n.Script) // 脚本（外部脚本文件）
  const tool = nonEmptyArray(n.Tools) // 内嵌片段（现由 Tools[] 承载，见 §7.4 的 schema 缺口）

  const missing = []
  if (!guide) missing.push('指导(Principle/Fix)')
  if (!script) missing.push('脚本(Script)')
  if (!tool) missing.push('内嵌片段(Tools[])')

  // 连指导都没有 = 什么都没有可用的 ⇒ 不是三等，是**没法用**
  if (!guide) return r('skip', 'no-guidance', '连指导都没有（Principle/Fix 皆空）⇒ 没法用，跳过', missing)

  if (script && tool) return r('first', 'complete', '三样齐（指导 ∧ 脚本 ∧ 内嵌片段）⇒ **一一对应齐备** ⇒ 直接建子 agent', [])
  if (!script && !tool) return r('third', 'guide-only', '只有指导（Script 与 Tools[] 皆空）⇒ 不建 agent，用来**优化同方向已有 agent 的提示词**', missing)
  return r('second', 'incomplete', `缺 ${missing.length} 项（${missing.join(' / ')}）⇒ **需我们自己补**（常见：把 Script 人工包成 ToolDef）后建子 agent`, missing)
}

function r(tier, key, why, missing) {
  return { tier, key, why, missing }
}

/**
 * ★★ 融合候选（纯函数，成对）：找出"**同功能**且**都有 `Script`**"的节点对，
 * 并给出"**谁更优**"的**排序依据**（不是"自动择优"）。
 *
 * 依据：`docs/training-ground-and-skill-sieve-2026-09-25.md` §10.4。
 * 用户口径：*"脚本本身也是可更改的，如果有相同功能的脚本的更优实现——更合理、更科学、更兼容的实现，
 * 也可以把两个脚本融合，或者说就是把它的设计融合在一起。"*
 *
 * ★ **"同功能"的口径是【我提的】，不是用户说的** ⇒ 做成 `minTriggerOverlap` 可调：
 *   默认 = **`Triggers` 交叠 ≥ 1** **或** 同一个 `Parent`。
 *   （用 `Triggers` 是因为它是现成的机器可判字段，注释逐字"路由依据"= 什么时候用它。）
 * ★★ **只输出候选 + 依据，绝不自动融合**（融合是**设计决定**，要人判）。
 *
 * @param {object[]} nodes
 * @param {{minTriggerOverlap?:number, seenHashes?:Set<string>|string[]}} [opts]
 * @returns {{a:string,b:string,why:string,better:{id:string,by:string}|null,scores:object}[]}
 */
export function suggestMerges(nodes, opts = {}) {
  const minOverlap = Number(opts.minTriggerOverlap ?? 1)
  // 只对"还在用、且有脚本"的节点提候选（被跳过的节点按纪律不再碰）
  const usable = (nodes ?? []).filter((n) => hasText(n?.Script) && classifySkill(n, opts).tier !== 'skip')
  const out = []
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]
      const b = usable[j]
      const ta = new Set((a.Triggers ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))
      const tb = new Set((b.Triggers ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))
      const overlap = [...ta].filter((x) => tb.has(x))
      const sameParent = hasText(a.Parent) && String(a.Parent) === String(b.Parent)
      if (overlap.length < minOverlap && !sameParent) continue
      out.push({
        a: a.ID ?? '(无ID)',
        b: b.ID ?? '(无ID)',
        why: sameParent ? `同一个 Parent（${a.Parent}）` : `Triggers 交叠 ${overlap.length}：${overlap.join('、')}`,
        better: pickBetter(a, b),
        scores: {
          [a.ID ?? 'a']: { SuccessRate: n(a.SuccessRate), Score: n(a.Score), UseCount: n(a.UseCount) },
          [b.ID ?? 'b']: { SuccessRate: n(b.SuccessRate), Score: n(b.Score), UseCount: n(b.UseCount) },
        },
      })
    }
  }
  return out
}

/** 谁更优：先 `SuccessRate`，再 `Score`，再 `UseCount` —— 全是**现成战绩字段**。★ 只是排序依据。 */
function pickBetter(a, b) {
  const rows = [
    ['SuccessRate', Number(a.SuccessRate ?? 0), Number(b.SuccessRate ?? 0)],
    ['Score', Number(a.Score ?? 0), Number(b.Score ?? 0)],
    ['UseCount', Number(a.UseCount ?? 0), Number(b.UseCount ?? 0)],
  ]
  for (const [by, va, vb] of rows) {
    if (va === vb) continue
    return { id: va > vb ? (a.ID ?? 'a') : (b.ID ?? 'b'), by }
  }
  return null // 三项全平 ⇒ 不裁，"谁更优"交给人
}
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// ─────────────────────────────────────────────────────────────────────────────
//  以下：IO / CLI / 自测
// ─────────────────────────────────────────────────────────────────────────────

/** 读入 nodes：支持 `.json`（数组 / `{nodes:[...]}` / `{skills:[...]}`）与 `.jsonl`。 */
export function loadNodes(file) {
  const raw = fs.readFileSync(file, 'utf8')
  if (file.toLowerCase().endsWith('.jsonl')) {
    return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  }
  const j = JSON.parse(raw)
  if (Array.isArray(j)) return j
  for (const k of ['nodes', 'skills', 'items']) if (Array.isArray(j[k])) return j[k]
  // Go 侧 `skill_tree.json` 可能是 { <id>: node } 的映射
  const vals = Object.values(j).filter((v) => v && typeof v === 'object' && 'ID' in v)
  if (vals.length) return vals
  throw new Error(`${file}: 认不出结构（要数组 / {nodes|skills|items:[...]} / {id: node}）`)
}

function argOf(argv, k) {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}

function selftest() {
  const cases = [
    ['一等：三样齐', { ID: 'a', Principle: '有指导', Script: 'x.py', Tools: [{ Name: 't' }] }, 'first'],
    ['二等：缺内嵌片段（最常见）', { ID: 'b', Principle: '有指导', Script: 'x.py', Tools: [] }, 'second'],
    ['二等：缺脚本', { ID: 'c', Principle: '有指导', Tools: [{ Name: 't' }] }, 'second'],
    ['三等：只有指导', { ID: 'd', Principle: '有指导' }, 'third'],
    ['跳过：用过', { ID: 'e', Principle: '有指导', Script: 'x', Tools: [{}], UseCount: 1 }, 'skip'],
    ['跳过：已吸收', { ID: 'f', Principle: '有指导', Script: 'x', Tools: [{}], Status: 'absorbed' }, 'skip'],
    ['跳过：已归档', { ID: 'g', Principle: '有指导', Script: 'x', Tools: [{}], Status: 'archived' }, 'skip'],
    ['跳过：防重回（哈希已见）', { ID: 'h', Principle: '有指导', Script: 'x', Tools: [{}], SourceHash: 'H1' }, 'skip'],
    ['跳过：连指导都没有', { ID: 'i', Script: 'x.py' }, 'skip'],
    ['Fix 也算指导', { ID: 'j', Fix: '怎么修', Script: 'x', Tools: [{}] }, 'first'],
  ]
  const seen = new Set(['H1'])
  let pass = 0
  console.log('=== 分级自测（10 例）===')
  for (const [name, node, want] of cases) {
    const got = classifySkill(node, { seenHashes: seen })
    const ok = got.tier === want
    if (ok) pass++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} ⇒ ${TIER_LABEL[got.tier]}（${got.key}）${ok ? '' : ` ★ 期望 ${TIER_LABEL[want]}`}`)
  }
  // ── 融合候选自测（§10.4）───────────────────────────────────────────────────
  console.log('\n=== 融合候选自测 ===')
  const mk = (id, triggers, extra = {}) => ({
    ID: id, Principle: 'g', Script: 'x', Tools: [{}], Triggers: triggers,
    SuccessRate: 0.5, Score: 0.5, UseCount: 0, ...extra,
  })
  const mergeCases = [
    ['Triggers 交叠 1 ⇒ 出候选', [mk('m1', ['refactor']), mk('m2', ['refactor'])], 1],
    ['交叠 0 且不同 Parent ⇒ 无候选', [mk('m3', ['a']), mk('m4', ['b'], { Parent: 'p2' })], 0],
    ['同 Parent（triggers 不交叠）⇒ 出候选', [mk('m5', ['a'], { Parent: 'P' }), mk('m6', ['b'], { Parent: 'P' })], 1],
    ['被跳过的节点不参与（用过了）', [mk('m7', ['x'], { UseCount: 1 }), mk('m8', ['x'])], 0],
    ['没有 Script 的节点不参与', [{ ID: 'm9', Principle: 'g', Triggers: ['y'] }, mk('m10', ['y'])], 0],
  ]
  let mpass = 0
  for (const [name, nodes, want] of mergeCases) {
    const got = suggestMerges(nodes, { seenHashes: new Set() }).length
    const ok = got === want
    if (ok) mpass++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} ⇒ ${got} 对${ok ? '' : ` ★ 期望 ${want}`}`)
  }
  const pair = suggestMerges([mk('b1', ['t'], { SuccessRate: 0.9 }), mk('b2', ['t'], { SuccessRate: 0.1 })], {})
  const bok = pair[0]?.better?.id === 'b1' && pair[0]?.better?.by === 'SuccessRate'
  if (bok) mpass++
  console.log(`  ${bok ? 'ok  ' : 'FAIL'} 谁更优 ⇒ ${pair[0]?.better ? `${pair[0].better.id}（按 ${pair[0].better.by}）` : '(未裁)'}${bok ? '' : ' ★ 期望 b1/按 SuccessRate'}`)

  // ★ 消融自证：撤掉"内嵌片段也要有"这一格 ⇒ "二等（缺片段）"那条必须变红
  console.log('\n=== 消融自证 ===')
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const ANCHOR = 'if (script && tool) return r(\'first\''
  const ABLATED = 'if (script) return r(\'first\''
  if (!src.includes(ANCHOR)) {
    console.log('  ★ 锚点失配 —— 消融脚本必须重写（不许模糊匹配）')
    return 1
  }
  const tmp = path.join(HERE, '_sieve-ablated.mjs')
  fs.writeFileSync(tmp, src.replace(ANCHOR, ABLATED), 'utf8')
  const run = spawnSync(process.execPath, [tmp, '--selftest-only'], { encoding: 'utf8', timeout: 60000 })
  const out = (run.stdout ?? '') + (run.stderr ?? '')
  const ablOk = /FAIL 二等：缺内嵌片段/.test(out) // 消融后那条**必须**变红
  console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 撤掉"内嵌片段"判定 ⇒ "二等：缺内嵌片段"变红 ${ablOk ? '✓' : '（没变红 ⇒ 那条判据没接线）'}`)
  fs.unlinkSync(tmp)
  // ★ 消融②：撤掉"同功能"那条过滤 ⇒ "交叠 0 ⇒ 0 对" 必须变红
  const ANCHOR2 = 'if (overlap.length < minOverlap && !sameParent) continue'
  const ABLATED2 = 'if (false) continue // ABLATED'
  let abl2Ok = false
  if (!src.includes(ANCHOR2)) {
    console.log('  ★ 消融②锚点失配 —— 必须重写')
  } else {
    fs.writeFileSync(tmp, src.replace(ANCHOR2, ABLATED2), 'utf8')
    const r2 = spawnSync(process.execPath, [tmp, '--selftest-only'], { encoding: 'utf8', timeout: 60000 })
    const o2 = (r2.stdout ?? '') + (r2.stderr ?? '')
    abl2Ok = /FAIL 融合：交叠0/.test(o2)
    console.log(`  ${abl2Ok ? 'ok  ' : 'FAIL'} 撤掉"同功能"过滤 ⇒ "交叠0 ⇒ 0 对"变红 ${abl2Ok ? '✓' : '（没变红 ⇒ 那条判据没接线）'}`)
    fs.unlinkSync(tmp)
  }
  const total = pass === cases.length && mpass === mergeCases.length + 1 && ablOk && abl2Ok
  console.log(`\n结果：分级 ${pass}/${cases.length}，融合 ${mpass}/${mergeCases.length + 1}，消融 ${ablOk && abl2Ok ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

const argv = process.argv.slice(2)
if (argv.includes('--selftest-only')) {
  // 消融版自调用：只跑最小集（分级 2 例 + 融合 1 例），不再递归消融。
  // ★ 两个消融各自断言自己那一行 FAIL，所以这里要把两行都打出来。
  const cases = [
    ['一等：三样齐', { ID: 'a', Principle: 'g', Script: 'x', Tools: [{}] }, 'first'],
    ['二等：缺内嵌片段', { ID: 'b', Principle: 'g', Script: 'x', Tools: [] }, 'second'],
  ]
  for (const [nm, node, want] of cases) {
    const got = classifySkill(node).tier
    if (got !== want) console.log(`  FAIL ${nm}（得 ${got}，期望 ${want}）`)
    else console.log(`  ok  ${nm}`)
  }
  const mk2 = (id, tr, ex = {}) => ({ ID: id, Principle: 'g', Script: 'x', Tools: [{}], Triggers: tr, SuccessRate: 0.5, Score: 0.5, UseCount: 0, ...ex })
  const pairs = suggestMerges([mk2('m3', ['a']), mk2('m4', ['b'], { Parent: 'p2' })], { seenHashes: new Set() }).length
  if (pairs !== 0) console.log(`  FAIL 融合：交叠0 应为0对（得 ${pairs}）`)
  else console.log('  ok  融合：交叠0 ⇒ 0 对')
  process.exit(0) // 消融版**故意**跑出 FAIL 供父进程断言；退出码本身不表态
}
if (argv.includes('--selftest') || argv.length === 0) process.exit(selftest())

const inFile = argOf(argv, '--in')
if (!inFile) {
  console.error('[用法] 需要 --in <skill_tree.json | nodes.jsonl>（或用 --selftest）')
  process.exit(2)
}
const seenFile = argOf(argv, '--seen')
const seen = seenFile && fs.existsSync(seenFile) ? new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8'))) : new Set()
const nodes = loadNodes(inFile)
const results = nodes.map((n) => ({ id: n.ID ?? '(无ID)', ...classifySkill(n, { seenHashes: seen }) }))

// ★ 融合候选（§10.4）：**只在 `--suggest-merge` 时算**（成对比较是 O(n²)，大集别默认跑）
const merges = argv.includes('--suggest-merge')
  ? suggestMerges(nodes, {
      seenHashes: seen,
      minTriggerOverlap: Number(argOf(argv, '--min-trigger-overlap') ?? 1),
    })
  : null

if (argv.includes('--json')) {
  console.log(JSON.stringify(merges ? { skills: results, mergeCandidates: merges } : results, null, 2))
} else {
  const byTier = {}
  for (const x of results) (byTier[x.tier] ??= []).push(x)
  console.log(`\n输入 ${results.length} 个 skill：`)
  for (const t of ['first', 'second', 'third', 'skip']) {
    const xs = byTier[t] ?? []
    console.log(`  ${TIER_LABEL[t]}：${xs.length}`)
    for (const x of xs.slice(0, 8)) console.log(`     · ${x.id} —— ${x.why}`)
    if (xs.length > 8) console.log(`     …（还有 ${xs.length - 8} 个）`)
  }
  if (merges) {
    console.log(`\n融合候选（"同功能"口径 = Triggers 交叠 ≥ ${argOf(argv, '--min-trigger-overlap') ?? 1} 或同 Parent；` +
      `★ **这是我提的口径**，可调）：${merges.length} 对`)
    for (const m of merges.slice(0, 12)) {
      const b = m.better ? `更优：${m.better.id}（按 ${m.better.by}）` : '三项全平 ⇒ 不裁，交给人'
      console.log(`   · ${m.a} ⟷ ${m.b} —— ${m.why} ⇒ ${b}`)
    }
    if (merges.length > 12) console.log(`   …（还有 ${merges.length - 12} 对）`)
    console.log('   ★★ 这只是**候选**：融合是**设计决定**（且融合后必须通过**原先两者**的全部用例，见 §10.3）。')
  }
}
const emit = argOf(argv, '--emit-seen')
if (emit) {
  const all = new Set(seen)
  for (const n of nodes) if (hasText(n.SourceHash)) all.add(String(n.SourceHash).trim())
  fs.mkdirSync(path.dirname(emit), { recursive: true })
  fs.writeFileSync(emit, JSON.stringify([...all].sort(), null, 2), 'utf8')
  console.log(`\n已见哈希台账 → ${emit}（${all.size} 条）★ 这是"防重回"的去重键，不是本体`)
}
console.log('\n★ 本工具只判定 + 记账，**不删除任何东西**（"退役不留本体"是独立的、需人确认的动作）。')
