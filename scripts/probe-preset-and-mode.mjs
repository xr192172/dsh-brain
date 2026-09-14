/**
 * probe-preset-and-mode.mjs —— 定位「工具呈现模式切换」的触发源
 *
 * 假设：呈现模式由 agent preset 决定（`dsh-agent-tool-presentation` 插件按 preset 的
 * standing scope 调 `tools.presentAs(mode)`），code preset 与 native preset 可同进程并存。
 * 因此同一会话里出现两种 header 形态（system 长度 / tools 数量不同）= 不同 preset 的 agent 在交替发请求。
 *
 * 本脚本输出：每个会话的 agentPreset、header 形态指纹、以及 subagent 活动计数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/preset-mode.txt'

const out = []
const say = (x = '') => out.push(x)

function load(file) {
  const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  return text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

const sessions = []
for (const dir of fs.readdirSync(ROOT)) {
  const dp = path.join(ROOT, dir)
  if (!fs.statSync(dp).isDirectory()) continue
  for (const s of fs.readdirSync(dp)) {
    const f = path.join(dp, s, 'session.jsonl.zstd')
    if (fs.existsSync(f)) sessions.push({ rel: `${dir}/${s}`, file: f, size: fs.statSync(f).size })
  }
}
sessions.sort((a, b) => b.size - a.size)

for (const s of sessions) {
  let evs
  try { evs = load(s.file) } catch { continue }
  if (!evs.length) continue

  const head = evs.find((e) => e.type === 'session')
  const presets = new Set()
  if (head?.agentPreset) presets.add(head.agentPreset)
  for (const e of evs) {
    if (e.type === 'session' && e.agentPreset) presets.add(e.agentPreset)
    if (e.data?.agentPreset) presets.add(e.data.agentPreset)
  }

  // header 形态指纹
  const fps = new Map()
  const headers = evs.filter((e) => e.type === 'request/header')
  for (const h of headers) {
    const d = h.data?.header ?? {}
    const fp = `${(d.system ?? '').length}|${Array.isArray(d.tools) ? d.tools.length : 0}`
    fps.set(fp, (fps.get(fp) || 0) + 1)
  }

  // subagent / delegation 活动
  const typeCount = new Map()
  for (const e of evs) typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1)
  const subagentish = [...typeCount.entries()]
    .filter(([k]) => /subagent|delegat|code-dispatch|inbox/i.test(k))
    .map(([k, v]) => `${k}=${v}`)

  const ctxEv = evs.find((e) => e.type === 'request/context')

  say(`===== ${s.rel.replace(/^--/g, '').slice(0, 52)} =====`)
  say(`  size=${(s.size / 1048576).toFixed(2)}MB  events=${evs.length}  window=${ctxEv?.data?.contextWindow ?? '?'}`)
  say(`  agentPreset(session header) = ${head?.agentPreset ?? '(none)'}   all seen = ${[...presets].join(', ') || '(none)'}`)
  say(`  cwd = ${head?.cwd ?? '?'}  delegationDepth = ${head?.delegationDepth ?? '?'}`)
  say(`  header 形态指纹 (systemLen|toolsCount) x 次数:`)
  for (const [fp, n] of [...fps.entries()].sort((a, b) => b[1] - a[1])) say(`      ${fp}   x${n}`)
  if (fps.size > 1) {
    let switches = 0
    for (let i = 1; i < headers.length; i++) {
      const a = headers[i - 1].data?.header ?? {}, b = headers[i].data?.header ?? {}
      const fa = `${(a.system ?? '').length}|${Array.isArray(a.tools) ? a.tools.length : 0}`
      const fb = `${(b.system ?? '').length}|${Array.isArray(b.tools) ? b.tools.length : 0}`
      if (fa !== fb) switches++
    }
    say(`  ⚠️ 形态切换 ${switches} 次 / ${headers.length - 1} 次相邻比较`)
  }
  say(`  相关事件: ${subagentish.join(', ') || '(none)'}`)
  say('')
}

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log('written:', OUT)
