// 批量提取 ai-base/internal/memory 下每个非测试 .go 的头部 doc comment，
// 以便快速判断每个模块的定位（谁在用、依赖谁）。
import fs from 'node:fs'
import path from 'node:path'

const DIR = 'D:/project_develop/ai-base/agent-shell/internal/memory'
const out = []

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).sort()
const total = files.reduce((a, f) => a + fs.statSync(path.join(DIR, f)).size, 0)

out.push(`非测试 .go 文件数：${files.length}，合计 ${(total / 1024).toFixed(0)} KB\n`)

for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8')
  const size = (fs.statSync(path.join(DIR, f)).size / 1024).toFixed(0)
  // 取 package 声明之前的注释块（Go 的包级 doc comment）
  const m = src.match(/^([\s\S]*?)^package\s/m)
  let doc = m ? m[1] : ''
  doc = doc
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\/\/\s?/, '').trim())
    .filter((l) => l && !/^\/\*|\*\/$/.test(l))
    .join('\n')
  // 只看前 8 行有效内容
  const lines = doc.split('\n').filter(Boolean).slice(0, 8)
  out.push(`${'='.repeat(70)}`)
  out.push(`### ${f}  (${size} KB)`)
  out.push(lines.length ? lines.join('\n') : '(无头部注释)')
  out.push('')
}

fs.writeFileSync('D:/project_develop/dsh-brain/out/memory-modules.txt', out.join('\n'), 'utf8')
console.log('written:', files.length, 'modules')
