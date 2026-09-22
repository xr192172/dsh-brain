#!/usr/bin/env node
/**
 * capability-intake.mjs —— 能力**入池编排**（P3 执行器的第一块）
 *
 * 一句话目标：
 *   **「候选入池 + 只经注册门采纳」的单向门** ——
 *   候选 →（只建 `pending`）→ 跑注册门 → **只有过门才写 `acceptance`** → 出一份可复算报表。
 *
 * 设计依据：`docs/capability-registry-evolution.md` §9（P3 行）、§4（四个动作）、
 *           §5.1（lineage）、§5.5.2 / §5.5.3（行为信号）；判据阶梯见 `scripts/capability-gate.mjs` 文件头。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 必须遵守的纪律（逐条落到代码里，不是口号）
 *
 * 1. **注册 ≠ 采纳。** `capability-registry.mjs register` **只建 `pending`**；
 *    **只有注册门收回执、且回执写进 `acceptance`，才算采纳**。本脚本从不"自己宣布通过"。
 * 2. ★ **只跑到 L1 ⇒ 回执必须原样带上 `proofLevel` 与 `unenforced`。**
 *    本脚本不重写、不美化这两项：`proofLevel` / `unenforced` 一律**从注册门写进 registry 的
 *    回执里原样读出**并照抄进报表。**绝不把 L2~L4 说成"通过"** —— 那是假绿，本项目明令。
 * 3. **缺声明 = fail-closed。**「没声明」不等于「不适用」，只等于「没承认」——
 *    这是门的行为，本脚本**不代候选补声明**（不自动填 role/writeScope/credentials/budget）。
 * 4. ★ **绝不为了让候选通过而改判据 / 改门。** 本脚本**只调用**门，从不 import 门的判据、
 *    不传任何"放宽"开关。**被拒就是被拒，reason 如实记录。**
 * 5. ★ **默认只读（dry-run）。无参数运行时【不写 registry】**，只出报表；
 *    **只有显式 `--apply` 才真写**，且 `--apply` 前**先调 `capability-snapshot.mjs --save` 快照一次**。
 * 6. **不修改仓库里任何已有文件。** registry / gate / store / sources 一律**以子进程调用**
 *    （唯一的例外见下），本脚本**不 fs.writeFileSync 那个 registry.json**。
 *
 * 「dry-run 怎么还能拿到门的真实结论」——**沙箱**：
 *   把真实 `registry.json` 复制到一个临时 `DSH_HOME`，在沙箱里跑 `register` + `run`。
 *   门跑的是**真实判据、真实证据**（真 import 编译产物、真跑 apply），只是**写到了副本上**。
 *   真实 registry 的 sha256 前后一致可查（报表里打印）。这比"dry-run 就不跑门、只猜结论"诚实得多。
 *
 * 唯一一处 import 而非子进程：`capability-sources.mjs`。它是**纯只读扫描模块、没有 CLI**；
 * 第 6 条的关切是"不要 import 去改"，此处只 import 读取候选清单与扫描结果（不写任何东西）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 候选来源（三条）
 *   ① 显式清单  --candidate <id> --pkg <包名> [--path <相对路径>] [--version <v>]
 *                 [--role <r>] [--write-scope <none|sandbox|workspace|production>]
 *                 [--credentials <none|inherit|own>] [--budget <tokens>|--budget-source <inherit|declared|none>]
 *                 [--caps a,b,c] [--note <说明>]          （--candidate 可重复 ⇒ 多候选）
 *   ② 外部来源  --from-source mcp        （用 `capability-sources.mjs` 的 MCP_SOURCES 扫描结果当候选）
 *   ③ skill-tree 候选池  —— **暂不可用**（见报表；`packages/skill-tree` 没有持久化 store）
 *
 * 其它开关：`--apply`（真写；先快照）· `--out <文件>` · `--keep-sandbox`
 *
 * 用法：
 *   node scripts/capability-intake.mjs --candidate x --pkg @scope/pkg --role design
 *   node scripts/capability-intake.mjs --candidate x --pkg @scope/pkg --role design --apply
 *   node scripts/capability-intake.mjs --from-source mcp
 *
 * 报表默认写到 `out/capability-intake.txt`；stdout 末尾打一行汇总
 *   `candidates=N registered=M passed=K rejected=J apply=false`
 *
 * 退出码：0 = 流程本身跑完（**门拒了也是 0** —— 那是正常结论，不是本脚本的失败）；
 *         2 = 内部错误 / 参数错误（例如 registry 读不出来）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
// ★ 只读 import：capability-sources.mjs 是纯扫描模块、没有 CLI（见文件头第 6 条的说明）
import { MCP_SOURCES, scanMcpSource } from './capability-sources.mjs'

const REPO = 'D:/project_develop/dsh-brain'
const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const REG = path.join(HOME, 'capabilities', 'registry.json')

const CLI = {
  registry: path.join(REPO, 'scripts', 'capability-registry.mjs'),
  gate: path.join(REPO, 'scripts', 'capability-gate.mjs'),
  snapshot: path.join(REPO, 'scripts', 'capability-snapshot.mjs'),
}
const DEFAULT_OUT = path.join(REPO, 'out', 'capability-intake.txt')
const SKILLTREE_SRC = path.join(REPO, 'packages', 'skill-tree', 'src')
/** 移植计划 L3 的落点（`docs/skill-tree-port-plan.md:60` / `docs/skill-as-agent-spec.md:1314`）。 */
const SKILLTREE_L3_DIRS = ['store', 'import'].map((d) => path.join(SKILLTREE_SRC, d))

