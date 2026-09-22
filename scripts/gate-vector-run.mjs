#!/usr/bin/env node
/**
 * gate-vector-run.mjs —— 向量 runner：把 `evals/gate/vectors.json` 变成**可执行的验证**，
 * 并且能**指向任意实现**（默认参考实现；也可以指向 Go 侧将来接上契约后的实现）。
 *
 *     node scripts/gate-vector-run.mjs [--impl "<cmd>"] [--vectors <file>] [--out <file>]
 *
 * ★ 本任务的核心价值：**同一套向量，两处跑**。
 *   今天跑 `--impl "node scripts/gate-impl-reference.mjs"`（正确的参考实现）；
 *   将来 Go 侧按契约实现完 `visible` / `transition` 两条子命令后，**换一个 --impl 就行**，
 *   不需要再写一套验证。为此 runner 只认契约 `implementations.commands` 里那两条命令 + stdout 形状。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 三种结果，**绝不含糊**（判定顺序：先证据、后对错）
 *
 *   PASS            实现给出了判决，且与 `expect` 逐字段一致
 *   FAIL            实现给出了判决，但与 `expect` 不一致
 *   ★ NEEDS-EVIDENCE 实现**答不上来**：崩了／非零退出／stdout 不是合法 JSON／
 *                    缺该子命令必须返回的字段 ⇒ **绝不是 PASS**（"无证据 ≠ 通过"）
 *                    —— 这条路径是防"实现没接上却显示全绿"的保险，而保险必须自己测过。
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL；2 = 无 FAIL 但有 NEEDS-EVIDENCE；3 = 用法/读取错。
 * （1 与 2 分开，是为了让"门漏了"和"实现没接上"在 CI 里可区分。）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 额外做的事（报告/CI 看的东西）
 *   1. 打表：`角色(pos/neg/boundary) × 结果` 的汇总 + 每条 id 一行；
 *   2. ★ 汇总里**单独一行**打印"两条关键对照"：
 *        `l3-active-trigger-match-visible`（active ∧ 命中 ⇒ 应 PASS）
 *        `l3-pending-trigger-match-hidden`（pending ∧ 命中 ⇒ 应 PASS）
 *      这两条一起看 = **门既没漏（pending 挡得住）也没全封（active 出得来）**；
 *      两种 impl 下这一行必须**不同**，否则向量就是装饰。
 *   3. 全量原始输出写 `out/gate-vector-run.txt`（默认），便于贴进报告当证据。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 状态写回约定（★ O51 后：**从契约读**，不再是 runner 与实现的私下约定）
 *
 * 每条 transition 向量：**先把 `{...vector.node}` 写成一份临时节点文件**，
 * 再把 `--node <该文件> --to <status> [--receipt <回执临时文件>]` 喂给实现。
 * 写回位置与读回方式来自 `evals/gate/contract.json` → `implementations.state`：
 *   - `writeback.mode = "in-place"`（契约写死）⇒ 实现把结果写回 `--node` 那个文件本身；
 *   - `readback.field = "status"` ⇒ runner 事后**读该文件的 status 字段**来判
 *     `statusUnchanged` / 迁移后 `status`（不采信实现 stdout 的自述）。
 * ★ 契约里**没有**声明这套约定 ⇒ runner **exit 3 拒绝跑**（宁可答不上来，也不靠隐含约定）；
 *   契约声明了 runner 未支持的模式 ⇒ 同样 exit 3 并点名该模式。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ O55：**写回痕迹**（`expect.fileChanged`）—— 让「从不写回」可被分辨
 *
 * 问题（`docs/skill-as-agent-spec.md` §35.4）：4 条**负向**迁移向量都期望
 * `statusUnchanged: true`，而一个「**从不写回**」的实现【同样满足】—— 「读不到」被
 * 当成了「没变」。⇒ `statusUnchanged` 单独**不能**分辨「被拒绝且文件未动」与「根本不写回」；
 * 而**只有那条正向对照**（`transition-pending-to-active-receipt-passed`，期望
 * `statusUnchanged: false`）能抓到 ⇒ **删掉它，这类错误就会全绿通过。**
 *
 * 补法（两层，这里只是第一层）：每次 `transition` 都 measure **写回痕迹** ——
 * 对**契约声明的写回文件**（`readback.file`，即 `--node` 那份）在调用实现**前后**
 * 各取一次 `sha256` 摘要 ⇒ 摘要变了 = 文件**确实被写过**（`fileChanged: true`）。
 * 痕迹机制本身也必须由契约声明（`implementations.state.writeback.evidence`），
 * **契约没声明 ⇒ exit 3 拒绝跑**（与 O51 同一条纪律：宁可答不上来，也不靠隐含约定）。
 * 第二层（负向向量必须配同形正向对照）由 `contract.json` → `vectors.pairing` 声明、
 * 由 `scripts/gate-contract-check.mjs` 守（见该文件 O55 三条检查）。
 *
 * 依赖：无（`node:crypto` 是标准库）。只写 `out/`（临时目录 + 报告 txt），
 * **不改 vectors.json / contract.json**。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const DEFAULTS = {
  impl: 'node scripts/gate-impl-reference.mjs',
  vectors: path.join(ROOT, 'evals', 'gate', 'vectors.json'),
  out: path.join(ROOT, 'out', 'gate-vector-run.txt'),
  tmp: path.join(ROOT, 'out', 'gate-vector-run.tmp'),
}
const EXPECTED_VECTORS_SHAPE = 'dsh-gate-vectors/v1'

/**
 * ★ O55：本 runner **实现**的写回痕迹机制（契约声明 kind/algorithm/scope，
 * runner 只认这一种并要求契约值与之逐字一致 —— 不认识的声明一律 exit 3 拒绝猜）。
 */
