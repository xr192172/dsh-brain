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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseSeatContracts, validateSeatOutput, SeatContractParseError, SEAT_SOURCE } from './seat-contract.mjs'

const results = []
const ok = (n, detail = '') => { results.push({ n, pass: true }); console.log(`  ok    ${n}${detail ? ' — ' + detail : ''}`) }
const bad = (n, detail = '') => { results.push({ n, pass: false }); console.log(`  FAIL  ${n}${detail ? ' — ' + detail : ''}`) }
const t = (n, cond, detail = '') => (cond ? ok(n, detail) : bad(n, detail))

console.log('=== 席位产出契约验收器 · 双向自证 ===\n')
console.log(`契约源（单一真相源）: ${SEAT_SOURCE}\n`)

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
  architect: `**1. 问题重述**
把 launcher 的 .cmd 保持在纯 ASCII + CRLF。

**2. 候选方案**
方案A：每次安装时归一化。方案B：安装器拒绝坏源。两者隐含假设不同：A 假设源可以脏，B 假设源必须干净。

**3. 取舍**
A 能做到且可逆；B 代价是源必须干净，但可逆性更好。

**4. 推荐 + 风险**
推荐 B。它会坏在：源里有非 ASCII 时安装直接失败，用户看到红字 —— 这是好事，能立刻发现。

**5. 我可能错在哪**
如果团队的源长期有中文注释，B 会让安装频繁失败，可能需要放宽为只检查非 ASCII 之外的项。`,
  dev: `**1. 链路图**
读源 → 校验行尾 → 校验字节 → 写桌面 → 复验指纹。

**2. 编排产物**
工具名：install-launcher；参数：{repo, dest}；内部调用 check-lineendings / write / verify。

**3. 融合说明**
融合了 install-desktop-icon 与 fix-cmd-lineendings；依据是复验指纹后 0 非 ASCII / 0 纯 LF 的具体读数。

**4. 自证**
贴原始输出：\`指纹 bytes=3713 非ASCII=0 纯LF=0\`；真退出码 0。

**5. 回值**
成功率 1/1；调用次数 1。

**6. 我可能错在哪**
我只在 Windows 上验过，POSIX 上的换行语义不同，可能不适用。`,
  review: `**1. 被审对象**
启动器加固：桌面那份重新生成 + 两道门。

**2. 独立复算**
我不用作者的结论，自己重算：读桌面文件字节，得 非ASCII=0 / 纯LF=0，与作者所述一致。

**3. 裁决**
通过。

**4. 下一步**
无需改动；建议把同样的指纹检查加到 CI。

**5. 我可能错在哪**
独立性档位：同会话（跨会话/跨模型都没用上）。若作者与我是同一模型，某些盲区会共享。`,
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
    const cut = GOOD[seat].split('\n').filter((l) => !l.includes(`**${name}**`) && !l.startsWith('**') || !l.includes(name))
    // 上面过滤太绕；改为：删掉包含该段名的标题行
    const lines = GOOD[seat].split('\n')
    const out = lines.filter((l) => !(l.startsWith('**') && l.includes(name))).join('\n')
    const r = validateSeatOutput(seat, out, contracts)
    const named = r.problems.some((p) => p.code === 'G1-MISSING' && p.msg.includes(name))
    t(`W2 缺段·${seat}「${name}」⇒ FAIL 且指名`, !r.ok && named,
      r.ok ? '★ 没报红！' : (named ? '' : JSON.stringify(r.problems)))
  }
}

// ── W3 「我可能错在哪」留空/敷衍 ⇒ FAIL ──────────────────────────────────────
console.log('\n-- W3 自证伪字段不许敷衍 --')
{
  const blank = GOOD.review.replace(/我可能错在哪\*\*[\s\S]*$/, '我可能错在哪**\n')
  const r1 = validateSeatOutput('review', blank, contracts)
  t('W3a 「我可能错在哪」留空 ⇒ FAIL', !r1.ok && r1.problems.some((p) => p.code.startsWith('G2')), JSON.stringify(r1.problems.map((p) => p.code)))

  const dismissive = GOOD.review.replace(/我可能错在哪\*\*[\s\S]*$/, '我可能错在哪**\n无')
  const r2 = validateSeatOutput('review', dismissive, contracts)
  t('W3b 「我可能错在哪」只写"无" ⇒ FAIL（算敷衍）', !r2.ok && r2.problems.some((p) => p.code === 'G2-DISMISSIVE'), JSON.stringify(r2.problems.map((p) => p.code)))
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
  const vague = GOOD.review.replace('**3. 裁决**\n通过。', '**3. 裁决**\n整体不错，可以考虑采纳。')
  const r = validateSeatOutput('review', vague, contracts)
  t('W5 裁决含糊（"整体不错"）⇒ FAIL', !r.ok && r.problems.some((p) => p.code === 'G4-VAGUE-VERDICT'), JSON.stringify(r.problems.map((p) => p.code)))
}
{
  // ★ 用一个**真的不含任何档位词**的替换串。
  //   我第一版写成"作者与我是不同会话。"—— 那是测试写错了：`不同会话` 里含 `同会话` 子串，
  //   于是 G5 仍匹配 ⇒ 这条测试**自己**制造不了阴性条件。
  //   （★ 顺带：这也证明了模块原来用裸 `同会话` 是**假绿**风险，已收紧为 `同会话换`。）
  const noIndep = GOOD.review.replace(/独立性档位：同会话（跨会话\/跨模型都没用上）。/, '作者与我不在同一台机器上。')
  const r = validateSeatOutput('review', noIndep, contracts)
  t('W6 缺独立性档位 ⇒ FAIL', !r.ok && r.problems.some((p) => p.code === 'G5-NO-INDEPENDENCE'), JSON.stringify(r.problems.map((p) => p.code)))
}

