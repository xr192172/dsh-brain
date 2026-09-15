#!/usr/bin/env node
/**
 * check-session-integrity.mjs —— 会话日志体健门
 *
 * ## 为什么它是"装配级"的门，而不是数据修复工具
 *
 * 2026-09-15 实测：**一份坏会话能让整代起不来**。
 * 启动时 `dsh-workspace` 会 `list()` 所有会话 ⇒
 *   · 帧契约坏（第一帧不是恰好一行）⇒ `corrupt Zstandard session log: first frame …`
 *   · seq 不连续 ⇒ `corrupt session log: seq gap in committed region`
 *   · surface 事件缺 `id`/`source` ⇒ `… lacks an identified message`
 * 三者都会让**新代启动失败**（健康检查回滚）。
 *
 * ⇒ 所以它该在**换代之前**跑，而不是等下一代失败了再查。
 *
 * ## 判据全部来自**读者自己的实现**（不自己复刻）
 *
 *   · 帧契约：`assertZstdHeaderFrame` —— 第一帧明文必须恰好一行（只有 1 个 \n 且在末尾）
 *   · 展开与连续性：`decodeStorageRecord`（`@deepseek-ai/dsh-session`）逐行展开后 seq === 下标
 *   · 消息身份：`assertMessageEventShape` 的条款（id 非空 / role / source.kind 非空 / content 数组）
 *
 * ## 用法
 *   node scripts/check-session-integrity.mjs            # 扫全部
 *   node scripts/check-session-integrity.mjs --limit 5  # 只看最近 5 个
 *   node scripts/check-session-integrity.mjs --all      # 含全量连续性扫描（慢）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { decompress } from 'fzstd'

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const ROOT = path.join(HOME, 'sessions')
const REPO = 'D:/project_develop/dsh-brain'
const argv = process.argv.slice(2)
const FULL = argv.includes('--all')
const limitArg = argv.indexOf('--limit')
const LIMIT = limitArg >= 0 ? Number(argv[limitArg + 1]) : 0

const S = await import(pathToFileURL(path.join(REPO, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href)
const decodeStorageRecord = S.decodeStorageRecord

const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** assertZstdHeaderFrame 的条款：第一帧明文恰好一行。 */
function frameContract(buf) {
  // 找第二个 frame magic，切出第一帧
  let second = -1
  for (let i = 4; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) { second = i; break }
  }
  const firstFrame = second < 0 ? buf : buf.subarray(0, second)
  let plain
  try { plain = Buffer.from(decompress(new Uint8Array(firstFrame))).toString('utf8') } catch (e) { return { ok: false, why: '第一帧解不开：' + e.message } }
  if (plain.length === 0 || plain.indexOf('\n') !== plain.length - 1) {
    return { ok: false, why: `第一帧不是"恰好一行"（${plain.length} 字节，含 ${plain.split('\n').length - 1} 个换行）` }
  }
  return { ok: true, frameBytes: firstFrame.length }
}

/** 逐行展开，返回第一个不连续点。 */
function scanEvents(eventLines, stopAtFirstBreak) {
  let count = 0
  for (const [i, l] of eventLines.entries()) {
    let v
    try { v = JSON.parse(l) } catch { return { ok: false, at: i, why: 'JSON 解析失败', events: count } }
    let decoded
    try { decoded = decodeStorageRecord(v) } catch (e) { return { ok: false, at: i, why: 'decode 抛错：' + e.message, events: count } }
    for (const ev of decoded) {
      if (ev.seq !== count) return { ok: false, at: i, expected: count, got: ev.seq, events: count }
      count++
      if (!stopAtFirstBreak && count > 400000) return { ok: true, events: count, truncated: true }
    }
  }
  return { ok: true, events: count }
}

/** 消息身份违规（assertMessageEventShape 条款）。 */
function identityViolations(events) {
  const bad = []
  for (const e of events) {
    if (!SURFACE.has(e.type)) continue
    const d = e.data ?? {}
    const m = e.type === 'user/message' ? d : d.message
    if (typeof m !== 'object' || m === null || typeof m.id !== 'string' || m.id === '') bad.push({ seq: e.seq, type: e.type, why: 'id 缺失' })
    else if (m.role !== (e.type === 'assistant/message' ? 'assistant' : 'user')) bad.push({ seq: e.seq, type: e.type, why: 'role 不符' })
    else if (typeof m.source !== 'object' || m.source === null || typeof m.source.kind !== 'string' || m.source.kind === '') bad.push({ seq: e.seq, type: e.type, why: 'source.kind 缺失' })
    else if (!Array.isArray(m.content)) bad.push({ seq: e.seq, type: e.type, why: 'content 非数组' })
  }
  return bad
}

