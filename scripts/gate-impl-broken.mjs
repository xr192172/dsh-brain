#!/usr/bin/env node
/**
 * gate-impl-broken.mjs —— ★★ 「故意坏」的实现 = **复现我们发现的真 bug**
 *
 * ★ O54 起：**一个文件 + 一个 `--break` 开关**（不再为每种坏法各写一个文件）
 *
 *     node scripts/gate-impl-broken.mjs visible    --node <f> [--task-hint <t>] [--break <mode>]
 *     node scripts/gate-impl-broken.mjs transition --node <f> --to <s> [--receipt <f>] [--break <mode>]
 *
 *   `--break l3-status`     （★ 默认）L3 分支【不检查 status】—— 现状，向后兼容
 *   `--break o51-writeback`            transition 【不按契约声明的位置写回】（写到旁挂文件）
 *   `--break o53-receipt`              transition 【只认 receipt.status=="passed"，不要求回执必填字段齐】
 *   `--break all-hidden`    （★ O57）  注入侧【全封】：`visible` **永远返回 false**（与 l3-status「全放」对称）
 *
 * 不带 `--break` ⇒ 等价于 `--break l3-status`（逐字向后兼容：argv 与契约改动都一样）。
 * 四种模式**互斥**（一次只坏一处）：这样每次跑出来的 FAIL 集合就是"这一处坏法能被几条向量抓到"，
 * 而不是几种坏法混在一起、说不清是哪条向量在起作用。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 坏法①：`l3-status`（现状，O45/O52）
 *
 *     L3 分支【不检查 status】⇒ pending（甚至 archived/invalidated/suspicious）条目
 *     只要 triggers 命中 taskHint 就照样"可见"（= 会被注入 prompt）。
 *
 * 这就是「只改导入处 = 装饰门」那种形状，也正是现状：
 *
 *   docs/o45-import-gate-landing.md §1 逐字核过 internal/memory/skill_tree.go:1054+ GetActiveSkills：
 *     | L0（高分配稳定技能） | Score>0.7 ∧ UseCount>10 | ✅ 要求 Status == "active" |
 *     | ★ L3（触发词命中）   | Triggers 命中 taskHint  | ❌ 完全不检查 Status          |
 *   ⇒ 把导入处改成 pending 只封住 L0 那条路，**L3 那条路照走**（spec §30.1）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 坏法②：`o51-writeback`（O51）
 *
 *     transition 照常判决、照常写回 —— 但**写到旁挂文件**，契约声明的那份（runner 读回的那份）不动。
 *     ⇒ 期望被 runner「按契约读回 `--node` 文件的 status」判 `statusUnchanged` 时抓住。
 *
 * 与现状的关系：这正是 `docs/gate-contract.md` §5.1 / 契约 `implementations.state.goSide` 逐字警告的
 *   那种失真 ——「读不到写回结果」与「状态未变」不可区分；runner 采信 stdout 自述（ok:true/active）
 *   就会显示全绿，而磁盘上条目还是 pending ⇒ **过了门却没生效**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 坏法③：`o53-receipt`（O53）
 *
 *     pending → active 只看 `receipt.status == "passed"`，
 *     **不要求回执必填字段齐**（忽略 `proofLevel` 缺失）。
 *     ⇒ 期望被 `transition-pending-to-active-receipt-missing-prooflevel` 抓住。
 *
 * 与现状的关系：契约 transitions.rules 的**字面**只写了 `receipt.status == "passed"`，
 *    比向量更松 —— 「passed 但读不到证到哪一级」会静默过门（= 没有回执位）。O53 才把
 *    「回执必填字段可读（至少 proofLevel）」写进契约。本坏法就是**回到 O53 之前的那个洞**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 坏法④：`all-hidden`（★ O57）—— 与 `l3-status`（"全放"）**对称**的"全封"
 *
 *     `visible` **永远返回 false**：任何 status 的节点都进不了注入面。
 *
 *     与现状的关系：这是"把门关死"的那种坏法（技能全废），与 `l3-status`（门形同虚设、
 *     什么都放行）是同一根轴的两端。★ 它**恰好**能被 L0/L3 的**正向对照**抓到：
 *     L0/L3 的 negative-control（本篇任务文字写作"4 条"，实测当前向量集是
 *     **L0 的 2 条 + L3 的 4 条 = 6 条**，都期望 `visible:false`）在它下面**全部 PASS**
 *     ⇒ 只有 `l0-active-highscore-visible` / `l3-active-trigger-match-visible` 会 FAIL
 *     ⇒ 这正是 O57 要堵的洞（§36.5-3：删掉正向对照 ⇒ 静默全绿）。
 *
 *     ★ 为什么这一处用"改契约数据"表达（如实记，含一个实测到的坑）：
 *       参考实现不硬编码任何状态字面量 ⇒ 「可见/不可见」这条路**只能**从
 *       `visibility.rules[].requiresStatus` / `conditions` 读。要让两条路径**同时**全封，
 *       不存在任何一个**合法词汇表取值**可用 —— 5 个状态全都被向量用到
 *       （L0 用到 active/pending/archived；L3 用到全部 5 个：active/pending/archived/
 *       invalidated/suspicious）⇒ 无论把 requiresStatus 设成哪个合法值，都会**放出**一批
 *       本该被挡下的向量（那会变成另一种坏法，不是"全封"）。
 *       ⇒ 本文件把两条规则的 `requiresStatus` 设成一个**任何合法 status 都不等于**的哨兵
 *         `__all-hidden__` ⇒ 判定结果对所有合法节点恒为「不可见」= `visible` 永远返回 false。
 *       实测到的坑：哨兵**不能**用空字符串 —— 参考实现写的是
 *       `if (rule.requiresStatus && statusOf(node) !== rule.requiresStatus) return false`，
 *       空串是 falsy ⇒ 那道状态检查会被**跳过**，L0 会退化成"只看 score/useCount"
 *       （于是全封失败、L0 反而全放）。这是"合法值"之外的第三个陷阱，故记在此处。
 *       ⚠️ 只改内存，**绝不改 `contract.json` 磁盘文件**（`loadContract()` 每次返回新对象）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么坏法长这个形状：参考实现是**契约驱动**的 ⇒ 只动数据、不动判定代码
 *
 * 参考实现不硬编码任何阈值/状态字面量（见其 §0）⇒ 「坏法」有两种忠实复现手段，
 * 两者都**只改数据**，两个实现因此共享同一段判定代码，FAIL 时"挂的是哪一条策略"是确定的：
 *
 *   ① 改坏契约（**内存里**）：`l3-status`、`o53-receipt`、★ `all-hidden` 用。
 *      删掉契约里那条判据（L3 的 `requiresStatus`；pending→active 里 `receipt.proofLevel`
 *      的 require + `requireFieldsComplete.atLeast` + `receipt.schema.required`），
 *      等价于"有人把这条要求从策略里删了 / 从没写进去"。
 *      ★ `all-hidden` 则相反：把两条可见性规则的 `requiresStatus` 换成不可达哨兵
 *      （见上 §坏法④）——同样是"只动数据"。
 *      ⚠️ 只改内存，**绝不改 `contract.json` 磁盘文件**（`loadContract()` 每次返回新对象）。
 *
 *   ② 改坏写回位置（**argv 里**）：`o51-writeback` 用 —— 因为写回位置**不是**一条"判据"，
 *      而是 `implementations.state.writeback.mode/arg`：参考实现见 `mode=in-place` 就原地回写
 *      `--node` 文件；**若把 mode 改成别的值，参考实现会 exit 2（= 答不上来）**，
 *      那是"没实现"而不是"坏实现"（runner 会给 NEEDS-EVIDENCE，抓不到"状态不一致"这件事）。
 *      所以在 argv 层把 `--node <f>` 换成一份旁挂副本 `<f>.sidecar.json`：
 *      实现照样读节点、照样判决、照样写回 —— 只是**写到了旁挂文件**，
 *      契约声明的那份（runner 读回的那份）**原封不动**。
 *      ⇒ stdout 与参考实现逐字一致，差异**只**出现在"runner 按契约读回的那个文件"里。
 *      `gate-vector-run.mjs` 不传 `--state` ⇒ 走的就是契约默认的 in-place 分支。
 *
 * ★ 本文件**只**坏 `--break` 选中的那一处：另外几处照原样继承契约（含"不动 `--node`/判据代码"）。
 *
 * ★ 与现状的**刻意的不忠实**（如实记录，报告里也有）：
 *   Go 现状在 L3 之前还有一条更上层的 `if node.Status == "archived" { continue }`，
 *   所以现状真正漏出去的只有 `pending`。`l3-status` 的 L3 分支是**完全没有状态逻辑**，
 *   因此 `archived`、`invalidated`、`suspicious` 也会一起漏 ⇒ 除 `l3-pending-trigger-match-hidden`
 *   之外，`l3-archived-trigger-match-hidden`、`invalidated-trigger-match-hidden`、
 *   `suspicious-trigger-match-hidden` 也会 FAIL。
 *   ★ 全都 FAIL 更好用：它同时说明这批向量能分辨"漏了 pending"和"漏了不可见态"（O52 补的两条也在其中）。
 *
 * 退出码：与参考实现一致（0 = 有判决；2 = 用法/输入错，含 `--break` 取值非法）。
 */

