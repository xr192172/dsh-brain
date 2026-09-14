// check-compaction-fallback-shape.mjs — 回归守卫：兜底摘要对象必须满足稳定性断言所需的字段契约。
//
// 背景（2026-09-13 事故）：deterministicFallbackPrune() 返回的对象漏了 `measurement`，
// 而下一行 assertWholeSurfaceUnchanged() 就读 prepared.measurement.nodes →
// "Cannot read properties of undefined (reading 'nodes')"，兜底路径 100% 崩溃，
// surface 永不收缩、400 持续。
//
// 本脚本把「断言读什么」与「兜底给什么」做静态对照，缺字段即非零退出。
// 用法： node scripts/check-compaction-fallback-shape.mjs
import fs from 'node:fs'

const FILE = 'D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
const src = fs.readFileSync(FILE, 'utf8')

const fail = []
const ok = []
const note = (s) => console.log(s)

/** 截取一个顶层 function 的完整函数体（按大括号配平）。 */
function bodyOf(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) return null
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

/** 断言函数从 prepared/参数 上读了哪些字段。 */
function fieldsReadFrom(body, param) {
  const found = new Set()
  const re = new RegExp('\\b' + param + '\\.([A-Za-z_$][\\w$]*)', 'g')
  let m
  while ((m = re.exec(body)) !== null) found.add(m[1])
  return found
}

const assertions = ['assertWholeSurfaceUnchanged', 'assertSelectedSpanStable']
const fallback = bodyOf('deterministicFallbackPrune')

if (fallback === null) fail.push('未找到 deterministicFallbackPrune（包结构变了？）')
if (fallback === null) {
  note('FAIL: 无法定位 deterministicFallbackPrune')
  process.exit(1)
}

// 兜底对象提供的字段：字面量键名 + 是否 spread 了 prepared
const provided = new Set()
for (const m of fallback.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) provided.add(m[1])
const spreadsPrepared = /\.\.\.\s*prepared\b/.test(fallback)

for (const name of assertions) {
  const body = bodyOf(name)
  if (body === null) { fail.push('未找到 ' + name); continue }
  const needed = fieldsReadFrom(body, 'prepared')
  const missing = [...needed].filter((f) => !provided.has(f))
  if (missing.length === 0) {
    ok.push(`${name}: 兜底对象已含其读取的全部字段 (${[...needed].join(', ')})`)
  } else if (spreadsPrepared) {
    ok.push(`${name}: 兜底对象 spread 了 prepared，字段 ${missing.join(', ')} 由 prepared 透传`)
  } else {
    fail.push(`${name} 读取了兜底对象未提供的字段: ${missing.join(', ')} —— 这会导致 TypeError`)
  }
}

// 兜底路径必须放宽为 selected-span 稳定性（确定性裁剪不依赖模型输出）
const region = bodyOf('compactSurfaceRegion') ?? ''
if (/assertStable\s*=\s*assertSelectedSpanStable/.test(region)) {
  ok.push('compactSurfaceRegion: 兜底路径已切到 assertSelectedSpanStable')
} else {
  fail.push('compactSurfaceRegion: 兜底路径未切换到 assertSelectedSpanStable（整条 surface 变动会让兜底失效）')
}

note('=== 压缩兜底契约检查 ===')
note('文件: ' + FILE)
for (const line of ok) note('  OK   ' + line)
for (const line of fail) note('  FAIL ' + line)
note(fail.length === 0 ? '\n结果: PASS' : `\n结果: FAIL (${fail.length} 项)`)
process.exit(fail.length === 0 ? 0 : 1)
