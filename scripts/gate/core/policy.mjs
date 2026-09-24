#!/usr/bin/env node
/**
 * policy.mjs —— 门层的【唯一策略入口】。所有钩子与命令都只调用这里的函数：
 *
 *   watchdog()          core.hooksPath 还在不在本层手里（绕法② 的告警面）
 *   reconcile()         对账：git 历史里有没有"门没看见过"的提交（绕法② 的发现面）
 *   shoutUnaccounted()  对账结果的告警呈现（**不去重**：只要还有未记账提交，每次进门都出声）
 *   ledgerHealth()      台账封条链 + 未封条 approve（绕法③ 的发现面）
 *   preCommit()         提交前：判层 → 过台账 → 放行／拦住（并自动挂票）
 *   postCommit()        ★ 提交后：git **仍然会跑 post-commit**（`--no-verify` 也照跑）
 *                       ⇒ 这里是绕法① 的兜底观察点：R0/R1 的提交若没有已批准记录覆盖 ⇒ **记账 + 告警**
 *
 * 为什么是这几个函数：见 scripts/gate/README.md 的分层图与"可绕但可发现"契约。
 * 判层规则**单一来源**仍是 `scripts/change-classify.mjs`（逐字复用，不另写一套）。
 */
import { classifyPaths } from '../../change-classify.mjs'
import { Ledger, covers, blockingLevels } from './ledger.mjs'
import { Journal, banner } from './journal.mjs'
import * as R from './repo.mjs'

export const classify = (repo, paths) => classifyPaths(paths, { root: repo })

// ─────────────────────────────────────────────────────────────────────────────
// watchdog —— 绕法② 的告警面
// ─────────────────────────────────────────────────────────────────────────────

/** 每一条钩子/命令进来都先跑：hooksPath 若不再指向本层 ⇒ 记一条 + 大声告警。 */
export function watchdog(repo, journal, { quiet = false } = {}) {
  const w = R.hooksWired(repo)
  if (w.ok) return { ok: true, ...w, reported: false }
  const last = [...journal.entries()].reverse().find((e) => e.kind === 'hooks-drift')
  const reported = last && last.got === w.got
  if (!reported) {
    journal.append({ kind: 'hooks-drift', got: w.got, want: R.HOOKS_DIR_REL, why: w.why })
  }
  if (!quiet) {
    banner([
      `门层告警（hooks-drift）：${w.why}`,
      '★ 后果：git 现在【不会调用本层钩子】⇒ 提交路径上的拦截失效。',
      `  修：node scripts/gate/cli.mjs install --repo "${R.toPosix(repo)}"`,
      '★ 这条告警本身**已经记账**（out/gate/journal.jsonl: kind=hooks-drift）；对账也会继续追。',
    ])
  }
  return { ok: false, ...w, reported: !last }
}

// ─────────────────────────────────────────────────────────────────────────────
// reconcile —— 绕法② 的发现面（对账：git 历史 vs 观察日志）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 找出"门从没看见过"的提交。
 * ★ 证据来自 **git 自己的对象库**（提交就在那里），不是我们的可写文件 ⇒ 删不掉、改不白。
 *   `-c core.hooksPath=<别处>` 会把 pre-commit/post-commit **一起**换掉 ⇒ 提交当场无告警，
 *   但下一次任何钩子被触发（或 `cli audit`）时，这里必然对上账。
 */
export function reconcile(repo, journal) {
  const baseline = journal.baseline()
  if (baseline === null) return { installed: false, ok: true, unaccounted: [], reportedNow: [], why: '未安装（日志里没有 baseline）' }
  const cs = R.commitsSince(repo, baseline)
  if (!cs.ok) return { installed: true, ok: false, unaccounted: [], reportedNow: [], why: cs.why }
  const seen = journal.seenShas()
  const acked = journal.ackedShas()
  const unaccounted = cs.shas.filter((s) => !seen.has(s) && !acked.has(s))
  const already = new Set()
  for (const e of journal.entries()) if (e.kind === 'audit' && Array.isArray(e.unaccounted)) for (const s of e.unaccounted) already.add(s)
  const reportedNow = unaccounted.filter((s) => !already.has(s))
  if (reportedNow.length > 0) {
    journal.append({ kind: 'audit', unaccounted, reportedNow, baseline, note: '对账：git 历史里有门没看见过的提交' })
  }
  return { installed: true, ok: unaccounted.length === 0, unaccounted, reportedNow, baseline, why: '' }
}