import fs from 'node:fs'
import { loadContract, main } from './gate-impl-reference.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// ★ O54：`--break` 开关（在 argv 进参考实现之前摘掉 —— 参考实现的 parseArgv 只认契约那几个 flag）
// ─────────────────────────────────────────────────────────────────────────────

const BREAK_MODES = ['l3-status', 'o51-writeback', 'o53-receipt', 'all-hidden']
const DEFAULT_BREAK = 'l3-status'

/** ★ O57：「全封」用的哨兵 —— 值本身不重要，重要的是它**不等于任何合法 status**。
 *  ⚠️ 不能是空串：参考实现的判据是 `if (rule.requiresStatus && ...)`，空串是 falsy ⇒
 *     状态检查会被跳过（L0 会退化成"只看 score/useCount"），那就不是"全封"了。 */
const ALL_HIDDEN_SENTINEL = '__all-hidden__'

/** 用法错（与参考实现的 UsageError 同款语义：输出既有的单行 JSON + 非零退出）。 */
class ArgError extends Error {}

/**
 * 从 argv 里摘出 `--break <mode>` / `--break=<mode>`。
 * @returns {{mode:string, argv:string[]}}  mode 缺省即 `l3-status`（向后兼容）
 */
function takeBreak(argv) {
  const rest = []
  let mode = null
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a !== '--break' && !a.startsWith('--break=')) {
      rest.push(a)
      continue
    }
    const val = a === '--break' ? argv[++i] : a.slice('--break='.length)
    if (val === undefined || val === '') throw new ArgError(`参数 --break 缺少取值（应为 ${BREAK_MODES.join(' | ')}）`)
    if (mode !== null) throw new ArgError(`参数 --break 只能给一次（四种坏法互斥）`)
    if (!BREAK_MODES.includes(val)) {
      throw new ArgError(`未知 --break 取值 "${val}"（应为 ${BREAK_MODES.join(' | ')}）`)
    }
    mode = val
  }
  return { mode: mode ?? DEFAULT_BREAK, argv: rest }
}

