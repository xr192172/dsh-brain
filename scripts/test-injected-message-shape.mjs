#!/usr/bin/env node
/**
 * test-injected-message-shape.mjs —— 注入会话的消息**必须带身份**（回归守卫）
 *
 * ## 它守的是什么（2026-09-15 实事故）
 *
 * switchboard 换代时会往会话里注入"收尾/续跑"提示，旧代码是
 * `{ role: 'user', content: [...] }` —— **缺 `id` 与 `source`**。
 * 而 `dsh-session` 的 `assertMessageEventShape`（`lib/index.js:1246-1258`）要求
 * surface 事件的 `id` 是非空字符串、`source.kind` 是非空字符串
 * ⇒ 落盘后整份会话历史被判 `SessionPersistenceCorruptionError:
 *   session event at seq N lacks an identified message` ⇒ **永久读不出来**
 * （实测已废掉 `session-b79a6e91` 的 seq 5342）。
 *
 * ## 两段
 *
 * A. **直测**：import switchboard 编译产物里的 `injectedUserMessage`，
 *    按**校验器的原始条款**逐条断言（条款抄自上面那个函数，不是我编的）。
 * B. **反模式扫描**：扫我们自己的 `packages/<pkg>/src`，找"构造 user 消息却没带 id"的地方
 *    —— 防止同类问题在**别的**站点重新长出来（A 只保住了这一个函数）。
 *    ※ 注意：注释里别写 `packages` + `*` + `/src` 那种连写的通配路径 ——
 *      里面的 `*` `/` 会**提前闭合块注释**，报错还会指向后面某一行（踩过）。
 *
 * 用法：node scripts/test-injected-message-shape.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/project_develop/dsh-brain'
const LIB = path.join(REPO, 'packages/switchboard/lib/index.js')

let pass = 0
let fail = 0
const failures = []
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log('  FAIL ' + n + ' — ' + d) }
const truthy = (n, v, d = '') => (v ? ok(n) : bad(n, d || `期望为真，实得 ${JSON.stringify(v)}`))

// ── A. 直测工厂产物 ─────────────────────────────────────────────────────────
console.log('== A. injectedUserMessage 的产物是否满足校验器 ==')
if (!fs.existsSync(LIB)) {
  bad('编译产物存在', `${LIB} 不存在，先构建 switchboard`)
} else {
  const M = await import(pathToFileURL(LIB).href)
  const mk = M.injectedUserMessage
  if (typeof mk !== 'function') {
    bad('injectedUserMessage 已导出', '不是函数 —— 忘了 export？')
  } else {
    ok('injectedUserMessage 已导出')
    const msg = mk('测试文本')
    // 条款来自 dsh-session/lib/index.js:1246-1258 assertMessageEventShape
    truthy('id 是非空字符串（校验器第一条）', typeof msg.id === 'string' && msg.id !== '', JSON.stringify(msg.id))
    truthy('role === "user"', msg.role === 'user', String(msg.role))
    truthy('source 是对象且 source.kind 是非空字符串', typeof msg.source === 'object' && msg.source !== null && typeof msg.source.kind === 'string' && msg.source.kind !== '', JSON.stringify(msg.source))
    truthy('content 是数组', Array.isArray(msg.content), JSON.stringify(msg.content))
    truthy('content 里是我们给的文本', msg.content?.[0]?.text === '测试文本')
    // 不该被 agent-loop 的 isOwned() 误认成 system-prompt 的 runtime-context
    truthy('plugin 标签不是 dsh-system-prompt（避免被 isOwned 误认）', msg.source.plugin !== '@deepseek-ai/dsh-system-prompt', String(msg.source.plugin))
    // 每次调用给新身份（否则同一会话里两次注入会撞 id）
    truthy('两次调用 id 不同', mk('a').id !== mk('b').id)
  }
}

// ── B. 反模式扫描：我们自己的源码里有没有"裸 user 消息"──────────────────────
console.log('')
console.log('== B. 扫描我们自己的源码，找"构造 user 消息却没带 id"的反模式 ==')
const PKGS = path.join(REPO, 'packages')
const suspects = []
function walk(dir, depth) {
  if (depth > 4) return
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      // ★ 必须排除 out/ —— 那是构建产物与历史快照（`b<时间戳>/`）。
      //   不排除会把几十份旧构建一起扫进来 ⇒ 满屏**假红**（踩过）。
      if (['node_modules', 'lib', 'dist', 'out', '.git', 'coverage'].includes(e.name)) continue
      walk(p, depth + 1)
      continue
    }
    if (!/\.(ts|mts|js|mjs)$/.test(e.name)) continue
    const text = fs.readFileSync(p, 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      // 只找"对象字面量里出现 role:'user'"的行，且该行/邻域没有 id:
      if (!/role:\s*['"]user['"]/.test(line)) return
      const window = lines.slice(Math.max(0, i - 2), i + 6).join('\n')
      if (/\bid:\s/.test(window)) return          // 已有 id，放过
      // 排除类型声明/注释
      if (/^\s*(\/\/|\*)/.test(line)) return
      suspects.push({ file: path.relative(REPO, p), line: i + 1, text: line.trim().slice(0, 100) })
    })
  }
}
walk(PKGS, 0)

if (suspects.length) {
  bad('没有裸 user 消息', `${suspects.length} 处可疑：`)
  for (const s of suspects) console.log(`      ${s.file}:${s.line}  ${s.text}`)
} else {
  ok('我们自己的 packages/*/src 里没有"role:user 但无 id"的构造点')
}

console.log('')
console.log('=========================================')
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) for (const f of failures) console.log('  · ' + f)
process.exit(fail ? 1 : 0)
