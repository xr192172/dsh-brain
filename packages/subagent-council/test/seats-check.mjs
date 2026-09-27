// seats-check.mjs —— 判据：自进化两席（开发脑 / 审批脑）注册正确 + 向后兼容 + 不静默降级
//
// 依据：`docs/revised-architecture-2026-09-20.md` §7（三段流水线；§7.0 融合归开发脑；§:218 防串供）
//       与 `docs/training-ground-and-skill-sieve-2026-09-25.md` §11（用户 2026-09-25 口述）。
//
// 判据（8 条，全过才算数）：
//   ① 三个席位齐（council-architect/council-dev/council-review）+ provider 名 = 席位唯一名（逐字相同）
//   ② 开发脑人格：边界节（Key Distinctions）+ 产出契约（Output Contract，含**写死段数**）+ 自省机制（Red Flags / Rationalization Table）
//   ③ 审批脑人格：同上 + **可执行的独立性条款**（由发起方派发、输入不许含作者推理）+ **三态裁决**（UNKNOWN / 不许给总评）
//   ④ `apply({seats:['dev','review']})` ⇒ 注册 **2** 个（**旧短名经兼容垫片解析成唯一名**）
//   ⑤ ★ **向后兼容**：`apply({})` ⇒ **只注册 1 个**，名字 = council-architect（与改动前逐字一致）
//   ⑥ ★ 未知席位 **跳过**（不静默降级成 architect）：`apply({seats:['dev','nope']})` ⇒ 只 1 个（council-dev）
//   ⑦ 两席都挂上时**有防串供可见性**（打印身份；两席都继承时告警"它们就同源"）
//   ⑧ ★★ 消融：把"未知席位跳过"改成"降级成 architect" ⇒ 判据⑥ **必须变红**
//
// ★★★ 2026-09-27 迁移注记：②③ 的**关键词换成了新格式的章节名**，这是**显式裁决**不是放宽 ——
//   旧 `## 职责边界` ⇒ 新 `## Key Distinctions`；旧"六段/五段要素" ⇒ 新 `## Output Contract`；
//   旧"我可能错在哪" ⇒ 新 `## Rationalization Table` + `## Red Flags`。语义意图逐条保留，且**新增**了
//   两条更硬的（写死段数 / 三态裁决）。★ 逐条映射理由见 ② 前的注释块。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const LIB = pathToFileURL('D:/project_develop/dsh-brain/packages/subagent-council/lib/index.js').href
const mod = await import(LIB)
const { apply, SEAT_PERSONAS, SEAT_PROVIDER_NAMES, EVOLUTION_SEATS } = mod

const results = []
const check = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

/** 假 ctx：只捕获 registerProvider 的调用；同时把 console.log 拦下来供断言。 */
function runApply(config) {
  const captured = []
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.map(String).join(' '))
  try {
    apply({ subagents: { registerProvider: (p) => captured.push(p) } }, config)
  } finally {
    console.log = orig
  }
  return { names: captured.map((p) => p?.name), logs, providers: captured }
}

// ①
// ★★★ 2026-09-27 迁移：`SEAT_PERSONAS` 的键从【短名】变成【席位唯一名】（= provider 名）。
//   ⇒ 判据改成：唯一名集合恰是三席，且 provider 名与键**逐字相同**（迁移后是恒等关系）。
const seats = Object.keys(SEAT_PERSONAS).sort()
const names = Object.values(SEAT_PROVIDER_NAMES)
const EXP_SEATS = ['council-architect', 'council-dev', 'council-review']
check('① 三席齐 + provider 名互不相同（= 席位唯一名）',
  seats.join(',') === EXP_SEATS.join(',') &&
    new Set(names).size === names.length &&
    seats.every((s, i) => names[i] === s),
  `seats=[${seats.join(', ')}] providers=[${names.join(', ')}]（期望二者逐字相同）`)

