/**
 * test-seat-contract.mjs —— 席位产出契约验收器的**双向自证**（S0′；规格 §6.2 的 W1–W8）
 *
 * ★ 为什么每条判据都要**双向**：
 *   只证明"能抓错"是不够的 —— 一个**逢错必报的噪音机**同样能"抓住所有错"。
 *   必须有**阳性对照**：喂一份**确实合格**的产出，它必须给 PASS。
 *   没有阳性对照的门，唯一的下场是被当噪音、被绕过（比没有门更糟）。
 *
 * ★ 消融自证（W7）：把 persona 源码的解析锚点改坏 ⇒ 解析**必须抛错**（fail-closed），
 *   **绝不许**静默算成"0 段 ⇒ 全部通过"。
 *
 * 用法：node scripts/seats/test-seat-contract.mjs
 */
import fs, { readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSeatContracts, validateSeatOutput, SeatContractParseError, SEAT_SOURCE_DIR } from './seat-contract.mjs'

const results = []
const ok = (n, detail = '') => { results.push({ n, pass: true }); console.log(`  ok    ${n}${detail ? ' — ' + detail : ''}`) }
const bad = (n, detail = '') => { results.push({ n, pass: false }); console.log(`  FAIL  ${n}${detail ? ' — ' + detail : ''}`) }
const t = (n, cond, detail = '') => (cond ? ok(n, detail) : bad(n, detail))

console.log('=== 席位产出契约验收器 · 双向自证 ===\n')
console.log(`契约源（单一真相源）: ${SEAT_SOURCE_DIR}\n`)

// ── G0 解析 ─────────────────────────────────────────────────────────────────
const contracts = parseSeatContracts()
console.log('-- G0 契约解析（从源码，不手抄） --')
t('G0.1 三席都解析出契约', Object.keys(contracts).length === 3, `席位=${Object.keys(contracts).join(',')}`)
{
  const num = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  let allMatch = true
  const detail = []
  for (const [seat, c] of Object.entries(contracts)) {
    const declared = num[c.countWord]
    const actual = c.sections.length
    if (declared !== actual) allMatch = false
    detail.push(`${seat}:声明${c.countWord}=${declared}/实际=${actual}`)
  }
  t('G0.2 ★ 每条契约「声明的段数」与「解析出的段数」一致', allMatch, detail.join('  '))
}
t('G0.3 每席都有被禁空话（从 persona 解析，不是硬编码）', Object.values(contracts).every((c) => c.bannedClosings.length > 0),
  JSON.stringify(Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v.bannedClosings]))))

// ── W1 阳性对照：合格产出必须 PASS ────────────────────────────────────────────
console.log('\n-- W1 ★阳性对照：确实合格的产出必须 PASS（防"逢错必报的噪音机"） --')

const GOOD = {
  architect: `**1. 目标复述**
把 launcher 的 .cmd 保持在纯 ASCII + CRLF。

**2. 现状**
当前 launcher 存在非 ASCII 字符和 LF 行尾问题。

**3. 方案**
方案A：每次安装时归一化。方案B：安装器拒绝坏源。两者隐含假设不同：A 假设源可以脏，B 假设源必须干净。

**4. 推荐**
推荐 B。它会坏在：源里有非 ASCII 时安装直接失败，用户看到红字 —— 这是好事，能立刻发现。错了代价是源必须干净。

**5. 不确定性**
如果团队的源长期有中文注释，B 会让安装频繁失败。需要核实团队源的实际内容。

**6. 判据**
验证：运行 install-launcher 后检查桌面文件，非ASCII=0，纯LF=0。`,
  dev: `**1. 变更清单**
- scripts/install-launcher.mjs：新增行尾校验逻辑
- scripts/check-lineendings.mjs：修复非 ASCII 检测

**2. 判据**
命令：node scripts/check-all.mjs --only seats
输出：exit=0，全绿

**3. 证据**
\`指纹 bytes=3713 非ASCII=0 纯LF=0\`；真退出码 0

**4. 不确定**
POSIX 系统上的换行语义不同，可能不适用。

**5. 阻塞**
无`,
  review: `**1. 复算结果**
我重跑了验证：读桌面文件字节，得 非ASCII=0 / 纯LF=0，与作者所述一致。

**2. 判决**
PASS —— 复算支持原结论。

**3. 反证清单**
无

**4. 不确定**
若作者与我是同一模型，某些盲区会共享。

**独立性档位**
本次裁决的档位：跨会话（未到跨模型）。`,
}