const EVIDENCE_KIND = 'file-digest'
const EVIDENCE_ALGORITHM = 'sha256'
const EVIDENCE_SCOPE = 'declared-writeback-file'

/** ★ 两条关键对照：一起看才是"门既没漏也没全封"。 */
const KEY_PAIR = ['l3-active-trigger-match-visible', 'l3-pending-trigger-match-hidden']

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = { ...DEFAULTS, hasImpl: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1
    const key = eq > 0 ? a.slice(2, eq) : a.startsWith('--') ? a.slice(2) : a
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (!['impl', 'vectors', 'out', 'tmp'].includes(key)) throw new Error(`未知参数 "${a}"`)
    if (val === undefined) throw new Error(`参数 --${key} 缺少取值`)
    if (key === 'impl') opts.hasImpl = true
    opts[key] = val
  }
  opts.vectors = path.resolve(opts.vectors)
  opts.out = path.resolve(opts.out)
  opts.tmp = path.resolve(opts.tmp)
  return opts
}

/** `--impl "<cmd>"` 允许带参数（如 `node scripts/x.mjs --flag`）⇒ 按引号切分，不走 shell。 */
export function splitCommand(cmd) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3])
  if (out.length === 0) throw new Error('--impl 为空')
  return out
}

function firstJsonLine(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
      return null
    } catch {
      /* 继续找下一行 */
    }
  }
  return null
}

/**
 * ★ O51：从**契约**读出状态写回/读回约定。读不到 ⇒ 抛错（调用方 exit 3），
 * 绝不退回"runner 自己知道一个默认值"那种隐含约定。
 * ★ O55：一并读出**写回痕迹机制**（`writeback.evidence`）—— 同理，读不到 ⇒ exit 3。
 * @returns {{contractFile:string, mode:string, writeArg:string, readField:string, readTarget:string,
 *            evidence:{kind:string, algorithm:string, scope:string, field:string}}}
 */
