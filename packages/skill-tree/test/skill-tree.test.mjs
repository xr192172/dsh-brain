/**
 * L2 `SkillTree` 单测 —— 三级 findByPrinciple + findSimilar + Absorb（2026-09-21）
 *
 * 跑法（先编译，lib/ 被 gitignore，不会污染仓库）：
 *   node node_modules/typescript/bin/tsc -p packages/skill-tree/tsconfig.json
 *   node --test packages/skill-tree/test/skill-tree.test.mjs
 *
 * ★ 与 `tokenize.test.mjs` 一样：这里的断言是 **Go 侧既有行为的逐字镜像**，
 *   包括 W1~W5 / N1~N3 那些已知缺陷。红了 = 口径漂了 = 去重/合并结果不可复现。
 *   ⇒ 想改行为？先改这里的断言并写明「有意的口径变更」，再单独立项。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SkillTree,
  newSkillNode,
  randomSuffix,
  isEvalReady,
  EvalReason,
  MIN_FUZZY_TOKENS,
  TIER2_JACCARD_GT,
  TIER3_MIN_NORM_BYTES,
  REJECTED_EDITS_MAX,
} from '../lib/skill-tree.js'
import { AbsorbOutcome, SkillStatus, SkillSource } from '../lib/index.js'
import { byteLen, normalizePrinciple, tokenizePrinciple, jaccard } from '../lib/text/tokenize.js'

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/** 直接塞一个节点（绕过 create 的去重/ID 生成），用于精确控场。 */
const mk = (tree, id, over = {}) => {
  const n = { ...newSkillNode(), ID: id, ...over }
  tree.put(n)
  return n
}

/** 建一棵带 N 个 principle 的树（principle 之间互不匹配，避免 create 的 dedup 干扰）。 */
const treeOf = (...principles) => {
  const t = new SkillTree()
  principles.forEach((p, i) => t.create('learned', p, `fix-${i}`, [], ''))
  return t
}

/** 固定返回值的 evaluator，记录收到的候选节点。 */
class FixedEval {
  constructor(res) {
    this.res = res
    this.seen = []
  }
  Evaluate(node) {
    this.seen.push(node)
    return { ...this.res }
  }
}

// ── Tier-1：O(1) 归一化索引 ──────────────────────────────────────────────────

test('Tier-1 精确命中：大小写 / 前后空白不敏感', () => {
  const t = treeOf('Validate user input')
  assert.equal(t.findByPrinciple('Validate user input'), 'skill-validate-user-input')
  assert.equal(t.findByPrinciple('validate user input'), 'skill-validate-user-input')
  assert.equal(t.findByPrinciple('  VALIDATE User Input  '), 'skill-validate-user-input')
})

test('Tier-1 未命中返回 undefined（Go 的 ("", false)）', () => {
  const t = treeOf('Validate user input')
  assert.equal(t.findByPrinciple('sanitize html output'), undefined)
  assert.equal(new SkillTree().findByPrinciple('anything at all here'), undefined)
})

test('⚠️W4 Tier-1 的键是 normalizePrinciple：D1 误伤后的串才是同一个键', () => {
  const t = new SkillTree()
  const n = t.create('learned', 'validate datflow', 'f', [], '')
  // 查询串与被存串**原文不同**，但归一化后同键 ⇒ 命中
  assert.equal(normalizePrinciple('Validate data flow'), 'validate datflow')
  assert.equal(t.findByPrinciple('Validate data flow'), n.ID)
})

// ── Tier-2：token 集合 Jaccard，严格 > 0.5 ───────────────────────────────────

test('Tier-2 命中：改写后 jaccard > 0.5', () => {
  const t = new SkillTree()
  const n = mk(t, 'skill-a', { Principle: 'validate user input email' })
  // 候选 {validate,user,input,form} ∩ {validate,user,input,email} = 3，∪ = 5 ⇒ 0.6
  assert.equal(jaccard(tokenizePrinciple('validate user input form'), tokenizePrinciple(n.Principle)), 0.6)
  assert.equal(t.findByPrinciple('validate user input form'), 'skill-a')
})

