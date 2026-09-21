#!/usr/bin/env node
/**
 * probe-gen-boot.mjs —— **启动痕迹通道**：读某一代（gen）的 `boot.log`，报"哪些插件真的起来了"。
 *
 * ## 为什么要有它
 *
 * 判「某个能力关掉了」是**否定命题**，而工具面读数只有**一个**通道 ——
 * "读不到"与"没有"在它上面分不开（铁律「看不到 ≠ 没有」）。
 * 本脚本给一条**正交且纯文件**的第二通道：
 *
 *   · 工具面通道 = 「**模型实际收到的 header 里有没有这些工具**」（请求侧，事后读 session）
 *   · 启动痕迹通道 = 「**loader 到底装配/启动了哪些插件**」（装配侧，读 gen 自己的 boot.log）
 *
 * 两者失败模式完全不同 ⇒ 同向才算坐实。
 * ★ 且本通道**不需要 PowerShell**（本机 Bash 沙箱里 PS 调不到），只读文件 ⇒ 稳定。
 *
 * 用法：
 *   node scripts/probe-gen-boot.mjs                    # 读**现役代**（问控制面要 gen 名）
 *   node scripts/probe-gen-boot.mjs gen-3106           # 读指定代
 *   node scripts/probe-gen-boot.mjs gen-3106 --json    # JSON（给别的脚本调）
 *   node scripts/probe-gen-boot.mjs gen-3106 --mark 'design-canvas' --mark 'tool-evolution'
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'C:/Users/Admin/.dsh/switchboard'
const CTRL = process.env.DSH_CTRL ?? 'http://127.0.0.1:31800'
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : argv[i + 1]
}
const marks = argv.reduce((a, x, i) => (x === '--mark' ? [...a, argv[i + 1]] : a), []).filter(Boolean)
/** 默认关注这些标记（`{name, re}`）；`--mark X` 追加"含 X"的标记。 */
const MARKERS = [
  { name: 'design-canvas-bridge(apply)', re: /\[design-canvas-bridge\]\s*apply/i },
  { name: 'design-canvas-MCP-server', re: /MCP server started/i },
  { name: 'mcp-client', re: /mcp-client/i },
  { name: 'tool-evolution', re: /\[tool-evolution\]/i },
  { name: 'capability-bridge', re: /\[capability-bridge\]/i },
  { name: 'plugin-tree-failed', re: /plugin tree failed to load/i },
  { name: 'duplicate-loader-id', re: /duplicate loader entry id/i },
  { name: 'startup-error', re: /startup error|EXIT code=|fatal/i },
  ...marks.map((m) => ({ name: `--mark:${m}`, re: new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })),
]

const genArg = argv.find((a) => !a.startsWith('--') && !MARKERS.some((m) => m.name.endsWith(':' + a)))
let gen = genArg ?? null
if (!gen) {
  try {
    const s = await (await fetch(`${CTRL}/?cmd=status`)).json()
    gen = s?.lease?.activeGen?.gen ?? null
  } catch {
    /* 控制面不可达 */
  }
}
if (!gen) {
  console.error('⚠ 拿不到 gen 名（控制面不可达且命令行也没给）')
  process.exit(1)
}
const logPath = path.join(ROOT, gen, 'boot.log')
const lifePath = path.join(ROOT, gen, 'lifecycle.log')
if (!fs.existsSync(logPath)) {
  console.error(`⚠ 没有 ${logPath}`)
  process.exit(1)
}
const text = fs.readFileSync(logPath, 'utf8')
/**
 * ★★ 只读**最后一次启动**的段（2026-09-21 实证踩到）：
 * `boot.log` 以 'a' 打开 ⇒ **跨多次启动累积**，分隔符是 `===== BOOT gen=… =====`。
 * 实测 gen-3105 的 boot.log 有两段：**第一段是昨天（09-20）一次失败的启动**
 * （`Cannot find module …dsh/lib/bin.js` / `MODULE_NOT_FOUND`），第二段才是今天这代。
 * ⇒ 若整篇一起数标记，**阳性臂会被陈旧行谎报成"起来了"** —— 这是典型的假绿。
 */
const segs = text.split(/^===== BOOT /m)
const segmentCount = segs.length - 1
const last = segs.length > 1 ? segs[segs.length - 1] : text
const lastHeader = segs.length > 1 ? ('===== BOOT ' + last.split('\n')[0]).trim() : '(无 BOOT 分隔符)'
const hits = MARKERS.map((m) => ({ name: m.name, count: (last.match(new RegExp(m.re.source, m.re.flags + 'g')) ?? []).length }))
const lines = text.split('\n').length - 1
// ★ bridge 的"逐个工具注册"行 —— 这是最硬的一条：boot.log 直接点名每个工具
const registered = [...last.matchAll(/\[design-canvas-bridge\]\s*(\S+)\s*已注册/g)].map((m) => m[1])
// lifecycle.log：进程生死轨迹（有没有"退了又起"这类事）
let lifecycle = null
if (fs.existsSync(lifePath)) {
  const lt = fs.readFileSync(lifePath, 'utf8').trim().split('\n')
  lifecycle = { lines: lt.length, tail: lt.slice(-2) }
}
const out = { gen, bootLog: logPath.replace(/\\/g, '/'), bootLines: lines, segmentCount, lastHeader, hits, registered, lifecycle }

if (asJson) {
  console.log(JSON.stringify(out))
} else {
  console.log(`gen=${gen}   boot.log 行数=${lines}  启动段数=${segmentCount}   ${logPath.replace(/\\/g, '/')}`)
  console.log(`  末段: ${lastHeader}${segmentCount > 1 ? `  ⚠ 这代 boot.log 有 ${segmentCount} 段（跨启动累积）⇒ 下面只数**末段**` : ''}`)
  for (const h of hits) console.log(`  ${h.count === 0 ? '【0】' : '   '} ${h.name.padEnd(28)} ${h.count}`)
  console.log(`  bridge 逐个注册行: ${registered.length ? registered.join(', ') : '【0（无）】'}`)
  if (lifecycle) console.log(`  lifecycle.log 行数=${lifecycle.lines}  尾: ${lifecycle.tail.join(' | ').slice(0, 140)}`)
}
