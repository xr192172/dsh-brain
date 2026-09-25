// seats-check.mjs —— 判据：自进化两席（开发脑 / 审批脑）注册正确 + 向后兼容 + 不静默降级
//
// 依据：`docs/revised-architecture-2026-09-20.md` §7（三段流水线；§7.0 融合归开发脑；§:218 防串供）
//       与 `docs/training-ground-and-skill-sieve-2026-09-25.md` §11（用户 2026-09-25 口述）。
//
// 判据（8 条，全过才算数）：
//   ① 三个席位齐（architect/dev/review）+ 三个 **不同**的 provider 名
//   ② 开发脑人格含"六段"与关键职责（编排 / 融合 / 自证 / 回值 / 我可能错在哪）
//   ③ 审批脑人格含"五段"（独立复算 / 裁决 / 下一步 / 我可能错在哪）**且防串供写进去了**
//   ④ `apply({seats:['dev','review']})` ⇒ 注册 **2** 个，名字是 evo-dev / evo-review
//   ⑤ ★ **向后兼容**：`apply({})` ⇒ **只注册 1 个**，名字 = council-architect（与改动前逐字一致）
//   ⑥ ★ 未知席位 **跳过**（不静默降级成 architect）：`apply({seats:['dev','nope']})` ⇒ 只 1 个（evo-dev）
//   ⑦ 两席都挂上时**有防串供可见性**（打印身份；两席都继承时告警"它们就同源"）
//   ⑧ ★★ 消融：把"未知席位跳过"改成"降级成 architect" ⇒ 判据⑥ **必须变红**
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const LIB = pathToFileURL('D:/project_develop/dsh-brain/packages/subagent-council/lib/index.js').href
const mod = await import(LIB)
const { apply, SEAT_PERSONAS, SEAT_PROVIDER_NAMES, EVOLUTION_SEATS } = mod

const results = []
const check = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

/** 假 ctx：只捕获 registerProvider 的调用；同时把 console.log 拦下来供断言。 */
function runApply(config) {
  const captured = []
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.map(String).join(' '))
  try {
    apply({ subagents: { registerProvider: (p) => captured.push(p) } }, config)
  } finally {
    console.log = orig
  }
  return { names: captured.map((p) => p?.name), logs, providers: captured }
}

// ①
const seats = Object.keys(SEAT_PERSONAS).sort()
const names = Object.values(SEAT_PROVIDER_NAMES)
check('① 三席齐 + provider 名互不相同',
  seats.join(',') === 'architect,dev,review' && new Set(names).size === names.length,
  `seats=[${seats.join(', ')}] providers=[${names.join(', ')}]`)

// ②
const dev = SEAT_PERSONAS.dev ?? ''
const devNeed = ['职责边界', '编排', '融合', '自证', '回值', '我可能错在哪']
const devMiss = devNeed.filter((k) => !dev.includes(k))
check('② 开发脑人格：职责边界 + 六段要素齐', devMiss.length === 0, devMiss.length ? `缺：${devMiss.join('、')}` : `${dev.split('\n').length} 行，6 个关键要素齐`)

// ③
const rev = SEAT_PERSONAS.review ?? ''
const revNeed = ['职责边界', '独立复算', '裁决', '下一步', '我可能错在哪']
const revMiss = revNeed.filter((k) => !rev.includes(k))
// ★ 独立性那一条必须**可执行**：写明"没给作者信息就写【独立性无法核对】" + 三级阶梯（跨模型 > 跨会话 > …）
const hasIndependence =
  rev.includes('无环') && rev.includes('不同机构') && rev.includes('跨模型') && rev.includes('独立性无法核对')
check('③ 审批脑人格：职责边界 + 五段要素 + **可执行的独立性条款**', revMiss.length === 0 && hasIndependence,
  revMiss.length ? `缺：${revMiss.join('、')}` : (hasIndependence ? `${rev.split('\n').length} 行，五段齐 + 独立性条款可执行` : '★ 独立性条款不可执行（缺：无环/不同机构/跨模型/独立性无法核对 之一）'))