test('⚠️W5 边界 0.5：Go 注释点名的改写被 >0.5 漏掉（同串 findSimilar 命中）', () => {
  const t = new SkillTree()
  mk(t, 'skill-a', { Principle: 'validate user input' })
  const s = jaccard(
    tokenizePrinciple('input validation for user'),
    tokenizePrinciple('validate user input'),
  )
  assert.equal(s, 0.5)
  // Tier-2 严格 > 0.5 ⇒ 不命中；且 19 字节进不了 Tier-3 ⇒ 整体未命中
  assert.equal(TIER2_JACCARD_GT, 0.5)
  assert.ok(byteLen('validate user input') <= TIER3_MIN_NORM_BYTES)
  assert.equal(t.findByPrinciple('input validation for user'), undefined)
  // 同一对在 FindSimilar 的 >= 语义下**命中**
  assert.equal(t.findSimilar('input validation for user', 0.5, 5).length, 1)
})

test('Tier-2 闸门：候选或被比节点 token 数 < 2 都不参与', () => {
  assert.equal(MIN_FUZZY_TOKENS, 2)
  const t = new SkillTree()
  mk(t, 'skill-a', { Principle: 'validate user input email' })
  // 候选只有 1 个 token（"user" 是 4 字节，其余是 ≤2 字节/stopword）
  assert.equal(tokenizePrinciple('a to user').size, 1)
  assert.equal(t.findByPrinciple('a to user'), undefined)
  // 被比节点只有 1 个 token
  const t2 = new SkillTree()
  mk(t2, 'skill-b', { Principle: 'validate' })
  assert.equal(t2.findByPrinciple('validate user input'), undefined)
})

test('⚠️W1 中文去重 Tier-2 恒失效（纯中文 principle 永不匹配，短串 Tier-3 也进不去）', () => {
  const t = new SkillTree()
  mk(t, 'skill-cn', { Principle: '校验用户输入' })
  // token 集为空 ⇒ Tier-2 整层跳过
  assert.equal(tokenizePrinciple('校验用户输入').size, 0)
  // 18 字节 ≤ 20 ⇒ Tier-3 也进不去 ⇒ 完全查不到
  assert.ok(byteLen(normalizePrinciple('校验用户数据')) <= TIER3_MIN_NORM_BYTES)
  assert.equal(t.findByPrinciple('校验用户数据'), undefined)
  // 中英混排时英文部分仍能救回 Tier-2
  const t2 = new SkillTree()
  mk(t2, 'skill-mix', { Principle: '校验 user input 输入' })
  assert.equal(t2.findByPrinciple('input 校验 user'), 'skill-mix')
})

test('Tier-2 排除已吸收节点', () => {
  const t = new SkillTree()
  mk(t, 'skill-a', { Principle: 'validate user input email', Status: SkillStatus.Absorbed })
  assert.equal(t.findByPrinciple('validate user input form'), undefined)
})

// ── Tier-3：双向子串（两边 norm 都要 > 20 字节）─────────────────────────────

test('Tier-3 双向子串命中；且要求两侧都 > 20 字节', () => {
  const t = new SkillTree()
  mk(t, 'skill-long', { Principle: '校验用户输入的边界情况啊' }) // 36 字节
  assert.ok(byteLen(normalizePrinciple('校验用户输入的边界情况啊')) > TIER3_MIN_NORM_BYTES)
  // 查询串更长 ⇒ norm.includes(np)
  assert.equal(t.findByPrinciple('校验用户输入的边界情况啊以及更多'), 'skill-long')
  // 反过来：查询更短 ⇒ np.includes(norm)
  const t2 = new SkillTree()
  mk(t2, 'skill-long2', { Principle: '校验用户输入的边界情况啊以及更多' })
  assert.equal(t2.findByPrinciple('校验用户输入的边界情况啊'), 'skill-long2')
})

test('Tier-3 不走短串：被比节点 ≤20 字节时跳过', () => {
  const t = new SkillTree()
  mk(t, 'skill-short', { Principle: '校验用户输入' }) // 18 字节
  assert.equal(t.findByPrinciple('校验用户输入的边界情况啊'), undefined)
})

