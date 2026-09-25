// find-injection.mjs —— 查"代际身份 / 切换已完成"这类**运行时上下文注入**在会话里出现几次、什么时候出现
// 为什么查：L3b 干到一半停工，最后一句是"已收到代际切换通知…等待下一步指令" ⇒ 疑似我们自己注入的
// 控制面文案把 worker 读成"新指令机制开始 ⇒ 停下等指令"。这直接伤害"AI 全自动施工"。
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const root = path.join(HOME, 'sessions')
const PREFIXES = ['session-2f9111da', 'session-21b5a769', 'session-68ad4034']
const NEEDLES = ['代际身份', '切换已完成', '恢复一切正常服务', 'promote 为 active', '等待下一步指令']

for (const d of fs.readdirSync(root)) {
  const pp = path.join(root, d)
  if (!fs.statSync(pp).isDirectory()) continue
  for (const s of fs.readdirSync(pp)) {
    if (!PREFIXES.some((p) => s.startsWith(p))) continue
    const f = path.join(pp, s, 'session.jsonl.zstd')
    if (!fs.existsSync(f)) continue
    const evs = Buffer.from(decompress(fs.readFileSync(f))).toString('utf8')
      .split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

    console.log(`\n=== ${s} ===  events=${evs.length}  cwd=${evs[0]?.cwd}`)
    let hits = 0
    for (const e of evs) {
      const t = JSON.stringify(e)
      const found = NEEDLES.filter((n) => t.includes(n))
      if (found.length === 0) continue
      hits++
      const seq = e.seq ?? '(无 seq)'
      const kind = e.type + (e.data?.inserted ? ' [inserted]' : '')
      console.log(`  #${seq} ${kind} seq=${e.seq} needle=[${found.join(',')}]`)
      // 打印该段的上下文片段（首 220 字符）
      const m = t.match(/代际身份|切换已完成|恢复一切正常服务/)
      if (m) {
        const i = t.indexOf(m[0])
        console.log(`      …${t.slice(Math.max(0, i - 60), i + 200).replace(/\\n/g, ' | ')}…`)
      }
    }
    console.log(`  命中事件数 = ${hits}`)
    // 最后 3 个事件的类型（看停工点）
    console.log('  末尾事件: ' + evs.slice(-4).map((e) => `${e.type}#${e.seq}`).join(' → '))
  }
}
