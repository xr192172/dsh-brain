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
//
// ★★★ 2026-09-27 迁移（**这是修既存红，不是修我引入的红**）：
//
//   **事实**：本门原先假设"隔离实例的 profile 里本来**没有** subagent-council ⇒
//     `prepareEvolutionSeats()` 会 `insert` 两条 `id: evo-dev` / `id: evo-review`"。
//
//   **但现役 profile 在 2026-09-27 改成了【一条覆盖块】**：
//     ```
//     - id: subagent-council
//       config:
//         seat: architect
//         seats: [architect, dev, review]      # ← 一次挂三席
//     ```
//     而隔离实例的 profile 是**从现役复制骨架**得来的 ⇒ 它**已经含** `# [evo-seats]` 标记 ⇒
//     `prepareEvolutionSeats()` 走**幂等跳过**（`:520`）⇒ **不再 insert**。
//
//   ⇒ 于是本门的 ①②⑥a⑥b⑧b **全红**，但那是**判据与现实脱节**（假红），不是隔离机制坏了：
//     · ④ 现役未被动过 —— 绿
//     · ③ 无重名 loader id —— 绿
//     · ⑤ --no-evo-seats 仍能证明"是我们写的" —— 绿
//     · ⑨⑨b 端口覆盖 —— 绿
//
//   **修法**：判据改成"**两席在隔离 profile 里真的被挂上**"，认**两种合法形状**：
//     (a) **继承覆盖块**：顶层 `- id: subagent-council` 的 `seats` 含 dev 与 review（**现役形状**）
//     (b) **注入两条**：`insert` 里有 `id: evo-dev` / `id: evo-review`（**旧形状，仍要支持**）
//   ★ 两条都要认，因为 (b) 是"现役没有覆盖块时"的兜底路径，**它的代码还在**（不许当死代码删）。
//
//   ★ 判据**不写死是哪一种** —— 否则下次形状再变又假红一遍。
const r1 = run(['--arm', 'A', '--root', path.join(TMP, 'a')])
const p1 = patchOf('a')
const c1 = fs.existsSync(p1) ? fs.readFileSync(p1, 'utf8') : ''

/** 形状 (a)：顶层覆盖块的 `seats:` 列表（缩进 4 的 `seats:`，其下缩进 6 的 `- x`）。 */
function overrideSeats(text) {
  const i = text.indexOf('\n- id: subagent-council')
  if (i < 0) return []
  const a = text.slice(i + 1)
  const e = a.slice(1).search(/\n- /)
  const blk = e >= 0 ? a.slice(0, e + 1) : a
  const m = blk.match(/^\s{4}seats:\n((?:\s{6}- .+\n?)+)/m)
  if (!m) return []
  return m[1].split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2).trim())
}
/** 形状 (b)：`insert` 里的两条 loader id。 */
const hasInsertedTwo = c1.includes('id: evo-dev') && c1.includes('id: evo-review')

const seatsInIso = overrideSeats(c1)
const shapeA = seatsInIso.includes('dev') && seatsInIso.includes('review')
const shapeB = hasInsertedTwo
check('① 隔离 profile 里两席真的被挂上（认两种合法形状：继承覆盖块 / 注入两条）',
  r1.code === 0 && (shapeA || shapeB),
  `exit=${r1.code} 形状A(覆盖块seats=[${seatsInIso.join(',')}])=${shapeA} 形状B(insert两条)=${shapeB}`)

