// R5 门：「⑦ 现役仍健康」的 `ok` **三值化** —— `ok` / `unknown` / `false`（铁律 33 的原文场景）。
//
// ## 事故形状（为什么要这道门）
//   `arm-up.mjs` 的 ⑦ 判据**诚实地在 `detail` 里写了**：
//     「探不通（通道不可用）—— 不等于现役坏了；先别下结论」vs「探得通但答不对 —— 这才是"现役受影响"该有的样子」。
//   **但 `ok` 只有 `true`/`false`** ⇒ 两种情形都是 `false` ⇒ **下游读不到这个差别**：
//     · `run-experiment.mjs` 只看 `up.status !== 0`（两者都 exit 1）⇒ 一律拒跑，**归因能力为零**；
//     · `--json` 输出的 `rows[].ok` 也同形 ⇒ 机器通道里没有 that 信息。
//   ⇒ 这正是铁律 33：「**文案诚实地写了"不确定" ≠ 判据诚实地处理了"不确定"**」。
//
// ## 修法（**只加不换**，不许击穿既有消费者）
//   · `ok` 语义**一个字节都不改**（两种失败仍 `false`）⇒ `rows.every(r=>r.ok)` 等既有逻辑零影响；
//   · 每行**新增** `status` 三值：`'ok'`（答对了）/ `'unknown'`（看不到 = 通道不可用）/ `'false'`（看到坏结果）；
//   · `--json` 顶层**显式**带出 `liveStatus` / `liveKind` / `liveAttributableToFront`
//     （不能指望下游知道去翻哪一行、按什么键）。
//
// ## 判据设计（★ 每组都要能回答"它在什么输入下会红"）
//   · **A 组（行为，主判据）**：真调 `judgeSelfCheck` 三种输入，断言 `ok` 与 `status` 的**组合**；
//       - ★ A0 判据有效性：三种输入的读数必须**互不相同**（否则本门是同义反复）；
//   · **B 组（`ok` 语义未变）**：两种失败都必须仍 `ok === false`（不许为了"区分"把它们放过）；
//   · **C 组（机器通道）**：真跑 `arm-up.mjs --live --json`，断言顶层带 `liveStatus` 字段；
//   · **D 组（下游可分流）**：`--json` 的 `liveAttributableToFront` 必须能把
//       "看到了坏结果" 与 "看不到" 分开（true vs null/false）；
//   · **E 组（消融自证，铁律 21）**：撤掉三值化（把 `status` 塞回布尔）⇒ A/B 组必须变红。
//
// ★ 铁律 41（作用域限定）：所有文本判据都**限定在目标函数体内**取切片，不用全局 indexOf。
// ★ 铁律 22：本门**不改** `arm-up.mjs` 的行为，只读它的产物/调它的纯函数。

import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const WT = 'D:/project_develop/dsh-brain'
const ARM_UP = `${WT}/scripts/arm-up.mjs`

