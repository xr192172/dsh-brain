// test-arm-isolation-wiring.mjs —— 验证「训练场身份 ⇒ 臂间隔离层」的接线（**不起任何 gen**）
//
// 判据（六条，全过才算数）：
//   ① 纯函数：self + deny 齐备 ⇒ 渲染出 `- insert:` 条目（id/name/self/extraDeny 四个字段逐字对）
//   ② 纯函数：**缺任何一样** ⇒ 空串（不插条目）—— 因为半个身份会让 arm-isolation 抛错（fail-closed）
//   ③ 接线：设了 env ⇒ `extraPatches` 末位出现 arm-isolation overlay，且文件已落盘、内容正确
//   ④ ★ 向后兼容：**什么都不设** ⇒ 没有这个 patch（行为与改动前逐字一致）
//   ⑤ 与 dev 模式**共存**：两个 env 都设 ⇒ envExtra 有 DSH_PERMISSION_MODE **且** extraPatches 有隔离层
//      （这正是"沙箱全开 + 只有软件护栏"的组合）
//   ⑥ deny 根**逐字**落到 YAML 里（不丢、不错引号）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LIB = pathToFileURL('D:/project_develop/dsh-brain/packages/switchboard/lib/gen-assembly.js').href
const mod = await import(LIB)
const { resolveGenSpawnSpec, renderArmIsolationOverlay } = mod

const TMP = 'D:/project_develop/dsh-brain/out/_armwire-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const base = { genPort: 33080, genDir: TMP, defaultProfile: 'web' }

const results = []
const check = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }
const clearEnv = () => { for (const k of ['DSH_ARM_SELF', 'DSH_ARM_DENY', 'DSH_SWITCHBOARD_DEV', 'DSH_PERMISSION_MODE']) delete process.env[k] }

// ①
const y1 = renderArmIsolationOverlay('A', 'D:/project_develop/_arms/a, C:/_arms/b')
const need = ['- insert:', 'id: arm-isolation', "name: '@dsh-brain/arm-isolation'", 'self: "A"']
const miss = need.filter((s) => !y1.includes(s))
check('① 两样齐 ⇒ 渲染出 insert 条目', miss.length === 0 && y1.includes('extraDeny:'), miss.length ? `缺：${miss.join(' | ')}` : '4 个关键字段齐 + extraDeny')

// ②
const cases = [['缺 self', undefined, 'D:/x'], ['缺 deny', 'A', undefined], ['都空', '  ', '  '], ['deny 只有逗号', 'A', ' , , ']]
const bad = cases.filter(([, s, d]) => renderArmIsolationOverlay(s, d) !== '')
check('② 半个身份 ⇒ 空串（不插条目）', bad.length === 0, bad.length ? `失败：${bad.map((c) => c[0]).join('、')}` : `${cases.length} 种情形全为空`)

// ③
clearEnv()
process.env['DSH_ARM_SELF'] = 'A'
process.env['DSH_ARM_DENY'] = 'D:/project_develop/_arms/a/store,C:/_arms/b'
const spec3 = resolveGenSpawnSpec({ ...base })
const tail = spec3.extraPatches[spec3.extraPatches.length - 1] ?? ''
check('③ 接线：env ⇒ extraPatches 末位是该 overlay', tail.endsWith('arm-isolation-overlay.yml'), tail || '(无 patch)')
const body3 = fs.existsSync(tail) ? fs.readFileSync(tail, 'utf8') : ''
check('③b 落盘内容含 arm-isolation', body3.includes('arm-isolation') && body3.includes('extraDeny'), `${body3.split('\n').length} 行`)

// ⑥
check('⑥ deny 根逐字落地', body3.includes('"D:/project_develop/_arms/a/store"') && body3.includes('"C:/_arms/b"'), '两个根都在（JSON 引号形式）')

// ④ ★ 向后兼容
clearEnv()
const spec4 = resolveGenSpawnSpec({ ...base })
const hasArm = spec4.extraPatches.some((p) => p.includes('arm-isolation'))
check('④ 未设 env ⇒ 不插该条目（向后兼容）', !hasArm, `extraPatches=${JSON.stringify(spec4.extraPatches)}`)

// ⑤ 与 dev 模式共存
clearEnv()
process.env['DSH_SWITCHBOARD_DEV'] = '1'
process.env['DSH_ARM_SELF'] = 'A'
process.env['DSH_ARM_DENY'] = 'D:/project_develop/_arms/a/store'
const spec5 = resolveGenSpawnSpec({ ...base })
const ok5 = spec5.envExtra['DSH_PERMISSION_MODE'] === 'danger-full-access' &&
  spec5.extraPatches.some((p) => p.includes('arm-isolation'))
check('⑤ dev 模式与隔离层共存', ok5, `PERMISSION_MODE=${spec5.envExtra['DSH_PERMISSION_MODE']} + 隔离层 patch=${spec5.extraPatches.some((p) => p.includes('arm-isolation'))}`)

clearEnv()
const pass = results.filter((r) => r.ok).length
console.log(`\n结果：${pass}/${results.length} 通过`)
fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify(results, null, 2), 'utf8')
process.exit(pass === results.length ? 0 : 1)
