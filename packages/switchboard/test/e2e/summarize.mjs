/**
 * 格⑮ · 把一份 `/admin/inventory` 或 preflight 报告的关键部分打出来（报告里直接引用原始输出）。
 *
 *   node summarize.mjs inv <inventory.json>
 *   node summarize.mjs rep <report.json>          # 也接受 ?cmd=preflight-result 的 {ok,stage,report}
 */
import { readFileSync } from 'node:fs'

const [, , mode, file] = process.argv
if (!mode || !file) {
  console.error('usage: summarize.mjs <inv|rep> <file.json>')
  process.exit(2)
}
const raw = JSON.parse(readFileSync(file, 'utf8'))
const j = raw && raw.report !== undefined ? raw.report : raw

if (mode === 'inv') {
  console.log('gen=', j.gen, 'mode=', j.mode, 'build=', j.build, 'at=', j.at)
  console.log('unavailable=', JSON.stringify(j.unavailable ?? null))
  console.log('--- plugins (' + j.plugins.length + ') ---')
  for (const p of j.plugins) console.log(`  ${p.id}\t${p.enabled ? 'enabled ' : 'DISABLED'}\tphase=${p.phase ?? 'null'}\t${p.module}`)
  console.log('--- tools (' + j.tools.length + ') ---')
  console.log('  ' + j.tools.join(', '))
  console.log('--- commands (' + j.commands.length + ') ---')
  console.log('  ' + j.commands.join(', '))
} else if (mode === 'rep') {
  if (!j || typeof j !== 'object') {
    console.error('no report in ' + file + ' (stage=' + (raw && raw.stage) + ')')
    process.exit(3)
  }
  console.log('verdict=', j.verdict, 'build=', j.build)
  console.log('rehearsal=', JSON.stringify(j.rehearsal))
  console.log('discarded=', JSON.stringify(j.discarded))
  console.log('reason=', j.reason ?? '(none)')
  console.log('--- checks (' + j.checks.length + ') ---')
  for (const c of j.checks) {
    console.log(`  [${c.ok ? 'OK  ' : 'RED '}] ${c.kind.padEnd(7)} ${c.name}`)
    console.log(`         detail: ${c.detail}`)
    if (c.expect !== undefined) console.log(`         expect: ${c.expect}`)
    if (c.actual !== undefined) console.log(`         actual: ${c.actual}`)
  }
} else {
  console.error('unknown mode: ' + mode)
  process.exit(2)
}
