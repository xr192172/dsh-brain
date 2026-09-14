import fs from 'node:fs'
const F = 'D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js'
const src = fs.readFileSync(F, 'utf8')
const out = [`file length: ${src.length}`]
const grab = (kw) => {
  const hits = []
  let i = -1
  while ((i = src.indexOf(kw, i + 1)) !== -1 && hits.length < 4) {
    hits.push(src.slice(Math.max(0, i - 130), i + 130).replace(/\s+/g, ' '))
  }
  return hits
}
for (const kw of ['expand', 'collapse', 'catalog']) {
  out.push(`\n===== ${kw} =====`)
  const h = grab(kw)
  out.push(h.length ? h.join('\n---\n') : '(none)')
}
out.push('\n===== 字符串字面量 top =====')
const m = src.match(/"[A-Za-z][A-Za-z ._-]{3,44}"/g) || []
const cnt = new Map()
for (const s of m) cnt.set(s, (cnt.get(s) || 0) + 1)
out.push([...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([s, n]) => `${n}  ${s}`).join('\n'))
fs.writeFileSync('out/ui-subagent-probe.txt', out.join('\n'), 'utf8')
