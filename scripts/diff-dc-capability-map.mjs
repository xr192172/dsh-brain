#!/usr/bin/env node
/**
 * diff-dc-capability-map.mjs —— design-canvas 能力线目录：一致性验收 + 回填 dsh 能力库登记
 *
 * 演变（2026-09-14）：
 *   旧版：正则解析 capability_map.ts 的**手工 LANES 表**，检出「已注册但没进任何能力线」的工具
 *         —— 当时抓到 4 个工具看不见（含记忆系统两个入口）。
 *   现版：LANES 已改成**由 server_registry 的 TOOL_DEFS 自动派生**（LANE_OF 只写归属，
 *         when 缺省由注册描述摘要）→ 漂移在结构上不可能发生；本脚本随之改为对**真实产物**
 *         做三方对账，不再正则会话源码：
 *           ① 直接 import design-canvas 编译产物（dist）—— 查真注册表，不查包装层/副本；
 *           ② validateLanes 必须为空（未归线 / 陈旧标注 / direct 越线 全为 0）；
 *           ③ 真调 capability_map 的 handler（证明 makeCapabilityMapHandler(() => TOOL_DEFS)
 *              的注入没断），全量地图落 out/ 供人/LLM 复核；
 *           ④ 与 ~/.dsh/capabilities/registry.json 里 design-canvas 的 tooling 块对账，--fix 回填。
 *
 * 用法：
 *   node scripts/diff-dc-capability-map.mjs          # 只报不改（校验失败 exit 1）
 *   node scripts/diff-dc-capability-map.mjs --fix     # 回填 registry.json 的 tooling 块
 */
import fs from 'node:fs'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const OUT = 'D:/project_develop/dsh-brain/out/dc-capability-map.txt'
const HOME = process.env.DSH_HOME ?? 'C:/Users/Admin/.dsh'
const REGISTRY = path.join(HOME, 'capabilities', 'registry.json')
const fix = process.argv.includes('--fix')

const regEntry = `${DC}/dist/src/server_registry.js`
const cmEntry = `${DC}/dist/src/tools/capability_map.js`
if (!fs.existsSync(regEntry) || !fs.existsSync(cmEntry)) {
  console.error(`X 找不到 design-canvas 编译产物（先 npm run build）：\n  ${regEntry}`)
  process.exit(1)
}

const reg = await import(`file:///${regEntry}`)
const cm = await import(`file:///${cmEntry}`)

const catalog = reg.TOOL_DEFS.map((d) => ({ name: d.name, title: d.title, description: d.description }))
const def = reg.TOOL_DEFS.find((d) => d.name === 'capability_map')
if (!def) {
  console.error('X 注册表里没有 capability_map —— 工具被摘了？')
  process.exit(1)
}

const errors = cm.validateLanes(catalog)
const { lanes, unassigned, stale } = cm.buildLanes(catalog)
const report = cm.laneMaintenanceReport(catalog)
const full = await def.handler({})
const badLane = await def.handler({ lane: 'no_such_lane' })
if (!badLane.isError) errors.push('未知 lane 未按错误返回')

const live = {
  mode: 'derived-from-TOOL_DEFS',
  toolCount: reg.TOOL_DEFS.length,
  laneCount: lanes.length,
  lanes: lanes.map((l) => l.id),
  laneToolCount: lanes.reduce((n, l) => n + l.tools.length, 0),
  directCount: new Set(lanes.flatMap((l) => l.direct)).size,
  curatedWhen: report.curated,
  derivedWhen: report.derived.length,
  drift: {
    registeredNotInLanes: unassigned.map((t) => t.name),
    inLanesNotRegistered: stale,
    exempt: [],
  },
  scannedAt: new Date().toISOString(),
}

// ── 报告 ────────────────────────────────────────────────────────────────────
const out = []
out.push('design-canvas 能力线目录：与真实注册表三方对账')
out.push(`  源（编译产物）: ${regEntry}`)
out.push(`  ★ 目录来源: ${live.mode}（LANE_OF 只写归属；when=${live.curatedWhen} 人工 / ${live.derivedWhen} 自动摘要）`)
out.push(`  注册工具数 : ${live.toolCount}`)
out.push(`  目录收录数 : ${live.laneToolCount}（未归线 ${live.drift.registeredNotInLanes.length}）`)
out.push(`  能力线     : ${live.lanes.join(', ')}（${live.laneCount} 条）`)
out.push(`  陈旧标注   : ${live.drift.inLanesNotRegistered.join(', ') || '（无）'}`)
out.push(`  direct 白名单: ${live.directCount}`)
out.push(`  校验错误   : ${errors.length ? JSON.stringify(errors, null, 2) : '（无）'}`)
out.push('')
out.push(`★ 已注册但没进任何能力线（${live.drift.registeredNotInLanes.length} 条）`)
for (const x of live.drift.registeredNotInLanes) out.push(`    ${x}`)
if (!live.drift.registeredNotInLanes.length) out.push('    （无）')
out.push('')
out.push('──── capability_map 实调输出（模型可见的地图）────')
out.push(full.text)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, out.join('\n'), 'utf8')

// ── 对账 dsh 能力库登记 ──────────────────────────────────────────────────────
const db = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : null
const entry = db?.capabilities?.find((c) => c.id === 'design-canvas')
const diffs = []
if (!entry) {
  diffs.push('registry.json 里没有 design-canvas 条目')
} else {
  const prev = entry.tooling ?? {}
  for (const k of ['toolCount', 'laneCount', 'laneToolCount', 'directCount', 'mode']) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(live[k])) diffs.push(`${k}: ${JSON.stringify(prev[k])} → ${JSON.stringify(live[k])}`)
  }
  const prevDrift = prev.drift ?? {}
  if (JSON.stringify(prevDrift.registeredNotInLanes ?? []) !== JSON.stringify(live.drift.registeredNotInLanes)) {
    diffs.push(`drift.registeredNotInLanes: ${JSON.stringify(prevDrift.registeredNotInLanes ?? [])} → ${JSON.stringify(live.drift.registeredNotInLanes)}`)
  }
  if (JSON.stringify(prevDrift.inLanesNotRegistered ?? []) !== JSON.stringify(live.drift.inLanesNotRegistered)) {
    diffs.push(`drift.inLanesNotRegistered: ${JSON.stringify(prevDrift.inLanesNotRegistered ?? [])} → ${JSON.stringify(live.drift.inLanesNotRegistered)}`)
  }
}

console.log(out.slice(0, 8).join('\n'))
console.log(`\n对账 dsh 能力库（${REGISTRY}）:`)
console.log(diffs.length ? diffs.map((d) => '  · ' + d).join('\n') : '  （一致）')

if (fix && entry) {
  entry.tooling = live
  entry.signals = entry.signals ?? {}
  entry.signals.notes = [
    `工具面：${live.toolCount} 工具 / ${live.laneCount} 条能力线（${live.lanes.join(', ')}）；目录由 TOOL_DEFS 派生，未归线 ${live.drift.registeredNotInLanes.length} 个`,
  ]
  db.updatedAt = new Date().toISOString()
  const tmp = `${REGISTRY}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, REGISTRY)
  console.log(`  ✅ 已回填 tooling 块（${live.mode}）`)
}

console.log(`\nok -> ${OUT}`)
process.exit(errors.length ? 1 : 0)
