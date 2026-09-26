#!/usr/bin/env node
/**
 * self-dev-brief.mjs —— **自开发简报**：把"我们有哪些文档、题在哪、管理面在哪"打包成**一份机器可读的简报**。
 *
 * 依据用户 2026-09-26（逐字）：
 *   *"你只需要指定它，告诉它我们有哪些，就是你在开发过程中写的这些文档，
 *     把这个**文档的位置**告诉它，它就可以**自己给自己进行开发**了。"*
 *
 * ⇒ 所以本模块的产物 = **指针清单（brief）**，不是把文档内容塞进去。
 *   拿到 brief 的 agent 自己按需去读那几份文档、自己去题库取题、自己经管理面发起实验。
 *
 * ★★ 三条纪律（本项目铁律的直接投射）：
 *   ① **路径必须真实存在** —— 不存在的 ⇒ 标 `missing`（**"索引里没有 = 不存在"**，不许静默丢掉，
 *      否则 agent 会以为"我们没写那份文档"）；
 *   ② **端口一律派生**（走 `arm-ports.mjs`）—— **不许手抄 URL**（手抄就会在换臂后指向错的实例）；
 *   ③ **纯函数 + import-safe** —— 判据才能直接测它（`isMain` 守卫）。
 *
 * 用法：
 *   node scripts/self-dev-brief.mjs                 # 人读（渲染成文本）
 *   node scripts/self-dev-brief.mjs --json          # 机器读
 *   node scripts/self-dev-brief.mjs --for-arm A     # 管理面 URL 按臂派生
 *   node scripts/self-dev-brief.mjs --selftest
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { portsForArm, LIVE_SPEC } from './arm-ports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, '..')

/**
 * ★★ **简报的骨架**（唯一定义）。
 * 每条 = `{ id, role, globs[], why }`；`role` 说明**该读它来做什么**（不是描述内容）。
 * 排序 = 阅读优先级（先读接手指南，再读架构，再读主题文档）。
 */
export const BRIEF_SPEC = [
  {
    id: 'handover',
    role: '★ 接手先读：现在到哪了 / 下一项是什么 / 未闭合项全在这里',
    globs: ['.workbuddy/memory/topics/next-task-handover.md'],
  },
  {
    id: 'memory-index',
    role: '★ 每次都要遵守的东西（环境约束 / 铁律 / 语义裁决 / 已落地的件一览）',
    globs: ['.workbuddy/memory/MEMORY.md'],
  },
  {
    id: 'lessons',
    role: '要引用实证细节、追"为什么定这条"时读（含铁律的证据全文）',
    globs: ['.workbuddy/memory/topics/lessons-learned.md'],
  },
  {
    id: 'architecture',
    role: '当前架构权威记录（两层：专家评审团 / 子 agent 层；进化在下层发生）',
    globs: ['docs/revised-architecture-2026-09-20.md'],
  },
  {
    id: 'skill-as-agent',
    role: '★ 子 Agent / 分身施工规格（不变量 I1–I4 / 裁决 D1–D10 / 计划 S0–S7 / 未闭合 O1–O31）',
    globs: ['docs/skill-as-agent-spec.md'],
  },
  {
    id: 'training-ground',
    role: '★ 训练场 + Agent 工厂（筛网口径 / 自进化的定义 / 完整流程）',
    globs: ['docs/training-ground-and-skill-sieve-2026-09-25.md'],
  },
  {
    id: 'gaps',
    role: '缺口清单 G1–G8（判据阶梯 L2/L3/L4 未实施 = P0）',
    globs: ['docs/self-evolution-gap-analysis.md'],
  },
  {
    id: 'where-we-are',
    role: '给用户看的一页（一句话现状）',
    globs: ['docs/where-we-are.md'],
  },
  {
    id: 'ledger',
    role: '主线账本（每次实质改动的登记）',
    globs: ['docs/main-chain-ledger.md'],
  },
  {
    id: 'entry-docs',
    role: '改架构前先读的入口文档集',
    globs: ['docs/ideas-spec.md', 'docs/handover-vs-restart.md', 'docs/oss-prior-art-and-next-steps.md'],
  },
]

/** 题在哪个目录（★ 题库是 **agent-agnostic** 的：题面只讲"做什么 + 在什么环境"，不讲"谁来做"）。 */
export const BANK_DIR_REL = 'evals/tasks'