/**
 * 坏法①③用：**在内存里**把契约改坏一处（绝不落盘）。
 * @param {object} contract  loadContract() 的新对象
 * @param {string} mode
 */
function breakContract(contract, mode) {
  if (mode === 'l3-status') {
    const l3 = (contract.visibility?.rules ?? []).find((r) => r.level === 'L3')
    if (!l3) throw new ArgError('坏实现的前提不成立：契约里找不到 visibility.rules[level="L3"]')
    delete l3.requiresStatus // ★★ 唯一的差异：L3 分支不检查 status（复现 skill_tree.go:1054+ 现状）
    return
  }

  if (mode === 'o53-receipt') {
    const id = 'pending-to-active-requires-passed-receipt'
    const rule = (contract.transitions?.rules ?? []).find((r) => r.id === id)
    if (!rule) throw new ArgError(`坏实现的前提不成立：契约里找不到 transitions.rules[id="${id}"]`)
    // ★ 只认 receipt.status == "passed"：把「回执可读」这几条判据从策略里删掉
    rule.require = (rule.require ?? []).filter((q) => q.path !== 'receipt.proofLevel')
    if (rule.requireFieldsComplete) rule.requireFieldsComplete.atLeast = []
    if (contract.receipt?.schema) contract.receipt.schema.required = []
    return
  }

  if (mode === 'all-hidden') {
    // ★★ O57 坏法④：注入侧「全封」—— visible 永远返回 false（与 l3-status「全放」对称）。
    //    做法（只动数据）：把**每一条**可见性路径的 requiresStatus 换成一个任何合法 status
    //    都不等于的哨兵 ⇒ L0/L3 两条路径对所有节点都判「不可见」= visible 恒 false。
    //    ⚠️ 哨兵必须非空（空串是 falsy，会让参考实现跳过整道状态检查 ⇒ 变成"L0 只看分数"）。
    const rules = contract.visibility?.rules ?? []
    if (rules.length === 0) {
      throw new ArgError('坏实现的前提不成立：契约里找不到 visibility.rules（没有注入路径可控 ⇒ 全封无从谈起）')
    }
    for (const r of rules) r.requiresStatus = ALL_HIDDEN_SENTINEL
    return
  }
}

/** 坏法②用：把 `--node <f>` 换成旁挂副本 `<f>.sidecar.json`（读不到就照原样交给参考实现去报用法错）。 */
function redirectWritebackToSidecar(argv) {
  const out = [...argv]
  const swap = (file) => {
    const sidecar = `${file}.sidecar.json`
    try {
      fs.copyFileSync(file, sidecar)
    } catch {
      return file // 源文件读不到 ⇒ 不伪造：照原样交给参考实现（它会 exit 2 报"节点文件不可读"）
    }
    return sidecar
  }
  for (let i = 0; i < out.length; i += 1) {
    const a = out[i]
    if (a === '--node' && i + 1 < out.length) {
      out[i + 1] = swap(out[i + 1])
      return out
    }
    if (a.startsWith('--node=')) {
      out[i] = `--node=${swap(a.slice('--node='.length))}`
      return out
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

function run() {
  const { mode, argv } = takeBreak(process.argv.slice(2))
  const contract = loadContract()
  breakContract(contract, mode)
  // 坏法②：只坏 transition 的写回位置（visible 不涉及写回）
  const finalArgv = mode === 'o51-writeback' && argv[0] === 'transition' ? redirectWritebackToSidecar(argv) : argv
  return main(finalArgv, contract)
}

let code
try {
  code = run()
} catch (e) {
  const msg = e instanceof ArgError ? e.message : `实现内部错误：${e.stack ?? e.message}`
  process.stdout.write(`${JSON.stringify({ error: msg })}\n`)
  process.stderr.write(`${msg}\n`)
  code = 2
}
process.exit(code)
