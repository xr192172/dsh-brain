#!/usr/bin/env node
/**
 * check-all.mjs —— 全部门禁的统一入口（2026-09-15）
 *
 * ## 为什么需要它
 *
 * 到 2026-09-15 已有 12 道门散在 `scripts/` 与 package.json 里，**却没有统一入口**。
 * 那本身就是"开发起来会混乱"的新来源 —— 而混乱正是我们刚花一天在收的东西。
 *
 * ## 口径（沿用 `gate-authoring` 的纪律）
 *
 * - **逐项报告 + 末尾汇总**：每道门单独一行（✓/✗ + 耗时），失败时把它的尾部输出贴出来。
 * - **任一失败 ⇒ 非 0 退出**。
 * - **有副作用的门要如实标注** —— 例如 `capability-gate run --all` 会**写回执**。
 *   把"检查"和"会改东西的检查"混为一谈，是让人不敢跑总检查的常见原因。
 * - `--only <substr>` 跑子集（调试用）；`--list` 只列不跑。
 *
 * 用法：
 *   node scripts/check-all.mjs
 *   node scripts/check-all.mjs --only capability
 *   node scripts/check-all.mjs --list
 *   node scripts/check-all.mjs --repo <工作树>      # ★ 把各道门指向指定的工作树跑
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
/**
 * ★★ 2026-09-22（O69 / R1「判据必须在 Agent 够不到的地方」）——
 * 判据脚本必须能被**指向你指定的工作树**，否则隔离在原理上不可能生效。
 *
 * 优先级：`--repo <path>` ＞ 环境变量 `DSH_EVAL_REPO` ＞ **原来的硬编码值**（fallback）。
 * ★ **不许弱化判据**：两个都没给时 `REPO` **就是改动前那个字符串** ⇒ 行为逐字不变
 *   （门列表、`--only` / `--list`、判据口径、退出码全部照旧）。
 *
 * ## ★★ 2026-09-22（O73）：子门必须从**判据根**起跑，`--repo` 只当"被测树"传下去
 *
 * **事故**：`DSH_EVAL_REPO=<隔离树>` 时，本脚本原先拿它当**子进程的 cwd** 用
 * ⇒ 而隔离树按 R1 **排除了 `scripts/`** ⇒ 每道门都是
 * `node scripts/xxx.mjs` + cwd=隔离树 ⇒ `MODULE_NOT_FOUND` ⇒ **regression 假红**
 * （实测：`node scripts/check-all.mjs --repo <wt>` 15 道门全崩）。
 *
 * **正确设计**（`scripts/eval-validate.mjs` 头部逐字写明的同一条）：
 *   **判据脚本住在【判据根】（主仓），它【检查】的是被测树。**
 *   ⇒ 子进程 `cwd = JUDGE_ROOT`（本脚本自己所在的仓库），
 *     被测树通过环境变量 `DSH_EVAL_REPO`（= `--repo` 的值）**传给那些读它的门**。
 *
 * ⚠️ **诚实交代**：本仓目前只有 `test-injected-message-shape.mjs` 与
 *   `test-handover-drain.mjs` 两道门读 `DSH_EVAL_REPO`（下面标了 `repoAware: true`）
 *   ⇒ 传了 `--repo` 时**只有它们真的在查那棵树**，其余门在判据根上跑。
 *   这一点会**打印出来**（不打印就等于让人以为"全都在查被测树" = 假绿）。
 */
const JUDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoArg = (() => {
  const i = argv.indexOf('--repo')
  return i < 0 ? null : (argv[i + 1] ?? null)
})()
const REPO_GIVEN = repoArg ?? process.env.DSH_EVAL_REPO ?? null
const REPO = REPO_GIVEN ? path.resolve(REPO_GIVEN) : 'D:/project_develop/dsh-brain'
/** 子进程的 cwd：给了 `--repo`/`DSH_EVAL_REPO` ⇒ **判据根**；没给 ⇒ 与改动前逐字相同。 */
const CWD = REPO_GIVEN ? JUDGE_ROOT : REPO
const only = (() => {
  const i = argv.indexOf('--only')
  return i < 0 ? null : argv[i + 1]
})()
const listOnly = argv.includes('--list')

