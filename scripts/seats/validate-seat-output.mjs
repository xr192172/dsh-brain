#!/usr/bin/env node
/**
 * validate-seat-output.mjs —— 用某个席位的**自述契约**校验一份产出（S0′ 的可用入口）。
 *
 * 用途（两个真实场景）：
 *   ① **执行者自检**：把自己的交付按 `review`/`architect` 席的契约过一遍 —— 少段、敷衍、
 *      空话收尾、裁决含糊，**在提交给人/给席位之前**就暴露（这是"交给它审"的前置）。
 *   ② **席间门**：将来接进流程时，任何席位产出先过这一关，不合格直接退回。
 *
 * ★ 本工具**不改 persona、不写盘、不联网、不调 LLM** —— 纯确定性。
 *
 * 用法：
 *   node scripts/seats/validate-seat-output.mjs --seat review --file out/my-review.md
 *   node scripts/seats/validate-seat-output.mjs --seat dev --file -        # 从 stdin 读
 *   node scripts/seats/validate-seat-output.mjs --list                     # 列三席的契约
 *   node scripts/seats/validate-seat-output.mjs --seat review --file x.md --json
 */
import fs from 'node:fs'
import { parseSeatContracts, validateSeatOutput, SEAT_SOURCE } from './seat-contract.mjs'
import { verifyVocabulary } from './vocabulary-check.mjs'

const argv = process.argv.slice(2)
const get = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1] }
const has = (k) => argv.includes(k)
const asJson = has('--json')

let contracts
try {
  contracts = parseSeatContracts()
} catch (e) {
  // ★ fail-closed：契约解析不出来 ⇒ 报错退出，**绝不**"解析不到就跳过校验"
  console.error(`[失败] 席位契约解析失败（fail-closed，拒绝继续）：${e.message}`)
  console.error('       ⇒ 先修 packages/subagent-council/src/index.ts 的 persona 形状，或修解析器。')
  process.exit(2)
}

if (has('--list')) {
  console.log('\n席位契约（★ 从 persona 源码解析，不是手抄）')
  console.log(`  源: ${SEAT_SOURCE}\n`)
  for (const [seat, c] of Object.entries(contracts)) {
    console.log(`  ${seat}  （声明「这${c.countWord}段」= ${c.declaredCount}，解析出 ${c.sections.length}）`)
    console.log(`      必需段落: ${c.sections.join(' / ')}`)
    console.log(`      禁止收尾: ${c.bannedClosings.join(' / ')}`)
  }
  console.log('')
  process.exit(0)
}

const seat = get('--seat')
const file = get('--file')
if (!seat || !file) {
  console.error('用法: --seat <architect|dev|review> --file <路径|-> [--json]   或   --list')
  process.exit(2)
}

let text
try {
  text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8')
} catch (e) {
  console.error(`[失败] 读不到产出：${file} — ${e.message}`)
  process.exit(2)
}

const r = validateSeatOutput(seat, text, contracts)

// ★ 编造判据（G8/G9）—— 只在给了 `--source`（被审材料）时才跑：
//   "新名词"的定义就是"不在被审材料里"。不给材料就无法判定，**不许猜**。
const srcFile = get('--source')
let vocab = null
if (srcFile) {
  try {
    vocab = verifyVocabulary(text, fs.readFileSync(srcFile, 'utf8'))
  } catch (e) {
    console.error(`[失败] 读不到被审材料：${srcFile} — ${e.message}`)
    process.exit(2)
  }
}

const ok = r.ok && (!vocab || vocab.ok)

if (asJson) {
  console.log(JSON.stringify({ seat, ok, problems: r.problems, vocabulary: vocab?.problems ?? null }, null, 2))
  process.exit(ok ? 0 : 1)
}

console.log(`\n席位产出校验 · seat=${seat}  产出 ${text.length} 字符`)
console.log(`契约: ${contracts[seat]?.sections.join(' / ') ?? '(未知席位)'}`)
console.log(`编造判据: ${srcFile ? `开（被审材料 ${srcFile}）` : '★ 关（未给 --source ⇒ 无法判定"新名词"，不许猜）'}`)
console.log('')
if (ok) {
  console.log('  ✅ 合格：段落齐、自证伪字段非空且不敷衍、结尾无被禁空话')
  if (seat === 'review') console.log('     （review 席：裁决落在三态内，独立性档位已标注）')
  if (vocab) console.log('     （编造判据：没有"无坐标的新符号"，也没有"符号在所引文件里找不到"）')
  console.log('')
  process.exit(0)
}
const all = [...r.problems, ...(vocab?.problems ?? [])]
console.log(`  ✗✗ 不合格（${all.length} 条）：`)
for (const p of all) console.log(`      [${p.code}] ${p.msg}`)
console.log('')
console.log('  ★ 修法：按上面逐条补齐。**不许**去改判据来让它变绿（那是把假红变成假绿）。')
console.log('  ★ G9 特别说明：它抓的是"你把这个符号说成在那个文件里，但文件里没有" ——')
console.log('     这正是**编造机制**的典型形状（真实实例：`shell:true` 在 check-all.mjs 里零命中）。')
console.log('')
process.exit(1)