// ── W9 ★ 假红回归：段名【先出现在正文里】，标题在后面 ─────────────────────────
console.log('\n-- W9 ★假红回归：段名先在正文出现（真实产出就是这个形状） --')
{
  // 真实席位产出里，正文先说「以下是独立复核裁决。」，标题 `## 3. 裁决：…` 在后面。
  // 旧实现用全局 indexOf ⇒ 切到正文那句 ⇒ 判「没有三态词」= **假红**。
  // （★ 病因与铁律 41 同族：文本判据没做作用域限定。）
  const realShape = `关键数据已收集完毕。以下是独立复核裁决。

---

## 1. 被审对象

门本身。

## 2. 独立复算

自己跑了命令，读数与作者声明一致。

## 3. 裁决：**有条件通过**

判据逻辑正确，但有阻塞项。

## 4. 下一步

修集成。

## 5. 我可能错在哪

可能这个行为只是本机沙箱特例。`
  const r = validateSeatOutput('review', realShape, contracts)
  const g4 = r.problems.some((p) => p.code === 'G4-VAGUE-VERDICT')
  t('W9 段名先出现在正文、标题在后 ⇒ 不得报 G4（否则就是假红）', !g4, g4 ? '★ 又假红了！' : '')
  // ★ 阳性：裁决段真的含三态词 ⇒ 必须被识别出来
  const body = r.sections['裁决'] ?? ''
  t('W9b 裁决段正文确实取到了「有条件通过」', body.includes('有条件通过'), JSON.stringify(body.slice(0, 40)))
}

// ── 其它 ─────────────────────────────────────────────────────────────────────
console.log('\n-- 其余 --')
t('未知席位 ⇒ FAIL（不许静默通过）', !validateSeatOutput('nope', '随便', contracts).ok)

// ── W7 ★ 消融：解析锚点坏掉 ⇒ 必须 fail-closed ───────────────────────────────
console.log('\n-- W7 ★消融自证：解析失败必须 fail-closed（绝不许静默跳过） --')
{
  const tmp = path.join(os.tmpdir(), `seat-src-broken-${Date.now()}.ts`)
  const src = fs.readFileSync(SEAT_SOURCE, 'utf8')
  // 把「必须包含这N段」这个锚点整体改掉（模拟 persona 被重写）
  const broken = src.replace(/必须包含这/g, '必须囊括下列')
  if (broken === src) bad('W7 前置：消融没生效（锚点没被改到）')
  else {
    fs.writeFileSync(tmp, broken, 'utf8')
    let threw = false
    let msg = ''
    try { parseSeatContracts(tmp) } catch (e) {
      threw = e instanceof SeatContractParseError
      msg = String(e.message).slice(0, 80)
    }
    t('W7 消融：锚点被改 ⇒ 解析必须抛 SeatContractParseError', threw, threw ? msg : '★ 没抛错！')
    fs.rmSync(tmp, { force: true })
  }
}
{
  // ★ 消融：段名标记被部分改掉。
  //   ⚠️ 这一条是**最有价值的一条** —— 它最初**没报错**：因为改掉 4/5 个段名后，
  //   解析出的是 **1** 段而不是 0 段，而模块当时只断言 `> 0` ⇒
  //   **契约要求被悄悄从 5 段降到 1 段 ⇒ 假绿**。
  //   ⇒ 已改成"**解析出的段数必须等于标题声明的段数**"，否则抛错。
  const tmp = path.join(os.tmpdir(), `seat-src-nosec-${Date.now()}.ts`)
  const src = fs.readFileSync(SEAT_SOURCE, 'utf8')
  const broken = src.replace(/\*\*(问题重述|候选方案|取舍|推荐 \+ 风险)\*\*/g, '§$1§')
  fs.writeFileSync(tmp, broken, 'utf8')
  let threw = false
  let msg = ''
  try { parseSeatContracts(tmp) } catch (e) { threw = e instanceof SeatContractParseError; msg = String(e.message).slice(0, 90) }
  t('W7b 消融：段名被部分改坏 ⇒ 段数与声明不一致，必须抛错（不许把 5 段悄悄降成 1 段 = 假绿）', threw, threw ? msg : '★ 没抛错！')
  fs.rmSync(tmp, { force: true })
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
