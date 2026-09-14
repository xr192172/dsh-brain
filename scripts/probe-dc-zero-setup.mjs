/**
 * probe-dc-zero-setup.mjs —— 端到端验证「零前置」：不跑 import_project，直接查一个陌生项目
 *
 * 为什么值得单独探针：这是 `ast-io-entry.md` 的 N1（零前置）第一次真正可用。
 * 旧语义：空库 → 查询层抛「请先运行 import_project」= tool-convergence §5.6 障碍 #2 的根因。
 * 新语义：空库 → 就地冷启 bootstrap，agent 遇到任何项目**直接就能读**。
 *
 * 走真 MCP stdio（宿主就是这么拉起的），断言：
 *   ① 调用前：临时项目里没有 .design-canvas/cache.db（确实是"陌生项目"）
 *   ② 只调一次 explore_code(action=search)，**不调 import_project**
 *   ③ 命中目标符号（provider=exact），且 message 出现「冷启动建索引」
 *   ④ 调用后：cache.db 已生成（索引确实是被这次查询静默建起来的）
 *
 * 用法：node scripts/probe-dc-zero-setup.mjs
 */
import { Client } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const OUT = 'D:/project_develop/dsh-brain/out/dc-zero-setup.txt'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-zero-'))
const dbFile = path.join(root, '.design-canvas', 'cache.db')
fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
fs.writeFileSync(
  path.join(root, 'src', 'deep', 'mod.ts'),
  'export function zeroSetupProbe(x: number): number {\n  return x * 3;\n}\n',
  'utf8',
)

const before = fs.existsSync(dbFile)
const problems = []

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${DC}/dist/src/server.js`],
  env: { ...process.env, DESIGN_CANVAS_HOME: path.join(root, '.dc-home') },
  cwd: DC,
})
const client = new Client({ name: 'dsh-brain-zero-probe', version: '0.0.0' })
await client.connect(transport)

const r = await client.callTool({
  name: 'explore_code',
  arguments: { action: 'search', args: { project_dir: root, query: 'zeroSetupProbe' } },
})
const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')

// ★ 第二条：find_references 曾因"未建索引"直接拒绝（ok:false）；
// 零前置后应自己冷启并给出闭包结果。
const fr = await client.callTool({
  name: 'find_references',
  arguments: { project_dir: root, file: 'src/deep/mod.ts', symbol: 'zeroSetupProbe' },
})
const frText = (fr.content ?? []).map((c) => c.text ?? '').join('\n')
await client.close()

const after = fs.existsSync(dbFile)
if (before) problems.push('调用前就已存在 cache.db —— 这个项目不算"陌生"')
if (!after) problems.push('调用后仍没有 cache.db —— 冷启没建索引')
if (!/zeroSetupProbe/.test(text)) problems.push('没命中目标符号')
if (!/冷启动建索引/.test(text)) problems.push('输出里没有「冷启动建索引」注记（拿到的是旧语义？）')
if (/请先运行 import_project|请先对该项目运行/.test(text)) problems.push('仍要求先 import_project（零前置未生效）')
if (/"ok"\s*:\s*false/.test(frText) || /未建索引/.test(frText)) {
  problems.push('find_references 仍以"未建索引"拒绝（零前置未覆盖该工具）')
}

const lines = [
  '端到端（真 MCP stdio）：零前置冷启动 —— 陌生项目不跑 import_project 直接查',
  `  临时项目        : ${root}`,
  `  调用前 cache.db : ${before ? '已存在' : '不存在 ✓'}`,
  `  调用后 cache.db : ${after ? '已生成 ✓' : '未生成'}`,
  `  命中符号        : ${/zeroSetupProbe/.test(text) ? '是 ✓' : '否'}`,
  `  冷启动注记      : ${/冷启动建索引/.test(text) ? '有 ✓' : '无'}`,
  `  find_references : ${problems.some((p) => p.includes('find_references')) ? '仍拒绝' : '自建索引后可用 ✓'}`,
  `  断言            : ${problems.length ? 'FAIL\n    - ' + problems.join('\n    - ') : 'PASS（6 项全过）'}`,
  '',
  '──── explore_code(search) 实际输出 ────',
  text.split('\n').slice(0, 8).join('\n'),
  '',
  '──── find_references 实际输出（前 6 行）────',
  frText.split('\n').slice(0, 6).join('\n'),
]
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* Windows 占用，留给 OS */
}
process.exit(problems.length ? 1 : 0)
