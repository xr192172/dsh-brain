#!/usr/bin/env node
/**
 * mem-arm.mjs —— O80：把「记忆库」接进被测 agent 的**一条臂**，并**从会话日志取证**。
 *
 * ## 它做什么（严格按顺序）
 *   ① 渲染：调 `out/memprompt.exe render --db <store>`（Go 侧，复用 KnowledgeStore）
 *   ② 落载体：把渲染结果包进一个固定模板，写进 `<cwd>/AGENTS.md`（UTF-8 无 BOM）
 *      —— 这是 **DSH 侧既有的、活着的注入面**：`@deepseek-ai/dsh-agent-instructions`
 *         在会话第一个 `agent/pre-step` 把 cwd 链上的 AGENTS.md 作为**持久 user 角色消息**
 *         注入（`source.kind = "agent-instructions"`），**step 1 就到达第一次请求**，
 *         且**不碰 tools 段**（工具面不变）。
 *   ③ 起会话：`session.create { cwd, agentPreset: 'council' }`（★ 永远新建，不碰用户会话）
 *   ④ 发题：`session.prompt` 一条**极小任务**（不需要任何工具调用）
 *   ⑤ 等待空闲，然后**读会话日志**取证：
 *      - 独特短语是否出现（出现 ⇒ 在提示词里）；出现在哪条事件 / 什么 source / 偏移多少
 *      - `request/header` 的 system 长度与**工具名集合**（用于两臂"脸"对比）
 *   ⑥ 把原始读数写成 `out/w29-arm-<name>.json`，并打印人读版
 *
 * ## 两臂隔离
 *   · 记忆库（store）= 一个**数据目录**，真实记忆落在 `<store>/knowledge_base.json`
 *     （与 `cmd/memface` 逐字同一约定）。A/B 各给一个目录 ⇒ **互不污染**。
 *   · 注入载体（carrier）= `<cwd>/AGENTS.md`，A/B 各给一个 cwd 目录 ⇒ **互不污染**。
 *   · ★ 两个 cwd 的**路径长度刻意取相同**（mem-arm-A / mem-arm-B），
 *     免得 cwd 长度差异泄进 `system`（sandbox policy 里带 workspace 绝对路径）。
 *
 * ## ★★ O85（2026-09-22）：`--root` —— 把 wt 与 store 一起放到判据根**之外**
 *
 * **上一轮的场地错在哪**（两条泄漏都在这一个地方）：
 *   · 默认值是 `<判据根>/out/mem-store-<臂>` 与 `<判据根>/out/mem-arm-<臂>`
 *     ⇒ ① 载体目录在判据根内部（`..` 两层回去就是 `dsh-brain/`）；
 *   · ★★ 更坏的是：**两臂的 store 与产物都在同一个 `out/` 下**
 *     ⇒ **A 臂的相对路径直接到得了 B 臂的记忆库**（`../mem-store-B/knowledge_base.json`）
 *     ⇒ **A/B 就不再是两臂了**（自变量泄漏）。
 *
 * **新口径**：每臂一个**独立的实验根**，落在判据根之外，且两臂**不共享**实验根：
 *   ```
 *   D:/project_develop/_abA/{wt,store}      ← A 臂
 *   D:/project_develop/_abB/{wt,store}      ← B 臂（与 A 的祖先链只共到 D:/project_develop）
 *   node scripts/mem-arm.mjs --name A --root D:/project_develop/_abA --expect present
 *   ```
 *   ⇒ `--root <R>` 的语义：`store = <R>/store`、`cwd = <R>/wt`（`wt` 必须是
 *   `scripts/eval-wt-new.mjs --root <R> --name wt` 建出来的**工作树**，否则拒绝跑）。
 *   · `--store` / `--cwd` 显式给出时**优先于** `--root`（逐字保留旧用法，不弱化任何东西）；
 *   · 证据文件默认仍写 `out/w29-arm-<name>.json`；给了 `--root` 且没给 `--evidence` 时
 *     改写 `<root>/evidence/w29-arm-<name>.json`（**臂的产物留在臂的根下**）。
 * ★★ **这不是沙箱**：被测 agent 有 `pwsh` ⇒ 可以 `cd` 到任何地方、可以 `ls ..`、
 *   可以走绝对路径。本布置只堵三条：① cwd 子树 ② 祖先链 ③ 两臂互见（朴素相对路径）。
 *   残余风险见 `out/w31-o85-isolation.md`。
 *
 * ## ★★ O86（2026-09-22）：上面那条 O85 的场地**仍然漏了嘴** —— 两臂必须**分处不同卷**
 *
 * **实测（O85 的场地，两臂同卷且互为兄弟）**：
 *   ```
 *   D:/project_develop/_abA/{wt,store}      ← A 臂
 *   D:/project_develop/_abB/{wt,store}      ← B 臂
 *   ```
 *   `D:/project_develop/_abA/wt/../../_abB/store/knowledge_base.json` **真的存在**
 *   ⇒ **A 臂用一条相对路径就读到了 B 臂的记忆库** ⇒ 自变量泄漏 ⇒ **A/B 不再是两臂**。
 *   O85 把它记成"长回旋可达"的**残余**，但那不是残余，那是**判据本身**。
 *
 * ★ **为什么"同卷换个非兄弟根"救不了**：`..` 在**同一个卷内是无界的**。
 *   把 B 挪到 `D:/_abB`（不是兄弟了）只是把"上两级"变成"上三级"——**知道名字就照样到得了**。
 *   ⇒ 唯一能把"**任意相对路径**"真正堵死的办法是**让两臂不在同一个卷**：
 *     相对路径**永远跨不过卷根**（`D:\` ↔ `C:\`）。
 *
 * **本轮口径（跨卷；A 臂不动，B 臂挪到另一个卷）**：
 *   ```
 *   D:/project_develop/_abA/{wt,store}      ← A 臂（判据根所在卷 D:）
 *   C:/_abB-experiment-root/{wt,store}      ← B 臂（另一个卷；两臂祖先链交集 = ∅）
 *   node scripts/mem-arm.mjs --name B --root C:/_abB-experiment-root --peer D:/project_develop/_abA --expect absent
 *   ```
 *   · ★ **B 的目录名凑成 20 字符是有意的**：本文件下面那条"两臂 cwd 路径长度必须相同"的
 *     约束要求 `C:/_abB-experiment-root/wt`（26）与 `D:/project_develop/_abA/wt`（26）**等长**。
 *   · ★★ `--peer <另一臂的实验根>`：**跑会话之前**先机器判定"本臂能不能用相对路径够到对方"，
 *     够得到就 **exit 2 拒跑**（fail-closed）—— 宁可不给结论，也不在一次已经泄漏的场地上跑会话。
 *     判据与 `scripts/eval-wt-new.mjs --peer` 的 [10] 步同源（同一条口径、同一批实探）。
 *   · ★★ **仍然不是沙箱**：A 臂在 D: 卷 ⇒ 长回旋相对路径照样回得到判据根与 `D:` 上的任何东西。
 *     本文件只保证**臂间**不互见。残余风险见 `out/w32-o86-arms.md`。
 *
 * ## 用法
 *   node scripts/mem-arm.mjs --name A --store <dir> --cwd <dir> [--expect present|absent] [--phrase <p>]
 *   node scripts/mem-arm.mjs --name A --root D:/project_develop/_abA --expect present
 *   ★ O86（跨卷两臂，别忘 --peer）：
 *   node scripts/mem-arm.mjs --name B --root C:/_abB-experiment-root --peer D:/project_develop/_abA --expect absent
 *   例：
 *   node scripts/mem-arm.mjs --name treat --store out/mem-store-treat --cwd out/mem-arm-treat --expect present
 *   node scripts/mem-arm.mjs --name ctrl  --store out/mem-store-ctrl  --cwd out/mem-arm-ctrl  --expect absent
 *
 * ★ 本脚本只做：只读 RPC（session.create / session.prompt / session.list）+ 写两个**新建目录**。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { decompress } from 'fzstd'

const REPO = 'D:/project_develop/dsh-brain'
const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const SESS_ROOT = 'C:/Users/Admin/.dsh/sessions'
const MEMPROMPT = path.join(REPO, 'out', 'memprompt.exe')
const MAX_MS = 240000

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const has = (k) => argv.includes(k)

const NAME = argOf('--name') ?? 'arm'
/** ★ O85：实验根。给了它 ⇒ `store=<root>/store`、`cwd=<root>/wt`（两臂各一个，互不共享）。 */
const ROOT_ARG = argOf('--root')
const ROOT = ROOT_ARG ? path.resolve(ROOT_ARG) : null
if (ROOT_ARG && !path.isAbsolute(ROOT_ARG)) {
  console.log(`[stop] --root 必须是绝对路径（用 D:/… 而不是 /d/…）：${ROOT_ARG}`)
  process.exit(2)
}
/** ★★ O86：另一臂的实验根。给了它 ⇒ 起会话**之前**先判定"本臂够不到对方"（够得到就 exit 2）。 */
const PEER_ARG = argOf('--peer')
if (PEER_ARG && !path.isAbsolute(PEER_ARG)) {
  console.log(`[stop] --peer 必须是绝对路径（用 D:/… 而不是 /d/…）：${PEER_ARG}`)
  process.exit(2)
}
/** `--store` ＞ `--root`/store ＞ 旧缺省 `out/mem-store-<name>`（**旧缺省逐字不变**）。 */
const STORE = argOf('--store')
  ? path.resolve(argOf('--store'))
  : ROOT
    ? path.join(ROOT, 'store')
    : path.resolve(REPO, `out/mem-store-${NAME}`)
