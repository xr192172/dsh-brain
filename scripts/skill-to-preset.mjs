#!/usr/bin/env node
/**
 * skill-to-preset.mjs —— **那座桥**：把 `skill-factory` 出的「agent 规格」落成**运行时可用的 preset**。
 *
 * ★ 为什么需要它（端到端演练暴露的缺口①）：
 *   规格里写的是 `provider:"spawn"` + `persona` + `toolFilter`；
 *   而 worker 手上只有 **`subagent` 工具**，它吃 `{description, prompt, run_in_background}`
 *   —— **不吃 persona / toolFilter**。
 *   ⇒ 「起一个**带指定人格 + 窄工具面**的子 agent」**不是一次工具调用能做的**，
 *     得落成 **preset**（人格在 `- id: persona`，工具面 = preset 列出的条目）。
 *
 * ★ 形状**照实物抄**（`~/.dsh/.agent-presets/g0/agent.cordis.yml`），不自造字段：
 *   · `preset.yml` = `{name, description}`（元数据）
 *   · `agent.cordis.yml` = 一个 loader 条目列表：`- id: persona`（`@deepseek-ai/dsh-persona`）
 *     + 各工具条目。
 *   · ★★ **shell 组必须带平台 gate**（`disabled: !!js process.platform === 'win32'`）——
 *     `g0` 的注释里写着血泪教训：只写一行 `tool-bash` ⇒ 本机 win32 上**壳子名字对了但跑不动**。
 *
 * ★★ **诚实边界（本桥不假装能做的事）**：`ToolDef`（`Kind: shell` 的脚本工具）**在运行时并不存在** ——
 *   没有任何东西把它注册进 ToolRegistry。⇒ 本桥对**映射不了的工具**：
 *     **如实标注**（写进 `preset.yml` 的 description + CLI 醒目报告），**绝不假装它已可用**。
 *
 * 用法：
 *   node scripts/skill-to-preset.mjs --in <skill_tree.json|nodes.jsonl> [--dest <目录>] [--yes] [--id <presetId>] [--json]
 *   node scripts/skill-to-preset.mjs --selftest
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifySkill, loadNodes } from './skill-sieve.mjs'
import { skillToAgentSpec } from './skill-factory.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PRESET_DIR = path.join(os.homedir(), '.dsh', '.agent-presets')

/** DSH 里**真实存在**的工具名（本桥能映射的只有这些；其余必须如实标注）。★ 只列常用的几个基线。 */
export const KNOWN_TOOLS = new Set([
  'read', 'write', 'edit', 'ls', 'glob', 'grep', 'shell', 'pwsh', 'bash', 'list_capabilities', 'subagent', 'todo',
])

/**
 * ★ 核心（纯函数）：`spec` ⇒ 两份文件的内容。
 * @returns {{ok:true, presetId:string, files:Record<string,string>, unmapped:string[], notes:string[]}|{ok:false,reason:string}}
 */
