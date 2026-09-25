// test-arm-isolation-guard.mjs —— 判据：臂间隔离层的**路径判定**（`isDenied`）真的拦得住
//
// ★ 起因（实测事故，2026-09-25）：臂 A 的 agent 用 `pwsh` 成功列出了**臂 B** 的
//   `C:\_abB-experiment-root\store`，并在回复里如实写了"成功读到了目录内容"。
//   根因：`extractPathsFromCmd` 的正则不排除引号 ⇒ 从 `'C:\...\store'` 提取出的路径**带结尾单引号**
//   ⇒ `pathDenyCheck` 只做 `===` 或 `startsWith(root + '/')` ⇒ 两个都不匹配 ⇒ **放行**。
//   ⇒ 结论：**给路径加个引号就能绕过隔离层**（这不是理论，是实测）。
//
// 判据（9 条 + 消融）：
//   ① ★ 实测绕过的那条**原样**（单引号）⇒ 必拒   ② 双引号 ⇒ 必拒   ③ 无引号 ⇒ 必拒
//   ④ 结构化 path 字段（子路径）⇒ 必拒           ⑤ 另一种 shell 写法（type …）⇒ 必拒（第二通道）
//   ⑥ ★ 阴性对照：**自己臂内**的路径 ⇒ **不许拒**   ⑦ ★ 阴性对照：无关路径 ⇒ **不许拒**
//   ⑧ 空 denyRoots ⇒ 一律不拒（显式 no-op 语义）  ⑨ 大小写/斜杠混写 ⇒ 仍必拒
//   ⑩ ★ 消融：把正则改回**含引号**的旧版 ⇒ 判据① 变红
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const WT = 'D:/project_develop/dsh-brain'
const LIB = pathToFileURL(path.join(WT, 'packages/arm-isolation/lib/index.js')).href
const SRC = path.join(WT, 'packages/arm-isolation/src/index.ts')
const TSC = path.join(WT, 'node_modules/typescript/bin/tsc')
const CFG = path.join(WT, 'packages/arm-isolation/tsconfig.json')

const DENY = ['C:\\_abB-experiment-root\\wt', 'C:\\_abB-experiment-root\\store']
const bad = 'C:\\_abB-experiment-root\\store'
const mine = 'D:/project_develop/_abA/wt/x.txt'
const other = 'D:/project_develop/dsh-brain/package.json'

const mod = await import(LIB)
const { isDenied } = mod
const results = []
const check = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

// ① 实测绕过的那条（逐字）
const cmd1 = `Get-ChildItem -Path '${bad}' -ErrorAction Stop | Format-Table Name, Mode, Length -AutoSize`
check('① ★ 实测绕过的那条原样（单引号路径）⇒ 必拒', isDenied({ command: cmd1 }, DENY) === true,
  isDenied({ command: cmd1 }, DENY) === true ? '拒了' : '★ 放行 ⇒ 洞还在')

// ② 双引号
check('② 双引号路径 ⇒ 必拒', isDenied({ command: `dir "${bad}"` }, DENY) === true, '')
// ③ 无引号
check('③ 无引号路径 ⇒ 必拒', isDenied({ command: `dir ${bad}` }, DENY) === true, '')
// ④ 结构化 path（子路径）
check('④ 结构化 path 字段 + 子路径 ⇒ 必拒', isDenied({ path: 'C:\\_abB-experiment-root\\wt\\a\\b.txt' }, DENY) === true, '')
check('④b 结构化 path 命中根本身 ⇒ 必拒', isDenied({ file_path: 'C:/_abB-experiment-root/store' }, DENY) === true, '')
// ⑤ 第二通道（另一种写法，不靠 Get-ChildItem）
check('⑤ 另一写法（type …\\knowledge_base.json）⇒ 必拒',
  isDenied({ command: `type '${bad}\\knowledge_base.json'` }, DENY) === true, '')

// ⑥⑦ 阴性对照（★ 证明"不是一律拒"）
check('⑥ ★ 阴性对照：自己臂内的路径 ⇒ 不许拒', isDenied({ command: `ls ${mine}` }, DENY) === false, '')
check('⑦ ★ 阴性对照：无关路径 ⇒ 不许拒', isDenied({ command: `cat ${other}` }, DENY) === false, '')
// ⑧ 空 deny ⇒ 显式 no-op
check('⑧ 空 denyRoots ⇒ 一律不拒（显式 no-op）', isDenied({ command: `dir ${bad}` }, []) === false, '')
// ⑨ 大小写/斜杠混写
check('⑨ 大小写 + 正斜杠混写 ⇒ 仍必拒', isDenied({ command: "dir 'c:/_ABB-experiment-root/STORE'" }, DENY) === true, '')

// ⑩ ★ 消融自证 —— **不改编源码**（避免转义踩雷，也更安全），改成**就地复现旧逻辑**：
//    旧正则不排除引号 ⇒ 提取出的路径**带结尾单引号** ⇒ 旧的比较必然判不中 ⇒ 放行。
//    ★ 把"旧逻辑提取到的字符串"**打出来**，方便你肉眼核对这条路确实成立。
console.log('\n=== 消融自证 ===')
const oldExtract = (cmd) => [...cmd.matchAll(/[A-Za-z]:[/\\][^\s;|&<>"]+/g)].map((m) => m[0])
const oldRaw = oldExtract(cmd1)
const oldNorm = oldRaw.map((p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase())
const oldWouldDeny = oldNorm.some((np) => np === 'c:/_abb-experiment-root/store' || np.startsWith('c:/_abb-experiment-root/store/'))
console.log(`  旧正则提取到 = ${JSON.stringify(oldRaw)}`)
console.log(`  归一化后     = ${JSON.stringify(oldNorm)}（★ 注意结尾那个单引号）`)
const ablOk = oldWouldDeny === false
console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 旧正则对同一条命令**判不中**（放行）⇒ 判据① 确实在测这个修 ${ablOk ? '✓' : '（没复现出旧行为 ⇒ 我的旧逻辑复现写错了）'}`)

const pass = results.filter((r) => r.ok).length
const total = pass === results.length && ablOk
console.log(`\n结果：判据 ${pass}/${results.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
process.exit(total ? 0 : 1)