/** `--cwd` ＞ `--root`/wt ＞ 旧缺省 `out/mem-arm-<name>`（**旧缺省逐字不变**）。 */
const CWD = argOf('--cwd')
  ? path.resolve(argOf('--cwd'))
  : ROOT
    ? path.join(ROOT, 'wt')
    : path.resolve(REPO, `out/mem-arm-${NAME}`)
const PHRASE = argOf('--phrase') ?? 'ZXQ-MEM-PROBE-7f3a91-DO-NOT-LEAK'
const EXPECT = argOf('--expect') ?? null // present | absent | null(只报)
const TASK = argOf('--task') ?? '只回一个字：好'
/** ★ O85：证据落点。给了 `--root` 且没给 `--evidence` ⇒ 留在**臂的根下**。 */
const EVIDENCE = argOf('--evidence')
  ? path.resolve(argOf('--evidence'))
  : ROOT
    ? path.join(ROOT, 'evidence', `w29-arm-${NAME}.json`)
    : path.join(REPO, 'out', `w29-arm-${NAME}.json`)

/* ── 载体模板（唯一的"策略"处，集中在这里，便于审阅与替换）────────────
 * 两臂用**逐字相同**的模板，只有「记忆条目块」不同 ⇒ 差异只有自变量本身。 */
