#!/usr/bin/env node
/**
 * w61-verify-swap.mjs —— **换代（tool_apply）前的 verify 闸**（w61 这一批改动专用）。
 *
 * 谁调用它：控制面（`coordinator.runVerifyGate`）在 flip 之前执行。经
 *   `tool_apply(verify=<本脚本绝对路径>)` 提交 ⇒ 控制面先跑本脚本，**stdout 首个以 `{`
 *   开头的行**必须能 `JSON.parse` 且 `ok===true` 才正式 flip；否则判 verify-gate 失败 ⇒
 *   **非破坏回滚旧代**（coordinator.ts:481-509 / 587-667）。
 *
 * ★★ 设计原则（写死，不许弱化）：
 *   1. **fail-closed**：本脚本**自己**对每条判据做判决，任一条不过 ⇒ 打印 `{"ok":false,...}`
 *      且 **`process.exit(1)`**。**保险不靠调用方读 stdout**。
 *   2. **无副作用**：只读仓库与两臂；唯一的写是把合成读数/存档写进 `out/_w61/_verify-gens/`
 *      （该目录在 `.gitignore` 的 `out/` 下，**不会污染主仓**）。
 *   3. **stdout 里除了最后那行 JSON 之外，任何一行的 trim 后都不以 `{` 开头** ——
 *      否则控制面的"首个 `{` 行"会取错行。
 *
 * 判据（7 条，全部"必须为真"）：
 *   A. `evals/pilot/tasks.jsonl` = **7 行**，逐行可 JSON.parse，id 唯一，关键字段齐。
 *   B. **题面 v2**：从 `scripts/eval-run.mjs` 抽出**真实的 `taskPrompt` 源码**（不是手抄副本），
 *      对 7 条真任务逐条渲染 ⇒ ① 7/7 不含旧句「验证命令」；② 7/7 不含 `t.oracle`
 *      里的判据命令字样；③ 7/7 不含判据根路径字样（`dsh-brain` / `project_develop` /
 *      `_abA` / `_abB`）；④ 7/7 含「请自行确认」。
 *   C. **臂注册表可装载**：`evals/arms.json`（2 臂）与 `evals/arms.sample-3arm.json`（3 臂）都过
 *      `loadArmsRegistry`；且**负向自证**：故意缺 `store` 的对象必须抛 `ArmsRegistryError`
 *      （证明这是"闸"不是"永真"）。
 *   D. **跨代存档/对比能跑（端到端）**：`gen-archive` 造两代合成存档 ⇒ exit 0；
 *      `gen-compare --a vg1 --b vg2` ⇒ exit 0 且产出 delta 表。**负向自证两条**：
 *      `--evolution "TBD"` ⇒ exit 2（占位符拒写）；`--a vg1 --b vg1` ⇒ exit 2。
 *   E. **两臂 git 封 + 跟踪树逐字节一致**：注册表声明的两臂，各自 `rev-list --count HEAD == 1`
 *      （封过 = 只有 1 个提交）、`ls-files` 数相等、`HEAD^{tree}` **逐字相同**
 *      （tree 哈希相同 ⇒ 全部跟踪文件逐字节一致，含行尾）。
 *   F. **对称装置在位**：`scripts/eval-wt-new.mjs` 含 `--symmetry-only` 与收尾步 `[11]`；
 *      且 `TARGET_INCLUDES` **不含** `README.md`（`cli-0005` 的 README 里写着 oracle 命令，
 *      它必须留在保留区外 —— 这是"点名 oracle"通道被封住的**唯一依据**）。
 *   G. **回归**：`node scripts/gate-vector-run.mjs --impl <out/gatecheck.exe>` ⇒
 *      **16/16 PASS / 0 FAIL / 0 NEEDS-EVIDENCE / exit 0**。
 *
 * 用法：node scripts/w61-verify-swap.mjs
 * 退出码：0 = 全过（放行 flip）；1 = 有判据不过（控制面应回滚）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ArmsRegistryError, loadArmsRegistry, normalizeArmsRegistry } from './arms-registry.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 判据根（本脚本在 `scripts/` 下 ⇒ 上一级就是仓库根）。 ★ 不写死盘符，换位置也不会跑错。 */