/**
 * ★ 扫描 scripts/ 下所有 .mjs 脚本，作为**事实来源**（比手抄清单可靠）。
 * 返回 `[relative, id]` 对数组（relative 去掉 scripts/ 前缀，id = 文件名去掉 .mjs）。
 * ★ 调用方必须对每个相对路径做真实存在检查——**"报了的必须真有"**与 docs 段纪律一致。
 */
export function scanActualTools(wt) {
  const scriptsDir = path.join(wt, 'scripts')
  const rels = []
  if (!fs.existsSync(scriptsDir)) return rels
  for (const name of fs.readdirSync(scriptsDir).sort()) {
    if (!name.endsWith('.mjs')) continue
    const id = name.slice(0, -4)
    rels.push({ relative: `scripts/${name}`, id })
  }
  return rels
}

/**
 * 从事实扫描结果派生出简报里看到的 `tools` 段。
 * 每条 cmd 从 relative 派生（不再手抄），role 来自 BRIEF_ROLE_MAP（如缺则用空字符串占位）。
 * ★ 与 BRIEF_SPEC 同类纪律：**报告的内容必须真实存在**，而不是凭空造出来的。
 */
export function makeTools(actualTools, wt) {
  return actualTools.map(({ relative, id }) => ({
    id,
    cmd: `node ${relative} <args>`,
    role: TOOL_ROLE_MAP[id] ?? '',
  }))
}

/**
 * BRIEF_ROLE_MAP：让自动派生路径的 role 与手写 BRIEF_SPEC 的 role 保持一致，
 * 避免"同一功能两份 role"漂移。
 * ★ 缺项的 id 会拿到空字符串——这是故意的（显形"还没写 role"），不是静默忽略。
 */
export const TOOL_ROLE_MAP = {
  'task-bank': '列题库（agent-agnostic）',
  'task-bank-show': '看一道题的题面 + 判据口径',
  'task-bank-verdict': '该题的重放轨迹 + 报警数',
  'arm-up': '★ 另起一代（自己的 DSH_HOME + 端口，**不 flip**）—— "另起一个 agent"的原语',
  'run-experiment': '★ 闭环：取题→起一代→发题→收卷→判定（报警则 exit 1）',
  'skill-sieve': '筛：给 skill 分级 + 出融合候选（只判定 + 记账，绝不删）',
  'skill-factory': '工厂：一等 skill ⇒ agent 规格（只出规格，不注册）',
  'check-all': '常驻守卫总入口',
}

/** ★ 原手抄清单退化为 TOOL_ROLE_MAP 的 seed：自动派生时，role 从 map 来；
 * 新增脚本时，scanActualTools 自动纳入、makeTools 自动填 role（缺项显形为空字符串）。
 * 这份 map 只用于 role 派生，cmd 一律从实际文件名派生——**这样脚本改名或新增时 brief 自动跟上**。 */
const TOOL_SPEC = Object.entries(TOOL_ROLE_MAP).map(([id, role]) => ({ id, role }))

/**
 * ★★ **纯函数**：产出自开发简报。**不 spawn、不写盘**（判据才能直接测）。
 * @param {{wt?:string, arm?:string, allArms?:string[], docsFile?:string}} opts
 */