const HEADING = `# 记忆注入（由 scripts/mem-arm.mjs 从记忆库渲染，勿手改）`
const EMPTY_NOTE = '（本题的记忆库为空：没有可注入的条目）'
const PREFACE = '以下条目来自本会话绑定的记忆库。它们可能与本任务相关；相关则纳入判断，无关则忽略。'

/* ── 小工具 ─────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const sha8 = (s) => sha256(s).slice(0, 8)
const toolNameOf = (t) => t?.name ?? t?.function?.name ?? ''
const textOf = (c) => {
  if (c == null) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' ? (p.text ?? '') : String(p))).join('\n')
  if (typeof c === 'object' && typeof c.text === 'string') return c.text
  return ''
}

async function rpc(method, payload) {
  const res = await fetch(`${FRONT}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, json: null, text: text.slice(0, 400) } }
}
const valOf = (r) => r?.json?.result?.value
const errOf = (r) => r?.json?.result?.error ?? r?.json?.error ?? (r?.json ? null : { raw: r?.text })

function findSessionFile(sid) {
  for (const proj of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const f = path.join(SESS_ROOT, proj.name, sid, 'session.jsonl.zstd')
    if (fs.existsSync(f)) return { proj: proj.name, file: f }
  }
  return null
}
function readEvents(file) {
  const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

/* ── ① 渲染 + ② 落载体 ─────────────────────────────────────── */
/** ★ O85：祖先链（自下而上到盘符根）。纯只读。 */
function ancestorsOf(p) {
  const out = []
  let cur = path.resolve(p)
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) return out
    out.push(parent)
    cur = parent
  }
}
const isInside = (anc, p) => {
  const rel = path.relative(path.resolve(anc), path.resolve(p)).replace(/\\/g, '/')
  return rel === '' || (!rel.startsWith('../') && !path.isAbsolute(rel))
}
const ANC = ancestorsOf(CWD)
const JUDGE_ROOT_IN_ANCESTORS = ANC.includes(path.resolve(REPO))
const INSIDE_JUDGE_ROOT = isInside(REPO, CWD)

