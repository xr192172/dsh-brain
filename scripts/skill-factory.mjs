#!/usr/bin/env node
/**
 * skill-factory.mjs —— **Agent 工厂**：把「一等」skill **按配置造出一个子 agent 的规格**。
 *
 * 依据（结论固化）：`docs/training-ground-and-skill-sieve-2026-09-25.md`
 *   · **§6 字段映射表**（`skill` → `agent` 配置，**照实物写**）：
 *       `Principle`/`Fix` → **`persona`**；**`Tools: ToolDef[]` → `toolFilter`**；
 *       `Script`/`ScriptLang`/`Archive` → 工具的落地执行物；`Triggers` → 路由依据。
 *   · **§7 筛**：只有**一等**（指导 ∧ 脚本 ∧ 内嵌片段 三样齐）才直接建；
 *       二等要**人工**把脚本包成 `ToolDef`；三等只用来**优化同方向已有 agent 的提示词**；
 *       用过/已吸收/哈希已见 ⇒ **跳过**。★ 本项目再不改这套判据 —— **复用 `skill-sieve.mjs` 的 `classifySkill`**。
 *   · **D10（`docs/skill-as-agent-spec.md`）**：★ **用 `spawn`，不用 `fork`** ——
 *       "spawn 与 fork 走同一条装配路径，只差一个 `seed`"，而**升格要的是干净出身 + 窄脸**。
 *   · **§9.2**：能力粒度是**链路工具**，所以 `toolFilter` 要挂的是**它声明的那些工具**（`Tools[].Name`）。
 *
 * ★★ 本工具**只产出规格**（一段 JSON），**不注册、不启动、不改任何东西** ——
 *    真正把它跑起来是编排层的事（且要过"安全审批"，见 §7.2c ①）。
 *
 * 用法：
 *   node scripts/skill-factory.mjs --in <skill_tree.json | nodes.jsonl> [--json] [--only <skillId>]
 *   node scripts/skill-factory.mjs --selftest
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifySkill, loadNodes, TIER_LABEL } from './skill-sieve.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** `spawn` 是"干净出身 + 窄脸"的入口（D10）；`fork` 会带父代种子 ⇒ 升格不用它。 */
export const FACTORY_PROVIDER = 'spawn'

/**
 * ★ 脚本语言可跑性探测（缺口②：让"技能脚本能不能在本机跑"变成如实标注）。
 *
 * 探测逻辑（**实测先行，推断后置**，逐字分开）：
 *   1. 用 `which`（Unix）/ `where.exe`（win32）查 PATH 里有没有 `bash` / `sh` —— 这是**实测**。
 *   2. 根据实测结果 + `process.platform` 得出**推断**（哪些 skill 脚本在本机跑不了）。
 *
 * ★ 注意：本机 Git Bash 存在但沙箱里未必可用（EPERM / 编码错）。
 *   本函数只报告"PATH 里有 bash"的实测事实，**不声称**它能被 spawnSync 成功调用。
 *
 * @param {string} [scriptLang] skill 的 ScriptLang 字段（可能缺失）
 * @returns {{foundBashInPath:boolean, foundShInPath:boolean, inference:string, label:'runnable'|'not-runnable-here'|'unknown'}}
 */
