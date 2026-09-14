/**
 * add-preset-council.mjs —— 往自定义 preset `code-council` 里挂上「议事厅 · 架构师」工具行。
 *
 * 幂等：已存在则跳过。保留原文件的换行风格与 BOM。
 *
 * 设计依据：随附 preset 是只读的（system trust），要给模型加能力必须走
 * `<dshHome>/.agent-presets/<id>/` 这个 user 根目录。见 dsh-agent-presets/README.zh.md。
 */
import fs from 'node:fs'

const DIR = 'C:/Users/Admin/.dsh/.agent-presets/code-council'
const YML = `${DIR}/agent.cordis.yml`
const META = `${DIR}/preset.yml`

// ── 1. agent.cordis.yml：插入工具行 ─────────────────────────────
const s = fs.readFileSync(YML, 'utf8')
const EOL = s.includes('\r\n') ? '\r\n' : '\n'
const MARK = 'tool-subagent-council-architect'

if (s.includes(MARK)) {
  console.log('agent.cordis.yml: 已存在，跳过')
} else {
  const ANCHOR = '    # Production dsh does not install these optional providers.'
  const i = s.indexOf(ANCHOR)
  if (i < 0) {
    console.error('X 锚点未找到（随附 preset 结构可能变了）：' + ANCHOR)
    process.exit(1)
  }
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
  console.log('agent.cordis.yml: 已插入 tool-subagent-council-architect')
}

// ── 2. preset.yml：改名 + 描述，并丢掉 copy 来的 roster `order` ──
const meta = [
  'name: 议事厅 · 架构师',
  'description: >-',
  '  在 PTC（Code Mode）全部能力之上，把委派工具的一席交给「议事厅 · 架构师」',
  '  （provider: council-architect）—— 一个只提方案、不写实现的固定人格子代理，',
  '  产出五段式：问题重述 / 候选方案 / 取舍 / 推荐与风险 / 我可能错在哪。',
  '',
].join('\n')
fs.writeFileSync(META, meta, 'utf8')
console.log('preset.yml: 已重写（name/description，已丢弃 order）')

// ── 3. 自检：YAML 能否解析 ─────────────────────────────────────
try {
  const yaml = await import('yaml')
  const parsed = yaml.parse(fs.readFileSync(YML, 'utf8'))
  const ok = Array.isArray(parsed)
  console.log(`自检: YAML 解析 ${ok ? 'OK（顶层是数组，' + parsed.length + ' 项）' : '失败：顶层不是数组'}`)
  const found = JSON.stringify(parsed).includes('council-architect')
  console.log(`自检: 含 council-architect = ${found}`)
} catch (e) {
  console.log('自检跳过（yaml 库不可用）：' + e.message)
}
