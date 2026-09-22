#!/usr/bin/env node
/**
 * gate-impl-reference.mjs —— 「门」的**参考实现**（按 evals/gate/contract.json）
 *
 * ★ 这个文件就是**将来 Go 侧要实现的同一形状**。契约
 *   (`evals/gate/contract.json` → `implementations.commands`) 只认两条子命令 + stdout 形状：
 *
 *     <impl> visible    --node <jsonfile> [--task-hint <text>]                     → {"visible": bool}
 *     <impl> transition --node <jsonfile> --to <status> [--receipt <jsonfile>]     → {"ok":bool,"status":str,"reason":str}
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么要有这份实现
 *
 * 契约自洽 ≠ 门被实现（`docs/gate-contract.md` §8.1/§8.4 如实记着这一点）。
 * 光有 `contract.json` + 校验器，只能证明"设计不装饰"；要证明"门被尊重"，
 * 必须有**一份能被向量打分的实现**。这个文件就是那份实现（参考版，正确的）。
 * 它的孪生兄弟 `gate-impl-broken.mjs` 故意坏掉一处（L3 分支不检查 status），
 * 用来证明 `evals/gate/vectors.json` 这 14 条**有分辨力**（不是一批全绿的装饰向量）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 策略不写死：本实现【不硬编码】任何阈值/状态字面量，全部从契约读取
 *
 * 这直接对应 `ai-base/AGENTS.md:196-204` 禁止行为第 4 条（不硬编码策略）与
 * `docs/gate-contract.md` §0：L0 的 `score > 0.7`、`useCount > 10`、L0/L3 的
 * `requiresStatus`、`pending → active` 要求 `receipt.status == "passed"`、
 * 以及拒绝时的 `reasonTemplate`，**全部**来自 `contract.visibility.rules` /
 * `contract.transitions.rules` / `contract.receipt`。改策略 = 改 JSON。
 * ⚠️ 代价（如实说）：本实现**依赖向量所覆盖的那部分契约形状**
 *   （见文件末尾 §未覆盖），契约里没声明的迁移一律**拒绝**而不是放过。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 状态写回约定（★ O51 后：**从契约读**，不再是自己定的私下约定）
 *
 * 写回位置与读回方式**由契约声明**：`evals/gate/contract.json` →
 * `implementations.state`（`writeback.mode = "in-place"` / `writeback.arg = "--node"` /
 * `readback.field = "status"`）。本实现**照契约执行**：
 *
 * - `--node <file>`：**必填**。读节点（含 `status`）。
 * - 状态写回位置：契约写死 **`in-place`** ⇒ 写回 `--node` 指向的**同一个文件**（原地回写）；
 *   契约若声明别的模式而本实现不支持 ⇒ **exit 2**（拒绝猜，不许另开私下约定）。
 * - `--state <file>`（契约 `writeback.overrideArg`）：旁挂 override；给了且文件已存在
 *   ⇒ 以 state 文件里的 status 为"当前状态"（否则用 `--node` 的）。
 * - 理由：照抄 `builder.go:491 InvalidateNodes()` 的形状 ——「读节点 → 改字段 → 提交」，
 *   而不是另开一条旁路；runner 也按契约读回同一个文件的 `status` 来判 `statusUnchanged`。
 * - `ok:true` 时额外把**回执**写回（对应不变量 `receipt-is-recorded-on-adoption`：
 *   过了门却读不到证到哪一级 = 没有回执位）。
 *
 * ★ 「二者择一、写死」的意义：Go 侧实现必须同款，否则 `statusUnchanged` 判据静默失真
 *   （「读不到文件」与「状态未变」不可区分）。见 `docs/gate-contract.md` §5.1。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 退出码（★ 失败绝不静默）
 *   0 = 给出了判决（`ok:true` 或「按规则拒绝」的 `ok:false`，两者都是有效判决）
 *   2 = 用法错/输入不可读（缺参数、文件不存在、JSON 非法、`--to` 不在词汇表、未知子命令）
 *       ⇒ stdout 单行 `{"error":"..."}`，stderr 也写一份原因。
 * 也就是说：**「被规则拒绝」不是错误**（exit 0），**「答不上来」才是**（exit 2）。
 *
 * 依赖：无（只读契约与输入，写状态文件）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
export const DEFAULT_CONTRACT = path.join(ROOT, 'evals', 'gate', 'contract.json')

/** ★ O53：过门时回执里必须可读的必填字段（策略在契约里，不在实现里）。 */
function receiptFieldEnum(contract, field) {
  const en = contract?.receipt?.schema?.properties?.[field]?.enum
  const list = Array.isArray(en) ? en : []
  return list.filter((v) => v !== null && v !== undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// 用法错（exit 2）用的错误类型；与「按规则拒绝」严格分开
// ─────────────────────────────────────────────────────────────────────────────
class UsageError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// 契约加载 / 读取小工具
// ─────────────────────────────────────────────────────────────────────────────

export function loadContract(file = DEFAULT_CONTRACT) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new UsageError(`契约不可读：${file}（${e.message}）`)
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new UsageError(`契约不是合法 JSON：${file}（${e.message}）`)
  }
}