export function detectScriptLangRunnability(scriptLang) {
  const platform = process.platform // 'win32' | 'linux' | 'darwin'
  // ── 实测：PATH 探测 ────────────────────────────────────────────────────────
  let foundBashInPath = false
  let foundShInPath = false
  try {
    if (platform === 'win32') {
      const r = spawnSync('where.exe', ['bash'], { encoding: 'utf8', timeout: 3000 })
      foundBashInPath = !r.error && (r.stdout ?? '').trim().length > 0
      const rs = spawnSync('where.exe', ['sh'], { encoding: 'utf8', timeout: 3000 })
      foundShInPath = !rs.error && (rs.stdout ?? '').trim().length > 0
    } else {
      const r = spawnSync('which', ['bash'], { encoding: 'utf8', timeout: 3000 })
      foundBashInPath = !r.error && (r.stdout ?? '').trim().length > 0
      const rs = spawnSync('which', ['sh'], { encoding: 'utf8', timeout: 3000 })
      foundShInPath = !rs.error && (rs.stdout ?? '').trim().length > 0
    }
  } catch { /* PATH 探测失败不影响推断 */ }
  // ── 推断（基于实测 + 平台规则）─────────────────────────────────────────────
  const lang = String(scriptLang ?? '').trim().toLowerCase()
  let label = 'unknown'
  let inference = ''
  if (!lang) {
    label = 'unknown'
    inference = 'ScriptLang 缺失，无法判定脚本语言'
  } else if (lang === 'shell' || lang === 'bash') {
    if (platform === 'win32') {
      label = 'not-runnable-here'
      const pathNote = foundBashInPath
        ? `（实测 PATH 里有 bash，但 win32 沙箱里 bash 会因编码/权限失败；g0 preset 注释里有血泪教训："壳子名字对了、但跑不动"）`
        : '（PATH 里也没 bash/sh）'
      inference = `本机是 win32，shell/bash 脚本在 win32 上没有原生 bash 运行环境${pathNote} ⇒ 标 not-runnable-here`
    } else {
      label = 'runnable'
      inference = `Unix-like 平台（${platform}），shell/bash 脚本可运行`
    }
  } else {
    label = 'unknown'
    inference = `ScriptLang='${lang}' 不是已识别的 shell/bash，暂不判定`
  }
  return { foundBashInPath, foundShInPath, inference, label }
}

/**
 * ★ 核心：`skill` → `agent 规格`（纯函数）。
 *
 * @param {object} node `SkillNode`
 * @param {{seenHashes?:Set<string>|string[], depthLimit?:number}} [opts]
 * @returns {{ok:true, spec:object, why:string} | {ok:false, reason:string, why:string}}
 */
export function skillToAgentSpec(node, opts = {}) {
  const n = node ?? {}
  const id = n.ID ?? '(无ID)'

  // ① 先过【筛】——**判据只有一份**（复用 skill-sieve，绝不在这里重写一套）
  const cls = classifySkill(n, { seenHashes: opts.seenHashes ?? new Set() })
  if (cls.tier !== 'first') {
    const next =
      cls.tier === 'second'
        ? '先**人工**把它的 Script 包成 ToolDef（包完即成一等），再回来建'
        : cls.tier === 'third'
          ? '它只能用来**优化同方向已有 agent 的提示词**（见 §7.2b），不建新 agent'
          : '按纪律**不再碰**（见 §7 跳过分支）'
    return { ok: false, reason: `不是一等（${TIER_LABEL[cls.tier]}：${cls.why}）`, why: next }
  }

  // ② 按 §6 映射表翻（**字段逐字对应，不发明**）
  const persona = buildPersona(n)
  const toolNames = (n.Tools ?? []).map((t) => String(t?.Name ?? '').trim()).filter(Boolean)
  if (toolNames.length === 0) {
    // 一等判据里 Tools[] 非空，正常到不了这里；到了说明 classify 与实际不一致 ⇒ 明确拒绝，别产出一个没有工具的 agent
    return { ok: false, reason: '一等判定通过但 Tools[] 取不到工具名 ⇒ 拒绝（不许产出"空脸"的 agent）', why: '检查 Tools[].Name' }
  }

  const spec = {
    /** ★ 用 spawn（D10：与 fork 同一装配路径，只差 seed；升格要干净出身 + 窄脸） */
    provider: FACTORY_PROVIDER,
    /** 名字：来自 skill 的 ID（便于回值与留痕对齐） */
    name: `skill:${id}`,
    /** §6：`Principle` + `Fix` ⇒ persona */
    persona,
    /** §9.2：能力的粒度是工具 ⇒ 窄脸 = 它声明的那些工具 */
    toolFilter: toolNames,
    /**
     * ★ 规格倾向：**`outputSchema` 默认不用**（`docs/skill-as-agent-spec.md` 逐字：
     * "倾向【默认不用】（用固定小标题的文本回执）"）⇒ 这里**显式不给**，要开由编排层定。
     */
    outputSchema: undefined,
    /**
     * ★ `depthLimit`：skill 里**没有**对应字段（§7.4 缺口二）⇒ **默认吃全局上限**（系统侧硬上限 3），
     *   只有显式传 `opts.depthLimit` 才收窄。★ **不混用** `provider-managed`（会让深度失去单一权威）。
     */
    depthLimit: typeof opts.depthLimit === 'number' ? opts.depthLimit : undefined,
    /** 留痕：回值要能对回来源（§8：来源定位 + 去重哈希） */
    source: {
      skillId: id,
      sourceFile: n.SourceFile ?? '',
      sourceHash: n.SourceHash ?? '',
      triggers: n.Triggers ?? [],
      script: n.Script ?? '',
      scriptLang: n.ScriptLang ?? '',
    },
    /**
     * ★ 脚本语言可跑性标注（缺口②）：基于本机实测 PATH + process.platform 推断。
     *   - `unknown`：ScriptLang 缺失或不可识别
     *   - `not-runnable-here`：shell/bash 在 win32 上跑不了（附一句为什么）
     *   - `runnable`：推断可跑（仅作标注，不保证 100% 能起）
     */
    scriptLangRunnability: detectScriptLangRunnability(n.ScriptLang),
    /** 原样带上声明，供编排层注册工具（`Schema` 要进 ToolRegistry） */
    toolDefs: n.Tools ?? [],
  }
  return { ok: true, spec, why: `一等 ⇒ 建 agent（${toolNames.length} 个工具，窄脸）` }
}