// ④
const both = runApply({ seats: ['dev', 'review'] })
check('④ 一次挂两席 ⇒ 注册 evo-dev + evo-review',
  both.names.length === 2 && both.names.includes('evo-dev') && both.names.includes('evo-review'),
  `names=[${both.names.join(', ')}]`)

// ⑤ ★ 向后兼容
const legacy = runApply({})
check('⑤ 向后兼容：空配置 ⇒ 只注册 council-architect',
  legacy.names.length === 1 && legacy.names[0] === 'council-architect',
  `names=[${legacy.names.join(', ')}]`)

// ⑥ ★ 不静默降级
const unknown = runApply({ seats: ['dev', 'nope'] })
check('⑥ 未知席位 ⇒ 跳过（不降级成 architect）',
  unknown.names.length === 1 && unknown.names[0] === 'evo-dev',
  `names=[${unknown.names.join(', ')}]`)

// ⑦ 防串供可见性
const warnProbe = runApply({ seats: ['dev', 'review'] })
const visible = warnProbe.logs.some((l) => l.includes('自进化两席已就位')) && warnProbe.logs.some((l) => l.includes('防串供'))
const warnedInherit = warnProbe.logs.some((l) => l.includes('跨会话') && l.includes('跨模型'))
check('⑦ 独立性可见：打印身份 + 两席同继承时按【三级阶梯】告警', visible && warnedInherit,
  `可见=${visible} 阶梯告警=${warnedInherit}`)

// ⑧ ★★ 消融自证
const SRC = 'D:/project_develop/dsh-brain/packages/subagent-council/src/index.ts'
const ANCHOR = 'const persona = SEAT_PERSONAS[seat];'
const ABLATED = 'const persona = SEAT_PERSONAS[seat] ?? SEAT_PERSONAS.architect; // ABLATED'
const src = fs.readFileSync(SRC, 'utf8')
let ablOk = false
if (!src.includes(ANCHOR)) {
  console.log('  ★ 消融锚点失配 —— 必须重写（不许模糊匹配）')
} else {
  const bak = src
  const tsc = 'D:/project_develop/dsh-brain/node_modules/typescript/bin/tsc'
  const cfg = 'D:/project_develop/dsh-brain/packages/subagent-council/tsconfig.json'
  fs.writeFileSync(SRC, src.replace(ANCHOR, ABLATED), 'utf8')
  const b = spawnSync(process.execPath, [tsc, '-p', cfg], { encoding: 'utf8', timeout: 120000 })
  let ablNames = null
  if (b.status === 0) {
    const m2 = await import(LIB + '?abl=' + Date.now())
    const cap = []
    const o = console.log; console.log = () => {}
    try { m2.apply({ subagents: { registerProvider: (p) => cap.push(p.name) } }, { seats: ['dev', 'nope'] }) } catch {}
    console.log = o
    ablNames = cap
  }
  fs.writeFileSync(SRC, bak, 'utf8')
  spawnSync(process.execPath, [tsc, '-p', cfg], { encoding: 'utf8', timeout: 120000 }) // 还原并重建
  ablOk = Array.isArray(ablNames) && ablNames.length === 2 // 消融后"跳过"失效 ⇒ 会注册 2 个
  console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 消融：把"未知席位跳过"改成"降级成 architect" ⇒ 判据⑥ 变红 ${ablOk ? '✓' : `（没变红 ⇒ 那条没接线；ablNames=${JSON.stringify(ablNames)}）`}`)
}

const pass = results.filter((r) => r.ok).length
const total = pass === results.length && ablOk
console.log(`\n结果：判据 ${pass}/${results.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
fs.writeFileSync('D:/project_develop/dsh-brain/out/_seats-check.json', JSON.stringify(results, null, 2), 'utf8')
process.exit(total ? 0 : 1)
