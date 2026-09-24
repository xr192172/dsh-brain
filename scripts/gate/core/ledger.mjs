#!/usr/bin/env node
/**
 * ledger.mjs —— 门层的【审批台账】：谁被允许提交什么（pending / approved）。
 *
 * ★★ 与主仓既有的 `scripts/pending-approval.mjs` 的关系（**刻意保留两份**，理由如下）：
 *   · **同一份文件**：`out/pending-approval/records.jsonl`（目录/格式与 O107 兼容，用 `--dir` 可换）。
 *   · 本模块**只读**它 + 通过 ChainLog **追加封条行**；不改写、不删除任何历史行。
 *   · 主仓既有的 `pending-approval.mjs` **一字未改**，它写的行**没有封条** ⇒ 本模块把它们登记为
 *     `unsealed`。**未封条的 approve 不构成"已批准"**（见下）。
 *     这样做的理由：绕法③ 的病根就是"台账是本地可写文件 ⇒ 门判不了是谁批的"。
 *     本地无法给出可信身份（见 README「边界」），但可以让**伪造留下一道无法自洽的痕**：
 *     手写一行 approve ⇒ 缺封条 ⇒ 门**不认**并告警；连封条一起伪造 ⇒ 还要同步改 git 目录里的锚点。
 *     ★ 这是"提高伪造成本"，**不是"防得住有意伪造"** —— 残差如实写在 README。
 *
 * 批准判据（**两条口径写死**，与既有 O115/O107 的 covers() 一致，但**只认封条 approve**）：
 *   · 记录带 fingerprint ⇒ 指纹相等才算覆盖；
 *   · 记录不带 fingerprint（老式/手工票）⇒ 本批路径是其 paths 的子集才算覆盖。
 *
 * ★ 锚点位置（本树特有，见 repo.mjs:gitDirOf）：`<git-dir>/dsh-gate/ledger.anchor`。
 *   主仓这棵树是链接工作树 ⇒ `<tree>/.git` 是文件 ⇒ **不能用 `<tree>/.git/...`**。
 */
import path from 'node:path'
import { ChainLog } from './chain.mjs'
import { now, anchorFileOf } from './repo.mjs'

export const DEFAULT_LEDGER_DIR_REL = 'out/pending-approval'
export const LEDGER_FILE = 'records.jsonl'

export const ledgerPaths = (repo, dirAbs) => {
  const dir = dirAbs ?? path.join(repo, DEFAULT_LEDGER_DIR_REL)
  return { dir, file: path.join(dir, LEDGER_FILE), anchorFile: anchorFileOf(repo, 'ledger') }
}

export const STRICTNESS = { R0: 0, R1: 1, R2: 2 }

/** `gate --level L` 要拦住的：比 L 更严或同严的记录。 */
export const blockingLevels = (level) => (level === 'R0' ? ['R0'] : level === 'R1' ? ['R0', 'R1'] : [])

const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase()

/** 一条记录能否覆盖本批（见文件头两条口径）。 */
export function covers(rec, batch) {
  if (typeof rec.fingerprint === 'string' && rec.fingerprint !== '') {
    return String(rec.fingerprint).toLowerCase() === batch.fingerprint ? 'fingerprint' : null
  }
  const have = new Set((rec.paths ?? []).map(norm))
  if (have.size === 0) return null
  return batch.paths.every((p) => have.has(norm(p))) ? 'paths-subset' : null
}

export class Ledger {
  constructor(repo, dirAbs = null) {
    this.repo = repo
    const p = ledgerPaths(repo, dirAbs)
    this.dir = p.dir
    this.file = p.file
    this.anchorFile = p.anchorFile
    this.log = new ChainLog({ file: p.file, anchorFile: p.anchorFile, name: 'ledger' })
  }

  verify() {
    return this.log.verify()
  }

  /** fold 全部行 ⇒ 记录视图（后出现的 approve 生效；**记录该 approve 是否封条**）。 */
  fold() {
    const map = new Map()
    for (const e of this.log.entries()) {
      if (typeof e.id !== 'string') continue
      let r = map.get(e.id)
      if (!r) {
        r = {
          id: e.id,
          level: e.level ?? null,
          status: 'pending',
          sealed: false,
          note: e.note ?? '',
          paths: Array.isArray(e.paths) ? e.paths : [],
          fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : null,
          by: e.by ?? null,
          createdAt: e.at ?? null,
          approvedBy: null,
          approvedAt: null,
          approveNote: null,
        }
        map.set(e.id, r)
      }
      if (e.kind === 'approve' || e.status === 'approved') {
        r.status = 'approved'
        r.sealed = Object.prototype.hasOwnProperty.call(e, '_c') // ★ 只有封条行才可能是"有效批准"
        r.approvedBy = e.approvedBy ?? r.approvedBy
        r.approvedAt = e.at ?? r.approvedAt
        r.approveNote = e.note ?? r.approveNote
      } else if (e.level && r.level === null) {
        r.level = e.level
      }
    }
    return [...map.values()].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
  }

  /** ★ **有效批准**：status approved **且** approve 行带封条。 */
  approvals() {
    return this.fold().filter((r) => r.status === 'approved' && r.sealed)
  }

  /** 没封条的"已批准"——不是证据，是**告警对象**。 */
  unsealedApprovals() {
    return this.fold().filter((r) => r.status === 'approved' && !r.sealed)
  }

  pendings(levels = null) {
    return this.fold().filter((r) => r.status === 'pending' && (levels === null || levels.includes(r.level)))
  }

  /** 追加一条封条行。 */
  append(fields) {
    return this.log.append(fields)
  }

  record({ level, note, paths = [], fingerprint = null, by = 'cli' }) {
    return this.append({
      schema: 'dsh-pending-approval/v1',
      kind: 'record',
      id: newId(),
      level,
      status: 'pending',
      note,
      paths,
      ...(fingerprint ? { fingerprint } : {}),
      by,
      source: 'record',
      at: now(),
    })
  }

  approve({ id, level = null, by, note = '' }) {
    return this.append({
      schema: 'dsh-pending-approval/v1',
      kind: 'approve',
      id,
      ...(level ? { level } : {}),
      status: 'approved',
      approvedBy: by,
      note,
      at: now(),
      source: 'approve',
    })
  }
}

export function newId() {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `pa-${ymd}-${Math.random().toString(16).slice(2, 8)}`
}
