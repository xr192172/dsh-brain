#!/usr/bin/env node
/**
 * eval-isolation-audit.mjs —— **两臂之间的隔离审计**（回答"题目的空间有没有分开"）。
 *
 * 为什么需要：两条臂跑在**同一个文件系统**上，而"共享空间"远不止工作区：
 *   · 工作区（git 跟踪的文件）—— 有 seed/restore 按住 ✓
 *   · **别的会话的日志** `~/.dsh/sessions/**` —— 里面是另一臂的完整推理与编辑 ⇒ **泄漏面**
 *   · **我自己的报告** `out/eval-pair-*.json` / `out/eval-run-*.json` —— 含另一臂的轨迹 ⇒ 同类泄漏面
 *   · **能力库** `~/.dsh/capabilities/registry.json` —— 共享可变状态
 *   · **design-canvas 索引/缓存** `D:\project_develop\dsh-brain\.design-canvas` —— 热/冷状态会跨臂继承（性能混淆）
 *   · **构建产物**（`packages/switchboard/lib` junction 指向的 build）—— 换代/重建会变
 *
 * 本脚本**只读**：数一数每条臂的工具参数里有没有碰到上面这些面，把"看得见的泄漏"点出来。
 * （判据纪律：不要把"没看见"当成"没发生"——这里只报告**观测到的**触碰。）
 *
 * 用法：
 *   node scripts/eval-isolation-audit.mjs --pair <out/eval-pair-*.json>
 *   node scripts/eval-isolation-audit.mjs <sid> [<sid2> …]
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const SESS = 'C:/Users/Admin/.dsh/sessions'
const REPO = 'D:/project_develop/dsh-brain'
const argv = process.argv.slice(2)

const findLog = (sid) => {
  let best = null
  for (const d of fs.readdirSync(SESS)) {
    const p = path.join(SESS, d, sid, 'session.jsonl.zstd')
    if (fs.existsSync(p)) {
      const st = fs.statSync(p)
      if (!best || st.size > best.size) best = { p, size: st.size }
    }
  }
  return best
}

const PATTERNS = [
  ['别的会话日志（泄漏面）', /\.dsh[\\/]sessions/i],
  ['我的报告 out/eval-*（含另一臂轨迹）', /out[\\/]eval-(pair|run|validate)|eval-pair-|eval-run-/i],
  ['能力库 registry.json', /capabilities[\\/]registry\.json/i],
  ['design-canvas 索引/缓存（冷热状态会跨臂继承）', /\.design-canvas/i],
  ['switchboard 运行态（state.jsonl / gen 目录）', /switchboard[\\/](state\.jsonl|gen-)/i],
]

function audit(sid, label) {
  const f = findLog(sid)
  if (!f) return { sid, label, found: false }
  const recs = Buffer.from(decompress(fs.readFileSync(f.p)))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const calls = recs.filter((r) => r.type === 'tool/call')
  const hits = {}
  for (const c of calls) {
    const args = String(c?.data?.arguments ?? '')
    for (const [name, re] of PATTERNS) {
      if (re.test(args)) (hits[name] ??= []).push({ tool: c?.data?.name ?? '?', snippet: args.replace(/\s+/g, ' ').slice(0, 120) })
    }
  }
  // 工具面（首个 request/header）
  // ★★ 2026-09-21 修正**口径**（此前这个数字被读成了"臂有多大"）：
  //   在 code（PTC）模式下 `request/header.tools` **恒只有 `run_code` 一个** ⇒ 恒为 1，
  //   而两臂的真差别落在**系统提示**里（实测 A=79405 字符 / B=39605 字符）
  //   ⇒ 打印时**必须带上口径标注**（mode + system 字符数），并声明它**不是**臂大小。
  const hdr = recs.find((r) => r.type === 'request/header')
  const tools = (hdr?.data?.header?.tools ?? []).map((t) => t?.name ?? '?')
  const toolSetSize = tools.length
  const systemChars = String(hdr?.data?.header?.system ?? '').length
  const mode = toolSetSize === 1 && tools[0] === 'run_code' ? 'code' : toolSetSize ? 'native' : 'unknown'
  return { sid, label, found: true, calls: calls.length, toolSetSize, mode, systemChars, hits }
}

const targets = []
if (argv[0] === '--pair' && argv[1]) {
  const j = JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8'))
  for (const [k, arm] of Object.entries(j.arms ?? {})) {
    for (const run of arm.runs ?? []) targets.push({ sid: run.session, label: `${k}(${arm.preset}@${run.profile ?? '?'})` })
    if (!arm.runs?.length && arm.session) targets.push({ sid: arm.session, label: k })
  }
} else {
  for (const s of argv) targets.push({ sid: s, label: s })
}

console.log(`隔离审计：${targets.length} 条会话\n`)
let flagged = 0
for (const t of targets) {
  const r = audit(t.sid, t.label)
  if (!r.found) {
    console.log(`  ${r.label}: 找不到日志`)
    continue
  }
  const names = Object.keys(r.hits)
  console.log(
    `  ${r.label}  工具面=${r.toolSetSize}(mode=${r.mode}, system=${r.systemChars}字符)  调用=${r.calls}  ` +
      `${names.length ? '⚠ 触碰到共享面：' + names.join(' / ') : '✓ 没触碰到列出的共享面'}`,
  )
  for (const n of names) {
    flagged++
    for (const h of r.hits[n].slice(0, 3)) console.log(`      · [${n}] ${h.tool}: ${h.snippet}`)
  }
}
console.log(
  `\n⚠ 口径：「工具面」= 首条 request/header 的 tools **条数**，**不是臂有多大**：` +
    `\n   code（PTC）模式下它恒为 1（只有 \`run_code\`）—— 要判臂大小请看同行的 \`system=…字符\`，` +
    `\n   或跑 \`node scripts/eval-run.mjs --self-test-harness\` 看 dcHits 口径（A>0 / B===0）。` +
    `\n合计 ${flagged} 处触碰。⚠ 注意：**没触碰到 ≠ 没泄漏**（本审计只看工具参数里出现的路径）。` +
    `\n   要更强的隔离，需要：① 每臂独立的会话目录/报告目录；② 或把另一臂的产物在跑之前移出 agent 够得到的位置。`,
)
