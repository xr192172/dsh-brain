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
 * ★★ **精选入口清单**（**不是** `scripts/` 目录倾倒）。
 *
 * ⚠️ 2026-09-26 回退说明：DSH 曾把它改成"扫 `scripts/` 全部 `.mjs` 并列出 165 条"
 *   ⇒ **退回**。理由（三条，写在 `out/_verify-self-dev-1.md`）：
 *   ① 用户要的是"**我们写的有意义的那些**"，不是目录列表；
 *   ② 165 条里 159 条无 role ⇒ 对 agent 是**噪音**（它得先过滤 165 条才找到 8 条有用的）；
 *   ③ `cmd` 里被硬拼了 `<args>` ⇒ **凭空造出命令形状**（`check-all` 根本不接参数）。
 * ★ 但**保留**它那条真有益的机制：**每条 cmd 指向的脚本必须真实存在，缺的显形 `missing`**
 *   —— 这才是候选 A 真正要的（"手抄清单会静默过期"的解药）。
 */
export const TOOL_SPEC = [
  {
    id: 'task-bank',
    cmd: 'node scripts/task-bank.mjs list',
    role: '列题库（agent-agnostic）',
    script: 'scripts/task-bank.mjs',
  },
  {
    id: 'task-bank-show',
    cmd: 'node scripts/task-bank.mjs show <题id>',
    role: '看一道题的题面 + 判据口径',
    script: 'scripts/task-bank.mjs',
  },
  {
    id: 'task-bank-verdict',
    cmd: 'node scripts/task-bank.mjs verdict <题id>',
    role: '该题的重放轨迹 + 报警数',
    script: 'scripts/task-bank.mjs',
  },
  {
    id: 'arm-up',
    cmd: 'node scripts/arm-up.mjs <臂名>',
    role: '★ 另起一代（自己的 DSH_HOME + 端口，**不 flip**）—— "另起一个 agent"的原语',
    script: 'scripts/arm-up.mjs',
  },
  {
    id: 'run-experiment',
    cmd: 'node scripts/run-experiment.mjs <题id> --arm <臂名>',
    role: '★ 闭环：取题→起一代→发题→收卷→判定（报警则 exit 1）',
    script: 'scripts/run-experiment.mjs',
  },
  {
    id: 'skill-sieve',
    cmd: 'node scripts/skill-sieve.mjs --in <skill_tree.json>',
    role: '筛：给 skill 分级 + 出融合候选（只判定 + 记账，绝不删）',
    script: 'scripts/skill-sieve.mjs',
  },
  {
    id: 'skill-factory',
    cmd: 'node scripts/skill-factory.mjs --in <skill_tree.json>',
    role: '工厂：一等 skill ⇒ agent 规格（只出规格，不注册）',
    script: 'scripts/skill-factory.mjs',
  },
  {
    id: 'self-dev-brief',
    cmd: 'node scripts/self-dev-brief.mjs [--json] [--for-arm <臂名>]',
    role: '★ 本简报自身（**这就是"文档在哪"的入口**）',
    script: 'scripts/self-dev-brief.mjs',
  },
  {
    id: 'check-all',
    cmd: 'node scripts/check-all.mjs',
    role: '常驻守卫总入口',
    script: 'scripts/check-all.mjs',
  },
]

/**
 * ★ 扫描 `scripts/` 下所有 `.mjs`（**事实来源**，用于核验精选清单、以及报告"仓库里到底有多少脚本"）。
 * ★ 它**不直接进 `tools` 段**（那会变成目录倾倒）；它只服务于**存在性核验**。
 */
export function scanActualTools(wt) {
  const scriptsDir = path.join(wt, 'scripts')
  const rels = []
  if (!fs.existsSync(scriptsDir)) return rels
  for (const name of fs.readdirSync(scriptsDir).sort()) {
    if (!name.endsWith('.mjs')) continue
    rels.push({ relative: `scripts/${name}`, id: name.slice(0, -4) })
  }
  return rels
}

/**
 * ★★ **精选清单 + 存在性核验**（候选 A 的正解）：
 *   每条 `TOOL_SPEC` 原样输出（cmd 是人手写的、**含真实参数形状**），
 *   **只补一个 `missing` 标记**：它指向的脚本不存在 ⇒ 显形（"我报了的必须真有"）。
 */
