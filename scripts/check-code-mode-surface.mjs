#!/usr/bin/env node
/**
 * check-code-mode-surface.mjs —— 「unknown tool … only run_code is callable directly」的归属门
 *
 * ## 结论（2026-09-21，doc §2.8 结案）
 *
 * 报错源：`@deepseek-ai/dsh-tools/lib/index.js:3065`（`createExecution` 的 `collapsed` 分支），
 * 判定入口 `collapses()` 同文件 :2983。
 *
 * **工具面并没有多列工具**：code 模式下 `wireSchemas()`（:2713）把 wire schema **过滤成只剩 run_code**
 * （:2726-2729），会话实测 **58/58** 条报错当时的 `request/header.tools` 都恰好是 `["run_code"]`。
 * 模型之所以知道 `read`/`pwsh`/`council_architect` 这些名字，来自 **prompt 里的 SDK 段与各工具自带
 * guidance 段**（上游自己写过这条注释，见 :2603-2617），并在同一份 system 里给了缓解句
 * `CODE_ONLY_INSTRUCTION`（:2407）—— 实测 58/58 在场。
 *
 * ⇒ **归属：上游设计 + 模型不遵守明文规则，既不是我们的工具面配置，也不是上游 bug**
 *   （不要拿它去报上游：`docs/upstream-defects.md` §2.8 结案为「双重我方的 + 模型行为」）。
 *
 * ## 本门守护什么（fail-closed 不变量）
 *
 *   INV1 「列了却拒收」计数 === 0 —— 工具面里有名字、运行时却拒收。
 *        今天是 0；一旦 > 0 说明形态变了（真变成「工具面与运行时不一致」），**归属要重判**。
 *   INV2 每条拒收当时的工具面必须恰好是 ["run_code"]。
 *   INV3 每条拒收当时的 system 必须含上游缓解句（否则是"诱捕"型的 prompt 缺口，归我们）。
 *
 * INV1/INV2 破了 ⇒ 归属从「模型不遵守」移位到「工具面/运行时不一致」；
 * INV3 破了 ⇒ 移位到「我们少配了 prompt」（这才是原本待验证的假设）。
 *
 * ## 两方向自证（红必须红、绿必须绿）
 *
 *   node scripts/check-code-mode-surface.mjs --self-test
 *
 * 用法：
 *   node scripts/check-code-mode-surface.mjs              # 跑门（unit proof + 全量会话语料）
 *   node scripts/check-code-mode-surface.mjs --self-test  # 自证
 */
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'
import { default as Tools } from '@deepseek-ai/dsh-tools'

const SESSION_ROOT = 'C:/Users/Admin/.dsh/sessions'
const OUT = 'D:/project_develop/dsh-brain/out/code-mode-surface.txt'
const MAX_SIZE = 40 * 1048576

const REJECT_RE = /only `run_code` is callable directly/
const NAME_RE = /unknown tool "([^"]+)"/
const CODE_ONLY_MARK = 'is the only tool you can call directly'
const OUR_RULE_MARK = '本会话的工具入口只有一个'

// ────────────────────────────────────────────────────────────────────────
// A. 单位层：直接用上游真代码证明「为什么列了却拒收」这个前提是错的
// ────────────────────────────────────────────────────────────────────────

/** 最小够用的 ctx：`Tools` 只要 systemPrompt / logger / get / reflect */
function fakeCtx() {
  return {
    systemPrompt: { tools: () => () => {}, section: () => () => {} },
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    get: (name) => (name === 'codeRuntime' ? { language: 'typescript' } : undefined),
    reflect: { provide() {} },
    emit() {},
  }
}

export function unitProofs() {
  const code = new Tools(fakeCtx(), { mode: 'code' })
  const native = new Tools(fakeCtx(), {})
  return [
    { id: 'A1', want: true, got: code.collapses('read', undefined, false),
      why: 'code 模式 + 模型直连 ⇒ 拒收成立（这就是 3065 那条报错）' },
    { id: 'A2', want: false, got: code.collapses('run_code', undefined, false),
      why: 'run_code 自身不 collapse ⇒ 还有唯一入口' },
    { id: 'A3', want: false, got: code.collapses('read', undefined, true),
      why: '嵌套子派发（SDK 内部 tools.*）不 collapse' },
    { id: 'A4', want: false, got: native.collapses('read', undefined, false),
      why: 'native 部署不 collapse ⇒ 限制只在 code 模式生效' },
    { id: 'A5', want: '["run_code"]', got: JSON.stringify(code.wireSchemas(undefined).schemas.map((s) => s.name)),
      why: '★ code 模式的模型工具面被过滤成只剩 run_code ⇒ 工具面没多列工具' },
  ]
}

