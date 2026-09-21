#!/usr/bin/env node
/**
 * arm-probe.mjs —— **臂分离探针**：换代到某个 profile 后，真发一句话、真读"模型实际拿到的工具面"。
 *
 * 与 `eval-isolation-audit.mjs`（看"两臂之间有没有互相碰"）配套；本脚本回答的是
 * **"这一臂到底拿到哪些工具"** —— 因为"我们改了 profile" ≠ "模型看见的变了"（实测踩过：
 * 换代刚 flip 完插件还在注册工具，臂跑在只有 4 个工具的 gen 上；也踩过只 drop bundle
 * 但能力还有第二条路 = mcp-client insert）。
 *
 * ★★ 2026-09-21 加 **多次采样（`--samples`）**，为的是判得动**否定命题**（"某个家族关掉了"）。
 * 判据逻辑（照铁律「**看不到 ≠ 没有**」）：
 *   ① **窗口**：单个读数**不能**证明"没有" —— MCP server 是**迟到挂载**的，早读一次当然是 0。
 *      必须在一个**覆盖迟到延迟的窗口**上连续采样（本脚本打印窗口时长 = N × interval）。
 *   ② **同窗口阳性对照**：窗口内**必须有家族读到了非 0**；
 *      否则"全 0"只说明**这次读不到**，不能说明**没有** ⇒ 判为「不可采信」而不是「关掉了」。
 *   ③ **族级判定**：每个家族出 `min/max/取值序列` ⇒ 全 0 才叫关掉；有 0 有非 0 叫**迟到挂载**（最有用的一条）。
 *
 * ★★★ 对照族的**选择规则**（2026-09-21 用血换的，别踩）：
 *   **对照族必须与本次自变量【正交】** —— 即"你不动它，它就在"。
 *   我第一版拿 `self_evolve` 当对照，结果它在被测臂里**归零**了 ⇒ 脚本只能判"不可采信"。
 *   事后查明：`self_evolve` 根本不是 `tool-evolution` 的工具，而是
 *   **`@dsh-brain/design-canvas-bridge` 的 8 个工具之一** ⇒ **它就在被关掉的那一族里**，
 *   当对照等于"拿体温计量自己的体温"。
 *   ⇒ 默认对照 = `subagent`（`subagent-council` 的，与被关的 design-canvas 无关）；
 *     换别的实验用 `--control <族名>`，**并先自问：它会不会随自变量变**。
 *
 * ⚠ `--samples` / `--interval` / `--control` 是**全局**的（对本次命令行里所有 profile 生效）。
 *
 * 用法：
 *   node scripts/arm-probe.mjs web-nodc                        # 换代到该 profile 并探一次
 *   node scripts/arm-probe.mjs web-nodc web                    # 探完再切回来（两方向）
 *   node scripts/arm-probe.mjs --current                       # 不换代，只探当前代
 *   node scripts/arm-probe.mjs --current --samples 6 --interval 5   # ★ 6 次采样 / 间隔 5s（判"关掉了"用这个）
 *   node scripts/arm-probe.mjs --current --samples 6 --family 'mcp=/^mcp__/' --control subagent
 *
 * ❗**关掉一批工具**这件事，本脚本只给"工具面"这一个通道；要下结论还需另一条**正交通道**
 *   （典型：`node scripts/probe-node-procs.mjs design-canvas` —— 独立 MCP server 是**真进程**，
 *   它不在 ⇒ 正向事实）。两通道一致才叫坐实。
 *
 * 产出：`out/arm-probe-<profile|current>-<ts>.json`（逐次采样的原始读数，可复查）。
 * 前置：控制面可达（`DSH_CTRL` 默认 http://127.0.0.1:31800）；控制面必须 idle 才能换代。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CTRL = process.env.DSH_CTRL ?? 'http://127.0.0.1:31800'
const REPO = 'D:/project_develop/dsh-brain'
const OUT = path.join(REPO, 'out')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8' })
const status = async () => (await fetch(`${CTRL}/?cmd=status`)).json()

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : argv[i + 1]
}
/** ★ 先做一次**规范的 token 解析**：带值的选项吃掉它后面的值，剩下的才是 profile 名。
 *  （旧实现用 `filter` 猜，`--family mcp=/^mcp__/` 的值会被误当成 profile 名而触发换代。） */
