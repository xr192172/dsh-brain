#!/usr/bin/env node
/**
 * make-g0-preset.mjs —— 装配/校验 **G0 干净工具面下界 preset**（对照实验专用）。
 *
 * ## 为什么 id 叫 `g0` 而**不是** `minimal`
 *
 * 随附（`trust=system`、只读）preset 里**已经有一个 id 就叫 `minimal`**
 * （`<dsh>/node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/`）。
 * preset 发现顺序是「配置根在前、用户根 `<dshHome>/.agent-presets` 在后，同 id 先到先得」
 * ⇒ 用户在 `~/.dsh/.agent-presets/minimal/` 建的同名目录会被**静默遮蔽**：
 *   · 目录还在；
 *   · `agentPreset.select {agentPreset:'minimal'}` 返回 **HTTP 200**；
 *   · `session.list` 回读 `agentPreset` 也显示 `minimal`；
 *   · **但装的是随附那一份**（含 `str_replace_editor`、工具面 78 个，不是我们写的这份）。
 * ⇒ 换一个不撞车的 id（`g0`），并且**校验判据要比"名字"更强**（见 `--check`）。
 *
 * ## 为什么 shell 组**必须带平台 gate**
 *
 * 早期版本只留一行 `tool-bash` 并删掉了 `council` 那行的 win32 gate ⇒ 本机（win32）
 * 工具面里是 `bash` **却没有 `pwsh`**：名单里像有壳子，实际**跑不动**。
 * 正确写法照随附 `minimal`：同一份行集合**按平台 gate 二选一**
 * （`=== 'win32'` 的行在 POSIX 上关掉，`!== 'win32'` 的行在 win32 上关掉）
 * ⇒ **两个平台各自恰好得到 1 个可用 shell**，既保住"只留一个 shell"的设计，
 *   又不会出现"平台判断错了 ⇒ 零 shell"。
 *
 * ## 用法
 *
 *   node scripts/make-g0-preset.mjs                    # 幂等装配（已存在则跳过）
 *   node scripts/make-g0-preset.mjs --force            # 覆盖重写
 *   node scripts/make-g0-preset.mjs --check --traj <sid>   # ★ 只读校验"装上的确实是这份"
 *
 * `--check` **不动栈、不建会话、不改文件**；它要一个**已经跑过 g0 的会话 id**
 * （用 `node scripts/measure-arm-face.mjs --preset g0` 产出，或任一手工会话）。
 * 判据（比"名字"强 —— 全部来自"回读会骗人"的实测）：
 *   ① **本地文件**：按**解析后的 YAML** 判（不看原始文本 —— 头注释里就写着
 *      `str-replace-editor` 那几个字，拿文本正则判会自己把自己判红）；
 *      必须同时具备 `persistent-bash: disabled === "process.platform === 'win32'"` 与
 *      `persistent-pwsh: disabled === "process.platform !== 'win32'"`（双 platform gate）。
 *   ② **会话里持久的** `agent-preset/selected` 事件 === `g0`。
 *      ⚠ 不能拿 `session.list` 的 `agentPreset` 当判据：实测那个字段是**当代投影**，
 *      换代后会**漂回默认 preset**（同一会话当代读 `g0`、切回 `web` 代后读 `council`，
 *      而事件与工具面都没变）⇒ 跨代不可信，本脚本只把它打印出来作**参考**。
 *   ③ **工具面指纹**：`toolSetSize !== 78`（78 = 随附 `minimal` 的指纹；G0 应为 77）
 *      且工具面里**没有** `str_replace_editor`（那是随附 minimal 的第二件工具）。
 *   任一条不符 ⇒ 退出码非 0。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { decompress as decompressZstd } from 'fzstd'
import { SESSION_ROOT } from './lib-tool-failure.mjs'

const REPO = 'D:/project_develop/dsh-brain'
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const ID = 'g0'
const DIR = path.join(HOME, '.agent-presets', ID)
const YML = path.join(DIR, 'agent.cordis.yml')
const META = path.join(DIR, 'preset.yml')
/** 随附（只读）preset 的指纹：工具面 78 个 + 含 str_replace_editor。 */
const SYSTEM_MINIMAL_IDS = ['standard', 'code', 'cordis', 'minimal']
const SYSTEM_MINIMAL_TOOLSET = 78
const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : argv[i + 1]
}