// ②
// ★★★ 2026-09-27 迁移（显式裁决，理由逐条写在下面）：
//   **不是"判据过时所以放宽"** —— 旧的 `职责边界` 是**旧 persona 的章节名**，迁移后已不存在。
//   但旧判据的【语义意图】仍在，只是换了章节名：
//     · 旧 `## 职责边界（严格遵守）`  ⇒  新 `## Key Distinctions`（正文仍是"你不做 X / 你的边界是 Y"）
//     · 旧"六段/五段产出要素"        ⇒  新 `## Output Contract`（逐项编号的产出契约）
//     · 旧"我可能错在哪"             ⇒  新 `## Rationalization Table` + `## Red Flags`（借口对照 + 红旗清单）
//   ⇒ **判据改成锚新章节名 + 锚那些【跨格式都该有的关键约束】**，**不放宽**：
//     ① 边界节必须在（`Key Distinctions`）；
//     ② 产出契约必须在（`Output Contract`）且必须**写死段数**（用统一的量词正则，容忍 段/项/条/点）；
//     ③ 自省机制必须在（`Red Flags` 或 `Rationalization Table` 至少其一）。
//   ★ 为什么这些词进判据是**语义**而不是**同义反复**：它们都是**只有真写了才算**的契约点 ——
//     缺 `Output Contract` ⇒ 下游拿不到产出形状（superpowers 实测：没写形状 ⇒ agent 按摘要自由发挥）。
const dev = SEAT_PERSONAS['council-dev'] ?? ''
const devSections = ['## Key Distinctions', '## Output Contract', '## Red Flags', '## Rationalization Table']
const devMiss = devSections.filter((k) => !dev.includes(k))
// ★ 段数声明：量词不统一（architect 写"六段"、dev 写"五项"、review 写"四段"）⇒ 兼容 段/项/条/点。
const devHasFixedCount = /固定\s*(?:[一二三四五六七八九十\d]+)\s*(?:段|项|条|点)/.test(dev)
check('② 开发脑人格：边界节 + 产出契约（含写死段数）+ 自省机制',
  devMiss.length === 0 && devHasFixedCount,
  devMiss.length ? `缺章节：${devMiss.join('、')}` : (devHasFixedCount ? `${dev.split('\n').length} 行；章节齐 + 段数已写死` : '★ 缺"固定N段/项"的产出段数声明（下游拿不到产出形状）'))

// ③
const rev = SEAT_PERSONAS['council-review'] ?? ''
const revSections = ['## Key Distinctions', '## Output Contract', '## Red Flags', '## Rationalization Table']
const revMiss = revSections.filter((k) => !rev.includes(k))
const revHasFixedCount = /固定\s*(?:[一二三四五六七八九十\d]+)\s*(?:段|项|条|点)/.test(rev)
// ★ 独立性那一条必须**可执行**：迁移后它有了自己的章节，且要求【由发起方派发 + 输入不许含作者推理】。
//   ★ 保留旧的"防串供"语义检查（换成新措辞）：必须写明审者不是作者派生的。
const hasIndependence =
  rev.includes('独立性的构造条件') && rev.includes('由发起方') && rev.includes('不许有作者的推理过程')
// ★ 迁移后新增：三态裁决（PASS/UNKNOWN/FAIL）必须写进产出契约 —— 这是 review 席最不可省的一条
//   （铁律 33：`unknown` 不许当"通过"也不许当"失败"）。
const hasThreeState = rev.includes('UNKNOWN') && rev.includes('不许给总评')
check('③ 审批脑人格：边界节 + 产出契约 + **可执行的独立性条款** + 三态裁决',
  revMiss.length === 0 && revHasFixedCount && hasIndependence && hasThreeState,
  revMiss.length ? `缺章节：${revMiss.join('、')}`
    : (!revHasFixedCount ? '★ 缺"固定N段/项"的产出段数声明'
      : (!hasIndependence ? '★ 独立性条款不可执行（缺：独立性的构造条件/由发起方/不许有作者的推理过程 之一）'
        : (!hasThreeState ? '★ 三态裁决缺失（需 UNKNOWN + 不许给总评）' : `${rev.split('\n').length} 行；四要素齐`))))

// ④
// ★ 迁移后 provider 名 = 唯一名（原 `evo-dev`/`evo-review`）。★ 调用方**仍传旧短名** `['dev','review']`
//   —— 本判据同时在验【兼容垫片真的在工作】（旧短名经 `resolveSeat()` 解析成唯一名）。
const both = runApply({ seats: ['dev', 'review'] })
check('④ 一次挂两席 ⇒ 注册 council-dev + council-review（且旧短名经垫片解析成功）',
  both.names.length === 2 && both.names.includes('council-dev') && both.names.includes('council-review'),
  `names=[${both.names.join(', ')}]`)

// ⑤ ★ 向后兼容
const legacy = runApply({})
check('⑤ 向后兼容：空配置 ⇒ 只注册 council-architect',
  legacy.names.length === 1 && legacy.names[0] === 'council-architect',
  `names=[${legacy.names.join(', ')}]`)

// ⑥ ★ 不静默降级
// ★ 迁移后：`dev`（旧短名）经垫片 → `council-dev`；`nope` 是**未知席位** ⇒ 必须被跳过（只 1 个）。
const unknown = runApply({ seats: ['dev', 'nope'] })
check('⑥ 未知席位 ⇒ 跳过（不降级成 architect）',
  unknown.names.length === 1 && unknown.names[0] === 'council-dev',
  `names=[${unknown.names.join(', ')}]（nope 必须被跳过；dev 必须经垫片解析成 council-dev）`)

