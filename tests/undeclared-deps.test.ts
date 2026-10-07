/**
 * 未声明依赖（幻影依赖）—— 由**门**改写成**测试**（2026-10-07）。
 *
 * 为什么改：用户裁掉"手搓门"这条路线 —— *"我其实很讨厌这些门……我觉得有日志就够了"*、
 * *"拿那个套件来用，而不是自己去手搓门"*。这条判据本身是对的（它当天抓到两个真缺陷），
 * 但它的**存在形式**（scripts/ 下一个自己造退出码的门）不该继续扩散。
 * ⇒ 逻辑原封不动，搬进真框架（Vitest），用 `npx vitest run` 跑。
 *
 * 判据：`packages/<x>/{src,lib}` 里 import 了的裸模块说明符，必须出现在该包
 * `package.json` 的 dependencies / peerDependencies / optionalDependencies / devDependencies 之一。
 * ★ **根 package.json 的声明不算数** —— 那正是"幻影"的定义（借别人的声明过日子）。
 *
 * 当天实测的两个真缺陷（现在由本测试守住）：
 *   · `agent-io-bridge`  import '@deepseek-ai/dsh-llm'  而四类键一处都没声明 ⇒ 每代 boot `failed to import`
 *   · `key-pool-proxy`   import 'zod'                    同样一处都没声明
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scan } from '../scripts/check-undeclared-deps.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

/** 造一个临时夹具包 */
function fixture(pkgs: Record<string, { pkg: unknown; files: Record<string, string> }>) {
  const root = mkdtempSync(path.join(tmpdir(), 'undec-deps-'))
  for (const [name, { pkg, files }] of Object.entries(pkgs)) {
    const dir = path.join(root, 'packages', name)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    for (const [file, body] of Object.entries(files)) writeFileSync(path.join(dir, 'src', file), body)
  }
  return root
}

const missOf = (root: string) =>
  Object.fromEntries(scan(root).rows.map((r) => [r.name, r.misses.map(([s]) => s)]))

describe('未声明依赖', () => {
  it('本仓：每个包只 import 自己声明过的依赖', () => {
    const res = scan(REPO)
    // 阳性对照：先证明它**真的扫到了东西**，免得判据因为"没扫到任何文件"而恒真。
    expect(res.pkgs).toBeGreaterThan(5)
    expect(res.files).toBeGreaterThan(30)
    expect(res.violations).toEqual([])
  })

  it('植入违规 ⇒ 必须命中（阴性对照）', () => {
    const root = fixture({ planted: { pkg: { name: 'planted', dependencies: {} }, files: { 'a.ts': "import _ from 'lodash'\n" } } })
    expect(missOf(root).planted).toEqual(['lodash'])
  })

  it('声明的、内置的、相对路径的 ⇒ 不误报', () => {
    const root = fixture({
      clean: {
        pkg: { name: 'clean', dependencies: { zod: '^4' } },
        files: { 'a.ts': "import { z } from 'zod'\nimport fs from 'node:fs'\nimport { b } from './b'\nimport path from 'path'\n", 'b.ts': 'export const b = 1\n' },
      },
    })
    expect(missOf(root).clean).toEqual([])
  })

  it('回归：停用词表里的 from 不许被当成 import', () => {
    // 真实踩过的坑：skill-tree 的停用词表含 'at','by','from','as'，
    // 无锚定的正则会把那个 from 当 import，抽出 ", " 这种垃圾。
    const root = fixture({
      wordlist: { pkg: { name: 'wordlist' }, files: { 'a.ts': "const STOP = [\n  'at', 'by', 'from', 'as',\n  'to', 'of',\n]\nexport default STOP\n" } },
    })
    expect(missOf(root).wordlist).toEqual([])
  })

  it('回归：子路径归并到包名（zod/v4/core → zod）', () => {
    const root = fixture({ subpath: { pkg: { name: 'subpath' }, files: { 'a.ts': "import { x } from 'zod/v4/core'\n" } } })
    expect(missOf(root).subpath).toEqual(['zod'])
  })
})
