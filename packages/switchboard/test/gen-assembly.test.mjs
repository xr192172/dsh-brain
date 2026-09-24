/**
 * gen-assembly 纯函数单测（零依赖，`node test/gen-assembly.test.mjs`）。
 *
 * 守的是**判据本身**，不是实现细节：每一条用例对应一条"若破就会让判据变成假绿"的性质。
 * 尤其红向用例（该抛就抛）——本层的存在理由是"配置错误不得伪装成一次成功换代"。
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGenAssembly,
  loadGenAssembly,
  parseEnvFile,
  poolPortOf,
  renderAssemblyOverlay,
  resolveGenSpawnSpec,
  projectAssembly,
} from '../lib/gen-assembly.js'

let pass = 0
let fail = 0
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  [OK ] ${name}`)
  } else {
    fail++
    console.log(`  [RED] ${name}\n         期望 ${e}\n         实际 ${a}`)
  }
}
function throws(name, fn, needle) {
  try {
    fn()
    fail++
    console.log(`  [RED] ${name}\n         期望抛错，实际没有抛`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (needle && !msg.includes(needle)) {
      fail++
      console.log(`  [RED] ${name}\n         期望错因含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(msg)}`)
    } else {
      pass++
      console.log(`  [OK ] ${name}`)
    }
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'b2-genasm-'))

console.log('parseEnvFile / poolPortOf')
eq('env 解析：注释/空行/引号/等号在后', parseEnvFile('# c\n\nA=1\nB="x=y"\nC=\nD= z \n'), { A: '1', B: 'x=y', D: 'z' })
eq('池未启用 ⇒ 无池口（这就是"控制面最小集"）', poolPortOf({ enabled: false, portOffset: 1000 }, 3041), null)
eq('池未声明 ⇒ 无池口', poolPortOf(undefined, 3041), null)
eq('★ 池口派生（不再固定 3101）', poolPortOf({ enabled: true, portOffset: 100 }, 3043), 3143)
eq('未给偏移 ⇒ 默认 +1000', poolPortOf({ enabled: true }, 3043), 4043)
eq('显式端口优先', poolPortOf({ enabled: true, portOffset: 100, explicitPort: 4501 }, 3043), 4501)

console.log('parseGenAssembly（该红的红）')
throws('缺 version ⇒ 抛', () => parseGenAssembly('{}'), 'version')
throws('不是 JSON ⇒ 抛', () => parseGenAssembly('nope'), '合法 JSON')
throws('顶层是数组 ⇒ 抛', () => parseGenAssembly('[]'), '顶层必须是对象')
throws('pool.portOffset 不是整数 ⇒ 抛', () => parseGenAssembly('{"version":1,"pool":{"portOffset":"1000"}}'), 'pool.portOffset')
throws('model 缺 provider ⇒ 抛', () => parseGenAssembly('{"version":1,"model":{"id":"m"}}'), 'model.provider')
eq('最小合法清单', parseGenAssembly('{"version":1}').version, 1)

console.log('renderAssemblyOverlay（装配翻译）')
eq('空清单 ⇒ 空 overlay（行为与今天完全一致）', renderAssemblyOverlay({ version: 1 }, 3041), '')
const y1 = renderAssemblyOverlay(
  { version: 'v1', pool: { enabled: true, portOffset: 100, upstreamBase: 'http://127.0.0.1:33999' }, model: { provider: 'agnes', id: 'agnes-2.5-flash' } },
  3043,
)
eq('★ 池口随代走：gen 3043 ⇒ 池 3143', y1.includes('port: 3143'), true)
eq('★ 模型上行指向本代池', y1.includes('baseURL: "http://127.0.0.1:3143/v1"'), true)
eq('key-pool-proxy 走 insert（与它自己的 bundle 同形）', y1.includes("- insert:\n    - id: key-pool-proxy"), true)
const y2 = renderAssemblyOverlay({ version: 'v1', pool: { enabled: true, portOffset: 100 }, model: { provider: 'agnes', id: 'm' } }, 3044)
eq('换一代 ⇒ 渲染出来的池口也变（= 换代才会变）', y2.includes('port: 3144') && !y2.includes('port: 3143'), true)

console.log('loadGenAssembly / resolveGenSpawnSpec')
eq('清单路径为空 ⇒ 最小集', loadGenAssembly(undefined).source, 'none')
eq('清单文件不存在 ⇒ 最小集（控制面照样能起）', loadGenAssembly(join(tmp, 'nope.json')).source, 'none')

writeFileSync(join(tmp, 'pool.env'), 'AGENTSHELL_MAIN_LLM_API_KEYS=k1,k2\nAGENTSHELL_MAIN_LLM_API_KEY=k1\n')
writeFileSync(
  join(tmp, 'gen-assembly.json'),
  JSON.stringify({
    version: 'v1',
    profile: 'brainX',
    envFiles: [join(tmp, 'pool.env')],
    env: { EXTRA_FLAG: '1' },
    pool: { enabled: true, portOffset: 100, upstreamBase: 'http://127.0.0.1:33999' },
    model: { provider: 'agnes', id: 'agnes-2.5-flash' },
  }),
)
const spec = resolveGenSpawnSpec({ file: join(tmp, 'gen-assembly.json'), genPort: 3043, genDir: join(tmp, 'gen-3043'), defaultProfile: 'ctrl' })
eq('清单声明 profile ⇒ 用它', spec.profile, 'brainX')
eq('代 env：来自清单声明的 env 文件 + 内联', [spec.envExtra.AGENTSHELL_MAIN_LLM_API_KEYS, spec.envExtra.EXTRA_FLAG], ['k1,k2', '1'])
eq('代池口', spec.poolPort, 3143)
eq('overlay 落盘（可被 --patch 指到）', spec.extraPatches.length === 1 && existsSync(spec.extraPatches[0]), true)
eq('落盘内容里含本代池口', readFileSync(spec.extraPatches[0], 'utf8').includes('port: 3143'), true)

// 同一份清单、不同代端口 ⇒ 池口不同（"池随代走"而不是"池是控制面级共享资源"）
const specOtherGen = resolveGenSpawnSpec({ file: join(tmp, 'gen-assembly.json'), genPort: 3044, genDir: join(tmp, 'gen-3044'), defaultProfile: 'ctrl' })
eq('同一清单 + 下一代 ⇒ 池口随代变', specOtherGen.poolPort, 3144)

// 清单不声明 profile 的形态
writeFileSync(join(tmp, 'no-profile.json'), JSON.stringify({ version: 'v2', pool: { enabled: true, portOffset: 100 } }))
const specNoProfile = resolveGenSpawnSpec({ file: join(tmp, 'no-profile.json'), genPort: 3044, genDir: join(tmp, 'gen-np'), defaultProfile: 'ctrl' })
eq('清单没声明 profile ⇒ 回落控制剖面', specNoProfile.profile, 'ctrl')
const specMin = resolveGenSpawnSpec({ file: undefined, genPort: 3045, genDir: join(tmp, 'gen-3045'), defaultProfile: 'ctrl' })
eq('无清单 ⇒ 控制剖面 + 无 patch + 无 env', [specMin.profile, specMin.extraPatches.length, Object.keys(specMin.envExtra).length, specMin.poolPort], ['ctrl', 0, 0, null])

writeFileSync(join(tmp, 'bad.json'), '{"version":1,"pool":{"enabled":true,"portOffset":1000},"envFiles":["' + join(tmp, 'missing.env').replace(/\\/g, '\\\\') + '"]}')
throws(
  '★ 清单声明的 env 文件不存在 ⇒ 抛（不许静默跳过一个"没有 key 的代"）',
  () => resolveGenSpawnSpec({ file: join(tmp, 'bad.json'), genPort: 3046, genDir: join(tmp, 'gen-3046'), defaultProfile: 'ctrl' }),
  '不存在',
)
writeFileSync(join(tmp, 'nonsense.json'), '{"version":1,"profile":')
throws(
  '★ 清单坏 ⇒ 抛（坏配置不得伪装成一次成功换代）',
  () => resolveGenSpawnSpec({ file: join(tmp, 'nonsense.json'), genPort: 3047, genDir: join(tmp, 'gen-3047'), defaultProfile: 'ctrl' }),
  '合法 JSON',
)

console.log('projectAssembly（?cmd=assembly 的投影）')
const pj = projectAssembly({ file: join(tmp, 'gen-assembly.json'), ctrlProfile: 'ctrl', probeGenPort: 3043 })
eq('投影：控制剖面 / 清单在 / 下一代池口', [pj.ctrlProfile, pj.assemblyPresent, pj.probePoolPort], ['ctrl', true, 3143])
eq('投影只报 env 文件**名字**，不报值', pj.envFileNames.length === 1 && !JSON.stringify(pj).includes('k1,k2'), true)
const pjMin = projectAssembly({ file: join(tmp, 'nope.json'), ctrlProfile: 'ctrl', probeGenPort: 3043 })
eq('无清单 ⇒ 投影说清"没有模型接入"', [pjMin.assemblyPresent, pjMin.poolEnabled, pjMin.overlayPreview], [false, false, ''])

mkdirSync(join(tmp, 'cleanup'), { recursive: true })
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* 临时目录清理失败不影响判据 */
}

console.log(`\n${pass}/${pass + fail} OK`)
if (fail > 0) process.exit(1)
