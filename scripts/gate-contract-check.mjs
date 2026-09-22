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
 *   实现协议 stdout 形状坏、★ 没声明状态写回约定(O51)、不可见集漏 invalidated/suspicious(O52)、
 *   迁移没要求回执必填字段可读(O53)、★ 没声明写回痕迹机制(O55)、★ 没声明向量配对规则(O55)、
 *   ★★ 删掉正负对照那条正向向量(O55)、★ 正向对照在但没带 fileChanged 断言(O55)、
 *   ★★ O57 按类配对：删掉 L0 的正向对照、★★ 删掉 L3 的正向对照、
 *   ★ L0 正向对照的 expect.visible 被改成 false（配对无牙）、
 *   ★ L0 负向向量的档位被改到阈值外（"同档位/只差 status"这条同形判据被破坏）、
 *   ★ 契约没声明按类配对 rules(O57)），
 *   断言校验器**会拒绝**，并打印每份坏契约被**哪条规则**挡下。
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
/** ★ O52：states.values 里的这两个态也必须被明确声明为不可见。 */
const REQUIRED_INVISIBLE_EXTRA = ['invalidated', 'suspicious']
/** ★ O51：runner 读回状态用的字段名（写回结果里那个"状态"字段）。 */
const STATE_READBACK_FIELD = 'status'
/** ★ O53：过门时回执里至少要可读的那个必填字段。 */
const REQUIRED_RECEIPT_FIELD_FOR_ADOPTION = 'proofLevel'
/** ★ O55：本契约选定的写回痕迹机制（kind / scope 必须逐字是这两个值：痕迹只能取自 runner 读回的那份文件）。 */
const EVIDENCE_KIND = 'file-digest'
const EVIDENCE_SCOPE = 'declared-writeback-file'
/** ★ O55：向量配对规则允许的模式（目前只有"同 transition.to"这一种）。★ O57 保持原样不动：
 *  这是**顶层那一档**（transition）的判据 —— 不许因为新增了两类就把旧档也放行。 */
const PAIR_MODES = ['same-transition-target']
/** ★ O57：配对规则必须按类覆盖这三类（transition 迁移 / l0 = L0 注入 / l3 = L3 注入）。 */
const REQUIRED_PAIR_CLASSES = ['transition', 'l0', 'l3']
/** ★ O57：每类允许的 mode（"同形"的判据名字；判据本体在本文件里，契约只声明用哪种）。 */
const CLASS_PAIR_MODES = {
  transition: ['same-transition-target'],
  l0: ['same-l0-bucket'],
  l3: ['same-l3-trigger-hit'],
}
/** ★ O57：可见性类的 kind → 契约 visibility.rules 里的 level。 */
const CLASS_LEVEL = { l0: 'L0', l3: 'L3' }
/** ★ O57：契约 L3 规则声明的命中条件 kind（校验器据此推导"命中载体字段"，**不重造命中算法**）。 */
const L3_CONDITION_KIND = 'triggers-hit-taskHint'
/** ★ O57：由 L3_CONDITION_KIND 推导出的命中载体字段名。 */
const L3_TRIGGER_FIELD = 'triggers'

// ── ★ O57：按类配对检查用的小工具 ────────────────────────────────────────────

/**
 * ★ O57：按契约声明的算子比较（用于「该负向向量的档位都在阈值内」这条同形判据）。
 * ★ 返回 null 表示契约里出现**本校验器不支持的算子** ⇒ 调用方必须判 FAIL，
 *   绝不能把"不认识"当成"满足"（那会静默放过一条判据）。
 */
function cmpOp(op, actual, expected) {
  switch (op) {
    case '>': return actual > expected
    case '>=': return actual >= expected
    case '<': return actual < expected
    case '<=': return actual <= expected
    case '==': return actual === expected
    case '!=': return actual !== expected
    case 'in': return Array.isArray(expected) && expected.includes(actual)
    default: return null
  }
}

/** 逐值相等（数组/对象用 JSON 形式比；向量里只有标量与字符串数组，顺序即语义）。 */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * ★ O57：校验一条**按类**配对规则自身的合法性。
 * ★ 关键的一条是「nodeFields 必须覆盖该 level 的可见性规则真正读到的字段」——
 *   否则「同形」会在契约那侧被悄悄放宽（例如删掉 useCount，两个不同档位的向量也算同形）。
 * @param {object} cr 契约 vectors.pairing.classes.rules 里的一条
 * @param {{legacy:{requireFor:string,mode:string,requirePairAsserts:string}, l0Metrics:string[], l3CondKind:string}} ctx
 * @returns {string[]} 问题清单（空 = 合法）
 */