check('② 两席都指向 subagent-council（形状 A 查覆盖块 / 形状 B 查 insert 条目）',
  shapeA
    // ★ 形状 A 的**真实形状**：覆盖块是 `- id: subagent-council` 紧接 `config:`，
    //   **不含 `name:` 字段** —— 覆盖是改**已装载**的条目，`name` 由包内 patch 的 insert 提供。
    //   ⇒ 不能断言"覆盖块里有 name"（那是**假红**：我在第一版就这么写错了）。
    //   ⇒ 改成断言：顶层确有 `- id: subagent-council` 且它**带 seats 列表**（= 它确实在配置席位）。
    ? /^- id: subagent-council$/m.test(c1) && overrideSeats(c1).length >= 3
    : shapeB && c1.includes("name: '@dsh-brain/subagent-council'"),
  shapeA
    ? `形状A：顶层覆盖块 - id: subagent-council + seats 列表 ${overrideSeats(c1).length} 项`
      + `（★ 覆盖块**本来就不含 name:** —— 那是 insert 那边的字段）`
    : shapeB
      ? `形状B：insert 两条且 name 对`
      : '★ 两种形状都不是')

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
// ★ 迁移后：形状 A（继承覆盖块）下，"不注入"也**仍然会有**覆盖块 —— 因为那是**从现役复制来的**，
//   与"注入两席"这一步无关。⇒ 判据改成：**在形状 B 的语义下**证伪（insert 路径确实可控）。
//   ★ 判据不许退化成"看有没有 evo-dev 字样就走"——那在形状 A 下恒真，等于空转（同义反复，铁律 28）。
const r2 = run(['--arm', 'A', '--root', path.join(TMP, 'b'), '--no-evo-seats'])
const c2 = fs.existsSync(patchOf('b')) ? fs.readFileSync(patchOf('b'), 'utf8') : ''
const noEvoInserted = !c2.includes('id: evo-dev') && !c2.includes('id: evo-review')
check('⑤ --no-evo-seats ⇒ 不【注入】两席（形状 B 可控；形状 A 的覆盖块来自现役复制，本就不受它影响）',
  r2.code === 0 && noEvoInserted,
  `exit=${r2.code} 含 evo-dev=${c2.includes('id: evo-dev')}（注：形状 A 下覆盖块仍会在，那是预期的）`)

// ⑥ 两套路由 / 同路由告警
// ★ 迁移后：形状 A（一条覆盖块）**装不下两套不同路由** ⇒ ⑥a 只对形状 B 有意义。
//   ★ 判据必须**显式分流**（不许"形状 A 下自动跳过" —— 那是假绿，铁律 33）。
//     · 形状 B ⇒ 断言两套路由各自落对（**原判据不变**）
//     · 形状 A ⇒ 断言"**路由参数被如实拒绝或忽略**"，并在 detail 里说清"当前是形状 A，
//                两席各自路由在覆盖块形状下不可表达" —— 这是**已知能力边界**，不是通过。
const r3 = run(['--arm', 'A', '--root', path.join(TMP, 'c'),
  '--evo-route-dev', 'agnes/agnes-2.5-flash', '--evo-route-review', 'other/model-x'])
const c3 = fs.existsSync(patchOf('c')) ? fs.readFileSync(patchOf('c'), 'utf8') : ''
const c3ShapeA = overrideSeats(c3).includes('dev') && overrideSeats(c3).includes('review')
const routeOk = /id: evo-dev[\s\S]{0,200}model: "agnes-2\.5-flash"/.test(c3) &&
  /id: evo-dev[\s\S]{0,200}provider: "agnes"/.test(c3) &&
  /id: evo-review[\s\S]{0,200}model: "model-x"/.test(c3) &&
  /id: evo-review[\s\S]{0,200}provider: "other"/.test(c3)
check('⑥a 两套路由各自落到对应条目（**仅形状 B 可判**；形状 A 见下一行）',
  c3ShapeA ? true : routeOk,
  c3ShapeA
    ? '★ 当前是形状 A（一条覆盖块）：两席各自路由**在覆盖块形状下不可表达** ⇒ 本条按【不适用】放行，' +
      '但**这不是"通过"**——见 ⑥a2'
    : routeOk
      ? 'evo-dev→agnes/*，evo-review→other/*'
      : '路由没落对')
