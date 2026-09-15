#!/usr/bin/env node
/**
 * test-capability-notice.mjs —— 折叠内核的**离线自证**（P4 骨架）
 *
 * 验的是 `packages/capability-bridge/lib/notice.js`（**编译产物**，不是源码 ——
 * 与 `check-config-tolerance.mjs` 同一条纪律：跑真件）。
 *
 * 重点证三件事（都是设计里最容易做错、做错了还不显眼的）：
 *   ① **幂等**：同一状态重复折叠，第二次起绝不重复写；
 *   ② **写的是快照不是增量**：丢掉的后果只能是「不知道」，不能是「以为错」；
 *   ③ **顺序无关**（只比状态、不比事件）⇒ `+X,-X` 与 `-X,+X` 结果相同。
 *
 * 用法：node scripts/test-capability-notice.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/project_develop/dsh-brain'
const LIB = path.join(REPO, 'packages/capability-bridge/lib/notice.js')

let pass = 0
let fail = 0
const failures = []
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log('  FAIL ' + n + ' — ' + d) }
const eq = (n, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(n)
  else bad(n, `期望 ${w}，实得 ${g}`)
}
const truthy = (n, v) => (v ? ok(n) : bad(n, `期望为真，实得 ${JSON.stringify(v)}`))

if (!fs.existsSync(LIB)) {
  console.error(`X 找不到编译产物：${LIB}\n  先构建：node node_modules/typescript/bin/tsc -p packages/capability-bridge/tsconfig.json`)
  process.exit(1)
}
const M = await import(pathToFileURL(LIB).href)
const { foldNotices, initialFoldState, normalizeSnapshot, hashSnapshot, renderNotice } = M

const chg = (seq, id, action = 'registered') => ({ seq, at: '2026-09-15T00:00:00Z', action, id })

console.log('== 归一化与哈希 ==')
eq('归一化：排序 + 去重', normalizeSnapshot(['b', 'a', 'b']), 'a\nb')
eq('同一集合不同顺序 ⇒ 同一指纹', hashSnapshot(normalizeSnapshot(['b', 'a'])), hashSnapshot(normalizeSnapshot(['a', 'b'])))
truthy('不同集合 ⇒ 不同指纹', hashSnapshot(normalizeSnapshot(['a'])) !== hashSnapshot(normalizeSnapshot(['a', 'c'])))

console.log('== ① 无变更 → 不写（幂等的基础）==')
{
  const r = foldNotices([], initialFoldState, ['a'])
  eq('无变更 ⇒ no-pending', r.kind, 'no-pending')
  eq('无变更 ⇒ 状态不变', r.next, initialFoldState)
}

console.log('== ② 有变更且集合变了 → 写**快照** ==')
{
  const changes = [chg(1, 'council-architect')]
  const live = ['design-canvas', 'fork', 'council-architect']
  const r = foldNotices(changes, initialFoldState, live)
  eq('集合变了 ⇒ emit', r.kind, 'emit')
  for (const id of live) truthy(`快照含当前项 ${id}`, r.text.includes(id))
  // ★ 关键：不能出现增量措辞。写"刚加了 X"就等于引入相对量，
  //   一旦这条丢了，模型会以为 X 不存在（"以为错"），而不是"不知道"。
  const deltaWords = ['新增', '已卸载', '刚刚', 'added', 'removed']
  const hit = deltaWords.filter((w) => r.text.includes(w))
  eq('★ 快照里不得出现增量措辞', hit, [])
  truthy('提示指向 list_capabilities 兜底', r.text.includes('list_capabilities'))
}

console.log('== ③ 幂等：同状态重复折叠不再写 ==')
{
  const live = ['a', 'b']
  const r1 = foldNotices([chg(1, 'a')], initialFoldState, live)
  eq('首次 ⇒ emit', r1.kind, 'emit')
  const r2 = foldNotices([chg(1, 'a')], r1.next, live)
  eq('再折叠同一状态 ⇒ no-pending', r2.kind, 'no-pending')
  const r3 = foldNotices([chg(1, 'a'), chg(2, 'b')], r1.next, live)
  // 集合与上次写出去的一致 ⇒ 整段 delta 可丢（但仍推进水位）
  eq('集合未变的新变更 ⇒ dropped（不写）', r3.kind, 'dropped')
  eq('dropped 计入条数', r3.droppedCount, 1)
  truthy('dropped 仍推进水位', r3.next.foldedUpToSeq === 2)
  const r4 = foldNotices([chg(1, 'a'), chg(2, 'b')], r3.next, live)
  eq('dropped 之后再折叠 ⇒ no-pending（水位已推）', r4.kind, 'no-pending')
}

console.log('== ④ 顺序无关：只比状态，不比事件 ==')
{
  const live = ['a']                       // 回到与"写出去时"相同的集合
  const base = foldNotices([chg(1, 'a')], initialFoldState, live).next
  const plusMinus = [chg(1, 'x', 'registered'), chg(2, 'x', 'retired')]
  const minusPlus = [chg(1, 'x', 'retired'), chg(2, 'x', 'registered')]
  const rA = foldNotices([chg(0, 'a'), ...plusMinus], { ...base, foldedUpToSeq: 0 }, live)
  const rB = foldNotices([chg(0, 'a'), ...minusPlus], { ...base, foldedUpToSeq: 0 }, live)
  eq('+X,-X ⇒ dropped（集合没变）', rA.kind, 'dropped')
  eq('-X,+X ⇒ dropped（集合没变）', rB.kind, 'dropped')
  eq('★ 两种顺序结果相同（不存在"成对相消"的顺序坑）', rA.kind, rB.kind)
}

console.log('== ⑤ 真变化 ⇒ 再写一次，然后重新静默 ==')
{
  const r1 = foldNotices([chg(1, 'a')], initialFoldState, ['a'])
  const r2 = foldNotices([chg(1, 'a'), chg(2, 'b')], r1.next, ['a', 'b'])
  eq('集合真变了 ⇒ 再次 emit', r2.kind, 'emit')
  truthy('新快照含新增项', r2.text.includes('b'))
  const r3 = foldNotices([chg(1, 'a'), chg(2, 'b')], r2.next, ['a', 'b'])
  eq('写完之后 ⇒ no-pending（收敛）', r3.kind, 'no-pending')
}

console.log('== ⑥ 边界 ==')
{
  const r = foldNotices([chg(1, 'a')], initialFoldState, [])
  eq('空集合 ⇒ 仍 emit（状态确实变了）', r.kind, 'emit')
  truthy('空集合文案不崩且说清楚', r.text.includes('无可用能力'))
  eq('空集合无增量措辞', ['新增', '已卸载'].filter((w) => r.text.includes(w)), [])
  eq('renderNotice 幂等（同输入同输出）', renderNotice(['b', 'a']), renderNotice(['a', 'b']))
}

console.log('\n=========================================')
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) for (const f of failures) console.log('  · ' + f)
process.exit(fail ? 1 : 0)
