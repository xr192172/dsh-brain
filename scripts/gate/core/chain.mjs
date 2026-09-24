#!/usr/bin/env node
/**
 * chain.mjs —— ★ 门层的【统一底座】：防篡改的 append-only JSONL 日志。
 *
 * 设计边界（**先读这段再看代码**）：
 *   · 本模块**只做一件事**：让"这一行是不是我按顺序写下去的"可被独立复核。
 *   · 它**不做**策略判定（谁该被批、哪条路径是 R1）—— 那是 policy.mjs。
 *   · 它**不做**身份认证 —— 本地没有任何可信身份源（见 scripts/gate/README.md「边界」）。
 *
 * 契约（写死，可反驳）：
 *   每条**封条行**带 `_c: { seq, prev, hash }`
 *     seq  —— 从 1 开始的连续序号（只数封条行）
 *     prev —— 上一条封条行的 hash；首条为字符串 "GENESIS"
 *     hash —— sha256( canonical(obj 去掉 _c) )，canonical = 递归按 key 排序的 JSON
 *   ★ 没有 `_c` 的行 = **未封条行**（unsealed）：本模块**不改写也不删除**它（append-only 的历史
 *     不允许被"修好"），但会**如实登记**它；它**不能**用来证明任何"已批准"（见 ledger.mjs）。
 *
 * 锚点（anchor）：
 *   把 { sealedCount, headHash } 写在工作树【之外】（调用方给路径；本层用 git 目录下的
 *   `dsh-gate/*.anchor`，见 repo.mjs:gitDirOf）。
 *   目的：① 截断（少了几行）② 重写（head 变了）都不再隐形 —— 两者都会与锚点不符。
 *   ★ 诚实：锚点仍是本地可写文件。它能防"随手改"，**不能**防"知情且同步改两处"。
 *     这条残差写在 scripts/gate/README.md，不在这里假装已闭环。
 *
 * 只读 git 之外什么都不碰；append 时先 verify()，链已坏 ⇒ **拒绝追加**（fail-closed）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const GENESIS = 'GENESIS'

/** 递归 canonical（key 排序）——让"同一条记录"只有一种字节表示，hash 才有意义。 */
export function canonical(v) {
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'number' || t === 'boolean') return JSON.stringify(v)
  if (t === 'string') return JSON.stringify(v)
  if (t === 'undefined') return 'null'
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
}

export const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

/** 一条封条行的 hash（对"去掉 _c 的对象"取 canonical sha256）。 */
export function lineHash(obj) {
  const { _c, ...rest } = obj
  return sha256(canonical(rest))
}