function validatePairClassRule(cr, ctx) {
  const bad = []
  const cls = cr?.class
  const modes = CLASS_PAIR_MODES[cls]
  if (typeof cls !== 'string' || !REQUIRED_PAIR_CLASSES.includes(cls)) return [`class=${JSON.stringify(cls)} 不是 ${JSON.stringify(REQUIRED_PAIR_CLASSES)} 之一`]
  if (typeof cr?.kind !== 'string' || cr.kind.trim() === '') bad.push(`缺 kind（现为 ${JSON.stringify(cr?.kind)}）`)
  if (typeof cr?.role !== 'string' || cr.role.trim() === '') bad.push(`缺 role（现为 ${JSON.stringify(cr?.role)}）`)
  if (cr?.requireFor !== `${cr?.kind}.${cr?.role}`) {
    bad.push(`requireFor=${JSON.stringify(cr?.requireFor)} 必须逐字等于 "kind.role" = ${JSON.stringify(`${cr?.kind}.${cr?.role}`)}`)
  }
  if (!Array.isArray(modes) || !modes.includes(cr?.mode)) {
    bad.push(`mode=${JSON.stringify(cr?.mode)} 不在 ${JSON.stringify(modes)} 里`)
  }
  if (typeof cr?.requirePairAsserts !== 'string' || cr.requirePairAsserts.trim() === '') {
    bad.push(`缺 requirePairAsserts（"有牙"的断言字段名）`)
  }
  if (typeof cr?.sameShape !== 'string' || cr.sameShape.trim() === '') {
    bad.push('缺 sameShape（"同形"的机器可判定义 —— 不许只在文档里写）')
  }
  if (typeof cr?.why !== 'string' || cr.why.trim() === '') {
    bad.push('缺 why（防的是什么）')
  }

  if (cls === 'transition') {
    // ★ 顶层那档（O55）与按类这档必须是同一套值 —— 否则同一档规则在两处各写一遍，必然漂移。
    if (cr.requireFor !== ctx?.legacy?.requireFor) bad.push(`与顶层 requireFor=${JSON.stringify(ctx?.legacy?.requireFor)} 不一致（漂移）`)
    if (cr.mode !== ctx?.legacy?.mode) bad.push(`与顶层 mode=${JSON.stringify(ctx?.legacy?.mode)} 不一致（漂移）`)
    if (cr.requirePairAsserts !== ctx?.legacy?.requirePairAsserts) bad.push(`与顶层 requirePairAsserts=${JSON.stringify(ctx?.legacy?.requirePairAsserts)} 不一致（漂移）`)
    return bad
  }

  // ── 可见性类（l0 / l3）──
  if (cr?.level !== CLASS_LEVEL[cls]) bad.push(`level=${JSON.stringify(cr?.level)} 必须是 ${JSON.stringify(CLASS_LEVEL[cls])}`)
  if (cr?.statusField !== 'status') bad.push(`statusField=${JSON.stringify(cr?.statusField)} 必须是 "status"（唯一自变量就是它）`)
  if (typeof cr?.positiveStatus !== 'string' || cr.positiveStatus.trim() === '') {
    bad.push('缺 positiveStatus（正向对照必须是哪个状态）')
  }
  const nodeFields = Array.isArray(cr?.nodeFields) ? cr.nodeFields : null
  if (!nodeFields || nodeFields.length === 0) {
    bad.push('缺 nodeFields（除 status 外必须逐值相等的节点字段清单）')
  } else if (nodeFields.includes('status')) {
    bad.push('nodeFields 里含 "status" —— status 是**唯一自变量**，必须排除在"相等字段"之外')
  } else if (cls === 'l0') {
    if (!Array.isArray(ctx?.l0Metrics) || ctx.l0Metrics.length === 0) {
      bad.push('契约的 visibility.rules[level="L0"] 没有 conditions[*].metric ⇒ 无法验证"同档位"，也无法推导 nodeFields')
    } else {
      const missing = ctx.l0Metrics.filter((m) => !nodeFields.includes(m))
      if (missing.length) bad.push(`nodeFields 未覆盖 L0 规则读到的字段：${JSON.stringify(missing)}（现为 ${JSON.stringify(nodeFields)}）`)
    }
    if (cr.mustSatisfyRuleConditions !== true) {
      bad.push('l0 类必须声明 mustSatisfyRuleConditions: true —— 否则"同档位（score/useCount 都 > 阈值）"这条同形判据没有牙，status 这个自变量被稀释')
    }
  } else if (cls === 'l3') {
    if (ctx?.l3CondKind !== L3_CONDITION_KIND) {
      bad.push(`契约的 visibility.rules[level="L3"].condition.kind=${JSON.stringify(ctx?.l3CondKind)} 不等于 ${JSON.stringify(L3_CONDITION_KIND)} ⇒ 校验器的"命中载体字段=${L3_TRIGGER_FIELD}"推导失效（要么改契约要么改本校验器）`)
    }
    if (!nodeFields.includes(L3_TRIGGER_FIELD)) {
      bad.push(`nodeFields 未覆盖命中载体字段 ${JSON.stringify(L3_TRIGGER_FIELD)}（现为 ${JSON.stringify(nodeFields)}）`)
    }
  }
  return bad
}

/**
 * ★ O57：一类（l0 / l3）的配对检查 —— 每一条 negative-control 必须存在一条**同形**正向对照。
 * 同形判据（机器可判，逐字对应契约该类的 sameShape）：
 *   ① 同 kind ∧ 同 role 过滤；② 同 taskHint；③ nodeFields 逐值相等（status 除外）；
 *   ④ 负向那条的非 status 字段满足该 level 规则的全部 conditions（l0 的"同档位"）；
 *   ⑤ 正向那条 node.status === positiveStatus(active)；⑥ 两者 status 不同（唯一自变量）；
 *   ⑦ 正向那条 expect.<assert> === true；⑧ 负向那条 expect.<assert> === false。
 * @returns {{ok:boolean, detail:string}}
 */