// ── 报表缓冲（stdout 与报表文件同源，避免"两套说法"） ────────────────────────

const OUT = []
function say(s = '') {
  const t = String(s)
  OUT.push(t)
  console.log(t)
}
/** 逐行输出（**不要**写成 `say(...lines)` —— `say` 只吃第一个参数，多出来的会被静默丢掉）。 */
function sayLines(lines) {
  for (const l of lines) say(l)
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const KEEP_SANDBOX = argv.includes('--keep-sandbox')

/** `--candidate` 之后、下一个 `--candidate` 之前的选项属于该候选。 */
const CAND_OPTS = new Set([
  'pkg', 'path', 'version', 'role', 'write-scope', 'credentials', 'budget', 'budget-source',
  'provider', 'tool', 'caps', 'note',
])

function parseArgv(a) {
  const candidates = []
  const global = { out: DEFAULT_OUT, fromSource: [] }
  let cur = null
  for (let i = 0; i < a.length; i++) {
    const tok = a[i]
    if (tok === '--apply' || tok === '--dry-run' || tok === '--keep-sandbox') continue
    if (tok.startsWith('--')) {
      const name = tok.slice(2)
      const next = a[i + 1]
      const val = next !== undefined && !next.startsWith('--') ? a[++i] : true
      if (name === 'candidate') {
        cur = { id: String(val), kind: 'subagent-provider', origin: 'explicit', opts: {} }
        candidates.push(cur)
        continue
      }
      if (name === 'out') { global.out = path.resolve(REPO, String(val)); continue }
      if (name === 'from-source') {
        global.fromSource = String(val).split(',').map((s) => s.trim()).filter(Boolean)
        continue
      }
      if (CAND_OPTS.has(name)) {
        if (!cur) throw new Error(`--${name} 必须写在某个 --candidate <id> 之后`)
        cur.opts[name] = val
        continue
      }
      throw new Error(`未知参数：${tok}`)
    }
    throw new Error(`无法识别的位置参数：${tok}（候选必须写成 --candidate <id>）`)
  }
  return { candidates, global }
}

/** 把候选的显式选项翻成 `capability-registry.mjs register` 的参数（不新增字段、不补默认值）。 */
function registerArgs(c) {
  const o = c.opts
  const a = ['register', c.id]
  for (const k of ['pkg', 'path', 'version', 'provider', 'tool', 'role', 'write-scope', 'credentials', 'budget', 'budget-source', 'caps', 'note']) {
    if (o[k] !== undefined && o[k] !== true) a.push(`--${k}`, String(o[k]))
  }
  return a
}

// ── 子进程 ──────────────────────────────────────────────────────────────────

/**
 * 调一个 `capability-*.mjs`。**只以子进程调用**（纪律 6）—— 本脚本从不 import registry/gate/store。
 * env 里带 `DSH_HOME` 决定它读写哪个 registry：真实 or 沙箱。
 */
function runCli(cli, args, env) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    cmd: `node ${path.relative(REPO, cli).replace(/\\/g, '/')} ${args.join(' ')}`,
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? String(r.error.message) : null,
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
function regSha() {
  try { return sha256(fs.readFileSync(REG)) } catch (e) { return `(读不到：${e.code ?? e.message})` }
}

function listRegistry(env) {
  const r = runCli(CLI.registry, ['list', '--json'], env)
  try { return { r, db: JSON.parse(r.stdout) } } catch (e) { return { r, db: null, parseError: e.message } }
}

/** 从沙箱/真实 registry 读一条能力的结构化回执（proofLevel / unenforced / checks 原样）。 */
function showCapability(env, id) {
  const r = runCli(CLI.registry, ['show', id], env)
  try { return { r, cap: JSON.parse(r.stdout) } } catch (e) { return { r, cap: null, parseError: e.message } }
}

function transcript(r, pad = '      ') {
  const out = [`${pad}$ ${r.cmd}`, `${pad}exit=${r.code}${r.error ? `  error=${r.error}` : ''}`]
  for (const [tag, s] of [['stdout', r.stdout], ['stderr', r.stderr]]) {
    const text = String(s).replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (!text) continue
    out.push(`${pad}${tag}:`)
    for (const line of text.split('\n')) out.push(`${pad}  ${line}`)
  }
  return out
}

// ── 候选来源 ②：外部来源（MCP） ──────────────────────────────────────────────

async function mcpCandidates() {
  const list = []
  for (const m of MCP_SOURCES) {
    const scan = await scanMcpSource(m)
    list.push({
      id: m.id,
      kind: m.kind,
      origin: 'source:mcp',
      label: m.label,
      source: m,
      scan,
      // ★ 外部来源自己带的 L1 声明照抄自 capability-sources.mjs，不由本脚本编造
      invariants: m.invariants ?? null,
    })
  }
  return list
}

// ── 候选来源 ③：skill-tree 候选池（如实体检，不硬编码结论） ──────────────────

function skillTreeStatus() {
  const present = SKILLTREE_L3_DIRS.filter((d) => fs.existsSync(d))
  const srcFiles = fs.existsSync(SKILLTREE_SRC)
    ? fs.readdirSync(SKILLTREE_SRC, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? '/' : ''))
    : []
  return { available: present.length > 0, present, checked: SKILLTREE_L3_DIRS, srcFiles }
}

