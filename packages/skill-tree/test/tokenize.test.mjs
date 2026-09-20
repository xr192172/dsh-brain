/**
 * L0 纯函数层单测 —— **口径钉死器**（2026-09-20）
 *
 * 跑法（先编译，lib/ 被 gitignore，不会污染仓库）：
 *   node node_modules/typescript/bin/tsc -p packages/skill-tree/tsconfig.json
 *   node --test packages/skill-tree/test/
 * 或：`npm test`（package.json 里已串好两步）。
 *
 * ★ 这些断言**不是**「期望行为」，而是「Go 侧既有行为的逐字镜像」，
 *   包括已知缺陷（D1~D4）。断言红了 = 口径漂了 = 去重结果不可复现。
 *   ⇒ 想改行为？先改这里的断言 + 在注释里写明「这是有意的口径变更」，再单独立项。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  byteLen,
  isStopword,
  tokenizePrinciple,
  jaccard,
  jaccardFromSets,
  normalizePrinciple,
  tokenize,
  sanitizeID,
  sanitizeName,
  extractTriggerTokens,
  mergeTriggers,
  mergeFix,
  MAX_ID_BYTES,
  FIX_SEPARATOR,
} from '../lib/text/tokenize.js'

const setOf = (...xs) => new Set(xs)

// ── A. 字节口径 ──────────────────────────────────────────────────────────────
test('A1 长度按 UTF-8 字节，不按 UTF-16 length', () => {
  assert.equal(byteLen('abc'), 3)
  assert.equal(byteLen('校验'), 6) // 2 汉字 = 6 字节，而 .length 是 2
  assert.equal(byteLen('校验'), '校验'.length * 3)
  assert.equal(byteLen(''), 0)
})

// ── B. tokenizePrinciple（去重主口径）────────────────────────────────────────
test('B1/B2/B3 分隔符=非 alnum；丢 ≤2 字节词；丢 stopword；返回集合', () => {
  const t = tokenizePrinciple('Validate user input, always.')
  assert.deepEqual(t, setOf('validate', 'user', 'input', 'always'))
  // 长度 ≤2 被丢（字节口径）
  assert.ok(!tokenizePrinciple('go to db now').has('go'))
  assert.ok(!tokenizePrinciple('go to db now').has('db'))
  // stopword 被丢
  assert.ok(!tokenizePrinciple('this is that which').has('this'))
  assert.ok(!tokenizePrinciple('this is that which').has('which'))
  // 集合去重：重复词只留一个
  assert.equal(tokenizePrinciple('user user user').size, 1)
})

test('B2 边界：刚好 3 字节的词保留，2 字节丢弃', () => {
  assert.deepEqual(tokenizePrinciple('abc'), setOf('abc'))
  assert.deepEqual(tokenizePrinciple('ab'), setOf())
  assert.equal(tokenizePrinciple('ab').size, 0)
})

test('B5 ★已知缺陷：CJK 永不成为 token（照 Go，改动=改去重结果）', () => {
  assert.equal(tokenizePrinciple('校验用户输入').size, 0)
  // 中英混排：只有英文部分留下
  assert.deepEqual(tokenizePrinciple('校验 user input 输入'), setOf('user', 'input'))
  // ⇒ 纯中文 principle 之间 jaccard 恒 0，Tier-2 恒不匹配
  assert.equal(jaccard(tokenizePrinciple('校验用户输入'), tokenizePrinciple('校验用户数据')), 0)
})

// ── C. jaccard ───────────────────────────────────────────────────────────────
test('C1 两集合都空 ⇒ 0（不是 NaN / 1）', () => {
  assert.equal(jaccard(setOf(), setOf()), 0)
  assert.equal(jaccard(setOf('a'), setOf()), 0)
  assert.equal(jaccard(setOf(), setOf('a')), 0)
  assert.ok(!Number.isNaN(jaccard(setOf(), setOf())))
})

test('C1 数值：|∩|/|∪|', () => {
  assert.equal(jaccard(setOf('a', 'b', 'c'), setOf('b', 'c', 'd')), 2 / 4)
  assert.equal(jaccard(setOf('a'), setOf('a')), 1)
  assert.equal(jaccard(setOf('a'), setOf('b')), 0)
})

test('C2 阈值口径：Tier-2 严格 >0.5，FindSimilar 用 >=minJaccard', () => {
  // 3 词交集 2、并集 4 ⇒ 0.5：Tier-2 的 >0.5 **不命中**，FindSimilar 的 >=0.5 **命中**
  const a = setOf('x', 'y', 'z')
  const b = setOf('y', 'z', 'w')
  const s = jaccard(a, b)
  assert.equal(s, 0.5)
  assert.equal(s > 0.5, false)
  assert.equal(s >= 0.5, true)
})

test('C3 jaccard 与 jaccardFromSets 是同一实现（Go 侧两份重复体）', () => {
  const a = setOf('p', 'q')
  const b = setOf('q', 'r')
  assert.equal(jaccard(a, b), jaccardFromSets(a, b))
})

// ── D1. normalizePrinciple ───────────────────────────────────────────────────
test('D1 ★已知缺陷：填充词朴素子串替换会误伤词尾（照 Go）', () => {
  // "data " 里的 "a " 被删 ⇒ datflow
  assert.equal(normalizePrinciple('Validate data flow'), 'validate datflow')
  // "human " 里的 "an " 被删 ⇒ "hum" 与后面的 "in" 直接拼成 "humin"
  assert.equal(normalizePrinciple('human in loop'), 'humin loop')
  // 正常路径
  assert.equal(normalizePrinciple('The Quick Fix'), 'quick fix')
  assert.equal(normalizePrinciple('  Trim Me  '), 'trim me')
})

test('Tier-3 判据是字节：len(norm) > 20', () => {
  // 7 个汉字 = 21 字节 ⇒ 进 Tier-3；7 个字母 = 7 字节 ⇒ 不进
  assert.ok(byteLen(normalizePrinciple('校验用户输入的边界情况啊')) > 20)
  assert.ok(byteLen(normalizePrinciple('abcdefg')) <= 20)
})

// ── E. tokenize（检索用，≠ tokenizePrinciple）────────────────────────────────
test('E2 tokenize 只按 7 个分隔符切，无 stopword、无去重、保留 CJK', () => {
  assert.deepEqual(tokenize('Hello, World! Yes?'), ['hello', 'world', 'yes'])
  // 保留重复项（与 tokenizePrinciple 的集合语义相反）
  assert.deepEqual(tokenize('user user'), ['user', 'user'])
  // 无 stopword 过滤：the/this 会留下（长度 >2）
  assert.ok(tokenize('this that').includes('this'))
  // CJK 保留（因为分隔符只有 7 个）
  assert.ok(tokenize('校验用户输入').includes('校验用户输入'))
  // 长度按字节：单个汉字 3 字节 > 2 ⇒ 保留
  assert.deepEqual(tokenize('校验'), ['校验'])
  // \t 不是分隔符
  assert.deepEqual(tokenize('aa\tbb'), ['aa\tbb'])
})

// ── D2/D3. sanitizeID / sanitizeName ─────────────────────────────────────────
test('sanitizeID 映射规则 + 80 字节截断 + 修剪首尾连字符', () => {
  assert.equal(sanitizeID('My Skill'), 'my-skill')
  assert.equal(sanitizeID('A:B_C D!'), 'a-b-c-d')
  assert.equal(sanitizeID('---x---'), 'x')
  assert.equal(MAX_ID_BYTES, 80)
  assert.equal(sanitizeID('a'.repeat(200)).length, 80)
  // 空格/冒号/下划线 → '-'；其余丢弃
  assert.equal(sanitizeID('Code Review! 2'), 'code-review-2')
})

test('D3 ★已知缺陷：全非 ASCII 输入 ⇒ 空串 ⇒ 调用方退化 randomSuffix（ID 不可复现）', () => {
  assert.equal(sanitizeID('校验用户输入'), '')
  assert.equal(sanitizeID('校验'), '')
  // 与 Go 一致：id == "skill-" 时 Create 会改走 triggers join，再不行就 randomSuffix
  assert.equal('skill-' + sanitizeID('校验用户输入'), 'skill-')
})

test('D2 ★已知缺陷：sanitizeID 与 sanitizeName 不同构（照 Go，改名会打断既有数据）', () => {
  // ':' ：sanitizeID → '-'，sanitizeName → 丢弃
  assert.equal(sanitizeID('a:b'), 'a-b')
  assert.equal(sanitizeName('a:b'), 'ab')
  // '--' 折叠：只有 sanitizeName 做
  assert.equal(sanitizeID('Test--Skill'), 'test--skill')
  assert.equal(sanitizeName('Test--Skill'), 'test-skill')
})

test('sanitizeName（对齐 Go 单测 skill_import_test.go:347 的四个用例）', () => {
  assert.equal(sanitizeName('My Skill'), 'my-skill')
  assert.equal(sanitizeName('Code Review!'), 'code-review')
  assert.equal(sanitizeName('Test--Skill'), 'test-skill')
  assert.equal(sanitizeName('multi  space'), 'multi-space')
})

// ── extractTriggerTokens ─────────────────────────────────────────────────────
test('extractTriggerTokens：切分 + 小写 + 去重 + 最多 5 个', () => {
  const t = extractTriggerTokens('bash /dev/null not found on Windows')
  assert.deepEqual(t, ['bash', 'dev', 'null', 'not', 'found'])
  assert.equal(t.length, 5)
  assert.ok(t.every((x) => byteLen(x) > 2))
})

test('extractTriggerTokens 兜底：3 字节一块，尾部残余丢弃，最多 5 块', () => {
  const t = extractTriggerTokens('a b c d e f g h i j k')
  assert.ok(t.length > 0)
  assert.ok(t.length <= 5)
  // 注意：兜底块**不做 trim**，块里带着空格（Go 只有主路径的 word 会 TrimSpace）
  assert.deepEqual(t, ['a b', ' c ', 'd e', ' f ', 'g h'])
  // 尾部不足 3 字节的残余（这里是 "k"）被丢弃 —— 照 Go 的 i <= len-3
  assert.ok(!t.some((x) => x.includes('k')))
})

test('extractTriggerTokens 兜底按 60 字节截断', () => {
  const t = extractTriggerTokens('a '.repeat(100))
  assert.equal(t.length, 5)
  assert.ok(byteLen(t.join('')) <= 60)
})

test('extractTriggerTokens：CJK 长词会被保留（不进兜底）', () => {
  const t = extractTriggerTokens('校验用户输入')
  assert.deepEqual(t, ['校验用户输入'])
})

// ── 合并原语 ─────────────────────────────────────────────────────────────────
test('mergeTriggers：保序去重，不改入参', () => {
  const dst = ['b', 'a']
  const src = ['a', 'c']
  assert.deepEqual(mergeTriggers(dst, src), ['b', 'a', 'c'])
  assert.deepEqual(dst, ['b', 'a'], '入参不得被修改')
  assert.deepEqual(mergeTriggers([], []), [])
})

test('mergeFix：空串语义 + 固定分隔符', () => {
  assert.equal(FIX_SEPARATOR, '\n\n---\n\n')
  assert.equal(mergeFix('', 'b'), 'b')
  assert.equal(mergeFix('a', ''), 'a')
  assert.equal(mergeFix('', ''), '')
  assert.equal(mergeFix('a', 'b'), 'a\n\n---\n\nb')
})

// ── 回归护栏：去重三级联动（口径一漂这条最先红）────────────────────────────
test('★ Go 注释与实现不符：它自称能捕获的改写，实际被 >0.5 漏掉', () => {
  // skill_tree.go:601 的注释写「Catches rephrasings like "validate user input"
  // vs "input validation for user"」—— 但实测 jaccard 恰好 = 0.5，
  // 而 Tier-2 的判据是**严格 > 0.5** ⇒ 这句经典改写**命中不了**。
  const a = tokenizePrinciple('validate user input') // {validate,user,input}
  const b = tokenizePrinciple('input validation for user') // {input,validation,user}（for 是 stopword）
  assert.equal(jaccard(a, b), 0.5)
  assert.equal(jaccard(a, b) > 0.5, false, 'Tier-2 漏判 —— 这是 Go 侧注释与阈值不一致')
  // 只有把阈值放宽到 >=0.5（FindSimilar 的 minJaccard 语义）才会命中
  assert.equal(jaccard(a, b) >= 0.5, true)
})
