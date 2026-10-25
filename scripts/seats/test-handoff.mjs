/**
 * test-handoff.mjs —— 交接包契约的**双向自证**（照 test-seat-contract 的纪律）
 *
 * ★ 阳性对照：一份确实合格的交接包必须 PASS（没有阳性对照的门会被当噪音绕过）
 * ★ 消融自证：缺段/缺证据/空话收尾都必须 FAIL（fail-closed，绝不静默放过）
 *
 * 用法：node scripts/seats/test-handoff.mjs
 */
import { validateHandoff } from './handoff-contract.mjs'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`✓ ${name}`) }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e.message}`) }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const GOOD = `# 交接包 · 记忆图谱召回优化

- depth: 2
- from: dev@深度2（agent:dev-7）
- to: review-board

## 已完成（含证据）
- 阈值判定接入 /recall —— 证据：\`grep -n "minScore" httpapi.go\`（httpapi.go:566）
- 中文规范化提取验证 —— 证据：真实网关 /remember 返回 source:"llm"，3 节点全中文

## 未完成（剩余）
- 前因后果链的深度参数化 —— 原因：默认 depth=1 够用，参数化待真实需求

## 关键发现与坑
- RRF 分数是倒数排名量纲，不能当相关性阈值用——要用 cosScore

## 下一步建议
把 cosScore 贯通到 SearchEntry 后跑三组中文召回冒烟
`

const BAD_MISSING = GOOD.split('## 关键发现与坑')[0] // 砍掉后两段

const BAD_NO_EVIDENCE = GOOD.replace(/ —— 证据：`grep -n "minScore" httpapi\.go`（httpapi\.go:566）/, '')

const BAD_EMPTY_NEXT = GOOD.replace(
  '把 cosScore 贯通到 SearchEntry 后跑三组中文召回冒烟',
  '建议进一步评估',
)

t('阳性：合格交接包 PASS', () => {
  const r = validateHandoff(GOOD)
  assert(r.ok, '应 PASS，实际 problems=' + JSON.stringify(r.problems))
  assert(r.sections.length === 4, '四段齐')
  assert(r.meta.depth === '2' && r.meta.to === 'review-board', '元信息齐')
})

t('消融：缺两段 → FAIL 且指名缺段', () => {
  const r = validateHandoff(BAD_MISSING)
  assert(!r.ok, '应 FAIL')
  assert(r.problems.some((p) => p.includes('关键发现与坑')), '应指名缺「关键发现与坑」')
  assert(r.problems.some((p) => p.includes('下一步建议')), '应指名缺「下一步建议」')
})

t('消融：已完成条目缺证据标记 → FAIL', () => {
  const r = validateHandoff(BAD_NO_EVIDENCE)
  assert(!r.ok, '应 FAIL')
  assert(r.problems.some((p) => p.includes('缺证据标记')), '应指名缺证据')
})

t('消融：下一步空话收尾 → FAIL', () => {
  const r = validateHandoff(BAD_EMPTY_NEXT)
  assert(!r.ok, '应 FAIL')
  assert(r.problems.some((p) => p.includes('空话收尾')), '应指名空话收尾')
})

t('fail-closed：完全不是交接包的文本 → FAIL（缺全部四段+元信息）', () => {
  const r = validateHandoff('今天天气不错，我想去钓鱼。')
  assert(!r.ok, '应 FAIL')
  assert(r.problems.length >= 6, '应报缺四段+三行元信息，实际 ' + JSON.stringify(r.problems))
})

console.log(`\n交接包契约自证：${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
