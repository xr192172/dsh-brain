/**
 * grep-session.mjs —— 在 DSH 会话（zstd 压缩 jsonl）里搜关键词并打印上下文
 *
 * 用途：排查"某段 prompt 到底进没进模型"、"某事件到底记了什么"。
 * 会话存储格式：~/.dsh/sessions/<cwdDir>/<sessionId>/session.jsonl.zstd（多帧 zstd，fzstd 解）
 *
 * 用法： node scripts/grep-session.mjs <会话目录相对路径> <关键词> [上下文字符数]
 *   例： node scripts/grep-session.mjs "--D-project_develop-dsh-brain--/session-xxx" "工具调用约定" 400
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/grep-session.txt'
const rel = process.argv[2]
const kw = process.argv[3]
const ctx = Number(process.argv[4] ?? 300)

if (!rel || !kw) {
  console.log('usage: node scripts/grep-session.mjs <relPath> <keyword> [contextChars]')
  process.exit(1)
}

const file = path.join(ROOT, rel, 'session.jsonl.zstd')
if (!fs.existsSync(file)) { console.log('missing ' + file); process.exit(1) }

const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
const out = []
out.push(`会话: ${rel}`)
out.push(`文件字节: ${fs.statSync(file).size}`)
out.push(`关键词: 「${kw}」`)
out.push('')

// 全文出现次数
const all = text.split(kw).length - 1
out.push(`全文字面出现次数: ${all}`)
out.push('')

// 上下文
let from = 0
let n = 0
while (n < 6) {
  const i = text.indexOf(kw, from)
  if (i < 0) break
  n++
  out.push(`── 命中 #${n} @偏移 ${i} ──`)
  out.push(text.slice(Math.max(0, i - ctx), i + kw.length + ctx).replace(/\\n/g, '\n'))
  out.push('')
  from = i + kw.length
}

// 顺便报一下 request/header 里的层级信息
try {
  const evs = text.split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  const h = evs.find((e) => e.type === 'request/header')?.data?.header
  if (h) {
    out.push('── request/header ──')
    out.push(`  header keys: ${Object.keys(h).join(', ')}`)
    out.push(`  system 长度: ${typeof h.system === 'string' ? h.system.length : 'n/a'}`)
    out.push(`  tools: ${Array.isArray(h.tools) ? '[' + h.tools.map((t) => t?.name).join(', ') + ']' : typeof h.tools}`)
    if (typeof h.system === 'string') {
      const i = h.system.indexOf(kw)
      out.push(`  关键词在 system 内的偏移: ${i >= 0 ? i : '【不存在】'}`)
      out.push(`  system 前 400 字符: ${h.system.slice(0, 400).replace(/\n/g, ' | ')}`)
    }
  }
} catch (e) { out.push('header 解析跳过: ' + e.message) }

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log('ok -> ' + OUT)
console.log(out.slice(0, 8).join('\n'))