function checkClassPairing(cr, all, vectorsRes, ctx) {
  const assertField = cr?.requirePairAsserts
  const stField = cr?.statusField
  const nodeFields = Array.isArray(cr?.nodeFields) ? cr.nodeFields : []
  const negatives = all.filter((x) => x?.kind === cr?.kind && x?.role === cr?.role)
  const positives = all.filter((x) => x?.kind === cr?.kind && x?.role === 'positive-control')
  const modeLabel = `mode=${JSON.stringify(cr?.mode)}`

  if (negatives.length === 0) {
    return {
      ok: false,
      detail: `★ 向量集里一条 kind=${JSON.stringify(cr?.kind)} role=${JSON.stringify(cr?.role)} 的向量都没有 ⇒ 这条配对规则被架空（空判也能"通过"）`,
    }
  }

  const source = vectorsRes?.source ?? '(内存注入)'
  const problems = []
  let paired = 0
  for (const n of negatives) {
    if (typeof n?.taskHint !== 'string') {
      problems.push(`${n?.id}（该向量缺 taskHint ⇒ 无法判定"同 taskHint"）`)
      continue
    }
    if (n?.expect?.[assertField] !== false) {
      problems.push(`${n?.id}（该 negative-control 没有 expect.${assertField}: false ⇒ 它不是"应当不可见"的负向向量，配对无从谈起）`)
      continue
    }
    // ④ l0 的"同档位"：负向那条的非 status 字段本来就在阈值内 ⇒ 不可见只能是 status 造成的
    if (cr?.mustSatisfyRuleConditions) {
      const rule = ctx?.visibilityRule ?? null
      const conds = Array.isArray(rule?.conditions) ? rule.conditions : []
      if (conds.length === 0) {
        problems.push(`${n?.id}（契约 ${cr.level} 规则没有 conditions ⇒ "同档位"无从判定）`)
        continue
      }
      const unmet = []
      for (const c of conds) {
        const got = cmpOp(c?.op, n?.node?.[c?.metric], c?.value)
        if (got === null) unmet.push(`${c?.metric} ${c?.op} ${JSON.stringify(c?.value)}（校验器不支持该算子）`)
        else if (got !== true) unmet.push(`${c?.metric}(${JSON.stringify(n?.node?.[c?.metric])}) 不满足 ${c?.op} ${JSON.stringify(c?.value)}`)
      }
      if (unmet.length) {
        problems.push(`${n?.id}（该负向向量不满足 ${cr.level} 规则的 conditions：${unmet.join('；')} ⇒ 它的不可见不是 status 造成的，不是"同形"）`)
        continue
      }
    }

    const nStatus = stField ? n?.node?.[stField] : undefined
    const cands = positives.filter((p) => p?.taskHint === n.taskHint)
    const rej = []
    let pair = null
    for (const p of cands) {
      const pStatus = stField ? p?.node?.[stField] : undefined
      if (pStatus !== cr?.positiveStatus) {
        rej.push(`${p?.id}：node.${stField}=${JSON.stringify(pStatus)} ≠ ${JSON.stringify(cr?.positiveStatus)}`)
        continue
      }
      if (stField && nStatus === pStatus) {
        rej.push(`${p?.id}：与负向向量同 status=${JSON.stringify(nStatus)}（status 不是唯一自变量）`)
        continue
      }
      const diff = nodeFields.filter((f) => !sameJson(p?.node?.[f], n?.node?.[f]))
      if (diff.length) {
        rej.push(`${p?.id}：字段 ${diff.join(' / ')} 与负向向量不同（非同形）`)
        continue
      }
      if (p?.expect?.[assertField] !== true) {
        rej.push(`${p?.id}：缺 expect.${assertField}: true（配对无牙）`)
        continue
      }
      pair = p
      break
    }
    if (!pair) {
      const tail = cands.length
        ? `有 ${cands.length} 条同 taskHint 的 positive-control 但都不满足同形：${rej.slice(0, 3).join('；')}`
        : '没有任何同 taskHint 的 positive-control'
      problems.push(`${n?.id}（${tail}）`)
    } else {
      paired += 1
    }
  }

  if (problems.length) {
    return {
      ok: false,
      detail: `★★ 配对缺失/无牙（${negatives.length - paired}/${negatives.length}）：这些 ${cr.requireFor} 向量没有满足同形定义（${modeLabel}：同 kind + 同 taskHint + 同 ${JSON.stringify(nodeFields)} + 只差 ${stField} 且正向 status=${JSON.stringify(cr.positiveStatus)} / expect.${assertField}: true${cr.mustSatisfyRuleConditions ? ' / 负向档位在阈值内' : ''}）的正向对照 ⇒ ${problems.join('；')}`,
    }
  }
  return {
    ok: true,
    detail: `配对完整：${negatives.length} 条 ${cr.requireFor} 各自有一条满足同形定义的正向对照（${modeLabel}；同 kind + 同 taskHint + 同 ${JSON.stringify(nodeFields)} + 只差 ${stField}，正向 status=${JSON.stringify(cr.positiveStatus)} 且带 expect.${assertField}: true）；向量来源 ${source}`,
  }
}

// ── 校验器主体 ──────────────────────────────────────────────────────────────

/**
 * 对一份契约做全部检查。
 * @param {object} c  契约对象
 * @param {{vectorsInput?:{data:object|null,error:string|null,source:string}|null}} [opts]
 *   ★ O55：向量集的数据（用于「负向向量必须配同形正向对照」这条检查）。
 *   `vectorsInput` 给了就用它（`--vectors` override / 自检的内存注入）；没给就从契约
 *   `vectors.pairing.vectorsFile` 读。★ 读不到 ⇒ 那条检查 **FAIL**，绝不静默跳过。
 * @returns {{checks: Array<{id:string,ok:boolean,why:string,detail:string}>}}
 */