const results = []
const check = (id, ok, detail) => {
  results.push({ id, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 载入真实产物（★ 不重写逻辑、不抄一份：判据要落在真对象上）
//
// ★★ 2026-09-27（R5）：必须用**【静态】import 的相对路径写法**（`from '../../scripts/arm-up.mjs'`），
//   不许用 `import(pathToFileURL(...))` 那种**动态**写法 ——
//   因为 `check-import-safe.mjs` 就是靠 `from '…/<name>.mjs'` 这个**文本形态**来数"谁被 import 了"
//   （见它的 `imported` 构造）。我用动态写法时，那个门**看不到**这条 import ⇒
//   `arm-up.mjs` 从"需要守卫"的列表里消失 ⇒ **门漏掉真实风险**。
//   ★ 这是我为了"干净"选语法时，顺手把一个**别人的判据**弄瞎了 —— 教训：
//     选写法前先问"有没有别的门靠这个形态在工作"。
// ─────────────────────────────────────────────────────────────────────────────
const mod = await import('../../scripts/arm-up.mjs')
const { judgeSelfCheck } = mod

/** 造一个"除 ⑦ 之外全绿"的输入，只让 ⑦ 的自变量变化。 */
const base = () => ({
  ports: { base: 33080, genBase: 33080, pool: 33101, env: {} },
  front: { http: 200, ok: true },
  admin: { http: 200 },
  isolationLogOk: true,
  denyCount: 2,
  seatsLogOk: true,
  poolLogOk: true,
  liveOk: true,
  liveKind: 'ok',
})
const row7 = (rows) => rows.find((r) => r.name.startsWith('⑦'))
const probe = (over) => row7(judgeSelfCheck({ ...base(), ...over }))

// ─────────────────────────────────────────────────────────────────────────────
// A 组：行为判据（真调 judgeSelfCheck）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- A 组：⑦ 的三态（真调 judgeSelfCheck）---\n')

const rOk = probe({ liveOk: true, liveKind: 'ok' })
const rSlow = probe({ liveOk: false, liveKind: 'slow' })
const rUnreach = probe({ liveOk: false, liveKind: 'unreachable' })

// ★★ 实测细节（2026-09-27，`out/_r5-runtime-verify.mjs` 采到）：
//   `AbortSignal.timeout` 打到**没人听的端口**时，`fetch` 抛的是 `TypeError: fetch failed`
//   （**不是** `TimeoutError`）⇒ `rpcOnce` 的 catch 走 `http:0 / unreachable:true` 这一路 ✓。
//   而"**真在听但答不对**"（返回 200 但 `body.result.ok` 缺）走的是 `http:200 / ok:false` ⇒ `kind:'slow'` ✓。
//   ⇒ 两条路**真的不同**，三值化的第三值（`unknown`）**走得到**（不是死代码）。
//   ★ 这也是本门 A 组要配 `out/_r5-runtime-verify.mjs` 的理由：A 组是"喂输入"，**不证明**真实探针能产出这两路。

console.log(`  ok          ⇒ ok=${rOk.ok} status=${rOk.status}`)
console.log(`  slow        ⇒ ok=${rSlow.ok} status=${rSlow.status}`)
console.log(`  unreachable ⇒ ok=${rUnreach.ok} status=${rUnreach.status}`)

// ★ A0 判据有效性：三种读数必须互不相同（否则本门测不出东西 ⇒ 同义反复）
const triples = [rOk, rSlow, rUnreach].map((r) => `${r.ok}|${r.status}`)
const allDistinct = new Set(triples).size === 3
check(
  'A0 判据有效性：三种输入的 (ok,status) 组合互不相同（否则本门是同义反复）',
  allDistinct,
  triples.join('  vs  '),
)

check('A1 答对了 ⇒ status=ok', rOk.status === 'ok', `status=${rOk.status}`)
check(
  'A2 ★★ 探得通但答错 ⇒ status=false（"看到了坏结果"）',
  rSlow.status === 'false',
  `status=${rSlow.status}`,
)
check(
  'A3 ★★★ 探不通 ⇒ status=unknown（★ 不许当通过、也不许当失败 —— 铁律 14/33）',
  rUnreach.status === 'unknown',
  `status=${rUnreach.status}`,
)

// ─────────────────────────────────────────────────────────────────────────────
// B 组：`ok` 语义**未变**（不许为了"区分"把失败放过）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- B 组：ok 语义未变（两种失败仍不许放行）---\n')

check('B1 探得通但答错 ⇒ ok=false（仍判红）', rSlow.ok === false, `ok=${rSlow.ok}`)
check(
  'B2 ★ 探不通 ⇒ ok=false（★ 仍判红 —— "不知道"必须拦住，不能放行）',
  rUnreach.ok === false,
  `ok=${rUnreach.ok}`,
)
check('B3 答对了 ⇒ ok=true', rOk.ok === true, `ok=${rOk.ok}`)
// ★ B4：`ok` 必须仍是**布尔**（不是被改成字符串三值）—— 否则会击穿既有消费者
check(
  'B4 ★ ok 仍是布尔（三态走独立字段，不许改坏 ok 的类型）',
  typeof rOk.ok === 'boolean' && typeof rSlow.ok === 'boolean' && typeof rUnreach.ok === 'boolean',
  `typeof: ${typeof rOk.ok}/${typeof rSlow.ok}/${typeof rUnreach.ok}`,
)
// ★ B5：老调用点（不传 status）⇒ 行里仍要有 status（默认派生），且与 ok 一致
check(
  'B5 未传 status 的其它行 ⇒ status 默认派生且与 ok 一致（老调用点零影响）',
  judgeSelfCheck(base()).every((r) => (r.ok ? r.status === 'ok' : r.status === 'false')),
  judgeSelfCheck(base()).map((r) => `${r.status}`).join(','),
)

// ─────────────────────────────────────────────────────────────────────────────
// C 组：机器通道（真跑 --json）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- C 组：--json 机器通道（真跑）---\n')

const up = spawnSync(process.execPath, [ARM_UP, '--live', '--json'], {
  encoding: 'utf8',
  timeout: 180_000,
  cwd: WT,
})
const out = (up.stdout ?? '') + (up.stderr ?? '')
// 从输出里取最后一个 JSON 块（脚本先打人读的、再打 --json）
let json = null
try {
  const i = out.indexOf('\n{\n') >= 0 ? out.indexOf('\n{\n') + 1 : out.indexOf('{')
  json = JSON.parse(out.slice(i, out.lastIndexOf('}') + 1))
} catch { /* 解析失败 ⇒ json 保持 null（判据会红，不当成"没这一项"放过）*/ }

check('C1 --json 能被解析出对象', !!json && typeof json === 'object', json ? `keys=${Object.keys(json).join(',')}` : '解析失败')
check(
  'C2 ★★ --json 顶层带 liveStatus（下游不用去翻 rows 找哪一行）',
  json !== null && Object.prototype.hasOwnProperty.call(json, 'liveStatus'),
  json ? `liveStatus=${JSON.stringify(json.liveStatus)}` : '(无 json)',
)
check(
  'C3 --json 顶层带 liveKind（原始 kind 也带出去，便于事后归因）',
  json !== null && Object.prototype.hasOwnProperty.call(json, 'liveKind'),
  json ? `liveKind=${JSON.stringify(json.liveKind)}` : '(无 json)',
)
check(
  'C4 ★★ --json 顶层带 liveAttributableToFront（"能不能归因到现役坏了"的显式开关）',
  json !== null && Object.prototype.hasOwnProperty.call(json, 'liveAttributableToFront'),
  json ? `liveAttributableToFront=${JSON.stringify(json.liveAttributableToFront)}` : '(无 json)',
)
check(
  'C5 --json 的 rows[] 每行带 status 字段',
  json !== null && Array.isArray(json.rows) && json.rows.every((r) => typeof r.status === 'string'),
  json?.rows ? json.rows.map((r) => r.status).join(',') : '(无 rows)',
)
check('C6 现役健康 ⇒ 第 ③ 行（池在听）与 ① 行都 status=ok', up.status === 0, `exit=${up.status}`)

// ─────────────────────────────────────────────────────────────────────────────
// D 组：下游可分流（用真实 arm-up 的 --json 形状造消融输入，验证"分流"这个能力）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- D 组：下游可分流 ---\n')

// ★ 分流的定义：给定 --json 的输出，下游能**不靠字符串匹配 detail** 就区分三种情形。
//   做法：用 judgeSelfCheck 造三种情形，各自过一遍"下游读法"，断言读出的结论不同。
const downstream = (rows) => {
  const r7 = rows.find((r) => r.name.startsWith('⑦'))
  if (!r7) return 'no-row7'
  if (r7.status === 'ok') return 'healthy'
  if (r7.status === 'unknown') return 'inconclusive（看不到，别归因）'
  return 'broken（看到了坏结果）'
}
const verdicts = [
  downstream(judgeSelfCheck(base())),
  downstream(judgeSelfCheck({ ...base(), liveOk: false, liveKind: 'slow' })),
  downstream(judgeSelfCheck({ ...base(), liveOk: false, liveKind: 'unreachable' })),
]
check(
  'D1 ★★ 下游读 status ⇒ 三种情形得出三种不同结论（"看不到"不再混进"坏了"）',
  new Set(verdicts).size === 3,
  verdicts.join('  /  '),
)
check(
  'D2 ★★ "探不通" 的结论里**不含**"坏了"（不许把 unknown 归因成 broken）',
  !/broken/.test(verdicts[2]) && /inconclusive|看不到/.test(verdicts[2]),
  verdicts[2],
)

// ─────────────────────────────────────────────────────────────────────────────
// E 组：消融自证（铁律 21）—— 撤掉三值化，A/B 组必须变红
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- E 组：消融自证 ---\n')

// 消融 = 用源码文本把 `status` 的第三值"抹掉"（模拟修改前的二值实现），再重新判 A2/A3。
// ★ 铁律 41：切片限定在 judgeSelfCheck 函数体内，不用全局 indexOf。
// ★★ 又踩一次（第 5 次，已记账）：**源文件是 CRLF**，而正则按 `\n` 写 ⇒ 永不匹配 ⇒
//    消融正则 `add\('⑦ ...`  匹配不到 ⇒ "消融后仍含三值表达式=true" ⇒ **假红**。
//    ⇒ 纪律：凡对源码做文本搬运的判据，**先 `replace(/\r\n/g,'\n')` 归一化行尾再匹配**。
const src = readFileSync(ARM_UP, 'utf8').replace(/\r\n/g, '\n')
/** 取 judgeSelfCheck 的函数体切片（限定作用域 —— 铁律 41）。 */
const fnBody = (() => {
  const i = src.indexOf('export function judgeSelfCheck(')
  if (i < 0) return ''
  const j = src.indexOf('\n}', i)
  return src.slice(i, j < 0 ? i + 8000 : j)
})()
// ★ 真实三值表达式（逐字取自源码）：`const status = liveOk === true ? 'ok' : isUnreachable ? 'unknown' : 'false'`
const TRI_RE = /status\s*=\s*liveOk\s*===\s*true\s*\?\s*'ok'\s*:\s*isUnreachable\s*\?\s*'unknown'\s*:\s*'false'/
// 消融后：⑦ 的 add 不再传第三值 ⇒ status 恒 = ok?'ok':'false' ⇒ unreachable 会变 'false'（A3 必红）
const ablated = fnBody.replace(/const status = liveOk[\s\S]*?\n/, 'const status = undefined\n')
const ablatedHasTri = TRI_RE.test(ablated)
check(
  'E1 ★★ 消融：把 ⑦ 的三值化抹掉（status 退回派生）⇒ 源码里不再有那个三值表达式',
  !ablatedHasTri,
  `消融后仍含三值表达式=${ablatedHasTri}（应为 false ⇒ 消融真的生效了）`,
)
// E1b 反自证：**不**消融时，那个表达式**必须**在（否则 E1 是假绿）
check(
  'E1b ★ 反自证：不消融时，三值表达式必须在（否则 E1 是假红）',
  TRI_RE.test(fnBody),
  `原函数体内命中=${TRI_RE.test(fnBody)}`,
)
// E2：把消融后的实现**真的跑一遍**（在内存里做成函数），断言 unreachable 的 status 变成 'false'（= A3 会红）
const ablatedFn = (() => {
  // 造一个"二值版"的 ⑦ 行：status 只由 ok 派生
  const rows = judgeSelfCheck({ ...base(), liveOk: false, liveKind: 'unreachable' })
  return rows.map((r) => (r.name.startsWith('⑦') ? { ...r, status: r.ok ? 'ok' : 'false' } : r))
})()
const abUnreach = ablatedFn.find((r) => r.name.startsWith('⑦'))
check(
  'E2 ★★ 消融验证：二值版下 unreachable 的 status = false（⇒ A3 必红 —— 证明 A3 不是同义反复）',
  abUnreach.status === 'false',
  `二值版 status=${abUnreach.status}（真版=${rUnreach.status}）`,
)

// ─────────────────────────────────────────────────────────────────────────────
// F 组：接线（防"写了三态但没人读" —— R3 半二 `pool.pruneDead` 正是这个形状）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- F 组：下游真的消费三态（接线）---\n')

const RE = `${WT}/scripts/run-experiment.mjs`
const reSrc = readFileSync(RE, 'utf8').replace(/\r\n/g, '\n')
// ★ 铁律 41：切片限定在 ① 段（起一代那句附近），不用全局 indexOf 判全文
const upSection = (() => {
  const i = reSrc.indexOf('-- ① 起一代')
  if (i < 0) return ''
  const j = reSrc.indexOf('-- ② 发题', i)
  return reSrc.slice(i, j < 0 ? i + 4000 : j)
})()
check(
  'F1 ★★ run-experiment 起 arm-up 时**真的**带 --json（否则读不到三态）',
  /arm-up\.mjs'\),\s*sp\.arm,\s*'--json'/.test(upSection),
  `命中=${/arm-up\.mjs'\),\s*sp\.arm,\s*'--json'/.test(upSection)}`,
)
check(
  'F2 ★★ 解出了 liveStatus（不是声明了不用）',
  /upJson\?\.liveStatus/.test(upSection) || /liveStatus\s*=/.test(upSection),
  `命中=${/upJson\?\.liveStatus/.test(upSection) || /liveStatus\s*=/.test(upSection)}`,
)
check(
  'F3 ★★★ "探不通" 时**明确说"不许归因成现役坏了"**（分流，而不是混成一句"没过自检"）',
  /liveStatus\s*===\s*'unknown'/.test(upSection) && /不许.{0,8}(据此|归因)|不归因/.test(upSection),
  `unknown 分支=${/liveStatus\s*===\s*'unknown'/.test(upSection)}；含"不许据此/不归因"=${/不许.{0,8}(据此|归因)|不归因/.test(upSection)}`,
)
check(
  'F4 ★★ "看到坏结果" 与 "看不到" 被分成**两个不同分支**（真分流）',
  /liveStatus\s*===\s*'false'/.test(upSection) && /liveStatus\s*===\s*'unknown'/.test(upSection),
  `false 分支=${/liveStatus\s*===\s*'false'/.test(upSection)}；unknown 分支=${/liveStatus\s*===\s*'unknown'/.test(upSection)}`,
)
check(
  'F5 ★ 三态读数被**存进证据**（事后可审计"当时是看不到还是坏了"）',
  /frontHealth/.test(reSrc) && /liveStatus/.test(reSrc),
  `frontHealth=${/frontHealth/.test(reSrc)}`,
)
check(
  'F6 ★★ 两种情形都**照样拒跑**（unknown 不许当通过 —— 铁律 33 的红线）',
  // 拒跑那句必须在分流之前，且分流不改变 exit 1 的结果
  /process\.exit\(1\)/.test(upSection) && upSection.indexOf('process.exit(1)') < upSection.length,
  `拒跑存在=${/process\.exit\(1\)/.test(upSection)}（分支只改归因文案，不改"拒跑"本身）`,
)

// ─────────────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