// 收集会话
const files = []
;(function walk(d, depth) {
  if (depth > 3) return
  let es = []
  try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { walk(p, depth + 1); continue }
    if (e.name !== 'session.jsonl.zstd') continue
    files.push({ p, m: fs.statSync(p).mtimeMs })
  }
})(ROOT, 0)
files.sort((a, b) => b.m - a.m)
const targets = LIMIT ? files.slice(0, LIMIT) : files

console.log(`会话体检：${targets.length} / ${files.length} 个${LIMIT ? `（--limit ${LIMIT}）` : ''}${FULL ? '  [全量连续性扫描]' : ''}`)
console.log('─'.repeat(84))

let nFrame = 0   // ERROR：阻塞启动
let nLoad = 0    // WARN：只让那份会话历史打不开
for (const f of targets) {
  const rel = path.relative(ROOT, f.p)
  const id = path.basename(path.dirname(f.p))
  const frameProblems = []
  const loadProblems = []
  let buf
  try { buf = fs.readFileSync(f.p) } catch (e) { frameProblems.push('读文件失败：' + e.message) }

  if (buf) {
    const fc = frameContract(buf)
    if (!fc.ok) frameProblems.push('帧契约：' + fc.why)
    let text = null
    try { text = Buffer.from(decompress(new Uint8Array(buf))).toString('utf8') } catch (e) { frameProblems.push('整份解不开：' + e.message) }
    if (text) {
      const lines = text.split('\n')
      const eventLines = lines.slice(1).filter((l) => l.trim())
      const sc = scanEvents(eventLines, !FULL)
      if (!sc.ok) loadProblems.push(`seq 不连续：事件行 #${sc.at + 1}（expected ${sc.expected} / got ${sc.got}）⇒ 缺 ${sc.expected - sc.got} 个`)
      if (FULL && sc.ok) {
        const evs = []
        for (const l of eventLines) { try { for (const ev of decodeStorageRecord(JSON.parse(l))) evs.push(ev) } catch { } }
        const iv = identityViolations(evs)
        if (iv.length) loadProblems.push(`消息缺身份：${iv.length} 处（首处 seq=${iv[0].seq} ${iv[0].why}）`)
      }
    }
  }

  if (frameProblems.length) {
    nFrame++
    console.log(`  ✗ ERROR ${id}  ← **会让新代启动失败**`)
    for (const p of frameProblems) console.log(`      · ${p}`)
  }
  if (loadProblems.length) {
    nLoad++
    console.log(`  ⚠ WARN  ${id}  ← 只影响这份会话的历史`)
    for (const p of loadProblems) console.log(`      · ${p}`)
  }
}

console.log('')
if (nFrame) {
  console.log(`  ✗ ${nFrame} 个会话**帧契约坏** —— 这会让新代启动失败（启动时 list() 要读每个会话的第一帧）。`)
  console.log('    修法见下；**这类必须修**。')
}
if (nLoad) {
  console.log(`  ⚠ ${nLoad} 个会话 seq 不连续 / 消息缺身份 —— **不阻塞启动**（实测：这类会话存在时换代仍 success），`)
  console.log('    只让那一份会话的历史打不开。修不修看你要不要那份历史。')
}
if (!nFrame && !nLoad) {
  console.log(`  ✅ ${targets.length} 个会话全部合格${FULL ? '（含全量连续性 + 消息身份）' : '（帧契约 + 连续性；加 --all 做全量）'}`)
}
console.log('')
console.log('  修法：node scripts/repair-session-message-id.mjs <会话目录名> --apply   # 补身份')
console.log('        node scripts/repair-session-seq-gap.mjs    <会话目录名> --apply   # 截断（会丢尾部）')
// 只有"会让新代起不来"的那类才算失败
process.exit(nFrame ? 1 : 0)
