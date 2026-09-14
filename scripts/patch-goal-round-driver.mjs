// patch goal-round-driver: event.data.reason 可能为 undefined → 可选链保护
// 交接/中断边界态下 turn/end 的 data.reason 缺失时，原代码 `event.data.reason.kind` 抛
// "Cannot read properties of undefined (reading 'kind')"，被 web 前端包装为"本轮运行失败"。
import fs from 'node:fs'

const paths = [
  'D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js',
  'C:/Users/Admin/.dsh/profiles/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js',
]

for (const p of paths) {
  if (!fs.existsSync(p)) { console.log('skip missing:', p); continue }
  let c = fs.readFileSync(p, 'utf8')
  const before = c
  c = c.split('event.data.reason.kind').join('event.data.reason?.kind')
  fs.writeFileSync(p, c, 'utf8')
  const n = (before.match(/event\.data\.reason\.kind/g) || []).length
  const after = (c.match(/event\.data\.reason\?\.kind/g) || []).length
  console.log(`${p}\n  replaced ${n} raw -> optional-chain ${after}`)
}