#!/usr/bin/env node
/**
 * gate-commit-check.mjs —— ★★ 把 `gate` 接进【提交路径】（O115；2026-09-23 格 ⑩ v2：钩子自己挂票）
 *
 * ── 它解决的问题（2026-09-23 暴露，我自己的流程违规实测出来的）────────────────
 *   `scripts/pending-approval.mjs` 的 `gate` 一直是**约定**：
 *     ① `change-classify` 判层 → ② R1/R0 就 `record` 留票 → ③ 续跑前跑 `gate`（有票 ⇒ 非零退出）。
 *   实测缺口（O110）：**跳过 ③ 或跳过 ②，就无声放行** —— 因为「提交」这一步**没有门**。
 *   于是"R1 未批不提交"完全靠发起者自律 ⇒ 2026-09-23 真的发生了一次
 *   「票还 pending，R1 改动已经 commit 且 push」（见账本 §6 与 `out/w44-witness-verdict.md`）。
 *   ⇒ 本脚本 + `scripts/git-hooks/pre-commit` 就是那一件：**让机器在 `git commit` 时查**。
 *
 * ── ★★ v2：门自己判层、自己挂票（封掉"跳过②（不挂票）"）──────────────────────
 *   独立见证者（`out/w46-witness2-verdict.md`）实测出 v1 的缺口：
 *     · 只在"已挂票 ∧ 未批"时才拦得住；**不挂票就静默放行**（见证者记作 A1，`exit=0`）。
 *   因为 v1 的唯一输入是"有没有未批记录"，而**记录由发起者自己写** ⇒ 那半条缺口没堵。
 *   v2 的流程（★ 钩子**不信任发起者有没有挂票**，它自己判、自己挂）：
 *     1. 取**暂存区**改动路径：`git diff --cached --name-only -z --no-renames`（改名拆成 D+A ⇒ 两侧都判）。
 *     2. `change-classify.mjs` 按【实际改动路径】判层（不看提交信息、不看自述、不看发起者）。
 *        · **R2 ⇒ 放行**（exit 0，不产生任何记录）。
 *        · **R0/R1 ⇒ 往下走**。
 *     3. `gate --level <L>`（原有口径，**未改**）：有任何未批的 R0/R1 记录 ⇒ **拦住**（exit 1）。
 *     4. gate 放行 ⇒ 再看台账里**有没有一条【已批】记录覆盖本批**：
 *        · 有 ⇒ **放行**（exit 0）。
 *        · 没有 ⇒ ★ **钩子自己 `record` 一张 pending 票**（`level` = 第 2 步判出的层；
 *          `paths` = 实际改动路径；`note` = 自动生成，说明"由 pre-commit 自动挂票，因改动路径判为 R0/R1"），
 *          **然后拦住**（exit 1，报错点名这张刚挂的票）。
 *   ⇒ 两种"绕过②"的路都不再是无声放行：**不挂票 ⇒ 机器替你挂一张，然后拦住**。
 *   ★★ 自动挂票 **≠** 自动批准：票仍然是 `pending`，**仍然必须由独立见证者 `approve`**
 *     （§6.2 无环原则；钩子只写 `record` 行，**从不写 `approve` 行**）。
 *
 * ── 去重（同一批改动反复 commit 不应无限挂票）────────────────────────────────
 *   覆盖判定 `covers(票, 本批)`，两条口径**逐条写死**（可反驳）：
 *     · 票带 `fingerprint`（**新式票**，自动挂的票一律带）⇒ **指纹相等**才算覆盖。
 *       指纹 = 暂存路径集合 + 各路径在**索引里的 blob sha**（连 mode 一起）⇒ **内容一变就是另一张票**。
 *     · 票不带 `fingerprint`（**老式/手工票**）⇒ 本批路径**是那张票 paths 的子集**才算覆盖（大小写不敏感）。
 *   ★ 结构上的第一道保险其实更强：第一次自动挂票之后，第二次 `git commit` 在**第 3 步 gate 就**
 *     被拦住（gate 是"级别级、与路径无关"的：有未批 R0/R1 就拦）⇒ **根本进不到挂票分支**。
 *     指纹/路径去重是**第二道保险**（例如台账被外部改过、或 gate 口径将来变宽时仍不重复挂）。
 *
 * ── ★★ 诚实边界（**不许把它说成沙箱**；按独立见证者裁决修正措辞）────────────────
 *   ★ 准确定性：这是**默认路径上的条件门（conditional gate on the default path）**，
 *     **不是机器约束（machine constraint）**。拦住提交的是**客户端钩子**，而客户端钩子有
 *     **固有限制** —— 已知绕过路径（★ 见证者与我都**实测**过，见 `out/w46-witness2-verdict.md` §3 与本批报告）：
 *       (a) `git commit --no-verify`                        ⇒ 一步绕过（钩子**不被调用**）；
 *       (b) `git -c core.hooksPath=/nonexistent commit`     ⇒ 一步绕过（换掉钩子目录）；
 *       (c) 直接改 `scripts/git-hooks/pre-commit` / 本文件  ⇒ 下一条命令就绕过；
 *       (d) `git config --local core.hooksPath <别处>`      ⇒ 同 (b)（该配置是仓库本地配置，不进版本库）；
 *       (e) ★ **直接往台账 append 一行 `approve`**（`out/pending-approval/records.jsonl` 是**本地可写文件**）
 *           ⇒ **伪造"已批"**然后提交 ⇒ 放行（**实测**，见报告 §边界复验2）。这就是"无环原则"要防的
 *           "自己批自己"，本钩子**挡不住**它 —— 它只读台账，判不了那行是谁写的。
 *   ★ 本地侧**没有**能真封住 (a)/(b) 的办法：`git` 里 `--no-verify` 的定义就是"跳过钩子"；
 *     钩子路径又是本地可写配置。要"不可绕"必须把检查放到**被治理者够不到的地方**：
 *       ① 远端 `pre-receive` / CI（服务端，`--no-verify` 管不到）；② 控制面自身
 *       （`packages/switchboard` 的换代/交接/回滚路径里校验审批状态 ⇒ O111，属 R0）；
 *       ③ 判据根离机 / 换卷。
 *     本批**没有**做这三件（代价大 / 属控制面），⇒ 如实记为边界，**不声称已闭环、不声称"不可绕"**。
 *   ★ 隔离工作树（`eval-wt-new` 建的那种，`scripts/` 被排除）里**没有本脚本** ⇒ 钩子**放行**
 *     （否则会把被测 agent 正常的 `git commit` 堵死）。这条是刻意设计，不是漏。
 *   ★ **fail-closed**：台账读不到 / 写不进（IO 错）⇒ **不放行**（exit 非零）。
 *     代价：这棵树上 R0/R1 的提交会一直失败，直到台账可写。这是刻意的取舍（宁可堵死，不无声放行）。
 *
 * ── 形态选择（为什么是 git 钩子，而不是"必须走某个包装命令"）──────────────────
 *   备选 A：约定"必须用 `node scripts/commit-wrapped.mjs` 提交" —— ✗ **不选**：
 *     它把门放在"我记得用哪个命令"上，正是本轮要消灭的那类"靠自律"。
 *   备选 B：`git commit` 钩子（`core.hooksPath` 指向版本化的 `scripts/git-hooks/`）—— ✓ **选它**：
 *     · 拦的是**机器动作本身**（git 自己的提交路径），不是提醒；
 *     · 钩子文件**进仓库**（可审计、可 diff、可被 `change-classify` 判断）；
 *     · 不需要任何人改变习惯：谁敲 `git commit` 都一样过这道门。
 *   ★ 本仓此前**没有**钩子目录约定（`.git/hooks/` 里只有 `*.sample`，`core.hooksPath` 未设）
 *     ⇒ 本批新建 `scripts/git-hooks/`，安装只需一条 `git config`（见 `--install`）。
 *   ★ `core.hooksPath` 是**仓库本地配置**（`.git/config`，不进版本库）⇒ **新克隆要重跑 `--install`**。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/gate-commit-check.mjs --install          # 安装钩子（设 core.hooksPath）
 *   node scripts/gate-commit-check.mjs --status           # 看当前 wiring
 *   node scripts/gate-commit-check.mjs --hook pre-commit  # 钩子内部调用（读【暂存区】）
 *   node scripts/gate-commit-check.mjs --dir <待批目录>    # 换待批台账目录（测试/隔离用）
 *
 * 退出码：0 = 放行；1 = **拦住**（未批的 R0/R1，含本脚本刚自动挂的那张票）；3 = 用法/IO 错。
 * ★ 依赖：`./change-classify.mjs`（层级推断的单一来源）+ `./pending-approval.mjs`（台账）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyPaths } from './change-classify.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const NAME = 'gate-commit-check'
const HOOKS_DIR_REL = 'scripts/git-hooks'

const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const has = (k) => argv.includes(k)

const USAGE = `${NAME} —— 把 gate 接进提交路径（O115；v2 钩子自己挂票）

用法：
  node scripts/${NAME}.mjs --install                    # 安装：git config core.hooksPath ${HOOKS_DIR_REL}
  node scripts/${NAME}.mjs --status                     # 看 wiring（钩子文件在不在 + hooksPath 是什么）
  node scripts/${NAME}.mjs --hook <pre-commit>          # 钩子内部调用：按【暂存区】判层 + 过 gate
  node scripts/${NAME}.mjs --hook <name> --repo <abs>   # 指定被判的仓库/工作树
  node scripts/${NAME}.mjs --hook <name> --dir <abs>    # 指定待批台账目录（缺省 out/pending-approval）
  -h, --help

判据（v2）：
  暂存路径判层 R2 ⇒ 放行（exit 0，不产生记录）。
  R0/R1 ⇒ gate 有未批记录 ⇒ 拦住（exit 1）；否则若台账里有一条【已批】记录覆盖本批 ⇒ 放行（exit 0）；
  再否则 ⇒ ★ 钩子自动 record 一张 **pending** 票（level=判层结果 / paths=实际改动路径 / note=自动生成），
  然后拦住（exit 1）。★ 自动挂票 ≠ 自动批准：仍须独立见证者 approve。
退出码：0 = 放行；1 = 拦住（未批的 R0/R1，含刚自动挂的票）；3 = 用法/IO 错。
★ 边界：这是**默认路径上的条件门**，不是机器约束 —— \`--no-verify\` / \`-c core.hooksPath=\` 都能一步绕过。
`

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
const say = (s) => process.stdout.write(`${s}\n`)
const err = (s) => process.stderr.write(`${s}\n`)

/**
 * 暂存区相对 HEAD 的改动路径。
 * ★ 用 `--no-renames`：改名会被拆成 `D 旧` + `A 新` ⇒ **两侧都参与判层**
 *   （否则"把 evals/ 里的东西改名搬走"可能只看到新名）。
 * ★ 无 HEAD（首次提交）时 `git diff --cached` 会与空树比 ⇒ 新仓库也能用。
 */
