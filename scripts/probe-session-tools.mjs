// 找出每个会话的 header：agentPreset + 工具数量 + 是否含委派工具
// 用途：验证「preset 层是否真的把 subagent 工具交给了模型」
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/session-tools.txt'
const lines = []

function listSessions() {
  const out = []
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dp = path.join(ROOT, d.name)
    let kids = []
    try { kids = fs.readdirSync(dp) } catch { continue }
    for (const s of kids) {
      const f = path.join(dp, s, 'session.jsonl.zstd')
      if (fs.existsSync(f)) {
        const st = fs.statSync(f)
        out.push({ rel: `${d.name}/${s}`, file: f, size: st.size, mtime: st.mtime })
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

const all = listSessions()
lines.push(`会话总数: ${all.length}`)
lines.push('')

let examined = 0
for (const s of all) {
  if (examined >= 25) break
  if (s.size > 30 * 1048576) { lines.push(`${s.rel}  (跳过：${(s.size / 1048576).toFixed(0)}MB 过大)`); continue }
  examined++
  let first
  try {
    const text = Buffer.from(decompress(fs.readFileSync(s.file))).toString('utf8')
    first = text.slice(0, text.indexOf('\n'))
  } catch (e) { lines.push(`${s.rel}  解压失败: ${e.message}`); lines.push(''); continue }

  let h = null
  try { h = JSON.parse(first) } catch (e) { lines.push(`${s.rel}  header 解析失败: ${e.message}`); lines.push(''); continue }

  lines.push(`${s.mtime.toISOString().slice(0, 16)}  ${(s.size / 1048576).toFixed(2).padStart(6)}MB  ${s.rel}`)
  lines.push(`    header keys: ${Object.keys(h).join(', ')}`)

  // preset 字段的各种可能位置
  const presetCandidates = {
    agentPreset: h.agentPreset,
    preset: h.preset,
    'agent.preset': h.agent?.preset,
    'agent.presetId': h.agent?.presetId,
    'meta.preset': h.meta?.preset,
  }
  const presetFound = Object.entries(presetCandidates).filter(([, v]) => v != null)
  lines.push(`    preset 字段: ${presetFound.length ? JSON.stringify(Object.fromEntries(presetFound)) : '(header 无)'}`)

  // 工具清单
  const tools = Array.isArray(h.tools) ? h.tools
    : Array.isArray(h.toolSchemas) ? h.toolSchemas
      : Array.isArray(h.system?.tools) ? h.system.tools : null
  if (tools) {
    const names = tools.map((t) => t?.name ?? t?.function?.name ?? t?.id ?? '?')
    const subs = names.filter((n) => /subagent|delegate|list_agents/i.test(String(n)))
    lines.push(`    工具数: ${tools.length}`)
    lines.push(`    委派相关工具: ${subs.length ? subs.join(', ') : '【无】'}`)
    lines.push(`    工具名样本: ${names.slice(0, 30).join(', ')}`)
  } else {
    lines.push(`    工具清单: (header 未内联；含 tools 字样计数 ${typeof h.toolsCount === 'number' ? h.toolsCount : 'n/a'})`)
  }

  const whole = JSON.stringify(h)
  const m = whole.match(/subagent[a-z_-]*/gi)
  lines.push(`    header 内 subagent 字样: ${m ? [...new Set(m)].join(', ') : '【无】'}`)
  lines.push('')
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log('ok, examined=' + examined)