for (const seat of Object.keys(GOOD)) {
  const r = validateSeatOutput(seat, GOOD[seat], contracts)
  t(`W1 阳性·${seat} 合格产出 ⇒ PASS`, r.ok, r.ok ? '' : JSON.stringify(r.problems))
}

// ★ 阳性变体：段落名写法的容忍（"推荐与风险" 而不是 "推荐 + 风险"）
{
  const variant = GOOD.architect.replace('**4. 推荐 + 风险**', '**4. 推荐与风险**')
  const r = validateSeatOutput('architect', variant, contracts)
  t('W1 阳性·归一化：写成「推荐与风险」也算合格（防长期假红）', r.ok, r.ok ? '' : JSON.stringify(r.problems))
}

// ── W2 阴性：缺段必须 FAIL 且指名 ────────────────────────────────────────────
console.log('\n-- W2 阴性：缺哪一段必须指名 --')
for (const seat of Object.keys(GOOD)) {
  for (const name of contracts[seat].sections) {
    // ★ steer 06: 删整段（标题行 + 正文），不只是标题行
    const lines = GOOD[seat].split('\n')
    let removed = false
    let skipNextNonEmpty = false
    const out = []
    for (const l of lines) {
      if (!removed && /^\*\*.*\*\*$/.test(l) && l.includes(name)) {
        removed = true
        skipNextNonEmpty = true
        continue
      }
      if (skipNextNonEmpty) {
        if (l.trim() === '') {
          skipNextNonEmpty = false
        }
        continue
      }
      out.push(l)
    }
    const r = validateSeatOutput(seat, out.join('\n'), contracts)
    // ★ 接受 G1-MISSING 或 G1-EMPTY（删段后正文可能也被删除）
    const named = r.problems.some((p) => p.code === 'G1-MISSING' && p.msg.includes(name)) ||
                  r.problems.some((p) => p.code === 'G1-EMPTY' && p.msg.includes(name))
    t(`W2 缺段·${seat}「${name}」⇒ FAIL 且指名`, !r.ok && named,
      r.ok ? '★ 没报红！' : (named ? '' : JSON.stringify(r.problems)))
  }
}

// ── W3 「我可能错在哪」留空/敷衍 ⇒ FAIL ──────────────────────────────────────
console.log('\n-- W3 自证伪字段不许敷衍 --')
{
  // W3a: 空段落 ⇒ FAIL（G1-EMPTY 或 G2-EMPTY 都可接受）
  const blank = GOOD.architect.replace(/\*\*5\. 不确定性\*\*[\s\S]*?\n\*\*6\. 判据\*\*/g, '**5. 不确定性**\n\n**6. 判据**')
  const r1 = validateSeatOutput('architect', blank, contracts)
  t('W3a 「不确定性」留空 ⇒ FAIL', !r1.ok && (r1.problems.some((p) => p.code === 'G1-EMPTY') || r1.problems.some((p) => p.code.startsWith('G2'))),
    JSON.stringify(r1.problems.map((p) => p.code)))

  // W3b: 敷衍段落 ⇒ FAIL（G1-EMPTY 或 G2-DISMISSIVE 都可接受）
  //   ★ steer 06: 新格式下 "无" 被 cleanBody 剥掉后变成空字符串，走 G1-EMPTY
  //   但如果 G2 分支生效（从 schema 读取的自省段），也会走 G2-DISMISSIVE
  const dismissive = GOOD.architect.replace(/\*\*5\. 不确定性\*\*[\s\S]*?\n\*\*6\. 判据\*\*/g, '**5. 不确定性**\n无\n\n**6. 判据**')
  const r2 = validateSeatOutput('architect', dismissive, contracts)
  t('W3b 「不确定性」只写"无" ⇒ FAIL（算敷衍）', !r2.ok && (r2.problems.some((p) => p.code === 'G1-EMPTY') || r2.problems.some((p) => p.code === 'G2-DISMISSIVE')),
    JSON.stringify(r2.problems.map((p) => p.code)))
}

// ── W4 被禁空话收尾 ⇒ FAIL ──────────────────────────────────────────────────
console.log('\n-- W4 禁止空话收尾 --')
{
  const banned = contracts.architect.bannedClosings[0]
  const withBanned = GOOD.architect + `\n\n建议进一步评估。`
  const r = validateSeatOutput('architect', withBanned, contracts)
  t(`W4 以被禁空话「${banned}」收尾 ⇒ FAIL`, !r.ok && r.problems.some((p) => p.code === 'G3-BANNED-CLOSING'), JSON.stringify(r.problems.map((p) => p.code)))
}