function checkContract(c, opts = {}) {
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

  // ★ O52：不可见集必须与词汇表口径一致（漏 invalidated / suspicious ⇒ 假绿）
  //   ★ 只认【枚举】形式：散文提到这两个词不算声明（散文不可断言，同 kind:"ref" 的教训）。
  const declaredInvisible = (s) => invisible.includes(s)
  const missingExtraInvisible = REQUIRED_INVISIBLE_EXTRA.filter((s) => !declaredInvisible(s))
  const adoptedState = c?.states?.adoptedState
  const maybeInvisible = Array.isArray(values) && typeof adoptedState === 'string'
    ? values.filter((s) => s !== adoptedState)
    : []
  const undeclaredByVocab = maybeInvisible.filter((s) => !declaredInvisible(s))
  add(
    'visibility-invalidated-and-suspicious-invisible',
    missingExtraInvisible.length === 0 && undeclaredByVocab.length === 0,
    '★ O52：states.values 有 5 个状态，不可见集只列 pending / archived ⇒ 严格按 invisibleStates 判的实现会把 invalidated / suspicious 判成「可见」（假绿）。这两个态必须【枚举进 invisibleStates】（不可见集要与词汇表口径一致：凡 != adoptedState 的态都必须列出来）；★ 写成散文不算 —— 散文不可断言。',
    missingExtraInvisible.length || undeclaredByVocab.length
      ? `invisibleStates = ${JSON.stringify(invisible)}；未声明不可见的态：${JSON.stringify([...new Set([...missingExtraInvisible, ...undeclaredByVocab])])}`
      : `不可见集（含 O52 补全）= ${invisible.join(', ')}（= states.values 减去 ${JSON.stringify(adoptedState)}）`,
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

  // ★ O53：过门不只要 receipt.status=="passed"，回执必填字段（至少 proofLevel）必须【可读】
  const requireReadsField = (r, field) => {
    if (r?.path !== `receipt.${field}`) return false
    if (r?.op === 'in' && Array.isArray(r?.value)) return r.value.length > 0 && r.value.every((v) => v !== null && v !== undefined)
    if (r?.op === '!=' && r?.value === null) return true
    if (r?.op === '==' && r?.value !== null && r?.value !== undefined) return true
    return false
  }
  const readableReceipt =
    reqs.some((r) => requireReadsField(r, REQUIRED_RECEIPT_FIELD_FOR_ADOPTION)) ||
    (Array.isArray(pa?.requireFieldsComplete?.atLeast) &&
      pa.requireFieldsComplete.atLeast.includes(REQUIRED_RECEIPT_FIELD_FOR_ADOPTION))
  add(
    'transition-pending-active-requires-readable-receipt',
    readableReceipt,
    '★ O53：向量 transition-pending-to-active-receipt-missing-prooflevel 要求「passed 但缺 proofLevel ⇒ ok:false」，而 transitions.rules 字面只写 receipt.status=="passed" ⇒ 这条更严的判据只活在实现里。必须写进契约：过门不仅要求 status==passed，回执的必填字段（至少 proofLevel）必须可读（缺失 / null / 不在取值集内一律拒绝）。',
    pa
      ? readableReceipt
        ? `pending → active 已要求回执必填字段可读（至少 ${REQUIRED_RECEIPT_FIELD_FOR_ADOPTION}）；require = ${JSON.stringify(reqs)}`
        : `pending → active 的 require 没有要求 receipt.${REQUIRED_RECEIPT_FIELD_FOR_ADOPTION} 可读（现为 ${JSON.stringify(reqs)}；requireFieldsComplete.atLeast = ${JSON.stringify(pa?.requireFieldsComplete?.atLeast)}）`
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

  // ★ O51：状态"写回哪里 / 怎么读回"必须在契约里声明
  const stDecl = c?.implementations?.state
  const wb = stDecl?.writeback
  const rb = stDecl?.readback
  const wbMode = wb?.mode
  const wbModeOk = typeof wbMode === 'string' && ['in-place', 'sidecar'].includes(wbMode)
  const wbArgOk = typeof wb?.arg === 'string' && wb.arg.trim() !== ''
  const rbFieldOk = rb?.field === STATE_READBACK_FIELD
  const rbTargetOk = typeof rb?.file === 'string' && rb.file.trim() !== ''
  add(
    'impl-state-writeback-declared',
    wbModeOk && wbArgOk && rbFieldOk && rbTargetOk,
    '★ O51：向量的 expect.statusUnchanged 依赖「状态写回哪里、runner 怎么读回」。这只活在实现的私下约定里 ⇒ Go 侧接上时若不照做，该判据会【静默失真】（「读不到文件」与「状态未变」不可区分）。契约必须显式声明写回模式（二者择一写死）+ 读回字段/文件。',
    wbModeOk && wbArgOk && rbFieldOk && rbTargetOk
      ? `写回：mode=${JSON.stringify(wbMode)} arg=${JSON.stringify(wb.arg)}；读回：field=${JSON.stringify(rb.field)} file=${JSON.stringify(rb.file)}`
      : `写回 mode=${JSON.stringify(wbMode)}（需 in-place|sidecar）／arg=${JSON.stringify(wb?.arg)}；读回 field=${JSON.stringify(rb?.field)}（需 "${STATE_READBACK_FIELD}"）／file=${JSON.stringify(rb?.file)}`,
  )

  // ★ O55：写回**痕迹**机制也必须在契约里声明（与 O51 同族：*信号*本身也不许靠私下约定）
  const ev = wb?.evidence
  const evKindOk = typeof ev?.kind === 'string' && ev.kind === EVIDENCE_KIND
  const evScopeOk = typeof ev?.scope === 'string' && ev.scope === EVIDENCE_SCOPE
  const evAlgoOk = typeof ev?.algorithm === 'string' && ev.algorithm.trim() !== ''
  const evFieldOk = typeof ev?.field === 'string' && ev.field.trim() !== ''
  const evCompareOk = typeof ev?.compare === 'string' && ev.compare.trim() !== ''
  const evWhyOk = typeof ev?.why === 'string' && ev.why.trim() !== ''
  const evidenceOk = evKindOk && evScopeOk && evAlgoOk && evFieldOk && evCompareOk && evWhyOk
  add(
    'impl-writeback-evidence-declared',
    evidenceOk,
    '★ O55（§35.4）：4 条负向迁移向量都期望 statusUnchanged:true，而一个「从不写回」的实现【同样满足】（「读不到」被当成「没变」）⇒ statusUnchanged 单独**没有分辨力**。⇒ 必须另有一个独立的「到底写没写」信号（写回痕迹：transition 前后对某个文件取摘要，摘要变了 = 确实写了），且这个信号本身也要写进契约 —— 否则它又会变成实现与 runner 的私下约定（O51 的同一个洞，只是换了一层）。scope 必须钉死在 declared-writeback-file（= runner 按契约读回的那份）⇒ 痕迹只能来自那一份文件，别处的写入不算数。',
    evidenceOk
      ? `痕迹：kind=${JSON.stringify(ev.kind)} scope=${JSON.stringify(ev.scope)} algorithm=${JSON.stringify(ev.algorithm)} field=${JSON.stringify(ev.field)}`
      : `writeback.evidence = ${JSON.stringify(ev)}（需 kind="${EVIDENCE_KIND}" + scope="${EVIDENCE_SCOPE}" + 非空 algorithm / field / compare / why）`,
  )

  // ══ F. ★ O55：向量集【自身】的完备性（contract.json → vectors.pairing） ═════
  //    ★ 为什么放在契约校验器而不是 runner：这条规则是 contract.json 自己声明的
  //      （vectors.pairing），由契约的校验器守；且它是「向量集够不够分辨」的**静态**检查，
  //      与跑哪个实现无关 —— runner 的结果语义是 per-vector 的 PASS/FAIL/NEEDS-EVIDENCE，
  //      不再混入第四种「向量集不完整」。见 contract.json → vectors.pairing.whichCheck。

  const pairing = c?.vectors?.pairing
  const requireFor = pairing?.requireFor
  const pairMode = pairing?.mode
  const pairVectorsFile = pairing?.vectorsFile
  const pairAssert = pairing?.requirePairAsserts
  const requireForOk = typeof requireFor === 'string' && /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/i.test(requireFor)
  const pairModeOk = typeof pairMode === 'string' && PAIR_MODES.includes(pairMode)
  const pairFileOk = typeof pairVectorsFile === 'string' && pairVectorsFile.trim() !== ''
  const pairAssertOk = typeof pairAssert === 'string' && pairAssert.trim() !== ''
  const pairingWhyOk = typeof pairing?.why === 'string' && pairing.why.trim() !== ''
  const pairingRuleOk = requireForOk && pairModeOk && pairFileOk && pairAssertOk && pairingWhyOk
  add(
    'vectors-pairing-rule-declared',
    pairingRuleOk,
    '★ O55：负向向量「缺同形正向对照 ⇒ 对『从不写回』假绿」这条风险，必须是一条**集中声明、机器可读**的规则（否则「删掉那条正向对照」这件事没有任何东西会响）。requireFor = 哪些向量被要求配对（"<kind>.<role>"）；mode = 怎么算"同形"；vectorsFile = 检查哪一份向量集；requirePairAsserts = 那条正向对照必须带哪个断言才算"有牙"。',
    pairingRuleOk
      ? `配对规则：requireFor=${JSON.stringify(requireFor)} mode=${JSON.stringify(pairMode)} vectorsFile=${JSON.stringify(pairVectorsFile)} requirePairAsserts=${JSON.stringify(pairAssert)}`
      : `vectors.pairing = ${JSON.stringify(pairing)}（需 requireFor="kind.role" + mode∈${JSON.stringify(PAIR_MODES)} + 非空 vectorsFile / requirePairAsserts / why）`,
  )

  // 向量数据来源：--vectors override / 自检注入优先；否则按契约声明读盘。读不到 ⇒ 这条 FAIL。
  const vres =
    opts.vectorsInput ?? loadVectorsFile(pairVectorsFile)

  const targetsOf = (x) => {
    const t = x?.transition?.to
    return Array.isArray(t) ? t : t === undefined || t === null ? [] : [t]
  }
  const [reqKind, reqRole] = String(requireFor ?? '').split('.')
  let pairOk = false
  let pairDetail = ''
  if (!pairingRuleOk) {
    pairDetail = `★ 配对规则未声明/不合法（requireFor=${JSON.stringify(requireFor)} mode=${JSON.stringify(pairMode)}）⇒ 无法验证「负向向量必须配同形正向对照」`
  } else if (vres.error) {
    pairDetail = `★ 配对检查的向量集不可读：${vres.error}`
  } else if (!Array.isArray(vres.data?.cases)) {
    pairDetail = `★ 向量集里没有 cases 数组（${vres.source ?? '(来源未知)'}）⇒ 无法验证配对`
  } else {
    const all = vres.data.cases
    const required = all.filter((x) => x?.kind === reqKind && x?.role === reqRole)
    const positives = all.filter((x) => x?.kind === reqKind && x?.role === 'positive-control')
    const missing = []
    const toothless = []
    for (const n of required) {
      const tos = targetsOf(n)
      const pair = positives.find((p) => targetsOf(p).some((t) => tos.includes(t)))
      if (!pair) {
        missing.push(`${n?.id ?? '(无 id)'}（transition.to=${JSON.stringify(tos.length === 1 ? tos[0] : tos)}）`)
      } else if (pair?.expect?.[pairAssert] !== true) {
        toothless.push(`${n?.id ?? '(无 id)'} ↔ ${pair?.id ?? '(无 id)'}（该正向对照没有 expect.${pairAssert}: true）`)
      }
    }
    if (required.length === 0) {
      pairDetail = `★ 向量集里一条 kind=${reqKind} role=${reqRole} 的向量都没有 ⇒ 这条配对规则被架空（空判也能"通过"）`
    } else if (missing.length) {
      pairDetail = `★★ 配对缺失（${missing.length}/${required.length}）：这些 ${requireFor} 向量没有【同 transition.to】的 positive-control 对照 ⇒ ${missing.join('；')}`
    } else if (toothless.length) {
      pairDetail = `★★ 配对无牙（${toothless.length}/${required.length}）：有同 to 的正向对照，但它没带 expect.${pairAssert}: true ⇒ 该配对抓不到「从不写回」：${toothless.join('；')}`
    } else {
      pairOk = true
      pairDetail = `配对完整：${required.length} 条 ${requireFor} 各自有一条同 transition.to 的 positive-control（mode=${pairMode}），且都带 expect.${pairAssert}: true；向量来源 ${vres.source ?? '(内存注入)'}`
    }
  }
  add(
    'vectors-negative-control-has-same-target-positive-pair',
    pairOk,
    '★★ O55 的核心（§35.4）：4 条负向迁移向量都期望 statusUnchanged:true ⇒ 一个「从不写回」的实现同样满足；这套判据**只**靠那条正向对照 transition-pending-to-active-receipt-passed 才能分辨这类错误 ⇒ 【删掉它，这类错误就全绿通过】。⇒ 每条 transition 类的 negative-control 向量都必须存在一条【同 transition.to】且**带 fileChanged 断言**的 positive-control 向量；缺一条即不合格、非零退出（不许静默全绿）。',
    pairDetail,
  )

  // ══ G. ★★ O57：配对规则**按类**（transition / L0 / L3） ═══════════════════
  //    问题（spec §36.5-3 逐字）：「配对规则只覆盖 transition 类 —— L0/L3 的负向向量也有
  //    正向对照，但没有机器检查。」
  //    失败形状（与 §36.4 已证的 transition 那侧同构）：一个「全封」的实现
  //    （visible 永远返回 false）⇒ 4 条 L0/L3 negative-control 全部 PASS（它们期望
  //    visible:false）⇒ 只有同类的那条正向对照能抓到它 ⇒ 若那条正向被删/被弱化
  //    ⇒ **静默全绿**。⇒ 所以「每条该类负向向量必须有一条同形正向对照」也必须是机器检查的规则。

  const classesDecl = pairing?.classes
  const classRules = Array.isArray(classesDecl?.rules) ? classesDecl.rules : []
  const ruleOfLevel = (lv) => vRules.find((r) => r?.level === lv)
  const l0Rule = ruleOfLevel('L0')
  const l3Rule = ruleOfLevel('L3')
  const l0Metrics = (Array.isArray(l0Rule?.conditions) ? l0Rule.conditions : [])
    .map((x) => x?.metric)
    .filter((m) => typeof m === 'string' && m.trim() !== '')
  const l3CondKind = l3Rule?.condition?.kind

  const classProblems = []
  const presentClasses = []
  for (const cls of REQUIRED_PAIR_CLASSES) {
    const cr = classRules.find((x) => x?.class === cls)
    if (!cr) {
      classProblems.push(`缺 ${cls} 类的配对规则（只覆盖 transition ⇒ L0/L3 是否有同形正向对照没人管）`)
      continue
    }
    presentClasses.push(cls)
    classProblems.push(
      ...validatePairClassRule(cr, {
        legacy: { requireFor, mode: pairMode, requirePairAsserts: pairAssert },
        l0Metrics,
        l3CondKind,
      }).map((p) => `${cls}: ${p}`),
    )
  }
  const strayClasses = classRules.map((x) => x?.class).filter((x) => !REQUIRED_PAIR_CLASSES.includes(x))
  if (strayClasses.length) classProblems.push(`出现未支持的 class：${JSON.stringify(strayClasses)}`)
  add(
    'vectors-pairing-classes-declared',
    classProblems.length === 0,
    '★ O57：配对规则必须**按类**声明且"同形"必须机器可判 —— 每类要有 requireFor(kind.role) / mode / requirePairAsserts(牙) / sameShape(同形定义) / why，且 nodeFields 必须覆盖该 level 的可见性规则真正读到的字段（否则"同形"会被悄悄放宽）。transition 那一档还必须与顶层 O55 声明的值逐字一致（同一档规则不许两处各写一遍而漂移）。',
    classProblems.length
      ? `vectors.pairing.classes 不合格：${classProblems.join('；')}`
      : `按类配对规则齐：${presentClasses.join(' / ')}；nodeFields 覆盖性已核对（L0 需含 ${JSON.stringify(l0Metrics)}、L3 需含 ${JSON.stringify(L3_TRIGGER_FIELD)}）`,
  )

  for (const cls of ['l0', 'l3']) {
    const cr = classRules.find((x) => x?.class === cls)
    const id = `vectors-pairing-${cls}-negative-controls-have-same-shape-positive`
    const level = CLASS_LEVEL[cls]
    let res
    if (!cr) {
      res = {
        ok: false,
        detail: `★ 契约没声明 ${cls} 类的配对规则 ⇒ 无法验证「每条 ${cls}.negative-control 都有同形正向对照」（**不静默跳过**：跳过就等于这条检查不存在）`,
      }
    } else if (vres.error) {
      res = { ok: false, detail: `★ 配对检查的向量集不可读：${vres.error}` }
    } else if (!Array.isArray(vres.data?.cases)) {
      res = { ok: false, detail: `★ 向量集里没有 cases 数组（${vres.source ?? '(来源未知)'}）⇒ 无法验证配对` }
    } else {
      res = checkClassPairing(cr, vres.data.cases, vres, { visibilityRule: ruleOfLevel(level) })
    }
    add(
      id,
      res.ok,
      cls === 'l0'
        ? '★★ O57（§36.5-3）：L0 的 2 条 negative-control（pending / archived，score 0.9 ∧ useCount 20 都达标）期望 visible:false ⇒ 一个「visible 恒 false」的**全封**实现【同样满足】⇒ 这套负向判据只靠那条正向对照 l0-active-highscore-visible 才能分辨「门没漏」与「全封」⇒ 删掉或弱化它 = 静默全绿。⇒ 每条 l0 类负向向量都必须存在一条**同 kind + 同 taskHint + 同 score/useCount（且都在阈值内）+ 只差 status** 且 node.status=active / expect.visible:true 的正向对照；缺一条即不合格、非零退出。'
        : '★★ O57（§36.5-3）：L3 的 4 条 negative-control（pending / archived / invalidated / suspicious，triggers 与 taskHint 逐值相同）期望 visible:false ⇒ 全封实现同样全过 ⇒ 只靠正向对照 l3-active-trigger-match-visible 分辨 ⇒ 删掉或弱化它 = 静默全绿；而 L3 正是本契约最不能少的一条路径（§4：现状 skill_tree.go:1054+ 的 L3 分支完全不检查 Status）。⇒ 每条 l3 类负向向量都必须存在一条**同 kind + 同 taskHint + 同 triggers + 只差 status** 且 node.status=active / expect.visible:true 的正向对照；缺一条即不合格、非零退出。',
      res.detail,
    )
  }

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
  {
    name: '★ O51：契约没声明状态写回约定（runner 只能靠私下约定读回）',
    why: '状态写到哪里 / 怎么读回没进契约 ⇒ statusUnchanged 判据会静默失真（读不到文件与"状态未变"不可区分）。',
    expect: ['impl-state-writeback-declared'],
    mutate: (c) => {
      delete c.implementations.state
    },
  },
  {
    name: '★ O52：不可见集漏了 invalidated / suspicious',
    why: '只列 pending/archived ⇒ 严格按 invisibleStates 判的实现会把这两态判成"可见"（假绿）。',
    expect: ['visibility-invalidated-and-suspicious-invisible'],
    mutate: (c) => {
      c.visibility.invisibleStates = ['pending', 'archived']
    },
  },
  {
    name: '★ O53：迁移规则丢掉「回执必填字段（至少 proofLevel）必须可读」',
    why: '退回原字面（只要求 receipt.status=="passed"）⇒ passed 但缺 proofLevel 的回执会被放行。',
    expect: ['transition-pending-active-requires-readable-receipt'],
    mutate: (c) => {
      const r = c.transitions.rules.find((x) => x.from === 'pending' && x.to === 'active')
      r.require = r.require.filter((q) => q.path !== 'receipt.proofLevel')
      delete r.requireFieldsComplete
    },
  },
  {
    name: '★ O55：契约没声明写回痕迹机制（只剩 statusUnchanged，对「从不写回」没分辨力）',
    why: '没有痕迹信号 ⇒ 「读不到」与「没变」不可区分 ⇒ 4 条负向迁移向量的 statusUnchanged:true 会被一个从不写回的实现「满足」。',
    expect: ['impl-writeback-evidence-declared'],
    mutate: (c) => {
      delete c.implementations.state.writeback.evidence
    },
  },
  {
    name: '★ O55：契约没声明向量配对规则（负向向量是否配了正向对照，没人管）',
    why: '缺 vectors.pairing ⇒ 「删掉那条正向对照」这件事没有任何东西会响。★ 配对检查也必须跟着 FAIL（不许因为"规则没声明"就静默跳过）。',
    expect: ['vectors-pairing-rule-declared', 'vectors-negative-control-has-same-target-positive-pair'],
    mutate: (c) => {
      delete c.vectors.pairing
    },
  },
  {
    name: '★★ O55：把正负对照的那条正向向量删掉（transition-pending-to-active-receipt-passed）',
    why: '§35.4 逐字：删掉它，这类错误就会全绿通过。⇒ 配对检查必须报「配对缺失」并非零退出。',
    expect: ['vectors-negative-control-has-same-target-positive-pair'],
    mutate: () => {},
    mutateVectors: (v) => {
      v.cases = v.cases.filter((x) => x.id !== 'transition-pending-to-active-receipt-passed')
    },
  },
  {
    name: '★ O55：正向对照还在，但把它的 fileChanged 断言删掉（配对变成形式）',
    why: '有同 to 的正向向量却没带 fileChanged:true ⇒ 配对抓不到「从不写回」= 有对照但没牙。',
    expect: ['vectors-negative-control-has-same-target-positive-pair'],
    mutate: () => {},
    mutateVectors: (v) => {
      const p = v.cases.find((x) => x.id === 'transition-pending-to-active-receipt-passed')
      delete p.expect.fileChanged
    },
  },
  {
    name: '★★ O57：删掉 L0 的那条正向对照（l0-active-highscore-visible）',
    why: '§36.5-3：L0 的负向向量（pending / archived，都期望 visible:false）在「全封」实现下全过 ⇒ 删掉正向对照就只剩静默全绿。⇒ L0 配对检查必须报「配对缺失」并非零退出。',
    expect: ['vectors-pairing-l0-negative-controls-have-same-shape-positive'],
    mutate: () => {},
    mutateVectors: (v) => {
      v.cases = v.cases.filter((x) => x.id !== 'l0-active-highscore-visible')
    },
  },
  {
    name: '★★ O57：删掉 L3 的那条正向对照（l3-active-trigger-match-visible）',
    why: '§36.5-3：L3 有 4 条负向向量（全期望 visible:false）⇒ 删掉正向对照后「全封」实现 14/14 PASS。⇒ L3 配对检查必须报「配对缺失」并非零退出。',
    expect: ['vectors-pairing-l3-negative-controls-have-same-shape-positive'],
    mutate: () => {},
    mutateVectors: (v) => {
      v.cases = v.cases.filter((x) => x.id !== 'l3-active-trigger-match-visible')
    },
  },
  {
    name: '★ O57：L0 正向对照还在，但把它的 expect.visible 改成 false（配对无牙）',
    why: '正向对照不再断言"应当可见" ⇒ 它抓不到「全封」= 有对照但没牙。',
    expect: ['vectors-pairing-l0-negative-controls-have-same-shape-positive'],
    mutate: () => {},
    mutateVectors: (v) => {
      const p = v.cases.find((x) => x.id === 'l0-active-highscore-visible')
      p.expect.visible = false
    },
  },
  {
    name: '★ O57：把 L0 负向向量的档位改到阈值外（score 0.9 → 0.5）',
    why: '负向那条的不可见不再由 status 造成 ⇒ 它既不与 L0 正向对照同形、也不满足该 level 的 conditions ⇒ 不能证明"只差 status" ⇒ 必须报非同形/缺配对（不许静默当作配对成立）。',
    expect: ['vectors-pairing-l0-negative-controls-have-same-shape-positive'],
    mutate: () => {},
    mutateVectors: (v) => {
      const n = v.cases.find((x) => x.id === 'l0-pending-highscore-hidden')
      n.node.score = 0.5
    },
  },
  {
    name: '★ O57：契约没声明按类配对（删掉 vectors.pairing.classes）',
    why: '按类规则不存在 ⇒ L0/L3 的配对是否有机器检查这件事本身就没人守。★ 三条按类检查必须**跟着 FAIL**（不许因为"规则没声明"就静默跳过）。',
    expect: [
      'vectors-pairing-classes-declared',
      'vectors-pairing-l0-negative-controls-have-same-shape-positive',
      'vectors-pairing-l3-negative-controls-have-same-shape-positive',
    ],
    mutate: (c) => {
      delete c.vectors.pairing.classes
    },
  },
]

// ── 输出 ────────────────────────────────────────────────────────────────────

const clone = (o) => JSON.parse(JSON.stringify(o))

/**
 * ★ O55：从契约声明的位置读向量集。读不到 ⇒ 返回 error（调用方把那条检查判 FAIL，
 * **绝不静默跳过** —— 跳过就等于"检查不存在"，而这条检查防的正是"静默全绿"）。
 * @returns {{data:object|null, error:string|null, source:string}}
 */
function loadVectorsFile(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') {
    return { data: null, error: '契约没有声明 vectors.pairing.vectorsFile', source: '(未声明)' }
  }
  const file = path.isAbsolute(rel) ? rel : path.resolve(ROOT, rel)
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), error: null, source: file }
  } catch (e) {
    return { data: null, error: `${file}（${e.message}）`, source: file }
  }
}

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
  // ★ O55：配对检查要读向量集 —— 自检里也用真向量（阳性对照），坏契约里可以改向量（mutateVectors）
  const baseVectors = loadVectorsFile(base?.vectors?.pairing?.vectorsFile)
  if (baseVectors.error) {
    console.log(`  ❌ 真契约声明的向量集读不到：${baseVectors.error}`)
    console.log('\n自检结果：❌ 阳性对照未通过（先修契约或修校验器）')
    process.exit(1)
  }
  console.log(`向量集：${baseVectors.source}（${Array.isArray(baseVectors.data?.cases) ? baseVectors.data.cases.length : '?'} 条）`)
  console.log('')
  const good = checkContract(base, { vectorsInput: baseVectors }).checks
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
    // ★ O55：允许坏契约同时改【向量集】（例如"把正负对照的那条正向向量删掉"）
    const vres = cs.mutateVectors ? { ...baseVectors, data: clone(baseVectors.data) } : baseVectors
    if (cs.mutateVectors) cs.mutateVectors(vres.data)
    const checks = checkContract(c, { vectorsInput: vres }).checks
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
  const src = fs.readFileSync(new URL(import.meta.url)).toString('utf8').split('\n')
  const end = src.findIndex((l, idx) => idx > 0 && l.trim().startsWith('*/'))
  console.log(src.slice(1, end > 0 ? end : 34).join('\n'))
  process.exit(0)
}