export function loadStateProtocol(vectorsRaw) {
  const rel = vectorsRaw?.contract
  if (typeof rel !== 'string' || rel.trim() === '') {
    throw new Error('向量文件没有声明 contract ⇒ runner 无法按契约读回状态（O51：不许靠隐含约定）')
  }
  const contractFile = path.resolve(ROOT, rel)
  let contract
  try {
    contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'))
  } catch (e) {
    throw new Error(`契约不可读/非法：${contractFile}（${e.message}）`)
  }
  const st = contract?.implementations?.state
  const mode = st?.writeback?.mode
  const writeArg = st?.writeback?.arg
  const readField = st?.readback?.field
  const readTarget = st?.readback?.file
  if (typeof mode !== 'string' || typeof writeArg !== 'string' || typeof readField !== 'string') {
    throw new Error(
      '契约未声明 implementations.state.writeback/readback（状态写回约定）⇒ runner 拒绝跑（O51：宁可答不上来，也不靠隐含约定）',
    )
  }
  if (mode !== 'in-place') {
    throw new Error(
      `契约声明的状态写回模式 "${mode}"（readback.file=${JSON.stringify(readTarget)}）本 runner 未支持（已支持：in-place）⇒ 拒绝猜`,
    )
  }
  // ★ O55：写回痕迹机制必须由契约声明；runner 只实现契约声明的这一种 ⇒ 不认识的声明也拒绝猜。
  const ev = st?.writeback?.evidence
  const evKind = ev?.kind
  const evAlgo = ev?.algorithm
  const evScope = ev?.scope
  const evField = ev?.field
  if (typeof evKind !== 'string' || evKind.trim() === '') {
    throw new Error(
      '契约未声明 implementations.state.writeback.evidence（写回痕迹机制）⇒ runner 拒绝跑（O55：没有痕迹 ⇒「从不写回」与「被拒绝且文件未动」不可分辨 ⇒ statusUnchanged 会假绿）',
    )
  }
  if (evKind !== EVIDENCE_KIND) {
    throw new Error(
      `契约声明的写回痕迹 kind="${evKind}" 本 runner 未支持（已支持：${EVIDENCE_KIND}）⇒ 拒绝猜`,
    )
  }
  if (evAlgo !== EVIDENCE_ALGORITHM) {
    throw new Error(
      `契约声明的写回痕迹 algorithm="${evAlgo}" 本 runner 未支持（已支持：${EVIDENCE_ALGORITHM}）⇒ 拒绝猜`,
    )
  }
  if (evScope !== EVIDENCE_SCOPE) {
    throw new Error(
      `契约声明的写回痕迹 scope="${evScope}" 本 runner 未支持（已支持：${EVIDENCE_SCOPE} = runner 按契约读回的那份文件）⇒ 拒绝猜`,
    )
  }
  if (typeof evField !== 'string' || evField.trim() === '') {
    throw new Error('契约未声明 implementations.state.writeback.evidence.field（痕迹断言用的字段名）⇒ runner 拒绝跑')
  }
  return {
    contractFile,
    mode,
    writeArg,
    readField,
    readTarget: readTarget ?? '',
    evidence: { kind: evKind, algorithm: evAlgo, scope: evScope, field: evField },
  }
}

/**
 * ★ O55：文件摘要 —— 摘要机制本身**由契约声明**（kind/algorithm），这里只是它的实现。
 * 返回 `sha256:<hex>:len=<bytes>`；读不到 ⇒ 返回 `null`（调用方按"痕迹取不到"处理，偏严）。
 */
function fileDigest(file) {
  try {
    const buf = fs.readFileSync(file)
    return `${EVIDENCE_ALGORITHM}:${crypto.createHash(EVIDENCE_ALGORITHM).update(buf).digest('hex')}:len=${buf.length}`
  } catch {
    return null
  }
}