test('Tier-3 排除已吸收节点', () => {
  const t = new SkillTree()
  mk(t, 'skill-long', { Principle: '校验用户输入的边界情况啊', AbsorbedBy: 'skill-x' })
  assert.equal(t.findByPrinciple('校验用户输入的边界情况啊以及更多'), undefined)
})

test('三级优先级：Tier-1 > Tier-2 > Tier-3', () => {
  const t = new SkillTree()
  mk(t, 'skill-t3', { Principle: 'validate user input email address here' })
  mk(t, 'skill-t2', { Principle: 'validate user input email' })
  mk(t, 'skill-t1', { Principle: 'validate user input form' })
  // 精确键优先
  assert.equal(t.findByPrinciple('validate user input form'), 'skill-t1')
  // 无 Tier-1 时走 Tier-2（0.6）而非 Tier-3
  assert.equal(t.findByPrinciple('validate user input email extra'), 'skill-t2')
})

// ── FindSimilar ──────────────────────────────────────────────────────────────

test('FindSimilar：>= minJaccard 入选，按分数降序，topN 截断', () => {
  const t = new SkillTree()
  mk(t, 'skill-1', { Principle: 'validate user input email' })
  mk(t, 'skill-2', { Principle: 'validate user input phone' })
  mk(t, 'skill-3', { Principle: 'validate user name' })
  mk(t, 'skill-4', { Principle: 'sanitize html output' })
  const got = t.findSimilar('validate user input form', 0.3, 5)
  assert.deepEqual(
    got.map((n) => n.ID),
    ['skill-1', 'skill-2', 'skill-3'],
  ) // 0.6 / 0.6 / 0.4，第 4 个为 0
  assert.deepEqual(t.findSimilar('validate user input form', 0.3, 2).map((n) => n.ID), [
    'skill-1',
    'skill-2',
  ])
  // 阈值收紧到 0.5 ⇒ 只剩两个 0.6
  assert.equal(t.findSimilar('validate user input form', 0.5, 5).length, 2)
})

test('FindSimilar：token < 2 / topN <= 0 / 空树 ⇒ 空；排除已吸收', () => {
  const t = new SkillTree()
  mk(t, 'skill-1', { Principle: 'validate user input email' })
  assert.deepEqual(t.findSimilar('校验用户输入', 0.3, 5), []) // ⚠️W1 中文进不去
  assert.deepEqual(t.findSimilar('validate', 0.3, 5), []) // 只有 1 个 token ⇒ 直接空
  assert.deepEqual(t.findSimilar('validate user input form', 0.3, 0), [])
  assert.deepEqual(new SkillTree().findSimilar('validate user input form', 0.3, 5), [])
  const t2 = new SkillTree()
  mk(t2, 'skill-1', { Principle: 'validate user input email', Status: SkillStatus.Absorbed })
  assert.deepEqual(t2.findSimilar('validate user input form', 0.3, 5), [])
})

// ── Absorb：6 条合并规则 ─────────────────────────────────────────────────────

test('Absorb 规则 1/2/3/4/5/6 全量核对', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', 'fix-into', ['trig-a'], '')
  const absorbed = t.create('learned', 'sanitize html output', 'fix-abs', ['trig-b', 'trig-a'], '')
  const intoID = into.ID
  const intoPrinciple = into.Principle

  assert.equal(into.Score, 0.6)
  assert.equal(absorbed.Score, 0.3)
  assert.equal(t.absorb(absorbed.ID, into.ID), AbsorbOutcome.Succeeded)

  assert.equal(into.ID, intoID, '规则 1：ID 保留')
  assert.equal(into.Principle, intoPrinciple, '规则 1：Principle 保留')
  assert.deepEqual(into.Triggers, ['trig-a', 'trig-b'], '规则 2：追加且去重保序')
  assert.equal(into.Fix, 'fix-into\n\n---\n\nfix-abs', '规则 3：固定分隔符连接')
  assert.deepEqual(into.MergedFrom, [absorbed.ID], '规则 4：审计留痕')
  assert.equal(into.Score, 0.3 * 0.3 + 0.6 * 0.7, '规则 5：0.3/0.7 加权')
  assert.equal(into.Source, SkillSource.User, '规则 6：Source 不降级')
  // 被吸收方：留痕而非删除
  assert.equal(absorbed.Status, SkillStatus.Absorbed)
  assert.equal(absorbed.AbsorbedBy, into.ID)
  assert.ok(t.get(absorbed.ID), '仍在 Nodes 里（审计）')
})

