#!/usr/bin/env node
/**
 * make-council-preset.mjs —— 用**非 Code Mode** 的基础做一个带「议事厅 · 架构师」的 preset
 *
 * ## 为什么需要它（2026-09-15 的实际事故）
 *
 * `scripts/add-preset-council.mjs` 当初是拿**上游 `code` preset** 做基底的 ——
 * 而 `code` = `standard` + 一行 `tool-presentation`（`@deepseek-ai/dsh-agent-tool-presentation`），
 * **那一行就是 Code Mode**。它同时把 `settings.yaml` 的 `agent-presets.default` 指成了
 * `code-council` ⇒ **之后所有新窗口都是 Code Mode** ⇒ 而 `agnes-2.5-flash`
 * 遵守不了「只能调 run_code」，于是窗口里连环
 * `unknown tool … only run_code is callable directly` / `code run failed`。
 *
 * 用户要的其实是**议事厅**，不是 Code Mode —— 这两件事被绑在一起了。本脚本把它解开。
 *
 * ## 做什么
 *
 * 从上游 **`standard`**（标准模式，Native 工具）整目录复制出一个 user preset，
 * 挂上议事厅工具行，并可把它设为默认。
 *
 * 依据 `@deepseek-ai/dsh-agent-presets/README.zh.md`：
 *   · 随附 preset 是 `system` trust、**只读** ⇒ 要加能力必须走
 *     `<dshHome>/.agent-presets/<id>/` 这个 **user 根**；
 *   · `id` 重复时**靠前的根胜出** ⇒ 必须用一个**新 id**，不能叫 `standard`。
 *
 * ## 用法
 *
 *   node scripts/make-council-preset.mjs                 # 造 council（id 默认 council），不改默认
 *   node scripts/make-council-preset.mjs --set-default   # 顺便把 settings.yaml 的默认指向它
 *   node scripts/make-council-preset.mjs --base code     # 想再要一个 Code Mode 版时
 *
 * 幂等：可重复跑；已有内容就跳过对应步骤。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i < 0 ? d : argv[i + 1]
}
const BASE = opt('base', 'standard')            // standard | code | cordis | minimal
const ID = opt('id', 'council')                 // preset id（目录名）
const SET_DEFAULT = argv.includes('--set-default')

const BASE_DIR = `D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh/config/agent-presets/${BASE}`
const DIR = path.join(HOME, '.agent-presets', ID)
const YML = path.join(DIR, 'agent.cordis.yml')
const META = path.join(DIR, 'preset.yml')
const SETTINGS = path.join(HOME, 'settings.yaml')

const MARK = 'tool-subagent-council-architect'
const ANCHOR = '    # Production dsh does not install these optional providers.'

const problems = []
const say = (s) => console.log(s)

// ── 0. 前置检查 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(BASE_DIR)) {
  console.error(`✗ 找不到基础 preset：${BASE_DIR}\n  可用的：code / cordis / minimal / standard`)
  process.exit(1)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(ID)) {
  console.error(`✗ preset id 必须匹配 [a-z0-9][a-z0-9-]*，实得 ${JSON.stringify(ID)}`)
  process.exit(1)
}
if (['standard', 'code', 'cordis', 'minimal'].includes(ID)) {
  console.error(`✗ id 不能与随附 preset 同名（靠前的根会胜出，你的会被遮蔽）`)
  process.exit(1)
}

// ── 1. 整目录复制（只复制组装文件与元数据，不动别的东西）─────────────────────
fs.mkdirSync(DIR, { recursive: true })
const baseYml = fs.readFileSync(path.join(BASE_DIR, 'agent.cordis.yml'), 'utf8')
if (!fs.existsSync(YML)) {
  fs.writeFileSync(YML, baseYml, 'utf8')
  say(`已复制组装文件：${BASE_DIR}/agent.cordis.yml → ${YML}`)
} else {
  say(`组装文件已存在，保留现有：${YML}`)
}

// ── 2. 插入议事厅工具行 ──────────────────────────────────────────────────────
let s = fs.readFileSync(YML, 'utf8')
if (s.includes(MARK)) {
  say('议事厅工具行：已存在，跳过')
} else {
  const EOL = s.includes('\r\n') ? '\r\n' : '\n'
  const i = s.indexOf(ANCHOR)
  if (i < 0) {
    problems.push(`锚点未找到（上游 preset 结构可能变了）：${ANCHOR}`)
    say(`✗ ${problems[problems.length - 1]}`)
  } else {
    const block = [
      '    # ── 议事厅（多模型会议室）· 第一席：架构师 ──────────────────────────',
      '    # provider 由 @dsh-brain/subagent-council 在 HOST plane 注册（见其包内 cordis.patch.yml）；',
      '    # 这里只挂「工具行」，把这一席交给模型。人格与职责边界写在包内（SEAT_PERSONAS.architect）。',
      '    # 与上面 `tool-subagent`(provider: spawn) 的区别：spawn 是通用子代理，本行是固定人格的架构师席位。',
      '    - id: tool-subagent-council-architect',
      "      name: '@deepseek-ai/dsh-tool-subagent'",
      '      config:',
      '        provider: council-architect',
      '        toolName: council_architect',
      '        backgroundMode: continuable',
      '',
      '',
    ].join(EOL)
    fs.writeFileSync(YML, s.slice(0, i) + block + s.slice(i), 'utf8')
    say(`议事厅工具行：已插入（基底 = ${BASE}）`)
  }
}

// ── 3. preset.yml：写 name/description，且**不带 order**（不参与随附 roster 排序）──
const MODE_NOTE = BASE === 'code' ? 'PTC（Code Mode）' : '标准模式（Native 工具，非 Code Mode）'
const meta = [
  'name: 议事厅 · 架构师',
  'description: >-',
  `  在${MODE_NOTE}的全部能力之上，把委派工具的一席交给「议事厅 · 架构师」`,
  '  （provider: council-architect）—— 一个只提方案、不写实现的固定人格子代理，',
  '  产出五段式：问题重述 / 候选方案 / 取舍 / 推荐与风险 / 我可能错在哪。',
  '',
].join('\n')
fs.writeFileSync(META, meta, 'utf8')
say(`元数据已写：name=议事厅 · 架构师（基底 ${BASE}，不带 order）`)

// ── 4. 自检：YAML 可解析、顶层是数组、含 council-architect、且**不含 tool-presentation** ──
try {
  const yaml = (await import('yaml')).default ?? (await import('yaml'))
  const parsed = yaml.parse(fs.readFileSync(YML, 'utf8'))
  if (!Array.isArray(parsed)) problems.push('YAML 顶层不是数组（组装文件必须是插件行列表）')
  else say(`自检：YAML OK（${parsed.length} 行）`)
  if (!JSON.stringify(parsed).includes('council-architect')) problems.push('组装文件里没有 council-architect')
  else say('自检：含 council-architect ✓')

  // ★ 关键：基底是 standard 时**不该**出现 tool-presentation（那就是 Code Mode）
  const hasPresentation = JSON.stringify(parsed).includes('tool-presentation')
  if (BASE === 'standard') {
    if (hasPresentation) problems.push('基底是 standard，却出现了 tool-presentation ⇒ 那不是标准模式！')
    else say('自检：无 tool-presentation ✓（确认不是 Code Mode）')
  } else {
    say(`自检：含 tool-presentation（基底 ${BASE} 本来就是 Code Mode）`)
  }
} catch (e) {
  say('自检跳过（yaml 库不可用）：' + e.message)
}

// ── 5. 可选：把 settings.yaml 的默认指向它（先备份；只改那一行）──────────────
if (SET_DEFAULT) {
  if (!fs.existsSync(SETTINGS)) {
    problems.push(`找不到 settings.yaml：${SETTINGS}`)
  } else {
    const raw = fs.readFileSync(SETTINGS, 'utf8')
    const lines = raw.split(/\r?\n/)
    const at = lines.findIndex((l) => /^agent-presets:\s*$/.test(l))
    if (at < 0) {
      problems.push('settings.yaml 里没有 `agent-presets:` 顶层键')
    } else {
      // 在 agent-presets 块内找 default:
      let di = -1
      for (let i = at + 1; i < lines.length; i++) {
        if (/^[^\s]/.test(lines[i])) break           // 块结束
        if (/^\s+default:\s*/.test(lines[i])) { di = i; break }
      }
      const want = `  default: ${ID}`
      if (di >= 0 && lines[di].trim() === `default: ${ID}`) {
        say(`settings.yaml：默认已是 ${ID}，跳过`)
      } else {
        const backupDir = path.join(HOME, '.backup')
        fs.mkdirSync(backupDir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bak = path.join(backupDir, `settings.yaml.${stamp}.bak`)
        fs.writeFileSync(bak, raw, 'utf8')
        if (di >= 0) lines[di] = want
        else lines.splice(at + 1, 0, want)
        fs.writeFileSync(SETTINGS, lines.join('\n'), 'utf8')
        say(`settings.yaml：默认已改为 ${ID}（旧版备份到 .backup/${path.basename(bak)}）`)
      }
    }
  }
}

say('')
if (problems.length) {
  console.error('✗ 有问题：')
  for (const p of problems) console.error('    · ' + p)
  process.exit(1)
}
say(`✓ 完成。preset id = ${ID}（路径 ${DIR}）`)
say(`  下一步：新开一个窗口即为该 preset。若要把**空白**会话切过去，用 preset 选择器` +
    `（已产出过的会话不能切 —— 见 dsh-agent-presets README 的「仅空白可切」锁）。`)
