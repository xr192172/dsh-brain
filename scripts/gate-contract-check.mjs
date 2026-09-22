#!/usr/bin/env node
/**
 * gate-contract-check.mjs —— 「门契约」的校验器（**可执行的门**）
 *
 * 输入：一份 contract.json（默认 evals/gate/contract.json，可用 --contract / 位置参数覆盖）。
 * 输出：逐条检查 + 每条「防的是什么」；★ 任一项不满足 ⇒ 非零退出。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 这个脚本存在的理由
 *
 * 「门」是**契约**，不是某个实现里的几行 if。契约一旦只写在文档里，就会：
 *   (a) 被实现绕过（改了导入处、注入处不认 —— 装饰门，O45 §30.1）；
 *   (b) 被"顺手优化"掉（把 L3 的 active 要求删掉，因为"triggers 命中就够相关了"）；
 *   (c) 出现假绿（把未实施的 L2~L4 说成通过，或把缺读数说成 passed）。
 * ⇒ 所以契约必须有**机器可读形式 + 一个会拒绝的校验器**。本脚本就是那个校验器。
 *
 * ★ 最重要的一条检查是 `visibility-L3-requires-active`：**防装饰门**。
 *   现状 internal/memory/skill_tree.go:1054+ 有两条注入路径，L0 要求 Status=="active"、
 *   L3（triggers 命中 taskHint）**完全不检查 Status** ⇒ 只把导入处改成 pending 挡不住 L3。
 *   若契约不要求 L3 也 active，则这道门是装饰。校验器把它变成机器可判的失败。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 用法：
 *   node scripts/gate-contract-check.mjs                          # 校验真契约
 *   node scripts/gate-contract-check.mjs --contract <path>        # 校验指定契约
 *   node scripts/gate-contract-check.mjs --selftest               # ★ 自证有分辨力
 *
 * 退出码：0 = 契约自洽（或自检通过）／1 = 契约不合格（或自检发现校验器没分辨力）／2 = 用法或读取错误
 *
 * --selftest 干什么：在**内存里**构造若干坏契约（L3 不要求 active、unenforced 缺 L2、
 *   回执缺 proofLevel、词汇表缺 pending、词表重复、迁移丢了 passed 要求、可见性未声明 L3、
 *   实现协议 stdout 形状坏），断言校验器**会拒绝**，并打印每份坏契约被**哪条规则**挡下。
 *   ★ 同时跑一份**阳性对照**（未改动的真契约必须全过）——否则"全红"的校验器也能通过自检，
 *     那是"过度封锁"，与"假绿"同等有害。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 依赖：无。只读文件，不写任何东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DEFAULT_CONTRACT = path.join(ROOT, 'evals', 'gate', 'contract.json')

// ── 契约里的"不许改"的常量（校验器的判据，不是实现的判据） ─────────────────

/** ★ 本项目既有事实：门只跑到 L1，L2~L4 未实施 ⇒ 必须出现在 unenforced 里。 */
const REQUIRED_UNENFORCED = ['L2', 'L3', 'L4']
/** 门的两端：pending = 未过门；active = 过门。缺任一个，"门"无从谈起。 */
const CORE_STATES = ['pending', 'active']
/** ★ 必须显式声明的两条注入路径（现状的两条都在 skill_tree.go:1054+）。 */
const REQUIRED_VISIBILITY = ['L0', 'L3']
/** 回执四字段（对齐 TS 侧 capability-registry 的 acceptance）。 */
const RECEIPT_FIELDS = ['kind', 'status', 'proofLevel', 'unenforced']
/** 回执三态。 */
const RECEIPT_STATUSES = ['passed', 'failed', 'unknown']
/** 迁移返回值形状。 */
const TRANSITION_RESULT_FIELDS = ['ok', 'status', 'reason']
/** 必须声明"缺读数 ⇒ unknown"这条不变量。 */
const UNKNOWN_INVARIANT = 'missing-reading-is-unknown'

// ── 校验器主体 ──────────────────────────────────────────────────────────────

/**
 * 对一份契约做全部检查。
 * @returns {{checks: Array<{id:string,ok:boolean,why:string,detail:string}>}}
 */