const FLAGS = new Set()
const POSITIONAL = []
const FAMILY_SPECS = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--samples' || a === '--interval' || a === '--family' || a === '--control' || a === '--proc') {
    if (a === '--family') FAMILY_SPECS.push(argv[i + 1])
    i++
    continue
  }
  if (a.startsWith('--')) {
    FLAGS.add(a)
    continue
  }
  POSITIONAL.push(a)
}
const samples = Math.max(1, Number(argOf('--samples') ?? 1) || 1)
const intervalMs = Math.max(0, Number(argOf('--interval') ?? 3) || 0) * 1000

/** 家族定义：`--family name=regex` 可追加；默认这四族。
 *  · `self_evolve` 是**同窗口阳性对照**：它是我们自己的包挂的，只要 profile 没坏就必然在。
 *    ⇒ 它读到非 0，才说明"这次读数能看见东西"。 */
const FAMILIES = [
  { name: 'design-canvas', re: /design[-_]canvas/i },
  { name: 'mcp', re: /^mcp__/ },
  { name: 'self_evolve', re: /^self_evolve$/ },
  { name: 'subagent', re: /^(subagent|subagent_fork|council_architect)$/ },
]
/** 阳性对照族名。★ 必须与**本次自变量正交** —— 详见文件头注释。
 * 默认 `subagent`（`subagent-council` 注册的 provider 产物；关 design-canvas 时它不变）。
 * ✗ 不要用 `self_evolve`：它是 `design-canvas-bridge` 的 8 个工具之一（2026-09-21 翻车实证）。 */
const CONTROL = argOf('--control') ?? 'subagent'
/** 第二通道关键词：`--proc design-canvas` ⇒ 每次采样同时数"命令行含它的 node 进程"。 */
const PROC_KW = argOf('--proc') ?? null

/** 追加自定义家族 */
for (const spec of FAMILY_SPECS.filter(Boolean)) {
  const m = /^([^=]+)=(.+)$/.exec(spec)
  if (!m) {
    console.warn(`⚠ --family 格式应为 name=regex，忽略：${spec}`)
    continue
  }
  try {
    FAMILIES.push({ name: m[1], re: new RegExp(m[2]) })
  } catch (e) {
    console.warn(`⚠ --family 正则非法，忽略 ${spec}：${e.message}`)
  }
}

async function flip(profile) {
  const s0 = await status()
  if (s0.stage !== 'idle') throw new Error(`控制面 stage=${s0.stage}，先别换代`)
  await fetch(`${CTRL}/?cmd=handover&profile=${encodeURIComponent(profile)}`)
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const s = await status()
    if (s.stage === 'idle' && s.result) return s
  }
  throw new Error('换代超时')
}

/**
 * **第二通道**：`--proc <关键词>` 时，每次采样同时记"进程表里含该关键词的 node 进程数"。
 *
 * 为什么必须正交地再看一眼：工具面读数是**一个**通道，"读不到"与"没有"在它上面分不开。
 * 独立 MCP server 是**真进程** ⇒ "进程不在"是**正向**可观测事实。
 * 两通道同向 ⇒ 结论坐实；两通道矛盾 ⇒ 有我们没搞懂的挂载路（那本身就是发现）。
 */
/**
 * **正交通道②**：读这一代的 `boot.log`（装配侧痕迹，纯文件、不需要 PowerShell）。
 * 与工具面（请求侧）失败模式不同 ⇒ 同向才叫坐实。
 */
