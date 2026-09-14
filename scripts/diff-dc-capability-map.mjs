/**
 * diff-dc-capability-map.mjs —— 检测 design-canvas「能力线目录」与实际工具注册的漂移
 *
 * 背景：design-canvas/src/tools/capability_map.ts 的注释自己写着
 *   「能力线目录（静态事实，改动工具名/新增工具时同步此处）」
 * —— 这是一份**手工同步**的表，必然漂移。本脚本把漂移变成可检出的。
 *
 * 意义：这是「能力库必须覆盖工具层」的第一个具体证据。
 * 我们的 capability-registry 只登记了 subagent provider；而模型手里**大部分工具来自 MCP**
 * （design-canvas 一家就占 58 个）。不覆盖工具层，"我有哪些能力"就是半个答案。
 *
 * 用法： node scripts/diff-dc-capability-map.mjs
 */
import fs from 'node:fs'

const DC = 'D:/project_develop/design-canvas'
const OUT = 'D:/project_develop/dsh-brain/out/dc-capability-drift.txt'

const regPath = `${DC}/src/server_registry.ts`
const cmPath = `${DC}/src/tools/capability_map.ts`
const out = []

if (!fs.existsSync(regPath) || !fs.existsSync(cmPath)) {
  console.log('X 找不到 design-canvas 源文件，检查路径：' + DC)
  process.exit(1)
}

const reg = fs.readFileSync(regPath, 'utf8')
const cm = fs.readFileSync(cmPath, 'utf8')

// server_registry 里的工具名：行首缩进后的 name: 'xxx'
const registered = new Set([...reg.matchAll(/^\s*name:\s*'([a-z][a-z0-9_]*)'/gm)].map((m) => m[1]))
// capability_map 里收录的工具名：{ name: 'xxx', when: ...
const inLanes = new Set([...cm.matchAll(/\{\s*name:\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]))
// 各线的 direct 白名单
const direct = new Set(
  [...cm.matchAll(/direct:\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((x) => x[1])),
)
// 线 id
const lanes = [...cm.matchAll(/^\s*id:\s*'([a-z]+)',/gm)].map((m) => m[1])

out.push('design-canvas：能力线目录 vs 实际注册（漂移检测）')
out.push(`  源文件: ${regPath}`)
out.push(`  能力线: ${lanes.join(', ')}（${lanes.length} 条）`)
out.push(`  注册表工具数 : ${registered.size}`)
out.push(`  能力线收录数 : ${inLanes.size}`)
out.push(`  direct 白名单 : ${direct.size}`)
out.push('')

const onlyReg = [...registered].filter((x) => !inLanes.has(x)).sort()
const onlyLane = [...inLanes].filter((x) => !registered.has(x)).sort()

out.push(`★ 已注册但没进任何能力线（${onlyReg.length} 条）—— agent 靠 capability_map 导航时看不见它们:`)
for (const x of onlyReg) out.push(`    ${x}`)
if (!onlyReg.length) out.push('    （无）')
out.push('')
out.push(`★ 能力线里写了但注册表没有（${onlyLane.length} 条）—— 陈旧条目，agent 会被指向不存在的工具:`)
for (const x of onlyLane) out.push(`    ${x}`)
if (!onlyLane.length) out.push('    （无）')
out.push('')
const badDirect = [...direct].filter((x) => !inLanes.has(x))
out.push(`direct 白名单里不在任何线内的（应为 0）: ${badDirect.join(', ') || '无'}`)

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log(out.join('\n'))
console.log('\nok -> ' + OUT)