// ── 要写入的装配文件（照随附 minimal 的 shell 组；persona 行原样）──────────────
const YAML = `# G0 —— 干净「工具面下界」agent preset（对照实验专用）。
#
# ⚠️ 为什么这个文件叫 \`g0\` 而不是 \`minimal\`（实测发现，别改回去）：
#   **随附（只读）preset 里已经有一个 id 就叫 \`minimal\`**
#   （\`…/node_modules/@deepseek-ai/dsh/config/agent-presets/minimal/\`，
#     \`agentPreset.list\` 报 \`minimal trust=system\`）。
#   preset 发现是「配置根在前、用户根 \`.agent-presets\` 在后，同 id 先到先得」
#   ⇒ 用户在 \`~/.dsh/.agent-presets/minimal/\` 建的同名 preset 会被**静默遮蔽**：
#     目录还在、\`agentPreset.select {agentPreset:'minimal'}\` 也回读成功（HTTP 200，
#     回读也显示 \`minimal\`），但装的是随附那一份（实测读数 46 字 / 78 工具 /
#     有 str_replace_editor、无我们想要的那份行集合）。
#   ⇒ **回读成功 ≠ 生效的是你以为的那份** ⇒ 本 preset 必须换一个不撞车的 id，
#     并且校验判据要比名字更强（看 \`toolSetSize\` / 工具名，而不是只看 id 字符串）。
#
# 目的：把 agent 的**工具面 + 系统提示面**同时压到最小可装配状态，作为
# 「把 agent 的工具面当自变量」实验的**下界臂**。它复刻的是上游 DSH 自己的
# minimal 组合（persona 一句话、只留 shell、不挂 compaction），但**照我们这版
# preset schema 重写**（上游 agent-spine-demo 用的是完全不同的行集合，不能直接抄）。
#
# 与两个现役臂的区别：
#   · \`council\`（263 行）：persona + 全量工具行 + compaction + 委派 + 计划模式 …
#   · \`exp-base-nodc\`：profile 层少装了一个包，但 preset 层仍带着 compaction +
#     一堆工具行 + harness identity + web orientation ⇒ **不是干净的工具面下界**。
#   · 本 preset（G0）：只有 persona 行 + 一个 shell 组。
#
# 三条设计要点：
#   ① persona 行 \`complete: true\` ⇒ 装配后**系统提示里只剩这一段**，harness identity /
#      工具指引 / 任何 listener 都追加不进文本；
#      \`includeRuntimeContext: false\` ⇒ 连 sandbox / approval / 委派的 runtime-context
#      快照也不进来（这两项见 @deepseek-ai/dsh-persona README 的 Config 表）。
#   ② **只有一个工具**。skills / jobs / goal / fs / fs-search / plan-mode /
#      compaction / 委派 / workflow / web 一律不挂 ⇒ 本文件**没有** \`filesystem\` 组
#      （随附 minimal 有 \`fs-local\` + \`str-replace-editor\`，这是 G0 有意不要的第二件工具）。
#   ③ **不挂 compaction**（council 的 \`- id: compaction\` 整组不在这里）。
#
# ⚠️ 为什么 shell 组**必须带平台 gate**（2026-09-21 修，血的教训）：
#   本 preset 早期版本只有一行 \`tool-bash\`（抄自 council），且**删掉了** council 那一行的
#   \`disabled: !!js process.platform === 'win32'\`（当时的理由是"只准一行工具，照抄会让本机零 shell"）。
#   后果：本机（win32）工具面里是 \`bash\`、**没有 \`pwsh\`** —— 壳子名字对了、但**跑不动**。
#   正确做法是照**随附 \`minimal\`** 的 shell 组：**同一份行集合按平台 gate 二选一**
#   （\`!== 'win32'\` 的行在 Windows 上关掉，\`=== 'win32'\` 的行在 POSIX 上关掉）
#   ⇒ **两个平台各自恰好得到 1 个可用 shell**，既满足"只留一个 shell"的设计，
#     又不会出现"平台不对 ⇒ 零 shell"。
#   旁证：\`council\` 也是给 \`tool-bash\` 加 win32 gate 并**另配一行 tool-pwsh** 兜底 —— 同一逻辑。
#   \`terminal-*\` 行是**终端实现/后端**（服务），不注册工具；真正注册工具的是
#   \`persistent-bash\` / \`persistent-pwsh\`（本机 win32 ⇒ 工具名 \`pwsh\`）。
#
# 行写法照抄随附 minimal 的 shell 组（同样的 \`id:\` + \`name:\` 映射、同样的
# \`@deepseek-ai/dsh-*\` 包名、同样的 \`config:\` / \`disabled:\` 写法），没有自造字段。

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false

# The PTY registry is an agent-owned service, so it lives in an entry-local
# realm. The backend still consumes the host sandbox policy and subprocess
# implementation, while the tool registers into this agent's scoped catalog.
# Exactly one shell stack mounts per host: the bash stack gates off win32 and
# its pwsh twin gates off POSIX, mirroring the one-shot shell rows.
- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'

    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a bash shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * You don't have access to the internet via this tool.
          * You do have access to a mirror of common linux and python packages via apt and pip.
          * State is persistent across command calls and discussions with the user.
          * To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
          * Please avoid commands that may produce a very large amount of output.
          * Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.

    - id: terminal-pwsh
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform !== 'win32'
      config:
        shellDialect: pwsh
        timeoutMs: 300000

    - id: persistent-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh-persistent'
      disabled: !!js process.platform !== 'win32'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a PowerShell shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * You don't have access to the internet via this tool.
          * State is persistent across command calls and discussions with the user.
          * Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.
          * Please avoid commands that may produce a very large amount of output.
          * Please run long lived commands in the background, e.g. 'Start-Job' or start a process with Start-Process.
`

