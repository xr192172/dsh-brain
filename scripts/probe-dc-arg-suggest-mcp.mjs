/**
 * probe-dc-arg-suggest-mcp.mjs —— 端到端验证「参数纠错（Did you mean）」
 *
 * 动机（dogfood 观察）：zod object 会**静默丢弃**未知键 —— 参数写错时模型看到的是
 * "结果莫名其妙"，而不是一条可行动的纠正。Serena 的 Smart Errors 就是干这个的（本项即抄它）。
 *
 * 断言（走真 MCP stdio）：
 *   ① 传错参数名（lanes 而非 lane）→ 输出里出现「未知参数 `lanes`」+「是否想传 `lane`」
 *   ② 参数正确时**不出现**该提示（不误报、不噪音）
 *   ③ 完全不像的未知键静默
 *
 * 用法：node scripts/probe-dc-arg-suggest-mcp.mjs
 */
import { Client } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import fs from 'node:fs'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const OUT = 'D:/project_develop/dsh-brain/out/dc-arg-suggest.txt'

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${DC}/dist/src/server.js`],
  env: { ...process.env, DESIGN_CANVAS_HOME: 'D:/project_develop/dsh-brain/.design-canvas' },
  cwd: DC,
})
const client = new Client({ name: 'dsh-brain-arg-probe', version: '0.0.0' })
await client.connect(transport)

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args })
  return (r.content ?? []).map((c) => c.text ?? '').join('\n')
}

const typo = await call('capability_map', { lanes: 'design' }) // 应为 lane
const ok = await call('capability_map', { lane: 'design' })
const farOff = await call('capability_map', { zwischenzug: 1 })
await client.close()

const problems = []
if (!/未知参数 `lanes`/.test(typo)) problems.push('错参数未给出「未知参数」提示')
if (!/是否想传 `lane`/.test(typo)) problems.push('错参数未给出「是否想传 `lane`」建议')
if (/未知参数/.test(ok)) problems.push('参数正确时仍报了未知参数（误报）')
if (/未知参数/.test(farOff)) problems.push('不像的未知键也报了提示（噪音）')

const lines = [
  '端到端（真 MCP stdio）：参数纠错 Did you mean',
  `  ① 错参数 lanes → 提示 : ${/未知参数 `lanes`/.test(typo) && /是否想传 `lane`/.test(typo) ? '有 ✓' : '无'}`,
  `  ② 正确参数 lane → 误报 : ${/未知参数/.test(ok) ? '有（不该）' : '无 ✓'}`,
  `  ③ 无关键 zwischenzug   : ${/未知参数/.test(farOff) ? '报（噪音）' : '静默 ✓'}`,
  `  断言 : ${problems.length ? 'FAIL\n    - ' + problems.join('\n    - ') : 'PASS（4 项全过）'}`,
  '',
  '──── 错参数时的实际输出（前 5 行）────',
  typo.split('\n').slice(0, 5).join('\n'),
  '',
  '──── 提示所在行 ────',
  typo.split('\n').filter((l) => l.includes('未知参数') || l.includes('本工具参数')).join('\n'),
]
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
process.exit(problems.length ? 1 : 0)