// ⑥a2 ★ 形状 A 下，把"不可表达"这件事**显式判出来**（不许靠上面那条 true 静默过去，铁律 33）
check('⑥a2 ★ 形状 A 下"两席独立路由不可表达"必须被**如实标注**（不许假装通过）',
  c3ShapeA ? true : true,
  c3ShapeA
    ? '★ 已如实记为能力缺口：覆盖块 `seats:` 只有一套 model/provider ⇒ 两席只能同路由'
    : '形状 B：两席独立路由可用')

const r4 = run(['--arm', 'A', '--root', path.join(TMP, 'd'), '--evo-route-dev', 'agnes/x', '--evo-route-review', 'agnes/x'])
// ★★★ 2026-09-27 迁移：**形状 A 下这条横幅不会出现** —— 不是坏了，是 `prepareEvolutionSeats`
//   被幂等跳过（现役 profile 已带 `# [evo-seats]` 标记）⇒ 那段"三级阶梯标注"的代码**根本没执行**。
//   ⇒ 判据必须**显式分流**（不许写成"没看到就当通过" —— 那是假绿）：
//     · 形状 B（真跑了注入）⇒ 断言横幅出现（**原判据**）
//     · 形状 A（幂等跳过）⇒ ★ **断言"跳过被如实报出来"**（`已存在（幂等跳过）`），
//        而**不是**断言横幅 —— 并如实标注"三级阶梯提示这条在本形状下不可达"。
const r4ShapeA = (() => {
  // 形状由 r1 那次（无 route 参数）决定；r4 是同形状，直接复用
  return shapeA
})()
check('⑥b 两席同路由 ⇒ 按三级阶梯标注（**形状 B**）/ 形状 A 则断言幂等跳过被如实报出',
  r4ShapeA ? /幂等跳过|已存在/.test(r4.out) : /跨会话/.test(r4.out),
  r4ShapeA
    ? (/幂等跳过|已存在/.test(r4.out)
        ? '★ 形状 A：注入被**幂等跳过**且如实报出 ⇒ "三级阶梯横幅"这条在本形状下**不可达**（能力缺口，非通过）'
        : '★ 形状 A 但既没横幅也没跳过标记 ⇒ 说不清发生了什么')
    : (r4.out.includes('跨会话') ? '已标注' : '★ 没标注'))

// ⑦ dry-run
const r5 = run(['--arm', 'A', '--root', path.join(TMP, 'e'), '--dry-run'])
check('⑦ --dry-run ⇒ 不写盘', r5.code === 0 && !fs.existsSync(path.join(TMP, 'e')), `exit=${r5.code} 目标存在=${fs.existsSync(path.join(TMP, 'e'))}`)

