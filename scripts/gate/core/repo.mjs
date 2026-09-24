#!/usr/bin/env node
/**
 * repo.mjs —— 门层的【git 探针】：仓库根、批次（batch）、指纹、hooksPath、**git 目录**。
 *
 * ★ 本文件是 O110 在主仓语境下的重放件（不是照搬 B2 的隔离树版本），差异见 scripts/gate/README.md §6：
 *   · 主仓这棵树是 **git 链接工作树（linked worktree）**：`<tree>/.git` 是一个**文件**而不是目录
 *     （内容是 `gitdir: <主仓>/.git/worktrees/<name>`）。B2 的隔离树是独立仓库 ⇒ 它把锚点写成
 *     `path.join(repo, '.git', 'dsh-gate')`，在链接工作树里会直接 ENOTDIR。
 *     ⇒ 本层统一用 `gitDirOf()`（`git rev-parse --absolute-git-dir`，**每个工作树各自的 git 目录**）。
 *
 * ★ 关于"硬编码判据根"：本层**没有任何绝对路径常量**。仓库根由 `--repo` > 环境 `DSH_GATE_REPO`
 *   > 从脚本自身位置向上找含 `.git` 的目录，三选一解析 ⇒ 同一套门可以治理任意一棵树。
 *
 * ★ 批次的定义（两条，写死）：
 *   · staged batch  —— `git diff --cached` 的路径（提交【前】看得到的东西）
 *   · commit batch  —— `git diff <parent> <rev>` 的路径（提交【后】真正落地的东西）
 *   指纹 = 路径集合 + 每条路径在对应版本里的 (mode:blobSha)。索引与提交里同一内容的 blob sha 相同
 *   ⇒ 两个批次可用同一个口径比对（这是 post-commit 能判断"这次提交是否被 pre-commit 放行过"的基础）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

/** 期望的钩子目录（相对仓库根）—— 与 core.hooksPath 的值比对。 */
export const HOOKS_DIR_REL = 'scripts/git-hooks'

/** 锚点目录名（位于 git 目录之内 ⇒ 在工作树【之外】）。 */
export const ANCHOR_DIR = 'dsh-gate'

export const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

export const say = (s = '') => process.stdout.write(`${s}\n`)
export const err = (s = '') => process.stderr.write(`${s}\n`)
export const now = () => new Date().toISOString()
export const toPosix = (p) => String(p).replace(/\\/g, '/')

function git(repo, args) {
  const r = sh('git', ['-C', repo, ...args])
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error }
}

export { git }

export function repoRootOf(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel'])
  const s = r.stdout.trim()
  return r.status === 0 && s ? toPosix(s) : null
}

/**
 * ★ 本仓库的 **git 目录**绝对路径（链接工作树 ⇒ 是 `<主仓>/.git/worktrees/<name>`，不是 `<tree>/.git`）。
 *   锚点写在这里：它在工作树之外（工作树里改不到），但仍是本地可写文件（边界见 README §4）。
 */
export function gitDirOf(repo) {
  const r = git(repo, ['rev-parse', '--absolute-git-dir'])
  const s = r.stdout.trim()
  if (r.status === 0 && s) return path.resolve(toPosix(s))
  return path.join(repo, '.git') // 兜底：独立仓库
}

/** 锚点文件的绝对路径。 */
export const anchorFileOf = (repo, name) => path.join(gitDirOf(repo), ANCHOR_DIR, `${name}.anchor`)

/**
 * 解析"要治理哪棵树"：`--repo` > 环境 `DSH_GATE_REPO` > 从脚本自身位置向上找含 `.git` 的目录。
 * ★ 刻意不写任何绝对路径 —— 门跟着"自己被放在哪棵树"走；要治理别处就用上面两个显式出口。
 */
export function resolveRepo({ cliRepo = null, selfPath }) {
  if (cliRepo) {
    const r = repoRootOf(path.resolve(cliRepo))
    return r ?? null
  }
  const env = process.env.DSH_GATE_REPO
  if (env && env.trim() !== '') {
    const r = repoRootOf(path.resolve(env.trim()))
    return r ?? null
  }
  let d = path.resolve(selfPath)
  for (let i = 0; i < 12; i += 1) {
    const up = path.dirname(d)
    if (up === d) break
    d = up
    // ★ `.git` 可能是目录（独立仓库）也可能是文件（链接工作树）—— existsSync 两者都为真。
    if (fs.existsSync(path.join(d, '.git'))) {
      const r = repoRootOf(d)
      if (r) return r
    }
  }
  return repoRootOf(process.cwd())
}