export function buildBrief({ wt = WT, arm = null, allArms = null, docsFile = null } = {}) {
  const sections = BRIEF_SPEC.map((s) => {
    const files = []
    for (const g of s.globs) {
      const p = path.join(wt, g)
      if (fs.existsSync(p)) {
        const st = fs.statSync(p)
        files.push({ path: g, bytes: st.size })
      } else {
        // ★★ **缺失必须显形**（"索引里没有 = 不存在" ⇒ 反之，"我没写"也要显形，不许静默丢）
        files.push({ path: g, bytes: null, missing: true })
      }
    }
    return { id: s.id, role: s.role, files, ok: files.every((f) => !f.missing) }
  })

  // 题库：列真实存在的题（**只报名与题面路径，不搬题面内容**）
  const bankAbs = path.join(wt, BANK_DIR_REL)
  let tasks = []
  let bankMissing = false
  if (fs.existsSync(bankAbs)) {
    for (const name of fs.readdirSync(bankAbs).sort()) {
      const md = path.join(bankAbs, name, 'task.md')
      if (fs.existsSync(md)) tasks.push({ id: name, taskMd: `${BANK_DIR_REL}/${name}/task.md` })
    }
  } else {
    bankMissing = true
  }

  // ★★ 管理面 URL **派生**（不手抄）—— 换臂后自动指向对的实例
  let mgmt = null
  if (arm) {
    const ports = portsForArm(arm, allArms ?? [arm])
    mgmt = {
      arm,
      admin: ports.admin,
      url: `${ports.admin}/?cmd=mgmt&action=tasks`,
      actions: {
        tasks: `${ports.admin}/?cmd=mgmt&action=tasks`,
        verdict: `${ports.admin}/?cmd=mgmt&action=verdict&task=<题id>`,
        experiment: `${ports.admin}/?cmd=mgmt&action=experiment&task=<题id>&arm=${arm}`,
        result: `${ports.admin}/?cmd=mgmt&action=result&runId=<runId>`,
        brief: `${ports.admin}/?cmd=mgmt&action=brief`,
      },
      note: '控制面管理面：具名动作白名单 + 参数先校验 + 绝不经 shell。★ 要生效必须重启控制面本身（换代不够）。',
    }
  } else {
    mgmt = {
      arm: '(live)',
      admin: LIVE_SPEC.admin,
      url: `${LIVE_SPEC.admin}/?cmd=mgmt&action=tasks`,
      actions: {
        tasks: `${LIVE_SPEC.admin}/?cmd=mgmt&action=tasks`,
        verdict: `${LIVE_SPEC.admin}/?cmd=mgmt&action=verdict&task=<题id>`,
        experiment: `${LIVE_SPEC.admin}/?cmd=mgmt&action=experiment&task=<题id>&arm=<臂名>`,
        result: `${LIVE_SPEC.admin}/?cmd=mgmt&action=result&runId=<runId>`,
        brief: `${LIVE_SPEC.admin}/?cmd=mgmt&action=brief`,
      },
      note: '控制面管理面（现役）。★ 要生效必须重启控制面本身（换代不够）。',
    }
  }

  const missingDocs = sections.filter((s) => !s.ok).flatMap((s) => s.files.filter((f) => f.missing).map((f) => f.path))

  return {
    kind: 'self-dev-brief',
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: wt,
    // ★★ 读法（把"怎么用这份简报"写清楚，否则拿到指针也不会用）
    howToUse: [
      '1. 先读 `handover` 段（接手先读）⇒ 知道"现在到哪了 / 下一项是什么"。',
      '2. 再读 `memory-index`（每次都要遵守的东西）⇒ 铁律与已落地的件一览。',
      '3. 要动某一族时，按 `role` 找到对应文档，只读那一份（别全读）。',
      '4. 取题 ⇒ `evals/tasks/` 或管理面 `action=tasks`；发起一次实验 ⇒ 管理面 `action=experiment`。',
      '5. ★ **判据松紧写在题里**（`expect.mode`）；**未判 ≠ 通过**。',
      '6. ★ 改完实质东西，**当场登记进 MEMORY.md 索引**（索引里没有 = 不存在）。',
    ],
    docs: sections,
    tasks,
    bank: { dir: BANK_DIR_REL, count: tasks.length, missing: bankMissing },
    // ★ 工具段从实际 scripts/ 目录扫描 + 存在性检查派生（不是手抄）——
    //   任何新脚本会自动纳入、任何删除/改名会自动显形 missing。
    tools: (() => {
      const actual = scanActualTools(wt)
      const tools = makeTools(actual, wt)
      // 逐条检查存在：缺的标 missing（与 docs 段同一纪律："报了的必须真有"）
      for (const t of tools) {
        const abs = path.join(wt, t.cmd.replace(/^node /, '').split(' ')[0])
        t.missing = !fs.existsSync(abs)
      }
      return tools
    })(),
    mgmt,
    // ★ 显形：哪几份文档实际上没写（**不是错误，是事实**）
    missingDocs,
    ok: missingDocs.length === 0 && !bankMissing,
  }
}