// ────────────────────────────────────────────────────────────────────────
// B. 语料层：全量会话里实际发生了什么
// ────────────────────────────────────────────────────────────────────────

function listSessions() {
  const out = []
  for (const d of fs.readdirSync(SESSION_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dp = path.join(SESSION_ROOT, d.name)
    let kids = []
    try { kids = fs.readdirSync(dp, { withFileTypes: true }) } catch { continue }
    for (const s of kids) {
      if (!s.isDirectory()) continue
      const f = path.join(dp, s.name, 'session.jsonl.zstd')
      if (fs.existsSync(f)) out.push({ rel: `${d.name}/${s.name}`, file: f, size: fs.statSync(f).size })
    }
  }
  return out.sort((a, b) => b.rel < a.rel ? -1 : 1)
}

function resultTextOf(ev) {
  const c0 = ev?.data?.message?.content?.[0]
  if (Array.isArray(c0?.content)) return c0.content.map((x) => x?.text ?? '').join('')
  return String(c0?.content ?? c0?.text ?? '')
}

export function scanCorpus({ limitSessions = Infinity } = {}) {
  const rows = []
  let scanned = 0
  for (const s of listSessions()) {
    if (scanned >= limitSessions) break
    if (s.size > MAX_SIZE) continue
    let text
    try { text = Buffer.from(decompress(fs.readFileSync(s.file))).toString('utf8') } catch { continue }
    scanned++
    let curHeader = null
    let preset = '(未知)'
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      const pm = /"agentPreset"\s*:\s*"([^"]+)"/.exec(line)
      if (pm) preset = pm[1]
      if (ev.type === 'request/header') { curHeader = ev; continue }
      if (ev.type !== 'tool/result') continue
      const t = resultTextOf(ev)
      if (!REJECT_RE.test(t)) continue
      const h = curHeader?.data?.header ?? {}
      let tools = h.tools ?? h.toolSchemas ?? null
      if (!Array.isArray(tools) && tools && typeof tools === 'object') tools = Object.values(tools)
      const names = Array.isArray(tools) ? tools.map((x) => x?.name ?? '?') : []
      const sys = typeof h.system === 'string' ? h.system : String(h.system ?? '')
      rows.push({
        rel: s.rel, preset, iso: Number.isFinite(Number(ev.time)) ? new Date(Number(ev.time)).toISOString().replace('T', ' ').slice(0, 19) : '?',
        tool: NAME_RE.exec(t)?.[1] ?? '?',
        tools: names,
        listed: names.includes(NAME_RE.exec(t)?.[1] ?? '#'),
        upstreamRule: sys.includes(CODE_ONLY_MARK),
        ourRule: sys.includes(OUR_RULE_MARK),
      })
    }
  }
  return { rows, scanned }
}

/** 不变量检查：给定 rows，返回 [{id, ok, why, hits}] */
export function checkInvariants(rows) {
  const listed = rows.filter((r) => r.listed && r.tools.length > 1)
  const notOnlyRunCode = rows.filter((r) => JSON.stringify(r.tools) !== '["run_code"]')
  const noUpstreamRule = rows.filter((r) => !r.upstreamRule)
  return [
    { id: 'INV1', ok: listed.length === 0, hits: listed,
      why: '「工具面列了它、运行时拒收」必须为 0 —— >0 则归属从「模型不遵守」移位到「工具面/运行时不一致」' },
    { id: 'INV2', ok: notOnlyRunCode.length === 0, hits: notOnlyRunCode,
      why: '每条拒收当时的工具面必须恰好是 ["run_code"]' },
    { id: 'INV3', ok: noUpstreamRule.length === 0, hits: noUpstreamRule,
      why: 'system 必须含上游缓解句 CODE_ONLY_INSTRUCTION —— 缺了才是「我们少配 prompt」' },
  ]
}

// ────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────