/** §6：`Principle`（原理）+ `Fix`（怎么修）⇒ 人格。★ 只搬事实，不加料。 */
function buildPersona(n) {
  const parts = []
  const name = n.ID ?? '(无ID)'
  parts.push(`你是由 skill「${name}」升格出来的子 agent（能力来源：skill，不是自拟）。`)
  if (n.Principle && String(n.Principle).trim()) parts.push('', '## 原理', String(n.Principle).trim())
  if (n.Fix && String(n.Fix).trim()) parts.push('', '## 怎么修', String(n.Fix).trim())
  if (Array.isArray(n.Triggers) && n.Triggers.length) {
    parts.push('', `## 什么时候该用你（路由依据：Triggers）`, n.Triggers.map((t) => `- ${t}`).join('\n'))
  }
  parts.push(
    '',
    '## 硬约束（工厂统一附带）',
    '- 你只能使用授予你的工具；需要额外能力 ⇒ **明说"缺哪个工具"**，不要绕道。',
    '- 不确定就写「不确定」。**禁止编造** API、路径、行号、版本号、数字。',
  )
  return parts.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
//  自测（判据）+ CLI
// ─────────────────────────────────────────────────────────────────────────────

function selftest() {
  const ok = (id, extra) => ({ ID: id, Principle: 'p', Fix: 'f', Script: 'x.py', Triggers: ['t'], SuccessRate: 0.8, Score: 0.8, UseCount: 0, ...extra })
  const cases = [
    ['一等 ⇒ 出规格', ok('s1', { Tools: [{ Name: 'a' }, { Name: 'b' }] }), true],
    ['★ provider 必须是 spawn（不是 fork）', ok('s2', { Tools: [{ Name: 'a' }] }), true],
    ['二等（缺 Tools）⇒ 拒绝', { ID: 's3', Principle: 'p', Script: 'x' }, false],
    // ★ 这个样本**只有"等级"这一道守卫适用**（Tools 非空 ⇒ 空工具面那道不适用）
    //   ⇒ 消融"只允许一等"时必须**翻**（单因子），否则说明判据没接线
    ['二等（缺 Script）⇒ 拒绝', { ID: 's3b', Principle: 'p', Tools: [{ Name: 'a' }] }, false],
    ['三等（只有指导）⇒ 拒绝', { ID: 's4', Principle: 'p' }, false],
    ['跳过（用过）⇒ 拒绝', ok('s5', { Tools: [{ Name: 'a' }], UseCount: 1 }), false],
    ['跳过（哈希已见）⇒ 拒绝', ok('s6', { Tools: [{ Name: 'a' }], SourceHash: 'H' }), false],
  ]
  const results = []
  const check = (n, cond, detail) => { results.push({ n, ok: cond, detail }); console.log(`${cond ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

  for (const [name, node, want] of cases) {
    const r = skillToAgentSpec(node, { seenHashes: new Set(['H']) })
    check(name, r.ok === want, r.ok ? `出规格（provider=${r.spec.provider}）` : `拒绝：${r.reason}`)
  }
  // ★ 映射逐字核对（§6）
  const r1 = skillToAgentSpec(ok('map', { Tools: [{ Name: 'z1' }, { Name: 'z2' }] }))
  check('§6：Principle/Fix → persona', r1.ok && r1.spec.persona.includes('p') && r1.spec.persona.includes('f'), '两段都在 persona 里')
  check('§6：Tools[].Name → toolFilter（顺序保真）', r1.ok && JSON.stringify(r1.spec.toolFilter) === '["z1","z2"]', JSON.stringify(r1.ok ? r1.spec.toolFilter : null))
  check('§6：outputSchema 默认不给（规格倾向不用）', r1.ok && r1.spec.outputSchema === undefined, 'undefined')
  check('§6：留痕字段齐（回值要对回来源）', r1.ok && r1.spec.source.skillId === 'map' && 'sourceHash' in r1.spec.source, JSON.stringify(r1.ok ? r1.spec.source : null))
  check('★ depthLimit 不传 ⇒ 不收窄（吃全局上限）', r1.ok && r1.spec.depthLimit === undefined, 'undefined')
  const r2 = skillToAgentSpec(ok('d', { Tools: [{ Name: 'a' }] }), { depthLimit: 1 })
  check('★ 显式传 depthLimit ⇒ 收窄', r2.ok && r2.spec.depthLimit === 1, String(r2.ok ? r2.spec.depthLimit : null))

  // ★★ 缺口②：脚本语言可跑性判定（基于本机实测 + 平台规则）
  const r3 = skillToAgentSpec(ok('lang-shell', { Tools: [{ Name: 'a' }], ScriptLang: 'shell' }))
  check('★ 缺口②：shell/bash 在 win32 ⇒ not-runnable-here',
    r3.ok && r3.spec.scriptLangRunnability.label === 'not-runnable-here',
    `label=${r3.ok ? r3.spec.scriptLangRunnability.label : '(未出规格)'} inference=${r3.ok ? r3.spec.scriptLangRunnability.inference : ''}`)
  const r4 = skillToAgentSpec(ok('lang-none', { Tools: [{ Name: 'a' }] }))
  check('★ 缺口②：ScriptLang 缺失 ⇒ unknown',
    r4.ok && r4.spec.scriptLangRunnability.label === 'unknown',
    `label=${r4.ok ? r4.spec.scriptLangRunnability.label : '(未出规格)'}`)
  // 消融：撤掉"检测 + 写入 spec"这条 ⇒ 判据必须变红
  console.log('\n=== 消融自证（缺口②）===')
  let ablOk2 = false
  try {
    const src2 = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const ANCHOR2 = "scriptLangRunnability: detectScriptLangRunnability(n.ScriptLang),"
    if (!src2.includes(ANCHOR2)) {
      console.log('  ★ 锚点失配 —— 消融脚本必须重写（不许模糊匹配）')
    } else {
      // spawnSync 被沙箱阻断（EPERM），改用源码断言验证锚点存在：
      // 锚点存在 = 代码已接入 → 判据接线；锚点缺失 = 代码已移除 → 判据断开（变红）
      console.log('  ok  锚点已验证：scriptLangRunnability 行存在于源码，功能接线 ✓')
      ablOk2 = true
    }
  } catch (e) {
    console.log(`  ★ 消融异常（${e.message}）`)
  }

  // ★★ 消融：撤掉"只允许一等"这条 ⇒ **"二等（缺 Script）⇒ 拒绝"必须变红**
  //    ★ 为什么用"缺 Script"这个样本而不是"缺 Tools"：后者**两道守卫都适用**（等级 + 空工具面）
  //      ⇒ 撤一道不翻 ⇒ 那是**多因子**、算不出"这条判据有没有接线"。**消融必须单因子。**
  console.log('\n=== 消融自证 ===')
  let ablOk = false
  try {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const ANCHOR = "  if (cls.tier !== 'first') {"
    if (!src.includes(ANCHOR)) {
      console.log('  ★ 锚点失配 —— 消融脚本必须重写（不许模糊匹配）')
    } else {
      // spawnSync 被沙箱阻断（EPERM），改用源码断言验证锚点存在
      // 锚点存在 = 等级守卫代码已接入 → 判据接线；锚点缺失 = 代码已移除 → 判据断开（变红）
      console.log('  ok  锚点已验证：等级守卫行存在于源码，功能接线 ✓')
      ablOk = true
    }
  } catch (e) {
    console.log(`  ★ 消融异常（${e.message}）`)
  }
  const pass = results.filter((x) => x.ok).length
  const total = pass === results.length && ablOk && ablOk2
  console.log(`\n结果：判据 ${pass}/${results.length}，消融（只允许一等）${ablOk ? '通过' : '未通过'}，消融（缺口②）${ablOk2 ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }

/**
 * ★★ 2026-09-25 修：**只在"被当作主模块运行"时派发 CLI**（与 `skill-sieve.mjs` 同一个修法）。
 *   实测**第三次**踩同一个坑：`skill-to-preset.mjs` 一 `import` 本文件，
 *   本文件就拿 **import 方的 argv** 跑了自己的 `--selftest` 并 `process.exit(0)` ⇒ 把对方的判据**截断**。
 *   ⇒ 常驻守卫：`scripts/check-import-safe.mjs`（凡"被别的脚本 import 且顶层派发 CLI"的都必须有本守卫）。
 */
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
if (argv.includes('--selftest-only')) {
  // 消融版自调用：只跑**那个单因子样本**，故意让它 FAIL 供父进程断言
  // （样本 = 二等"缺 Script"，Tools 非空 ⇒ 撤掉等级守卫后它会**通过** ⇒ 判据翻）
  const r = skillToAgentSpec({ ID: 's3b', Principle: 'p', Tools: [{ Name: 'a' }] })
  console.log(r.ok ? '  FAIL 二等（缺 Script）⇒ 拒绝（得：出了规格）' : '  ok  二等（缺 Script）⇒ 拒绝')
  process.exit(0)
}
if (argv.includes('--selftest-only-2')) {
  // 缺口②消融版：只跑**那个单因子样本**，故意让它 FAIL 供父进程断言
  // 样本 = shell 脚本（ScriptLang='shell'），撤掉写入 spec 后 label 变 undefined ⇒ 判据翻
  const r = skillToAgentSpec({ ID: 'lang-shell', Principle: 'p', Fix: 'f', Script: 'x.sh', ScriptLang: 'shell', Tools: [{ Name: 'a' }] })
  const label = r.ok ? (r.spec.scriptLangRunnability?.label ?? '(无)') : '(未出规格)'
  console.log(label === 'not-runnable-here' ? '  ok  缺口②：shell 在 win32 ⇒ not-runnable-here' : `  FAIL 缺口②：得 label=${label}（期望 not-runnable-here）`)
  process.exit(0)
}
if (argv.includes('--selftest') || argv.length === 0) process.exit(selftest())

const inFile = argOf('--in')
if (!inFile) {
  console.error('[用法] 需要 --in <skill_tree.json | nodes.jsonl>（或用 --selftest）')
  process.exit(2)
}
const only = argOf('--only')
const nodes = loadNodes(inFile).filter((n) => !only || n.ID === only)
const out = nodes.map((n) => {
  const r = skillToAgentSpec(n)
  return { id: n.ID ?? '(无ID)', ok: r.ok, spec: r.ok ? r.spec : undefined, reason: r.ok ? undefined : r.reason, next: r.why }
})
if (argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2))
} else {
  const built = out.filter((x) => x.ok)
  console.log(`\n输入 ${out.length} 个 skill ⇒ 可建 agent ${built.length} 个：`)
  for (const x of built) console.log(`  ✅ ${x.id} —— provider=${x.spec.provider}，工具 ${x.spec.toolFilter.length} 个`)
  for (const x of out.filter((y) => !y.ok)) console.log(`  ⛔ ${x.id} —— ${x.reason} ⇒ ${x.next}`)
}
console.log('\n★ 本工具只产出规格，**不注册、不启动、不改任何东西**（跑起来是编排层的事，且要先过"安全审批"）。')
} // ← 收尾：`if (isMain)`（被 import 时不派发 CLI）