async function bootInfo(gen) {
  if (!gen) return null
  const r = sh('node', ['scripts/probe-gen-boot.mjs', gen, '--json'])
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

function procCount(kw) {
  if (!kw) return null
  const r = sh('node', ['scripts/probe-node-procs.mjs', '--json', kw])
  try {
    return JSON.parse(r.stdout).hits.length
  } catch {
    return null
  }
}

/** 一次采样 = 新建会话 + 一句极短 prompt + 等 request/header 落盘 ⇒ 读工具面（+ 进程通道）。 */
async function sampleOnce() {
  const sid = String(sh('node', ['scripts/session-create.mjs']).stdout).trim().split('\n').pop().trim()
  if (!sid || !sid.startsWith('session-')) return { sid, toolSet: null, note: '建会话失败' }
  sh('node', ['scripts/session-drive.mjs', 'prompt', sid, '只回一个字：好'])
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const r = sh('node', ['scripts/eval-run.mjs', '--traj', sid])
    try {
      const m = JSON.parse(r.stdout).metrics
      if (m?.toolSetSize) return { sid, toolSet: m.toolSet, toolSetSize: m.toolSetSize, procs: procCount(PROC_KW) }
    } catch {
      /* 还没写盘 */
    }
  }
  return { sid, toolSet: null, toolSetSize: 0, note: '读不到工具面', procs: procCount(PROC_KW) }
}