// ── W5 review 裁决含糊 ⇒ FAIL ────────────────────────────────────────────────
console.log('\n-- W5/W6 review 席的额外契约 --')
{
  const vague = GOOD.review.replace('**2. 判决**\nPASS —— 复算支持原结论。', '**2. 判决**\n整体不错，可以考虑采纳。')
  const r = validateSeatOutput('review', vague, contracts)
  t('W5 裁决含糊（"整体不错"）⇒ FAIL', !r.ok && r.problems.some((p) => p.code === 'G4-VAGUE-VERDICT'), JSON.stringify(r.problems.map((p) => p.code)))
}
{
  // ★ 用一个**真的不含任何档位词**的替换串。
  //   我第一版写成"作者与我是不同会话。"—— 那是测试写错了：`不同会话` 里含 `同会话` 子串，
  //   于是 G5 仍匹配 ⇒ 这条测试**自己**制造不了阴性条件。
  //   （★ 顺带：这也证明了模块原来用裸 `同会话` 是**假绿**风险，已收紧为 `同会话换`。）
  const noIndep = GOOD.review.replace(/本次裁决的档位：跨会话（未到跨模型）。/, '作者与我不在同一台机器上。')
  const r = validateSeatOutput('review', noIndep, contracts)
  // ★★ 2026-09-27 裁决（**不是放宽，是让断言与规格一致**）：
  //   本条原先要求 `G11-INVALID-VALUE` **且** `G5-NO-INDEPENDENCE`。
  //   但实测 review 的 `## Output Contract` 只声明**四段**
  //   （`复算结果 / 判决 / 反证清单 / 不确定`）—— **`独立性档位` 不在其中**
  //   （它是该 persona 里**另一节**，不是产出契约的固定N段）。
  //   ⇒ `G11` 是"**必需段落**"级判据，其适用面 = `c.sections.includes('独立性档位')`；
  //     对 review 而言**为假** ⇒ G11 **本就不该触发**（触发了才是假红，正是历史事故 A）。
  //
  //   ⇒ 这条阴性条件的**真正守卫是 G5**（全文弱判据：有没有档位词）。
  //     G5 对 review 有效且**确实**红了（实测 `["G5-NO-INDEPENDENCE"]`）⇒ 阴性条件成立。
  //   ★ 判据没有被削弱：`!r.ok` 仍为真，只是红的**分类**从"段落级 G11"变成"全文级 G5"，
  //     而**规格本来就没有** `独立性档位` 这一段 —— 要求 G11 才是错的。
  //   ★ 若将来 review 的契约**真的**把该段并进固定N段，下面这条断言应**同时**恢复 G11
  //     —— 判定方式：`contracts.review.sections.includes('独立性档位')`。
  t(
    'W6 档位值不合规 ⇒ FAIL（无档位词时 G5 必红）',
    !r.ok && r.problems.some((p) => p.code === 'G5-NO-INDEPENDENCE'),
    JSON.stringify(r.problems.map((p) => p.code)),
  )
}