if (argv.includes('--selftest')) {
  runSelftest()
}

// ★ O55：`--vectors` 优先摘掉（否则它的取值会被下面的"位置参数"逻辑当成契约路径）。
let vectorsArg = null
const positional = []
for (let k = 0; k < argv.length; k += 1) {
  const a = argv[k]
  if (a === '--vectors') {
    vectorsArg = argv[++k] ?? null
    continue
  }
  if (a.startsWith('--vectors=')) {
    vectorsArg = a.slice('--vectors='.length)
    continue
  }
  if (a === '--contract') {
    positional.push(argv[++k] ?? '')
    continue
  }
  if (a.startsWith('--contract=')) {
    positional.push(a.slice('--contract='.length))
    continue
  }
  positional.push(a)
}

const contractArg = positional.find((a) => a && !a.startsWith('--'))
const contractFile = contractArg ? path.resolve(contractArg) : DEFAULT_CONTRACT

const rawBytes = fs.readFileSync(contractFile)
const contract = readContract(contractFile)
// ★ O55：--vectors 给了就用它（例如"把正向对照删掉的临时副本"）；没给则按契约声明读。
const vectorsInput = vectorsArg
  ? loadVectorsFile(path.resolve(vectorsArg))
  : loadVectorsFile(contract?.vectors?.pairing?.vectorsFile)
