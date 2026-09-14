/**
 * probe-dc-capability-map-mcp.mjs —— 端到端探针：用真 MCP 协议调 design-canvas 的 capability_map
 *
 * 为什么需要：改完源码 + rebuild 只证明"文件是新的"。要证明**宿主模型拿到的是新地图**，
 * 必须走真正的 stdio MCP 通道（宿主就是这么拉起的：mcp-client --stdio--> dist/src/server.js）。
 *
 * 断言（任一失败 exit 1）：
 *   ① 工具总数 = 60（注册表未因改造而增减）
 *   ② capability_map 无参输出含「60 工具 / 6 线」与「目录由工具注册表自动派生」
 *   ③ 曾漏网的 5 个工具（memory_observe/memory_targets/go_originals/move_symbol/capability_map）都可见
 *   ④ 输出里没有「未归线工具」段（= 0 漏归）
 *
 * 用法：node scripts/probe-dc-capability-map-mcp.mjs
 */
import { Client } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import fs from 'node:fs'

const DC = 'D:/project_develop/design-canvas'
const OUT = 'D:/project_develop/dsh-brain/out/dc-capability-map-mcp.txt'

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${DC}/dist/src/server.js`],
  env: { ...process.env, DESIGN_CANVAS_HOME: 'D:/project_develop/dsh-brain/.design-canvas' },
  cwd: DC,
})
const client = new Client({ name: 'dsh-brain-probe', version: '0.0.0' })

const problems = []
await client.connect(transport)

const tl = await client.listTools()
const names = tl.tools.map((t) => t.name).sort()

const r = await client.callTool({ name: 'capability_map', arguments: {} })
const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')

// ★ 不写死工具数：地图头部的数字必须与真实 tools/list 一致（同一课：别手抄注册表）
const headerCount = Number((text.match(/（(\d+) 工具 \/ (\d+) 线）/) ?? [])[1] ?? NaN)
const headerLanes = Number((text.match(/（(\d+) 工具 \/ (\d+) 线）/) ?? [])[2] ?? NaN)
if (!Number.isFinite(headerCount)) problems.push('输出未含「（N 工具 / M 线）」头部')
else if (headerCount !== names.length) problems.push(`头部工具数 ${headerCount} ≠ tools/list ${names.length}`)
if (headerLanes !== 6) problems.push(`头部线数 ${headerLanes} ≠ 6`)
if (names.length < 60) problems.push(`工具数异常偏少：${names.length}`)
if (!text.includes('目录由工具注册表自动派生')) problems.push('输出未含派生说明（拿到的是旧地图？）')
const must = ['memory_observe', 'memory_targets', 'go_originals', 'move_symbol', 'capability_map']
for (const n of must) if (!text.includes(n)) problems.push(`曾漏网的工具仍不可见：${n}`)
if (text.includes('未归线工具')) problems.push('输出里出现了「未归线工具」段')
const laneLines = (text.match(/^◆ /gm) ?? []).length
if (laneLines !== 6) problems.push(`能力线段数 ${laneLines} ≠ 6`)

await client.close()

const lines = [
  `端到端（真 MCP stdio）探针：capability_map`,
  `  工具总数 : ${names.length}`,
  `  能力线段 : ${laneLines}`,
  `  人读行数 : ${text.split('\n').length}`,
  `  断言     : ${problems.length ? 'FAIL\n    - ' + problems.join('\n    - ') : 'PASS（4 项全过）'}`,
  '',
  '──── 模型侧实际拿到的输出（前 20 行）────',
  ...text.split('\n').slice(0, 20),
]
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
process.exit(problems.length ? 1 : 0)