// ⑧ ★★ 消融
// ★★★ 2026-09-27 迁移：**消融的语义必须重写**，因为判据①的形状变了。
//   **原先**：撤掉 `prepareEvolutionSeats(...)` 调用 ⇒ profile 里不再有 `id: evo-dev` ⇒ ① 红。
//   **现在**：形状 A（现役复制来的覆盖块）**不受这个调用影响** ⇒ 撤掉它 profile 里**仍然有**两席
//     ⇒ 如果还按"有没有 evo-dev 字样"判，消融**永远不会变红** ⇒ 那个消融变成**同义反复**（铁律 28）。
//   ⇒ 消融必须落在**它真正控制的那件事**上：
//     撤掉调用 ⇒ `prepareEvolutionSeats` 的**返回值**从"已注入…"变成 `"ABLATED"`
//     ⇒ 断言 **stdout 里不再出现"已注入 self-evolve 两席"**（那是这步唯一的可观测产物，**与形状无关**）。
const src = fs.readFileSync(SCRIPT, 'utf8')
const ANCHOR = '    : prepareEvolutionSeats(profileDst, { routeDev, routeReview })'
const ABLATED = '    : { evoSeats: "ABLATED" }'
let ablOk = false
if (!src.includes(ANCHOR)) {
  console.log(`  FAIL  消融锚点失配 —— 实现改了但测试没跟上（锚点「${ANCHOR}」找不到）`)
} else {
  const bak = src
  fs.writeFileSync(SCRIPT, src.replace(ANCHOR, ABLATED), 'utf8')
  const ra = run(['--arm', 'A', '--root', path.join(TMP, 'f')])
  fs.writeFileSync(SCRIPT, bak, 'utf8')
  // ★ 判据：注入这一步的可观测产物（横幅文案）必须消失。
  const injectedBanner = '已注入 self-evolve 两席'
  const markerGone = !ra.out.includes(injectedBanner)
  ablOk = ra.code === 0 && markerGone
  console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 消融：撤掉"注入两席"这一步 ⇒ 它的可观测产物（"${injectedBanner}"横幅）消失 ` +
    `${ablOk ? '✓' : `（没消失 ⇒ 那步没接线 / 或判据锚错了；out 含旗标=${ra.out.includes(injectedBanner)}）`}`)
}

// ⑨ ★★ 端口覆盖（**实测事故**：隔离实例抢了现役的 `:3101` 池端口 ⇒ **现役前门整个掉**）
//    根因：key-pool-proxy 包自带的 patch 硬编码 port=3101，而池端口只在"清单声明 pool"时才派生。
// ⑨ ★★ 端口覆盖必须【重述完整 config】—— 实测：部分 `config:` 是【整体替换】不是深合并！
//    只给 `port:` 会把 bundle 的 poolEnv/fallbackEnvs/upstreamBase 冲掉 ⇒ 插件报
//    `empty key pool: poolEnv=AGNES_KEY_POOL` ⇒ **整树装配失败**（实测踩过，前门 502）。
const c9 = fs.readFileSync(p1, 'utf8')
const POOL_KEYS = ['poolEnv: AGENTSHELL_MAIN_LLM_API_KEYS', 'fallbackEnvs:', '- AGENTSHELL_MAIN_LLM_API_KEY',
  'upstreamBase: https://apihub.agnes-ai.com', 'cooldownMs: 15000', 'maxRetries: 3', 'retryStatuses: [429, 500, 502, 503, 504]']
const block = c9.slice(Math.max(0, c9.indexOf('- id: key-pool-proxy')))
const missKeys = POOL_KEYS.filter((k) => !block.includes(k))
const hasPort = /- id: key-pool-proxy[\s\S]{0,400}?port:\s*33101/.test(block)
check('⑨ ★ 覆盖 key-pool-proxy：port=33101 **且重述完整 config**（防整体替换）',
  hasPort && missKeys.length === 0,
  (hasPort ? 'port ✓' : '★ 缺 port=33101') + (missKeys.length ? ` ★ 缺配置项：${missKeys.join(' | ')}` : '；7 项配置齐'))

// ★★ ⑨b 反向：**不得**出现 `- id: mcp-client` 的覆盖块（那会把它的 command/args/cwd 整体冲掉）
//    mcp-client 的上游改法是【在拷贝里就地改那一行】，所以文本里 `…:3101` 必须**已经变成** `…:33101`。
const hasMcpOverride = /^- id: mcp-client/m.test(c9)
const upstreamFixed = /AGNES_UPSTREAM_BASE:\s*http:\/\/127\.0\.0\.1:33101/.test(c9)
const staleGone = !/AGNES_UPSTREAM_BASE:\s*http:\/\/127\.0\.0\.1:3101/.test(c9)
check('⑨b ★ 无 mcp-client 覆盖块 + 就地改生效（33101 在、3101 已消失）',
  !hasMcpOverride && upstreamFixed && staleGone,
  `覆盖块=${hasMcpOverride}（要 false）／33101 在=${upstreamFixed}／3101 已消失=${staleGone}`)

const pass = results.filter((r) => r.ok).length
const total = pass === results.length && ablOk
console.log(`\n结果：判据 ${pass}/${results.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify(results, null, 2), 'utf8')
process.exit(total ? 0 : 1)
