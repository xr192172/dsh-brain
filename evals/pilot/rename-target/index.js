// 入口：导入 + 调用（两处都要跟着改名）。
// `--selftest` 打印的**只有数据、不带任何符号名** ⇒ 所以"行为不变"这件事可以直接逐字比对。
import { digestOf, KEY_NAMESPACE, legacyAlias } from './math.js'
import { put, get, size } from './store.js'

export function describe(s) {
  return KEY_NAMESPACE + '/' + digestOf(s)
}

/** 自检输出（纯数据、与符号名无关）—— oracle 直接调它，**不起子进程**。
 *  ★ 为什么必须是函数：oracle 早先用 `spawnSync` 起子进程 + 管道 stdio，而那在 workspace-write 沙箱里
 *  会被 EPERM 拦 ⇒ 做题的 agent 自己跑不动 oracle，只能去申请提权、卡了 1033 秒（实测）。 */
export function selftestLines() {
  const id = put('alpha', 'one')
  const rec = get(id)
  return [
    `h=${digestOf('abc')}`,
    `d=${describe('abc')}`,
    `put/get=${rec ? rec.value + '@' + rec.ns : 'null'}`,
    `size=${size()}`,
    `legacy=${legacyAlias()}`,
  ]
}

if (process.argv.includes('--selftest')) console.log(selftestLines().join('\n'))