// ── 沙箱 ────────────────────────────────────────────────────────────────────
//
// ★ 为什么要有它：门（`capability-gate.mjs run`）**一定会写 registry**（成功写 passed 回执、
//   被拒也写 failed 回执）。dry-run 要"只出报表不写库"，又要拿门的**真实**结论 ⇒ 把库复制一份来跑。

function makeSandbox(realDb) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-intake-'))
  fs.mkdirSync(path.join(root, 'capabilities'), { recursive: true })
  if (realDb) fs.copyFileSync(REG, path.join(root, 'capabilities', 'registry.json'))
  return { root, env: { ...process.env, DSH_HOME: root } }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const { candidates, global } = parseArgv(argv)

  const t0 = new Date().toISOString()
  const shaBefore = regSha()

  say('能力入池报表（capability-intake）')
  say('='.repeat(78))
  say(`生成时间   ：${t0}`)
  say(`模式       ：${APPLY ? 'apply（真写 registry）' : 'dry-run（只读，只出报表）'}`)
  say(`registry   ：${REG}`)
  say(`本脚本文件 ：scripts/capability-intake.mjs`)
  say(`registry sha256（运行前）：${shaBefore}`)
  say('')

  // ── 候选来源清单 ──
  say('── 候选来源 ─────────────────────────────────────────────────────────────')
  const mcpCands = global.fromSource.includes('mcp') ? await mcpCandidates() : []
  const st = skillTreeStatus()
  say(`① 显式清单（--candidate）           ：${candidates.length} 个`)
  say(`② 外部来源（--from-source mcp）     ：${global.fromSource.includes('mcp') ? `${mcpCands.length} 个（capability-sources.mjs 的 MCP_SOURCES）` : '未启用（加 --from-source mcp 启用）'}`)
  say(`③ skill-tree 候选池                 ：${st.available ? '可用' : '★ 暂不可用'}`)
  if (!st.available) {
    say('    ★ 暂不可用 —— 理由：packages/skill-tree **没有持久化 store**：')
    say('      移植计划 L3 的 import/*.ts 与 store/*.ts **尚未移植**（docs/skill-tree-port-plan.md:60、')
    say('      docs/skill-as-agent-spec.md:1314 记「全缺｜未移植」）⇒ **候选池现在没有落盘数据源**。')
    say(`      实测：${st.checked.map((d) => `${path.relative(REPO, d).replace(/\\/g, '/')}${fs.existsSync(d) ? '（在）' : '（不存在）'}`).join('、')}`)
    say(`      packages/skill-tree/src 现有：${st.srcFiles.join(', ') || '(空)'}`)
    say('      ⇒ 本来源**给不出任何候选**，本脚本不假装已打通（报表单列此行）。')
  }
  if (mcpCands.length) {
    for (const m of mcpCands) {
      const s = m.scan ?? {}
      say(`    · ${m.id}（${m.kind}）：${s.error ? `扫描失败：${s.error}` : `${s.toolCount} 工具 / ${s.laneCount} 条能力线 [${(s.lanes ?? []).join(', ')}]，未归线 ${(s.drift?.registeredNotInLanes ?? []).length} 个`}`)
    }
  }
  say('')

  // ── 待处理候选合并 ──
  const all = [...candidates, ...mcpCands]
  if (!all.length) {
    say('⚠️ 没有候选（--candidate 与 --from-source 都没给）。只出环境报表，不写任何东西。')
  }

  // ── 真实 registry 现状（判断"是否已在库"） ──
  const before = listRegistry(process.env)
  if (!before.db) {
    say(`X 读不出真实 registry：${before.parseError ?? before.r.error ?? '未知'}`)
    sayLines(transcript(before.r))
    throw new Error('registry 不可读 —— fail-closed，不继续')
  }
  const inReal = new Map(before.db.capabilities.map((c) => [c.id, c]))

  // ── 沙箱：复制真实 registry，在里面 register + 跑门 ──
  const sb = makeSandbox(true)
  say(`沙箱 DSH_HOME：${sb.root}`)
  say('  （dry-run 就靠它：门跑真实判据，写到副本上，真实 registry 一字不动）')
  say('')

  // ── `--apply` 的前置：先快照（纪律 5） ──
  let snap = null
  if (APPLY && all.length) {
    snap = runCli(CLI.snapshot, ['--save'], process.env)
    say('── --apply 前置快照（capability-snapshot.mjs --save） ────────────────────')
    sayLines(transcript(snap))
    say('')
  }

  // ── 逐候选 ──
  const results = []
  for (const c of all) {
    say('─'.repeat(78))
    say(`候选 ${c.id}   来源=${c.origin}   kind=${c.kind}`)
    say('')

    const existing = inReal.get(c.id) ?? null
    say(`  是否已在库：${existing ? `是（status=${existing.status}）` : '否'}`)

    // (1) 沙箱入池：只建 pending
    const sbList = listRegistry(sb.env)
    const sbHas = sbList.db ? sbList.db.capabilities.some((x) => x.id === c.id) : false
    let poolNote
    if (sbHas) {
      poolNote = '沙箱里已存在（沿用副本，不重复建）'
    } else if (c.kind === 'mcp-server') {
      const r = runCli(CLI.registry, ['init'], sb.env) // 外部来源只能由 init 物化（register 固定建 subagent-provider）
      poolNote = r.code === 0 ? '沙箱里经 registry init 物化（mcp-server）' : '沙箱 init 失败'
      if (r.code !== 0) sayLines(transcript(r))
    } else {
      const r = runCli(CLI.registry, registerArgs(c), sb.env)
      poolNote = r.code === 0 ? '沙箱里已 register ⇒ pending' : '沙箱 register 失败'
      if (r.code !== 0) sayLines(transcript(r))
    }
    say(`  入池结果（沙箱）：${poolNote}`)
    say('')

    // (2) 跑门
    const gateRun = runCli(CLI.gate, ['run', c.id], sb.env)
    const shown = showCapability(sb.env, c.id)
    const acc = shown.cap?.acceptance ?? null
    const checks = Array.isArray(acc?.checks) ? acc.checks : []
    const failed = checks.filter((k) => !k.ok)
    const admitted = acc?.status === 'passed'

    say(`  门的结果（scripts/capability-gate.mjs run ${c.id}，exit=${gateRun.code}）：`)
    if (!checks.length) {
      say('    （没有拿到任何逐项检查 —— 可能是能力不存在或沙箱出问题）')
    }
    for (const k of checks) {
      say(`    ${k.ok ? 'ok  ' : 'FAIL'} [${k.level}] ${k.name}${k.detail ? ` — ${k.detail}` : ''}`)
    }
    say('')
    // ★ 原样带出：proofLevel / unenforced 直接从门写进 registry 的回执里读，不重写、不美化
    say(`  proofLevel ：${JSON.stringify(acc?.proofLevel ?? null)}   （原样取自 registry 回执）`)
    say(`  unenforced ：${JSON.stringify(acc?.unenforced ?? null)}   （未实施的级，绝不计作通过）`)
    say(`  沙箱回执 status：${JSON.stringify(acc?.status ?? null)}`)
    say('')
    say(`  被拒 reason：${admitted ? '（无 —— 过门）' : (failed.length ? failed.map((k) => `[${k.level}] ${k.name}${k.detail ? ` — ${k.detail}` : ''}`).join(' | ') : '（未拿到逐项原因）')}`)
    say('')

    // (3) 真实 registry：只有 --apply 才动
    let applied = 'dry-run ⇒ 真实 registry 未写'
    if (APPLY) {
      if (existing) {
        applied = `已在库（status=${existing.status}）⇒ 入池动作无需执行（本脚本**不覆盖**既有条目，含既有的 acceptance）`
      } else if (c.kind === 'mcp-server') {
        const r = runCli(CLI.registry, ['init'], process.env)
        applied = r.code === 0 ? '真实 registry：init 物化（mcp-server，pending）' : '真实 registry：init 失败'
        sayLines(transcript(r))
      } else {
        const reg = runCli(CLI.registry, registerArgs(c), process.env)
        sayLines(transcript(reg))
        applied = reg.code === 0 ? '真实 registry：已 register ⇒ pending（**尚未采纳**）' : '真实 registry：register 失败'
        if (reg.code === 0) {
          if (admitted) {
            // ★ 只有沙箱判定过门，才对真实 registry 跑门 —— 这是**唯一**会写 acceptance 的路径
            const g = runCli(CLI.gate, ['run', c.id], process.env)
            sayLines(transcript(g))
            const after = showCapability(process.env, c.id)
            applied += `；过门 ⇒ 已对真实 registry 跑门写回执（status=${after.cap?.status}, proofLevel=${JSON.stringify(after.cap?.acceptance?.proofLevel)}, unenforced=${JSON.stringify(after.cap?.acceptance?.unenforced)}）`
          } else {
            // ★ 不过门 ⇒ **不动 acceptance**（纪律 3）：沙箱里门写的 failed 回执**不落到真库**，
            //   reason 已在上面如实记录。这样真库里该条保持 `acceptance.kind='none'`，不会被误读成"跑过门"。
            const after = showCapability(process.env, c.id)
            applied += `；**不过门 ⇒ 未对真实 registry 跑门，acceptance 保持未采纳**（现状 kind=${JSON.stringify(after.cap?.acceptance?.kind ?? null)}, status=${JSON.stringify(after.cap?.acceptance?.status ?? null)}, proofLevel=${JSON.stringify(after.cap?.acceptance?.proofLevel ?? null)}）`
          }
        }
      }
    }
    say(`  真实 registry 动作：${applied}`)
    say('')
    say('  子进程原始输出：')
    sayLines(transcript(gateRun))

    results.push({ c, existing, admitted, checks, failed, acc, applied, poolNote, gateRun })
  }

  // ── 汇总 ──
  const passedN = results.filter((r) => r.admitted).length
  const rejectedN = results.length - passedN
  const registeredN = APPLY
    ? results.filter((r) => !r.existing && r.applied.startsWith('真实 registry：已 register')).length
    : 0

  const shaAfter = regSha()
  const unchanged = shaAfter === shaBefore

  // 独立交叉核对（capability-snapshot.mjs --show 自己算 sha）
  const snapShow = runCli(CLI.snapshot, ['--show'], process.env)

  say('='.repeat(78))
  say('── registry 是否被改动（证据） ──────────────────────────────────────────')
  say(`  运行前 sha256：${shaBefore}`)
  say(`  运行后 sha256：${shaAfter}`)
  say(`  ⇒ ${unchanged ? '**未改动 ✓**（sha256 一致）' : '**已改动**（sha256 不一致）'}`)
  say(`  交叉核对（capability-snapshot.mjs --show，独立算 sha）：`)
  sayLines(transcript(snapShow))
  say('')

  say('── 结论 ────────────────────────────────────────────────────────────────')
  say(`  模式：${APPLY ? 'apply（真写）' : 'dry-run（只读）'}`)
  say(`  快照：${snap ? '已执行 capability-snapshot.mjs --save（--apply 前置）' : '未执行（dry-run 不需要）'}`)
  say(`  proofLevel / unenforced：逐候选已原样带出（见上），**L2~L4 一律未实施、不计作通过**。`)
  say(`  skill-tree 候选池：暂不可用（无持久化 store，L3 未移植）—— 上文已单列说明。`)
  say(`  真实 registry 在本次运行中${unchanged ? '未被改动' : '被改动'}。`)
  say('')

  const summary = `candidates=${results.length} registered=${registeredN} passed=${passedN} rejected=${rejectedN} apply=${APPLY}`
  say(summary)
  say('')

  // ── 写报表 ──
  fs.mkdirSync(path.dirname(global.out), { recursive: true })
  fs.writeFileSync(global.out, OUT.join('\n') + '\n', 'utf8')
  say(`报表已写入：${global.out}`)

  // ── 清理沙箱 ──
  if (KEEP_SANDBOX) {
    say(`沙箱保留：${sb.root}`)
  } else {
    try { fs.rmSync(sb.root, { recursive: true, force: true }) } catch { /* 清不掉也不影响结论 */ }
  }
}

main().catch((e) => {
  console.error(`X capability-intake 内部错误：${e.message}`)
  process.exit(2)
})
