// test-evo-seats-mount.mjs —— 判据：隔离实例是否**只在自己的 profile 里**挂上自进化的两席
//
// 依据：`docs/training-ground-and-skill-sieve-2026-09-25.md` §11（用户口述）
//       + `docs/revised-architecture-2026-09-20.md` §7（三段流水线 / §:218 防串供）。
//
// 判据（7 条 + 消融；★ 全部用**工作目录内**的 `--root`，不碰现役）：
//   ① 默认（不给 flag）⇒ 隔离 profile 的 `cordis.patch.yml` 里出现 evo-dev / evo-review 两条
//   ② 两条的 `name` 都是 `@dsh-brain/subagent-council`，且 `seat` 分别是 dev / review
//   ③ ★★ **没有重名 loader id**（本项目铁律：同 id ⇒ `duplicate loader entry id` ⇒ 整树装配失败）
//   ④ ★★ **现役 profile 一个字节没动**（跑前跑后比 mtime + 内容哈希）
//   ⑤ `--no-evo-seats` ⇒ **不写**（= 证明这两条确实是我们写的，不是本来就有的）
//   ⑥ 给两套路由 ⇒ 各自的 `model`/`provider` 落进对应条目；**两套相同 ⇒ 输出按三级阶梯标注只到【跨会话】档**
//   ⑦ `--dry-run` ⇒ 不写盘
//   ⑧ 消融：撤掉"注入两席"这一步 ⇒ 判据① **必须变红**
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const WT = 'D:/project_develop/dsh-brain'
const SCRIPT = path.join(WT, 'scripts/delegation/isolated-instance.mjs')
const NODE = process.execPath
const LIVE_PATCH = 'C:/Users/Admin/.dsh/profiles/web/cordis.patch.yml'
const TMP = path.join(WT, 'out/_evoseats-test')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const results = []
const check = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16) : '(缺)')
const mtime = (f) => (fs.existsSync(f) ? fs.statSync(f).mtime.toISOString() : '(缺)')

function run(args) {
  const r = spawnSync(NODE, [SCRIPT, ...args], { encoding: 'utf8', timeout: 180000 })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const patchOf = (root) => path.join(TMP, root, 'dshhome/profiles/web/cordis.patch.yml')

const liveBefore = { sha: sha(LIVE_PATCH), mtime: mtime(LIVE_PATCH) }

// ① ② ③
const r1 = run(['--arm', 'A', '--root', path.join(TMP, 'a')])
const p1 = patchOf('a')
const c1 = fs.existsSync(p1) ? fs.readFileSync(p1, 'utf8') : ''
check('① 默认 ⇒ 注入 evo-dev / evo-review 两条', r1.code === 0 && c1.includes('id: evo-dev') && c1.includes('id: evo-review'), `exit=${r1.code}`)
check('② 两条都指向 subagent-council 且 seat 正确',
  c1.includes("name: '@dsh-brain/subagent-council'") && /id: evo-dev[\s\S]{0,120}seat: dev/.test(c1) && /id: evo-review[\s\S]{0,120}seat: review/.test(c1),
  'name 与 seat 都对')

// ★ ③ 要**分组**看：`insert:` 里嵌套的 id 与**顶层**覆盖的 id 语义不同 ——
//   同一个名字**出现在两组里**正是"覆盖"该有的样子（不是重复！）。
//   真正要防的重复是：**同一组内**出现两次（那才会 duplicate loader entry id）。
const topIds = [...c1.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1])
const insIds = [...c1.matchAll(/^\s{4}- id:\s*(\S+)/gm)].map((m) => m[1])
const dupOf = (a) => a.filter((x, i) => a.indexOf(x) !== i)
const dupTop = dupOf(topIds), dupIns = dupOf(insIds)
check('③ 无重名 loader id（**分组内**各不重复；跨组同名 = 覆盖，是预期）',
  dupTop.length === 0 && dupIns.length === 0,
  `顶层覆盖=[${topIds.join(', ')}] ／ insert=[${insIds.join(', ')}]` + (dupTop.length + dupIns.length ? ` ★ 组内重复：${[...dupTop, ...dupIns].join(', ')}` : ''))

// ④ 现役没动
check('④ ★ 现役 profile 未被动过', liveBefore.sha === sha(LIVE_PATCH) && liveBefore.mtime === mtime(LIVE_PATCH),
  `sha ${liveBefore.sha}→${sha(LIVE_PATCH)} / mtime ${liveBefore.mtime}→${mtime(LIVE_PATCH)}`)

// ⑤ --no-evo-seats
const r2 = run(['--arm', 'A', '--root', path.join(TMP, 'b'), '--no-evo-seats'])
const c2 = fs.existsSync(patchOf('b')) ? fs.readFileSync(patchOf('b'), 'utf8') : ''
check('⑤ --no-evo-seats ⇒ 不注入（证明是我们写的）',
  r2.code === 0 && !c2.includes('id: evo-dev') && !c2.includes('id: evo-review'),
  `exit=${r2.code} 含 evo-dev=${c2.includes('id: evo-dev')}`)