/** 门列表。`side` 非空表示**会改动磁盘**，必须如实标注。 */
const GATES = [
  {
    id: 'bom',
    what: '无 UTF-8 BOM（数据文件）+ .ps1 必须带 BOM',
    cmd: ['node', 'scripts/check-bom.mjs'],
  },
  {
    id: 'cmd-lineendings',
    // ★ 2026-09-26 新增（真事故）。两条判据：
    //   A 纯 LF 行 = 0 —— LF-only 会让 cmd.exe **吃掉 `rem` 前缀**、把注释里的英文单词
    //     当命令执行（实测出现 `'-click'` / `'icon'` / `'equired'` / 甚至 `TIME` 提示）。
    //   B 非 ASCII 字节 = 0 —— cmd.exe 按**当前 OEM 码页**流式读取，而 `chcp` 生效更晚
    //     ⇒ 非 ASCII 会让它偶发切错行（实测 ~4% 概率，**窗口一闪而过时根本发现不了**）。
    //   消融自证：改回 LF ⇒ A 必红；塞一个 `★` ⇒ B 必红（见脚本头注释）。
    what: '.cmd/.bat 必须【全 CRLF】且【纯 ASCII】（否则 cmd.exe 吃 rem 前缀 / 切错行）',
    cmd: ['node', 'scripts/check-cmd-lineendings.mjs', '.'],
  },
  {
    id: 'desktop-launcher',
    // ★★ 2026-09-26 新增（**本次事故的正主**）。
    //   形状最坏的一种：**被检查的都干净，用户双击的那个没人管**。
    //   `dsh-up.cmd` 修好了，但桌面那份 `DSH 启动 (双击).cmd` 从没重新生成
    //   （实测 243 非 ASCII + 66 纯 LF，与源 0/0 脱节）⇒ 用户双击就是满屏报错。
    //   本门用**指纹重算 + 逐字节比较**（不看名字/不看是否存在），三态 PASS/FAIL/SKIP。
    what: '桌面那份启动器必须与仓库源文件【逐字一致】（派生物不许陈旧）',
    cmd: ['node', 'scripts/check-desktop-launcher.mjs'],
  },
  {
    id: 'plugin-hygiene',
    what: '插件卫生：包完整性 / 残留 / deps 与 bundles / lock 一致 / 遗留物',
    cmd: ['node', 'scripts/check-plugin-hygiene.mjs'],
  },
  {
    id: 'profile',
    // ★ 2026-09-20 基线 582 → 575：582 是**含 `@dsh-brain/conveyor-context` 时**的行数，
    //   而该包由用户**有意删除**（自研的上下文层被放弃，改用回**上游自带的**上下文管理）
    //   ⇒ 582 不可达 ⇒ **是判据过时，不是配置错**。
    //   575 的正当性由实质判据佐证：exit 0 / stderr 空 / pet 0 / dup 0 /
    //   conveyor 引用 0 处 / **compaction 在链上**（上游上下文管理仍在）。
    //   ⚠️ **口径**：本门的行数 = `stdout.split('\n').length - 1`（见下方核对代码），
    //   **不是"非空行"**（那个数是 565）。改这个数字必须用**门自己的口径** —— 我先前按
    //   非空行写成 565，门随即报 `行数 575 ≠ 期望 565`；靶场会话的 `exp-base` 变体实测 575，
    //   也正是同一口径。**别拿自己另数的一遍当基线。**
    what: 'profile 装配（--dump-config）：exit 0 / stderr 空 / 575 行 / pet 0 / dup 0',
    // ★ 2026-09-20 修语法：原来写 `['…bin.js', 'web', '--dump-config']` ——
    //   **那不是有效语法**（`dsh` 要的是 `--profile <name>`）。它对 `web` 之所以"能过"，
    //   是因为 **`web` 正好是默认 profile** ⇒ **门一直在测"默认 profile"，而不是显式测 web**。
    //   证据：`bin.js candidate --dump-config` → `error: --profile <name> is required`。
    //   ⇒ 若哪天默认 profile 变了，这道门会**静默测错对象**（假绿）。
    cmd: ['node', 'node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'web', '--dump-config'],
    expect: { lines: 575, forbid: ['duplicate loader entry id'], forbidCount: { pet: 0 } },
  },
  {
    id: 'registry',
    what: '能力库数据层校验（capability-registry check）',
    cmd: ['node', 'scripts/capability-registry.mjs', 'check'],
  },
  {
    id: 'capability-gate',
    what: '注册门：判据阶梯 L0/L1（**会写回执到 registry.json**）',
    cmd: ['node', 'scripts/capability-gate.mjs', 'run', '--all'],
    side: '写 registry.json 的 acceptance 回执',
  },
  {
    id: 'session-integrity',
    what: '会话日志体健（帧契约 + seq 连续）—— 坏日志会让整代起不来',
    // ★ 只查最近 12 个：全量扫要 25s（耗时全在几个几万行的历史大会话上），
    //   而**新损坏只可能出现在近期会话**。换代前要彻底，单独跑
    //   `node scripts/check-session-integrity.mjs --all`。
    cmd: ['node', 'scripts/check-session-integrity.mjs', '--limit', '12'],
  },
  {
    id: 'test:patch-anchors',
    what: '上游补丁锚点严格化（两方向）',
    cmd: ['node', 'scripts/test-patch-anchors.mjs'],
  },
  {
    id: 'test:boot-health',
    what: '启动健康检查三态（含真实 gen-3083 文本）',
    cmd: ['node', 'scripts/test-boot-health.mjs'],
  },
  {
    id: 'test:config-tolerance',
    what: '插件 Config 容忍缺 config（经 cordis 真实 resolveConfig）',
    cmd: ['node', 'scripts/check-config-tolerance.mjs'],
  },
  {
    id: 'test:capability-gate',
    what: '注册门自证（两方向）',
    cmd: ['node', 'scripts/test-capability-gate.mjs'],
  },
  {
    id: 'test:notice-core',
    what: '能力通知折叠内核（幂等 / 快照非增量 / 顺序无关）',
    cmd: ['node', 'scripts/test-capability-notice.mjs'],
  },
  {
    id: 'test:notice-wiring',
    what: '能力通知接线（mock ctx 真调 apply）',
    cmd: ['node', 'scripts/test-capability-notice-wiring.mjs'],
  },
  {
    id: 'test:plugin-hygiene',
    what: '插件卫生门自证（两方向）',
    cmd: ['node', 'scripts/test-plugin-hygiene.mjs'],
  },
  {
    id: 'test:message-shape',
    what: '注入会话的消息必须带身份（id/source）+ 反模式扫描',
    cmd: ['node', 'scripts/test-injected-message-shape.mjs'],
    repoAware: true,
  },
  {
    id: 'test:handover-drain',
    what: '换代前必须真的停写（drain 三方向 + 封口顺序两方向自证）',
    cmd: ['node', 'scripts/test-handover-drain.mjs'],
    repoAware: true,
  },
]

// ⚠️ 刻意**不**收录 `scripts/verify-p4-after-swap.mjs`：
//   它在换代之前**本来就该是红的**（判据是"新代码有没有上"），
//   收进来会让 `check:all` 在换代前恒红 ⇒ 门被当成噪音 ⇒ 门被绕过。
//   它由 `npm run verify:p4` 单独跑（换代后跑）。
//
// ⚠️ 同理**不**收录 `scripts/verify-drain-after-swap.mjs`（`npm run verify:drain`）：
//   它验的是"**真机上**这次换代是不是由新版跑、旧代有没有确认停写" ——
//   换代前必然红（而且它带 seq-gap 基线状态），塞进 check:all 同样会被绕过。
//   离线那半边（drain 三方向 + 封口顺序）已由下面的 test:handover-drain 守住。
//
// ⚠️ `scripts/check-upstream-drift.mjs`（`npm run check:upstream`）也**不**收录：
//   它要**联网**拉 registry 上的新版本 tarball，且结论依赖"当前 registry 上有什么"——
//   放进每次的本地门里会让门变慢、变飘。它是"要不要升上游"这一决策的手动前置检查。
//
// ⚠️ `scripts/eval-validate.mjs`（`npm run eval:validate`）同样**不**收录，理由不同：
//   它要给每题**打上 seed（临时改工作区文件）再还原** —— 虽然做了字节级备份 + sha256 校验，
//   但"会临时改动被检文件的检查"不能混进总门，否则没人敢在改动中途跑 check:all。
//   它由 `npm run eval:validate` 单独跑（收题、改 seed、换代前跑）。

const selected = only ? GATES.filter((g) => g.id.includes(only)) : GATES
if (!selected.length) {
  console.error(`--only ${only} 没匹配到任何门。可用：${GATES.map((g) => g.id).join(', ')}`)
  process.exit(1)
}

if (listOnly) {
  console.log(`共 ${GATES.length} 道门${only ? `（匹配 ${only}：${selected.length}）` : ''}：`)
  for (const g of selected) {
    console.log(`  ${g.side ? '⚙ ' : '  '}${g.id.padEnd(24)} ${g.what}`)
    if (g.side) console.log(`  ${' '.repeat(24)} └ ⚙ 有副作用：${g.side}`)
  }
  console.log('\n  ⚙ = 会改动磁盘；其余为纯检查。')
  process.exit(0)
}

const t0 = Date.now()
const rows = []
// ★★ 2026-09-22（O73）：给了 `--repo` / `DSH_EVAL_REPO` 时，如实交代"谁真的在查被测树"。
if (REPO_GIVEN) {
  const aware = selected.filter((g) => g.repoAware).map((g) => g.id)
  console.log(`被测树（--repo / DSH_EVAL_REPO）：${REPO}`)
  console.log(`判据根（各道门的 cwd，判据脚本住这儿）：${CWD}`)
  console.log(`★ 读 DSH_EVAL_REPO、**真的在查被测树**的门：${aware.join(', ') || '（无）'}`)
  console.log(`  其余门不读该变量 ⇒ 它们查的是**判据根**（不查被测树）—— 别把它们的绿当成被测树的绿。`)
  console.log('')
}
for (const g of selected) {
  const start = Date.now()
  const r = spawnSync(g.cmd[0], g.cmd.slice(1), {
    // ★ O73：**判据根**，不是被测树（被测树按 R1 没有 scripts/ ⇒ 用它当 cwd 会 MODULE_NOT_FOUND）
    cwd: CWD,
    // ★ O73：把被测树**传给**门（不给 `--repo` 时不加环境变量 ⇒ 与改动前逐字相同）
    ...(REPO_GIVEN ? { env: { ...process.env, DSH_EVAL_REPO: REPO } } : {}),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  let ok = (r.status ?? 1) === 0
  const notes = []

  // profile 门额外核几个硬指标（只看 exit code 会漏掉"装上了但内容不对"）
  if (ok && g.expect) {
    if (g.expect.lines !== undefined) {
      const n = (r.stdout ?? '').split('\n').length - 1
      if (n !== g.expect.lines) { ok = false; notes.push(`行数 ${n} ≠ 期望 ${g.expect.lines}`) }
    }
    for (const bad of g.expect.forbid ?? []) {
      if (out.includes(bad)) { ok = false; notes.push(`出现了不该有的：${bad}`) }
    }
    for (const [k, want] of Object.entries(g.expect.forbidCount ?? {})) {
      const n = out.split('\n').filter((l) => l.includes(k)).length
      if (n !== want) { ok = false; notes.push(`${k} 出现 ${n} 次 ≠ ${want}`) }
    }
  }

  // 提取"结果：N passed, M failed"之类的关键行当摘要
  const summary =
    out.split('\n').reverse().find((l) => /结果：|✅|Done|全部锚点就位|无问题/.test(l)) ?? ''
  rows.push({ g, ok, ms: Date.now() - start, out, notes, summary: summary.trim() })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${g.id.padEnd(24)} ${String(Date.now() - start).padStart(5)}ms  ${summary.slice(0, 52)}\n`)
}

const bad = rows.filter((r) => !r.ok)
console.log('')
console.log('─'.repeat(78))
console.log(`  ${rows.length - bad.length} 通过 / ${bad.length} 失败   总耗时 ${Date.now() - t0}ms`)
if (bad.length) {
  console.log('')
  for (const r of bad) {
    console.log(`  ✗ ${r.g.id} —— ${r.g.what}`)
    if (r.notes.length) for (const n of r.notes) console.log(`      · ${n}`)
    const tail = r.out.trim().split('\n').slice(-6)
    for (const l of tail) console.log(`      | ${l}`)
    console.log('')
  }
} else {
  console.log('  全部通过。')
}
console.log(`  （⚙ 有副作用的门：${selected.filter((g) => g.side).map((g) => g.id).join(', ') || '无'}）`)
process.exit(bad.length ? 1 : 0)
