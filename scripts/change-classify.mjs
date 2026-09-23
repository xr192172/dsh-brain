#!/usr/bin/env node
/**
 * change-classify.mjs —— 「这次改动属于哪一层」的**机器化推断**（O106）
 *
 *     node scripts/change-classify.mjs                       # 缺省：读 `git status --porcelain` 的改动路径
 *     node scripts/change-classify.mjs --paths <p1,p2,...>   # 显式给路径（可重复给 --paths）
 *     node scripts/change-classify.mjs --rules               # 打印规则表（人读 / 审计用，不是 JSON）
 *
 *   ⇒ stdout **恰好一行 JSON**：`{"level":"R0"|"R1"|"R2","reasons":[...],"paths":[...], ...}`
 *     退出码：0 = 给出推断；3 = 用法/IO 错（★ 推断本身不走非零退出，拦住是消费侧的事 —— 见 O107）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 它守的是哪条规则（原典：`docs/handover-vs-restart.md:232-265` §6.2 无环原则）
 *
 *   | 变动对象 | 见证方 | 换代后自动续跑？ |
 *   | R2 能力层（tool/skill/prompt/子 agent/普通代码） | 判据阶梯（自动） | ✅ 自动 |
 *   | R1 判据层（评测集/holdout/权限声明/配额上限/审批逻辑） | 外部（人/独立见证） | ❌ 留一条待批记录 |
 *   | R0 自举层（启动/恢复/回滚路径） | 外部 + 自举性检验 | ❌ 同上 |
 *
 *   ★ 写死条文①：**层级标签不能由发起者自己填**（否则它会把自己标成 R2）
 *     ⇒ 本脚本**只看变更的实际路径**（`git status` / `--paths`），
 *       **不看提交信息、不看 `--level` 之类的自述、不看谁发起的**。
 *   ★ 写死条文②：**控制面自身属于 R1，agent 不可写它** —— 即"决定能不能自动批准的那段代码，
 *     不能被被批准的东西改写"。⇒ 本轮的机制刻意做在**控制面之外**（`scripts/` 下的约定脚本 +
 *     一个约定目录 `out/pending-approval/`），使**本轮改动自身落在 R2**（可自动）。
 *     代价与自指风险见报告 `out/w39-o106-o107.md`「不确定/未验证」——★ 不许把这件事说成已闭环。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 判定口径（三条，全部写死；**多重命中取最严** R0 > R1 > R2）
 *
 *   1. **R0（自举层）= 启动/恢复/回滚路径**
 *      实际判据：改它能让"控制面起不来 / 换不了代 / 回滚回去"——即它在 boot、handover、rollback、
 *      前门、部署这条路径上。落到路径上 = `packages/switchboard/**`（整个 switchboard 包）
 *      + 前门的启动/重启/切换脚本。
 *   2. **R1（判据层）= 判据本身，或判据的装置**
 *      实际判据（一句话可判）：**「改它能否让某个判据变松/变绿，而完全不用改被测物？」能 ⇒ R1。**
 *      落到路径上 = 冻结任务集 `evals/**`、判据脚本族 `scripts/{check,eval,gate,capability,memory}-*.mjs`、
 *      权限声明 `packages/switchboard/src/guard.ts`。
 *   3. **R2 = 其余**（能力层：非控制面的插件源码、文档、报告产物、其余脚本）。
 *
 *   ★ 灰区（探针/测量类脚本、根配置文件）**我判 R2** —— 逐条列在报告里，且注明
 *   "把某条路径从 R2 升到 R1/R0 本身是一次 R1 改动（需外部见证）"。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 消费侧约定（★ "不自动续跑"的落地；与 `scripts/pending-approval.mjs` 配对）
 *
 *   本脚本只回答"是哪一层"。**拦住**由 `node scripts/pending-approval.mjs gate --level <L>` 做：
 *       有待批记录 ⇒ 非零退出（拦住） ／ 没有 ⇒ exit 0（放行）；R2 不产生记录，直接放行。
 *   ⇒ 任何 R1/R0 类改动，**在续跑之前必须先过 `gate`**。用法注释见 pending-approval.mjs 文件头。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 依赖：无（只用 node 标准库）。只读 `git status`；**不写任何文件**。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 规则表（**这就是"审计对象"本身**；`--rules` 打印的就是这张表）
//
//   match: { kind: 'exact' | 'glob', pattern }
//     · exact ⇒ 归一化后的仓库相对路径逐字相等（小写、正斜杠）
//     · glob  ⇒ 支持 `**`（跨 `/`）与 `*`（不跨 `/`）与 `?`
//   why: 为什么它属这一层（人读的一句话；必须能被反驳 —— 反驳就是一次规则讨论）
// ─────────────────────────────────────────────────────────────────────────────

export const RULES = [
  // ── R0（自举层：启动 / 恢复 / 回滚路径） ────────────────────────────────────
  {
    id: 'R0-CONTROL-PLANE',
    level: 'R0',
    match: { kind: 'glob', pattern: 'packages/switchboard/**' },
    why: 'switchboard 包 = 控制面/自举层本身：进程启动装配(index.ts)、换代状态机与失败回滚(coordinator.ts)、前门与命令路由(main.ts)、控制面操作接口(admin.ts/adminclient.ts)、起代(spawner.ts)、前门指向哪一代/恢复指向(lease.ts)、启动健康检查(boot-health.ts)、交接停写(drain.ts)、部署落盘(deploy.ts)、交接 wire 契约(handover-protocol.ts/protocol.ts)、换代上下文预置(preseed.ts/snapshot.ts/overlay.ts)、前门代理(proxy.ts)。改它 = 改「启动/恢复/回滚路径」',
  },
  {
    id: 'R0-CONTROL-PLANE-ENTRY',
    level: 'R0',
    match: { kind: 'exact', pattern: 'packages/switchboard/bin.cjs' },
    why: '控制面的**可执行入口**（被 `bin` 指向）；改它 = 改"控制面怎么被拉起来"',
  },
  {
    id: 'R0-CONTROL-PLANE-PKG',
    level: 'R0',
    match: { kind: 'exact', pattern: 'packages/switchboard/package.json' },
    why: '`bin`/`main`/`type` 声明决定控制面**怎么被启动/被加载**（启动路径的声明面）',
  },
  {
    id: 'R0-FRONT-DOOR-START',
    level: 'R0',
    match: { kind: 'glob', pattern: 'scripts/start*.ps1' },
    why: '前门的**启动脚本**（外部启动路径；改了它 = 换了"怎么起前门"）',
  },
  {
    id: 'R0-FRONT-DOOR-RELAUNCH',
    level: 'R0',
    match: { kind: 'glob', pattern: 'scripts/relaunch-switchboard.*' },
    why: '前门**重启/重拉**脚本（重启路径）',
  },
  {
    id: 'R0-FRONT-DOOR-RESTART',
    level: 'R0',
    match: { kind: 'exact', pattern: 'scripts/restart-fast.mjs' },
    why: '快速换代/重启入口（重启路径）',
  },
  {
    id: 'R0-FRONT-DOOR-FLIP',
    level: 'R0',
    match: { kind: 'exact', pattern: 'scripts/switchboard-flip.mjs' },
    why: '前门切换/换代的切换动作（换代 + 回滚路径）',
  },

  // ── R1（判据层：判据本身 / 判据的装置 / 权限声明） ──────────────────────────
  {
    id: 'R1-EVALS-FROZEN',
    level: 'R1',
    match: { kind: 'glob', pattern: 'evals/**' },
    why: '冻结任务集与判据回执本体：`evals/pilot/tasks.jsonl`(题面/holdout)、`evals/checks/**`(判分)、`evals/gate/contract.json`+`vectors.json`(门契约与向量)、`evals/README.md`(R1/R2 规则)。★ `evals/README.md` 逐字："R1 判据必须在 Agent 够不到的地方"——它自己就是判据',
  },
  {
    id: 'R1-CHECK-SCRIPTS',
    level: 'R1',
    match: { kind: 'glob', pattern: 'scripts/check-*.mjs' },
    why: '判据脚本族（`check:all` 的 PASS_TO_PASS 断言）：`check-*.mjs` 的断言口径就是"算不算合格"。改它能直接把红判成绿 ⇒ R1',
  },
  {
    id: 'R1-EVAL-SCRIPTS',
    level: 'R1',
    match: { kind: 'glob', pattern: 'scripts/eval-*.mjs' },
    why: '评测执行/校验的判据侧：题面装载、seed/restore、`eval-validate`(R2 假题门)、`eval-signal-check`(三段自证)、`eval-isolation-audit`(两臂隔离)。改它 = 改读数怎么产生 ⇒ R1',
  },
  {
    id: 'R1-GATE-SCRIPTS',
    level: 'R1',
    match: { kind: 'glob', pattern: 'scripts/gate-*.mjs' },
    why: '门本体：向量 runner / 契约校验器 / 参考实现与坏实现。★ `gate-impl-broken.mjs` 的存在就是为了证明"向量有分辨力"——门的松紧全在这里 ⇒ R1',
  },
  {
    id: 'R1-CAPABILITY-FAMILY',
    level: 'R1',
    match: { kind: 'glob', pattern: 'scripts/capability-*.mjs' },
    why: '能力门的判据与其装置：注册门阶梯(`capability-gate.mjs` 的 LADDER / `enforced`)、判据回执 acceptance 的校验(`capability-registry.mjs`)、只有过门才写回执的编排(`capability-intake.mjs`)、实验起点装置(`capability-snapshot.mjs`)、共享状态读写口(`capability-store.mjs`)、外部能力源扫描(`capability-sources.mjs`，假漂移会误导判据)。★ "注册 = 采纳"的闸就在这里 ⇒ R1',
  },
  {
    id: 'R1-MEMORY-FAMILY',
    level: 'R1',
    match: { kind: 'glob', pattern: 'scripts/memory-*.mjs' },
    why: '记忆效应的**判据机器**与其器具：三断言+四态(`memory-effect-judge.mjs`)、R1 隔离带毒自检(`memory-judge-poison-check.mjs`)、器具/面(`memory-stub.mjs`/`memory-arm.mjs`)。★ 两臂同器具是判据前提 —— 改器具 = 改读数 ⇒ R1',
  },
  {
    id: 'R1-GUARD-PERMISSIONS',
    level: 'R1',
    match: { kind: 'exact', pattern: 'packages/switchboard/src/guard.ts' },
    why: '权限声明（P2 宿主安全护栏的 deny 表：哪些签名禁就地改）。§6.2 把"权限声明"显式归 R1。★ 注意：它同时命中 R0-CONTROL-PLANE（在控制面包内）⇒ 按"取最严"实际判 **R0**（严于 §6.2 的 R1；分歧见报告）',
  },

  // ── R2（能力层；显式列出常见面，让规则表完整可读） ─────────────────────────
  {
    id: 'R2-DOCS',
    level: 'R2',
    match: { kind: 'glob', pattern: 'docs/**' },
    why: '文档/规格：**不改变任何可执行路径或判据**（设计要经由代码才生效）⇒ 能力层。★ 这也是本轮交付能落 R2 的原因之一',
  },
  {
    id: 'R2-OUT',
    level: 'R2',
    match: { kind: 'glob', pattern: 'out/**' },
    why: '报告/实验产物/临时文件（`.gitignore:15` 已忽略该目录）：**不被任何门读作判据** ⇒ 能力层',
  },
  {
    id: 'R2-NON-CONTROL-SRC',
    level: 'R2',
    match: { kind: 'glob', pattern: 'packages/*/src/**' },
    unless: [{ kind: 'glob', pattern: 'packages/switchboard/**' }],
    why: '非控制面的插件源码（capability-bridge / conveyor-context / design-canvas-bridge / key-pool-proxy / skill-tree / subagent-council / tool-evolution）：普通代码 = 能力层 ⇒ R2。★ `unless` 排掉 switchboard ⇒ 控制面源码不会被这条判成 R2',
  },
  {
    id: 'R2-SCRIPTS-OTHER',
    level: 'R2',
    match: { kind: 'glob', pattern: 'scripts/**' },
    why: '其余脚本（一次性实验 / 探针 / 工具）。★ 灰区：探针与测量类（`probe-*`/`measure-*`/`arm-probe`）可争议为 R1（改测量就能改读数），本轮**判 R2 并如实列入报告灰区** —— 升它是一次 R1 改动',
  },
]

/** R1/R0 的"显式默认"——兜底理由用（未命中任何规则时）。 */
const DEFAULT_LEVEL = 'R2'
const STRICTNESS = { R0: 0, R1: 1, R2: 2 }

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

