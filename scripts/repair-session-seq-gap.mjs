#!/usr/bin/env node
/**
 * repair-session-seq-gap.mjs —— 修「seq 不连续」的会话日志：**截断到最后一个连续点**
 *
 * ## 背景（2026-09-15）
 *
 * 两份会话日志报 `corrupt session log: seq gap in committed region`。
 * 用**读者自己的** `decodeStorageRecord` 逐行展开后精确定位到：
 *   · `432f6207` 第 2167 事件行：expected 9435，got 9428 ⇒ **缺 7 个事件**
 *   · `ce5fa937` 第 3031 事件行：expected 16099，got 16096 ⇒ **缺 3 个事件**
 * 之后所有 seq 都少那么多 ⇒ 校验器在第一处就停。
 *
 * ⇒ **事件是在写入时真的丢了**，不是编码问题。丢掉的那些**无法复原**。
 *
 * ## 修法：截断，不重编号
 *
 * 保留"从 header 起、seq 严格连续"的最长前缀，**丢弃其后的全部**。
 *   · 为什么不重新编号把缺口补上：那会**伪造事件身份**，并打断压缩等
 *     记录的 `sourceEventSeqs` 引用（指向旧 seq）—— 就是"改被检对象去迎合判据"。
 *   · 截断是**DSH 自己对撕裂日志的语义**（`scanLog` 返回"header + 保留前缀 + 可安全追加偏移"）。
 *   · 代价明确：**尾部数据丢失**，但换来"这份会话能打开"。
 *
 * ## 安全纪律（同 repair-session-message-id.mjs）
 *
 * 默认 **dry-run** → 先备份 → 只截断（不重写保留部分）→ 多帧压缩（**frame1 恰为 header 一行**）
 * → 写临时文件 → 复验（全量连续 + 帧契约 + 内容往返）→ **全过才替换** → 替换后再验。
 *
 * 用法：
 *   node scripts/repair-session-seq-gap.mjs <会话目录名>            # dry-run
 *   node scripts/repair-session-seq-gap.mjs <会话目录名> --apply
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { decompress } from 'fzstd'

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const REPO = 'D:/project_develop/dsh-brain'
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const SESSION = argv.find((a) => !a.startsWith('--'))

// ★ 用**读者自己的**展开函数，不自己复刻（2026-09-15 的教训）
const S = await import(pathToFileURL(path.join(REPO, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href)
const decodeStorageRecord = S.decodeStorageRecord

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

/**
 * 扫描若干物理行（事件行），返回第一个不连续点与已确认的事件数。
 * @returns {{ok:boolean, breakAt?:number, expected?:number, got?:number, events:number}}
 */
function scan(eventLines) {
  let count = 0
  for (const [i, l] of eventLines.entries()) {
    let v
    try { v = JSON.parse(l) } catch { return { ok: false, breakAt: i, reason: 'JSON 解析失败', events: count } }
    let decoded
    try { decoded = decodeStorageRecord(v) } catch (e) { return { ok: false, breakAt: i, reason: 'decodeStorageRecord 抛错：' + e.message, events: count } }
    for (const ev of decoded) {
      if (ev.seq !== count) return { ok: false, breakAt: i, expected: count, got: ev.seq, events: count }
      count++
    }
  }
  return { ok: true, events: count }
}

if (!SESSION) {
  console.error('用法：node scripts/repair-session-seq-gap.mjs <会话目录名> [--apply]')
  process.exit(1)
}
const dir = findSessionDir(SESSION)
if (!dir) { console.error(`✗ 找不到会话：${SESSION}`); process.exit(1) }
const FILE = path.join(dir, 'session.jsonl.zstd')
console.log(`会话: ${dir}`)
console.log(`文件: ${FILE}  (${fs.statSync(FILE).size} 字节)`)
console.log(`模式: ${APPLY ? '★ APPLY（会写入）' : 'dry-run（只报告）'}`)
console.log('')

const raw = Buffer.from(decompress(fs.readFileSync(FILE))).toString('utf8')
const allLines = raw.split('\n')
const headerLine = allLines[0] + '\n'
const eventLines = allLines.slice(1).filter((l) => l.trim())

const before = scan(eventLines)
console.log(`事件行 ${eventLines.length} ｜ 逐行展开后连续事件数 ${before.events}`)
if (before.ok) {
  console.log('')
  console.log('✅ 这份日志 seq 是连续的，无需截断。')
  process.exit(0)
}
console.log('')
console.log(`★ 第一处不连续：事件行 #${before.breakAt + 1}（物理第 ${before.breakAt + 2} 行）`)
if (before.expected !== undefined) {
  console.log(`   expected seq=${before.expected}  got seq=${before.got}  ⇒ 缺 ${before.expected - before.got} 个事件`)
} else {
  console.log(`   ${before.reason}`)
}