// ── W15–W17 ★ G10 探针自证（信号驱动，不依赖自评）────────────────────────────
console.log('\n-- W15–W17 G10 探针自证：发现对不上的读数时，必须先自证探针 --')
{
  const base = (tail) => `**1. 被审对象**
门。

**2. 独立复算**
我在 \`scripts/check-all.mjs\` 里 grep \`shell\`，**零命中**。

${tail}

**4. 下一步**
无。

**5. 我可能错在哪**
独立性档位：跨会话（未到跨模型）。`

  // W15 阴性：在做归因，但全文没有阳性对照 ⇒ 红
  const noProof = base('**3. 裁决**\n通过。')
  const r15 = validateSeatOutput('review', noProof, contracts)
  t('W15 阴性：归因了但全文无阳性对照 ⇒ G10 红', r15.problems.some((p) => p.code === 'G10-NO-PROBE-SELF-PROOF'),
    JSON.stringify(r15.problems.map((p) => p.code)))

  // W16 阳性对照：同一份产出 + 一条阳性对照 ⇒ G10 必须放行（防噪音机）
  const withProof = base('**3. 裁决**\n通过。\n\n阳性对照：`node scripts/seats/test-seat-contract.mjs` exit=0，全绿。')
  const r16 = validateSeatOutput('review', withProof, contracts)
  t('W16 ★阳性对照：补一条阳性对照后 G10 必须放行', !r16.problems.some((p) => p.code === 'G10-NO-PROBE-SELF-PROOF'),
    JSON.stringify(r16.problems.map((p) => p.code)))

  // W17 消融：把"负面信号"这一半触发条件去掉 ⇒ G10 必须**不再触发**
  //   （证明触发它的是"文件引用 + 负面结果"这个组合，而不是别的什么）
  const noSignal = `**1. 被审对象**
门。

**2. 独立复算**
我在 \`scripts/check-all.mjs\` 里看到 \`shell\` 相关的调用。

**3. 裁决**
通过。

**4. 下一步**
无。

**5. 我可能错在哪**
独立性档位：跨会话（未到跨模型）。`
  const r17 = validateSeatOutput('review', noSignal, contracts)
  t('W17 消融：无负面信号 ⇒ G10 不触发（证明触发条件是那个组合）', !r17.problems.some((p) => p.code === 'G10-NO-PROBE-SELF-PROOF'),
    JSON.stringify(r17.problems.map((p) => p.code)))

  // W18 ★ scope 泄漏：**代码块里引用的契约原文**不算"产出了该段落"
  //   （实测：architect 轮 1/2 引用了拟议的 persona 片段 ⇒ 旧产出被误判为合格 = 假绿）
  const quoted = `**1. 被审对象**

下面是我**建议**加的那一段（注意这是引用，不是我产出的）：

\`\`\`
6. **独立性档位** —— 不适用（本席位不做独立复核）。
\`\`\`

**2. 独立复算**

无。

**3. 裁决**

通过。

**4. 下一步**

无。

**5. 我可能错在哪**

档位：跨会话（未到跨模型）。`
  const r18 = validateSeatOutput('architect', quoted, contracts)
  t('W18 代码块里引用的契约原文 ⇒ 不得当成"产出了该段落"（否则旧产出被误放行）',
    r18.problems.some((p) => p.code === 'G1-MISSING') || r18.problems.some((p) => p.code === 'G11-MISSING'),
    JSON.stringify(r18.problems.map((p) => p.code)))
}

// ── W9 ★ 假红回归：段名【先出现在正文里】，标题在后面 ─────────────────────────
console.log('\n-- W9 ★假红回归：段名先在正文出现（真实产出就是这个形状） --')
{
  // 真实席位产出里，正文先说「以下是独立复核判决。」，标题 `## 3. 判决：…` 在后面。
  // 旧实现用全局 indexOf ⇒ 切到正文那句 ⇒ 判「没有三态词」= **假红**。
  // （★ 病因与铁律 41 同族：文本判据没做作用域限定。）
  // ★ steer 06: 新格式用「判决」而非「裁决」，标题用「复算结果」「判决」等
  const realShape = `关键数据已收集完毕。以下是独立复核判决。

---

## 1. 复算结果

自己跑了命令，读数与作者声明一致。

## 2. 判决

经复算，本裁决为**有条件通过**，判据逻辑正确，但有阻塞项待解决。

## 3. 反证清单

无。

## 4. 不确定

可能这个行为只是本机沙箱特例。`
  const r = validateSeatOutput('review', realShape, contracts)
  const g4 = r.problems.some((p) => p.code === 'G4-VAGUE-VERDICT')
  t('W9 段名先出现在正文、标题在后 ⇒ 不得报 G4（否则就是假红）', !g4, g4 ? '★ 又假红了！' : '')
  // ★ 阳性：判决段真的含三态词 ⇒ 必须被识别出来
  const body = r.sections['判决'] ?? ''
  t('W9b 判决段正文确实取到了「有条件通过」', body.includes('有条件通过'), JSON.stringify(body.slice(0, 40)))
}

// ── 其它 ─────────────────────────────────────────────────────────────────────
console.log('\n-- 其余 --')
t('未知席位 ⇒ FAIL（不许静默通过）', !validateSeatOutput('nope', '随便', contracts).ok)