const readJsonSafe = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export class ChainLog {
  /**
   * @param {{file:string, anchorFile:string, name:string}} o
   */
  constructor({ file, anchorFile, name }) {
    this.file = file
    this.anchorFile = anchorFile
    this.name = name
  }

  /** 逐行读；坏行**不静默吞掉**（计数并原样保留）。 */
  read() {
    let text = ''
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return { objects: [], corrupt: [], missing: true }
      throw e
    }
    const objects = []
    const corrupt = []
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.trim() === '') return
      try {
        const o = JSON.parse(line)
        if (o && typeof o === 'object' && !Array.isArray(o)) objects.push(o)
        else corrupt.push({ line: i + 1, text: line.slice(0, 200) })
      } catch {
        corrupt.push({ line: i + 1, text: line.slice(0, 200) })
      }
    })
    return { objects, corrupt, missing: false }
  }

  anchor() {
    const a = readJsonSafe(this.anchorFile)
    if (!a || typeof a !== 'object') return null
    if (typeof a.sealedCount !== 'number' || typeof a.headHash !== 'string') return null
    return a
  }

  /**
   * 校验：逐行重算链条 + 与锚点比对。
   * @returns {{ok:boolean, sealedCount:number, headHash:string, unsealed:object[],
   *            breaks:{line:number, why:string}[], corrupt:object[], anchor:object|null,
   *            anchorProblems:string[]}}
   */
  verify() {
    const { objects, corrupt, missing } = this.read()
    const breaks = []
    const unsealed = []
    let seq = 1
    let prev = GENESIS
    let sawAny = false
    for (let i = 0; i < objects.length; i += 1) {
      const o = objects[i]
      const ln = i + 1
      const c = o._c
      if (!c || typeof c !== 'object') {
        unsealed.push({ line: ln, kind: o.kind ?? '(无 kind)', id: o.id ?? '(无 id)' })
        continue
      }
      sawAny = true
      if (c.seq !== seq) breaks.push({ line: ln, why: `seq 期望 ${seq}，实为 ${JSON.stringify(c.seq)}` })
      if (c.prev !== prev) breaks.push({ line: ln, why: `prev 期望 ${prev}，实为 ${JSON.stringify(c.prev)}` })
      const want = lineHash(o)
      if (c.hash !== want) breaks.push({ line: ln, why: `hash 与内容不符（记录 ${JSON.stringify(c.hash)}，重算 ${want}）⇒ 该行内容被改过` })
      // 重同步到**声明值**，避免一行坏导致后面全报错（只要报出精确的第一处）
      seq = (typeof c.seq === 'number' ? c.seq : seq) + 1
      prev = typeof c.hash === 'string' ? c.hash : prev
    }
    const sealedCount = sawAny ? seq - 1 : 0
    const headHash = sawAny ? prev : GENESIS

    const anchor = this.anchor()
    const anchorProblems = []
    if (anchor === null) {
      if (sealedCount > 0) {
        anchorProblems.push(`锚点缺失（${path.basename(this.anchorFile)} 读不到）但日志里有 ${sealedCount} 条封条行 ⇒ 疑似锚点被删`)
      }
    } else {
      if (anchor.sealedCount !== sealedCount) {
        anchorProblems.push(`锚点 sealedCount=${anchor.sealedCount} 与实算 ${sealedCount} 不符 ⇒ 日志被截断或补写`)
      }
      if (anchor.headHash !== headHash) {
        anchorProblems.push(`锚点 headHash=${anchor.headHash} 与实算 ${headHash} 不符 ⇒ 封条行被改写`)
      }
    }
    const ok = breaks.length === 0 && corrupt.length === 0 && anchorProblems.length === 0
    return { ok, sealedCount, headHash, unsealed, breaks, corrupt, missing, anchor, anchorProblems }
  }

  /** 写锚点（`{sealedCount, headHash, at}`）。 */
  #writeAnchor(sealedCount, headHash) {
    fs.mkdirSync(path.dirname(this.anchorFile), { recursive: true })
    fs.writeFileSync(
      this.anchorFile,
      `${JSON.stringify({ schema: 'dsh-gate-anchor/v1', log: this.name, sealedCount, headHash, at: new Date().toISOString() })}\n`,
      'utf8',
    )
  }

  /**
   * 追加一条**封条行**。
   * ★ fail-closed：链已坏（或被截断）⇒ **拒绝追加**并返回 {ok:false}（不"先修好再说"）。
   * @returns {{ok:true, seq:number, hash:string} | {ok:false, why:string}}
   */
  append(fields) {
    const v = this.verify()
    if (!v.ok) {
      const why = [...v.breaks.map((b) => `第${b.line}行 ${b.why}`), ...v.anchorProblems, ...v.corrupt.map((c) => `第${c.line}行不是合法 JSON`)]
        .slice(0, 4)
        .join('；')
      return { ok: false, why: `链未通过校验 ⇒ 拒绝追加（fail-closed）：${why}` }
    }
    const obj = { ...fields, _c: { seq: v.sealedCount + 1, prev: v.headHash } }
    obj._c.hash = lineHash(obj)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, `${JSON.stringify(obj)}\n`, 'utf8')
    this.#writeAnchor(obj._c.seq, obj._c.hash)
    return { ok: true, seq: obj._c.seq, hash: obj._c.hash }
  }

  /** 只读遍历（含未封条行）—— 供 policy/ledger 折叠用。 */
  entries() {
    return this.read().objects
  }
}