function readJson(file, what) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new UsageError(`${what}不可读：${file}（${e.message}）`)
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new UsageError(`${what}不是合法 JSON：${file}（${e.message}）`)
  }
}

function visibilityRule(contract, level) {
  const rule = (contract?.visibility?.rules ?? []).find((r) => r?.level === level)
  if (!rule) throw new UsageError(`契约里没有 visibility.rules[level="${level}"] ⇒ 无法判定`)
  return rule
}

function transitionRule(contract, from, to) {
  const rules = contract?.transitions?.rules ?? []
  return (
    rules.find((r) => {
      const tos = Array.isArray(r?.to) ? r.to : [r?.to]
      return (r?.from === from || r?.from === '*') && tos.includes(to)
    }) ?? null
  )
}

/** 契约里的比较算子（策略的一部分，不许在实现里另立一套）。 */
function compare(op, actual, expected) {
  switch (op) {
    case '>':
      return actual > expected
    case '>=':
      return actual >= expected
    case '<':
      return actual < expected
    case '<=':
      return actual <= expected
    case '==':
      return actual === expected
    case '!=':
      return actual !== expected
    case 'in':
      // ★ O53 用到的算子：`receipt.proofLevel in ["L0","L1"]` ⇒ 缺字段(undefined)/null 一律 false
      return Array.isArray(expected) && expected.includes(actual)
    default:
      throw new UsageError(`契约里出现未支持的算子 "${op}"`)
  }
}