// ⑦ 防串供可见性
const warnProbe = runApply({ seats: ['dev', 'review'] })
const visible = warnProbe.logs.some((l) => l.includes('自进化两席已就位') && l.includes('出发点'))
const warnedInherit = warnProbe.logs.some((l) => l.includes('跨会话') && l.includes('跨模型'))
check('⑦ 独立性可见：打印身份 + 按【出发点不同】口径说明档位', visible && warnedInherit,
  `可见=${visible} 档位说明=${warnedInherit}`)

// ⑧ ★★ 消融自证
// ★★★ 2026-09-27 迁移（**第二次修正**，第一次锚错了决策点）：
//   **第一版锚点**是 `resolvedSeats.push(def);` + 把 `def` 换成 `def ?? SEAT_BY_NAME[...]`。
//   ★ **它不可能变红** —— 因为 `if (!def) { …; continue; }` 在它**之前**就短路了，
//     消融后的 `??` 分支**永远走不到**（`ablNames` 实测只有 1 个 = 铁证）。
//   ⇒ **锚点必须落在【真正的决策点】：那个 `continue`**。把它换成"降级成 architect 也 push"，
//     判据⑥ 才会因为 `nope` 多注册一席而变红。
//   ★ 教训（铁律 21 同族）：**消融锚点选错 = 消融没跑 = 保险失效**，
//     而且它会**静默地**报"没变红"，很容易被当成"实现没接线"而放过。
const SRC = 'D:/project_develop/dsh-brain/packages/subagent-council/src/index.ts'
const ANCHOR = '\t\t\tcontinue;\n\t\t}\n\t\tresolvedSeats.push(def);'
const ABLATED =
  '\t\t\t// ABLATED: 原本是 continue（跳过未知席位），现在降级成 architect\n' +
  '\t\t\tresolvedSeats.push(SEAT_BY_NAME["council-architect"]);\n' +
  '\t\t\tcontinue;\n\t\t}\n\t\tresolvedSeats.push(def);'
const src = fs.readFileSync(SRC, 'utf8')
let ablOk = false
if (!src.includes(ANCHOR)) {
  // ★★ 锚点失配 = 消融**没跑** ⇒ 不能当"通过"（那是假绿：消融自证是整个测试的保险，保险失效必须报）。
  console.log(`  FAIL  消融锚点失配 —— 实现改了但测试没跟上（锚点找不到：${JSON.stringify(ANCHOR)}）`)
} else {
  const bak = src
  const tsc = 'D:/project_develop/dsh-brain/node_modules/typescript/bin/tsc'
  const cfg = 'D:/project_develop/dsh-brain/packages/subagent-council/tsconfig.json'
  const ablatedSrc = src.replace(ANCHOR, ABLATED)
  // ★ 先自证"替换真的落地了"（上次 sed 静默空转的教训）
  if (!ablatedSrc.includes('ABLATED')) {
    console.log('  FAIL  消融替换未落地（含 ABLATED 标记的源码没写出来）⇒ 消融不成立')
  } else {
    fs.writeFileSync(SRC, ablatedSrc, 'utf8')
    const b = spawnSync(process.execPath, [tsc, '-p', cfg], { encoding: 'utf8', timeout: 120000 })
    let ablNames = null
    if (b.status === 0) {
      const m2 = await import(LIB + '?abl=' + Date.now())
      const cap = []
      const o = console.log; console.log = () => {}
      try { m2.apply({ subagents: { registerProvider: (p) => cap.push(p.name) } }, { seats: ['dev', 'nope'] }) } catch {}
      console.log = o
      ablNames = cap
    }
    fs.writeFileSync(SRC, bak, 'utf8')
    spawnSync(process.execPath, [tsc, '-p', cfg], { encoding: 'utf8', timeout: 120000 }) // 还原并重建
    // 消融后"跳过"失效 ⇒ `nope` 会降级成 architect ⇒ 注册 2 个（council-dev + council-architect）
    ablOk = Array.isArray(ablNames) && ablNames.length === 2 && ablNames.includes('council-architect')
    console.log(`  ${ablOk ? 'ok  ' : 'FAIL'} 消融：把"未知席位跳过(continue)"改成"降级成 architect" ⇒ 判据⑥ 变红 ${ablOk ? '✓' : `（没变红 ⇒ 那条没接线；ablNames=${JSON.stringify(ablNames)}）`}`)
  }
}

const pass = results.filter((r) => r.ok).length
const total = pass === results.length && ablOk
console.log(`\n结果：判据 ${pass}/${results.length}，消融 ${ablOk ? '通过' : '未通过'} ⇒ ${total ? 'PASS' : 'FAIL'}`)
fs.writeFileSync('D:/project_develop/dsh-brain/out/_seats-check.json', JSON.stringify(results, null, 2), 'utf8')
process.exit(total ? 0 : 1)