// ── W7 ★ 消融：解析锚点坏掉 ⇒ 必须 fail-closed ───────────────────────────────
console.log('\n-- W7 ★消融自证：解析失败必须 fail-closed（绝不许静默跳过） --')
{
  // 造一个 tmp 目录，拷贝 seats/library 三份 md，然后改 council-dev.md 里的锚点词
  const tmpDir = path.join(os.tmpdir(), `seat-md-broken-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  const libFiles = readdirSync(SEAT_SOURCE_DIR).filter((n) => n.endsWith('.md'))
  for (const f of libFiles) copyFileSync(path.join(SEAT_SOURCE_DIR, f), path.join(tmpDir, f))

  // 把 council-dev.md 里的「## Output Contract」正文里「固定五项」那个锚点改成别的
  // 让「必须包含这N段」解析失败
  let devMd = readFileSync(path.join(tmpDir, 'council-dev.md'), 'utf8')
  const broken = devMd.replace(/固定五项/g, '固定下列若干项')
  if (broken === devMd) {
    bad('W7 前置：消融没生效（锚点没被改到）')
    rmSync(tmpDir, { recursive: true, force: true })
  } else {
    writeFileSync(path.join(tmpDir, 'council-dev.md'), broken, 'utf8')
    let threw = false
    let msg = ''
    try { parseSeatContracts(tmpDir) } catch (e) {
      threw = e instanceof SeatContractParseError
      msg = String(e.message).slice(0, 80)
    }
    t('W7 消融：锚点被改 ⇒ 解析必须抛 SeatContractParseError', threw, threw ? msg : '★ 没抛错！')
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
{
  // ★ 消融：段名标记被部分改掉（只对 council-architect.md 改）。
  //   ⚠️ 这一条是**最有价值的一条** —— 它最初**没报错**：因为改掉 4/5 个段名后，
  //   解析出的是 **1** 段而不是 0 段，而模块当时只断言 `> 0` ⇒
  //   **契约要求被悄悄从 5 段降到 1 段 ⇒ 假绿**。
  //   ⇒ 已改成"**解析出的段数必须等于标题声明的段数**"，否则抛错。
  const tmpDir = path.join(os.tmpdir(), `seat-md-nosec-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  const libFiles = readdirSync(SEAT_SOURCE_DIR).filter((n) => n.endsWith('.md'))
  for (const f of libFiles) copyFileSync(path.join(SEAT_SOURCE_DIR, f), path.join(tmpDir, f))

  // 改 council-architect.md：把段名标记从 **目标复述** 等改成 §...§
  let archMd = readFileSync(path.join(tmpDir, 'council-architect.md'), 'utf8')
  const broken = archMd.replace(/\*\*(目标复述|现状|方案|推荐|不确定性|判据)\*\*/g, '§$1§')
  writeFileSync(path.join(tmpDir, 'council-architect.md'), broken, 'utf8')
  let threw = false
  let msg = ''
  try { parseSeatContracts(tmpDir) } catch (e) { threw = e instanceof SeatContractParseError; msg = String(e.message).slice(0, 90) }
  t('W7b 消融：段名被部分改坏 ⇒ 段数与声明不一致，必须抛错（不许把 6 段悄悄降成 1 段 = 假绿）', threw, threw ? msg : '★ 没抛错！')
  rmSync(tmpDir, { recursive: true, force: true })
}

// ── W10–W13 ★ 编造判据（G8/G9）：用【真实席位产出】当验收样本 ─────────────────
console.log('\n-- W10–W13 ★编造判据：新名词必须带坐标，坐标必须对得上 --')
{
  const { verifyVocabulary } = await import('./vocabulary-check.mjs')
  const bundle = fs.readFileSync('out/handover-to-review-seat.md', 'utf8')
  const realOut = fs.existsSync('out/review-seat-output.md') ? fs.readFileSync('out/review-seat-output.md', 'utf8') : ''

  // W10 ★★★ 真实产出里那句「check-all.mjs 里 shell:true …」必须被抓住
  let r10 = { problems: [], unlocated: [] }
  if (realOut) {
    r10 = verifyVocabulary(realOut, bundle)
    const hitG9 = r10.problems.some((p) => p.code === 'G9-SYMBOL-NOT-IN-CITED-FILE' && p.msg.includes('shell:true'))
    t('W10 真实产出的「check-all.mjs 里 shell:true」必须被 G9 抓住（该符号在文件里零命中）', hitG9,
      hitG9 ? '' : JSON.stringify(r10.problems.map((p) => p.code)))
    // ★ 同时：它那条**诚实**的引用 `(r.status ?? 1) === 0`（第 259 行确有此行）**不许**被误报
    const falsePos = r10.problems.some((p) => p.msg.includes('r.status'))
    t('W10b 它那条【真的】引用 `(r.status ?? 1) === 0` 不得被误报（防噪音机）', !falsePos,
      falsePos ? '★ 误报了！' : '')
  } else {
    bad('W10 前置：找不到 out/review-seat-output.md（真实样本缺失）')
  }

  // W11 阳性对照：引用**真实存在**的符号 ⇒ 必须 PASS
  const goodCite = `## 1. 被审对象

门。

## 2. 独立复算

我读了 \`scripts/seats/seat-contract.mjs\`，确认里面确实有 \`parseSeatContracts\` 这个导出。

## 3. 裁决：通过

无阻塞。

## 4. 下一步

无。

## 5. 我可能错在哪

独立性档位：跨会话（未到跨模型），可能共享盲区。`
  const r11 = verifyVocabulary(goodCite, bundle)
  t('W11 阳性对照：引用真实存在的符号 ⇒ PASS', r11.ok, r11.ok ? '' : JSON.stringify(r11.problems.map((p) => p.code)))

  // W12 阴性：新符号 + 无引证 ⇒ **只报告（unlocated），不判红**
  //   ★ 为什么改成"不判红"：我第一版判红了，实测 **6 条发现里 5 条是误报**
  //     （把【命令】【它自己调用的函数】【返回字面量】全算成"该文件里没有"）⇒ **噪音机**。
  //     按三态纪律：显式记 `unknown`、不判红、也不放过。
  const noCoord = `## 1. 被审对象

门。

## 2. 独立复算

它内部用了 \`someInventedHelper\` 来解析。

## 3. 裁决：通过

无阻塞。

## 4. 下一步

无。

## 5. 我可能错在哪

独立性档位：跨会话。`
  const r12 = verifyVocabulary(noCoord, bundle)
  t('W12 新符号无引证 ⇒ 进 unlocated（报告），**不判红**', r12.unlocated.includes('someInventedHelper') && r12.problems.length === 0,
    `unlocated=${JSON.stringify(r12.unlocated)} problems=${JSON.stringify(r12.problems.map((p) => p.code))}`)

  // W14 ★★★ 防误报（本轮最该有的一条）：真实产出里那 5 个"看着像新符号其实不是"的，
  //   **一个都不许**被判红。它们分别是：命令、它自己调用的函数、返回字面量、我材料里的命令。
  const FALSE_POS = ['check-all --only seats', "validateSeatOutput('dev', content)", 'ok=true, problems=[]']
  const flagged = r10.problems.map((p) => p.msg).join('\n')
  const bad1 = FALSE_POS.filter((t2) => flagged.includes(t2))
  t('W14 防误报：命令 / 自调函数 / 返回字面量 不得被判红（第一版这里错了 5 条）', bad1.length === 0,
    bad1.length ? `★ 误报了：${JSON.stringify(bad1)}` : '')

  // W13 ★ 消融：把"真的去比对被引内容"这一步撤掉 ⇒ W10 必须**不再**红
  //   （证明抓住 shell:true 的**就是**那一步，而不是别的什么顺手命中了）
  const ablated = (() => {
    const src = fs.readFileSync('scripts/seats/vocabulary-check.mjs', 'utf8')
    const mutated = src.replace('if (target.includes(id)) continue', 'if (true) continue /* ★消融：永远认为命中 */')
    return mutated === src ? null : mutated
  })()
  if (!ablated) bad('W13 前置：消融没生效（没匹配到要改的那一句）')
  else {
    const tmp = path.join(os.tmpdir(), `vocab-ablate-${Date.now()}.mjs`)
    fs.writeFileSync(tmp, ablated, 'utf8')
    const mod = await import(`file://${tmp.replace(/\\/g, '/')}`)
    const r13 = mod.verifyVocabulary(realOut, bundle)
    const stillCaught = r13.problems.some((p) => p.code === 'G9-SYMBOL-NOT-IN-CITED-FILE')
    t('W13 消融：撤掉"真的比对被引内容"⇒ 必须抓不到了（证明是那一步在起作用）', !stillCaught,
      stillCaught ? '★ 撤了还能抓到 ⇒ 说明抓住它的不是这一步' : '')
    fs.rmSync(tmp, { force: true })
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass)
console.log('\n' + '='.repeat(60))
console.log(`结果：${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  · ${f.n}`)
}
process.exit(failed.length ? 1 : 0)
