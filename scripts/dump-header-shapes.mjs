/**
 * dump-header-shapes.mjs —— 直接对比不同 header 形态的实际内容
 * 回答：75429|1 与 1789|69 分别是什么？tools 数量为何在 94/95/96 间变？
 */
import fs from 'node:fs'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const target = process.argv[2]
const file = `${ROOT}/${target}/session.jsonl.zstd`
const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
const evs = text.split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((e) => e && typeof e.seq === 'number')

const out = []
const say = (x = '') => out.push(x)

const headers = evs.filter((e) => e.type === 'request/header')
const fp = (h) => {
  const d = h.data?.header ?? {}
  return `${(d.system ?? '').length}|${Array.isArray(d.tools) ? d.tools.length : 0}`
}

// 每种指纹取一个样本
const seen = new Map()
for (const h of headers) {
  const k = fp(h)
  if (!seen.has(k)) seen.set(k, h)
}

for (const [k, h] of seen) {
  const d = h.data?.header ?? {}
  const tools = Array.isArray(d.tools) ? d.tools : []
  say(`########## 形态 ${k} ##########`)
  say(`seq=${h.seq}  reason=${h.data?.reason}  time=${h.time}`)
  say(`config=${JSON.stringify(d.config)}`)
  say('')
  say(`--- system 前 600 字符 ---`)
  say(String(d.system ?? '').slice(0, 600))
  say('')
  say(`--- tools (${tools.length}) 名称 ---`)
  say(tools.map((t) => t.name ?? t.function?.name ?? '?').join(', ').slice(0, 1200))
  say('')
  // system 里是否提到 run_code / SDK
  const sys = String(d.system ?? '')
  say(`system 含 'run_code': ${sys.includes('run_code')}`)
  say(`system 含 'SDK' / 'tools.': ${sys.includes('SDK') || sys.includes('tools.')}`)
  say(`tools 里有 run_code: ${tools.some((t) => (t.name ?? t.function?.name) === 'run_code')}`)
  say('')
}

// tools 数量变化：对比 94/95/96 的差异
const byCount = new Map()
for (const h of headers) {
  const d = h.data?.header ?? {}
  const tools = Array.isArray(d.tools) ? d.tools.map((t) => t.name ?? t.function?.name) : []
  const n = tools.length
  if (!byCount.has(n)) byCount.set(n, { names: new Set(tools), sample: h.seq })
}
if (byCount.size > 1) {
  say('########## tools 数量差异 ##########')
  const counts = [...byCount.keys()].sort((a, b) => a - b)
  for (const c of counts) say(`  n=${c} (sample seq=${byCount.get(c).sample})`)
  // 以最大集合为基准，求差集
  const base = byCount.get(counts.at(-1)).names
  for (const c of counts.slice(0, -1)) {
    const s = byCount.get(c).names
    const missing = [...base].filter((x) => !s.has(x))
    const extra = [...s].filter((x) => !base.has(x))
    say(`  n=${c} 相对 n=${counts.at(-1)}: 缺 ${JSON.stringify(missing)} / 多 ${JSON.stringify(extra)}`)
  }
}

fs.writeFileSync('D:/project_develop/dsh-brain/out/header-shapes.txt', out.join('\n'), 'utf8')
console.log('written: out/header-shapes.txt')