const META_YML = `name: G0 · 干净下界（一句话 persona + 单 shell 工具 + 无 compaction）
description: >-
  对照实验专用的干净「工具面下界」。只有两段：一句话 persona
  （'You are a helpful software engineer assistant.'，带 complete: true 与
  includeRuntimeContext: false ⇒ 装配后系统提示里只剩这一段）与一个 shell 组
  （pty + 按平台 gate 二选一的 terminal/persistent shell ⇒ 每个平台恰好 1 个 shell 工具，
  win32 上是 pwsh）；不挂 filesystem，也不挂 compaction / skills / jobs / goal /
  fs-search / plan-mode / 委派 / web。
  用途：作为「把 agent 的工具面当自变量」实验的下界臂，与 council、exp-base(-nodc) 对照。
  注：本 preset 不能叫 \`minimal\` —— 随附只读 preset 已占用该 id，同名会被静默遮蔽
  （select 返回 200、回读也显示 minimal，但装的是随附那份）。
`

const say = (s) => console.log(s)
const problems = []
const die = (s) => {
  console.error(`✗ ${s}`)
  process.exit(1)
}

/** 无 BOM 写入（★ 本项目踩过：带 BOM 会让 boot 期 JSON.parse 崩）。 */
function writeNoBom(p, s) {
  fs.writeFileSync(p, s, 'utf8')
  const head = fs.readFileSync(p).subarray(0, 3)
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) die(`写入后仍是 BOM：${p}`)
}

