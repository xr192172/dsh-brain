/**
 * test-capability-bridge.mjs —— 不重启 DSH 就验证 capability-bridge 的工具实现
 *
 * 原理：直接 import 包的 lib/index.js，用 mock 的 ctx 捕获 `tools.register()` 拿到的工具定义，
 * 然后调用它们的 execute()。覆盖「工具实现是否正确」这一层。
 * 「工具是否真的交到模型手里」只能重启后用会话的 request/header 验（见 docs/subagent-provider-howto.md §5）。
 */
import fs from 'node:fs'
import { apply } from '../packages/capability-bridge/lib/index.js'

const OUT = 'D:/project_develop/dsh-brain/out/test-capability-bridge.txt'
const log = []
const say = (s) => { log.push(String(s)); console.log(String(s).split('\n')[0].slice(0, 120)) }

const captured = {}
const ctx = {
  inject(deps, cb) {
    if (deps.includes('tools')) {
      cb({ tools: { register(t) { captured[t?.name ?? '(无名)'] = t } } })
    }
  },
}

try {
  apply(ctx, { registryPath: '', maxRows: 50 })
} catch (e) {
  say('X apply 抛错：' + e.message)
}

say('捕获到的工具: ' + (Object.keys(captured).join(', ') || '(空)'))
const sample = captured.list_capabilities
say('工具对象的键: ' + (sample ? Object.keys(sample).join(', ') : '(无)'))

if (captured.list_capabilities) {
  const r = await captured.list_capabilities.execute({}, {})
  say('')
  say('===== list_capabilities（默认：只看 active）=====')
  say(r?.text ?? JSON.stringify(r))
  say('')
  const r2 = await captured.list_capabilities.execute({ all: true }, {})
  say('===== list_capabilities（all:true）=====')
  say(String(r2?.text ?? '').split('\n')[0])
  say('')
  try {
    const rendered = sample.output.render({}, r)
    say('render() 输出: ' + JSON.stringify(rendered).slice(0, 300))
  } catch (e) { say('render() 抛错: ' + e.message) }
}

if (captured.capability_report) {
  const r = await captured.capability_report.execute({ id: 'council-architect' }, {})
  say('')
  say('===== capability_report(council-architect) =====')
  say(String(r?.text ?? JSON.stringify(r)).slice(0, 1600))
  say('')
  const r2 = await captured.capability_report.execute({ id: 'no-such-cap' }, {})
  say('===== capability_report(不存在的 id) =====')
  say(String(r2?.text ?? JSON.stringify(r2)).slice(0, 400))
}

fs.writeFileSync(OUT, log.join('\n'), 'utf8')
console.log('\nok -> ' + OUT)
