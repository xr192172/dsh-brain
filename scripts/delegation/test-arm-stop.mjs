// arm-stop 的判据（行为层，**注入依赖 ⇒ 不真杀任何进程**）。
//
// ★ 本判据的**安全不变量**（最重要的一条）：
//   `selectDsBrainProcs` **绝不许**选中命令行里不含本仓库路径的 node 进程 —— 那是别人的东西。
//
// ★ 消融自证（铁律 21）：把 `selectDsBrainProcs` 的选择条件放宽成"只要是 node 就选"
//   ⇒ ②③（不误选）必红。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert'
import { selectDsBrainProcs, stopAll, pidsListeningOn } from '../../scripts/arm-stop.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); pass++ }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e?.message ?? e)); fail++ }
}
const ta = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++ }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e?.message ?? e)); fail++ }
}

console.log('\narm-stop 判据（★ 不真杀进程 —— 全用注入依赖）\n')

const R = 'D:\\project_develop\\dsh-brain'

// 一份"像真的一样"的进程快照：含本仓库那两个 + 一批**不该被碰**的无关 node
const SNAP = [
  // ★ 该被选中的：switchboard 本体
  { pid: 6816, ppid: 5560, cmd: `${R}\\.tools\\node\\node.exe ${R}\\packages\\switchboard\\out\\b1790403532379\\main.js` },
  // ★ 该被选中的：它拉起的代（ppid = 6816）
  { pid: 22512, ppid: 6816, cmd: `${R}\\.tools\\node\\node.exe --inspect=127.0.0.1:32811 ${R}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 3082 --no-open` },
  // ✗ 不该被碰：别的项目的 switchboard（另一个仓库）
  { pid: 9001, ppid: 5560, cmd: 'D:\\other\\proj\\packages\\switchboard\\out\\x\\main.js' },
  // ✗ 不该被碰：跟本项目无关的 node
  { pid: 20824, ppid: 1000, cmd: 'C:\\Program Files\\nodejs\\node.exe D:\\tools\\foo.js' },
  // ✗ 不该被碰：别的 node 恰好 cwd 在本仓库，但跑的不是 switchboard/main.js
  { pid: 7777, ppid: 1000, cmd: `${R}\\scripts\\something-else.mjs` },
  // ✗ 不该被碰：本仓库 node_modules 里的 dsh，但**不是** 6816 的子进程（别人手起的）
  { pid: 8888, ppid: 4242, cmd: `${R}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 3999` },
]

t('① 选中恰好两个：switchboard 本体 + 它拉起的代', () => {
  const s = selectDsBrainProcs(SNAP, R)
  assert.deepStrictEqual(s.roots, [6816], '本体只应有 6816')
  assert.deepStrictEqual(s.children, [22512], '代只应有 22512（ppid=6816）')
  assert.deepStrictEqual([...s.all].sort((a, b) => a - b), [6816, 22512])
})

t('② ★★ 绝不误选：别的仓库的 switchboard / 无关 node 一个都不许进', () => {
  const s = selectDsBrainProcs(SNAP, R)
  for (const bad of [9001, 20824, 7777, 8888]) {
    assert.ok(!s.all.includes(bad), `★ 不许选中 pid ${bad}（那是别人的进程）`)
  }
})

t('③ ★★ 无关进程占多数时仍只挑两个（不许"按名杀 node"）', () => {
  const many = [...SNAP, ...Array.from({ length: 50 }, (_, i) => ({ pid: 10000 + i, ppid: 1, cmd: 'C:\\node.exe other.js' }))]
  const s = selectDsBrainProcs(many, R)
  assert.strictEqual(s.all.length, 2, `只许 2 个，实际 ${s.all.length}`)
})

t('④ 顺序：先子后父（否则先杀父 ⇒ 代成孤儿，下次找不回来）', () => {
  const s = selectDsBrainProcs(SNAP, R)
  assert.strictEqual(s.all[0], 22512, '第一个必须是代')
  assert.strictEqual(s.all[1], 6816, '最后才是本体')
})

t('⑤ 路径分隔符/大小写不敏感（`\\` vs `/`、大小写）', () => {
  const alt = [{ pid: 1, ppid: 0, cmd: 'd:/PROJECT_DEVELOP/DSH-BRAIN/packages/switchboard/out/x/main.js' }]
  assert.deepStrictEqual(selectDsBrainProcs(alt, 'D:\\project_develop\\dsh-brain').roots, [1])
})

t('⑥ 空快照 ⇒ 什么都不选（不是"选全部"）', () => {
  assert.deepStrictEqual(selectDsBrainProcs([], R).all, [])
})

t('⑦ 端口兜底判据只认给定端口', () => {
  const lines = [
    '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    6816',
    '  TCP    127.0.0.1:31800   0.0.0.0:0    LISTENING    6816',
    '  TCP    127.0.0.1:9999    0.0.0.0:0    LISTENING    4321',
  ]
  assert.deepStrictEqual(pidsListeningOn(lines, [3080, 31800]).sort(), [6816])
})

// ── stopAll：注入依赖，验证"真停掉了 + 复核" ──
await ta('⑧ stopAll：停掉两个，且 survivors 为空（复核过）', async () => {
  const aliveSet = new Set([6816, 22512, 20824])
  const killed = []
  const r = await stopAll(
    {
      snapshot: async () => SNAP,
      kill: async (pid) => { killed.push(pid); aliveSet.delete(pid); return true },
      alive: (pid) => aliveSet.has(pid),
    },
    R,
  )
  assert.deepStrictEqual(killed.sort((a, b) => a - b), [6816, 22512], '只许杀这两个')
  assert.deepStrictEqual(r.survivors, [], '复核应确认已停干净')
  assert.ok(aliveSet.has(20824), '★ 无关进程必须还活着')
})

await ta('⑨ ★★ 复核要抓得住在"假死后复活"（kill 报成功但进程还在）', async () => {
  const aliveSet = new Set([6816, 22512])
  const r = await stopAll(
    {
      snapshot: async () => SNAP,
      kill: async () => true,            // ← 谎报成功
      alive: (pid) => aliveSet.has(pid), // ← 其实还活着
    },
    R,
  )
  assert.deepStrictEqual(r.survivors.sort((a, b) => a - b), [6816, 22512], '★ 必须报出"还活着"，不许谎报停干净')
})

await ta('⑩ 没东西可停 ⇒ 不报错，如实返回空', async () => {
  const r = await stopAll({ snapshot: async () => [], kill: async () => true, alive: () => false }, R)
  assert.deepStrictEqual(r.found, [])
  assert.deepStrictEqual(r.survivors, [])
})

// ── 正交对照（铁律 13）：与"停"无关的既有推导不许被带坏 ──
console.log('\n正交对照（铁律 13）\n')
await ta('⑪ [对照] 选中的**不含**任何非本仓库路径的 pid（把自变量换成正交方向）', async () => {
  const onlyForeign = SNAP.filter((p) => ![6816, 22512].includes(p.pid))
  const s = selectDsBrainProcs(onlyForeign, R)
  assert.deepStrictEqual(s.all, [], '★ 只剩外部进程时，必须一个都不选')
})

console.log(`\n${pass} ok / ${fail} FAIL\n`)
process.exit(fail === 0 ? 0 : 1)