const REPO = path.resolve(HERE, '..')
const NAME = 'w61-verify-swap'

const TASKS = path.join(REPO, 'evals', 'pilot', 'tasks.jsonl')
const EVAL_RUN = path.join(REPO, 'scripts', 'eval-run.mjs')
const ARMS_FILE = path.join(REPO, 'evals', 'arms.json')
const ARMS_SAMPLE = path.join(REPO, 'evals', 'arms.sample-3arm.json')
const WT_NEW = path.join(REPO, 'scripts', 'eval-wt-new.mjs')
const GEN_ARCHIVE = path.join(REPO, 'scripts', 'gen-archive.mjs')
const GEN_COMPARE = path.join(REPO, 'scripts', 'gen-compare.mjs')
const GATE_RUNNER = path.join(REPO, 'scripts', 'gate-vector-run.mjs')
const GATECHECK = path.join(REPO, 'out', 'gatecheck.exe')
const WORK = path.join(REPO, 'out', '_w61', '_verify-gens')

const results = []
const record = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') })

/** 跨行详情也保证"trim 后不以 `{` 开头"（否则会骗过控制面的"首个 { 行"）。 */
function safeOneLine(s) {
  return String(s ?? '')
    .split(/\r?\n/)
    .map((l) => (/^\s*\{/.test(l) ? '〔含 { 的行已缩为：〕' + l.trim().slice(1, 120) : l))
    .join(' ⏎ ')
}

function readText(p, label) {
  if (!fs.existsSync(p)) throw new Error(`${label} 不存在：${p}`)
  return fs.readFileSync(p, 'utf8')
}

/** 跑一个 node 脚本（绝不走 shell），返回 {status, stdout, stderr}。 */
function runNode(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 90_000,
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. tasks.jsonl = 7 行
// ─────────────────────────────────────────────────────────────────────────────
let tasks = []
try {
  const lines = readText(TASKS, 'tasks.jsonl').split(/\r?\n/).filter((l) => l.trim() !== '')
  const parsed = []
  const bad = []
  for (let i = 0; i < lines.length; i += 1) {
    try {
      parsed.push(JSON.parse(lines[i]))
    } catch (e) {
      bad.push(`第 ${i + 1} 行 JSON.parse 失败：${e.message}`)
    }
  }
  tasks = parsed
  const ids = parsed.map((t) => String(t?.id ?? ''))
  const dupes = ids.filter((x, i, all) => x !== '' && all.indexOf(x) !== i)
  const missing = parsed
    .map((t, i) => ({ i, need: ['id', 'invariant', 'kind', 'oracle', 'metrics', 'budget'].filter((k) => t?.[k] === undefined) }))
    .filter((x) => x.need.length > 0)
    .map((x) => `第 ${x.i + 1} 条缺 ${x.need.join('/')}`)
  const ok = lines.length === 7 && bad.length === 0 && dupes.length === 0 && missing.length === 0
  record(
    'A: tasks.jsonl 恰好 7 行且逐行合法（id 唯一、关键字段齐）',
    ok,
    safeOneLine(
      `非空行=${lines.length}（期望 7）；parse 失败=${bad.length}；重复 id=${dupes.length}；缺字段=${missing.length}` +
        (bad.length || dupes.length || missing.length ? ` ｜ ${[...bad, ...dupes, ...missing].join(' ; ')}` : ''),
    ),
  )
} catch (e) {
  record('A: tasks.jsonl 恰好 7 行且逐行合法（id 唯一、关键字段齐）', false, safeOneLine(e.message))
}

// ─────────────────────────────────────────────────────────────────────────────
// B. 题面 v2（★ 从真实源码抽函数，不手抄）
// ─────────────────────────────────────────────────────────────────────────────
try {
  const src = readText(EVAL_RUN, 'scripts/eval-run.mjs')
  const start = src.indexOf('function taskPrompt(')
  if (start < 0) throw new Error('在 scripts/eval-run.mjs 里找不到 `function taskPrompt(` 的源码')
  // 从函数起点找到**列 0 的收尾 `}`**（该函数是顶层 function 声明）。
  const rest = src.slice(start)
  const endIdx = rest.search(/\r?\n\}/)
  if (endIdx < 0) throw new Error('taskPrompt 源码没能找到收尾大括号')
  const fnSrc = rest.slice(0, endIdx + 3)
  // eslint-disable-next-line no-new-func
  const taskPrompt = new Function(`${fnSrc}; return taskPrompt;`)()
  if (typeof taskPrompt !== 'function') throw new Error('抽出的 taskPrompt 不是函数')

  const badOld = []
  const badOracle = []
  const badRoot = []
  const badNew = []
  const rootMarks = ['dsh-brain', 'project_develop', '_abA', '_abB']
  for (const t of tasks) {
    const p = String(taskPrompt(t))
    if (p.includes('验证命令')) badOld.push(t.id)
    const oracleCmd = String(t?.oracle ?? '')
    // 只检"判据命令的可执行部分"（脚本相对路径），避免误伤同名的普通词。
    const oraclePaths = oracleCmd.match(/[\w./-]*\.(?:mjs|js|cjs|py)\b/g) ?? []
    if (oraclePaths.some((x) => x && p.includes(x))) badOracle.push(`${t.id}（${oraclePaths.filter((x) => p.includes(x)).join(',')}）`)
    if (rootMarks.some((m) => p.includes(m))) badRoot.push(t.id)
    if (!p.includes('请自行确认')) badNew.push(t.id)
  }
  const ok =
    tasks.length === 7 && badOld.length === 0 && badOracle.length === 0 && badRoot.length === 0 && badNew.length === 0
  record(
    'B: 题面 v2 —— 7/7 无旧句「验证命令」、不点名 oracle 脚本、不含判据根路径、含「请自行确认」',
    ok,
    safeOneLine(
      `题数=${tasks.length}；含旧句=${badOld.length}${badOld.length ? '（' + badOld.join(',') + '）' : ''}；` +
        `点名 oracle 脚本=${badOracle.length}${badOracle.length ? '（' + badOracle.join(' ') + '）' : ''}；` +
        `含判据根路径字样=${badRoot.length}${badRoot.length ? '（' + badRoot.join(',') + '）' : ''}；` +
        `缺「请自行确认」=${badNew.length}${badNew.length ? '（' + badNew.join(',') + '）' : ''}` +
        `；函数源码 ${fnSrc.length} 字符`,
    ),
  )
} catch (e) {
  record('B: 题面 v2 —— 7/7 无旧句「验证命令」、不点名 oracle 脚本、不含判据根路径、含「请自行确认」', false, safeOneLine(e.message))
}

// ─────────────────────────────────────────────────────────────────────────────
// C. 臂注册表可装载（含负向自证）
// ─────────────────────────────────────────────────────────────────────────────
let arms = []
try {
  const reg = loadArmsRegistry(ARMS_FILE, { base: REPO })
  const reg3 = loadArmsRegistry(ARMS_SAMPLE, { base: REPO })
  arms = reg.arms
  // ★ 负向自证：缺 store ⇒ 必须抛 ArmsRegistryError（否则本闸对"注册表"没有分辨力）。
  let threw = null
  try {
    normalizeArmsRegistry({
      controlled: ['system'],
      arms: [{ name: 'X', role: 'control', cwd: 'D:/tmp/x', label: '缺 store 的臂' }],
    })
  } catch (e) {
    threw = e
  }
  // ★ 负向自证 2：非法 role ⇒ 必须抛。
  let threw2 = null
  try {
    normalizeArmsRegistry({ arms: [{ name: 'Y', role: 'wat', cwd: 'D:/tmp/y', store: 'D:/tmp/ys', label: 'l' }] })
  } catch (e) {
    threw2 = e
  }
  const negOk = threw instanceof ArmsRegistryError && threw2 instanceof ArmsRegistryError
  const ok = reg.arms.length >= 2 && reg3.arms.length === 3 && negOk
  record(
    'C: 臂注册表可装载（arms.json≥2 臂 / sample-3arm=3 臂）+ 缺字段与非法 role 必须被拒（负向自证）',
    ok,
    safeOneLine(
      `arms.json=${reg.arms.length} 臂 [${reg.arms.map((a) => `${a.name}:${a.role}`).join(' ')}]；` +
        `sample-3arm=${reg3.arms.length} 臂 [${reg3.arms.map((a) => `${a.name}:${a.role}`).join(' ')}]；` +
        `缺 store ⇒ ${threw ? 'ArmsRegistryError ✓' : '**没报错 ✗**'}；非法 role ⇒ ${threw2 ? 'ArmsRegistryError ✓' : '**没报错 ✗**'}`,
    ),
  )
} catch (e) {
  record('C: 臂注册表可装载（arms.json≥2 臂 / sample-3arm=3 臂）+ 缺字段与非法 role 必须被拒（负向自证）', false, safeOneLine(e.message))
}

// ─────────────────────────────────────────────────────────────────────────────
// D. 跨代存档 + 对比能跑（端到端 + 负向自证）
// ─────────────────────────────────────────────────────────────────────────────
try {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  const mk = (gen, toolCalls) => ({
    gen,
    tasks: ['t-alpha', 't-beta'],
    arms: {
      A: { 't-alpha': { ok: true, toolCalls, tokens: 1000, wallMs: 5000, dangerous: 0 } },
      B: { 't-beta': { ok: false, toolCalls: toolCalls + 4, tokens: null, wallMs: 9000, dangerous: 1 } },
    },
  })
  const f1 = path.join(WORK, 'vg1.readings.json')
  const f2 = path.join(WORK, 'vg2.readings.json')
  fs.writeFileSync(f1, JSON.stringify(mk('vg1', 12), null, 2) + '\n', 'utf8')
  fs.writeFileSync(f2, JSON.stringify(mk('vg2', 7), null, 2) + '\n', 'utf8')

  const a1 = runNode(GEN_ARCHIVE, ['--gen', 'vg1', '--readings', f1, '--evolution', 'verify 闸自检：合成第一代读数（工具调用 12）', '--out-root', WORK])
  const a2 = runNode(GEN_ARCHIVE, ['--gen', 'vg2', '--readings', f2, '--evolution', 'verify 闸自检：合成第二代读数（工具调用降到 7）', '--out-root', WORK])
  const cmp = runNode(GEN_COMPARE, ['--a', 'vg1', '--b', 'vg2', '--gens-root', WORK])

  // 负向自证①：占位符 --evolution ⇒ 必须 exit 2 且不落盘。
  const f3 = path.join(WORK, 'vg3.readings.json')
  fs.writeFileSync(f3, JSON.stringify(mk('vg3', 5), null, 2) + '\n', 'utf8')
  const neg1 = runNode(GEN_ARCHIVE, ['--gen', 'vg3', '--readings', f3, '--evolution', 'TBD', '--out-root', WORK])
  // 负向自证②：自己比自己 ⇒ 必须 exit 2。
  const neg2 = runNode(GEN_COMPARE, ['--a', 'vg1', '--b', 'vg1', '--gens-root', WORK])

  // ★ 判"真产出了表"不能只看 exit 0：必须看到表头 + 真算出来的 delta + 对数。
  const hasHeader = cmp.stdout.includes('Δ = B 代 − A 代')
  const hasDelta = cmp.stdout.includes('-5（12→7）')
  const hasPairs = /参与对比的 \(臂, 题\) 对数 = 2/.test(cmp.stdout)
  const ok =
    a1.status === 0 &&
    a2.status === 0 &&
    cmp.status === 0 &&
    hasHeader &&
    hasDelta &&
    hasPairs &&
    neg1.status === 2 &&
    neg2.status === 2 &&
    !fs.existsSync(path.join(WORK, 'vg3'))
  record(
    'D: gen-archive 造两代 + gen-compare 产 delta 表（端到端）；占位符 evolution 与自比自都必须被拒（负向）',
    ok,
    safeOneLine(
      `gen-archive vg1 exit=${a1.status}；vg2 exit=${a2.status}；gen-compare exit=${cmp.status}` +
        `（表头=${hasHeader}；真算出 delta -5（12→7）=${hasDelta}；对数=2 行=${hasPairs}）；` +
        `负向 evolution=TBD exit=${neg1.status}（期望 2，vg3 未落盘=${!fs.existsSync(path.join(WORK, 'vg3'))}）；` +
        `负向 --a vg1 --b vg1 exit=${neg2.status}（期望 2）` +
        (a1.status !== 0 || a2.status !== 0 || cmp.status !== 0
          ? ` ｜ ${safeOneLine(((a1.stderr || '') + (a2.stderr || '') + (cmp.stderr || '')).slice(0, 400))}`
          : ''),
    ),
  )
} catch (e) {
  record(
    'D: gen-archive 造两代 + gen-compare 产 delta 表（端到端）；占位符 evolution 与自比自都必须被拒（负向）',
    false,
    safeOneLine(e.message),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E. 两臂：git 封（1 个提交）+ 跟踪树逐字节一致
// ─────────────────────────────────────────────────────────────────────────────
try {
  const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000 })
  const rows = []
  let ok = arms.length >= 2
  const trees = []
  const counts = []
  for (const a of arms) {
    if (!fs.existsSync(a.cwd)) {
      rows.push(`${a.name}：目录不存在 ${a.cwd}`)
      ok = false
      continue
    }
    const cnt = git(a.cwd, ['rev-list', '--count', 'HEAD'])
    const tree = git(a.cwd, ['rev-parse', 'HEAD^{tree}'])
    const ls = git(a.cwd, ['ls-files'])
    const nFiles = String(ls.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '').length
    const nCommits = Number(String(cnt.stdout ?? '').trim())
    const treeId = String(tree.stdout ?? '').trim()
    trees.push(treeId)
    counts.push(nFiles)
    if (cnt.status !== 0 || tree.status !== 0 || ls.status !== 0) ok = false
    if (nCommits !== 1) ok = false
    rows.push(`${a.name}：提交数=${nCommits} 跟踪文件=${nFiles} tree=${treeId}`)
  }
  if (trees.length >= 2 && new Set(trees).size !== 1) ok = false
  if (counts.length >= 2 && new Set(counts).size !== 1) ok = false
  record(
    'E: 注册表两臂都 git 封（HEAD 只有 1 个提交）且 HEAD^{tree} 逐字相同（= 跟踪文件逐字节一致）',
    ok,
    safeOneLine(
      `${rows.join(' ｜ ')} ｜ tree 全同=${trees.length >= 2 && new Set(trees).size === 1}；跟踪文件数全同=${counts.length >= 2 && new Set(counts).size === 1}`,
    ),
  )
} catch (e) {
  record('E: 注册表两臂都 git 封（HEAD 只有 1 个提交）且 HEAD^{tree} 逐字相同（= 跟踪文件逐字节一致）', false, safeOneLine(e.message))
}

// ─────────────────────────────────────────────────────────────────────────────
// F. 对称装置在位（--symmetry-only / [11] / TARGET_INCLUDES 不含 README.md）
// ─────────────────────────────────────────────────────────────────────────────
try {
  const s = readText(WT_NEW, 'scripts/eval-wt-new.mjs')
  const hasSymOnly = s.includes('--symmetry-only')
  const hasStep11 = /\[11\]/.test(s)
  const hasDcClear = /function\s+dcClear\s*\(/.test(s)
  // TARGET_INCLUDES 数组字面量的内容（从 `const TARGET_INCLUDES = [` 到第一个 `]`）。
  const m = s.match(/const TARGET_INCLUDES\s*=\s*\[([\s\S]*?)\]/)
  const includeBody = m ? m[1] : ''
  const readmeIncluded = m ? /README\.md/i.test(includeBody) : true
  const ok = hasSymOnly && hasStep11 && hasDcClear && m !== null && !readmeIncluded
  record(
    'F: 对称装置在位（--symmetry-only + 收尾 [11] + dcClear），且 TARGET_INCLUDES 不含 README.md（点名 oracle 通道仍是断的）',
    ok,
    safeOneLine(
      `含 --symmetry-only=${hasSymOnly}；含 [11] 收尾=${hasStep11}；有 dcClear 定义=${hasDcClear}；` +
        `TARGET_INCLUDES 解析到=${m !== null}；其中含 README.md=${readmeIncluded}（必须 false）`,
    ),
  )
} catch (e) {
  record(
    'F: 对称装置在位（--symmetry-only + 收尾 [11] + dcClear），且 TARGET_INCLUDES 不含 README.md（点名 oracle 通道仍是断的）',
    false,
    safeOneLine(e.message),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G. 回归：gate-vector-run 16/16 PASS
// ─────────────────────────────────────────────────────────────────────────────
try {
  if (!fs.existsSync(GATE_RUNNER)) throw new Error(`gate-vector-run.mjs 不存在：${GATE_RUNNER}`)
  if (!fs.existsSync(GATECHECK)) throw new Error(`gatecheck.exe 不存在：${GATECHECK}`)
  const r = runNode(GATE_RUNNER, ['--impl', GATECHECK], { timeoutMs: 100_000 })
  const so = r.stdout ?? ''
  const se = r.stderr ?? ''
  try {
    fs.mkdirSync(path.join(REPO, 'out'), { recursive: true })
    fs.writeFileSync(path.join(REPO, 'out', 'w61-verify-gate-vector.txt'), so + se, 'utf8')
  } catch {
    /* 落盘失败不影响判据 */
  }
  const allPass = /16\/16 PASS/.test(so)
  const zeroFail = /0 FAIL/.test(so) && /0 NEEDS-EVIDENCE/.test(so)
  const ok = r.status === 0 && allPass && zeroFail
  record(
    'G: 回归 gate-vector-run 16/16 PASS（exit 0，0 FAIL，0 NEEDS-EVIDENCE）',
    ok,
    safeOneLine(
      `exit=${r.status}；含「16/16 PASS」=${allPass}；0 FAIL / 0 NEEDS-EVIDENCE=${zeroFail}` +
        `；原始输出 → out/w61-verify-gate-vector.txt` +
        (ok ? '' : ` ｜ ${(so + se).slice(0, 300)}`),
    ),
  )
} catch (e) {
  record('G: 回归 gate-vector-run 16/16 PASS（exit 0，0 FAIL，0 NEEDS-EVIDENCE）', false, safeOneLine(e.message))
}

// ─────────────────────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
const ok = failed.length === 0 && results.length === 7

console.log(`[${NAME}] 换代前 verify 闸 —— 判据明细（判据根 ${REPO.replace(/\\/g, '/')}）：`)
for (const r of results) console.log(`  ${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}\n         ${r.detail}`)
console.log(
  `[${NAME}] 合计 ${results.length - failed.length}/${results.length} PASS ⇒ ${ok ? '放行 flip' : '**拒绝 flip**（控制面应回滚旧代）'}`,
)
// ★ 控制面只认 stdout 首个以 `{` 开头的行 ⇒ 这一行必须是唯一一行"以 { 开头"的输出。
console.log(
  JSON.stringify({
    ok,
    reason: ok
      ? 'w61: tasks7 + prompt-v2 + arms-registry(±neg) + gen-archive/compare(±neg) + arms-identical + symmetry-device + gate-16/16'
      : 'failed: ' + failed.map((f) => f.name).join(' | '),
    checks: results.map((r) => ({ name: r.name, ok: r.ok })),
  }),
)

process.exit(ok ? 0 : 1)
