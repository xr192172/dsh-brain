/**
 * analyze-idle-gap.mjs —— 量化「空闲间隔」与「冷启动」对 cache 命中率的影响
 *
 * 动机：新会话 b79a6e91（512K 窗口、0 压缩、0 prune）命中率仍只有 70.57%，
 * 逐轮看是「每个 turn 第一条 0%」+「长空闲后 0%」。需要把这两类不可避免的成本量化出来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/idle-gap.txt'

const out = []
const say = (x = '') => out.push(x)
const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%')
const fmt = (n) => Math.round(n).toLocaleString('en-US')

const sessions = []
for (const dir of fs.readdirSync(ROOT)) {
  const dp = path.join(ROOT, dir)
  if (!fs.statSync(dp).isDirectory()) continue
  for (const s of fs.readdirSync(dp)) {
    const f = path.join(dp, s, 'session.jsonl.zstd')
    if (fs.existsSync(f)) sessions.push({ rel: `${dir}/${s}`, file: f, size: fs.statSync(f).size })
  }
}

function load(file) {
  const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  return text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((e) => e && typeof e.seq === 'number')
}

// 间隔分组：<1min（连续工作） / 1-5min / 5-30min / >30min（缓存大概率过期）
const BUCKETS = [
  { label: '连续 (<1 分钟)', lo: 0, hi: 60 },
  { label: '1~5 分钟', lo: 60, hi: 300 },
  { label: '5~30 分钟', lo: 300, hi: 1800 },
  { label: '>30 分钟（疑似过期）', lo: 1800, hi: Infinity },
]

const buckets = BUCKETS.map(() => ({ n: 0, sum: 0 }))
const firstOfTurn = { n: 0, sum: 0 }
const restOfTurn = { n: 0, sum: 0 }
const zeroHits = { n: 0, zero: 0, billedZero: 0, billedAll: 0 }
let grand = { n: 0, sum: 0, billed: 0 }

const perSession = []

for (const s of sessions) {
  let evs
  try { evs = load(s.file) } catch { continue }
  const turns = []
  for (const e of evs) {
    if (e.type !== 'assistant/message') continue
    const u = e.data?.usage
    if (!u) continue
    const i = u.inputTokens ?? 0, cr = u.cacheReadTokens ?? 0, cw = u.cacheWriteTokens ?? 0
    const b = i + cr + cw
    turns.push({ seq: e.seq, turn: e.data?.turn, time: e.time, billed: b, hit: b ? cr / b : 0 })
  }
  if (!turns.length) continue

  let sN = 0, sSum = 0, sBill = 0
  const seenTurn = new Set()
  for (let k = 0; k < turns.length; k++) {
    const t = turns[k]
    if (t.billed < 500) continue
    grand.n++; grand.sum += t.hit; grand.billed += t.billed
    sN++; sSum += t.hit; sBill += t.billed

    // 每 turn 的第一条
    if (!seenTurn.has(t.turn)) {
      seenTurn.add(t.turn)
      firstOfTurn.n++; firstOfTurn.sum += t.hit
    } else {
      restOfTurn.n++; restOfTurn.sum += t.hit
    }

    // 与上一条的时间间隔
    const prev = turns[k - 1]
    if (prev && typeof prev.time === 'number' && typeof t.time === 'number') {
      const gap = (t.time - prev.time) / 1000
      for (let bi = 0; bi < BUCKETS.length; bi++) {
        if (gap >= BUCKETS[bi].lo && gap < BUCKETS[bi].hi) { buckets[bi].n++; buckets[bi].sum += t.hit; break }
      }
      if (gap >= 300) { zeroHits.n++; if (t.hit < 0.05) { zeroHits.zero++; zeroHits.billedZero += t.billed } }
      zeroHits.billedAll += t.billed
    }
  }
  perSession.push({ rel: s.rel, sizeMB: s.size / 1048576, n: sN, hit: sSum / sN, billed: sBill })
}

say('# 空闲间隔 / 冷启动 对 cache 命中率的影响')
say('')
say('> 数据源：全部会话的 `assistant/message.usage`（含 512K 时代的新会话）。')
say('> 只统计 `billed > 500` 的轮次。')
say('')

say('## 按「与上一条请求的时间间隔」分组')
say('')
say('| 间隔 | 轮数 | 平均命中率 |')
say('|---|---|---|')
for (let i = 0; i < BUCKETS.length; i++) {
  const b = buckets[i]
  if (b.n) say(`| ${BUCKETS[i].label} | ${fmt(b.n)} | **${pct(b.sum / b.n)}** |`)
}
say('')

say('## 按「是否为本 turn 第一条」分组')
say('')
say('| 类别 | 轮数 | 平均命中率 |')
say('|---|---|---|')
if (firstOfTurn.n) say(`| **每 turn 第一条**（冷启动） | ${fmt(firstOfTurn.n)} | **${pct(firstOfTurn.sum / firstOfTurn.n)}** |`)
if (restOfTurn.n) say(`| 同 turn 内后续 step | ${fmt(restOfTurn.n)} | **${pct(restOfTurn.sum / restOfTurn.n)}** |`)
say('')

say('## 全量')
say('')
say(`| 轮数 | 简单平均命中率 | 计费 input 合计 |`)
say(`|---|---|---|`)
say(`| ${fmt(grand.n)} | **${pct(grand.sum / grand.n)}** | ${fmt(grand.billed)} |`)
say('')
if (zeroHits.n) {
  say(`间隔 >5 分钟的轮次：${zeroHits.n} 轮，其中命中率 ≈0 的有 **${zeroHits.zero}** 轮，`)
  say(`这些"近似全 miss"轮贡献了 ${fmt(zeroHits.billedZero)} 计费 input（占这些长间隔轮的 ${pct(zeroHits.billedZero / zeroHits.billedAll)}）。`)
}
say('')

say('## 会话明细（含 512K 时代新会话）')
say('')
say('| session | MB | 轮数 | 命中率 |')
say('|---|---|---|---|')
for (const r of perSession.sort((a, b) => b.hit - a.hit)) {
  say(`| ${r.rel.replace(/^--/g, '').slice(0, 52)} | ${r.sizeMB.toFixed(2)} | ${r.n} | ${pct(r.hit)} |`)
}

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log('written:', OUT)