export function specToPreset(spec, { presetId, skillId, sourceHash } = {}) {
  if (!spec?.persona) return { ok: false, reason: '规格里没有 persona ⇒ 拒绝产出一个"没有脸"的 preset' }
  const id = presetId ?? `skill-${String(skillId ?? spec.name ?? 'x').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase()}`
  const toolNames = Array.isArray(spec.toolFilter) ? spec.toolFilter : []
  const defs = Array.isArray(spec.toolDefs) ? spec.toolDefs : []
  const mapped = toolNames.filter((t) => KNOWN_TOOLS.has(t))
  const unmapped = toolNames.filter((t) => !KNOWN_TOOLS.has(t))
  const notes = []

  const lines = []
  lines.push(`# ${id} —— 由 skill-to-preset 从「agent 规格」生成（**自动产物，改它请改 skill 或工厂**）`)
  lines.push(`# 来源 skill: ${skillId ?? '(未知)'}${sourceHash ? `  hash=${sourceHash}` : ''}`)
  lines.push('# 形状照 ~/.dsh/.agent-presets/g0/agent.cordis.yml 抄（只有 persona + 一个 shell 组）')
  lines.push('')
  lines.push('- id: persona')
  lines.push("  name: '@deepseek-ai/dsh-persona'")
  lines.push('  config:')
  lines.push('    text: |-')
  for (const l of String(spec.persona).split('\n')) lines.push(`      ${l}`)
  // ★ 照 g0：`complete:true` ⇒ 装配后系统提示里只剩这一段（确定性高，噪声低）；
  //   `includeRuntimeContext:false` ⇒ 连 sandbox/approval 快照也不进来。**两项都可按需调**。
  lines.push('    complete: true')
  lines.push('    includeRuntimeContext: false')
  lines.push('')
  if (unmapped.length) {
    notes.push(`★ 未注册的工具（本桥映射不了，**不假装可用**）：${unmapped.join(', ')}`)
    lines.push(`# ★ 规格里有 ${unmapped.length} 个工具在 DSH 里【并不存在】，桥不替它们造壳：`)
    for (const u of unmapped) lines.push(`#   - ${u}（需先"把 ToolDef 注册进 ToolRegistry"，那是另一件事）`)
  }
  if (mapped.length) {
    notes.push(`已映射（DSH 里本来就有）：${mapped.join(', ')}`)
  }
  // shell 组：**本桥一律挂**（否则 skill 的 Script 连试着跑的机会都没有）；
  //   ★ 平台 gate 二选一（照随附 minimal / g0）—— 少一支就是"壳子名字对了但跑不动"。
  lines.push('# 平台 gate 的 shell 组（照随附 minimal / g0）：win32 上恰好 1 个可用 shell。')
  lines.push('- id: persistent-shell')
  lines.push('  name: cordis:group')
  lines.push('  group: true')
  lines.push('  isolate:')
  lines.push('    terminals: true')
  lines.push('  config:')
  lines.push('    - id: pty')
  lines.push("      name: '@deepseek-ai/dsh-terminal'")
  lines.push('')
  lines.push('    - id: terminal-bash')
  lines.push("      name: '@deepseek-ai/dsh-terminal-bash'")
  lines.push("      disabled: !!js process.platform === 'win32'")
  lines.push('      config:')
  lines.push('        timeoutMs: 300000')
  lines.push('')
  lines.push('    - id: persistent-bash')
  lines.push("      name: '@deepseek-ai/dsh-tool-bash-persistent'")
  lines.push("      disabled: !!js process.platform === 'win32'")
  lines.push('      config:')
  lines.push('        timeoutMs: 300000')
  lines.push('')
  lines.push('    - id: terminal-pwsh')
  lines.push("      name: '@deepseek-ai/dsh-terminal-bash'")
  lines.push("      disabled: !!js process.platform !== 'win32'")
  lines.push('      config:')
  lines.push('        shellDialect: pwsh')
  lines.push('        timeoutMs: 300000')
  lines.push('')
  lines.push('    - id: persistent-pwsh')
  lines.push("      name: '@deepseek-ai/dsh-tool-pwsh-persistent'")
  lines.push("      disabled: !!js process.platform !== 'win32'")
  lines.push('      config:')
  lines.push('        timeoutMs: 300000')

  const desc = [
    `由 skill「${skillId ?? '(未知)'}」升格出来的子 agent（规格由 skill-factory 产出，本 preset 由 skill-to-preset 落成）。`,
    `persona 逐字来自规格；工具面 = 平台 gate 的 shell 组${mapped.length ? ` + 已映射工具（${mapped.join(', ')}）` : ''}。`,
    ...(unmapped.length ? [`★ 未注册工具：${unmapped.join(', ')} —— 需先把 ToolDef 注册进 ToolRegistry（本桥不做这件事）。`] : []),
  ].join('\n')

  const presetYml = [
    `name: skill · ${skillId ?? id}`,
    'description: >-',
    ...desc.split('\n').map((l) => `  ${l}`),
    '',
  ].join('\n')

  return {
    ok: true,
    presetId: id,
    files: { 'agent.cordis.yml': lines.join('\n') + '\n', 'preset.yml': presetYml },
    unmapped,
    notes,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const res = []
  const check = (n, ok, detail) => { res.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }
  const spec = {
    provider: 'spawn',
    name: 'skill:demo',
    persona: '你是由 skill「demo」升格出来的子 agent。\n\n## 原理\n先取首行。',
    toolFilter: ['demo_first_line', 'read'],
    toolDefs: [{ Name: 'demo_first_line', Kind: 'shell', Entry: 'first_line.sh', Fn: 'first_line' }],
  }
  const r = specToPreset(spec, { presetId: 'skill-demo', skillId: 'demo' })
  check('① 出两份文件', r.ok && !!r.files['agent.cordis.yml'] && !!r.files['preset.yml'], r.ok ? Object.keys(r.files).join(' + ') : r.reason)
  const y = r.ok ? r.files['agent.cordis.yml'] : ''
  const hasPersonaEntry = /- id: persona/.test(y)
  const hasTextBlock = /^\s+text: \|-/m.test(y)
  const hasPersonaLines = y.includes('## 原理') && y.includes('你是由 skill「demo」升格出来的子 agent')
  check('② persona **逐字**写进去（多行用 |- 块）', hasPersonaEntry && hasTextBlock && hasPersonaLines,
    `entry=${hasPersonaEntry} 块=${hasTextBlock} 逐字=${hasPersonaLines}`)
  check('③ ★ **未注册的工具被如实标注**（不假装可用）', r.unmapped.length === 1 && r.unmapped[0] === 'demo_first_line' && y.includes('并不存在'), `unmapped=${JSON.stringify(r.unmapped)}`)
  check('④ 已注册的工具被认出来（read）', r.notes.some((n) => n.includes('read')), r.notes.join(' | '))
  check('⑤ ★ **shell 组带平台 gate**（win32 ⇒ pwsh 那支 enabled）',
    y.includes("disabled: !!js process.platform === 'win32'") && y.includes("disabled: !!js process.platform !== 'win32'") && y.includes('persistent-pwsh'),
    'bash/pwsh 各一支 + gate')
  check('⑥ 没有 persona ⇒ 拒绝（不产出"没有脸"的 preset）', specToPreset({ toolFilter: [] }, {}).ok === false, '')

  // ★ 消融：撤掉"未注册就标注"⇒ 判据③ 必须变红
  console.log('\n=== 消融自证 ===')
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const ANCHOR = "  if (unmapped.length) {\n    notes.push("
  const ABL = "  if (false) { // ABLATED\n    notes.push("
  let ablOk = false
  if (!src.includes(ANCHOR)) console.log('  ★ 消融锚点失配 —— 必须重写')
  else {
    const tmp = path.join(HERE, '_preset-ablated.mjs')
    fs.writeFileSync(tmp, src.replace(ANCHOR, ABL), 'utf8')
    const out = (spawnSync(process.execPath, [tmp, '--selftest-only'], { encoding: 'utf8', timeout: 60000 }).stdout ?? '')
    ablOk = /FAIL 未注册/.test(out)
    console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 撤掉"未注册就标注"⇒ 判据③ 变红 ${ablOk ? '✓' : `（没变红；${out.slice(0, 160)}）`}`)
    fs.unlinkSync(tmp)
  }
  const pass = res.filter((x) => x.ok).length
  const total = pass === res.length && ablOk
  console.log(`\n结果：判据 ${pass}/${res.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

const argv = process.argv.slice(2)
const argOf2 = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  if (argv.includes('--selftest-only')) {
    const r = specToPreset({ persona: 'x', toolFilter: ['demo_first_line'] }, { presetId: 'p' })
    // ★ 判据必须落在【产物内容】上 —— 消融撤掉的正是"那段标注"；而 `unmapped` 是**无条件**算出来的，
    //   拿它当判据 ⇒ 撤不撤都"ok" ⇒ **假消融**（我第一版就这么写的，跑出来才发现）。
    const annotated = !!(r.ok && r.files['agent.cordis.yml'].includes('并不存在'))
    console.log(annotated ? '  ok  未注册已标注' : '  FAIL 未注册（产物里没有标注）')
    process.exit(0)
  }
  if (argv.includes('--selftest') || argv.length === 0) process.exit(selftest())

  const inFile = argOf2('--in')
  if (!inFile) { console.error('[用法] --in <skill_tree.json|nodes.jsonl> [--dest <目录>] [--yes] [--id <presetId>] [--json]'); process.exit(2) }
  const destBase = argOf2('--dest') ?? DEFAULT_PRESET_DIR
  const nodes = loadNodes(inFile)
  const out = []
  for (const n of nodes) {
    const specRes = skillToAgentSpec(n)
    if (!specRes.ok) { out.push({ id: n.ID, ok: false, reason: specRes.reason }); continue }
    const pr = specToPreset(specRes.spec, { presetId: argOf2('--id') ?? undefined, skillId: n.ID, sourceHash: n.SourceHash })
    out.push({ id: n.ID, ok: pr.ok, presetId: pr.ok ? pr.presetId : undefined, dir: pr.ok ? path.join(destBase, pr.presetId) : undefined, unmapped: pr.ok ? pr.unmapped : undefined, notes: pr.ok ? pr.notes : undefined, files: pr.ok ? pr.files : undefined, reason: pr.ok ? undefined : pr.reason })
  }
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(out.every((x) => x.ok) ? 0 : 1) }
  const ok = out.filter((x) => x.ok)
  console.log(`\n输入 ${out.length} 个 skill ⇒ 可落成 preset ${ok.length} 个：`)
  for (const x of ok) {
    console.log(`  ✅ ${x.id} ⇒ preset "${x.presetId}"`)
    for (const nt of x.notes) console.log(`       ${nt}`)
    if (x.unmapped.length) console.log(`       ★★ ${x.unmapped.length} 个工具**未注册** ⇒ 本桥不替它们造壳（要另做"ToolDef 注册"）`)
  }
  for (const x of out.filter((y) => !y.ok)) console.log(`  ⛔ ${x.id} —— ${x.reason}`)
  const yes = argv.includes('--yes')
  if (!yes) {
    console.log(`\n（dry-run：没写盘。会写到 ${destBase}\\<presetId>\\ ；加 --yes 真写）`)
    for (const x of ok) for (const [f, c] of Object.entries(x.files)) console.log(`\n--- ${path.join(destBase, x.presetId, f)} ---\n${c.split('\n').slice(0, 14).join('\n')}${c.split('\n').length > 14 ? '\n…' : ''}`)
  } else {
    for (const x of ok) {
      fs.mkdirSync(x.dir, { recursive: true })
      for (const [f, c] of Object.entries(x.files)) fs.writeFileSync(path.join(x.dir, f), c, 'utf8')
      console.log(`  ✅ 已写：${x.dir}（${Object.keys(x.files).join(', ')}）`)
    }
  }
  process.exit(out.every((x) => x.ok) ? 0 : 1)
}