// 保留前缀 = 断点之前的所有事件行；截断掉断点及其后
const keep = eventLines.slice(0, before.breakAt)
const drop = eventLines.slice(before.breakAt)
const keptEvents = scan(keep)
console.log('')
console.log('=== 截断方案 ===')
console.log(`  保留事件行: ${keep.length}（展开后 ${keptEvents.events} 个事件，且已确认**全连续**）`)
console.log(`  丢弃事件行: ${drop.length}`)
// 让用户看清丢掉的是什么
const tailTypes = {}
for (const l of drop) {
  try { const v = JSON.parse(l); tailTypes[v.type] = (tailTypes[v.type] ?? 0) + 1 } catch { tailTypes['<坏行>'] = (tailTypes['<坏行>'] ?? 0) + 1 }
}
console.log(`  丢弃部分包含: ${Object.entries(tailTypes).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}×${n}`).join(', ')}`)
const anyTurnEnd = drop.some((l) => { try { return JSON.parse(l).type === 'turn/end' } catch { return false } })
console.log(`  丢弃部分含 turn/end: ${anyTurnEnd}（有 ⇒ 末尾那轮不完整，属预期）`)
if (!keptEvents.ok) { console.error('✗ 保留前缀本身仍不连续，脚本放弃'); process.exit(1) }

const out = headerLine + keep.join('\n') + (keep.length ? '\n' : '')

// 帧契约（同 repair-session-message-id.mjs）：frame1 必须恰好一行
const nl = out.indexOf('\n')
const frame1Text = out.slice(0, nl + 1)
const frame1 = zstdCompressSync(Buffer.from(frame1Text, 'utf8'))
const back1 = Buffer.from(decompress(new Uint8Array(frame1))).toString('utf8')
if (back1 !== frame1Text || back1.indexOf('\n') !== back1.length - 1) {
  console.error('✗ 第一帧不是"恰好一行"，拒绝写入'); process.exit(1)
}
console.log(`  帧契约自检：第一帧 = 恰好一行（${back1.length} 字节）✓`)

if (!APPLY) {
  console.log('')
  console.log('（dry-run 结束。确认要丢掉上面这些尾部数据后，加 --apply。）')
  process.exit(0)
}

// 备份 → 写临时 → 复验 → 替换 → 再验
const backupDir = path.join(HOME, '.backup')
fs.mkdirSync(backupDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const bak = path.join(backupDir, `${path.basename(dir)}.PRESEQ.${stamp}.bak`)
fs.copyFileSync(FILE, bak)
console.log('')
console.log(`已备份原文件 → .backup/${path.basename(bak)}`)

const packed = Buffer.concat([frame1, zstdCompressSync(Buffer.from(out.slice(nl + 1), 'utf8'))])
const tmp = `${FILE}.${process.pid}.tmp`
fs.writeFileSync(tmp, packed)

const tmpBuf = fs.readFileSync(tmp)
const tmpText = Buffer.from(decompress(new Uint8Array(tmpBuf))).toString('utf8')
const tmpHead = Buffer.from(decompress(new Uint8Array(tmpBuf.subarray(0, frame1.length)))).toString('utf8')
const tmpLines = tmpText.split('\n').slice(1).filter((l) => l.trim())
const tmpScan = scan(tmpLines)
const tmpFrameOk = tmpHead === frame1Text && tmpHead.indexOf('\n') === tmpHead.length - 1
if (tmpText !== out) { fs.unlinkSync(tmp); console.error('✗ 往返内容不一致，已放弃'); process.exit(1) }
if (!tmpScan.ok) { fs.unlinkSync(tmp); console.error(`✗ 截断后仍不连续（#${tmpScan.breakAt + 1}），已放弃`); process.exit(1) }
if (!tmpFrameOk) { fs.unlinkSync(tmp); console.error('✗ 帧契约不成立，已放弃'); process.exit(1) }
console.log(`临时文件复验：往返一致 + 全量连续（${tmpScan.events} 事件）+ 帧契约成立 ✓`)

fs.renameSync(tmp, FILE)
const finalBuf = fs.readFileSync(FILE)
const finalText = Buffer.from(decompress(new Uint8Array(finalBuf))).toString('utf8')
const finalHead = Buffer.from(decompress(new Uint8Array(finalBuf.subarray(0, frame1.length)))).toString('utf8')
const finalScan = scan(finalText.split('\n').slice(1).filter((l) => l.trim()))
const finalFrameOk = finalHead === frame1Text && finalHead.indexOf('\n') === finalHead.length - 1
console.log('替换后再验：帧契约 ' + (finalFrameOk ? '✓' : '✗') + ' / 连续 ' + (finalScan.ok ? '✓' : '✗') + ` / 事件 ${finalScan.events}`)
if (!finalFrameOk || !finalScan.ok) {
  console.error('✗ 落盘后复验未过 —— 用 .backup/ 里的备份回滚：')
  console.error(`    cp "${bak}" "${FILE}"`)
  process.exit(1)
}
console.log('')
console.log(`✓ 修复完成：保留了前 ${finalScan.events} 个事件，丢弃尾部 ${drop.length} 个事件行。`)
