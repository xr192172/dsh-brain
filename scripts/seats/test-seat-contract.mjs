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

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass)
console.log('\n' + '='.repeat(60))
console.log(`结果：${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  · ${f.n}`)
}
process.exit(failed.length ? 1 : 0)
