/**
 * probe-dc-snapshot-mcp.mjs —— 端到端验证「可撤回」：真编辑 → 一键回滚
 *
 * 出处：aider（自动 commit + /undo）；本项目设计原则 6「危险的不是能力，是不可撤回」。
 * 断言（走真 MCP stdio）：
 *   ① edit_code 真落盘前自动生成快照（list_snapshots 非空）
 *   ② 文件确实被改了
 *   ③ rollback_snapshot（latest）把内容复原
 *   ④ 回滚后再列快照仍可用（幂等/可反复）
 *
 * 用法：node scripts/probe-dc-snapshot-mcp.mjs
 */
import { Client } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from 'file:///D:/project_develop/design-canvas/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const OUT = 'D:/project_develop/dsh-brain/out/dc-snapshot.txt'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-snap-'))
const file = path.join(root, 'src', 'a.ts')
fs.mkdirSync(path.dirname(file), { recursive: true })
const ORIGINAL = 'export function probe(): number {\n  return 1;\n}\n'
fs.writeFileSync(file, ORIGINAL, 'utf8')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${DC}/dist/src/server.js`],
  env: { ...process.env, DESIGN_CANVAS_HOME: path.join(root, '.dc-home') },
  cwd: DC,
})
const client = new Client({ name: 'dsh-brain-snap-probe', version: '0.0.0' })
await client.connect(transport)

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args })
  return (r.content ?? []).map((c) => c.text ?? '').join('\n')
}

const edit = await call('edit_code', {
  project_dir: root,
  file: 'src/a.ts',
  op: 'replace',
  symbol: 'probe',
  code: 'export function probe(): number {\n  return 42;\n}',
})
const afterEdit = fs.readFileSync(file, 'utf8')
const list1 = await call('list_snapshots', { project_dir: root })
const rollback = await call('rollback_snapshot', { project_dir: root }) // 省略 snapshot = latest
const afterRollback = fs.readFileSync(file, 'utf8')
const list2 = await call('list_snapshots', { project_dir: root })
await client.close()

const problems = []
if (!/代码快照 [1-9]/.test(list1)) problems.push('edit_code 落盘后没有快照（list_snapshots 为空）')
if (!afterEdit.includes('return 42;')) problems.push('edit_code 未真正落盘')
if (afterRollback !== ORIGINAL) problems.push('回滚未复原文件内容')
if (!/已回滚代码快照/.test(rollback)) problems.push('rollback 回执异常：' + rollback.slice(0, 80))
if (!/代码快照 [1-9]/.test(list2)) problems.push('回滚后快照列表异常（应仍可查/可反复回滚）')

const lines = [
  '端到端（真 MCP stdio）：可撤回 —— edit_code 自动快照 + 一键回滚',
  `  临时项目        : ${root}`,
  `  ① 落盘后快照    : ${/代码快照 [1-9]/.test(list1) ? '有 ✓' : '无'}`,
  `  ② 文件已改      : ${afterEdit.includes('return 42;') ? '是 ✓' : '否'}`,
  `  ③ 回滚复原      : ${afterRollback === ORIGINAL ? '是 ✓' : '否'}`,
  `  ④ 回滚后仍可查  : ${/代码快照 [1-9]/.test(list2) ? '是 ✓' : '否'}`,
  `  断言 : ${problems.length ? 'FAIL\n    - ' + problems.join('\n    - ') : 'PASS（5 项全过）'}`,
  '',
  '──── list_snapshots（回滚前）────',
  list1.split('\n').slice(0, 4).join('\n'),
  '',
  '──── rollback_snapshot 回执 ────',
  rollback.split('\n').slice(0, 3).join('\n'),
  '',
  '──── edit_code 回执（前 3 行）────',
  edit.split('\n').slice(0, 3).join('\n'),
]
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(lines.join('\n'))

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* Windows 占用留给 OS */
}
process.exit(problems.length ? 1 : 0)