test('Absorb 后 absorbed 从 prinIndex 摘掉 ⇒ findByPrinciple 不再命中它', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', '', [], '')
  const absorbed = t.create('learned', 'sanitize html output', '', [], '')
  assert.equal(t.findByPrinciple(absorbed.Principle), absorbed.ID)
  t.absorb(absorbed.ID, into.ID)
  assert.notEqual(t.findByPrinciple(absorbed.Principle), absorbed.ID)
})

test('Absorb 不合并检查 1：Exclusive ⇒ RejectedExclusive，双方不动', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', 'fix-into', ['a'], '')
  into.Exclusive = true
  const absorbed = t.create('learned', 'sanitize html output', 'fix-abs', ['b'], '')
  const score = into.Score
  assert.equal(t.absorb(absorbed.ID, into.ID), AbsorbOutcome.RejectedExclusive)
  assert.deepEqual(into.Triggers, ['a'])
  assert.equal(into.Fix, 'fix-into')
  assert.equal(into.Score, score)
  assert.equal(absorbed.Status, SkillStatus.Active)
})

test('Absorb 不合并检查 2：验证分下滑 ⇒ RejectedValidation + 留痕', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', 'fix-into', ['a'], '')
  const absorbed = t.create('learned', 'sanitize html output', 'fix-abs', ['b'], '')
  into.ValidationScore = 0.8
  absorbed.ValidationScore = 0.7 // beforeMin = 0.7
  const ev = new FixedEval({ Score: 0.1, Passed: false, Reason: 'held-out' })
  t.setEvaluator(ev)

  assert.equal(t.absorb(absorbed.ID, into.ID), AbsorbOutcome.RejectedValidation)
  // 门控看到的是**候选态**（已合并），但真节点一个字节都没改
  assert.equal(ev.seen.length, 1)
  assert.equal(ev.seen[0].Score, 0.3 * 0.3 + 0.6 * 0.7)
  assert.deepEqual(ev.seen[0].Triggers, ['a', 'b'])
  assert.equal(ev.seen[0].Fix, 'fix-into\n\n---\n\nfix-abs')
  assert.deepEqual(into.Triggers, ['a'], 'into 不得被门控污染')
  assert.equal(into.Fix, 'fix-into')
  assert.equal(into.Score, 0.6)
  assert.equal(absorbed.Status, SkillStatus.Active)
  // 留痕
  assert.equal(into.RejectedAttempts, 1)
  assert.deepEqual(t.Meta.RejectedEdits, [into.ID])
  assert.equal(REJECTED_EDITS_MAX, 20)
})

test('Absorb 门控：「无验证集」不算拦（IsEvalReady=false）', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', '', ['a'], '')
  const absorbed = t.create('learned', 'sanitize html output', '', ['b'], '')
  into.ValidationScore = 0.9
  absorbed.ValidationScore = 0.9
  for (const reason of [EvalReason.NoValidationSet, EvalReason.NoMatchingScenarios]) {
    t.setEvaluator(new FixedEval({ Score: 0.0, Passed: false, Reason: reason }))
    assert.equal(isEvalReady({ Score: 0, Passed: false, Reason: reason }), false)
    into.RejectedAttempts = 0
    assert.equal(t.absorb(absorbed.ID, into.ID), AbsorbOutcome.Succeeded)
  }
})

test('Absorb RejectedNotFound：任一 ID 不存在都不合并', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', '', [], '')
  assert.equal(t.absorb('skill-nope', into.ID), AbsorbOutcome.RejectedNotFound)
  assert.equal(t.absorb(into.ID, 'skill-nope'), AbsorbOutcome.RejectedNotFound)
  assert.equal(t.absorb('skill-x', 'skill-y'), AbsorbOutcome.RejectedNotFound)
})

