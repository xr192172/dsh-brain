#!/usr/bin/env node
/** R2 三段自证：手动对 3 条 holdout 题跑 clean/seeded/restored */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const WT = 'D:/project_develop/_merge-l234/wt'
const GATE = path.join(WT, 'scripts', 'capability-gate.mjs')
const TASKS = path.join(WT, 'out', 'holdout', 'tasks.jsonl')

const tasks = fs.readFileSync(TASKS, 'utf8')
  .split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).map(l => JSON.parse(l))

// O76 LF 归一化
const toLf = (s) => String(s).replace(/\r\n/g, '\n')

const runOracle = (cmd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: WT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

const applySeed = (text, edit) => {
  const needle = toLf(edit.find)
  const replace = toLf(edit.replace ?? '')
  const tLf = toLf(text)
  if (!tLf.includes(needle)) return { ok: false, error: 'anchor not found' }
  const at = tLf.indexOf(needle)
  // 映射回原文本位置
  const map = new Array(tLf.length + 1)
  let j = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r' && text[i + 1] === '\n') continue
    map[j++] = i
  }
  map[tLf.length] = text.length
  const [start, end] = [map[at], map[at + needle.length]]
  const spanText = text.slice(start, end)
  const aligned = spanText.includes('\r\n')
    ? replace.replace(/\r\n|\n/g, '\r\n')
    : replace.replace(/\r\n/g, '\n')
  return { ok: true, text: text.slice(0, start) + aligned + text.slice(end) }
}

const results = []
for (const task of tasks) {
  console.log(`\n=== ${task.id} ===`)
  const edit = task.seed.edits[0]
  let gateText = fs.readFileSync(GATE, 'utf8')

  // Stage 1
  const o1 = runOracle(task.oracle.cmd)
  const cleanGreen = o1.status === 0
  console.log(`Stage 1 clean: ${cleanGreen ? 'GREEN' : 'RED'} exit=${o1.status}`)
  if (o1.out.trim()) console.log('  ' + o1.out.trim().split('\n')[0])

  // Stage 2
  const applied = applySeed(gateText, edit)
  if (!applied.ok) {
    console.log(`Stage 2: SKIP - ${applied.error}`)
    results.push({ id: task.id, cleanGreen, seededRed: null, restoredGreen: null, ok: false })
    continue
  }
  fs.writeFileSync(GATE, applied.text, 'utf8')
  const o2 = runOracle(task.oracle.cmd)
  const seededRed = o2.status !== 0
  console.log(`Stage 2 seeded: ${seededRed ? 'RED (correct)' : 'GREEN (wrong)'} exit=${o2.status}`)
  if (o2.out.trim()) console.log('  ' + o2.out.trim().split('\n')[0])

  // Stage 3
  fs.writeFileSync(GATE, gateText, 'utf8')
  const o3 = runOracle(task.oracle.cmd)
  const restoredGreen = o3.status === 0
  console.log(`Stage 3 restored: ${restoredGreen ? 'GREEN (correct)' : 'RED (wrong)'} exit=${o3.status}`)
  if (o3.out.trim()) console.log('  ' + o3.out.trim().split('\n')[0])

  const ok = cleanGreen && seededRed && restoredGreen
  results.push({ id: task.id, cleanGreen, seededRed, restoredGreen, ok })
  console.log(`=> ${ok ? 'PASS' : 'FAIL'}`)
}

console.log('\n═══ R2 汇总 ═══')
for (const r of results) {
  console.log(`  ${r.id}: clean=${r.cleanGreen} seeded=${r.seededRed} restored=${r.restoredGreen}`)
}
const passed = results.filter(r => r.ok).length
console.log(`通过: ${passed}/${results.length}`)