function runGate() {
  const L = []
  let red = false

  L.push('===== A. 单位层：直接问上游代码（同一份 dsh-tools，0.1.1-rc.2）=====')
  for (const p of unitProofs()) {
    const ok = String(p.got) === String(p.want)
    if (!ok) red = true
    L.push(`  ${ok ? 'OK  ' : 'FAIL'} ${p.id}  got=${String(p.got)}  want=${String(p.want)}`)
    L.push(`        ${p.why}`)
  }
  L.push('')

  const { rows, scanned } = scanCorpus()
  L.push(`===== B. 语料层：${scanned} 个会话，拒收 ${rows.length} 条 =====`)
  const byPreset = new Map()
  const byTool = new Map()
  const byRule = new Map()
  for (const r of rows) {
    const k = `${r.preset} 我方硬规则=${r.ourRule}`
    byPreset.set(k, (byPreset.get(k) ?? 0) + 1)
    byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + 1)
    byRule.set(`上游缓解句=${r.upstreamRule} 我方硬规则=${r.ourRule}`, (byRule.get(`上游缓解句=${r.upstreamRule} 我方硬规则=${r.ourRule}`) ?? 0) + 1)
  }
  L.push('  按 preset × 我方 persona 硬规则:')
  for (const [k, v] of [...byPreset].sort((a, b) => b[1] - a[1])) L.push(`     ${String(v).padStart(4)}  ${k}`)
  L.push('  按工具名:')
  for (const [k, v] of [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`     ${String(v).padStart(4)}  ${k}`)
  L.push('  按"规则在场"组合:')
  for (const [k, v] of byRule) L.push(`     ${String(v).padStart(4)}  ${k}`)
  L.push('')

  L.push('===== C. 不变量 =====')
  for (const inv of checkInvariants(rows)) {
    if (!inv.ok) red = true
    L.push(`  ${inv.ok ? 'OK  ' : 'FAIL'} ${inv.id}  违例 ${inv.hits.length} 条 —— ${inv.why}`)
    for (const h of inv.hits.slice(0, 5)) L.push(`        ${h.iso} ${h.rel} tool=${h.tool} tools=${JSON.stringify(h.tools)}`)
  }
  L.push('')
  L.push(red ? '结论：RED —— 形态变了，§2.8 归属要重判。' : '结论：GREEN —— 与结案一致：工具面正确过滤，规则在场，是模型不遵守明文规则。')

  fs.writeFileSync(OUT, L.join('\n'), 'utf8')
  console.log(L.join('\n'))
  process.exit(red ? 1 : 0)
}

function runSelfTest() {
  const L = []
  let bad = 0

  L.push('===== 自证 A：单位层（同一份上游代码，两种状态）=====')
  for (const p of unitProofs()) {
    const ok = String(p.got) === String(p.want)
    if (!ok) bad++
    L.push(`  ${ok ? 'OK  ' : 'FAIL'} ${p.id} got=${String(p.got)} want=${String(p.want)}  ${p.why}`)
  }

  L.push('')
  L.push('===== 自证 B：不变量的两个方向 =====')
  const greenRows = scanCorpus().rows
  const g = checkInvariants(greenRows)
  for (const inv of g) {
    if (!inv.ok) bad++
    L.push(`  ${inv.ok ? 'OK  ' : 'FAIL'} 绿向：真实语料 ${greenRows.length} 条 ⇒ ${inv.id} 必须为 OK（今天确实一条不违）`)
  }
  // 红向：合成「工具面列了它却被拒收」—— 这才是"工具面与运行时不一致"的形态
  const redRows = [
    { rel: 'SYNTHETIC', preset: 'synthetic', iso: '?', tool: 'read', tools: ['run_code', 'read', 'glob'], listed: true, upstreamRule: false, ourRule: false },
  ]
  const r = checkInvariants(redRows)
  for (const inv of r) {
    if (inv.ok) bad++
    L.push(`  ${inv.ok ? 'FAIL' : 'OK  '} 红向：合成「列了却拒收 + 无缓解句」 ⇒ ${inv.id} 必须为违例（今天 ${inv.hits.length} 条违例）`)
  }
  // 反向 acceptor：正常 code-mode 拒收（工具面只剩 run_code + 缓解句在场）必须全绿
  const okRow = [{ ...redRows[0], tools: ['run_code'], listed: false, upstreamRule: true }]
  const r2 = checkInvariants(okRow)
  for (const inv of r2) {
    if (!inv.ok) bad++
    L.push(`  ${inv.ok ? 'OK  ' : 'FAIL'} 绿向：正常形态的单条记录 ⇒ ${inv.id} 必须为 OK`)
  }

  L.push('')
  L.push(bad === 0 ? `自证通过：0 项不符（4 单位 + 3×3 双向不变量）` : `自证失败：${bad} 项不符`)
  console.log(L.join('\n'))
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv.includes('--self-test')) runSelfTest()
else runGate()