test('Absorb 幂等：重复吸收不再重复记 MergedFrom', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', '', [], '')
  const absorbed = t.create('learned', 'sanitize html output', '', [], '')
  t.absorb(absorbed.ID, into.ID)
  t.absorb(absorbed.ID, into.ID)
  assert.deepEqual(into.MergedFrom, [absorbed.ID])
})

test('RejectedEdits 是上限 20 的环形缓冲', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', '', [], '')
  const absorbed = t.create('learned', 'sanitize html output', '', [], '')
  into.ValidationScore = 0.8
  absorbed.ValidationScore = 0.8
  t.setEvaluator(new FixedEval({ Score: 0.0, Passed: false, Reason: 'held-out' }))
  t.Meta.RejectedEdits = Array.from({ length: 25 }, (_, i) => `old-${i}`)
  assert.equal(t.absorb(absorbed.ID, into.ID), AbsorbOutcome.RejectedValidation)
  assert.equal(t.Meta.RejectedEdits.length, 20)
  assert.equal(t.Meta.RejectedEdits.at(-1), into.ID)
  assert.equal(t.Meta.RejectedEdits[0], 'old-6')
})

// ── Create：去重 + ID 生成 ───────────────────────────────────────────────────

test('Create 命中既有 principle ⇒ 返回同一节点，UseCount++ 并追加 triggers', () => {
  const t = new SkillTree()
  const a = t.create('learned', 'Validate user input', 'f', ['t1'], '')
  const b = t.create('user', 'validate user input', 'g', ['t1', 't2'], '')
  assert.equal(b, a)
  assert.equal(a.UseCount, 1)
  assert.deepEqual(a.Triggers, ['t1', 't2'])
  assert.equal(a.Fix, 'f', '去重命中不改 Fix/Source/Score')
  assert.equal(a.Source, SkillSource.Learned)
})

test('Create：ID 由 sanitizeID(principle) → triggers → randomSuffix 三级退化（⚠️W2）', () => {
  const t = new SkillTree()
  assert.equal(t.create('learned', 'Validate User Input', '', [], '').ID, 'skill-validate-user-input')
  // principle 全非 ASCII ⇒ sanitizeID 空 ⇒ 退化到 triggers join('-')
  const t2 = new SkillTree()
  assert.equal(t2.create('learned', '校验用户输入', '', ['alpha', 'beta'], '').ID, 'skill-alpha-beta')
  // ⚠️W2 两者都空 ⇒ 退化到 randomSuffix ⇒ **ID 由时间戳决定，不可复现**：
  //    两棵树各自 Create 同一个中文 principle，得到两个不同 ID ⇒ 跨脑/跨进程无法对齐。
  //    （注：同一毫秒内两次调用可能撞同一个后缀，Go 亦如此 ⇒ 这里只钉「来自时间戳」这一事实。）
  const t3 = new SkillTree()
  const t4 = new SkillTree()
  const a = t3.create('learned', '校验用户输入', '', [], '')
  const b = t4.create('learned', '校验用户输入', '', [], '')
  assert.match(a.ID, /^skill-\d{6}\.\d{6}$/)
  assert.match(b.ID, /^skill-\d{6}\.\d{6}$/)
  assert.match(randomSuffix(), /^\d{6}\.\d{6}$/)
})

test('⚠️W3 sanitizeID 与 sanitizeName 不同构（同输入两套 ID）', async () => {
  const { sanitizeID, sanitizeName } = await import('../lib/text/tokenize.js')
  // Create 走 sanitizeID：空格和冒号**都**变 '-'，且不折叠 ⇒ 双连字符
  const t = new SkillTree()
  assert.equal(t.create('learned', 'Review: Code', '', [], '').ID, 'skill-review--code')
  // Import 走 sanitizeName：冒号**丢弃** ⇒ 只剩单连字符；且它会折叠 '--'
  assert.equal(sanitizeID('Review: Code'), 'review--code')
  assert.equal(sanitizeName('Review: Code'), 'review-code')
  assert.notEqual(sanitizeID('Review: Code'), sanitizeName('Review: Code'), '⚠️W3 两个 ID 不同')
  // 冒号紧邻无空格时差异更明显：'-' vs 直接丢弃
  assert.equal(sanitizeID('a:b'), 'a-b')
  assert.equal(sanitizeName('a:b'), 'ab')
})