/**
 * 对账结果的告警呈现。
 * ★ 口径（刻意选"吵"）：**只要还有未记账提交，每一次"进门"都出声**。
 *   只把【新发现】写进日志（避免日志被重复条目灌满），但**告警不去重** ——
 *   否则"报过一次之后就一直沉默"，等于把持续存在的绕过洗成了噪音。
 */
export function shoutUnaccounted(repo, journal, rec, { quiet = false } = {}) {
  const all = rec.unaccounted ?? []
  if (quiet || all.length === 0) return false
  const fresh = new Set(rec.reportedNow ?? [])
  const detail = all
    .slice(0, 6)
    .map((sha) => `${fresh.has(sha) ? '★新' : ' 旧'} · ${sha.slice(0, 12)} ${R.git(repo, ['log', '-1', '--format=%s', sha]).stdout.trim()}`)
  banner([
    `对账告警：git 历史里有 ${all.length} 次提交【门没有看见过】${fresh.size ? `（其中本次新发现 ${fresh.size} 次）` : ''}`,
    '★ 最常见成因：`git -c core.hooksPath=<别处> commit`（换掉钩子目录 ⇒ 钩子全不跑）。',
    '★ 这不是"没发生"，而是"发生在这道门够不到的地方" —— 已记账（kind=audit）。',
    ...detail,
    `  复核：node scripts/gate/cli.mjs audit --repo "${R.toPosix(repo)}"`,
  ])
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// 台账健康 —— 绕法③ 的发现面
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 台账两条独立检查：
 *   A. 封条链 + 锚点（git 目录下的 ledger.anchor）⇒ 断链/截断/改写 = 真篡改 ⇒ **fail-closed**
 *   B. 未封条的 approve ⇒ **不构成"已批准"**；★ **再分两类**（只改判定与告警，不碰台账数据）：
 *        · `legacy`（封条时代起点**之前**）= 历史遗留 ⇒ 如实登记，**不报 tamper**、不吓人；
 *        · `tamper`（封条时代起点**之后**仍无封条）= 真可疑 ⇒ 才报 tamper。
 *      时代起点 = 台账里**第一条带 `_c` 的记录**的时间（从数据里推，不新增记录；无封条 ⇒ null）。
 */
export function ledgerHealth(ledger, journal, { quiet = false } = {}) {
  const v = ledger.verify()
  const unsealed = ledger.unsealedApprovals()
  const era = ledger.sealEraStart()
  const legacy = ledger.legacyApprovals()
  const tamper = ledger.tamperApprovals()
  const problems = []
  if (!v.ok) {
    problems.push(...v.breaks.map((b) => `台账第 ${b.line} 行：${b.why}`))
    problems.push(...v.anchorProblems)
    problems.push(...v.corrupt.map((c) => `台账第 ${c.line} 行不是合法 JSON`))
  }
  // ★ 只有【封条时代之后】的无封条 approve 才算可疑 —— 那才是"封条机制已生效还敢手写一行"。
  if (tamper.length > 0) {
    problems.push(
      `台账里有 ${tamper.length} 条**封条时代（${era}）之后**仍无封条的 approve：${tamper.map((r) => r.id).join(', ')}` +
        `（封条机制已生效 ⇒ 这才判为伪造/篡改；且不构成有效批准）`,
    )
  }
  const info =
    legacy.length > 0
      ? `另有 ${legacy.length} 条**封条时代之前**的无封条 approve（历史遗留，不作为放行证据；如实登记，不报 tamper）：${legacy.map((r) => r.id).join(', ')}`
      : null
  // ★ 只有 legacy（无真问题）⇒ 干净返回、不记 tamper、**不在提交路径出声**（不吓人）；
  //   legacy 记在返回值里，由 status/audit 如实报出（见 cli.mjs）。
  if (problems.length === 0) {
    return { ok: true, chain: v, unsealed, legacy, tamper, era, info, fatal: false, problems }
  }

  const fatal = !v.ok
  const dedupeKey = problems.join('|')
  const last = [...journal.entries()].reverse().find((e) => e.kind === 'tamper')
  if (!(last && last.dedupeKey === dedupeKey)) {
    journal.append({ kind: 'tamper', fatal, where: 'ledger', dedupeKey, problems, ...(info ? { legacyIds: legacy.map((r) => r.id) } : {}) })
  }
  if (!quiet) {
    banner([
      `门层告警（台账 ${fatal ? '被封条链判为【被改过】' : '里有【封条时代之后】的无封条 approve'}）：`,
      ...problems.slice(0, 5).map((p) => `  · ${p}`),
      ...(info ? [`  · （另：${info}）`] : []),
      fatal
        ? '★ 封条链/锚点不一致 ⇒ 视为"台账被改过" ⇒ 本次提交**一律拦住**（fail-closed，不无声放行）。'
        : '★ 封条机制已生效还写无封条 approve ⇒ 视为伪造 ⇒ **不作为放行证据**（伪造者少做了一步：没写链）。',
      '★ 已记账（kind=tamper）。复核：node scripts/gate/cli.mjs status',
    ])
  }
  return { ok: false, chain: v, unsealed, legacy, tamper, era, info, fatal, problems }
}

// ─────────────────────────────────────────────────────────────────────────────
// preCommit —— 默认路径上的条件门（拦）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {{action:'allow'|'block', code:number, level:string, ...}}
 */
export function preCommit({ repo, ledger, journal }) {
  const batch = R.stagedBatch(repo)
  if (!batch.ok) {
    R.err(`门层：读暂存区失败（${batch.why}）⇒ 本步**放行**（不假装通过，也不堵死正常提交）`)
    return { action: 'allow', code: 0, level: '?', why: 'staged-unreadable' }
  }
  if (batch.paths.length === 0) {
    return { action: 'allow', code: 0, level: 'R2', batch, why: 'empty-staging' }
  }
  const inf = classify(repo, batch.paths)
  const level = inf.level

  R.say('════════════════════════════════════════════════════════════════════════')
  R.say('gate-layer · pre-commit（判层 → 台账 → 放行／拦住）')
  R.say(`  被判仓库  : ${R.toPosix(repo)}`)
  R.say(`  暂存改动  : ${batch.paths.length} 条`)
  for (const p of batch.paths.slice(0, 12)) R.say(`      · ${p}`)
  if (batch.paths.length > 12) R.say(`      · …（共 ${batch.paths.length} 条）`)
  R.say(`  判层      : **${level}**（${inf.ruleCounts.R0}×R0 / ${inf.ruleCounts.R1}×R1 / ${inf.ruleCounts.R2}×R2）`)
  for (const h of inf.hits.slice(0, 6)) R.say(`      [${h.ruleId}] ${h.level} ← ${h.path}`)
  R.say(`  批次指纹  : ${batch.fingerprint}`)

  // 绕法③：台账健康（链坏了 ⇒ 一律拦；有未封条 approve ⇒ 不当作证据）
  const health = ledgerHealth(ledger, journal)
  if (health.fatal) return { action: 'block', code: 1, level, batch, inf, mode: 'ledger-tamper', health }

  if (level === 'R2') {
    R.say('  ⇒ 放行（exit 0）：R2 = 能力层 ⇒ 判据阶梯自动 ⇒ 无需外部见证。')
    journal.append({ kind: 'allow', level, paths: batch.paths, fingerprint: batch.fingerprint, by: 'pre-commit' })
    return { action: 'allow', code: 0, level, batch, inf }
  }

  const pend = ledger.pendings(blockingLevels(level))
  const approvals = ledger.approvals().filter((r) => covers(r, batch))
  if (approvals.length > 0) {
    R.say(`  ⇒ 放行（exit 0）：台账里有**封条 approve** 覆盖本批（${approvals.map((r) => `${r.id} by ${r.approvedBy ?? '-'} 按 ${covers(r, batch)}`).join(' , ')}）`)
    journal.append({ kind: 'allow', level, paths: batch.paths, fingerprint: batch.fingerprint, approvedBy: approvals.map((r) => r.approvedBy).join(','), by: 'pre-commit' })
    return { action: 'allow', code: 0, level, batch, inf, approvals }
  }
  if (pend.length > 0) {
    journal.append({ kind: 'block', level, paths: batch.paths, fingerprint: batch.fingerprint, mode: 'pending-exists', tickets: pend.map((r) => r.id), by: 'pre-commit' })
    return { action: 'block', code: 1, level, batch, inf, mode: 'pending-exists', tickets: pend }
  }

  // 自动挂票（钩子自己判、自己挂；★ 从不写 approve）
  const ruleIds = [...new Set(inf.hits.filter((h) => h.level === level).map((h) => h.ruleId))]
  const note =
    `[auto] pre-commit 自动挂票：暂存改动按【实际路径】判为 ${level}` +
    `${ruleIds.length ? `（命中 ${ruleIds.join(' , ')}）` : ''} ⇒ 在【独立见证者】approve 之前不许提交（§6.2 无环原则）。` +
    `自动挂票 ≠ 自动批准。`
  const rec = ledger.record({ level, note, paths: batch.paths, fingerprint: batch.fingerprint, by: 'pre-commit' })
  const tickets = rec.ok ? [rec.seq] : []
  journal.append({ kind: 'block', level, paths: batch.paths, fingerprint: batch.fingerprint, mode: 'auto-record', tickets, by: 'pre-commit', recordOk: rec.ok })
  if (!rec.ok) {
    R.err(`门层：自动挂票失败（${rec.why}）⇒ fail-closed 拦住。`)
    return { action: 'block', code: 1, level, batch, inf, mode: 'auto-fail', why: rec.why }
  }
  return { action: 'block', code: 1, level, batch, inf, mode: 'auto-record', autoTicket: lastTicketId(ledger), note }
}

function lastTicketId(ledger) {
  const p = ledger.fold().filter((r) => r.status === 'pending')
  return p.length > 0 ? p[p.length - 1].id : null
}

// ─────────────────────────────────────────────────────────────────────────────
// postCommit —— ★ 绕法① 的兜底观察点（`--no-verify` 也会跑到这里）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `git commit --no-verify` 的定义就是"跳过 pre-commit 与 commit-msg"，**post-commit 不在其中**
 * （实测见 out/_merge/REPORT.md 判据2）。所以这里是"绕过 ①"的必经之处：一次真实的 R0/R1 提交
 * 若没有已批准记录覆盖 ⇒ **记账 + 大声告警 + 挂一张 pending 票**（让后续提交继续被拦）。
 */
export function postCommit({ repo, ledger, journal }) {
  const head = R.headSha(repo)
  if (head === null) return { action: 'skip', code: 0, why: 'no-head' }

  const cb = R.commitBatch(repo, head)
  if (!cb.ok) {
    R.err(`门层：读本次提交的改动失败（${cb.why}）⇒ 不假装看见，也不堵死。`)
    return { action: 'skip', code: 0, why: 'commit-unreadable' }
  }
  // ★ 无论判层结果如何，都先把"我看见过这次提交"记账（这是对账的基线）
  if (!journal.sawCommit(head)) journal.append({ kind: 'seen', commit: head, paths: cb.paths, by: 'post-commit' })

  const inf = classify(repo, cb.paths)
  R.say('════════════════════════════════════════════════════════════════════════')
  R.say('gate-layer · post-commit（★ 观察点：`--no-verify` 也照跑）')
  R.say(`  提交      : ${head.slice(0, 12)}  ${R.git(repo, ['log', '-1', '--format=%s', head]).stdout.trim()}`)
  R.say(`  改动路径  : ${cb.paths.length} 条 → 判层 **${inf.level}**`)
  R.say(`  提交指纹  : ${cb.fingerprint}`)

  if (inf.level === 'R2') {
    R.say('  ⇒ R2 提交：无需外部见证（记账 kind=seen）。')
    return { action: 'ok', code: 0, level: 'R2', commit: head }
  }

  const health = ledgerHealth(ledger, journal)
  if (health.fatal) return { action: 'alert', code: 3, level: inf.level, commit: head, mode: 'ledger-tamper', health }

  const approvals = ledger.approvals().filter((r) => covers(r, cb))
  if (approvals.length > 0) {
    R.say(`  ⇒ ${inf.level} 提交已被封条 approve 覆盖（${approvals.map((r) => r.id).join(', ')}）⇒ 合法。`)
    return { action: 'ok', code: 0, level: inf.level, commit: head, approvals }
  }

  // ★★ 绕过被发现
  const ticket = ledger.record({
    level: inf.level,
    note:
      `[bypass] post-commit 发现：提交 ${head.slice(0, 12)} 把 ${inf.level} 改动落了地，` +
      `而台账里**没有**覆盖它的封条 approve ⇒ 这次提交**没走 pre-commit 门**（典型：git commit --no-verify）。` +
      `本票由 post-commit 自动挂出；在当前票被外部处理前，后续 R0/R1 提交继续被拦。`,
    paths: cb.paths,
    fingerprint: cb.fingerprint,
    by: 'post-commit',
  })
  journal.append({ kind: 'bypass', level: inf.level, commit: head, paths: cb.paths, fingerprint: cb.fingerprint, how: 'commit-without-approval', ticket: ticket.ok ? ticket.seq : null })
  banner([
    `★★ 绕过告警：${inf.level} 提交落地，但没有已批准记录 ⇒ 这次提交【绕过了 pre-commit 门】`,
    `  提交 ${head}  ${R.git(repo, ['log', '-1', '--format=%s', head]).stdout.trim()}`,
    `  判层 ${inf.level}（命中 ${[...new Set(inf.hits.filter((h) => h.level === inf.level).map((h) => h.ruleId))].join(' , ')}）`,
    '  典型成因：`git commit --no-verify`（该选项只跳过 pre-commit / commit-msg，**post-commit 照跑**）。',
    '★ 已记账（out/gate/journal.jsonl: kind=bypass），并已挂一张 pending 票 ⇒ 后续 R0/R1 提交继续被拦。',
    `  复核：node scripts/gate/cli.mjs status --repo "${R.toPosix(repo)}"`,
  ])
  return { action: 'alert', code: 3, level: inf.level, commit: head, mode: 'bypass', ticket: ticket.ok ? ticket.seq : null }
}

// ─────────────────────────────────────────────────────────────────────────────
// 组合：一次"进门"要做的三件事（供钩子/命令复用）
// ─────────────────────────────────────────────────────────────────────────────

export function enter(repo, { dir = null, quietWatchdog = false, quietAudit = false, quietLedger = false, noAudit = false } = {}) {
  const journal = new Journal(repo)
  const ledger = new Ledger(repo, dir)
  const watch = watchdog(repo, journal, { quiet: quietWatchdog })
  const health = ledgerHealth(ledger, journal, { quiet: quietLedger })
  // ★ post-commit 必须**先记账(seen)再对账**，否则会把自己刚造的提交报成"未记账"（假阳性）。
  //   所以 post-commit 传 noAudit=true，自己在 postCommit() 之后调 reconcile()。
  const audit = noAudit ? { installed: true, ok: true, unaccounted: [], reportedNow: [], why: 'deferred' } : reconcile(repo, journal)
  if (!noAudit) shoutUnaccounted(repo, journal, audit, { quiet: quietAudit })
  return { journal, ledger, watch, audit, health }
}