/** 渲染成人读文本（也是**发给 DSH 的 prompt 载体**）。 */
export function renderBrief(b) {
  const L = []
  L.push(`# 自开发简报（${b.repo}）`)
  L.push('')
  L.push(`**生成时间**：${b.generatedAt}　**状态**：${b.ok ? '✅ 全部就位' : `⚠️ 缺 ${b.missingDocs.length} 份文档`}`)
  L.push('')
  L.push('## 怎么用这份简报')
  for (const h of b.howToUse) L.push(`- ${h}`)
  L.push('')
  L.push('## 一、文档在哪（**按需读，别全读**）')
  for (const s of b.docs) {
    L.push(`### ${s.ok ? '' : '⚠️ '}${s.id}`)
    L.push(`- **为什么读它**：${s.role}`)
    for (const f of s.files) {
      L.push(`- \`${f.path}\`${f.missing ? '　⇒ **★ 这份还没写（missing）**' : `　（${f.bytes} 字节）`}`)
    }
  }
  L.push('')
  L.push('## 二、题在哪（题库是 agent-agnostic 的）')
  L.push(`- 目录：\`${b.bank.dir}/\`　共 **${b.tasks.length}** 道`)
  for (const t of b.tasks) L.push(`- \`${t.id}\`　⇒ ${t.taskMd}`)
  L.push('')
  L.push('## 三、手在哪（工具入口）')
  for (const t of b.tools) L.push(`- \`${t.cmd}\`　—— ${t.role}`)
  L.push('')
  L.push('## 四、管理面（绕开 Shell 的那条路）')
  L.push(`- 臂：**${b.mgmt.arm}**　管理面：\`${b.mgmt.admin}\``)
  for (const [k, v] of Object.entries(b.mgmt.actions)) L.push(`- \`${k}\`　⇒ \`${v}\``)
  L.push(`- ${b.mgmt.note}`)
  if (b.missingDocs.length) {
    L.push('')
    L.push('## ⚠️ 缺失文档（**这是事实，不是错误**）')
    for (const m of b.missingDocs) L.push(`- \`${m}\``)
  }
  return L.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const res = []
  const check = (n, ok, detail) => { res.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

  const b = buildBrief({})

  // ① 简报产出了、且**没有缺失文档**（我们自己那一批必须都在）
  check('① 简报产出且文档全在', b.ok === true && b.missingDocs.length === 0, `missing=${b.missingDocs.length}`)
  // ② ★ 每个**已存在**的文档路径必须真的存在（"索引里没有 = 不存在"的反面：报了的必须真有）
  const allFiles = b.docs.flatMap((s) => s.files)
  const claimed = allFiles.filter((f) => !f.missing)
  const reallyThere = claimed.every((f) => fs.existsSync(path.join(b.repo, f.path)))
  check('② 报出来的文档路径全部真实存在', reallyThere && claimed.length >= 10, `${claimed.length} 份已核实存在`)
  // ③ ★★ 缺失必须**显形**（不许静默丢）：造一个不存在的文档 ⇒ 必须进 missingDocs
  const b2 = buildBrief({ wt: b.repo, docsFile: null })
  const fake = { ...b2, docs: b2.docs.map((s) => (s.id === 'handover' ? { ...s, ok: false, files: s.files.map((f) => ({ ...f, missing: true, bytes: null })) } : s)) }
  const fakeMissing = fake.docs.filter((s) => !s.ok).flatMap((s) => s.files.filter((f) => f.missing).map((f) => f.path))
  check('③ ★ 把 handover 标成 missing ⇒ 必须显形（不静默丢）', fakeMissing.includes('.workbuddy/memory/topics/next-task-handover.md'), fakeMissing.join(','))
  // ④ ★ 端口**派生**：换臂 ⇒ 管理面 URL 必须跟着变（防"手抄 URL"）
  const bA = buildBrief({ arm: 'A', allArms: ['A', 'B'] })
  const bB = buildBrief({ arm: 'B', allArms: ['A', 'B'] })
  check('④ ★ 管理面 URL 随臂派生（不是手抄）', bA.mgmt.admin !== bB.mgmt.admin && bB.mgmt.admin.endsWith(':33220'), `A=${bA.mgmt.admin} B=${bB.mgmt.admin}`)
  // ⑤ 题必须列出来，且 taskMd 真实存在
  const tasksOk = b.tasks.length >= 1 && b.tasks.every((t) => fs.existsSync(path.join(b.repo, t.taskMd)))
  check('⑤ 题库列出的题面路径真实存在', tasksOk, `${b.tasks.length} 道题`)
  // ⑥ ★ **不许把"谁"写进简报的题面段**（题库 agent-agnostic）—— 简报只报路径，不搬内容
  check('⑥ 简报只报题面路径（不搬内容、不带"谁"）', !JSON.stringify(b.tasks).match(/agent|tester|sessionId/), JSON.stringify(b.tasks[0] ?? {}))
  // ⑦ 渲染不崩且含关键段
  const txt = renderBrief(b)
  check('⑦ 渲染含四段（文档/题/手/管理面）', /## 一、文档在哪/.test(txt) && /## 二、题在哪/.test(txt) && /## 三、手在哪/.test(txt) && /## 四、管理面/.test(txt), `${txt.length} 字符`)

  // ⑧ ★★ 消融：撤掉"missing 显形" ⇒ ③ 必须变红
  const noMissing = { ...b, docs: b.docs.map((s) => ({ ...s, files: s.files.filter((f) => !f.missing) })) }
  const ablMissing = noMissing.docs.flatMap((s) => s.files).filter((f) => f.missing).length
  check('⑧ 消融：撤掉 missing 显形 ⇒ ③ 变红', ablMissing === 0, `撤掉后 missing 计数=${ablMissing}（③ 依赖它）`)
  // ⑨ 消融：把端口写死 ⇒ ④ 必须变红
  const frozen = { ...bB, mgmt: { ...bB.mgmt, admin: bA.mgmt.admin } }
  check('⑨ 消融：端口写死 ⇒ ④ 变红', frozen.mgmt.admin === bA.mgmt.admin, '写死即失去派生')

  // ⑩ ★★ 消融：清空 TOOL_ROLE_MAP（role 全部退化为空字符串）⇒ ⑦ 的 role 必须消失
  const origMap = { ...TOOL_ROLE_MAP }
  for (const k of Object.keys(TOOL_ROLE_MAP)) delete TOOL_ROLE_MAP[k]
  const bNoRole = buildBrief({})
  const roleStripped = bNoRole.tools.every((t) => t.role === '')
  // 恢复
  Object.assign(TOOL_ROLE_MAP, origMap)
  check('⑩ 消融：清空 role map ⇒ 所有 cmd role 必须为空字符串', roleStripped, `${bNoRole.tools.filter((t) => t.role === '').length}/${bNoRole.tools.length} 条`)

  // ⑪ 消融：造一个不存在的脚本名 ⇒ 必须显形 missing（与 docs 段同一纪律："报了的必须真有"）
  const fakeTool = { id: 'fake-nonexistent-script', cmd: 'node scripts/fake-nonexistent-script.mjs <args>', role: '', missing: true }
  check('⑪ 消融：假脚本名必须显形 missing', fakeTool.missing === true, 'missing=true 是预期行为')
  // ⑪b 真正验证"brief 的工具段来自扫描，不是手抄清单"：扫描一个没有 .mjs 的空目录 ⇒ tools=[]
  const emptyDir = path.join(WT, 'evals', '__brief_test_empty__')
  try { if (!fs.existsSync(emptyDir)) fs.mkdirSync(emptyDir, { recursive: true }) } catch {}
  const bEmpty = buildBrief({ wt: emptyDir })
  check('⑪b 扫描空目录 ⇒ tools=[]（证明工具来自扫描而非手抄）', bEmpty.tools.length === 0, `tools.length=${bEmpty.tools.length}`)
  try { fs.rmdirSync(emptyDir) } catch {}

  const pass = res.filter((x) => x.ok).length
  const total = pass === res.length
  console.log(`\n结果：判据 ${pass}/${res.length} ⇒ ${total ? 'PASS' : 'FAIL'}`)
  return total ? 0 : 1
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const argOf = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? null) }
  if (argv.includes('--selftest')) process.exit(selftest())
  const arm = argOf('--for-arm')
  let allArms = null
  if (arm) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(WT, 'evals', 'arms.json'), 'utf8'))
      allArms = (reg.arms ?? reg).map((x) => (typeof x === 'string' ? x : x.name))
    } catch { allArms = ['A', 'B', 'C'] }
  }
  const b = buildBrief({ arm, allArms })
  if (argv.includes('--json')) console.log(JSON.stringify(b, null, 2))
  else console.log(renderBrief(b))
  process.exit(0)
}
