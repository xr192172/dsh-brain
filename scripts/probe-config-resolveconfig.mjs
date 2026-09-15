// 真机探针：走 cordis 的 resolveConfig 路径，验证"缺 config"到底会不会崩。
// 目的：判定 --dump-config 是否覆盖了 plugin config 校验（怀疑不覆盖）。
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = 'D:/project_develop/dsh-brain'
const cordis = await import(pathToFileURL(path.join(ROOT, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)

const { Context } = cordis
const resolveConfig = cordis.resolveConfig

console.log('cordis exports keys:', Object.keys(cordis).slice(0, 40).join(','))
console.log('resolveConfig 类型:', typeof resolveConfig)

// 直接对 7 个包的真实产物跑 resolveConfig（等价于 loader 实例化时的校验）
const PKGS = [
  'capability-bridge',
  'conveyor-context',
  'design-canvas-bridge',
  'key-pool-proxy',
  'tool-evolution',
  'switchboard',
  'subagent-council',
]

let fail = 0
for (const pkg of PKGS) {
  const modPath = path.join(ROOT, 'packages', pkg, 'lib/index.js')
  let mod
  try {
    mod = await import(pathToFileURL(modPath).href)
  } catch (e) {
    console.log(`  [LOAD-FAIL] ${pkg}: ${e.message}`)
    fail++
    continue
  }
  const Config = mod.Config ?? mod.default?.Config
  if (!Config) {
    console.log(`  [NO-CONFIG] ${pkg}: 无 Config 导出`)
    continue
  }
  for (const [label, raw] of [['undefined', undefined], ['null', null], ['{}', {}]]) {
    // 直接调 ~standard.validate —— 这就是 resolveConfig 内部做的事
    const r = Config['~standard'].validate(raw)
    const issues = r.issues
    const via = typeof resolveConfig === 'function'
      ? (() => { try { resolveConfig({ Config }, raw); return 'OK' } catch (e) { return 'THROW:' + e.constructor.name } })()
      : 'n/a'
    const verdict = issues ? 'REJECT' : 'ACCEPT'
    if (issues) fail++
    console.log(`  ${pkg.padEnd(22)} ${label.padEnd(10)} ${verdict}  resolveConfig=${via}`)
  }
}
console.log(`\n=== 总失败（被拒）数：${fail} ===`)
process.exit(0)
