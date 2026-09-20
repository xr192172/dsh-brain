#!/usr/bin/env node
/**
 * test-patch-anchors.mjs —— 严格锚点应用器的**自证**（2026-09-15）
 *
 * 为什么要有：这次改动的全部价值就是"**上游一变就红**"。
 * 如果它在该红的时候还是绿的，那这次改动等于没做 —— 又一个"保险自己失效"。
 *
 * 所以照规矩证**两个方向**：
 *   ① 该红的红：锚点消失 ⇒ `missing` 命中 ⇒ 进程非 0 退出；
 *   ② 该绿的绿：全新文件能打上、已打过的不重复、文件不存在不算失败。
 *
 * 用法：node scripts/test-patch-anchors.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { applyAnchors } from './patch-anchors.mjs'
import { removeIfExists } from './lib-safe-fs.mjs'

const TMP = 'D:/project_develop/dsh-brain/out/patch-anchor-fixtures'
const REPO = 'D:/project_develop/dsh-brain'

let pass = 0
let fail = 0
const failures = []
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log('  FAIL ' + n + ' — ' + d) }
const eq = (n, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) ok(n)
  else bad(n, `期望 ${w}，实得 ${g}`)
}

const ANCHOR = 'const x = JSON.parse(readFileSync(f, "utf8"));'
const REPLACE = 'const x = readJsonManifest(f);'
const EDITS = [{ id: 'e1', anchor: ANCHOR, replace: REPLACE }]

function fx(name, content) {
  fs.mkdirSync(TMP, { recursive: true })
  const p = path.join(TMP, name)
  ffWrite(p, content)
  return p
}
function ffWrite(p, c) { fs.writeFileSync(p, c, 'utf8') }
const read = (p) => fs.readFileSync(p, 'utf8')

// ★ 删之前先判存在：宿主注入的 node-safe-delete-shim 在删不存在的路径时会 fail-closed 崩脚本（回执 B4）
removeIfExists(TMP)

console.log('== 三态判定 ==')

// pending：锚点在 ⇒ 应用
{
  const p = fx('pending.js', `// head\n${ANCHOR}\n// tail\n`)
  const r = applyAnchors(p, EDITS)
  eq('锚点在 ⇒ applied', r.applied, ['e1'])
  eq('锚点在 ⇒ missing 空', r.missing, [])
  if (read(p).includes(REPLACE) && !read(p).includes(ANCHOR)) ok('锚点在 ⇒ 确实写入替换')
  else bad('锚点在 ⇒ 确实写入替换', '文件内容不符')
}

// already：替换形态已在 ⇒ 幂等
{
  const p = fx('already.js', `// head\n${REPLACE}\n// tail\n`)
  const before = read(p)
  const r = applyAnchors(p, EDITS)
  eq('已最新 ⇒ already', r.already, ['e1'])
  eq('已最新 ⇒ 不重复写', read(p) === before, true)
}

// missing：两者都不在 ⇒ 必须报出
{
  const p = fx('missing.js', '// upstream refactored away\nconst x = whatever();\n')
  const r = applyAnchors(p, EDITS)
  eq('两者都不在 ⇒ missing', r.missing, ['e1'])
  eq('两者都不在 ⇒ 不谎报 applied', r.applied, [])
}

console.log('== all:true 的部分状态（最阴的一种）==')

// 1 处已替换 + 1 处仍是旧形态 ⇒ 必须继续替换，不能因"done 已存在"就跳过
{
  const p = fx('partial.js', `${REPLACE}\n${ANCHOR}\n`)
  const r = applyAnchors(p, [{ id: 'e2', all: true, anchor: ANCHOR, replace: REPLACE }])
  eq('部分已替换 ⇒ 仍 applied', r.applied, ['e2×1'])
  eq('部分已替换 ⇒ 最终两处皆新', (read(p).match(/readJsonManifest\(f\)/g) || []).length, 2)
  eq('部分已替换 ⇒ 旧形态归零', read(p).includes(ANCHOR), false)
}

// 全部已替换 ⇒ already
{
  const p = fx('all-done.js', `${REPLACE}\n${REPLACE}\n`)
  const r = applyAnchors(p, [{ id: 'e2', all: true, anchor: ANCHOR, replace: REPLACE }])
  eq('全部已替换 ⇒ already', r.already, ['e2'])
}

console.log('== reportAndExit 的退出码（该红必须真红）==')

// 用子进程验真实退出码 —— 进程内 exit 会杀掉测试自己
// ★ import 说明符必须走 pathToFileURL：ESM 不认裸的 `D:/...`（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const runner = path.join(TMP, 'runner.mjs')
const modUrl = pathToFileURL(path.join(REPO, 'scripts', 'patch-anchors.mjs')).href
ffWrite(
  runner,
  `import { reportAndExit, applyAnchors } from ${JSON.stringify(modUrl)}
const p = process.argv[2]
const r = applyAnchors(p, [{ id: 'e1', anchor: ${JSON.stringify(ANCHOR)}, replace: ${JSON.stringify(REPLACE)} }])
reportAndExit('fixture', [r])
`,
)

function runRunner(file, env = {}) {
  // ★ 用 spawnSync 而不是 execFileSync：后者在**成功**退出时拿不到 stderr，
  //   而"降级仅告警"这条正是走 console.warn(stderr) 且退出 0 —— 会被漏掉。
  const r = spawnSync(process.execPath, [runner, file], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

{
  const p = fx('exit-missing.js', 'const nope = 1;\n')
  const r = runRunner(p)
  eq('missing ⇒ 非 0 退出', r.code, 1)
  if (r.out.includes('锚点未命中')) ok('missing ⇒ 消息点明"未命中"')
  else bad('missing ⇒ 消息点明"未命中"', r.out.slice(0, 120))

  const r2 = runRunner(p, { DSH_PATCH_STRICT: '0' })
  eq('missing + DSH_PATCH_STRICT=0 ⇒ 退出 0（降级）', r2.code, 0)
  if (r2.out.includes('仅告警')) ok('降级时明确标注"仅告警"')
  else bad('降级时明确标注"仅告警"', r2.out.slice(0, 120))
}

{
  const p = fx('exit-already.js', `${REPLACE}\n`)
  const r = runRunner(p)
  eq('全已最新 ⇒ 退出 0', r.code, 0)
}

{
  // 文件不存在 = "该包未安装"，不该算失败
  const r = runRunner(path.join(TMP, 'no-such-file.js'))
  eq('文件不存在 ⇒ 退出 0（该包未安装，不算失败）', r.code, 0)
}

console.log('\n=========================================')
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) for (const f of failures) console.log('  · ' + f)
process.exit(fail ? 1 : 0)
