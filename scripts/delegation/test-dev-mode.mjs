// test-dev-mode.mjs —— 验证"控制面级 dev 模式启动参数"真的落到子代 env 上（**不 spawn 任何进程**）
//
// 判据（三条，全过才算数）：
//   ① devMode:true 显式传 ⇒ spec.envExtra.DSH_PERMISSION_MODE === 'danger-full-access'
//   ② 不显式传 + 环境变量 DSH_SWITCHBOARD_DEV=1 ⇒ 同样生效（证明**所有 spawn 路径自动覆盖**）
//   ③ 不显式传 + 环境变量未设 ⇒ **没有**这个 key（证明**向后兼容：默认行为一个字没变**）
//   ★ 另加 ④：清单若已写别的值 ⇒ dev 模式覆写它（并打警告）—— 用 DSH_PERMISSION_MODE 预置来模拟
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LIB = pathToFileURL('D:/project_develop/dsh-brain/packages/switchboard/lib/gen-assembly.js').href
const mod = await import(LIB)
const { resolveGenSpawnSpec, isDevModeEnv, DEV_PERMISSION_MODE, DEV_MODE_ENV } = mod

const TMP = 'D:/project_develop/dsh-brain/out/_devmode-test'
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const base = { genPort: 33080, genDir: TMP, defaultProfile: 'web' }
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`) }

console.log(`导出: isDevModeEnv=${typeof isDevModeEnv} DEV_PERMISSION_MODE=${DEV_PERMISSION_MODE} DEV_MODE_ENV=${DEV_MODE_ENV}\n`)

// ① 显式 devMode:true
delete process.env[DEV_MODE_ENV]
const s1 = resolveGenSpawnSpec({ ...base, devMode: true })
check('① devMode:true ⇒ 子代 env 带 danger-full-access', s1.envExtra['DSH_PERMISSION_MODE'] === DEV_PERMISSION_MODE,
  `DSH_PERMISSION_MODE=${s1.envExtra['DSH_PERMISSION_MODE']}`)

// ② 只靠环境变量（证明调用方忘了传也不会漏）
process.env[DEV_MODE_ENV] = '1'
const s2 = resolveGenSpawnSpec({ ...base })
check('② 仅 env 开关即生效（全路径覆盖）', s2.envExtra['DSH_PERMISSION_MODE'] === DEV_PERMISSION_MODE,
  `DSH_PERMISSION_MODE=${s2.envExtra['DSH_PERMISSION_MODE']}`)

// ③ 都不设 ⇒ 默认行为不变（向后兼容）
delete process.env[DEV_MODE_ENV]
delete process.env['DSH_PERMISSION_MODE']
const s3 = resolveGenSpawnSpec({ ...base })
check('③ 未开 ⇒ 没有这个 key（默认行为不变）', !('DSH_PERMISSION_MODE' in s3.envExtra),
  `keys=${Object.keys(s3.envExtra).join(',') || '(空)'}`)

// ④ 父进程若已设别的值 ⇒ dev 模式覆写（且应打警告）
process.env['DSH_PERMISSION_MODE'] = 'workspace-write'
process.env[DEV_MODE_ENV] = '1'
console.log('   （下面应出现一条 ⚠️ 覆写警告 —— 那是预期）')
const s4 = resolveGenSpawnSpec({ ...base })
check('④ dev 模式覆写父进程已设的值', s4.envExtra['DSH_PERMISSION_MODE'] === DEV_PERMISSION_MODE,
  `${process.env['DSH_PERMISSION_MODE']} → ${s4.envExtra['DSH_PERMISSION_MODE']}`)

delete process.env[DEV_MODE_ENV]
delete process.env['DSH_PERMISSION_MODE']

const pass = results.filter((r) => r.ok).length
console.log(`\n结果：${pass}/${results.length} 通过`)
fs.writeFileSync(path.join(TMP, 'result.json'), JSON.stringify(results, null, 2), 'utf8')
process.exit(pass === results.length ? 0 : 1)