// ⑥ 两套路由 / 同路由告警
const r3 = run(['--arm', 'A', '--root', path.join(TMP, 'c'),
  '--evo-route-dev', 'agnes/agnes-2.5-flash', '--evo-route-review', 'other/model-x'])
const c3 = fs.existsSync(patchOf('c')) ? fs.readFileSync(patchOf('c'), 'utf8') : ''
const routeOk = /id: evo-dev[\s\S]{0,200}model: "agnes-2\.5-flash"/.test(c3) &&
  /id: evo-dev[\s\S]{0,200}provider: "agnes"/.test(c3) &&
  /id: evo-review[\s\S]{0,200}model: "model-x"/.test(c3) &&
  /id: evo-review[\s\S]{0,200}provider: "other"/.test(c3)
check('⑥a 两套路由各自落到对应条目', routeOk, routeOk ? 'evo-dev→agnes/*，evo-review→other/*' : '路由没落对')
const r4 = run(['--arm', 'A', '--root', path.join(TMP, 'd'), '--evo-route-dev', 'agnes/x', '--evo-route-review', 'agnes/x'])
check('⑥b 两席同路由 ⇒ 输出按【三级阶梯】标注只到跨会话档', /跨会话/.test(r4.out), r4.out.includes('跨会话') ? '已标注' : '★ 没标注')

// ⑦ dry-run
const r5 = run(['--arm', 'A', '--root', path.join(TMP, 'e'), '--dry-run'])
check('⑦ --dry-run ⇒ 不写盘', r5.code === 0 && !fs.existsSync(path.join(TMP, 'e')), `exit=${r5.code} 目标存在=${fs.existsSync(path.join(TMP, 'e'))}`)

// ⑧ ★★ 消融
const src = fs.readFileSync(SCRIPT, 'utf8')
const ANCHOR = '    : prepareEvolutionSeats(profileDst, { routeDev, routeReview })'
const ABLATED = '    : { evoSeats: "ABLATED" }'
let ablOk = false
if (!src.includes(ANCHOR)) {
  console.log('  ★ 消融锚点失配 —— 必须重写（不许模糊匹配）')
} else {
  const bak = src
  fs.writeFileSync(SCRIPT, src.replace(ANCHOR, ABLATED), 'utf8')
  const ra = run(['--arm', 'A', '--root', path.join(TMP, 'f')])
  const ca = fs.existsSync(patchOf('f')) ? fs.readFileSync(patchOf('f'), 'utf8') : ''
  fs.writeFileSync(SCRIPT, bak, 'utf8')
  ablOk = ra.code === 0 && !ca.includes('id: evo-dev')
  console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 消融：撤掉"注入两席" ⇒ 判据① 变红 ${ablOk ? '✓' : '（没变红 ⇒ 那步没接线）'}`)
  // 还原自证
  const rr = run(['--arm', 'A', '--root', path.join(TMP, 'g')])
  const cr = fs.existsSync(patchOf('g')) ? fs.readFileSync(patchOf('g'), 'utf8') : ''
  const restored = cr.includes('id: evo-dev')
  check('⑧b 还原后复绿', restored, `还原后含 evo-dev=${restored}（exit=${rr.code}）`)
}

// ⑨ ★★ 端口覆盖（**实测事故**：隔离实例抢了现役的 `:3101` 池端口 ⇒ **现役前门整个掉**）
//    根因：key-pool-proxy 包自带的 patch 硬编码 port=3101，而池端口只在"清单声明 pool"时才派生。
const c9 = fs.readFileSync(p1, 'utf8')
const hasPoolOverride = /- id: key-pool-proxy[\s\S]{0,160}?port:\s*33101/.test(c9)
check('⑨ ★ 覆盖 key-pool-proxy.port = 33101（避开现役的 3101）', hasPoolOverride, hasPoolOverride ? '已覆盖' : '★ 没覆盖 ⇒ 会抢现役的 3101')
// ★ ⑨b 改成**断言"覆盖存在且指向本段端口"** —— 不能用"不得出现 3101"：
//   因为 profile 是从现役**复制**来的，那个 `mcp-client.env.AGNES_UPSTREAM_BASE: …:3101` 的**原文仍在**，
//   我们只是**在后面追加了覆盖**（生效值以覆盖为准）⇒ "文本里没有 3101" 是**做不到**的要求（我第一版写成那样 = 假判据）。
const hasUpstreamOverride = /- id: mcp-client[\s\S]{0,200}?AGNES_UPSTREAM_BASE:\s*http:\/\/127\.0\.0\.1:33101/.test(c9)
check('⑨b ★ 覆盖 mcp-client.env.AGNES_UPSTREAM_BASE → 本段池端口', hasUpstreamOverride, hasUpstreamOverride ? '已覆盖为 33101' : '★ 没覆盖 ⇒ 隔离实例会用现役的池')

const pass = results.filter((r) => r.ok).length
const total = pass === results.length && ablOk
console.log(`\n结果：判据 ${pass}/${results.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify(results, null, 2), 'utf8')
process.exit(total ? 0 : 1)
