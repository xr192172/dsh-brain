/**
 * ★ 两方向自证之「该红的必须红」：逐个把 lib/ 里补好的四处**还原成 Go 的坏写法**，
 *   再跑 `skill-tree.test.mjs` ⇒ 对应用例**必须变红**。证明每处补丁都是承重的，
 *   不是「改了也白改」。另一方向（该绿的不绿）就是 `node --test test/*.test.mjs` 全绿。
 *
 * 跑法（仓库根）：`node packages/skill-tree/test/ablation-check.mjs`
 *
 * ★ 只碰 gitignore 的 `lib/`（编译产物），**不碰 src/**；每轮结束用 tsc 重建还原。
 *   （判据是测试，绝不为消红去改被检对象 —— 这里改的正是「故意撤回的补丁」本身。）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIB = fileURLToPath(new URL('../lib/skill-tree.js', import.meta.url))
const TSC = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url))
const TSCFG = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
const TEST = fileURLToPath(new URL('./skill-tree.test.mjs', import.meta.url))

const ablations = [
  {
    // 还原成 Go 的「先遍历到谁谁赢」：去掉平票的字典序比较
    name: 'D1 Tier-2 平票',
    from: 'score === bestScore && id < bestID',
    to: 'false',
    grep: 'D1：Tier-2',
  },
  {
    name: 'D1 Tier-3 多命中',
    from: "bestID === '' || id < bestID",
    to: "bestID === ''",
    grep: 'D1：Tier-3',
  },
  {
    name: 'D2 findSimilar 同分',
    from: 'return a.node.ID < b.node.ID ? -1 : a.node.ID > b.node.ID ? 1 : 0;',
    to: 'return 0;',
    grep: 'D2：FindSimilar',
  },
  {
    name: 'D3a 自环',
    from: 'if (absorbedID === intoID)',
    to: 'if (false)',
    grep: 'D3a',
  },
  {
    // 还原成 Go 的「不检查键指向谁，直接删」
    name: 'D3b 误删 into 索引',
    from: 'if (this.prinIndex.get(absorbedKey) === absorbedID)',
    to: 'if (true)',
    grep: 'D3b',
  },
]

const orig = readFileSync(LIB, 'utf8')
let allRed = true
for (const a of ablations) {
  if (!orig.includes(a.from)) {
    console.log(`?? ${a.name}：找不到锚点`)
    allRed = false
    continue
  }
  writeFileSync(LIB, orig.split(a.from).join(a.to))
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', TEST], { encoding: 'utf8' })
  } catch (e) {
    out = e.stdout ?? ''
  }
  const line = out.split('\n').find((l) => l.startsWith('not ok') && l.includes(a.grep))
  const red = Boolean(line)
  console.log(`${red ? '红 ✔ ' : '没红 ✘'}  ${a.name}${line ? '  → ' + line.slice(0, 64) : ''}`)
  if (!red) allRed = false
  execFileSync(process.execPath, [TSC, '-p', TSCFG]) // 还原 lib/
}
console.log('\n' + (allRed ? '全部 5 处消融均「补之前必红」✔' : '有消融没红 ✘'))