test('Create：Score/Status/Level 按 source 初始化', () => {
  const t = new SkillTree()
  assert.equal(t.create('user', 'alpha task flow', '', [], '').Score, 0.6)
  assert.equal(t.create('community', 'beta task flow', '', [], '').Score, 0.55)
  assert.equal(t.create('learned', 'gamma task flow', '', [], '').Score, 0.3)
  const n = t.create('shared', 'delta task flow', '', [], 'x')
  assert.equal(n.Status, SkillStatus.Active)
  assert.equal(n.Level, 1)
  assert.equal(n.Brain, 'x')
  assert.equal(n.SuccessRate, 0.5)
})

// ── MergeRemote：三级 ────────────────────────────────────────────────────────

test('MergeRemote Tier-1（ID 精确）/ Tier-2（principle 命中 + MergedFrom）/ Tier-3（新建 shared）', () => {
  const t = new SkillTree()
  const local = t.create('learned', 'Validate user input', '', [], 'b1')
  // Tier-1：同 ID
  t.mergeRemote(local.ID, 'whatever else here', 'remote-fix', 'b2')
  assert.equal(local.UseCount, 1)
  assert.equal(local.Fix, 'remote-fix')
  assert.equal(local.Brain, '', '两个脑不一致 ⇒ 清空')
  // Tier-2：不同 ID、同 principle
  const before = local.UseCount
  t.mergeRemote('skill-remote-x', 'validate user input', '', 'b2')
  assert.equal(local.UseCount, before + 1)
  assert.deepEqual(local.MergedFrom, ['skill-remote-x'])
  // Tier-3：全新 ⇒ source=shared，**初分写死 0.30**
  t.mergeRemote('skill-new', 'sanitize html output', 'f', 'b2')
  const fresh = t.get('skill-new')
  assert.equal(fresh.Source, SkillSource.Shared)
  assert.equal(fresh.Score, 0.3)
  assert.ok(fresh.Triggers.length > 0, 'Triggers 由 extractTriggerTokens 兜底生成')
})

// ── recordUse（Go Score）────────────────────────────────────────────────────

test('recordUse：+0.02 / −0.05、clamp、success_rate 滚动、自动升降级', () => {
  const t = new SkillTree()
  const n = t.create('learned', 'Validate user input', '', [], '')
  t.recordUse(n.ID, true)
  assert.equal(n.UseCount, 1)
  assert.equal(n.Score, 0.32)
  assert.equal(n.SuccessRate, 1)
  t.recordUse(n.ID, false)
  assert.equal(n.Score, 0.27)
  assert.equal(n.SuccessRate, 0.5)
  // 连败到 5 次 ⇒ 自动 demote（success_rate 已跌破 0.3）
  for (let i = 0; i < 3; i++) t.recordUse(n.ID, false)
  assert.equal(n.UseCount, 5)
  assert.equal(n.SuccessRate, 0.2) // (0.25*4)/5
  assert.ok(n.SuccessRate < 0.3)
  assert.equal(n.Status, SkillStatus.Demoted)
  // clamp：狂胜不超过 1，狂败不低于 0
  const t2 = new SkillTree()
  const hi = t2.create('learned', 'alpha task flow', '', [], '')
  for (let i = 0; i < 100; i++) t2.recordUse(hi.ID, true)
  assert.equal(hi.Score, 1)
  const lo = t2.create('learned', 'beta task flow', '', [], '')
  for (let i = 0; i < 100; i++) t2.recordUse(lo.ID, false)
  assert.equal(lo.Score, 0)
})

test('recordUse 兼容 skill name（无 skill- 前缀）—— 2026-08-13 静默失效的回归护栏', () => {
  const t = new SkillTree()
  const n = t.create('learned', 'pdf', '', [], '')
  assert.equal(n.ID, 'skill-pdf')
  t.recordUse('pdf', true) // 传的是 name，不是 ID
  assert.equal(n.UseCount, 1, '评分不能静默失效')
  t.recordUse('PDF', true)
  assert.equal(n.UseCount, 2)
  t.recordUse('skill_pdf', true) // _ → -
  assert.equal(n.UseCount, 3)
  t.recordUse('skill-nonexistent', true) // 不存在则静默忽略
})

