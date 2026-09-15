#!/usr/bin/env node
/**
 * test-capability-notice-wiring.mjs —— P4 **接线**的离线自证
 *
 * 跑编译产物 `packages/capability-bridge/lib/index.js`，用 mock ctx 真调 `apply()`，
 * 再手动触发它注册的处理器 —— 这是**不换代**能验到的最深一层。
 *
 * 验的是"接对了没有"，而不是"内核对不对"（后者在 test-capability-notice.mjs）。
 * 重点：
 *   ① 两个处理器都装上了（`session/event` + `tools/post-execute`）；
 *   ② 首次见到会话 ⇒ 只记基线、**不记为变更**（否则每个新会话平白多一条通知）；
 *   ③ 能力库变了 ⇒ 折叠行**搭车到 `additionalContexts`**（不是自己 append 一条 surface）；
 *   ④ **幂等/收敛**：状态没再变 ⇒ 不再挂；
 *   ⑤ **集合没变就不写**（dropped）：updatedAt 变了但 active 集合一样 ⇒ 不挂；
 *   ⑥ 通知条目的 `source` 必须齐全 —— 上游注释明说漏了它会在派生历史里
 *      被渲染成**用户提示**（假消息）；
 *   ⑦ **失败隔离**：能力库读不到 ⇒ 原样返回，不炸、不改坏工具结果。
 *
 * 用法：node scripts/test-capability-notice-wiring.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/project_develop/dsh-brain'
const LIB = path.join(REPO, 'packages/capability-bridge/lib/index.js')
const TMP = path.join(REPO, 'out/notice-wiring')
const REG = path.join(TMP, 'registry.json')

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

if (!fs.existsSync(LIB)) {
  console.error(`X 找不到编译产物：${LIB}\n  先构建 capability-bridge`)
  process.exit(1)
}
const M = await import(pathToFileURL(LIB).href)
const { apply, CAP_CHANGE_EVENT } = M

// ── 造一个会变的 registry ────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

function writeRegistry(ids, updatedAt) {
  fs.writeFileSync(
    REG,
    JSON.stringify({
      schema: 'dsh-capability-registry/v1',
      updatedAt,
      capabilities: ids.map((id) => ({ id, kind: 'subagent-provider', status: 'active', version: '0.0.0' })),
      history: [],
    }, null, 2) + '\n',
    'utf8',
  )
}

// ── mock ctx：把 apply 注册的处理器收集起来，之后手动触发 ─────────────────────
function makeCtx() {
  const H = {}
  const on = (ev, fn) => { (H[ev] ??= []).push(fn) }
  const sctx = { on }
  const ctx = {
    inject: (deps, cb) => {
      if (deps.includes('tools')) cb({ tools: { register: () => () => {} } })
      if (deps.includes('sessions')) cb(sctx)
    },
  }
  return { ctx, H }
}

const fire = async (H, ev, ...args) => {
  const fns = H[ev] ?? []
  if (!fns.length) throw new Error(`没装上处理器：${ev}`)
  // post-execute 是 waterfall：调用方要传 next
  return fns[0](...args)
}

console.log('== ① 处理器装上了吗 ==')
writeRegistry(['spawn', 'fork'], 'T0')
const { ctx, H } = makeCtx()
apply(ctx, { registryPath: REG, maxRows: 50 })
eq('装了 session/event', (H['session/event'] ?? []).length, 1)
eq('装了 tools/post-execute', (H['tools/post-execute'] ?? []).length, 1)

// 一条假 session（只需要 id/append）+ 一个"上游决定"
const appended = []
const session = { id: 'session-test', append: (t, d) => { appended.push({ t, d }) } }
const ev = (seq) => ({ type: 'tool/result', seq })
const downstream = { kind: 'accept', content: [{ type: 'text', text: 'tool ok' }] }
const next = async () => downstream

console.log('== ② 首次见到会话 ⇒ 只记基线，不记为变更 ==')
await fire(H, 'session/event', session, ev(1))
{
  const r = await fire(H, 'tools/post-execute', { agent: { session: { header: { id: session.id } } } }, {}, next)
  eq('首次 ⇒ 不挂 additionalContexts', r.additionalContexts, undefined)
}

console.log('== ③ 能力库变了 ⇒ 搭车到 additionalContexts ==')
writeRegistry(['spawn', 'fork', 'design-canvas'], 'T1')
await fire(H, 'session/event', session, ev(2))
eq('把变更写进了会话日志（非 surface 事件）', appended.filter((a) => a.t === CAP_CHANGE_EVENT).length, 1)
let attached = null
{
  const r = await fire(H, 'tools/post-execute', { agent: { session: { header: { id: session.id } } } }, {}, next)
  attached = r.additionalContexts
  eq('挂上了 1 条', Array.isArray(attached) && attached.length, 1)
  eq('原工具结果内容未被破坏', JSON.stringify(r.content), JSON.stringify(downstream.content))
  if (attached?.[0]) {
    const t = attached[0].content?.[0]?.text ?? ''
    for (const id of ['spawn', 'fork', 'design-canvas']) {
      if (t.includes(id)) ok(`快照含 ${id}`)
      else bad(`快照含 ${id}`, t.slice(0, 100))
    }
    eq('★ source 标注齐全（漏了会被渲染成用户提示）',
      { kind: attached[0].source?.kind, plugin: attached[0].source?.plugin, form: attached[0].source?.form },
      { kind: 'plugin', plugin: 'capability-bridge', form: 'notice' })
  }
}

console.log('== ④ 幂等：状态没再变 ⇒ 不再挂 ==')
{
  const r = await fire(H, 'tools/post-execute', { agent: { session: { header: { id: session.id } } } }, {}, next)
  eq('第二次 ⇒ 不挂', r.additionalContexts, undefined)
}

console.log('== ⑤ 集合没变就不写（dropped）==')
// updatedAt 变了（触发记账），但 active 集合与上次写出去的**完全一致**
writeRegistry(['spawn', 'fork', 'design-canvas'], 'T2')
await fire(H, 'session/event', session, ev(3))
{
  const r = await fire(H, 'tools/post-execute', { agent: { session: { header: { id: session.id } } } }, {}, next)
  eq('集合未变 ⇒ 不挂（整段 delta 可丢）', r.additionalContexts, undefined)
  // 且水位已推进：再触发一次也不该挂
  const r2 = await fire(H, 'tools/post-execute', { agent: { session: { header: { id: session.id } } } }, {}, next)
  eq('dropped 后继续静默', r2.additionalContexts, undefined)
}

console.log('== ⑥ 集合真变 ⇒ 再挂一次，且是新快照 ==')
writeRegistry(['spawn', 'council-architect'], 'T3')
await fire(H, 'session/event', session, ev(4))
{
  const r = await fire(H, 'tools/post-execute', { agent: { session: { header: { id: session.id } } } }, {}, next)
  const t = r.additionalContexts?.[0]?.content?.[0]?.text ?? ''
  if (r.additionalContexts?.length === 1 && t.includes('council-architect') && !t.includes('design-canvas')) {
    ok('新快照反映真变化（且移除了已淘汰项）')
  } else {
    bad('新快照反映真变化', t.slice(0, 120))
  }
}

console.log('== ⑦ 失败隔离 ==')
{
  const { ctx: ctx2, H: H2 } = makeCtx()
  apply(ctx2, { registryPath: path.join(TMP, 'no-such-registry.json'), maxRows: 50 })
  await fire(H2, 'session/event', session, ev(9))
  const r = await fire(H2, 'tools/post-execute', { agent: { session: { header: { id: session.id } } } }, {}, next)
  eq('能力库读不到 ⇒ 原样返回（不炸、不改坏结果）', JSON.stringify(r), JSON.stringify(downstream))
}

console.log('== ⑧ 无 agent 的调用（直接/测试调用）不该炸 ==')
{
  const r = await fire(H, 'tools/post-execute', {}, {}, next)
  eq('无 agent ⇒ 原样返回', JSON.stringify(r), JSON.stringify(downstream))
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log('\n=========================================')
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) for (const f of failures) console.log('  · ' + f)
process.exit(fail ? 1 : 0)
