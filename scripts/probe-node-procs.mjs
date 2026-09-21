#!/usr/bin/env node
/**
 * probe-node-procs.mjs —— **进程通道**：列出本机 node 进程及其命令行，按关键词归类。
 *
 * ## 为什么要它（第二个独立通道）
 *
 * 判「某个能力关掉了」是个**否定命题**，而工具面读数只给一个通道 —— 一旦读不到，
 * "读不到"和"没有"就分不开（铁律「看不到 ≠ 没有」）。本脚本给**正交**的第二通道：
 * MCP 能力是**一个真实存在的子进程**（`mcp-client` loader entry 拉起的 stdio server）
 * ⇒ **进程在不在**是可直接观测的**正向**事实，不依赖工具面能不能读出来。
 *
 * 两通道一致 ⇒ 结论可信；不一致 ⇒ 说明有我们没搞懂的挂载路（那本身就是发现）。
 *
 * 用法：
 *   node scripts/probe-node-procs.mjs                       # 全量 node 进程 + 归类
 *   node scripts/probe-node-procs.mjs design-canvas          # 只看含该关键词的进程
 *   node scripts/probe-node-procs.mjs --json                 # 只出 JSON（管道用）
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'D:/project_develop/dsh-brain'
const OUT = path.join(REPO, 'out')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const kw = argv.find((a) => !a.startsWith('--')) ?? null

/** ★ 不用 pwsh 的 stdout 直读（本机实测会被吞）：写文件再读。 */
const tmp = path.join(OUT, 'procs.json')
fs.mkdirSync(OUT, { recursive: true })
const ps = [
  '$ErrorActionPreference="SilentlyContinue"',
  'Get-CimInstance Win32_Process |',
  '  Where-Object { $_.Name -eq "node.exe" } |',
  '  Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine |',
  `  ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 "${tmp.replace(/\//g, '\\')}"`,
].join(' ')
/** ★ 找 powershell 的**真身**：本机 Bash 工具里 PATH 被改过，
 *  `WindowsPowerShell\v1.0` 往往不在其中 ⇒ 裸名 `powershell` 会 spawn ENOENT（实测）。 */
const PS_CANDIDATES = [
  'powershell',
  'powershell.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'pwsh',
  'pwsh.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
]
let r = null
let used = null
for (const exe of PS_CANDIDATES) {
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
  const x = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  if (!x.error && fs.existsSync(tmp)) {
    r = x
    used = exe
    break
  }
  r = x
}
if (!fs.existsSync(tmp)) {
  console.error(
    '⚠ 取进程表失败（没有一个 powershell 候选跑通）:',
    String((r && (r.error?.message || r.stderr || r.stdout)) || '').slice(0, 300),
  )
  process.exit(1)
}
if (!asJson) console.error(`（进程表来源: ${used}）`)
let raw = fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '')
let list = []
try {
  const j = JSON.parse(raw)
  list = Array.isArray(j) ? j : [j]
} catch (e) {
  console.error('⚠ 进程表 JSON 解析失败:', e.message, raw.slice(0, 200))
  process.exit(1)
}

/** 归类规则：命令行里出现哪个关键词就归到哪一类（可多类，不互斥）。 */
const CLASSES = [
  { name: 'design-canvas-mcp', re: /design-canvas[\\/]dist[\\/]|design-canvas.*server\.js/i },
  { name: 'switchboard', re: /switchboard/i },
  { name: 'dsh-bin(现役代)', re: /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/i },
  { name: 'key-pool-proxy', re: /key-pool-proxy/i },
]
const rows = list
  .filter((p) => p.CommandLine)
  .map((p) => {
    const cl = String(p.CommandLine)
    return {
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      start: p.CreationDate,
      cls: CLASSES.filter((c) => c.re.test(cl)).map((c) => c.name),
      cl: cl.length > 190 ? cl.slice(0, 187) + '…' : cl,
    }
  })
const hit = kw ? rows.filter((x) => x.cl.includes(kw)) : rows

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, hits: hit }, null, 2))
  process.exit(0)
}
console.log(`node 进程总数: ${rows.length}${kw ? `（含 "${kw}" 的 ${hit.length} 个）` : ''}`)
for (const c of CLASSES) {
  const n = rows.filter((x) => x.cls.includes(c.name)).length
  console.log(`  ${n === 0 ? '【0】' : '   '} ${c.name.padEnd(18)} ${n}`)
}
console.log('--- 明细 ---')
for (const x of hit) console.log(`  pid=${String(x.pid).padEnd(7)} ppid=${String(x.ppid).padEnd(7)} [${x.cls.join(',') || '-'}] ${x.cl}`)
