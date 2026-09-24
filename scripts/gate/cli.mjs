#!/usr/bin/env node
/**
 * cli.mjs —— ★ 门层的【统一入口】。所有触发点（git 钩子 / 人 / CI）都只敲这一个命令。
 *
 *     node scripts/gate/cli.mjs install  [--repo <abs>]      # 安装/修复 wiring（设 core.hooksPath + 锚定 baseline）
 *     node scripts/gate/cli.mjs status   [--repo <abs>]      # 一眼看全：wiring / 台账 / 日志 / 对账
 *     node scripts/gate/cli.mjs audit    [--repo <abs>]      # 对账 + 两条链体检（CI 用；有问题 ⇒ 非零退出）
 *     node scripts/gate/cli.mjs hook <pre-commit|post-commit|post-checkout|post-merge|post-rewrite> [--repo <abs>]
 *     node scripts/gate/cli.mjs record  --level <R0|R1> --note "<一句话>" [--paths <p,p>] [--by <谁>] [--fingerprint <hex>]
 *     node scripts/gate/cli.mjs approve <id> --by <谁> [--note "<一句话>"]
 *     node scripts/gate/cli.mjs list    [--all] [--json]
 *     node scripts/gate/cli.mjs gate    --level <R0|R1|R2> [--paths <p,p>] [--json]
 *     node scripts/gate/cli.mjs ack-commit <sha> --by <谁> --note "<为什么可以接受>"
 *
 * 通用：`--repo <abs>`（治理哪棵树；缺省=本脚本所在树）  `--dir <abs>`（台账目录；缺省 out/pending-approval）
 *       `--json`  `--quiet`  `-h|--help`
 *
 * 退出码（★ 1 与 3 分开，让"被规则拦住"和"用法/IO/篡改"在 CI 里可区分）：
 *   0 = 放行 / 成功
 *   1 = **被拦住**（未批的 R0/R1，或台账被封条链判为被改过）
 *   3 = 用法错 / IO 错 / **发现了绕过或篡改**（钩子内部用；post-commit 的 3 不会被 git 当失败，但会记账）
 *
 * 分层与边界：见同目录 README.md。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as R from './core/repo.mjs'
import { Ledger, covers, blockingLevels } from './core/ledger.mjs'
import { Journal, banner } from './core/journal.mjs'
import * as P from './core/policy.mjs'

const NAME = 'gate-layer'
const SELF = fileURLToPath(import.meta.url)

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const has = (k) => argv.includes(k)

const USAGE = `${NAME} —— 门层统一入口（O110）

用法：
  node scripts/gate/cli.mjs <命令> [选项]

命令：
  install                安装/修复：git config core.hooksPath ${R.HOOKS_DIR_REL} + 锚定 baseline
  status                 一眼看全（wiring / 台账 / 日志 / 对账）
  audit                  对账 + 两条封条链体检（CI 用）
  hook <name>            git 钩子内部调用（pre-commit / post-commit / post-checkout / post-merge / post-rewrite）
  record --level ...     挂一张待批票（封条行）
  approve <id> --by ..   外部确认（**封条行**；只有封条 approve 才算有效批准）
  list                   列台账
  gate --level <L>       只看"能不能放行"
  ack-commit <sha> --by <谁> --note "<为什么这台提交可以接受>"
                         ★ 对账发现"门没看见过的提交"后，由**外部**显式确认它。
                           不是擦除：ack 是一条**带 by/note 的封条行**，永远留在日志里。

通用：--repo <abs>  --dir <abs>  --json  --quiet  -h|--help
退出码：0 放行/成功；1 被拦住；3 用法/IO/发现绕过或篡改`

const levelOk = (l) => ['R0', 'R1', 'R2'].includes(String(l ?? '').toUpperCase())

function resolveCtx() {
  const repo = R.resolveRepo({ cliRepo: argOf('--repo'), selfPath: SELF })
  if (!repo) {
    R.err(`${NAME}：取不到目标仓库根（用 --repo <abs> 或 DSH_GATE_REPO 显式给）`)
    return null
  }
  const dirArg = argOf('--dir')
  const dir = dirArg ? path.resolve(repo, dirArg) : null
  return { repo, dir }
}

// ─────────────────────────────────────────────────────────────────────────────
// 命令
// ─────────────────────────────────────────────────────────────────────────────

function cmdInstall(ctx) {
  const { repo } = ctx
  const hookDir = path.join(repo, R.HOOKS_DIR_REL)
  const need = ['pre-commit', 'post-commit']
  const missing = need.filter((h) => !R.fileExists(path.join(hookDir, h)))
  if (missing.length > 0) {
    R.err(`${NAME}：钩子文件缺失：${missing.join(', ')}（目录 ${R.toPosix(hookDir)}）`)
    return 3
  }
  // ★ 本树特有的一处收敛：值已经正确时**不重写**仓库配置。
  //   理由：core.hooksPath 住在【共享】的仓库配置里 ⇒ 本树（链接工作树）与主仓共用它；
  //   为了避免"在重放树里跑一次 install 就顺手改了主仓配置"，这里改成"只在不对时才写"。
  const cur = R.hooksPathOf(repo)
  let wrote = false
  if (cur !== R.HOOKS_DIR_REL) {
    const set = R.sh('git', ['-C', repo, 'config', 'core.hooksPath', R.HOOKS_DIR_REL])
    if (set.status !== 0) {
      R.err(`${NAME}：git config 失败：${String(set.stderr ?? '').trim()}`)
      return 3
    }
    wrote = true
  }
  const anchorDir = path.join(R.gitDirOf(repo), R.ANCHOR_DIR)
  fs.mkdirSync(anchorDir, { recursive: true })
  fs.mkdirSync(path.join(repo, 'out', 'gate'), { recursive: true })
  const journal = new Journal(repo)
  const head = R.headSha(repo)
  if (head && journal.baseline() === null) {
    const a = journal.append({ kind: 'baseline', commit: head, note: '安装门层时的起点提交：对账只算这台之后的提交' })
    R.say(`  baseline 已锚定：${head.slice(0, 12)}（对账起点）${a.ok ? '' : ` ★ 写入失败：${a.why}`}`)
  }
  R.say(`${NAME} install`)
  R.say(`  目标仓库        : ${R.toPosix(repo)}`)
  R.say(`  钩子目录        : ${R.toPosix(hookDir)}`)
  R.say(`  core.hooksPath  : ${R.hooksPathOf(repo)}${wrote ? '（本次写入）' : '（已是期望值 ⇒ 未改动配置）'}`)
  R.say(`  台账            : ${R.toPosix(new Ledger(repo, ctx.dir).file)}`)
  R.say(`  观察日志        : ${R.toPosix(path.join(repo, 'out', 'gate', 'journal.jsonl'))}`)
  R.say(`  锚点            : ${R.toPosix(anchorDir)}/*.anchor`)
  R.say('  ⇒ 现在起 `git commit` 走本层；`--no-verify` 会被 post-commit 记账；换 hooksPath 会被对账追上。')
  R.say('  ★ 提醒：core.hooksPath 是仓库本地配置（不进版本库）⇒ 新克隆要重跑本命令。')
  R.say(`  ★ 本树是链接工作树 ⇒ git 目录 = ${R.toPosix(R.gitDirOf(repo))}（锚点写在这里，工作树之外）`)
  return 0
}

function cmdStatus(ctx) {
  const { repo, dir } = ctx
  const journal = new Journal(repo)
  const ledger = new Ledger(repo, dir)
  const w = R.hooksWired(repo)
  const jv = journal.verify()
  const lv = ledger.verify()
  const rec = P.reconcile(repo, journal)
  const unsealed = ledger.unsealedApprovals()
  const era = ledger.sealEraStart()
  const legacy = ledger.legacyApprovals()
  const tamper = ledger.tamperApprovals()
  R.say(`${NAME} status`)
  R.say('── wiring ──────────────────────────────────────────────────────────────')
  R.say(`  目标仓库            : ${R.toPosix(repo)}`)
  R.say(`  core.hooksPath      : ${w.got === null ? '（未设 ⇒ 钩子不会被调用 ✗）' : `${w.got}${w.ok ? '  ✓' : '  ✗'}`}`)
  for (const h of ['pre-commit', 'post-commit', 'post-checkout', 'post-merge', 'post-rewrite']) {
    R.say(`  钩子 ${h.padEnd(14)}: ${R.fileExists(path.join(repo, R.HOOKS_DIR_REL, h)) ? '在 ✓' : '缺 ✗'}`)
  }
  R.say('── 台账（权限流） ──────────────────────────────────────────────────────')
  const fold = ledger.fold()
  R.say(`  文件                : ${R.toPosix(ledger.file)}`)
  R.say(`  记录                : 全部 ${fold.length} ／ 待批 ${fold.filter((r) => r.status === 'pending').length} ／ 有效批准 ${ledger.approvals().length} ／ ★未封条批准 ${unsealed.length}`)
  R.say(`  未封条批准分类      : legacy（封条时代之前·历史遗留，不作为放行证据）${legacy.length} 条${legacy.length ? `  ${legacy.map((r) => r.id).join(', ')}` : ''}`)
  R.say(`                        ★ tamper（封条时代之后仍无封条=可疑）${tamper.length} 条${tamper.length ? `  ★ ${tamper.map((r) => r.id).join(', ')}` : '  ✓'}`)
  R.say(`  封条时代起点        : ${era === null ? '（尚无封条时代 ⇒ 全部未封条批准均按 legacy 处理）' : `${era}（台账里第一条带 _c 的记录）`}`)
  R.say(`  封条链              : ${lv.ok ? `一致 ✓（${lv.sealedCount} 条封条行）` : `**不一致 ✗** ${[...lv.breaks.map((b) => `第${b.line}行${b.why}`), ...lv.anchorProblems].slice(0, 3).join('；')}`}`)
  for (const r of fold.slice(-6)) {
    R.say(`    [${r.status.padEnd(8)}${r.sealed ? ' sealed' : '       '}] ${r.id}  ${String(r.level).padEnd(3)} ${r.note.slice(0, 64)}`)
  }
  R.say('── 观察日志（事实流） ──────────────────────────────────────────────────')
  R.say(`  文件                : ${R.toPosix(journal.file)}`)
  R.say(`  封条链              : ${jv.ok ? `一致 ✓（${jv.sealedCount} 条封条行）` : `**不一致 ✗** ${[...jv.breaks.map((b) => `第${b.line}行${b.why}`), ...jv.anchorProblems].slice(0, 3).join('；')}`}`)
  R.say(`  条目                : baseline ${journal.count('baseline')} ／ allow ${journal.count('allow')} ／ block ${journal.count('block')} ／ seen ${journal.count('seen')} ／ ★bypass ${journal.count('bypass')} ／ ★hooks-drift ${journal.count('hooks-drift')} ／ ★tamper ${journal.count('tamper')}`)
  R.say('── 对账 ────────────────────────────────────────────────────────────────')
  if (!rec.installed) R.say('  未安装（没有 baseline）⇒ 先跑 install')
  else R.say(`  baseline            : ${String(rec.baseline).slice(0, 12)}`)
  R.say(`  门没看见过的提交    : ${rec.unaccounted.length} 条${rec.unaccounted.length ? `  ★ ${rec.unaccounted.map((s) => s.slice(0, 8)).join(', ')}` : '  ✓'}`)
  for (const b of journal.bypasses()) R.say(`  ★ bypass 记录       : ${String(b.commit).slice(0, 12)} [${b.level}]`)
  const fatal = !lv.ok || !jv.ok
  return fatal || rec.unaccounted.length > 0 ? 1 : 0
}

function cmdAudit(ctx) {
  const { repo, dir } = ctx
  const { journal, watch, audit, health } = P.enter(repo, { dir, quietWatchdog: has('--quiet'), quietAudit: true, quietLedger: true })
  R.say(`${NAME} audit`)
  R.say(`  仓库             : ${R.toPosix(repo)}`)
  R.say(`  hooksPath        : ${watch.ok ? `正确 ✓（${watch.got}）` : `**异常 ✗**: ${watch.why}`}`)
  R.say(`  台账封条链       : ${health.chain.ok ? `一致 ✓（${health.chain.sealedCount} 条封条）` : `**不一致 ✗**`}`)
  R.say(`  台账未封条批准   : ${health.unsealed.length} 条（legacy ${health.legacy.length} ／ ★tamper ${health.tamper.length}）`)
  R.say(`  台账·legacy      : ${health.legacy.length} 条${health.legacy.length ? `（封条时代${health.era === null ? '：尚无' : `起点 ${health.era}`} 之前的历史遗留，不作为放行证据，非告警）` : ' ✓'}`)
  R.say(`  台账·tamper      : ${health.tamper.length} 条${health.tamper.length ? `  ★ ${health.tamper.map((r) => r.id).join(', ')}` : ' ✓'}`)
  R.say(`  日志封条链       : ${journal.verify().ok ? '一致 ✓' : '**不一致 ✗**'}`)
  R.say(`  未记账提交       : ${audit.unaccounted.length} 条${audit.unaccounted.length ? `  ★ ${audit.unaccounted.map((s) => s.slice(0, 8)).join(', ')}` : ' ✓'}`)
  const bad = !watch.ok || !health.chain.ok || !journal.verify().ok || audit.unaccounted.length > 0 || health.tamper.length > 0
  R.say(`  ⇒ ${bad ? '**对账发现问题**（见上）' : '干净（无告警）'}  exit=${bad ? 3 : 0}`)
  return bad ? 3 : 0
}

function cmdHook(ctx, name) {
  const { repo, dir } = ctx
  const quiet = has('--quiet')
  switch (name) {
    case 'pre-commit': {
      const { journal, ledger } = P.enter(repo, { dir, quietWatchdog: quiet, quietAudit: quiet, quietLedger: quiet })
      const out = P.preCommit({ repo, ledger, journal })
      if (out.action === 'block') reportBlocked(ctx, out)
      return out.code
    }
    case 'post-commit': {
      const c = P.enter(repo, { dir, quietWatchdog: quiet, quietAudit: true, quietLedger: quiet, noAudit: true })
      const out = P.postCommit({ repo, ledger: c.ledger, journal: c.journal })
      // ★ 先记账(seen/bypass)再对账：否则会把本次刚造的提交误报成"未记账"。
      const rec = P.reconcile(repo, c.journal)
      P.shoutUnaccounted(repo, c.journal, rec, { quiet })
      return out.code
    }
    case 'post-checkout':
    case 'post-merge':
    case 'post-rewrite': {
      // 这些钩子是"额外机会"：只做体检 + 对账（不改提交、不拦）
      const { journal, watch, audit, health } = P.enter(repo, { dir, quietWatchdog: quiet, quietAudit: true, quietLedger: quiet })
      R.say(`${NAME} · ${name}（体检 + 对账）`)
      R.say(`  hooksPath : ${watch.ok ? 'ok ✓' : `异常 ✗ ${watch.why}`}`)
      R.say(`  未记账提交: ${audit.unaccounted.length}${audit.unaccounted.length ? ` ★ ${audit.unaccounted.map((s) => s.slice(0, 8)).join(', ')}` : ' ✓'}`)
      R.say(`  台账      : ${health.chain.ok ? '封条链 ok ✓' : '**封条链不一致 ✗**'}`)
      const bad = !watch.ok || audit.unaccounted.length > 0 || !health.chain.ok
      if (bad) return 3
      return 0
    }
    default:
      R.err(`${NAME}：未知钩子 "${name}"`)
      return 3
  }
}

function reportBlocked(ctx, out) {
  const { repo } = ctx
  R.err('')
  R.err('════════════════════════════════════════════════════════════════════════')
  if (out.mode === 'ledger-tamper') {
    R.err(`✗ pre-commit 拦住：**台账未通过封条校验（疑似被改过） ⇒ fail-closed**`)
    R.err('════════════════════════════════════════════════════════════════════════')
    for (const p of (out.health?.problems ?? []).slice(0, 6)) R.err(`  · ${p}`)
    R.err('  ★ 依据：scripts/gate/README.md「③ 台账：可绕但可发现」。')
    R.err('  ★ 这是刻意取舍：宁可堵死，也不"无声放行"。修好台账（或由外部重新锚定）后即可继续。')
    R.err(`  复核：node scripts/gate/cli.mjs status --repo "${R.toPosix(repo)}"`)
    R.err('')
    return
  }
  R.err(`✗ pre-commit 拦住：**未批的 ${out.level} 改动不许提交**（§6.2 无环原则）`)
  R.err('════════════════════════════════════════════════════════════════════════')
  R.err(`  判层：${out.level}（命中 ${[...new Set((out.inf?.hits ?? []).filter((h) => h.level === out.level).map((h) => h.ruleId))].join(' , ')}）`)
  if (out.mode === 'auto-record') {
    R.err(`  ★ 本层已**自动挂票**：${out.autoTicket ?? '(未取到 id)'}  status=pending  by=pre-commit`)
    R.err(`      note : ${out.note}`)
    R.err('      ★ 自动挂票 **不是**自动批准：仍须**独立见证者** approve 后才能再次提交。')
  }
  if (out.mode === 'auto-fail') R.err(`  ★ 自动挂票失败：${out.why} ⇒ fail-closed 拦住。`)
  for (const t of out.tickets ?? []) {
    R.err(`  ★ 那张票：${t.id} [${t.level}] status=${t.status}  ${t.note.slice(0, 80)}`)
    if (t.paths?.length) R.err(`      paths : ${t.paths.join(', ')}`)
  }
  R.err('  怎么放行（三条之一）：')
  const first = out.autoTicket ?? out.tickets?.[0]?.id
  if (first) R.err(`    ① 外部确认：node scripts/gate/cli.mjs approve ${first} --by <谁> --note "<一句>"`)
  else R.err('    ① 外部确认：node scripts/gate/cli.mjs approve <id> --by <谁>')
  R.err('    ② 若你认为这次改动其实是 R2：先纠正判层（改路径或改规则表）—— ★ 改规则表本身是一次 R1 改动。')
  R.err('    ③ `git commit --no-verify` 能跳过本钩子 —— 但 post-commit 会**记账并告警**（见 out/gate/journal.jsonl）。')
  R.err(`  复核：node scripts/gate/cli.mjs status --repo "${R.toPosix(repo)}"`)
  R.err('  ★ 本次提交被拦在 git 写任何东西之前 ⇒ 工作树与暂存区**原样未动**。')
  R.err('')
}

function cmdRecord(ctx) {
  const { repo, dir } = ctx
  const level = String(argOf('--level') ?? '').toUpperCase()
  const note = argOf('--note')
  if (!levelOk(level) || level === 'R2') {
    R.err(`${NAME}：record 的 --level 必须是 R0 或 R1（R2 不产生待批记录）`)
    return 3
  }
  if (!note || note.trim() === '') {
    R.err(`${NAME}：record 需要 --note "<一句话>"`)
    return 3
  }
  const paths = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--paths' && argv[i + 1]) paths.push(argv[i + 1])
  const fp = argOf('--fingerprint')
  if (paths.length > 0) {
    const inf = P.classify(repo, paths)
    const S = { R0: 0, R1: 1, R2: 2 }
    if (S[level] > S[inf.level]) {
      R.err(`${NAME}：拒绝 —— 声明 ${level} 比按路径推断的 ${inf.level} 更宽（层级不能自己降级，§6.2 条文①）`)
      return 3
    }
  }
  const journal = new Journal(repo)
  const health = P.ledgerHealth(new Ledger(repo, dir), journal, { quiet: true })
  if (health.fatal) {
    R.err(`${NAME}：台账封条链不一致 ⇒ 拒绝写入（先由外部修复/重新锚定）`)
    return 3
  }
  const ledger = new Ledger(repo, dir)
  const rec = ledger.record({ level, note: note.trim(), paths, fingerprint: fp, by: argOf('--by') ?? 'cli' })
  if (!rec.ok) {
    R.err(`${NAME}：追加失败：${rec.why}`)
    return 3
  }
  const id = lastPending(ledger)
  R.say(`${JSON.stringify({ ok: true, id, level, status: 'pending', sealedSeq: rec.seq })}`)
  R.say(`⇒ 已留一条**封条**待批记录 ${id}（${level}）。approve 之前 \`gate --level ${level}\` 会拦住。`)
  return 0
}

function lastPending(ledger) {
  const p = ledger.fold().filter((r) => r.status === 'pending')
  return p.length > 0 ? p[p.length - 1].id : null
}

function cmdApprove(ctx) {
  const { repo, dir } = ctx
  const id = argv[0] === 'approve' ? argv[1] : null
  if (!id || id.startsWith('--')) {
    R.err(`${NAME}：approve 需要 <id>`)
    return 3
  }
  const ledger = new Ledger(repo, dir)
  const rec = ledger.fold().find((r) => r.id === id)
  if (!rec) {
    R.err(`${NAME}：找不到待批记录 ${id}（不凭空批准）`)
    return 3
  }
  if (rec.status === 'approved' && rec.sealed) {
    R.say(`${JSON.stringify({ ok: true, id, status: 'already-approved', approvedBy: rec.approvedBy })}`)
    R.say(`⇒ ${id} 早已被 ${rec.approvedBy ?? '?'} 确认（封条行）⇒ 可以续跑。`)
    return 0
  }
  const by = argOf('--by') ?? process.env.USERNAME ?? process.env.USER ?? 'human'
  const a = ledger.approve({ id, level: rec.level, by, note: argOf('--note') ?? '' })
  if (!a.ok) {
    R.err(`${NAME}：追加失败：${a.why}`)
    return 3
  }
  R.say(`${JSON.stringify({ ok: true, id, level: rec.level, status: 'approved', approvedBy: by, sealedSeq: a.seq })}`)
  R.say(`⇒ ${id} 已被【外部】确认（${by}）⇒ 可以续跑。★ 批准行带封条（seq=${a.seq}，prev=${a.hash.slice(0, 12)}…）。`)
  return 0
}

function cmdList(ctx) {
  const { repo, dir } = ctx
  const ledger = new Ledger(repo, dir)
  const fold = ledger.fold()
  const shown = has('--all') ? fold : fold.filter((r) => r.status === 'pending')
  if (has('--json')) {
    R.say(`${JSON.stringify({ ok: true, total: fold.length, records: shown })}`)
    return 0
  }
  R.say(`台账 ${R.toPosix(ledger.file)}（全部 ${fold.length} ／ 待批 ${fold.filter((r) => r.status === 'pending').length} ／ 有效批准 ${ledger.approvals().length} ／ 未封条批准 ${ledger.unsealedApprovals().length}）`)
  for (const r of shown) {
    R.say(`  [${r.status.padEnd(8)}${r.sealed ? ' sealed' : '       '}] ${r.id}  ${String(r.level).padEnd(3)} ${r.createdAt ?? ''}  by:${r.by ?? '-'}`)
    R.say(`             ${r.note.slice(0, 100)}`)
    if (r.paths.length) R.say(`             paths: ${r.paths.join(', ')}`)
  }
  return 0
}

function cmdGate(ctx) {
  const { repo, dir } = ctx
  const level = String(argOf('--level') ?? '').toUpperCase()
  if (!levelOk(level)) {
    R.err(`${NAME}：gate 需要 --level <R0|R1|R2>`)
    return 3
  }
  const ledger = new Ledger(repo, dir)
  const journal = new Journal(repo)
  const health = P.ledgerHealth(ledger, journal, { quiet: true })
  const v = ledger.verify()
  if (level === 'R2') {
    R.say(`${JSON.stringify({ gate: 'PASS', level, blocking: [], fatal: health.fatal })}`)
    R.say('⇒ 放行（exit 0）：R2 不需要外部见证。')
    return 0
  }
  const levels = blockingLevels(level)
  const blocking = health.fatal ? [] : ledger.pendings(levels)
  const fatalNote = health.fatal ? ' ★ 但台账封条链不一致 ⇒ 视为被改过 ⇒ 一律不放行（fail-closed）' : ''
  const pass = blocking.length === 0 && !health.fatal
  R.say(`${JSON.stringify({ gate: pass ? 'PASS' : 'BLOCKED', level, blockingLevels: levels, blocking: blocking.map((r) => ({ id: r.id, level: r.level, note: r.note })), sealed: v.sealedCount, fatal: health.fatal })}`)
  if (pass) {
    R.say(`⇒ 放行（exit 0）：${level} 级没有未批记录，且台账封条链一致。`)
    return 0
  }
  R.say(`★★ 拦住（exit 1）：${level} 级有 ${blocking.length} 条未批记录${fatalNote}`)
  return 1
}

function cmdAckCommit(ctx) {
  const { repo } = ctx
  const sha = argv[1] && !argv[1].startsWith('--') ? argv[1] : null
  const by = argOf('--by')
  const note = argOf('--note')
  if (!sha || !by || !note || note.trim() === '') {
    R.err(`${NAME}：ack-commit 需要 <sha> --by <谁> --note "<为什么可以接受>"（三样都不能少 —— 确认必须留痕）`)
    return 3
  }
  const journal = new Journal(repo)
  const rec = P.reconcile(repo, journal)
  const full = rec.unaccounted.find((s) => s.startsWith(sha))
  if (!full) {
    R.err(`${NAME}：${sha} 不在当前"未记账提交"清单里（无需确认）`)
    return 3
  }
  const a = journal.append({ kind: 'ack', commit: full, by, note: note.trim() })
  if (!a.ok) {
    R.err(`${NAME}：追加失败：${a.why}`)
    return 3
  }
  R.say(`${JSON.stringify({ ok: true, commit: full, ackBy: by, sealedSeq: a.seq })}`)
  R.say(`⇒ 已把 ${full.slice(0, 12)} 记为**外部已确认**（by=${by}）。★ 不是擦除：日志里永远留着这条 ack（含理由）。`)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  if (has('-h') || has('--help') || argv.length === 0) {
    R.say(USAGE)
    return argv.length === 0 ? 3 : 0
  }
  const cmd = argv[0]
  if (cmd === 'hook') {
    const name = argv[1] ?? 'pre-commit'
    const ctx = resolveCtx()
    if (!ctx) return 3
    try {
      return cmdHook(ctx, name)
    } catch (e) {
      R.err(`${NAME} hook 内部错误：${String(e?.message ?? e)}`)
      return 3
    }
  }
  const ctx = resolveCtx()
  if (!ctx) return 3
  try {
    switch (cmd) {
      case 'install':
        return cmdInstall(ctx)
      case 'status':
        return cmdStatus(ctx)
      case 'audit':
        return cmdAudit(ctx)
      case 'record':
        return cmdRecord(ctx)
      case 'approve':
        return cmdApprove(ctx)
      case 'list':
        return cmdList(ctx)
      case 'gate':
        return cmdGate(ctx)
      case 'ack-commit':
        return cmdAckCommit(ctx)
      default:
        R.err(`${NAME}：未知命令 "${cmd}"\n\n${USAGE}`)
        return 3
    }
  } catch (e) {
    R.err(`${NAME} 内部错误：${String(e?.message ?? e)}`)
    return 3
  }
}

process.exit(main())
