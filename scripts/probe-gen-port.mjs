/**
 * probe-gen-port.mjs —— 验证：system prompt 里嵌入的 gen 实例端口是否随会话迁移而变化
 *
 * 假设：DSH 的 system prompt 含 "You are interacting with the user through the
 * DeepSeek Harness Web GUI at http://127.0.0.1:<port>"，该 <port> 是**当前 gen 实例**的端口。
 * 当会话在不同 gen 之间迁移（换代 / 蓝绿翻转 / resume 到别的实例）时，该端口变化
 * → system prompt 字节变化 → 整个前缀失效 → 全量 cache miss。
 *
 * 输出：每个 header 的 (seq, reason, systemLen, toolsCount, guiPort)，以及端口变化与命中的对应。
 */
import fs from 'node:fs'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/gen-port.txt'

const targets = process.argv.slice(2)
const out = []
const say = (x = '') => out.push(x)
const fmtT = (ms) => (typeof ms === 'number' ? new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(11, 19) : '?')

function load(rel) {
  const text = Buffer.from(decompress(fs.readFileSync(`${ROOT}/${rel}/session.jsonl.zstd`))).toString('utf8')
  return text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((e) => e && typeof e.seq === 'number')
}

for (const rel of targets) {
  let evs
  try { evs = load(rel) } catch (e) { say(`FAIL ${rel}: ${e.message}`); continue }
  const short = rel.split('/').pop().slice(0, 20)

  const headers = evs.filter((e) => e.type === 'request/header')
  const ports = new Map()
  say(`===== ${short} =====`)
  say('')
  say('seq     | time     | reason  | sysLen | tools | GUI port | system 尾部差异')
  for (const h of headers) {
    const d = h.data?.header ?? {}
    const sys = String(d.system ?? '')
    const m = sys.match(/127\.0\.0\.1:(\d+)/)
    const port = m ? m[1] : '(none)'
    const tl = Array.isArray(d.tools) ? d.tools.length : 0
    ports.set(port, (ports.get(port) || 0) + 1)
    say(`${String(h.seq).padStart(7)} | ${fmtT(h.time)} | ${String(h.data?.reason ?? '').padEnd(7)} | ${String(sys.length).padStart(6)} | ${String(tl).padStart(5)} | ${String(port).padStart(8)} | ${sys.slice(0, 0)}`)
  }
  say('')
  say(`GUI 端口分布: ${[...ports.entries()].map(([p, n]) => `${p}×${n}`).join('  ')}`)
  say(`不同端口数: ${ports.size}${ports.size > 1 ? '   ⚠️ 前缀会因端口变化而失效' : '   ✓ 单一实例'}`)

  // 把每个 header 的端口映射到其后的 usage
  const turns = []
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const u = e.data?.usage
    if (!u) continue
    const i = u.inputTokens ?? 0, cr = u.cacheReadTokens ?? 0, cw = u.cacheWriteTokens ?? 0
    const b = i + cr + cw
    turns.push({ seq: e.seq, billed: b, hit: b ? cr / b : 0, time: e.time })
  }
  // 对每个 header 端口，统计其后第一条 usage 的命中率
  const perPort = new Map()
  for (let hi = 0; hi < headers.length; hi++) {
    const h = headers[hi]
    const d = h.data?.header ?? {}
    const m = String(d.system ?? '').match(/127\.0\.0\.1:(\d+)/)
    const port = m ? m[1] : '(none)'
    const next = turns.find((t) => t.seq > h.seq)
    if (!next) continue
    if (!perPort.has(port)) perPort.set(port, { n: 0, sum: 0 })
    const g = perPort.get(port)
    g.n++; g.sum += next.hit
  }
  say('')
  say('端口 → 其导入之后第一条请求的命中率:')
  for (const [p, g] of perPort) say(`   ${p}: ${(100 * g.sum / g.n).toFixed(1)}%  (n=${g.n})`)

  // 端口变化点 vs 骤降点
  let portChanges = 0
  const changeSeqs = []
  for (let i = 1; i < headers.length; i++) {
    const a = String(headers[i - 1].data?.header?.system ?? '').match(/127\.0\.0\.1:(\d+)/)?.[1]
    const b = String(headers[i].data?.header?.system ?? '').match(/127\.0\.0\.1:(\d+)/)?.[1]
    if (a !== b) { portChanges++; changeSeqs.push({ seq: headers[i].seq, from: a, to: b }) }
  }
  say('')
  say(`端口变化次数: ${portChanges} / ${headers.length - 1}`)
  for (const c of changeSeqs) {
    const after = turns.filter((t) => t.seq > c.seq).slice(0, 2)
    say(`   seq=${c.seq}  ${c.from} → ${c.to}   其后命中率: ${after.map((t) => (100 * t.hit).toFixed(1) + '%').join(', ')}`)
  }
  say('')
}

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log('written:', OUT)