console.log(`===== 臂 ${NAME} =====`)
console.log(`[root  ] ${ROOT ?? `（未给 --root ⇒ 缺省：${path.join(REPO, 'out')} —— ★ 两臂的 store/产物会同处判据根的 out/ 下）`}`)
console.log(`[store ] ${STORE}`)
console.log(`[cwd   ] ${CWD}`)
console.log(`[evidence] ${EVIDENCE}`)
console.log(`[isolation] 判据根在 cwd 祖先链上 = ${JUDGE_ROOT_IN_ANCESTORS ? '**是**' : '否'}；cwd 在判据根内部 = ${INSIDE_JUDGE_ROOT ? '**是**' : '否'}`)
console.log(`[ancestors] ${ANC.join('  <  ')}`)
if (JUDGE_ROOT_IN_ANCESTORS || INSIDE_JUDGE_ROOT) {
  console.log(`  ⚠ 这条臂的 cwd 在判据根内/其祖先链上 ⇒ 判据（scripts/ evals/ out/，且 out/ 里有**另一臂**的 store）`)
  console.log(`    对被测 agent 随手可及 ⇒ R1 未成立。要真隔离：--root D:/project_develop/_ab<臂名>`)
}
if (ROOT) {
  console.log(`[root  ] ★ 实验根已在判据根之外；两臂用**各自的根**（互不共享子目录）⇒ 自变量不互见`)
}

/* ── ★ O85 守卫：给了 --root ⇒ cwd 必须是**已建好的工作树**，不许在这里凭空造目录 ──
 * 为什么：`--root` 的语义是"这条臂的场地已在那个根下建好了"（wt = 判据够不到的工作树）。
 * 若 cwd 不存在就 mkdir，会造出一个**没有 git、没有源码**的空壳并照常注入 ⇒ 读数没意义。
 * ⇒ 拒绝跑，并把建树的命令原样打出来（宁可不给结论，也不给一个用错场地的结论）。 */
if (ROOT && !argOf('--cwd')) {
  if (!fs.existsSync(CWD)) {
    console.log(`[stop] ${CWD} 不存在 ⇒ 先建工作树：`)
    console.log(`       node scripts/eval-wt-new.mjs --root ${ROOT} --name wt`)
    process.exit(2)
  }
  if (!fs.existsSync(path.join(CWD, '.git'))) {
    console.log(`[stop] ${CWD} 不是 git 工作树（缺 .git）⇒ 拒绝把注入载体写进一个非工作树的目录`)
    console.log(`       node scripts/eval-wt-new.mjs --root ${ROOT} --name wt`)
    process.exit(2)
  }
}

/* ── ★★ O86 守卫：给了 `--peer` ⇒ **在起会话之前**判定"本臂够不到另一臂"，够得到就拒跑 ──
 * 为什么放在这里（而不是只打印一行提醒）：这是**场地判据**，不是礼仪。
 *   一次已经泄漏的场地里跑出来的读数**没有解释价值**（A 能看到 B 的记忆 ⇒ 自变量不再受控），
 *   而会话一旦发起就已经产生了"这条臂跑过记忆"的副作用。
 *   ⇒ fail-closed：**宁可不给结论，也不给一个用错场地的结论**（与上面 `--root` 守卫同一纪律）。
 * 判据与 `scripts/eval-wt-new.mjs` 的 `[10]` 步**同源**（该文件里有完整的三条依据说明）：
 *   ① 卷根必须不同（相对路径跨不过卷根）② 对方不在祖先链上 ③ 长回旋候选全部 ENOENT。
 *   ★ 这条判据用的是**同一份口径**，不是"另一套平行实现"。
 * 想明知故犯地跑：`--allow-peer-visible`（只在复现实验里用，正常跑别给）。 */