function checkContract(c) {
  const checks = []
  const add = (id, ok, why, detail) => checks.push({ id, ok: Boolean(ok), why, detail: detail ?? '' })

  // ══ A. 状态词汇表（单一来源） ══════════════════════════════════════════════

  const values = c?.states?.values

  add(
    'vocab-exists',
    Array.isArray(values) && values.length > 0,
    '词汇表为空/不存在 ⇒ 没有任何状态可以判定，"门"退化成无判据（也就没有东西可校验）。',
    Array.isArray(values) ? `states.values = ${JSON.stringify(values)}` : `states.values 不是数组（${typeof values}）`,
  )

  const dupes = []
  if (Array.isArray(values)) {
    const seen = new Set()
    for (const v of values) {
      if (seen.has(v)) dupes.push(v)
      seen.add(v)
    }
  }
  add(
    'vocab-no-duplicates',
    Array.isArray(values) && dupes.length === 0,
    '重复值 ⇒ 同一状态被当成两个。Go 侧 switch 会静默走第一个分支，出现"静默不一致"（spec §32.3 的读取点清单就是为这类问题列的）。',
    dupes.length ? `重复值：${JSON.stringify(dupes)}` : '无重复',
  )

  const missingCore = CORE_STATES.filter((s) => !Array.isArray(values) || !values.includes(s))
  add(
    'vocab-has-core-states',
    missingCore.length === 0,
    'pending = 已导入未过门（门存在的前提，O45 落点 (a)）；active = 过门并写回回执后（唯一采纳态）。缺任一个 ⇒ 门的两端不存在。',
    missingCore.length
      ? `缺：${missingCore.join(', ')}（现为 ${JSON.stringify(values)}）`
      : `${CORE_STATES.join(' / ')} 都在`,
  )

  // ══ B. 判据回执 ════════════════════════════════════════════════════════════

  const schema = c?.receipt?.schema
  const recFields = Array.isArray(schema?.required) ? schema.required : []
  const missingFields = RECEIPT_FIELDS.filter((f) => !recFields.includes(f))
  add(
    'receipt-fields-complete',
    missingFields.length === 0,
    '对齐 TS 侧 capability-registry 的 acceptance{kind,status,proofLevel,unenforced}：缺 proofLevel ⇒ 读的人不知道"证明到哪为止"；缺 unenforced ⇒ 假绿。',
    missingFields.length
      ? `缺字段：${missingFields.join(', ')}（现为 ${JSON.stringify(recFields)}）`
      : `四字段齐：${RECEIPT_FIELDS.join(', ')}`,
  )

  const props = schema?.properties ?? {}

  const kindEnum = props?.kind?.enum
  const kindOk =
    Array.isArray(kindEnum) && kindEnum.includes('gate') && kindEnum.includes('none') && kindEnum.every((k) => k === 'gate' || k === 'none')
  add(
    'receipt-kind-enum',
    kindOk,
    '只有 kind="gate" 是判据；散文引用（kind="ref"）不得被当成通过 —— capability-registry 曾经把散文引用显示成 pass（假绿），已废弃。',
    `kind.enum = ${JSON.stringify(kindEnum)}`,
  )

  const statusEnum = props?.status?.enum
  const statusOk =
    Array.isArray(statusEnum) &&
    RECEIPT_STATUSES.every((s) => statusEnum.includes(s)) &&
    statusEnum.every((s) => RECEIPT_STATUSES.includes(s))
  add(
    'receipt-status-enum',
    statusOk,
    '三态必齐：缺 unknown ⇒ 缺读数时实现只能撒谎成 passed/failed（"无证据 ≠ 通过"）。',
    `status.enum = ${JSON.stringify(statusEnum)}`,
  )

  const invIds = Array.isArray(c?.receipt?.invariants) ? c.receipt.invariants.map((i) => i?.id) : []
  add(
    'receipt-missing-reading-is-unknown',
    invIds.includes(UNKNOWN_INVARIANT),
    '缺读数 ⇒ status:"unknown"（不得当 passed）。缺读数当 passed 就是假绿 —— 本项目花了两天修的那类失败（保险自己失效）。',
    `receipt.invariants = ${JSON.stringify(invIds)}`,
  )

  const un = props?.unenforced
  add(
    'receipt-unenforced-array',
    un?.type === 'array' && Array.isArray(un?.mustInclude),
    'unenforced 必须是数组。写成字符串/null ⇒ 下游（尤其 Go 侧）解析会退化成"没有未实施的级" = 全过。',
    `unenforced.type = ${JSON.stringify(un?.type)}；mustInclude = ${JSON.stringify(un?.mustInclude)}`,
  )

  const unList = Array.isArray(un?.mustInclude) ? un.mustInclude : []
  const missingUn = REQUIRED_UNENFORCED.filter((l) => !unList.includes(l))
  add(
    'receipt-unenforced-must-include',
    un?.type === 'array' && missingUn.length === 0,
    `★ 本项目既有事实：门只跑到 L1（capability-gate.mjs UNENFORCED = ${JSON.stringify(REQUIRED_UNENFORCED)}）。未实施的判据级不显式带出 = 读的人以为"全过"= 假绿。`,
    missingUn.length ? `缺：${missingUn.join(', ')}（现为 ${JSON.stringify(unList)}）` : `含 ${REQUIRED_UNENFORCED.join(', ')}`,
  )

  // ══ C. 注入可见性 ══════════════════════════════════════════════════════════

  const vRules = Array.isArray(c?.visibility?.rules) ? c.visibility.rules : []
  const levels = vRules.map((r) => r?.level)
  const missingLevels = REQUIRED_VISIBILITY.filter((l) => !levels.includes(l))
  add(
    'visibility-declares-L0-and-L3',
    missingLevels.length === 0,
    '现状有两条注入路径（skill_tree.go:1054+ 的 L0 与 L3）。契约只声明一条 ⇒ 另一条就是"绕过门的路径"。',
    missingLevels.length ? `未声明：${missingLevels.join(', ')}（现为 ${JSON.stringify(levels)}）` : `已声明 ${REQUIRED_VISIBILITY.join(' / ')}`,
  )

  for (const lv of REQUIRED_VISIBILITY) {
    const r = vRules.find((x) => x?.level === lv)
    const isL3 = lv === 'L3'
    add(
      `visibility-${lv}-requires-active`,
      r?.requiresStatus === 'active',
      isL3
        ? '★★ 防装饰门：现状 L3（triggers 命中 taskHint）**完全不检查 Status**。契约若不要求 L3 也 active，则"只把导入处改成 pending"就是装饰门 —— L0 那条路被封、L3 照走（O45 §30.1）。这一条少了，整个门作废。'
        : '现状 L0 已要求 Status == "active"；契约丢掉这条，等于把门自己拆掉一半（L0 变成"只看分数/次数"）。',
      r ? `${lv}.requiresStatus = ${JSON.stringify(r.requiresStatus)}` : `契约里没有 ${lv} 规则`,
    )
  }

  const invisible = Array.isArray(c?.visibility?.invisibleStates) ? c.visibility.invisibleStates : []
  const missingInvisible = ['pending', 'archived'].filter((s) => !invisible.includes(s))
  add(
    'visibility-invisible-states',
    missingInvisible.length === 0,
    '契约 ④：archived / pending ⇒ 不可见。漏掉 archived ⇒ 已淘汰的东西继续被注入；漏掉 pending ⇒ 门对新导入的条目无效。',
    missingInvisible.length ? `缺：${missingInvisible.join(', ')}（现为 ${JSON.stringify(invisible)}）` : `不可见集：${invisible.join(', ')}`,
  )

  const conflict = vRules.filter((r) => invisible.includes(r?.requiresStatus))
  add(
    'visibility-no-rule-admits-invisible',
    conflict.length === 0,
    '自相矛盾：一条可见性规则要求的状态，同时被声明为不可见 ⇒ 契约无法执行（实现各取一条，静默分歧）。',
    conflict.length ? `冲突：${conflict.map((r) => `${r.level}=${JSON.stringify(r.requiresStatus)}`).join(', ')}` : '无冲突',
  )

  // ══ D. 状态迁移 ════════════════════════════════════════════════════════════

  const tRules = Array.isArray(c?.transitions?.rules) ? c.transitions.rules : []
  const pa = tRules.find((r) => r?.from === 'pending' && r?.to === 'active')
  const reqs = Array.isArray(pa?.require) ? pa.require : []
  const gated = reqs.some((r) => r?.path === 'receipt.status' && r?.op === '==' && r?.value === 'passed')
  add(
    'transition-pending-active-gated',
    gated,
    '★ 这就是门本身：只有 receipt.status == "passed" 才允许 pending → active。少了它 ⇒ 没跑门也能被采纳（或永远采纳不了）。',
    pa
      ? gated
        ? `pending → active 的 require = ${JSON.stringify(reqs)}`
        : `pending → active 的 require 不含 receipt.status=="passed"（现为 ${JSON.stringify(reqs)}）`
      : '契约里没有 pending → active 规则',
  )

  const tFields = c?.transitions?.result?.fields
  const missingT = TRANSITION_RESULT_FIELDS.filter((f) => !Array.isArray(tFields) || !tFields.includes(f))
  add(
    'transition-result-shape',
    missingT.length === 0,
    '契约 ③ 的返回形状 {ok,status,reason}：调用方要靠 reason 才能"拒绝得可解释"，否则被挡下的人只会看到一张红脸。',
    missingT.length ? `缺：${missingT.join(', ')}` : `${TRANSITION_RESULT_FIELDS.join(', ')} 齐`,
  )

  // ══ E. 实现协议 ════════════════════════════════════════════════════════════

  const cmds = c?.implementations?.commands
  const hasVisible = Boolean(cmds?.visible)
  const hasTransition = Boolean(cmds?.transition)
  add(
    'impl-protocol-declares-commands',
    hasVisible && hasTransition,
    '契约 ⑤：runner 只认这两条子命令。少 visible ⇒ 门对注入面不负责（只挡迁移不挡注入 = 半截门）；少 transition ⇒ 门没有出口。',
    `visible=${hasVisible} transition=${hasTransition}`,
  )

  const vOut = cmds?.visible?.stdout
  add(
    'impl-visible-stdout',
    vOut?.visible === 'bool',
    'visible 的 stdout 必须是机器可读的 {"visible": bool}；自然语言输出不可断言，等于没判据。',
    `visible.stdout = ${JSON.stringify(vOut)}`,
  )

  const tOut = cmds?.transition?.stdout
  const tOutOk = Boolean(tOut) && tOut.ok === 'bool' && tOut.status === 'string' && tOut.reason === 'string'
  add(
    'impl-transition-stdout',
    tOutOk,
    'transition 的 stdout 必须是 {"ok":bool,"status":string,"reason":string}，与 transitions.result.fields 逐字对齐（否则 runner 与实现两套形状）。',
    `transition.stdout = ${JSON.stringify(tOut)}`,
  )

  return { checks }
}