function stagedPaths(repo) {
  const r = sh('git', ['-C', repo, 'diff', '--cached', '--name-only', '-z', '--no-renames'])
  if (r.status !== 0) return { ok: false, paths: [], why: String(r.stderr ?? '').trim().slice(0, 300) }
  return { ok: true, paths: String(r.stdout ?? '').split('\0').filter((x) => x.trim() !== ''), why: '' }
}

function repoRootOf(dir) {
  const r = sh('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
  const s = String(r.stdout ?? '').trim()
  return r.status === 0 && s ? s.replace(/\\/g, '/') : null
}

/** 调 `pending-approval.mjs gate`（同一进程树里 spawn，取它的 JSON 首行 + 退出码）。 */
function runGate(level, dir) {
  const script = path.join(HERE, 'pending-approval.mjs')
  if (!fs.existsSync(script)) return { ok: false, code: 3, json: null, raw: `找不到 ${script}`, why: '判据侧台账脚本不在' }
  const args = [script, 'gate', '--level', level]
  if (dir) args.push('--dir', dir)
  const r = sh(process.execPath, args)
  let json = null
  try {
    json = JSON.parse(String(r.stdout ?? '').split('\n')[0])
  } catch {
    /* 解析不了就只用退出码 + 原文，不假装解析成功 */
  }
  return { ok: r.status === 0, code: r.status, json, raw: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim(), why: '' }
}

/**
 * ★ 本批（暂存改动）的**内容指纹**：路径集合 + 各路径在**索引里的 blob sha**（含 mode）。
 *   ⇒ 内容一变（哪怕只是同一文件的另一版）指纹就变 ⇒ 自动挂的票是**绑定内容**的。
 *   · 路径排序后参与（顺序不影响）;· 索引里没有该路径（如暂存删除）⇒ token=`ABSENT`。
 */
function batchFingerprint(repo, paths) {
  const parts = []
  for (const p of [...paths].sort()) {
    const r = sh('git', ['-C', repo, 'ls-files', '-s', '-z', '--', p])
    let token = 'ABSENT'
    if (r.status === 0) {
      const first = String(r.stdout ?? '').split('\0')[0] ?? ''
      const m = /^(\S+)\s+([0-9a-fA-F]{7,64})\s+(\d+)\t/.exec(first)
      if (m) token = `${m[1]}:${m[2].toLowerCase()}`
    }
    parts.push(`${p}\u0000${token}`)
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex')
}

/** 读台账（**复用** `pending-approval.mjs list --all --json`，不另写一套 store 逻辑）。 */
function readRecords(dir) {
  const script = path.join(HERE, 'pending-approval.mjs')
  if (!fs.existsSync(script)) return { ok: false, records: [], why: `找不到 ${script}` }
  const args = [script, 'list', '--all', '--json']
  if (dir) args.push('--dir', dir)
  const r = sh(process.execPath, args)
  if (r.status !== 0) {
    return { ok: false, records: [], why: `pending-approval list 非零退出（${r.status}）：${String(r.stderr ?? '').trim().slice(0, 300)}` }
  }
  try {
    const o = JSON.parse(String(r.stdout ?? '').split('\n')[0])
    return { ok: true, records: Array.isArray(o.records) ? o.records : [], why: '' }
  } catch (e) {
    return { ok: false, records: [], why: `pending-approval list 输出解析失败：${String(e?.message ?? e)}` }
  }
}

/**
 * ★ 覆盖判定（**两条口径写死**，见文件头「去重」）：
 *   · 票带 fingerprint ⇒ 必须**指纹相等**；
 *   · 票不带 fingerprint（老式/手工票）⇒ 本批路径**是票 paths 的子集**（大小写不敏感）。
 * @returns {'fingerprint'|'paths-subset'|null}
 */
function covers(rec, batch) {
  if (typeof rec.fingerprint === 'string' && rec.fingerprint !== '') {
    return String(rec.fingerprint).toLowerCase() === batch.fingerprint ? 'fingerprint' : null
  }
  const have = new Set((rec.paths ?? []).map((p) => String(p).replace(/\\/g, '/').toLowerCase()))
  if (have.size === 0) return null
  return batch.paths.every((p) => have.has(String(p).replace(/\\/g, '/').toLowerCase())) ? 'paths-subset' : null
}

/**
 * ★★ 钩子**自己**挂一张 pending 票（`record` 行；★ 从不写 `approve` 行）。
 *   `--paths` **逐条**给（不用逗号拼），避免路径里含逗号时被拆错。
 */
function autoRecord(level, paths, fingerprint, ruleIds, dir) {
  const script = path.join(HERE, 'pending-approval.mjs')
  if (!fs.existsSync(script)) return { ok: false, id: null, why: `找不到 ${script}` }
  const note =
    `[auto] pre-commit 自动挂票：暂存改动按【实际路径】判为 ${level}` +
    `${ruleIds.length > 0 ? `（命中 ${ruleIds.join(' , ')}）` : ''}` +
    ` ⇒ 在【独立见证者】approve 之前不许提交（§6.2 无环原则）。` +
    `本票由 scripts/git-hooks/pre-commit 在 git commit 时自动挂出（发起者没有自己 record）；自动挂票 ≠ 自动批准。`
  const args = [script, 'record', '--level', level, '--note', note, '--by', 'pre-commit', '--fingerprint', fingerprint]
  for (const p of paths) args.push('--paths', p)
  if (dir) args.push('--dir', dir)
  const r = sh(process.execPath, args)
  let json = null
  try {
    json = JSON.parse(String(r.stdout ?? '').split('\n')[0])
  } catch {
    /* 解析不了就只用退出码 */
  }
  if (r.status !== 0 || !json?.id) {
    return { ok: false, id: null, why: `record 失败（exit ${r.status}）：${`${String(r.stdout ?? '')}${String(r.stderr ?? '')}`.trim().slice(0, 400)}` }
  }
  return { ok: true, id: json.id, level: json.level, note, why: '' }
}

function cmdInstall() {
  const hookFile = path.join(ROOT, HOOKS_DIR_REL, 'pre-commit')
  if (!fs.existsSync(hookFile)) {
    err(`${NAME}：钩子文件不存在：${hookFile}`)
    return 3
  }
  const r = sh('git', ['-C', ROOT, 'config', 'core.hooksPath', HOOKS_DIR_REL])
  if (r.status !== 0) {
    err(`${NAME}：git config 失败：${String(r.stderr ?? '').trim()}`)
    return 3
  }
  const got = String(sh('git', ['-C', ROOT, 'config', '--get', 'core.hooksPath']).stdout ?? '').trim()
  say(`${NAME} --install`)
  say(`  钩子文件   : ${hookFile.replace(/\\/g, '/')}`)
  say(`  core.hooksPath = ${got}`)
  say(`  ⇒ 现在起 \`git commit\` 会先过这道门（R0/R1 未批 ⇒ 拦住）。`)
  say(`  ★ 提醒：这是**仓库本地配置**（.git/config 不进版本库）⇒ 新克隆要重跑本命令。`)
  return 0
}

function cmdStatus() {
  const hookFile = path.join(ROOT, HOOKS_DIR_REL, 'pre-commit')
  const r = sh('git', ['-C', ROOT, 'config', '--get', 'core.hooksPath'])
  const got = String(r.stdout ?? '').trim()
  const script = path.join(HERE, 'pending-approval.mjs')
  say(`${NAME} --status`)
  say(`  判据根            : ${ROOT.replace(/\\/g, '/')}`)
  say(`  钩子文件存在      : ${fs.existsSync(hookFile) ? `是 ✓（${hookFile.replace(/\\/g, '/')}）` : '**否 ✗**'}`)
  say(`  core.hooksPath    : ${got === '' ? '（未设 —— 钩子**不会**被 git 调用）' : got}`)
  say(`  pending-approval  : ${fs.existsSync(script) ? '在 ✓' : '**不在 ✗**'}`)
  return 0
}

function cmdCheck() {
  const hookName = argOf('--hook') ?? 'pre-commit'
  const repoArg = argOf('--repo')
  const repo = repoArg ? path.resolve(repoArg) : repoRootOf(ROOT)
  if (!repo) {
    err(`${NAME}：取不到仓库根（用 --repo <abs> 显式给）`)
    return 3
  }
  const dir = argOf('--dir')
  const st = stagedPaths(repo)
  if (!st.ok) {
    // ★ 读不到暂存区 ⇒ 不假装"没有改动"：报错并**放行**（钩子内部拿不到读数时不该堵死正常提交）
    err(`${NAME}：读暂存区失败（${st.why}）⇒ 本步**放行**（不假装通过，也不堵死提交）`)
    return 0
  }

  say(`${NAME} —— ${hookName} 门（判据 = 暂存路径判层 ⇒ gate ⇒ 必要时自动挂票）`)
  say(`  被判仓库  : ${repo.replace(/\\/g, '/')}`)
  say(`  暂存改动  : ${st.paths.length} 条${st.paths.length ? '' : '（空 ⇒ 没有可判的对象 ⇒ 放行）'}`)
  for (const p of st.paths.slice(0, 12)) say(`      · ${p}`)
  if (st.paths.length > 12) say(`      · …（共 ${st.paths.length} 条）`)
  if (st.paths.length === 0) return 0

  const inf = classifyPaths(st.paths, { root: repo })
  say(`  判层      : **${inf.level}**（只看【变更的实际路径】；${inf.ruleCounts.R0}×R0 / ${inf.ruleCounts.R1}×R1 / ${inf.ruleCounts.R2}×R2）`)
  for (const h of inf.hits.slice(0, 6)) say(`      [${h.ruleId}] ${h.level} ← ${h.path}`)
  if (inf.hits.length > 6) say(`      …（共 ${inf.hits.length} 条命中）`)

  if (inf.level === 'R2') {
    say(`  ⇒ 放行（exit 0）：R2 = 能力层 ⇒ 判据阶梯自动 ⇒ 不产生待批记录、不需要外部见证。`)
    return 0
  }

  const dirLabel = dir ?? 'out/pending-approval'
  const batch = { paths: st.paths, fingerprint: batchFingerprint(repo, st.paths) }
  say(`  批次指纹  : ${batch.fingerprint}（路径 + 索引 blob sha ⇒ 内容绑定）`)

  // ── 第 3 步：原有 gate 口径（**未改**）：任何未批的 R0/R1 记录 ⇒ 拦住 ────────
  const g = runGate(inf.level, dir)
  if (g.why) {
    err(`${NAME}：${g.why} ⇒ 报错退出（不假装通过）`)
    return 3
  }
  const rd = readRecords(dir)
  if (!rd.ok) {
    return reportBlocked(hookName, inf, dirLabel, { mode: 'unreadable', why: rd.why })
  }

  if (!g.ok) {
    const blocking = g.json?.blocking ?? []
    const covering = rd.records.filter((r) => r.status === 'pending' && covers(r, batch))
    const shown = covering.length > 0 ? covering : blocking
    say(`  gate --level ${inf.level} : **拦住**（exit ${g.code}；有未批的 R0/R1 记录）`)
    if (covering.length > 0) {
      say(`  ⇒ 其中**覆盖本批**的票 ${covering.map((r) => r.id).join(', ')} ⇒ 不再重复挂票（按指纹/路径去重）。`)
    } else {
      say(`  ⇒ 未批记录与本批路径不同 ⇒ 按原有口径仍然拦住（不放宽），也不为本批挂票。`)
    }
    return reportBlocked(hookName, inf, dirLabel, {
      mode: 'external',
      records: shown,
      gateRaw: blocking.length === 0 ? g.raw : '',
    })
  }

  say(`  gate --level ${inf.level} : 放行（exit 0；**没有**未批的 R0/R1 记录）`)

  // ── 第 4 步：gate 放行 ⇒ 本批是不是**已经被批过**？─────────────────────────
  const approvedCovering = rd.records.filter((r) => r.status === 'approved' && covers(r, batch))
  if (approvedCovering.length > 0) {
    say(
      `  已批记录覆盖本批：${approvedCovering
        .map((r) => `${r.id}（按 ${covers(r, batch)} 命中，approvedBy=${r.approvedBy ?? '-'}）`)
        .join(' , ')}`,
    )
    say(`  ⇒ 放行（exit 0）：台账里有覆盖本批的**已批**记录。`)
    say(`  ★ 注意：台账（out/pending-approval/records.jsonl）是**本地可写文件** ⇒ 这一条**不验证批准者身份**，`)
    say(`    它只能说明"台账上写着已批"。谁写的、是不是独立见证者，本钩子判不了（见文件头「诚实边界」(e)）。`)
    return 0
  }

  // ── ★★ 自动挂票（钩子自己挂一张 pending 票），然后拦住 ────────────────────
  const ruleIds = [...new Set(inf.hits.filter((h) => h.level === inf.level).map((h) => h.ruleId))]
  say(`  台账里既没有覆盖本批的**未批**票，也没有**已批**票 ⇒ ★ 钩子自己挂一张 pending 票。`)
  const auto = autoRecord(inf.level, st.paths, batch.fingerprint, ruleIds, dir)
  if (!auto.ok) {
    return reportBlocked(hookName, inf, dirLabel, { mode: 'autofail', why: auto.why })
  }
  say(`  ⇒ 已自动挂票：**${auto.id}**（level=${inf.level}, status=pending）`)
  return reportBlocked(hookName, inf, dirLabel, { mode: 'auto', auto })
}

/**
 * ★★ 拦住时的报错：点名列出的每一张票（含**本脚本刚挂的那张**）。返回 1。
 * @param {{mode:'external'|'auto'|'autofail'|'unreadable', records?:object[], auto?:object, why?:string, gateRaw?:string}} how
 */
function reportBlocked(hookName, inf, dirLabel, how) {
  const records = how.records ?? []
  err('')
  err('════════════════════════════════════════════════════════════════════════')
  if (how.mode === 'auto') {
    err(`✗ ${hookName} 拦住：**未批的 ${inf.level} 改动 + 本批没有已批记录 ⇒ 已自动挂票，然后拦住**（O115 / §6.2）`)
  } else {
    err(`✗ ${hookName} 拦住：**未批的 ${inf.level} 改动不许提交**（O115 / §6.2 无环原则）`)
  }
  err('════════════════════════════════════════════════════════════════════════')
  err(`  判层：${inf.level}（命中 ${inf.hits.filter((h) => h.level === inf.level).map((h) => h.ruleId).join(' , ')}）`)
  err(`  待批记录目录：${dirLabel}`)

  if (how.mode === 'auto' && how.auto?.id) {
    err(`  ★ 本脚本刚自动挂的那张票：**${how.auto.id}**  [${inf.level}]  status=pending  by=pre-commit`)
    err(`      note  : ${how.auto.note}`)
    err(`      ★ 自动挂票 **不是**自动批准：票仍是 pending ⇒ 必须由【独立见证者】approve 后才能再次提交。`)
  }
  for (const b of records) {
    err(`  ★ 那张票：**${b.id}**  [${b.level}]  status=${b.status ?? 'pending'}`)
    if (b.note) err(`      note  : ${b.note}`)
    if (Array.isArray(b.paths) && b.paths.length) err(`      paths : ${b.paths.join(', ')}`)
  }
  if (how.mode === 'unreadable' || how.mode === 'autofail') {
    err(`  ★ 注意：${how.why}`)
    err(`    ⇒ 按"读不到/挂不上就不放行"处理（fail-closed，不假装通过）。`)
    if (how.gateRaw) err(how.gateRaw.split('\n').map((l) => `      ${l}`).join('\n'))
  }
  err('  怎么放行（三条之一）：')
  const first = how.auto?.id ?? records[0]?.id
  if (first) err(`    ① 外部确认：node scripts/pending-approval.mjs approve ${first} --by <谁> --note "<一句>"`)
  else err('    ① 外部确认：node scripts/pending-approval.mjs approve <id> --by <谁>')
  err(`    ② 若你认为这次改动其实是 R2：先纠正判层（改路径或改规则表）—— ★ 改规则表本身是一次 R1 改动。`)
  err(`    ③ ★ 注意：\`git commit --no-verify\` 能一步绕过本钩子 —— 但那是**故意绕过门**，不是放行。`)
  err(`  复核：node scripts/pending-approval.mjs gate --level ${inf.level}`)
  err('  ★ 本次提交被拦在 git 写任何东西之前 ⇒ 工作树与暂存区**原样未动**（自动挂的票写在台账里，不在工作树）。')
  err('')
  return 1
}

function main() {
  if (has('-h') || has('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    if (has('--install')) return cmdInstall()
    if (has('--status')) return cmdStatus()
    if (has('--hook')) return cmdCheck()
    process.stderr.write(USAGE)
    return 3
  } catch (e) {
    err(`${NAME} 内部错误：${String(e?.message ?? e)}`)
    return 3
  }
}

process.exit(main())