const { checks } = checkContract(contract, { vectorsInput })
const failed = checks.filter((x) => !x.ok)
const O55_ADDED = [
  'impl-writeback-evidence-declared',
  'vectors-pairing-rule-declared',
  'vectors-negative-control-has-same-target-positive-pair',
]
const nO55 = checks.filter((x) => O55_ADDED.includes(x.id)).length
// ★ O57：把配对检查从 transition 类扩到 L0/L3 可见性类（三条新检查）
const O57_ADDED = [
  'vectors-pairing-classes-declared',
  'vectors-pairing-l0-negative-controls-have-same-shape-positive',
  'vectors-pairing-l3-negative-controls-have-same-shape-positive',
]
const nO57 = checks.filter((x) => O57_ADDED.includes(x.id)).length

console.log('门契约校验 · dsh-gate-contract/v1')
console.log('═'.repeat(72))
console.log(`契约文件：${contractFile}`)
console.log(`JSON 解析：✅ 成功（本脚本用 node 的 JSON.parse 读了一遍：${rawBytes.length} 字节，顶层键 ${Object.keys(contract).length} 个：${Object.keys(contract).join(', ')}）`)
console.log(`向量集：${vectorsArg ? '（--vectors 指定）' : '（按契约 vectors.pairing.vectorsFile）'}${vectorsInput.source ?? '(未声明)'}${vectorsInput.error ? ` ❌ ${vectorsInput.error}` : ''}`)
console.log(`目标：契约必须**自洽** —— 词汇表单一来源 / 回执不撒谎 / 迁移有门 / 两条注入路径都要求 active / 实现协议可断言 / ★ 写回痕迹与向量配对都已被声明(O55) / ★★ 配对规则按类覆盖 transition + L0 + L3(O57)`)
console.log(`每项都打印「防的是什么」；任一项不满足 ⇒ 非零退出。
`)
console.log(`共 ${checks.length} 项检查：★ 其中 O55 新增 ${nO55} 项（${O55_ADDED.join(' / ')}）；★ O57 新增 ${nO57} 项（${O57_ADDED.join(' / ')}）⇒ 原有检查一项未删（O57 前 25 项 → 现 ${checks.length} 项）。`)
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
