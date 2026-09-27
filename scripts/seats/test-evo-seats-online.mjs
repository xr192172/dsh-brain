/**
 * test-evo-seats-online.mjs —— "自进化三席真的在线" 的判据（2026-09-27）
 *
 * 为什么需要这道门（而不只是在 check-all 里加个 require）：
 *   三席上线要**三处同时正确**，缺一处就是"看起来上了、其实没有"：
 *
 *     ① HOST plane   `~/.dsh/profiles/web/cordis.patch.yml` 里有 `- id: subagent-council`
 *                    的**覆盖块**且 `seats` 含三席  ⇒ provider 才被注册
 *                    （包内默认只有 `seat: architect`！）
 *     ② preset       `~/.dsh/.agent-presets/council/agent.cordis.yml` 里有**三条工具行**
 *                    （council-architect / evo-dev / evo-review）⇒ 模型手里才有工具
 *     ③ 运行时       前门真起的代数里，boot.log 认得三席注册；且**工具面**里三个名字都在
 *
 *   ★ 三处里任一处对了、另一处没对，都是**最坏的形状**：
 *     只有 ① ⇒ "provider 在线但没人能调"（本次改造前的真实状态）
 *     只有 ② ⇒ **悬空 provider**（工具行指向不存在的 provider ⇒ 席位起不来）
 *
 * 判据分层（与其信"改名回读"，不如逐字核内容 —— 铁律 18）：
 *   A 组 **静态**：两处文件的**内容**（不依赖服务在跑）
 *     A1 profile 有覆盖块且 seats 恰为三席（**不是** insert；insert 会 duplicate id，铁律 2）
 *     A2 profile 的覆盖块**重述了完整 config 四字段**（patch 是整体替换，不是深合并）
 *     A3 preset 有三条工具行，且 provider 名与 ① 注册的名字**对得上**
 *     A4 preset 的 `evo_dev`/`evo_review` **未被 disabled**（否则等于没挂）
 *     A5 ★★ **没有第四处**：两处文件里不存在指向 `evo-*` 的**额外** provider 名（防漂移）
 *   B 组 **交叉一致性**（最容易假绿的地方）
 *     B1 profile 里 `seats` 的**每一个**名字，在 preset 里都有对应工具行
 *     B2 preset 里指向 `evo-*`/`council-*` 的**每一个** provider，在 profile 的 seats 里都有
 *        ⇒ 两个方向都查，才叫"对得上"
 *   C 组 **消融自证**
 *     C1 撤掉 profile 的 seats（退回只注册一个）⇒ B1 必须变红
 *     C2 撤掉 preset 的一条工具行 ⇒ B1 必须变红
 *     ★ 不撤时必须**仍然全绿**（反自证，防"假红被当成通过"）
 *
 * ★ 本门**不需要服务在跑**（A/B/C 全是静态），所以能在 check-all 里稳定跑。
 *   运行时的实证（boot.log + 工具面 + 真委派）另在 `out/_probe-*.mjs` 里，属于一次性取证。
 *
 * 用法：node scripts/seats/test-evo-seats-online.mjs
 * 退出码：0 = 全过；1 = 有 FAIL
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(HERE, '..', '..')
const HOME = process.env.DSH_HOME_FOR_SEATS ?? 'C:/Users/Admin/.dsh'

const PROFILE = path.join(HOME, 'profiles', 'web', 'cordis.patch.yml')
const PRESET = path.join(HOME, '.agent-presets', 'council', 'agent.cordis.yml')

/** 三席的权威清单（与 packages/subagent-council/src/index.ts 的 SEAT_PERSONAS 对齐）。 */
const SEATS = ['architect', 'dev', 'review']
/** packge 里注册它们用的 provider 名（见 index.ts 的 SEAT_PROVIDER_NAMES）。 */
const PROVIDER_OF = { architect: 'council-architect', dev: 'evo-dev', review: 'evo-review' }
const TOOLNAME_OF = { architect: 'council_architect', dev: 'evo_dev', review: 'evo_review' }

