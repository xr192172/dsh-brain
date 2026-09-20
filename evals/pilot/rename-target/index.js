// 入口：导入 + 调用（两处都要跟着改名）。
// `--selftest` 打印的**只有数据、不带任何符号名** ⇒ 所以"行为不变"这件事可以直接逐字比对。
import { computeHash, KEY_NAMESPACE, legacyAlias } from './math.js'
import { put, get, size } from './store.js'

export function describe(s) {
  return KEY_NAMESPACE + '/' + computeHash(s)
}

if (process.argv.includes('--selftest')) {
  const id = put('alpha', 'one')
  const rec = get(id)
  const lines = [
    `h=${computeHash('abc')}`,
    `d=${describe('abc')}`,
    `put/get=${rec ? rec.value + '@' + rec.ns : 'null'}`,
    `size=${size()}`,
    `legacy=${legacyAlias()}`,
  ]
  console.log(lines.join('\n'))
}