/** 暂存改动路径（改名拆成删除+新增 ⇒ 两侧都参与判层）。 */
export function stagedPaths(repo) {
  const r = git(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames'])
  if (r.status !== 0) return { ok: false, paths: [], why: r.stderr.trim().slice(0, 300) }
  return { ok: true, paths: r.stdout.split('\0').filter((x) => x.trim() !== ''), why: '' }
}

/** 某次提交相对其父的真实改动路径（根提交用 --root）。 */
export function commitPaths(repo, rev) {
  const parents = git(repo, ['rev-list', '--parents', '-n', '1', rev]).stdout.trim().split(/\s+/)
  const isRoot = parents.length <= 1
  const args = isRoot
    ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', rev]
    : ['diff', '--name-only', '-z', '--no-renames', `${rev}^`, rev]
  const r = git(repo, args)
  if (r.status !== 0) return { ok: false, paths: [], why: r.stderr.trim().slice(0, 300), isRoot }
  return { ok: true, paths: r.stdout.split('\0').filter((x) => x.trim() !== ''), why: '', isRoot }
}

/** 索引里某路径的 `mode:blobSha`（不在索引里 ⇒ ABSENT）。 */
function indexToken(repo, p) {
  const r = git(repo, ['ls-files', '-s', '-z', '--', p])
  if (r.status !== 0) return 'ABSENT'
  const first = r.stdout.split('\0')[0] ?? ''
  const m = /^(\S+)\s+([0-9a-fA-F]{7,64})\s+(\d+)\t/.exec(first)
  return m ? `${m[1]}:${m[2].toLowerCase()}` : 'ABSENT'
}

/** 提交里某路径的 `mode:blobSha`（不在该提交里 ⇒ ABSENT）。 */
function commitToken(repo, rev, p) {
  const r = git(repo, ['ls-tree', '-z', rev, '--', p])
  if (r.status !== 0) return 'ABSENT'
  const first = r.stdout.split('\0')[0] ?? ''
  const m = /^(\d+)\s+\S+\s+([0-9a-fA-F]{7,64})\t/.exec(first)
  return m ? `${m[1]}:${m[2].toLowerCase()}` : 'ABSENT'
}

const fingerprintOf = (paths, tokenOf) =>
  crypto
    .createHash('sha256')
    .update([...paths].sort().map((p) => `${p}\u0000${tokenOf(p)}`).join('\n'))
    .digest('hex')

export const indexFingerprint = (repo, paths) => fingerprintOf(paths, (p) => indexToken(repo, p))
export const commitFingerprint = (repo, rev, paths) => fingerprintOf(paths, (p) => commitToken(repo, rev, p))

/** 完整批次描述（路径 + 指纹 + 层）。层由调用方用 change-classify 填。 */
export function stagedBatch(repo) {
  const st = stagedPaths(repo)
  if (!st.ok) return { ok: false, why: st.why }
  return { ok: true, paths: st.paths, fingerprint: indexFingerprint(repo, st.paths) }
}

export function commitBatch(repo, rev) {
  const cp = commitPaths(repo, rev)
  if (!cp.ok) return { ok: false, why: cp.why }
  return { ok: true, paths: cp.paths, fingerprint: commitFingerprint(repo, rev, cp.paths), isRoot: cp.isRoot }
}

/** core.hooksPath 的**当前生效值**（含 `-c` / 环境覆盖。取不到 ⇒ null）。 */
export function hooksPathOf(repo) {
  const r = git(repo, ['config', '--get', 'core.hooksPath'])
  const v = r.stdout.trim()
  return v === '' ? null : toPosix(v)
}

/** hooksPath 是否指向本层期望的目录（相对值按仓库根解析后比较）。 */
export function hooksWired(repo) {
  const got = hooksPathOf(repo)
  if (got === null) return { ok: false, got, want: HOOKS_DIR_REL, why: 'core.hooksPath 未设 ⇒ git 不会调用本层钩子' }
  const abs = path.isAbsolute(got) ? path.resolve(got) : path.resolve(repo, got)
  const wantAbs = path.resolve(repo, HOOKS_DIR_REL)
  const ok = toPosix(abs).toLowerCase() === toPosix(wantAbs).toLowerCase()
  return { ok, got, want: HOOKS_DIR_REL, why: ok ? '' : `core.hooksPath=${got} ⇒ 指向别处（期望 ${HOOKS_DIR_REL}）` }
}

/** 从 baseline（含）之后的提交（按时间正序）。baseline 为空 ⇒ 全部提交。 */
export function commitsSince(repo, baseline) {
  const args = ['rev-list', '--reverse', baseline ? `${baseline}..HEAD` : 'HEAD']
  const r = git(repo, args)
  if (r.status !== 0) return { ok: false, shas: [], why: r.stderr.trim().slice(0, 300) }
  return { ok: true, shas: r.stdout.split(/\s+/).filter((x) => x !== ''), why: '' }
}

export function headSha(repo) {
  const r = git(repo, ['rev-parse', 'HEAD'])
  return r.status === 0 ? r.stdout.trim() : null
}

export function revParse(repo, rev) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', rev])
  return r.status === 0 ? r.stdout.trim() : null
}

export function fileExists(p) {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}
