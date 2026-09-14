/**
 * check-preset.mjs —— 体检一个 agent preset 的组装文件
 *
 * 用途：改完 preset 后，离线确认「YAML 能解析 / persona 在 / 委派工具行在 / 有无 disabled 意外」，
 * 不必先启会话。
 *
 * 用法： node scripts/check-preset.mjs [presetDir]
 *       默认 C:/Users/Admin/.dsh/.agent-presets/code-council
 *
 * 注：`!!js` 是 DSH 加载器方言，标准 yaml 库会报 Unresolved tag —— 那是预期的，不是错误。
 */
import fs from 'node:fs'
import yaml from 'yaml'

const DIR = process.argv[2] ?? 'C:/Users/Admin/.dsh/.agent-presets/code-council'
const YML = `${DIR}/agent.cordis.yml`
const OUT = 'D:/project_develop/dsh-brain/out/check-preset.txt'

const out = []
const say = (s) => out.push(s)

if (!fs.existsSync(YML)) { console.error('missing ' + YML); process.exit(1) }
const src = fs.readFileSync(YML, 'utf8')

let parsed
try {
  parsed = yaml.parse(src)
} catch (e) {
  say('❌ YAML 解析失败: ' + e.message)
  fs.writeFileSync(OUT, out.join('\n'), 'utf8')
  console.log(out.join('\n'))
  process.exit(1)
}

say(`文件: ${YML}`)
say(`字节: ${Buffer.byteLength(src)}   行: ${src.split('\n').length}`)
say(`顶层是数组: ${Array.isArray(parsed)}   项数: ${Array.isArray(parsed) ? parsed.length : '-'}`)
say('')

const rows = Array.isArray(parsed) ? parsed : []

// ── persona ────────────────────────────────────────────────
const persona = rows.find((r) => r?.id === 'persona')
say('── persona ──')
if (persona) {
  const t = persona.config?.text ?? ''
  say(`  存在 ✓   text 长度 ${t.length}`)
  say(`  含「工具调用约定」: ${/工具调用约定/.test(t)}`)
  say(`  含 Code Mode 说明 : ${/Code Mode/.test(t)}`)
  say(`  首行: ${String(t).split('\n')[0].slice(0, 100)}`)
} else {
  say('  ❌ 没有 persona 行')
}
say('')

// ── delegation 组 ──────────────────────────────────────────
const del = rows.find((r) => r?.id === 'delegation')
say('── delegation 组（委派工具行）──')
if (del) {
  for (const r of del.config ?? []) {
    const p = r?.config?.provider ? `  provider=${r.config.provider}` : ''
    const t = r?.config?.toolName ? `  toolName=${r.config.toolName}` : ''
    say(`  - ${r?.id}${p}${t}${r?.disabled ? '   [disabled]' : ''}`)
  }
} else {
  say('  ❌ 没有 delegation 组')
}
say('')

// ── 自研 provider 是否被引用 ───────────────────────────────
const json = JSON.stringify(rows)
say('── 自研 provider 引用 ──')
say(`  含 council-architect: ${/council-architect/.test(json)}`)
say('')

// ── 顶层行总览 ─────────────────────────────────────────────
say('── 顶层行（id → name）──')
for (const r of rows) say(`  ${String(r?.id).padEnd(28)} ${r?.name ?? ''}${r?.disabled ? '  [disabled]' : ''}`)

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log(out.join('\n'))