const results = []
const check = (n, ok, detail) => {
  results.push({ n, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`)
}

// ─── 读源（不存在就直接判红，不当"跳过"）─────────────────────────────────────
const read = (p) => {
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}
const profSrc = read(PROFILE)
const presetSrc = read(PRESET)

check('A0 两处文件都存在', profSrc !== null && presetSrc !== null,
  `profile=${profSrc === null ? '缺失' : 'ok'} preset=${presetSrc === null ? '缺失' : 'ok'}`)

// 把 YAML 里的注释行剥掉 —— **只在真配置里判定**（铁律 41：作用域限定）
const stripComment = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
const profCode = profSrc ? stripComment(profSrc) : ''
const presetCode = presetSrc ? stripComment(presetSrc) : ''

// ─── A1 profile 有覆盖块（不是 insert）───────────────────────────────────────
// 形状：顶层 `- id: subagent-council`（**不带** `insert:`）⇒ 覆盖；带 insert ⇒ 会 duplicate
const hasOverride = /^- id: subagent-council$/m.test(profCode)
const hasInsertOfIt = /^\s*- id: subagent-council$/m.test(
  profCode.split(/^- id: subagent-council$/m)[0] + (profCode.match(/- insert:\n(?:.*\n)*?.*subagent-council/) ? 'subagent-council' : ''),
)
check('A1a profile 用【覆盖块】注册 subagent-council（不是 insert）', hasOverride,
  hasOverride ? '找到顶层 `- id: subagent-council`' : '★ 没找到覆盖块 ⇒ provider 仍只有 architect')

// A1b：覆盖块里 seats 恰为三席（按块范围取，不跨块 —— 铁律 41）
let seatsInProfile = []
if (hasOverride) {
  const idx = profCode.indexOf('\n- id: subagent-council')
  const after = idx >= 0 ? profCode.slice(idx + 1) : profCode.slice(profCode.indexOf('- id: subagent-council'))
  // 到【下一个顶层 `- ` 项】为止（下一项以 `- ` 开头且缩进 0）
  const endRel = after.slice(1).search(/\n- /)
  const block = endRel >= 0 ? after.slice(0, endRel + 1) : after
  const m = block.match(/^\s{4}seats:\n((?:\s{6}- .+\n?)+)/m)
  if (m) seatsInProfile = m[1].split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2).trim())
}
check('A1b profile 的覆盖块里 seats 恰为三席', JSON.stringify(seatsInProfile) === JSON.stringify(SEATS),
  `seats=${JSON.stringify(seatsInProfile)}（期望 ${JSON.stringify(SEATS)}）`)

// ─── A2 重述完整 config（patch 是整体替换，不是深合并）────────────────────────
// 源码依据：node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:100-103 `target[key] = value`
const idxP = profCode.indexOf('\n- id: subagent-council')
const blockP = idxP >= 0 ? (() => {
  const a = profCode.slice(idxP + 1)
  const e = a.slice(1).search(/\n- /)
  return e >= 0 ? a.slice(0, e + 1) : a
})() : ''
const hasSeat = /^\s{4}seat:/m.test(blockP)
const hasModel = /^\s{4}model:/m.test(blockP)
const hasProvider = /^\s{4}provider:/m.test(blockP)
check('A2 覆盖块重述了完整 config 四字段（seat/seats/model/provider）',
  hasSeat && hasModel && hasProvider,
  `seat=${hasSeat} seats=${seatsInProfile.length > 0} model=${hasModel} provider=${hasProvider}` +
    (hasModel && hasProvider ? '' : ' ★ 漏字段会被整体替换冲掉'))

// ─── A3 preset 三条工具行（按 delegation 组范围取）────────────────────────────
// 只在 delegation 组里找（组外的同名行不算 —— 作用域限定）
const delegationStart = presetCode.indexOf('- id: delegation')
const delegationEnd = delegationStart >= 0 ? presetCode.indexOf('\n- id:', delegationStart + 10) : -1
const delegationCode = delegationStart >= 0
  ? presetCode.slice(delegationStart, delegationEnd >= 0 ? delegationEnd : undefined)
  : ''

/** 从一块文本里取所有 `- id: X` … `provider: Y` 的配对。 */
function toolRows(block) {
  const rows = []
  const re = /- id:\s*([A-Za-z0-9_-]+)\n(?:.*\n)*?/g
  // 逐行扫，遇到 `- id:` 开新条目，遇到 `provider:` 记下
  const lines = block.split('\n')
  let cur = null
  for (const l of lines) {
    const mId = l.match(/^\s*- id:\s*([A-Za-z0-9_-]+)\s*$/)
    if (mId) { if (cur) rows.push(cur); cur = { id: mId[1], provider: null, disabled: false } ; continue }
    if (!cur) continue
    const mP = l.match(/^\s+provider:\s*([A-Za-z0-9_-]+)\s*$/)
    if (mP) cur.provider = mP[1]
    if (/^\s+disabled:\s*true\s*$/.test(l)) cur.disabled = true
  }
  if (cur) rows.push(cur)
  return rows
}

const rows = toolRows(delegationCode)
const seatRows = rows.filter((r) => Object.values(PROVIDER_OF).includes(r.provider))
const byProvider = Object.fromEntries(seatRows.map((r) => [r.provider, r]))

check('A3 preset 的 delegation 组里有三席工具行',
  SEATS.every((s) => byProvider[PROVIDER_OF[s]]),
  `找到 ${seatRows.length} 条：${seatRows.map((r) => `${r.id}(${r.provider})`).join(', ') || '(无)'}`)

// ─── A4 三席工具行都不能被 disabled ──────────────────────────────────────────
const disabledSeats = seatRows.filter((r) => r.disabled).map((r) => r.provider)
check('A4 三席工具行都未被 disabled', disabledSeats.length === 0,
  disabledSeats.length === 0 ? '三条都是启用态' : `★ 被禁用：${disabledSeats.join(',')}`)

// ─── B1 profile 的每个 seat 都有工具行 ───────────────────────────────────────
const missingRow = seatsInProfile.filter((s) => !byProvider[PROVIDER_OF[s]])
check('B1 profile 的每个 seat 在 preset 里都有工具行', missingRow.length === 0,
  missingRow.length === 0 ? '双向齐全' : `★ 悬空（注册了但模型没工具）：${missingRow.join(',')}`)

// ─── B2 preset 的每个席位 provider 都在 profile 的 seats 里 ──────────────────
const seatsProviderOf = seatsInProfile.map((s) => PROVIDER_OF[s])
const dangling = seatRows.filter((r) => r.provider && !seatsProviderOf.includes(r.provider)).map((r) => r.provider)
check('B2 preset 的席位 provider 都能在 profile 的 seats 里找到', dangling.length === 0,
  dangling.length === 0 ? '无悬空 provider' : `★ 悬空 provider（工具指向没人注册的名字）：${dangling.join(',')}`)

// ─── A5 防漂移：不存在其它 `evo-*` provider 名（第四处接线）──────────────────
const allProviders = [...new Set([...presetCode.matchAll(/provider:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]))]
const evoLike = allProviders.filter((p) => /^evo-/.test(p))
const unexpected = evoLike.filter((p) => !Object.values(PROVIDER_OF).includes(p))
check('A5 preset 里没有【计划外】的 evo-* provider', unexpected.length === 0,
  unexpected.length === 0 ? `evo-* 共 ${evoLike.length} 个，全部在三席清单内` : `★ 计划外：${unexpected.join(',')}`)

// ─── C 组：消融自证 ─────────────────────────────────────────────────────────
/** 纯函数化的判定入口：给定两处源码，返回 B1 是否通过。供消融复用。 */
function b1Holds(profText, presetText) {
  const pc = stripComment(profText)
  const prc = stripComment(presetText)
  const i = pc.indexOf('\n- id: subagent-council')
  if (i < 0) return false
  const a = pc.slice(i + 1)
  const e = a.slice(1).search(/\n- /)
  const blk = e >= 0 ? a.slice(0, e + 1) : a
  const m = blk.match(/^\s{4}seats:\n((?:\s{6}- .+\n?)+)/m)
  if (!m) return false
  const seats = m[1].split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2).trim())
  const ds = prc.indexOf('- id: delegation')
  const de = ds >= 0 ? prc.indexOf('\n- id:', ds + 10) : -1
  const dcode = ds >= 0 ? prc.slice(ds, de >= 0 ? de : undefined) : ''
  const rws = toolRows(dcode)
  const provs = new Set(rws.map((r) => r.provider).filter(Boolean))
  return seats.every((s) => provs.has(PROVIDER_OF[s]))
}

// C1 消融：把 seats 从 profile 里抹掉 ⇒ B1 必须变红
const profNoSeats = profSrc ? profSrc.replace(/^(\s{4})seats:\n(?:\s{6}- .+\n?)+/m, '') : ''
const c1 = !b1Holds(profNoSeats, presetSrc)
check('C1 消融：抹掉 profile 的 seats ⇒ B1 变红', c1,
  c1 ? '撤掉后确实判红 ⇒ B1 判据有效' : '★ 撤掉后仍绿 ⇒ B1 是空转（同义反复）')

// C2 消融：抹掉 preset 的一条工具行（evo-review）⇒ B1 必须变红
const presetNoReview = presetSrc
  ? presetSrc.replace(/^\s*- id: tool-subagent-evo-review\n(?:\s+.*\n?)*?^\s+backgroundMode: continuable\n/m, '')
  : ''
const c2 = presetNoReview !== presetSrc && !b1Holds(profSrc, presetNoReview)
check('C2 消融：抹掉 preset 的 evo-review 工具行 ⇒ B1 变红', c2,
  c2 ? '撤掉后确实判红 ⇒ B1 判据有效' : '★ 撤掉后仍绿（或没匹配到）⇒ B1 是空转')

// C3 反自证：不撤时 B1 必须仍绿（防"假红被当成通过"）
const c3 = b1Holds(profSrc, presetSrc)
check('C3 反自证：不消融时 B1 仍必须绿', c3, c3 ? '原始两处文件判绿' : '★ 原始文件判红 ⇒ C1/C2 的红不可信')

// ─── 汇总 ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log('\n' + '='.repeat(60))
console.log(`结果：${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  · ${f.n}`)
}
process.exit(failed.length ? 1 : 0)
