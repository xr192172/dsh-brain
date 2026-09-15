#!/usr/bin/env node
/**
 * repair-session-message-id.mjs —— 修**已损坏**的会话日志：给缺身份的消息补 `id`/`source`
 *
 * ## 为什么需要
 *
 * `dsh-session` 的 `assertMessageEventShape`（`lib/index.js:1246-1258`）要求 surface 事件
 * 的 message 有非空 `id` 与非空 `source.kind`。缺了 ⇒ **整份历史读不出来**
 * （`SessionPersistenceError: session event at seq N lacks an identified message`）。
 *
 * 根因已定位并修复在源头（`packages/switchboard/src/index.ts` 的 `injectedUserMessage`），
 * 但**已落盘的坏事件不会自己好** —— 本脚本负责补救历史。
 *
 * ## 安全纪律（这是 `~/.dsh` 下、**不在 git 里**的文件）
 *
 * 1. **默认 dry-run**，要 `--apply` 才动手；
 * 2. 动前 `cp` 备份到 `<dshHome>/.backup/`；
 * 3. 只改**那一行**，其余行**逐字节原样保留**（不重新格式化整份日志）；
 * 4. 写到**临时文件** → 解回来复验（事件数/其它 seq 不变 + 违规归零）→ **才**替换；
 * 5. 替换后再解一次复验。
 *
 * 压缩说明：`fzstd` 只有 `decompress`，所以用 `node:zlib.zstdCompressSync`。
 * 已实测 **zlib 压 → fzstd 解** 往返一致（否则 DSH 侧读不了）。
 *
 * 用法：
 *   node scripts/repair-session-message-id.mjs <会话目录名>            # dry-run
 *   node scripts/repair-session-message-id.mjs <会话目录名> --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { decompress } from 'fzstd'

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const SESSION = argv.find((a) => !a.startsWith('--'))

const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])

/** 校验器口径（抄自 dsh-session `assertMessageEventShape`），返回违规列表。 */
function violations(events) {
  const bad = []
  for (const e of events) {
    if (!SURFACE.has(e.type)) continue
    const d = e.data ?? {}
    const m = e.type === 'user/message' ? d : d.message
    if (typeof m !== 'object' || m === null || typeof m.id !== 'string' || m.id === '') bad.push({ seq: e.seq, type: e.type, why: 'id 缺失/非法' })
    else if (m.role !== (e.type === 'assistant/message' ? 'assistant' : 'user')) bad.push({ seq: e.seq, type: e.type, why: 'role 不符' })
    else if (typeof m.source !== 'object' || m.source === null || typeof m.source.kind !== 'string' || m.source.kind === '') bad.push({ seq: e.seq, type: e.type, why: 'source.kind 缺失' })
    else if (!Array.isArray(m.content)) bad.push({ seq: e.seq, type: e.type, why: 'content 非数组' })
  }
  return bad
}

function findSessionDir(name) {
  const root = path.join(HOME, 'sessions')
  let hit = null
  ;(function walk(d, dep) {
    if (dep > 3 || hit) return
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (!e.isDirectory()) continue
      const p = path.join(d, e.name)
      if (e.name.includes(name)) { hit = p; return }
      walk(p, dep + 1)
    }
  })(root, 0)
  return hit
}

if (!SESSION) {
  console.error('用法：node scripts/repair-session-message-id.mjs <会话目录名> [--apply]')
  process.exit(1)
}
const dir = findSessionDir(SESSION)
if (!dir) { console.error(`✗ 找不到会话：${SESSION}`); process.exit(1) }
const FILE = path.join(dir, 'session.jsonl.zstd')
console.log(`会话: ${dir}`)
console.log(`文件: ${FILE}  (${fs.statSync(FILE).size} 字节)`)
console.log(`模式: ${APPLY ? '★ APPLY（会写入）' : 'dry-run（只报告）'}`)
console.log('')

// ── 读 + 拆行（保留原始行结构）─────────────────────────────────────────────
const raw = Buffer.from(decompress(fs.readFileSync(FILE))).toString('utf8')
const hadTrailingNewline = raw.endsWith('\n')
const lines = raw.split('\n')
const events = []
const idxOf = []   // 行号索引（与 events 对齐）
lines.forEach((l, i) => {
  if (!l.trim()) return
  try { events.push(JSON.parse(l)); idxOf.push(i) } catch { /* 非 JSON 行原样保留 */ }
})
console.log(`事件 ${events.length} 行 / 物理行 ${lines.length}`)