// ── 坏契约（自检夹具，全部在内存里构造） ────────────────────────────────────

/**
 * 每份坏契约都必须被**指定的规则**挡下。
 * ★ `expect` 里的每一条 id 都必须出现在失败集里 —— 少一条即认为"校验器没有分辨力"。
 */
const BAD_CASES = [
  {
    name: '★ L3 少了 active 要求（这就是"装饰门"）',
    why: '只把导入处改成 pending、L3 不检查 Status ⇒ L0 被封而 L3 照走。',
    expect: ['visibility-L3-requires-active'],
    mutate: (c) => {
      const r = c.visibility.rules.find((x) => x.level === 'L3')
      delete r.requiresStatus
    },
  },
  {
    name: 'unenforced 缺 L2（把未实施的一级藏起来）',
    why: '藏起未实施的级 = 假绿。',
    expect: ['receipt-unenforced-must-include'],
    mutate: (c) => {
      c.receipt.schema.properties.unenforced.mustInclude = ['L3', 'L4']
    },
  },
  {
    name: 'unenforced 不是数组（写成字符串）',
    why: 'Go 侧解析会退化成"没有未实施的级"。',
    expect: ['receipt-unenforced-array'],
    mutate: (c) => {
      c.receipt.schema.properties.unenforced = { type: 'string', mustInclude: ['L2', 'L3', 'L4'] }
    },
  },
  {
    name: '回执缺 proofLevel 字段',
    why: '读的人不知道"证明到哪为止"。',
    expect: ['receipt-fields-complete'],
    mutate: (c) => {
      c.receipt.schema.required = ['kind', 'status', 'unenforced']
    },
  },
  {
    name: '回执 status 枚举缺 unknown',
    why: '缺读数时实现只能撒谎成 passed。',
    expect: ['receipt-status-enum'],
    mutate: (c) => {
      c.receipt.schema.properties.status.enum = ['passed', 'failed']
    },
  },
  {
    name: '词汇表缺 pending（门没有起点）',
    why: '没有 pending ⇒ 导入即 active = 没有门。',
    expect: ['vocab-has-core-states'],
    mutate: (c) => {
      c.states.values = c.states.values.filter((s) => s !== 'pending')
    },
  },
  {
    name: '词汇表里有重复的 active',
    why: '同一状态被当成两个 ⇒ 静默不一致。',
    expect: ['vocab-no-duplicates'],
    mutate: (c) => {
      c.states.values = ['pending', 'active', 'active', 'archived']
    },
  },
  {
    name: '迁移丢了 passed 回执要求（pending 可随便转 active）',
    why: '没有门，"没跑过门"与"跑过并通过"无法区分。',
    expect: ['transition-pending-active-gated'],
    mutate: (c) => {
      const r = c.transitions.rules.find((x) => x.from === 'pending' && x.to === 'active')
      r.require = []
    },
  },
  {
    name: '可见性未声明 L3 规则（另一条注入路径不管了）',
    why: '只声明 L0 ⇒ L3 路径不受契约约束。',
    expect: ['visibility-declares-L0-and-L3', 'visibility-L3-requires-active'],
    mutate: (c) => {
      c.visibility.rules = c.visibility.rules.filter((x) => x.level !== 'L3')
    },
  },
  {
    name: '可见性规则把 pending 当可见（自相矛盾）',
    why: '同一状态既可见又不可见 ⇒ 实现各取一条。',
    expect: ['visibility-L0-requires-active', 'visibility-no-rule-admits-invisible'],
    mutate: (c) => {
      const r = c.visibility.rules.find((x) => x.level === 'L0')
      r.requiresStatus = 'pending'
    },
  },
  {
    name: '实现协议缺 visible 子命令（半截门）',
    why: '只挡迁移不挡注入。',
    expect: ['impl-protocol-declares-commands'],
    mutate: (c) => {
      delete c.implementations.commands.visible
    },
  },
  {
    name: 'visible 的 stdout 形状坏（不可断言）',
    why: '自然语言输出等于没判据。',
    expect: ['impl-visible-stdout'],
    mutate: (c) => {
      c.implementations.commands.visible.stdout = { message: 'string' }
    },
  },
]