if (PEER_ARG) {
  const peer = path.resolve(PEER_ARG)
  const volumeOf = (p) => path.parse(path.resolve(p)).root.toLowerCase()
  const volCwd = volumeOf(CWD)
  const volPeer = volumeOf(peer)
  const volumeDiffers = volCwd !== volPeer
  const relRaw = path.relative(path.resolve(CWD), peer)
  const peerInAncestors = ancestorsOf(CWD).map((a) => a.toLowerCase()).includes(peer.toLowerCase())
  const peerBase = path.basename(peer)
  const probes = []
  for (let k = 1; k <= 5; k++) {
    for (const sub of ['', 'store', 'store/knowledge_base.json', 'wt']) {
      const rel = `${'../'.repeat(k)}${peerBase}${sub ? '/' + sub : ''}`
      probes.push({ rel, exists: fs.existsSync(path.resolve(CWD, rel)) })
    }
  }
  const reachable = probes.filter((p) => p.exists)
  const peerExists = fs.existsSync(peer)
  const ok = peerExists && volumeDiffers && !peerInAncestors && reachable.length === 0
  console.log(`[peer  ] ${peer}   存在=${peerExists}`)
  console.log(`[peer  ] 卷：本臂 ${volCwd}  vs  另一臂 ${volPeer}  ⇒ ${volumeDiffers ? '不同卷（相对路径跨不过去）' : '**同卷**（`..` 无界 ⇒ 长回旋可达）'}`)
  console.log(`[peer  ] path.relative(本臂 cwd → 另一臂) = ${relRaw.replace(/\\/g, '/')}${path.isAbsolute(relRaw) ? '   ★ 回落成绝对路径 = 相对路径表达不出这条路' : '   ★ 是相对路径 ⇒ 可达'}`)
  console.log(`[peer  ] 另一臂在本臂祖先链上？ ${peerInAncestors ? '**是**' : '否'}；长回旋相对路径实探：可达 ${reachable.length}/${probes.length}${reachable.length ? `（${reachable.map((p) => p.rel).join(' , ')}）` : ''}`)
  if (!ok && !has('--allow-peer-visible')) {
    console.log('')
    console.log(`[stop] ★★ O86：本臂**够得到**另一臂 ⇒ 这不是两臂，自变量泄漏 ⇒ **拒跑**（不起会话、不写载体）`)
    console.log(`       要真隔离：两臂必须落在**不同的卷**（相对路径永远跨不过卷根）。例：`)
    console.log(`         node scripts/eval-wt-new.mjs --root C:/_abB-experiment-root --name wt --peer D:/project_develop/_abA`)
    console.log(`         node scripts/mem-arm.mjs --name B --root C:/_abB-experiment-root --peer D:/project_develop/_abA`)
    console.log(`       明知故犯（只在复现实验里用）：--allow-peer-visible`)
    process.exit(2)
  }
  console.log(`[peer  ] ⇒ ${ok ? '★ 两臂互不可见（含长回旋）✓' : '▲ 已用 --allow-peer-visible 放行（读数**不可解释**）'}`)
}

if (!fs.existsSync(MEMPROMPT)) {
  console.log(`[stop] 找不到 ${MEMPROMPT}（先在 ai-base/agent-shell 跑 go build -o ${MEMPROMPT} ./cmd/memprompt）`)
  process.exit(2)
}
const rm = spawnSync(MEMPROMPT, ['render', '--db', STORE], { encoding: 'utf8' })
console.log(`[render] exit=${rm.status} stdout=${(rm.stdout ?? '').trim().slice(0, 400)}`)
console.log(`[render] stderr=${(rm.stderr ?? '').trim().slice(0, 300)}`)
if (rm.status !== 0) { console.log('[stop] memprompt render 失败'); process.exit(2) }
const rendered = JSON.parse((rm.stdout ?? '').trim())
console.log(`[render] count=${rendered.count} items=${rendered.items} bytes=${rendered.bytes}`)