/** 经前门 RPC 回读会话的 `agentPreset`（与 eval-run.mjs:71-89 同一口径）。 */
async function readbackPreset(sid) {
  const res = await fetch(`${FRONT}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.list', payload: {} }),
  })
  const j = await res.json().catch(() => null)
  const items = j?.result?.value?.items ?? []
  const s = items.find((x) => x.sessionId === sid)
  return { status: res.status, agentPreset: s?.agentPreset ?? null, found: !!s }
}

/** 只读取轨迹面读数（`eval-run.mjs --traj <sid>` 的 metrics）。 */
function readTraj(sid) {
  const r = spawnSync('node', ['scripts/eval-run.mjs', '--traj', sid], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  try {
    return JSON.parse(r.stdout)
  } catch {
    return { parseError: true, stderr: String(r.stderr ?? '').slice(0, 400) }
  }
}

/** 直接解会话文件（与 `eval-run.mjs:404-425` 同一找法/同一解压）。 */
function sessionFile(sid) {
  try {
    for (const d of fs.readdirSync(SESSION_ROOT)) {
      const p = path.join(SESSION_ROOT, d, sid, 'session.jsonl.zstd')
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* 目录不存在 */
  }
  return null
}

/**
 * 取会话里**持久的** preset 选择事件（`agent-preset/selected`）。
 *
 * ⚠ 为什么必须读事件、不能只信 `session.list` 的 `agentPreset`（2026-09-21 实测）：
 *   换代（handover）之后，`session.list` 的 `agentPreset` 字段会**漂回默认 preset**
 *   —— 实测：同一会话在 select 当代回读 `g0`，切回 `web` 代后再回读变成 `council`，
 *   而会话事件里 `agent-preset/selected {agentPreset:"g0"}` 与当次 `request/header`
 *   的 77 件工具面都**没变**。⇒ 那个字段是**当代投影**，跨代不可信；
 *   会话事件 + 面指纹才是**耐久**判据。
 */
function durableSelectedPreset(sid) {
  const f = sessionFile(sid)
  if (!f) return { found: false }
  let text
  try {
    text = Buffer.from(decompressZstd(fs.readFileSync(f))).toString('utf8')
  } catch (e) {
    return { found: true, error: String(e?.message ?? e) }
  }
  let last = null
  let n = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'agent-preset/selected') {
      n++
      last = ev?.data?.agentPreset ?? null
    }
  }
  return { found: true, agentPreset: last, count: n }
}

/** 解析本地这份 YAML（`!!js` tag 解析后是**字符串**，正好可断言 gate 写法）。 */
async function parseLocalYaml() {
  try {
    const yaml = (await import('yaml')).default ?? (await import('yaml'))
    return { parsed: yaml.parse(fs.readFileSync(YML, 'utf8')) }
  } catch (e) {
    return { error: String(e?.message ?? e) }
  }
}

// ── `--check`：**只读**校验"装上的那份是用户级这份"（判据比名字强）──────────────
if (has('--check')) {
  const sid = argOf('--traj') ?? process.env.DSH_G0_SID ?? null
  say(`G0 只读校验（人读；不改文件、不建会话）  dir=${DIR.replace(/\\/g, '/')}`)

  // ① 本地这份：看**解析后的 YAML**（❌ 不能拿原始文本正则 —— 头注释里就写着
  //    `str-replace-editor` 这几个字，拿文本判会自己把自己判红：实测踩到）
  const { parsed, error } = await parseLocalYaml()
  if (error) die(`本地这份 YAML 解析失败：${error}`)
  const flat = JSON.stringify(parsed)
  const rowOf = (id) => (Array.isArray(parsed) ? parsed : []).flatMap((r) => (r?.group && Array.isArray(r.config) ? r.config : [r])).find((x) => x?.id === id)
  const bashRow = rowOf('persistent-bash')
  const pwshRow = rowOf('persistent-pwsh')
  const localChecks = [
    ['顶层是数组（插件行列表）', Array.isArray(parsed)],
    ['persona 行 complete:true', rowOf('persona')?.config?.complete === true],
    ['persona 行 includeRuntimeContext:false', rowOf('persona')?.config?.includeRuntimeContext === false],
    ["persistent-bash 带 win32 gate（本机为假 ⇒ 不装 bash）", bashRow?.disabled === "process.platform === 'win32'"],
    ["persistent-pwsh 带非 win32 gate（本机为真 ⇒ 装 pwsh）", pwshRow?.disabled === "process.platform !== 'win32'"],
    ['含 persistent-pwsh 行（@deepseek-ai/dsh-tool-pwsh-persistent）', /tool-pwsh-persistent/.test(flat)],
    ['无 filesystem 组（G0 只要 1 件工具，不要 str_replace_editor/fs-local）', !/str-replace-editor|fs-local/.test(flat)],
  ]
  for (const [k, ok] of localChecks) {
    say(`  ${ok ? '✓' : '✗'} 本地文件（解析后）：${k}`)
    if (!ok) problems.push(`本地文件判据不通过：${k}`)
  }

  if (!sid) {
    say('  ⚠ 未给 `--traj <sid>`（也没有 DSH_G0_SID）⇒ **无法**做"装上的那份"的指纹断言。')
    say('    先用 `node scripts/measure-arm-face.mjs --profile exp-base-nodc --preset g0` 产出一个会话，')
    say('    再 `node scripts/make-g0-preset.mjs --check --traj <sid>`。')
    process.exit(problems.length ? 1 : 2)
  }

  // ② 会话里**持久**的 preset 选择事件（跨代不变 ⇒ 比 `session.list` 强）
  const dur = durableSelectedPreset(sid)
  say(`  会话 ${sid}`)
  if (!dur.found) {
    say('  ✗ 找不到会话文件')
    problems.push('找不到会话文件')
  } else {
    say(`  持久事件 agent-preset/selected = ${dur.agentPreset ?? '(无)'}（共 ${dur.count ?? 0} 条）`)
    if (dur.agentPreset !== ID) problems.push(`持久事件里的 preset = ${dur.agentPreset}，不是 ${ID}`)
  }

  // ③ live 回读（**只作参考，不作判据** —— 换代后会漂回默认）
  const rb = await readbackPreset(sid)
  say(`  ⚠ 参考（**不用于判定**）：session.list 的 agentPreset = ${rb.agentPreset ?? '(未找到)'}`)
  say('     实测该字段跨代会漂回默认（本会话当代读 g0、切回 web 代后读 council）⇒ 不做判据。')

  // ④ 轨迹面指纹（判据）
  const traj = readTraj(sid)
  const m = traj?.metrics ?? null
  if (!m) {
    say('  ✗ 读不到轨迹 metrics：')
    say('    ' + JSON.stringify(traj).slice(0, 600))
    problems.push('轨迹不可读')
  } else {
    const tools = m.toolSet ?? []
    say(`  工具面 toolSetSize = ${m.toolSetSize}   systemChars = ${m.systemChars}`)
    say(`  工具名 = ${JSON.stringify(tools)}`)
    // ★ 判据比名字强：随附 minimal = 78 件且含 str_replace_editor；G0 = 77 件且没有
    const isSysMinimal = m.toolSetSize === SYSTEM_MINIMAL_TOOLSET
    const hasEditor = tools.includes('str_replace_editor')
    say(`  ${isSysMinimal ? '✗' : '✓'} 断言 toolSetSize !== ${SYSTEM_MINIMAL_TOOLSET}（实得 ${m.toolSetSize}）`)
    say(`  ${hasEditor ? '✗' : '✓'} 断言不含 str_replace_editor（随附 minimal 的第二件工具）`)
    if (isSysMinimal) problems.push(`toolSetSize = ${SYSTEM_MINIMAL_TOOLSET} ⇒ 装的像是**随附 minimal**，不是用户级 g0`)
    if (hasEditor) problems.push('工具面里有 str_replace_editor ⇒ 装的像是随附 minimal')
    if (m.toolSetSize !== 77) say(`  ⚠ 不是预期的 77（若 profile 变过底板，这个数会整体平移）`)
  }

  say('')
  if (problems.length) {
    console.error('✗ G0 校验不通过：')
    for (const p of problems) console.error('    · ' + p)
    process.exit(1)
  }
  say('✓ G0 校验通过：本地这份含双平台 gate，且装上的那份**不是**随附 minimal（指纹不同）。')
  process.exit(0)
}

// ── 装配（幂等：先判断目录是否存在）────────────────────────────────────────────
const FORCE = has('--force')
if (SYSTEM_MINIMAL_IDS.includes(ID)) die(`id 不能与随附 preset 同名（会被静默遮蔽）：${ID}`)

const dirExisted = fs.existsSync(DIR)
say(`G0 preset 装配：${DIR.replace(/\\/g, '/')}  (目录${dirExisted ? '已存在' : '不存在'}，${FORCE ? '--force 覆盖' : '幂等跳过'}）`)
fs.mkdirSync(DIR, { recursive: true })

let wrote = 0
for (const [p, content, label] of [
  [YML, YAML, 'agent.cordis.yml'],
  [META, META_YML, 'preset.yml'],
]) {
  if (fs.existsSync(p) && !FORCE) {
    say(`  · ${label}：已存在，跳过（要覆盖用 --force）`)
    continue
  }
  writeNoBom(p, content)
  wrote++
  say(`  · ${label}：已写（${Buffer.byteLength(content, 'utf8')} 字节，无 BOM）`)
}

// ── 自检：YAML 可解析、顶层是数组、含双平台 gate ──────────────────────────────
try {
  const yaml = (await import('yaml')).default ?? (await import('yaml'))
  const parsed = yaml.parse(fs.readFileSync(YML, 'utf8'))
  if (!Array.isArray(parsed)) problems.push('YAML 顶层不是数组（组装文件必须是插件行列表）')
  else say(`  自检：YAML OK（${parsed.length} 个顶层行）`)
  const s = JSON.stringify(parsed)
  if (!/tool-pwsh-persistent/.test(s)) problems.push('缺 persistent-pwsh 行')
  if (!/tool-bash-persistent/.test(s)) problems.push('缺 persistent-bash 行')
  if (/str-replace-editor/.test(s)) problems.push('不该有 str-replace-editor（那是随附 minimal 的）')
  // 平台 gate 必须在（否则本机 win32 没有可用 shell —— 那就是这次修的 bug）
  const flat = fs.readFileSync(YML, 'utf8')
  if (!/process\.platform === 'win32'/.test(flat) || !/process\.platform !== 'win32'/.test(flat))
    problems.push('平台 gate 缺失或不完整 ⇒ 本机可能出现"零可用 shell"')
  else say("  自检：双平台 gate 在位 ✓（win32 得 pwsh、POSIX 得 bash，各恰好 1 个）")
} catch (e) {
  say('  自检跳过（yaml 库不可用）：' + e.message)
}

say('')
if (problems.length) {
  console.error('✗ 有问题：')
  for (const p of problems) console.error('    · ' + p)
  process.exit(1)
}
say(`✓ 完成（本次写入 ${wrote} 个文件）。`)
say(`  下一步：node scripts/measure-arm-face.mjs --profile exp-base-nodc --preset g0`)
say(`  再校验：node scripts/make-g0-preset.mjs --check --traj <上一步的 sid>`)