// ── 输出 ────────────────────────────────────────────────────────────────────

const clone = (o) => JSON.parse(JSON.stringify(o))

function printReport(checks, { verbose = true } = {}) {
  for (const x of checks) {
    console.log(`  ${x.ok ? 'ok  ' : 'FAIL'}  ${x.id}`)
    if (verbose) console.log(`        └ 防的是：${x.why}`)
    if (x.detail) console.log(`        · ${x.detail}`)
  }
}

function readContract(file) {
  if (!fs.existsSync(file)) {
    console.error(`X 找不到契约文件：${file}`)
    console.error('  （默认是 evals/gate/contract.json；本脚本只读，不会创建它）')
    process.exit(2)
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`X 契约不是合法 JSON：${file}\n  ${e.message}`)
    process.exit(2)
  }
}

function runSelftest() {
  console.log('门契约校验器 · --selftest（自证有分辨力）')
  console.log('═'.repeat(72))
  console.log('★ 自检要证明两件事：')
  console.log('   (1) 阳性对照：未改动的真契约**必须全过** —— 否则"全红"的校验器也能过自检（过度封锁）；')
  console.log('   (2) 分辨力：每一份坏契约**必须被指定的规则挡下**，并打印是哪条。')
  console.log('')
  console.log(`真契约：${DEFAULT_CONTRACT}`)
  console.log('')

  const base = readContract(DEFAULT_CONTRACT)
  const good = checkContract(base).checks
  const goodFailed = good.filter((x) => !x.ok)

  console.log('【阳性对照】未改动的真契约')
  console.log('-'.repeat(72))
  if (goodFailed.length) {
    console.log(`  ❌ 真契约有 ${goodFailed.length} 项失败 —— 校验器连"好契约"都拒绝，说明它会过度封锁：`)
    printReport(goodFailed, { verbose: false })
    console.log('\n自检结果：❌ 阳性对照未通过（先修契约或修校验器）')
    process.exit(1)
  }
  console.log(`  ✅ 真契约 ${good.length} 项检查全过（校验器不是"全红"的）`)
  console.log('')

  console.log('【分辨力】坏契约必须被挡下')
  console.log('-'.repeat(72))
  let bad = 0
  for (let i = 0; i < BAD_CASES.length; i++) {
    const cs = BAD_CASES[i]
    const c = clone(base)
    cs.mutate(c)
    const checks = checkContract(c).checks
    const failed = checks.filter((x) => !x.ok)
    const failedIds = failed.map((x) => x.id)

    const rejected = failed.length > 0
    const hitAll = cs.expect.every((id) => failedIds.includes(id))

    console.log(`CASE ${i + 1}  ${cs.name}`)
    console.log(`  坏在哪：${cs.why}`)
    console.log(`  期望被挡下：${cs.expect.join(', ')}`)
    if (rejected) {
      for (const id of failedIds) {
        const x = failed.find((y) => y.id === id)
        console.log(`  ⛔ 被规则挡下：${id}`)
        console.log(`        └ 防的是：${x.why}`)
      }
      console.log(`  该坏契约的失败项（共 ${failed.length} 条，校验器 exit≠0）：${failedIds.join(', ')}`)
    } else {
      console.log('  ❌ 未被任何规则挡下 —— 校验器对这份坏契约没有分辨力！')
    }
    const okCase = rejected && hitAll
    if (!okCase) bad++
    console.log(`  ${okCase ? '✅ 已拒绝' : '❌ 自检失败'}${hitAll ? '' : `（期望的规则未全部命中：缺 ${cs.expect.filter((id) => !failedIds.includes(id)).join(', ')}）`}`)
    console.log('')
  }

  console.log('═'.repeat(72))
  console.log(`自检汇总：阳性对照 ${goodFailed.length ? 'FAIL' : 'PASS'}；坏契约 ${BAD_CASES.length - bad}/${BAD_CASES.length} 被正确挡下`)
  if (bad) {
    console.log('自检结果：❌ 校验器没有分辨力（有坏契约被放过）⇒ 非零退出')
    process.exit(1)
  }
  console.log('自检结果：✅ 校验器有分辨力（坏契约全被指定的规则挡下）⇒ exit 0')
  process.exit(0)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('\n').slice(1, 34).join('\n'))
  process.exit(0)
}

