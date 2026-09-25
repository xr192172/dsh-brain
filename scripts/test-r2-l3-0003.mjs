import fs from 'node:fs'

const toLf = s => s.replace(/\r\n/g, '\n')
const alignEol = (replace, spanText) =>
  spanText.includes('\r\n') ? replace.replace(/\r\n|\n/g, '\r\n') : replace.replace(/\r\n/g, '\n')

const applySeed = (gatePath, taskId) => {
  const tasksRaw = fs.readFileSync('D:/project_develop/_merge-l234/wt/out/holdout/tasks.jsonl', 'utf8')
  const tasks = tasksRaw.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).map(l => JSON.parse(l))
  const task = tasks.find(t => t.id === taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)
  const edit = task.seed.edits[0]
  const text = fs.readFileSync(gatePath, 'utf8')
  const needle = toLf(edit.find)
  const replace = toLf(edit.replace ?? '')
  const textLf = toLf(text)
  const at = textLf.indexOf(needle)
  if (at < 0) throw new Error(`Anchor not found for ${taskId}`)
  const map = new Array(textLf.length + 1)
  let j = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') continue
    map[j++] = i
  }
  map[textLf.length] = text.length
  const [start, end] = [map[at], map[at + needle.length]]
  const span = text.slice(start, end)
  const aligned = alignEol(replace, span)
  return text.slice(0, start) + aligned + text.slice(end)
}

const gatePath = 'D:/project_develop/_merge-l234/wt/scripts/capability-gate.mjs'
const origText = fs.readFileSync(gatePath, 'utf8')

console.log('=== l3-0003 R2 test ===')

// Stage 1: clean
console.log('Stage 1 (clean): running oracle...')
const { spawnSync } = await import('node:child_process')
const o1 = spawnSync('node', ['scripts/evals/holdout/oracle-fail-closed.mjs'], {
  cwd: 'D:/project_develop/_merge-l234/wt', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
})
console.log(`  exit=${o1.status}, output: ${(o1.stdout ?? '').trim().split('\n')[0]}`)

// Stage 2: seed
console.log('Stage 2 (seeded): applying seed...')
const seeded = applySeed(gatePath, 'l3-0003-fail-closed-on-missing-result')
fs.writeFileSync(gatePath, seeded, 'utf8')
const o2 = spawnSync('node', ['scripts/evals/holdout/oracle-fail-closed.mjs'], {
  cwd: 'D:/project_develop/_merge-l234/wt', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
})
console.log(`  exit=${o2.status}, output: ${(o2.stdout ?? '').trim().split('\n')[0]}`)

// Stage 3: restore
console.log('Stage 3 (restored): restoring...')
fs.writeFileSync(gatePath, origText, 'utf8')
const o3 = spawnSync('node', ['scripts/evals/holdout/oracle-fail-closed.mjs'], {
  cwd: 'D:/project_develop/_merge-l234/wt', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
})
console.log(`  exit=${o3.status}, output: ${(o3.stdout ?? '').trim().split('\n')[0]}`)

const ok = o1.status === 0 && o2.status !== 0 && o3.status === 0
console.log(`\n=> ${ok ? 'PASS' : 'FAIL'}`)