// ── Lookup / 索引生命周期 ────────────────────────────────────────────────────

test('get / findByName / findBySourceFile / allNodes', () => {
  const t = new SkillTree()
  const a = t.create('learned', 'Validate user input', '', [], '')
  const b = mk(t, 'skill-arch', { Principle: 'old stuff here', Status: SkillStatus.Archived })
  b.SourceFile = 'skills/old.md'
  assert.equal(t.get(a.ID), a)
  assert.equal(t.get('skill-nope'), undefined)
  assert.equal(t.findByName('validate-user-input'), a)
  assert.equal(t.findBySourceFile('skills/old.md'), b)
  assert.equal(t.findBySourceFile('skills/none.md'), undefined)
  const ids = t.allNodes().map((n) => n.ID)
  assert.ok(ids.includes(a.ID))
  assert.ok(!ids.includes(b.ID), 'archived 被 AllNodes 过滤')
})

test('★plan §5⑪ prinIndex 不持久化：load() 后必须 rebuild 才查得到', () => {
  // 用 'pdf'（1 个 token、≤20 字节）：Tier-2/Tier-3 都进不去 ⇒ 只能靠 Tier-1 索引命中，
  // 这样才测得出「索引没了」；换一个三词 principle 会被 Tier-2 兜住，测不出。
  const t1 = new SkillTree()
  const n = t1.create('learned', 'pdf', '', [], '')
  const snap = t1.save()
  // 模拟「反序列化带不回 prinIndex」：新树只灌 Nodes，不 rebuild
  const t2 = new SkillTree()
  for (const [id, node] of Object.entries(snap.nodes)) t2.Nodes.set(id, node)
  assert.equal(t2.findByPrinciple('pdf'), undefined, '没 rebuild ⇒ 查不到')
  t2.rebuild()
  assert.equal(t2.findByPrinciple('pdf'), n.ID)
  // 走正规 load() 则自带 rebuild
  const t3 = new SkillTree()
  t3.load(snap)
  assert.equal(t3.findByPrinciple('pdf'), n.ID)
})

test('★plan §5⑩ save() 有 epoch++ 副作用', () => {
  const t = new SkillTree()
  assert.equal(t.epoch, 0)
  t.save()
  assert.equal(t.epoch, 1)
  t.save()
  assert.equal(t.epoch, 2)
  const snap = t.save()
  assert.equal(t.epoch, 3)
  assert.deepEqual(Object.keys(snap), ['nodes', 'meta'])
})

// ── 回归护栏：三级 + Absorb 联动 ─────────────────────────────────────────────

test('★ 吸收后 Tier-1 索引仍指向 into（同 principle 互吸会把索引删掉 —— ⚠️N3）', () => {
  const t = new SkillTree()
  const into = t.create('user', 'validate user input', '', [], '')
  const absorbed = t.create('learned', 'sanitize html output', '', [], '')
  assert.equal(t.absorb(absorbed.ID, into.ID), AbsorbOutcome.Succeeded)
  // into 自己的 principle 索引**不应该**被动过
  assert.equal(t.findByPrinciple('validate user input'), into.ID)
  // ⚠️N3：两个节点 principle 相同、且索引键当前指向 **into** 时，
  //   收尾那句 `delete(prinIndex, norm(absorbed.Principle))` 会把 **into 自己的索引**删掉。
  //   用 'pdf'（1 token、≤20 字节）造场景，使 Tier-2/Tier-3 都无法兜住 ⇒ 暴露为「查不到」。
  const t2 = new SkillTree()
  mk(t2, 'skill-dup', { Principle: 'pdf' })
  const x = mk(t2, 'skill-into', { Principle: 'pdf' }) // 后写 ⇒ prinIndex['pdf'] = skill-into
  assert.equal(t2.findByPrinciple('pdf'), x.ID)
  t2.absorb('skill-dup', 'skill-into')
  assert.equal(x.Status, SkillStatus.Active, 'into 仍活着、未被吸收')
  assert.equal(t2.findByPrinciple('pdf'), undefined, '⚠️N3：into 的索引被误删 ⇒ Tier-1 落空')
})