const memBlock = rendered.items > 0 ? rendered.text : EMPTY_NOTE
const carrier = `${HEADING}\n\n${PREFACE}\n\n${memBlock}\n`
fs.mkdirSync(CWD, { recursive: true })
const carrierPath = path.join(CWD, 'AGENTS.md')
fs.writeFileSync(carrierPath, carrier, 'utf8')
const carrierRaw = fs.readFileSync(carrierPath)
console.log(`[carrier] ${carrierPath} bytes=${carrierRaw.length} sha256=${sha256(carrierRaw.toString('utf8')).slice(0, 16)}`)
console.log(`[carrier] BOM=${carrierRaw[0] === 0xef && carrierRaw[1] === 0xbb && carrierRaw[2] === 0xbf}`)
console.log(`[carrier] 含短语=${carrier.includes(PHRASE)}`)

/* ── ③ 建会话（永远新建）───────────────────────────────────── */
const winCwd = CWD.replace(/\//g, '\\')
const c = await rpc('session.create', { cwd: winCwd, agentPreset: 'council' })
console.log(`[create] status=${c.status} value=${JSON.stringify(valOf(c))} err=${JSON.stringify(errOf(c))}`)
const sid = valOf(c)?.sessionId
if (!sid) { console.log('[stop] 没拿到 sessionId'); process.exit(2) }
console.log(`[create] 新会话 ${sid} preset=${valOf(c)?.agentPreset}`)

// 等它出现在列表里且空闲
const tCreate = Date.now()
while (Date.now() - tCreate < 60000) {
  const lr = await rpc('session.list', {})
  const s = valOf(lr)?.items?.find((x) => x.sessionId === sid)
  if (s && !s.running) break
  await sleep(1000)
}
await sleep(1000)

/* ── ④ 发极小任务 ─────────────────────────────────────────── */
const baselineTurns = (await rpc('session.list', {})).json?.result?.value?.items?.find((x) => x.sessionId === sid)
  ?.projections?.values?.sessionStats?.turns ?? 0
const r = await rpc('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: TASK }] })
console.log(`[prompt] status=${r.status} accepted=${valOf(r)?.accepted} err=${JSON.stringify(errOf(r))}`)

/* ── ⑤ 等空闲 ─────────────────────────────────────────────── */
const t0 = Date.now()
let last = null
while (Date.now() - t0 < MAX_MS) {
  const lr = await rpc('session.list', {})
  const s = valOf(lr)?.items?.find((x) => x.sessionId === sid)
  if (s) {
    const st = s.projections?.values?.sessionStats ?? {}
    last = { running: !!s.running, turns: st.turns ?? 0, steps: st.steps ?? 0 }
    if (!last.running && last.turns >= baselineTurns + 1) break
  }
  await sleep(2000)
}
console.log(`[wait] ${JSON.stringify({ ...last, waitedMs: Date.now() - t0 })}`)
await sleep(2000)

/* ── ⑥ 取证（从会话语义日志读，不靠"我以为"）───────────────── */
const loc = findSessionFile(sid)
if (!loc) { console.log('[stop] 找不到会话日志'); process.exit(2) }
console.log(`[日志] ${loc.file}`)
const evs = readEvents(loc.file)

const hdrs = evs.filter((e) => e.type === 'request/header')
const firstHdr = hdrs[0]?.data?.header ?? null
const names = Array.isArray(firstHdr?.tools) ? [...new Set(firstHdr.tools.map(toolNameOf))].sort() : []
const namesHash = names.length ? sha8(names.join('\n')) : '-'
console.log(`[header] 请求数=${hdrs.length} system长度=${typeof firstHdr?.system === 'string' ? firstHdr.system.length : 'n/a'} 工具数=${names.length} namesHash=${namesHash}`)

const hits = []
for (const e of evs) {
  const s = JSON.stringify(e)
  if (!s.includes(PHRASE)) continue
  const d = e.data ?? {}
  const t = textOf(d.content ?? d.message?.content ?? d.message ?? d)
  const i = t.indexOf(PHRASE)
  hits.push({
    seq: e.seq,
    type: e.type,
    source: d.source ?? d.message?.source ?? null,
    offset: i,
    context: i >= 0 ? t.slice(Math.max(0, i - 200), i + PHRASE.length + 120) : '(该事件无直读文本，仅 JSON 内命中)',
    textLen: t.length,
  })
}
console.log(`\n── 短语「${PHRASE}」命中 ${hits.length} 处 ──`)
for (const h of hits) {
  console.log(`  seq=${h.seq} type=${h.type} offset=${h.offset}`)
  console.log(`    source=${JSON.stringify(h.source)}`)
  console.log(`    上下文: ${JSON.stringify(h.context.slice(0, 420))}`)
}

// 记忆载体那条注入消息的完整形状（便于报告引用）
const instrMsg = evs.find((e) => e.type === 'user/message' && (e.data?.source?.kind === 'agent-instructions'))
if (instrMsg) {
  const d = instrMsg.data ?? {}
  const t = textOf(d.content ?? d.message?.content ?? d)
  console.log(`\n── agent-instructions 注入消息 ──`)
  console.log(`  seq=${instrMsg.seq} 文本长度=${t.length}`)
  console.log(`  source=${JSON.stringify(d.source ?? d.message?.source ?? null).slice(0, 700)}`)
  console.log(`  正文（前 500 字）: ${JSON.stringify(t.slice(0, 500))}`)
} else {
  console.log('\n⚠ 没有找到 source.kind=agent-instructions 的 user/message')
}

// 助手最终回复（用于"模型真的读到了吗"的行为面证据）
const assistantTexts = []
for (const e of evs) {
  if (e.type !== 'assistant/message') continue
  const d = e.data ?? {}
  const t = textOf(d.content ?? d.message?.content ?? d.message ?? d)
  if (t.trim()) assistantTexts.push({ seq: e.seq, turn: d.turn, step: d.step, text: t })
}
console.log(`\n── 助手回复（${assistantTexts.length} 条）──`)
for (const a of assistantTexts) {
  console.log(`  seq=${a.seq} t/s=${a.turn}/${a.step} 含短语=${a.text.includes(PHRASE)}`)
  console.log(`    正文: ${JSON.stringify(a.text.slice(0, 400))}`)
}
const replyHasPhrase = assistantTexts.some((a) => a.text.includes(PHRASE))

const verdict = hits.length > 0 ? 'present' : 'absent'
const pass = EXPECT ? verdict === EXPECT : null

const evidence = {
  arm: NAME,
  at: new Date().toISOString(),
  root: ROOT,
  cwd: CWD,
  ancestors: ANC,
  judgeRootInAncestors: JUDGE_ROOT_IN_ANCESTORS,
  insideJudgeRoot: INSIDE_JUDGE_ROOT,
  store: STORE,
  storeCount: rendered.count,
  storeItems: rendered.items,
  carrier: carrierPath,
  carrierBytes: carrierRaw.length,
  carrierSha256: sha256(carrierRaw.toString('utf8')),
  carrierHasPhrase: carrier.includes(PHRASE),
  sessionId: sid,
  preset: valOf(c)?.agentPreset ?? null,
  task: TASK,
  requestHeader: {
    count: hdrs.length,
    systemLen: typeof firstHdr?.system === 'string' ? firstHdr.system.length : null,
    toolCount: names.length,
    namesHash,
    toolNames: names,
  },
  phrase: PHRASE,
  phraseHits: hits,
  assistantTexts,
  replyHasPhrase,
  agentInstructionsMessage: instrMsg
    ? { seq: instrMsg.seq, source: instrMsg.data?.source ?? null, textLen: textOf(instrMsg.data?.content ?? instrMsg.data?.message?.content ?? instrMsg.data).length }
    : null,
  verdict,
  expect: EXPECT,
  pass,
}
const outFile = EVIDENCE
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log(`\n=== 判定：短语 ${verdict}（期望 ${EXPECT ?? '(未指定)'}）⇒ ${pass === null ? 'N/A' : pass ? 'PASS' : 'FAIL'} ===`)
console.log(`SID=${sid}`)
console.log(`evidence=${outFile}`)