/** glob → RegExp：`**` 跨 `/`；`*` 不跨 `/`；`?` 单字符。pattern 已归一化为小写正斜杠。 */
function globToRe(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?' // `**/` ⇒ 可吞掉任意层目录（含零层）
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${out}$`)
}

/** 规则表里 pattern 的编译缓存（每次进程只编译一次）。 */
const RE_CACHE = new Map()
function ruleRe(rule) {
  const key = rule.id
  if (!RE_CACHE.has(key)) RE_CACHE.set(key, rule.match.kind === 'glob' ? globToRe(rule.match.pattern) : null)
  return RE_CACHE.get(key)
}

/** 规则的 `unless`（排除项）编译缓存。 */
function unlessRes(rule) {
  const key = `${rule.id}::unless`
  if (!RE_CACHE.has(key)) {
    RE_CACHE.set(key, (rule.unless ?? []).map((u) => (u.kind === 'glob' ? globToRe(u.pattern) : null)))
  }
  return RE_CACHE.get(key)
}

/** 一条规则是否命中某个（已归一化的）仓库相对路径。 */
function ruleMatches(rule, rel) {
  const hit = rule.match.kind === 'exact' ? rel === rule.match.pattern : ruleRe(rule).test(rel)
  if (!hit) return false
  const unless = rule.unless ?? []
  for (let i = 0; i < unless.length; i += 1) {
    const u = unless[i]
    const m = u.kind === 'exact' ? rel === u.pattern : unlessRes(rule)[i].test(rel)
    if (m) return false // 命中排除项 ⇒ 这条规则不成立
  }
  return true
}

/**
 * 归一化一条输入路径。
 * @returns {{raw:string, abs:string, rel:string|null, isDir:boolean, outside:boolean, note:string|null}}
 */
export function normalizePath(p, { root = ROOT } = {}) {
  let s = String(p ?? '').trim()
  if (s === '') return null
  s = s.replace(/\\/g, '/')
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  const abs = path.resolve(root, s)
  const relRaw = path.relative(root, abs).replace(/\\/g, '/')
  const outside = relRaw === '' ? false : relRaw.startsWith('..') || path.isAbsolute(relRaw)
  let isDir = s.endsWith('/')
  try {
    if (!isDir && fs.existsSync(abs)) isDir = fs.statSync(abs).isDirectory()
  } catch {
    /* 路径不存在 ⇒ 不当作目录 */
  }
  let rel = relRaw.toLowerCase().replace(/\/+$/, '')
  if (isDir && rel !== '') rel += '/**' // 给目录 ⇒ 当"该目录下全部"看
  return { raw: s, abs, rel: outside ? null : rel, isDir, outside, note: null }
}

/** `git status --porcelain` → 改动路径数组（含 rename 的旧/新两侧）。 */
export function gitChangedPaths({ root = ROOT } = {}) {
  const res = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })
  if (res.error) throw new Error(`无法执行 git status：${res.error.message}`)
  if (res.status !== 0) throw new Error(`git status 非零退出（${res.status}）：${String(res.stderr ?? '').trim()}`)
  const paths = []
  for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    // 形状：`XY <path>`；rename/copy 为 `XY <old> -> <new>`；含特殊字符时 path 被引号包住。
    const rest = line.slice(3).trim()
    if (rest === '') continue
    const arrows = rest.split(' -> ')
    for (const one of arrows) paths.push(one.trim())
  }
  return paths
}

/**
 * ★ 核心推断：**只看路径**（不看提交信息、不看发起者、不看任何自述）。
 * @param {string[]} rawPaths
 * @param {{root?:string}} [opts]
 */
export function classifyPaths(rawPaths, opts = {}) {
  const root = opts.root ?? ROOT
  const paths = []
  /** @type {{level:string, ruleId:string, path:string, why:string, note?:string}[]} */
  const hits = []
  const reasons = []
  let outsideCount = 0

  for (const raw of rawPaths) {
    const n = normalizePath(raw, { root })
    if (n === null) continue
    paths.push(n.rel ?? n.raw)
    if (n.outside) {
      // ★ 树外路径：路径口径失效 ⇒ 保守判 R1（**不自动放行**），并点名。
      outsideCount += 1
      hits.push({
        level: 'R1',
        ruleId: 'R1-OUTSIDE-TREE',
        path: n.raw,
        why: '不在本仓库树内 ⇒ 本脚本的路径口径失效（无法判断它是否属启动/判据路径）⇒ 保守判 R1：不自动放行，交外部确认',
      })
      continue
    }
    for (const rule of RULES) {
      if (ruleMatches(rule, n.rel)) hits.push({ level: rule.level, ruleId: rule.id, path: n.rel, why: rule.why })
    }
  }

  // 命中数 = 0 且没有树外路径 ⇒ 兜底 R2
  if (hits.length === 0) {
    reasons.push(
      paths.length === 0
        ? `[DEFAULT] 改动路径为空（没有任何变更）⇒ 没有可推断的对象 ⇒ 默认 ${DEFAULT_LEVEL}（能力层）：空改动不需要外部见证`
        : `[DEFAULT] ${paths.length} 条路径均未命中 R0/R1 规则 ⇒ 默认 ${DEFAULT_LEVEL}（能力层：其余 = 普通代码/文档/产物）`,
    )
  }

  // ★ 取最严
  let level = DEFAULT_LEVEL
  if (hits.length > 0) {
    level = hits.reduce((acc, h) => (STRICTNESS[h.level] < STRICTNESS[acc] ? h.level : acc), 'R2')
  }

  // 逐条理由（按最严优先排序，便于人读）
  const sorted = [...hits].sort(
    (a, b) => STRICTNESS[a.level] - STRICTNESS[b.level] || a.ruleId.localeCompare(b.ruleId) || a.path.localeCompare(b.path),
  )
  for (const h of sorted) reasons.push(`[${h.ruleId}] ${h.level}: ${h.why} ｜ 命中: ${h.path}`)
  const perLevel = { R0: 0, R1: 0, R2: 0 }
  for (const h of hits) perLevel[h.level] += 1
  if (hits.length > 1) {
    reasons.push(
      `★ 多重命中取最严（R0 > R1 > R2）：命中 R0×${perLevel.R0} / R1×${perLevel.R1} / R2×${perLevel.R2} ⇒ 判 ${level}`,
    )
  }
  if (outsideCount > 0) {
    reasons.push(`⚠ 有 ${outsideCount} 条路径在本仓库树外 ⇒ 已按保守 R1 处理（不自动放行）`)
  }

  // ★ 自指提示（诚实记录，不改变级别）：本机制自己的两个脚本属"审批逻辑"语义，
  //   但它们在控制面之外、且未被控制面引用 ⇒ 按【路径口径】落 R2。见报告「不确定/未验证」。
  const SELF_FILES = ['scripts/change-classify.mjs', 'scripts/pending-approval.mjs']
  const selfReference = paths.some((p) => SELF_FILES.includes(p))
  if (selfReference) {
    reasons.push(
      '★ 自指：变更包含层级推断器/待批记录器自身。按【路径口径】它们在控制面之外、不被控制面引用 ⇒ R2；' +
        '但语义上它们是 §6.2 的"审批逻辑"（属 R1）⇒ 本轮**不自升**，且这正说明本机制目前只是"约定 + 可执行门"，不是机器约束（见报告）',
    )
  }

  return {
    level,
    paths,
    reasons,
    hits: sorted,
    selfReference,
    ruleCounts: perLevel,
    rulesetVersion: 'dsh-change-classify/v1',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则表打印（人读 / 审计）
// ─────────────────────────────────────────────────────────────────────────────

function printRules() {
  const lines = []
  lines.push('════════════════════════════════════════════════════════════════════════')
  lines.push('change-classify.mjs —— 规则表（R0 > R1 > R2，多重命中取最严）')
  lines.push('  口径：① R0 = 启动/恢复/回滚路径  ② R1 = 判据本身或其装置  ③ R2 = 其余')
  lines.push('  ★ 只看【变更的实际路径】；不看提交信息、不看发起者声明（§6.2 写死条文①）')
  lines.push('════════════════════════════════════════════════════════════════════════')
  for (const level of ['R0', 'R1', 'R2']) {
    lines.push('')
    lines.push(`── ${level} ────────────────────────────────────────────────────────────────`)
    for (const r of RULES.filter((x) => x.level === level)) {
      lines.push(`  ${r.id}`)
      lines.push(`      match : ${r.match.kind} ${r.match.pattern}`)
      if (r.unless && r.unless.length > 0) {
        lines.push(`      unless: ${r.unless.map((u) => `${u.kind} ${u.pattern}`).join('  /  ')}`)
      }
      lines.push(`      why   : ${r.why}`)
    }
  }
  lines.push('')
  lines.push('── 兜底 ─────────────────────────────────────────────────────────────────')
  lines.push(`  未命中任何规则 / 改动为空 ⇒ 默认 ${DEFAULT_LEVEL}`)
  lines.push('  在仓库树外 ⇒ 保守判 R1（路径口径失效 ⇒ 不自动放行）')
  lines.push('════════════════════════════════════════════════════════════════════════')
  process.stdout.write(`${lines.join('\n')}\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = { paths: [], rules: false, git: false, hasPaths: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--rules') {
      opts.rules = true
      continue
    }
    if (a === '--git') {
      opts.git = true
      continue
    }
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1
    const key = eq > 0 ? a.slice(2, eq) : a.startsWith('--') ? a.slice(2) : null
    if (key === null) throw new Error(`未知参数 "${a}"`)
    if (key !== 'paths') throw new Error(`未知参数 "--${key}"（支持：--paths / --rules / --git）`)
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (val === undefined) throw new Error('参数 --paths 缺少取值')
    opts.hasPaths = true
    for (const one of String(val).split(',')) if (one.trim() !== '') opts.paths.push(one.trim())
  }
  if (opts.rules && (opts.hasPaths || opts.git)) throw new Error('--rules 不能与 --paths/--git 同时用')
  return opts
}

function main(argv) {
  let opts
  try {
    opts = parseArgv(argv)
  } catch (e) {
    process.stderr.write(`change-classify 用法错误：${e.message}\n`)
    return 3
  }
  if (opts.rules) {
    printRules()
    return 0
  }

  let raw
  try {
    raw = opts.hasPaths ? opts.paths : gitChangedPaths()
  } catch (e) {
    process.stderr.write(`change-classify 取改动路径失败：${e.message}\n`)
    return 3
  }

  const result = classifyPaths(raw)
  result.source = opts.hasPaths ? 'paths' : 'git status --porcelain'
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (e) {
    process.stderr.write(`change-classify 内部错误：${e.message}\n`)
    process.exit(3)
  }
}
