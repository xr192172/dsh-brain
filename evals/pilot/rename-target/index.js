// 入口：导入 + 调用（两处都要跟着改名），并用 --selftest 打印**固定期望**以证明行为没变。
import { computeHash, KEY_NAMESPACE, legacyAlias } from './math.js'
import { put, get, size } from './store.js'

export function describe(s) {
  return KEY_NAMESPACE + '/' + computeHash(s)
}

if (process.argv.includes('--selftest')) {
  const id = put('alpha', 'one')
  const rec = get(id)
  const lines = [
    `computeHash("abc")=${computeHash('abc')}`,
    `describe("abc")=${describe('abc')}`,
    `put/get=${rec ? rec.value + '@' + rec.ns : 'null'}`,
    `size=${size()}`,
    `legacy=${legacyAlias()}`,
  ]
  console.log(lines.join('\n'))
}
