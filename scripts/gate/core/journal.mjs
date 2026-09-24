#!/usr/bin/env node
/**
 * journal.mjs —— 门层的【观察日志】（"门看到了什么"）。
 *
 * 与 ledger.mjs 的分工（**统一审计模型 = 两条流**）：
 *   · ledger  —— **权限**：谁被允许提交什么（pending / approved）。
 *   · journal —— **事实**：门什么时候放行/拦住/发现绕过/做了对账。
 *   两者都是 ChainLog（同一底座）：同一套封条口径、同一套锚点规则。
 *
 * 条目种类（kind）：
 *   baseline        安装时锚定起点提交（对账只算这台之后的提交 ⇒ 不再把种子提交当"未记账"）
 *   allow           某批次被判为 R2，或被已批准记录覆盖 ⇒ 放行
 *   block           某批次被判 R0/R1 且无已批准记录覆盖 ⇒ 拦住
 *   seen            post-commit 观察到一次真实提交（记账：这次提交存在）
 *   bypass          ★ post-commit 发现"R0/R1 的提交，却没有已批准记录覆盖" ⇒ 有人绕过了 pre-commit
 *   hooks-drift     core.hooksPath 不再指向本层 ⇒ 告警
 *   audit           一次对账结果（未记账提交清单）
 *   ack             ★ 外部**显式确认**一台"未记账提交"（`cli ack-commit`）。不是擦除：带 by/note，永远留痕。
 *
 * ★ 锚点位置：`<git-dir>/dsh-gate/journal.anchor`（本树是链接工作树 ⇒ 不能用 `<tree>/.git/...`）。
 */
import path from 'node:path'
import { ChainLog } from './chain.mjs'
import { say, err, now, anchorFileOf } from './repo.mjs'

export const journalPaths = (repo) => ({
  file: path.join(repo, 'out', 'gate', 'journal.jsonl'),
  anchorFile: anchorFileOf(repo, 'journal'),
})

export class Journal {
  constructor(repo) {
    this.repo = repo
    const p = journalPaths(repo)
    this.file = p.file
    this.anchorFile = p.anchorFile
    this.log = new ChainLog({ file: p.file, anchorFile: p.anchorFile, name: 'journal' })
  }

  verify() {
    return this.log.verify()
  }

  entries() {
    return this.log.entries()
  }

  append(fields) {
    return this.log.append({ at: now(), ...fields })
  }

  /** 安装时锚定的起点提交（最后一条 baseline 生效）。 */
  baseline() {
    let b = null
    for (const e of this.entries()) if (e.kind === 'baseline' && typeof e.commit === 'string') b = e.commit
    return b
  }

  /** 已被门"看见"过的提交 sha 集合（seen + baseline + bypass 都算看见）。 */
  seenShas() {
    const s = new Set()
    for (const e of this.entries()) {
      if (e.kind === 'seen' && typeof e.commit === 'string') s.add(e.commit)
      if (e.kind === 'bypass' && typeof e.commit === 'string') s.add(e.commit)
      if (e.kind === 'baseline' && typeof e.commit === 'string') s.add(e.commit)
    }
    return s
  }

  /**
   * ★ 被**外部显式确认**过的未记账提交（`cli ack-commit`）。
   *   ack **不是擦除**：它是一条带 `by`/`note` 的封条行，永远留在日志里；
   *   它只让对账"不再重复把这台提交算作待处理"。⇒ 绕过仍然可发现（翻日志就能看到 ack 的 by/note）。
   */
  ackedShas() {
    const s = new Set()
    for (const e of this.entries()) if (e.kind === 'ack' && typeof e.commit === 'string') s.add(e.commit)
    return s
  }

  acks() {
    return this.entries().filter((e) => e.kind === 'ack')
  }

  /** 门是否已经"看见"过这次提交。 */
  sawCommit(sha) {
    return this.seenShas().has(sha)
  }

  /** 最近的 bypass 条目（给 status/audit 人性化展示）。 */
  bypasses() {
    return this.entries().filter((e) => e.kind === 'bypass')
  }

  count(kind) {
    return this.entries().filter((e) => e.kind === kind).length
  }
}

/** 一条告警横幅（绕过/漂移/篡改都用它，保证"绝不被静默"）。 */
export function banner(lines) {
  const bar = '★'.repeat(72)
  err('')
  err(bar)
  for (const l of lines) err(`★★ ${l}`)
  err(bar)
  err('')
}

export { say, err }