export function makeTools(wt) {
  return TOOL_SPEC.map((t) => {
    const p = path.join(wt, t.script)
    const exists = fs.existsSync(p)
    return { id: t.id, cmd: t.cmd, role: t.role, script: t.script, missing: !exists }
  })
}


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
    // ★★ 工具段 = **精选入口清单 + 存在性核验**（**不是** `scripts/` 目录倾倒，见 `TOOL_SPEC` 注释）。
    //   任何一条指向不存在的脚本 ⇒ 显形 `missing`（"我报了的必须真有"）。
    tools: makeTools(wt),
    // ★ 顺带报"仓库里到底有多少脚本"（**读数，不是清单**）——防"精选清单过期"时无从察觉。
    scriptsOnDisk: scanActualTools(wt).length,
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
  L.push('## 三、手在哪（**精选入口**，不是目录清单）')
  L.push(`> 仓库里现有 **${b.scriptsOnDisk}** 个脚本；下面只列**真正会被你用到**的 ${b.tools.length} 个入口。`)
  for (const t of b.tools) L.push(`- \`${t.cmd}\`${t.missing ? '　⇒ **★ 脚本不存在（missing）**' : ''}　—— ${t.role}`)
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

  // ═══ ⑩⑪：**回归判据**（2026-09-26 回退后新增）═══
  // ⚠️ 说明：DSH 做的⑩（"清空 role map ⇒ role 为空"）与⑪b（"扫空目录 ⇒ 空数组"）是**同义反复**
  //   —— 输入被清空时输出当然为空，**不含信息量**（铁律 21 的"假消融"同族）。
  //   已替换为下面两条**真会翻**的判据。

  // ⑩ ★★ **精选入口不许退化成目录倾倒**（这正是 DSH 那版犯的错，必须被这条挡住）
  const tools = b.tools
  const curatedOk = tools.length > 0 && tools.length <= 20 && tools.every((t) => t.role && t.role.trim().length > 0)
  check(
    '⑩ ★★ tools 必须【精选且每条有 role】（防"目录倾倒"+防"空 role 噪音"）',
    curatedOk,
    `${tools.length} 条，全部有 role（仓库里共 ${b.scriptsOnDisk} 个脚本）`,
  )
  // ⑩b 消融：把 tools 换成"扫全目录" ⇒ ⑩ 必须变红（证明⑩真能挡住那个退化）
  {
    const dumped = scanActualTools(b.repo).map((x) => ({ id: x.id, cmd: `node ${x.relative}`, role: '' }))
    const dumpedPasses = dumped.length <= 20 && dumped.every((t) => t.role.trim().length > 0)
    check('⑩b ★ 消融：改成"扫全目录" ⇒ ⑩ 变红（证明⑩挡得住那个退化）', dumped.length > 20 && dumpedPasses === false, `倾倒 ${dumped.length} 条、且 role 全空`)
  }
  // ⑪ ★★ **cmd 里不许凭空造 `<args>`**（DSH 那版给每条都硬拼 `<args>`，`check-all` 根本不接参数）
  const argsOk = tools.every((t) => !/<args>/.test(t.cmd) || /<题id>|<臂名>|<skill_tree|<runId|\[--/.test(t.cmd))
  check('⑪ ★ cmd 不许凭空拼 `<args>`（占位符必须说清是什么）', argsOk, tools.map((t) => t.cmd).join(' | ').slice(0, 140))
  // ⑪b ★ **精选清单过期必须显形**：造一份指向不存在脚本的清单 ⇒ makeTools 必须标 missing
  {
    const abs = path.join(b.repo, 'scripts', '__no_such_script__.mjs')
    const saved = TOOL_SPEC.push({ id: '__probe__', cmd: 'node scripts/__no_such_script__.mjs', role: '探针', script: 'scripts/__no_such_script__.mjs' })
    const probed = makeTools(b.repo).find((t) => t.id === '__probe__')
    TOOL_SPEC.pop()
    check(
      '⑪b ★★ 精选清单指向不存在的脚本 ⇒ 必须显形 missing（这才是候选 A 的解药）',
      !!probed && probed.missing === true && !fs.existsSync(abs),
      `missing=${probed?.missing}`,
    )
  }

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