/** 对一组采样做族级判定 ⇒ 这一句就是"关掉了"能不能成立的**唯一**依据。 */
function verdict(samplesList) {
  // 对照族不在表里 ⇒ 自动补一个"精确名"族（否则 readable 恒 false，会误报"不可采信"）
  if (!FAMILIES.some((f) => f.name === CONTROL)) {
    FAMILIES.push({ name: CONTROL, re: new RegExp(`^${CONTROL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    console.warn(`⚠ 对照族 ${CONTROL} 不在家族表里 ⇒ 已按"精确名"补进去；建议用 --family 显式声明。`)
  }
  const perFamily = FAMILIES.map((f) => {
    const series = samplesList.map((s) => (s.toolSet ?? []).filter((t) => f.re.test(t)).length)
    const min = Math.min(...series)
    const max = Math.max(...series)
    const kind = series.length === 0 || max === 0 ? 'all-zero' : min > 0 ? 'all-nonzero' : 'flapping'
    return { name: f.name, series, min, max, kind }
  })
  const ctrl = perFamily.find((f) => f.name === CONTROL)
  // ③ 同窗口阳性对照：对照族**至少读到一个非 0** 才算"这次看得见"
  const readable = !!ctrl && ctrl.series.some((n) => n > 0)
  const sizes = samplesList.map((s) => s.toolSetSize ?? 0)
  const procSeries = PROC_KW ? samplesList.map((s) => (s.procs ?? null)) : null
  return { perFamily, readable, sizes, procSeries, ok: readable }
}

function fmtSeries(series) {
  return '[' + series.join(',') + ']'
}

async function probe(label, tag, gen) {
  const samplesList = []
  for (let i = 1; i <= samples; i++) {
    const r = await sampleOnce()
    samplesList.push(r)
    if (samples > 1) console.log(`  采样 ${i}/${samples}: 工具面 ${r.toolSetSize ?? 0} 个 (${r.sid})`)
    if (i < samples && intervalMs) await sleep(intervalMs)
  }
  const v = verdict(samplesList)
  const windowSec = ((samples - 1) * intervalMs) / 1000
  console.log(`  ${label}: 工具面采样 ${fmtSeries(v.sizes)}（窗口 ${samples} 次 × ${intervalMs / 1000}s = ${windowSec}s）`)
  for (const f of v.perFamily) {
    const mark = f.kind === 'all-zero' ? '全 0' : f.kind === 'all-nonzero' ? '全非 0' : '★ 振荡（迟到挂载？）'
    console.log(`    ${f.name.padEnd(14)} ${fmtSeries(f.series).padEnd(24)} ${mark}  [min=${f.min} max=${f.max}]`)
  }
  if (!v.readable) {
    console.log(
      `  ⚠ **无同窗口阳性对照**（对照族 ${CONTROL} 全程为 0）⇒ 本次读数**不能**当作"没有/关掉了"的证据：` +
        `程序性"看不到"与真的"没有"在这里分不开。`,
    )
  } else {
    const zeroFams = v.perFamily.filter((f) => f.kind === 'all-zero').map((f) => f.name)
    console.log(
      `  ✓ 同窗口阳性对照成立（${CONTROL} 读到非 0）⇒ 本窗口内的"全 0"可采信。` +
        `（前提：${CONTROL} 与自变量正交 —— 若它本身就是被关的那一族，这条判语无效）` +
        (zeroFams.length ? ` 判定为「关掉了」的家族：${zeroFams.join(', ')}` : ' 没有家族被判"关掉了"。'),
    )
  }
  fs.mkdirSync(OUT, { recursive: true })
  // ★ 通道②：装配侧痕迹（boot.log），与通道①（请求侧工具面）正交交叉验证
  const bi = await bootInfo(gen)
  let bootCross = null
  if (bi) {
    const get = (n) => bi.hits.find((h) => h.name === n)?.count ?? 0
    const bridge = get('design-canvas-bridge(apply)')
    const mcpSrv = get('design-canvas-MCP-server')
    const famDc = v.perFamily.find((f) => f.name === 'design-canvas')
    const toolZero = !!famDc && famDc.kind === 'all-zero'
    const bootZero = bridge === 0 && mcpSrv === 0
    console.log(
      `  通道② boot(${bi.gen}·段数${bi.segmentCount}) bridge apply=${bridge} MCP启动=${mcpSrv} bridge已注册=${bi.registered.length} 个` +
        ` ｜ 健康 plugin-tree-failed=${get('plugin-tree-failed')} dupId=${get('duplicate-loader-id')} startup-error=${get('startup-error')}`,
    )
    bootCross = toolZero === bootZero ? 'agree' : 'conflict'
    console.log(
      toolZero === bootZero
        ? `  ✓ 两通道同向（工具面 design-canvas ${toolZero ? '全 0' : '非 0'} ⟺ boot 痕迹 ${bootZero ? '无' : '有'}）`
        : `  ✗ **两通道矛盾**（工具面 ${toolZero ? '全 0' : '非 0'} 但 boot 痕迹 ${bootZero ? '无' : '有'}）⇒ 别下结论，去查；这本身就是发现。`,
    )
    if (bi.segmentCount > 1)
      console.log(`  ⚠ 这代 boot.log 有 ${bi.segmentCount} 个启动段（跨启动累积）—— 上面只数**末段**，别拿整篇数。`)
  }
  if (v.procSeries) {
    if (v.procSeries.every((n) => n === null)) {
      console.log(`  通道③ 进程（含 "${PROC_KW}"）: **不可用**（本 shell 调不到 PowerShell）⇒ 本通道无结论，别当成"没有"。`)
    } else {
      const procZero = v.procSeries.every((n) => n === 0)
      console.log(`  通道③ 进程（含 "${PROC_KW}"）: ${fmtSeries(v.procSeries)}  ⇒ ${procZero ? '全 0（进程不存在）' : '存在进程'}`)
    }
  }
  const file = path.join(OUT, `arm-probe-${tag}-${Date.now()}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        label, tag, gen, samples, intervalMs, windowSec, readable: v.readable,
        procKw: PROC_KW, perFamily: v.perFamily, procSeries: v.procSeries,
        boot: bi ? { gen: bi.gen, segmentCount: bi.segmentCount, hits: bi.hits, registered: bi.registered } : null,
        bootCross, samplesList,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`  证据落盘: ${path.relative(REPO, file).replace(/\\/g, '/')}`)
  return { ...v, file, firstSid: samplesList[0]?.sid, gen, boot: bi, bootCross }
}

const results = []
console.log(
  `臂探针配置（★ 全局，对本次所有 profile 生效）: samples=${samples} interval=${intervalMs / 1000}s ` +
    `control=${CONTROL}${PROC_KW ? ` proc=${PROC_KW}` : ''} | 臂: ${POSITIONAL.join(', ') || '(当前代)'}`,
)
if (argv.filter((a) => a === '--samples').length > 1)
  console.warn('⚠ --samples 出现了多次，但本工具只认**第一个**（采样配置是全局的）⇒ 想给各臂不同采样数请分开跑。')
if (FLAGS.has('--current') || !POSITIONAL.length) {
  const s = await status()
  results.push(await probe(`当前代 ${s.lease.activeGen.gen}`, 'current', s.lease.activeGen.gen))
} else {
  for (const p of POSITIONAL) {
    console.log(`\n=== 换代到 ${p} ===`)
    const s = await flip(p)
    console.log('  ' + String(s.result?.note ?? '').slice(0, 60) + '  代=' + s.lease.activeGen.gen)
    results.push(await probe(p, p, s.lease.activeGen.gen))
  }
}

// 多臂时给一张并排表 —— 两臂差异必须**逐族**看得见，不能只看总面积
if (results.length > 1) {
  console.log('\n===== 臂间并排（族 → 该臂读数）=====')
  for (const f of FAMILIES) {
    const row = results.map((r) => {
      const e = r.perFamily.find((x) => x.name === f.name)
      return e ? fmtSeries(e.series) : '(无)'
    })
    console.log(`  ${f.name.padEnd(14)} ${row.join('   vs   ')}`)
  }
  console.log(`  工具面总数      ${results.map((r) => fmtSeries(r.sizes)).join('   vs   ')}`)
  const bootCells = results.map((r) => {
    if (!r.boot) return '(未采)'
    const b = r.boot.hits.find((h) => h.name === 'design-canvas-bridge(apply)')?.count ?? 0
    const m = r.boot.hits.find((h) => h.name === 'design-canvas-MCP-server')?.count ?? 0
    return `bridge=${b}/mcp=${m}`
  })
  console.log(`  通道② boot 痕迹 ${bootCells.join('   vs   ')}`)
  const conflicts = results.filter((r) => r.bootCross === 'conflict')
  console.log(
    conflicts.length
      ? '  ✗ **有臂两通道矛盾** ⇒ 结论不可用（去查矛盾，别下判断）'
      : '  ✓ 全部臂：两通道（请求侧工具面 × 装配侧 boot 痕迹）同向 ⇒ 本组对比可用。',
  )
  if (PROC_KW) console.log(`  进程("${PROC_KW}")  ${results.map((r) => (r.procSeries ? fmtSeries(r.procSeries) : '(未采)')).join('   vs   ')}`)
  // ★ 跨臂对照体检：对照族在**每一臂**都必须非 0，否则它自己也被自变量影响了 ⇒ 判语作废
  const ctrlRows = results.map((r) => r.perFamily.find((x) => x.name === CONTROL))
  const bad = ctrlRows.filter((c) => !c || c.kind === 'all-zero')
  console.log(
    bad.length
      ? `  ★ 对照体检：**不通过** —— 对照族 ${CONTROL} 在 ${bad.length}/${results.length} 臂里为 0` +
          ` ⇒ 它多半也在被关的那一族里（或这臂本身是坏的）⇒ 上面的"可采信"判语一律作废，换个对照族重跑。`
      : `  ✓ 对照体检：对照组 ${CONTROL} 在全部 ${results.length} 臂都非 0 ⇒ 它是**正交**的，前面的判语成立。`,
  )
}