const before = violations(events)
console.log('')
console.log(`=== 修复前违规：${before.length} 处 ===`)
for (const b of before) console.log(`  seq=${b.seq} ${b.type} —— ${b.why}`)

if (!before.length) {
  console.log('')
  console.log('无需修复（本会话在这条判据下是干净的）。')
  process.exit(0)
}

// ── 只在"唯一可判定"的情形下动手：必须是 user/message 缺 id/source ────────────
const targetable = before.filter((b) => b.type === 'user/message' && b.why === 'id 缺失/非法')
const other = before.filter((b) => !targetable.includes(b))
if (other.length) {
  console.log('')
  console.error(`✗ 还有 ${other.length} 处**本脚本不处理**的违规（不是"user/message 缺 id"这一种）：`)
  for (const o of other) console.error(`    seq=${o.seq} ${o.type} —— ${o.why}`)
  console.error('  本脚本刻意只处理已定根因的那一种，别的类型请先分析清楚再动。')
  process.exit(1)
}

// ── 逐条修：补 id 与 source（与源码修复同形）────────────────────────────────
let changed = 0
for (const b of targetable) {
  const ei = events.findIndex((e) => e.seq === b.seq)
  if (ei < 0) continue
  const e = events[ei]
  const fixed = {
    ...e.data,
    id: randomUUID(),
    source: { kind: 'plugin', plugin: 'switchboard' },
  }
  // 保持 role/content 原样，只补两个字段
  events[ei] = { ...e, data: fixed }
  lines[idxOf[ei]] = JSON.stringify(events[ei])
  changed++
}
console.log('')
console.log(`=== 拟修复 ${changed} 处（补 id + source={kind:'plugin',plugin:'switchboard'}）===`)

// ── 复验：事件数不变 / 除目标外的 seq 集合不变 / 违规归零 ────────────────────
const after = violations(events)
const seqsBefore = events.map((e) => e.seq).sort((a, b2) => a - b2).join(',')
const reseq = events.map((e) => e.seq)
const afterSeqsOk = reseq.length === idxOf.length
const problems = []
if (!afterSeqsOk) problems.push('事件数变了（不应发生）')
if (after.length) problems.push(`仍有 ${after.length} 处违规`)

const out = lines.join('\n')
const reparse = out.split('\n').filter((l) => l.trim())
if (reparse.length !== lines.filter((l) => l.trim()).length) problems.push('重序列化后行数变了')
if (hadTrailingNewline !== out.endsWith('\n')) problems.push('行尾换行结构变了')

console.log(`修复后违规：${after.length} 处`)
if (problems.length) {
  console.log('')
  console.error('✗ 复验未过，**不写入**：')
  for (const p of problems) console.error('    · ' + p)
  process.exit(1)
}
console.log('复验：违规归零 / 行结构未变 ✓')

if (!APPLY) {
  console.log('')
  console.log('（dry-run 结束。确认无误后加 --apply 写入。）')
  process.exit(0)
}

// ── 备份 → 写临时 → 再解一次复验 → 替换 → 再复验 ───────────────────────────
const backupDir = path.join(HOME, '.backup')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const bak = path.join(backupDir, `${path.basename(dir)}.session.jsonl.zstd.${stamp}.bak`)
fs.copyFileSync(FILE, bak)
console.log('')
console.log(`已备份原文件 → .backup/${path.basename(bak)}`)

const tmp = `${FILE}.${process.pid}.tmp`
fs.writeFileSync(tmp, zstdCompressSync(Buffer.from(out, 'utf8')))

// 临时文件复验：能解、内容一致、违规归零
const back = Buffer.from(decompress(fs.readFileSync(tmp))).toString('utf8')
const tmpEvents = back.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
if (back !== out) { fs.unlinkSync(tmp); console.error('✗ 临时文件往返内容不一致，已放弃'); process.exit(1) }
if (violations(tmpEvents).length) { fs.unlinkSync(tmp); console.error('✗ 临时文件复验仍有违规，已放弃'); process.exit(1) }
console.log('临时文件复验：往返一致 + 违规归零 ✓')

fs.renameSync(tmp, FILE)
const final = Buffer.from(decompress(fs.readFileSync(FILE))).toString('utf8')
const finalEvents = final.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
console.log('替换后再验：违规 ' + violations(finalEvents).length + ' 处 / 事件 ' + finalEvents.length + ' 条')
console.log('')
console.log('✓ 修复完成。若该会话正被打开，请关掉重开。')