const oneLine = (s, max = 200) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max)}…` : t
}

// ─────────────────────────────────────────────────────────────────────────────
// 跑一条向量
// ─────────────────────────────────────────────────────────────────────────────

function runCase(implArgv, c, idx, tmpDir, log, stateProto) {
  const tag = `${String(idx + 1).padStart(2, '0')}-${c.id}`
  const nodeFile = path.join(tmpDir, `${tag}.node.json`)
  const receiptFile = path.join(tmpDir, `${tag}.receipt.json`)
  // ★ O51：写回位置**由契约的 state 约定决定**（mode=in-place ⇒ 就是 --node 那个文件）
  const stateFile = stateProto.mode === 'in-place' ? nodeFile : null

  fs.writeFileSync(nodeFile, `${JSON.stringify(c.node, null, 2)}\n`, 'utf8')
  const originalStatus = typeof c.node?.status === 'string' ? c.node.status : null
  // ★ O55：写回痕迹的【before】侧 —— 契约声明的写回文件在调用实现之前的摘要。
  //   （必须在写 nodeFile 之后取，否则摘要里没有"初始内容"这一基准。）
  const digestBefore = c.kind === 'transition' && stateFile ? fileDigest(stateFile) : null

  let args
  if (c.kind === 'transition') {
    const tr = c.transition ?? {}
    args = ['transition', '--node', nodeFile, '--to', String(tr.to)]
    if (tr.receipt != null) {
      fs.writeFileSync(receiptFile, `${JSON.stringify(tr.receipt, null, 2)}\n`, 'utf8')
      args.push('--receipt', receiptFile)
    }
  } else {
    args = ['visible', '--node', nodeFile, '--task-hint', String(c.taskHint ?? '')]
  }

  const res = spawnSync(implArgv[0], [...implArgv.slice(1), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  })
  const exit = res.status === null ? -1 : res.status
  const stdout = oneLine(res.stdout, 400)
  const stderr = oneLine(res.stderr, 240)
  const shown = [...args].join(' ')
  // ★ O55：写回痕迹的【after】侧 —— 实现退出后，同一个文件的摘要。
  const digestAfter = c.kind === 'transition' && stateFile ? fileDigest(stateFile) : null

  const ev = { exit, stdout, stderr, shown, reason: '' }
  if (res.error) {
    ev.reason = `实现无法启动：${res.error.code ?? res.error.message}`
    return { id: c.id, role: c.role, kind: c.kind, result: 'NEEDS-EVIDENCE', ev, checks: [] }
  }
  if (exit !== 0) {
    // ★ 「被规则拒绝」必须是 exit 0 + ok:false（契约 implementations.commands）；
    //    非零退出 = 实现答不上来 ⇒ 绝不是 PASS。
    ev.reason = `实现以非零退出码 ${exit} 收场（规则拒绝应当是 exit 0 + {"ok":false}）`
    return { id: c.id, role: c.role, kind: c.kind, result: 'NEEDS-EVIDENCE', ev, checks: [] }
  }
  const got = firstJsonLine(res.stdout)
  if (got === null) {
    ev.reason = 'stdout 里没有可解析的单行 JSON 对象'
    return { id: c.id, role: c.role, kind: c.kind, result: 'NEEDS-EVIDENCE', ev, checks: [] }
  }

  const checks = []
  const bad = (what, expected, actual) => checks.push({ ok: false, what, expected, actual })
  const good = (what) => checks.push({ ok: true, what })

  if (c.kind === 'transition') {
    if (typeof got.ok !== 'boolean' || typeof got.status !== 'string') {
      ev.reason = `transition 的 stdout 形状不合契约（需要 {ok:bool,status:str,reason:str}），实收 ${JSON.stringify(got)}`
      return { id: c.id, role: c.role, kind: c.kind, result: 'NEEDS-EVIDENCE', ev, checks: [] }
    }
    const want = c.expect ?? {}
    // ★ O51：迁移后的状态以**契约声明的写回文件**为准（mode=in-place ⇒ --node 那份）
    let afterStatus = null
    try {
      const readField = stateProto.readField
      afterStatus = JSON.parse(fs.readFileSync(stateFile, 'utf8'))?.[readField] ?? null
    } catch {
      afterStatus = null // 读不回 ⇒ 与 originalStatus 不等 ⇒ statusUnchanged 会 FAIL（偏严方向）
    }
    if (want.ok !== undefined) {
      got.ok === want.ok ? good('ok') : bad('ok', want.ok, got.ok)
    }
    if (want.status !== undefined) {
      // ★ O56 修复：`status` 也必须以**契约声明的写回文件**为准（与 :42-43 的声明一致），
      //   不得采信实现 stdout 的自述 —— 否则"没写回"的实现会在这条上假绿。
      afterStatus === want.status
        ? good('status(契约声明的写回文件)')
        : bad(
            'status(契约声明的写回文件)',
            want.status,
            `写回文件里 ${stateProto.readField}=${JSON.stringify(afterStatus)}（stdout 自述 ${JSON.stringify(got.status)}）`,
          )
    }
    if (want.statusUnchanged !== undefined) {
      const unchanged = afterStatus === originalStatus
      unchanged === want.statusUnchanged
        ? good('statusUnchanged(契约声明的写回文件)')
        : bad(
            'statusUnchanged(契约声明的写回文件)',
            want.statusUnchanged,
            `写回文件里 ${stateProto.readField}=${JSON.stringify(afterStatus)}（原 ${JSON.stringify(originalStatus)}）`,
          )
    }
    if (want.fileChanged !== undefined) {
      // ★★ O55：写回痕迹断言。`changed` 看的是【契约声明的写回文件】的摘要有没有变 ——
      //   这是唯一能分辨「被拒绝且文件未动」（false）与「根本不写回」（也是 false，但
      //   一旦有向量期望 true 就会挂）的信号。所以配套的配对规则（vectors.pairing）保证
      //   每条负向对照都有一条期望 true 的同 to 正向对照。
      const changed = digestBefore !== digestAfter
      changed === want.fileChanged
        ? good(`fileChanged(写回痕迹 ${stateProto.evidence.kind}/${stateProto.evidence.algorithm})`)
        : bad(
            `fileChanged(写回痕迹 ${stateProto.evidence.kind}/${stateProto.evidence.algorithm})`,
            want.fileChanged,
            `${changed ? '摘要变了' : '摘要没变'}：before=${JSON.stringify(digestBefore)} after=${JSON.stringify(digestAfter)}（文件 = 契约声明的写回文件 ${path.relative(ROOT, stateFile).replace(/\\/g, '/')}）`,
          )
    }
    if (typeof got.reason !== 'string' || got.reason.trim() === '') {
      bad('reason 可解释（非空）', '非空字符串', JSON.stringify(got.reason))
    } else {
      good('reason 可解释（非空）')
    }
  } else {
    if (typeof got.visible !== 'boolean') {
      ev.reason = `visible 的 stdout 形状不合契约（需要 {visible:bool}），实收 ${JSON.stringify(got)}`
      return { id: c.id, role: c.role, kind: c.kind, result: 'NEEDS-EVIDENCE', ev, checks: [] }
    }
    if (c.expect?.visible !== undefined) {
      got.visible === c.expect.visible
        ? good('visible')
        : bad('visible', c.expect.visible, got.visible)
    }
  }

  const failed = []
  for (const ck of checks) if (!ck.ok) failed.push(ck)
  ev.reason = failed.length === 0 ? '' : failed.map((f) => `${f.what} 期望 ${JSON.stringify(f.expected)} 实为 ${JSON.stringify(f.actual)}`).join('；')
  if (failed.length > 0) log(`      └ ${ev.reason}`)
  return { id: c.id, role: c.role, kind: c.kind, result: failed.length === 0 ? 'PASS' : 'FAIL', ev, checks }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const lines = []
  const log = (s = '') => {
    lines.push(s)
    process.stdout.write(`${s}\n`)
  }

  const opts = parseArgv(argv)

  let vectorsRaw
  try {
    vectorsRaw = JSON.parse(fs.readFileSync(opts.vectors, 'utf8'))
  } catch (e) {
    process.stderr.write(`向量文件不可读/非法：${opts.vectors}（${e.message}）\n`)
    return 3
  }
  const cases = vectorsRaw?.cases
  if (!Array.isArray(cases) || cases.length === 0) {
    process.stderr.write(`向量文件里没有 cases 数组：${opts.vectors}\n`)
    return 3
  }

  // ★ O51：状态写回/读回约定必须来自契约；读不到 ⇒ exit 3（不靠隐含约定）
  let stateProto
  try {
    stateProto = loadStateProtocol(vectorsRaw)
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return 3
  }

  log('════════════════════════════════════════════════════════════════════════')
  log('gate-vector-run.mjs —— 门向量 runner')
  log(`  impl    : ${opts.impl}`)
  log(`  vectors : ${path.relative(ROOT, opts.vectors).replace(/\\/g, '/')}  (${cases.length} 条)`)
  log(`  形状    : ${vectorsRaw.vectors}${vectorsRaw.vectors === EXPECTED_VECTORS_SHAPE ? '' : `  ⚠️ 期望 ${EXPECTED_VECTORS_SHAPE}`}`)
  log(`  契约    : ${vectorsRaw.contract ?? '(未声明)'}`)
  log(`  ★ 状态写回: 契约 ${path.relative(ROOT, stateProto.contractFile).replace(/\\/g, '/')} → implementations.state`)
  log(`              writeback.mode=${JSON.stringify(stateProto.mode)}（arg ${stateProto.writeArg}）⇒ 原地回写 --node 文件`)
  log(`              readback.field=${JSON.stringify(stateProto.readField)}（runner 读回该字段判 statusUnchanged / status）`)
  log(`  ★ 写回痕迹: 契约 writeback.evidence → ${stateProto.evidence.kind}/${stateProto.evidence.algorithm}（scope ${stateProto.evidence.scope}）`)
  log(`              ⇒ transition 前后各取一次该文件摘要，比 ${stateProto.evidence.field}（O55：分辨「从不写回」）`)
  log(`  out     : ${path.relative(ROOT, opts.out).replace(/\\/g, '/')}`)
  log('════════════════════════════════════════════════════════════════════════')

  fs.rmSync(opts.tmp, { recursive: true, force: true }) // 本脚本自己的临时目录
  fs.mkdirSync(opts.tmp, { recursive: true })
  const implArgv = splitCommand(opts.impl)

  const results = []
  cases.forEach((c, i) => {
    const r = runCase(implArgv, c, i, opts.tmp, log, stateProto)
    results.push(r)
    log(`[${r.result.padEnd(14)}] ${c.id.padEnd(56)} ${String(c.kind).padEnd(10)} ${String(c.role).padEnd(18)} expect=${JSON.stringify(c.expect)} got=${r.ev.stdout}`)
  })

  // ── 打表：角色 × 结果 ────────────────────────────────────────────────────
  const V = ['PASS', 'FAIL', 'NEEDS-EVIDENCE']
  const roles = ['positive-control', 'negative-control', 'boundary']
  const seenRoles = [...new Set([...roles, ...results.map((r) => r.role)])]
  log('')
  log('── 角色(pos/neg/boundary) × 结果 ────────────────────────────────────────')
  log(`  ${'role'.padEnd(20)}${V.map((v) => v.padStart(15)).join('')}${'total'.padStart(8)}`)
  for (const role of seenRoles) {
    const rs = results.filter((r) => r.role === role)
    if (rs.length === 0) continue
    const cells = V.map((v) => String(rs.filter((r) => r.result === v).length).padStart(15)).join('')
    log(`  ${String(role).padEnd(20)}${cells}${String(rs.length).padStart(8)}`)
  }
  log(`  ${'合计'.padEnd(19)}${V.map((v) => String(results.filter((r) => r.result === v).length).padStart(15)).join('')}${String(results.length).padStart(8)}`)

  // ── ★ 两条关键对照（单独一行） ───────────────────────────────────────────
  log('')
  log('── ★ 两条关键对照（门「既没漏」也「没全封」） ───────────────────────────')
  const keyCells = KEY_PAIR.map((id) => {
    const r = results.find((x) => x.id === id)
    return `${id}=${r ? r.result : 'MISSING-VECTOR'}`
  })
  const activePair = results.find((x) => x.id === KEY_PAIR[0])
  const pendingPair = results.find((x) => x.id === KEY_PAIR[1])
  let verdict
  if (!activePair || !pendingPair) verdict = '★ 向量缺失，无法判定（这批向量不完整）'
  else if (activePair.result === 'PASS' && pendingPair.result === 'PASS')
    verdict = '★ 判定：门既没漏（pending 挡得住 L3）也没全封（active 出得来）'
  else if (pendingPair.result === 'FAIL' && activePair.result === 'PASS')
    verdict = '★★ 判定：门漏了 —— active 出得来，但 pending 也出得来（= 装饰门，正是 skill_tree.go:1054+ 现状）'
  else if (activePair.result === 'FAIL' && pendingPair.result === 'PASS')
    verdict = '★★ 判定：门全封 —— pending 挡住了，但 active 也出不来（技能全废）'
  else verdict = `★★ 判定：两条都 ${activePair.result}/${pendingPair.result}`
  log(`  ${keyCells.join('   ')}`)
  log(`  ${verdict}`)

  // ── 逐条 id 一行（紧凑清单） ─────────────────────────────────────────────
  log('')
  log('── 逐条 id × 结果 × 判据 ───────────────────────────────────────────────')
  for (const r of results) {
    const detail =
      r.result === 'PASS'
        ? r.checks.filter((c) => c.ok).map((c) => c.what).join('+')
        : r.result === 'FAIL'
          ? r.ev.reason
          : r.ev.reason
    log(`  ${r.result.padEnd(15)} ${r.id.padEnd(56)} ${detail}`)
  }

  const nPass = results.filter((r) => r.result === 'PASS').length
  const nFail = results.filter((r) => r.result === 'FAIL').length
  const nNe = results.filter((r) => r.result === 'NEEDS-EVIDENCE').length
  const exit = nFail > 0 ? 1 : nNe > 0 ? 2 : 0
  log('')
  log('── 结论 ────────────────────────────────────────────────────────────────')
  log(`  ${nPass}/${results.length} PASS ／ ${nFail} FAIL ／ ${nNe} NEEDS-EVIDENCE  ⇒ exit ${exit}`)
  if (exit === 0) log('  ⇒ 该实现与向量一致（注意：这只证明「这批向量覆盖到的判据」一致，不等于门已被 Go 侧实现）')
  else if (exit === 1) log('  ⇒ 该实现与向量不一致；★ 若跑的是 gate-impl-broken.mjs，这正是「向量有分辨力」的证据')
  else log('  ⇒ 该实现答不上来（崩了/输出非法）⇒ NEEDS-EVIDENCE，绝不是 PASS')

  const text = `${lines.join('\n')}\n`
  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  fs.writeFileSync(opts.out, text, 'utf8')
  process.stdout.write(`\n（完整输出已写入 ${path.relative(ROOT, opts.out).replace(/\\/g, '/')}）\n`)
  if (!opts.hasImpl) process.stdout.write('（未指定 --impl，用的是默认参考实现）\n')
  return exit
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (e) {
    process.stderr.write(`runner 用法/内部错误：${e.message}\n`)
    process.exit(3)
  }
}