if (argv.includes('--selftest')) {
  runSelftest()
}

const i = argv.indexOf('--contract')
const contractFile = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')
  ? path.resolve(argv[i + 1])
  : (argv.find((a) => !a.startsWith('--')) ? path.resolve(argv.find((a) => !a.startsWith('--'))) : DEFAULT_CONTRACT)

const rawBytes = fs.readFileSync(contractFile)
const contract = readContract(contractFile)
const { checks } = checkContract(contract)
const failed = checks.filter((x) => !x.ok)

console.log('门契约校验 · dsh-gate-contract/v1')
console.log('═'.repeat(72))
console.log(`契约文件：${contractFile}`)
console.log(`JSON 解析：✅ 成功（本脚本用 node 的 JSON.parse 读了一遍：${rawBytes.length} 字节，顶层键 ${Object.keys(contract).length} 个：${Object.keys(contract).join(', ')}）`)
console.log(`目标：契约必须**自洽** —— 词汇表单一来源 / 回执不撒谎 / 迁移有门 / 两条注入路径都要求 active / 实现协议可断言`)
console.log(`每项都打印「防的是什么」；任一项不满足 ⇒ 非零退出。
`)
console.log(`共 ${checks.length} 项检查：`)
console.log('')
printReport(checks, { verbose: true })
console.log('')
console.log('═'.repeat(72))
console.log(`失败：${failed.length} / ${checks.length}`)
for (const f of failed) console.log(`  ⛔ ${f.id} —— ${f.detail}`)
if (failed.length) {
  console.log('契约不合格 ⇒ 非零退出')
  process.exit(1)
}
console.log('✅ 契约自洽 ⇒ exit 0')
process.exit(0)