function statusOf(node) {
  const s = node?.status
  return typeof s === 'string' ? s : null
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 注入可见性（契约 visibility.rules；★ L0 与 L3 两条路径都在契约里）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 触发词命中 taskHint。
 * ⚠️ 契约只声明了 `{"kind":"triggers-hit-taskHint"}`（含 kind 未给算法）⇒ 本实现取
 *    **大小写不敏感的子串包含**，且空 trigger / 空 taskHint 一律不算命中。
 *    这是**实现选择**，已写进报告「不确定/未验证」；若要换算法，应当先改契约。
 */
export function triggersHit(triggers, taskHint) {
  if (!Array.isArray(triggers)) return false
  if (typeof taskHint !== 'string' || taskHint.trim() === '') return false
  const hint = taskHint.toLowerCase()
  return triggers.some(
    (t) => typeof t === 'string' && t.trim() !== '' && hint.includes(t.trim().toLowerCase()),
  )
}

/**
 * 按契约判「L0 路径是否可见」。
 * ★ 契约 `visibility.rules[level=L0]` 里有 `requiresStatus: "active"` —— 这是**门的一半**：
 *   没有它，`status=pending` 但 score/use 达标的条目照样被注入。
 */
export function l0Visible(contract, node) {
  const rule = visibilityRule(contract, 'L0')
  if (rule.requiresStatus && statusOf(node) !== rule.requiresStatus) return false
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : []
  if (conditions.length === 0) return false
  return conditions.every((c) => compare(c.op, node?.[c.metric], c.value))
}

/**
 * 按契约判「L3 路径是否可见」。
 * ★★ 契约 `visibility.rules[level=L3].requiresStatus === "active"` —— 本契约**最不能少**的一条
 *    （现状 `skill_tree.go:1054+` 的 L3 分支完全不检查 Status ⇒ 只改导入处 = 装饰门）。
 *    若有人把契约里这条 `requiresStatus` 删掉（= `gate-impl-broken.mjs` 干的事），
 *    本函数会**如实地**跟着放行 —— 这就是"策略走接口"的代价与价值：
 *    坏策略一眼可见，而不是散落在某段 if 里。
 */
export function l3Visible(contract, node, taskHint) {
  const rule = visibilityRule(contract, 'L3')
  if (rule.requiresStatus && statusOf(node) !== rule.requiresStatus) return false
  return triggersHit(node?.triggers, taskHint)
}

/** 逐条给出判决 + 命中的是哪条路径（诊断用，不进 stdout）。 */
export function visibleDecision(contract, node, taskHint) {
  const st = statusOf(node)
  if (st === null) throw new UsageError(`节点缺 status 字段（或不是字符串）⇒ 无法判定可见性`)
  if (l3Visible(contract, node, taskHint)) return { visible: true, path: 'L3', status: st }
  if (l0Visible(contract, node)) return { visible: true, path: 'L0', status: st }
  return { visible: false, path: 'no-path', status: st }
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 状态迁移（契约 transitions.rules；★ `pending → active` 就是「门」本身）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 回执完整性：回执必填字段必须**可读**（present 且非 undefined）。
 * ★ O53：必填清单 = 契约 `receipt.schema.required` ∪ 该迁移规则声明的
 *   `requireFieldsComplete.atLeast`（本契约是 `["proofLevel"]`）—— 现在**全部从契约读**，
 *   实现里不再有 `['L0','L1']` 这类策略字面量。
 *   向量 `transition-pending-to-active-receipt-missing-prooflevel` 就是照这条设计的。
 */
function receiptCompleteness(contract, rule, receipt) {
  const schemaRequired = contract?.receipt?.schema?.required ?? []
  const atLeast = Array.isArray(rule?.requireFieldsComplete?.atLeast) ? rule.requireFieldsComplete.atLeast : []
  const required = [...new Set([...schemaRequired, ...atLeast])]
  const missing = required.filter((f) => receipt == null || receipt[f] === undefined)
  const evidence = contract?.receipt?.invariants?.find?.((i) => i.id === 'receipt-is-recorded-on-adoption')
  if (receipt != null && receipt.proofLevel !== undefined) {
    const readable = receiptFieldEnum(contract, 'proofLevel')
    if (!readable.includes(receipt.proofLevel)) missing.push(`proofLevel(可读值 ${JSON.stringify(readable)})`)
  }
  return { missing, why: evidence?.why ?? '' }
}

/**
 * 判决一次迁移。**不写盘**（写盘在 transition() 里），纯函数便于测试。
 * @returns {{ok:boolean, status:string, reason:string, writeReceipt?:object}}
 */
export function transitionDecision(contract, node, to, receipt) {
  const from = statusOf(node)
  if (from === null) throw new UsageError(`节点缺 status 字段（或不是字符串）⇒ 无法迁移`)

  const values = contract?.states?.values ?? []
  if (!values.includes(to)) {
    throw new UsageError(`目标状态 "${to}" 不在契约 states.values=${JSON.stringify(values)} 里`)
  }

  // 已经是目标态：幂等，不算"过门"（也不写回执）
  if (from === to) return { ok: true, status: to, reason: `状态已是 ${to}（幂等，未过门）` }

  const rule = transitionRule(contract, from, to)
  if (!rule) {
    // ★ 契约里没有的迁移 ⇒ 拒绝。默认拒绝是"门"的正确默认值：放过未知迁移 = 又一条绕门路径。
    return {
      ok: false,
      status: from,
      reason: `契约 transitions.rules 未声明 ${from} → ${to} ⇒ 拒绝（未知迁移不得默认放过）`,
    }
  }

  // 规则声明的 require 逐条判（契约现在是两条：receipt.status == "passed"，
  // ★ O53 另加 receipt.proofLevel in ["L0","L1"]）
  for (const req of rule.require ?? []) {
    const [head, ...rest] = String(req.path ?? '').split('.')
    if (head !== 'receipt') throw new UsageError(`契约里出现未支持的 require.path "${req.path}"`)
    const actual = receipt == null ? undefined : rest.reduce((o, k) => (o == null ? o : o[k]), receipt)
    if (!compare(req.op, actual, req.value)) {
      const template = req.reasonTemplate ?? rule.onFail?.reasonTemplate ?? 'require 不满足 ⇒ 拒绝'
      // 「拒绝必须可解释」：分清【没有回执】/【字段缺失】/【字段值不合规】三种情形，
      // 否则缺字段会被说成"无回执"，读的人找错方向。
      const actualText =
        receipt == null
          ? '无回执(null)'
          : actual === undefined
            ? `缺字段(${String(req.path).replace(/^receipt\./, '')})`
            : JSON.stringify(actual)
      return {
        ok: false,
        status: rule.onFail?.keepStatus === false ? to : from,
        reason: template.replace('{actual}', actualText),
      }
    }
  }

  // 走到这里 = 规则允许。★ 再过一道"回执完整性"（见 receiptCompleteness 的注释）
  const adopted = contract?.states?.adoptedState ?? 'active'
  if (to === adopted) {
    const { missing } = receiptCompleteness(contract, rule, receipt)
    if (missing.length > 0) {
      return {
        ok: false,
        status: from,
        reason: `回执不完整，缺字段 ${JSON.stringify(missing)} ⇒ 拒绝 ${from} → ${to}（回执可读是过门条件：receipt-is-recorded-on-adoption）`,
      }
    }
  }

  return {
    ok: true,
    status: to,
    reason: `规则 ${rule.id} 满足${rule.require?.length ? '（receipt.status == "passed"）' : '（无 require）'} ⇒ 允许 ${from} → ${to}`,
    writeReceipt: receipt ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态写回约定（★ O51：从契约 `implementations.state` 读，不再自己定）
// ─────────────────────────────────────────────────────────────────────────────

/** 契约声明的写回策略。没声明 ⇒ 拒绝猜（不许靠私下约定）。 */
function statePolicy(contract) {
  const w = contract?.implementations?.state?.writeback
  if (!w || typeof w.mode !== 'string' || w.mode.trim() === '') {
    throw new UsageError(
      '契约未声明 implementations.state.writeback（状态写回约定）⇒ 拒绝猜（O51：不许靠私下约定写回状态）',
    )
  }
  return w
}

/**
 * 状态文件 = 按契约 `writeback.mode` 决定：
 *   in-place ⇒ `--node` 指向的同一个文件（默认）；
 *   sidecar  ⇒ 仅在给了契约声明的 `writeback.overrideArg`（`--state`）时用它。
 * 契约声明了本实现不支持的模式 ⇒ exit 2（宁可答不上来，也不静默换个位置写）。
 */
function stateFileFor(contract, nodeFile, stateFile) {
  const w = statePolicy(contract)
  if (stateFile && w.overrideArg === '--state') return path.resolve(stateFile)
  if (w.mode === 'in-place') return path.resolve(nodeFile)
  throw new UsageError(
    `契约声明的状态写回模式 "${w.mode}" 参考实现未支持（已支持：in-place${w.overrideArg ? ` + ${w.overrideArg} override` : ''}）`,
  )
}

function currentStatus(contract, node, nodeFile, stateFile) {
  const sf = stateFileFor(contract, nodeFile, stateFile)
  if (stateFile && fs.existsSync(sf)) {
    const st = statusOf(readJson(sf, '状态文件'))
    if (st !== null) return st
  }
  return statusOf(node)
}

function writeState(sf, node, nextStatus, receipt) {
  const out = { ...node, status: nextStatus }
  if (receipt) out.receipt = receipt
  fs.mkdirSync(path.dirname(sf), { recursive: true })
  fs.writeFileSync(sf, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
}

// ─────────────────────────────────────────────────────────────────────────────
// 子命令
// ─────────────────────────────────────────────────────────────────────────────

export function cmdVisible(contract, opts) {
  const node = readJson(opts.node, '节点文件')
  const { visible } = visibleDecision(contract, node, opts.taskHint ?? '')
  return { stdout: { visible }, exit: 0 }
}

export function cmdTransition(contract, opts) {
  const node = readJson(opts.node, '节点文件')
  const sf = stateFileFor(contract, opts.node, opts.state)
  const from = currentStatus(contract, node, opts.node, opts.state)
  const working = { ...node, status: from }
  const receipt = opts.receipt ? readJson(opts.receipt, '回执文件') : null

  const r = transitionDecision(contract, working, opts.to, receipt)
  writeState(sf, working, r.status, r.ok ? r.writeReceipt : null)
  return {
    stdout: { ok: r.ok, status: r.status, reason: r.reason },
    exit: 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// argv 解析 + main
// ─────────────────────────────────────────────────────────────────────────────

const FLAGS_WITH_VALUE = new Set(['--node', '--to', '--task-hint', '--receipt', '--state', '--contract'])

export function parseArgv(argv) {
  const [cmd, ...rest] = argv
  if (!cmd || cmd.startsWith('--')) throw new UsageError('缺子命令（应为 visible | transition）')
  if (cmd !== 'visible' && cmd !== 'transition') throw new UsageError(`未知子命令 "${cmd}"（应为 visible | transition）`)

  const opts = {}
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    const eq = a.includes('=') ? a.indexOf('=') : -1
    const key = eq > 0 ? a.slice(0, eq) : a
    if (!FLAGS_WITH_VALUE.has(key)) throw new UsageError(`未知参数 "${a}"`)
    const val = eq > 0 ? a.slice(eq + 1) : rest[++i]
    if (val === undefined) throw new UsageError(`参数 ${key} 缺少取值`)
    opts[key.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = val
  }

  if (!opts.node) throw new UsageError('缺必填参数 --node <jsonfile>')
  if (cmd === 'transition' && !opts.to) throw new UsageError('transition 缺必填参数 --to <status>')
  return { cmd, opts }
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {object}   [contract]  已加载的契约（缺省从 --contract / DEFAULT_CONTRACT 读）
 *   ★ 允许注入：`gate-impl-broken.mjs` 就是靠"注入一份被改坏一处的契约"来复现 bug，
 *     从而保证两个实现**只差那一处**，而不是各写一套逻辑。
 * @returns {number} exit code
 */
export function main(argv, contract) {
  try {
    const { cmd, opts } = parseArgv(argv)
    const c = contract ?? loadContract(opts.contract ?? DEFAULT_CONTRACT)
    const { stdout, exit } = cmd === 'visible' ? cmdVisible(c, opts) : cmdTransition(c, opts)
    process.stdout.write(`${JSON.stringify(stdout)}\n`)
    return exit
  } catch (e) {
    const msg = e instanceof UsageError ? e.message : `实现内部错误：${e.stack ?? e.message}`
    process.stdout.write(`${JSON.stringify({ error: msg })}\n`)
    process.stderr.write(`${msg}\n`)
    return 2
  }
}

// 只有被当作入口脚本时才跑（被 broken.mjs import 时不跑）
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) process.exit(main(process.argv.slice(2)))
