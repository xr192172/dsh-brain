#!/usr/bin/env node
/**
 * test-gen-port-alloc.mjs —— 「gen 端口分配必须避开保留端口」的回归守卫（2026-09-20 事故）
 *
 * ## 守的是什么
 *
 * 现场：handover 连试 3 次恒 `b-not-ready`，旧代一直服务。真因是 **gen 的编号就是它自己的
 * 监听端口**（`gen-3100` → `--port 3100`），而 **3101 是 key-pool-proxy 的固定监听口**
 * （活跃代会在自己进程里再占一个 3101）⇒ 编号递增到 3101 的那一代要**同时**绑两个 3101
 * ⇒ **必然 EADDRINUSE** ⇒ 这一代永远起不来。
 *
 * 修法：`coordinator.ts` 的 `allocGenPort(portBase, slot)` 跳过 `RESERVED_GEN_PORTS`。
 *
 * ## 判据（两方向）
 *
 *  - **该绿的不红**：3101 被跳过；slot→port 严格单调递增（不撞车）；前若干个端口与"未修前"一致
 *    （回归：修法不能挪动本来没问题的号）。
 *  - **该红的红**：把"朴素分配 portBase+slot"喂进去必须**报 3101** —— 否则这道门只是句口号。
 *  - **接线**：`coordinator.ts` 的 handover 必须走 `allocGenPort`（不许有人绕过它再算一份端口）。
 *
 * 用法：node scripts/test-gen-port-alloc.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/project_develop/dsh-brain'
const LIB = path.join(REPO, 'packages/switchboard/lib/coordinator.js')
const SRC = path.join(REPO, 'packages/switchboard/src/coordinator.ts')
/** 现役控制面的实测配置：GEN_PORT_BASE=3098 ⇒ bootstrap gen-3099，handover 代从 gen-3100 起。 */
const PORT_BASE = 3098

let pass = 0
let fail = 0
const failures = []
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; failures.push(`${n} — ${d}`); console.log('  FAIL ' + n + ' — ' + d) }
const eq = (n, got, want) => (got === want ? ok(n) : bad(n, `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`))

// ── A. 直测 allocGenPort ───────────────────────────────────────────────────
console.log('== A. allocGenPort：跳过保留端口 ==')
if (!fs.existsSync(LIB)) {
  bad('编译产物存在', `${LIB} 不存在 —— 先构建 switchboard（packages/switchboard/scripts/build.mjs）`)
} else {
  const { allocGenPort, RESERVED_GEN_PORTS } = await import(pathToFileURL(LIB).href)
  eq('allocGenPort / RESERVED_GEN_PORTS 已导出', typeof allocGenPort === 'function' && Array.isArray(RESERVED_GEN_PORTS), true)
  eq('3101 在保留端口集合里（key-pool-proxy）', RESERVED_GEN_PORTS.includes(3101), true)

  // 第 1 个 handover 代：portBase=3098 → slot=2 → 3100（与修法前一致，不能有回归漂移）
  eq('slot 2 → 3100（未撞号时与旧实现一致）', allocGenPort(PORT_BASE, 2), 3100)
  // ★ 事故那代：slot=3 朴素算出来正好是 3101 ⇒ 必须被推开
  eq('slot 3 不得落在保留端口 3101', allocGenPort(PORT_BASE, 3) === 3101, false)
  eq('slot 3 → 3102（跳过 3101）', allocGenPort(PORT_BASE, 3), 3102)
  // ★ 关键：跳过之后不能与下一个 slot 撞车（"撞上就 +1"的朴素修法会让 slot 3/4 都变 3102）
  eq('slot 4 不与 slot 3 撞车（3103）', allocGenPort(PORT_BASE, 4), 3103)

  // 整段扫描：slot 1..60 全都不落在保留端口上，且严格单调递增（单射）
  const ports = []
  for (let slot = 1; slot <= 60; slot++) ports.push(allocGenPort(PORT_BASE, slot))
  const hitReserved = ports.filter((p) => RESERVED_GEN_PORTS.includes(p))
  eq('slot 1..60 无一落在保留端口上', hitReserved.length, 0)
  const strictlyIncreasing = ports.every((p, i) => i === 0 || p > ports[i - 1])
  eq('slot→port 严格单调递增（不会两代同号）', strictlyIncreasing, true)

  // 换一个基址也要成立（保留端口是**绝对端口号**，不随 portBase 漂移）
  const b2 = 3081 // tsconfig 默认 GEN_PORT_BASE
  const ports2 = []
  for (let slot = 1; slot <= 40; slot++) ports2.push(allocGenPort(b2, slot))
  eq('portBase=3081 时同样跳过 3101', ports2.includes(3101), false)
  eq('portBase=3081 时仍严格单调递增', ports2.every((p, i) => i === 0 || p > ports2[i - 1]), true)
}

// ── B. 两方向：朴素实现必须被判红 ──────────────────────────────────────────
console.log('== B. 反例：朴素分配必须撞 3101（证明 A 段有眼） ==')
const naive = (portBase, slot) => portBase + slot // 修法前的实现
eq('朴素实现在 slot=3 撞上 3101（事故形态）', naive(PORT_BASE, 3), 3101)
{
  const naivePorts = []
  for (let slot = 1; slot <= 60; slot++) naivePorts.push(naive(PORT_BASE, slot))
  eq('朴素实现在这段里确实会撞保留端口', naivePorts.includes(3101), true)
}

// ── C. 接线：handover 必须走 allocGenPort ──────────────────────────────────
console.log('== C. 接线：coordinator 的端口分配不许绕过 allocGenPort ==')
if (!fs.existsSync(SRC)) {
  bad('源码可读', `${SRC} 不存在`)
} else {
  const src = fs.readFileSync(SRC, 'utf8')
  eq('handover 侧调用 allocGenPort(...)', /allocGenPort\(/.test(src), true)
  // 旧写法：`const port = cfg.portBase + this.genCounter + 1` —— 它绕过分配器，必须已消失
  eq('不再有 portBase + genCounter 的裸算端口', /portBase\s*\+\s*this\.genCounter\s*\+\s*1/.test(src), false)
  // gen 编号必须继续等于本代端口（boot.log/目录名/真机验证都按这个不变量找）
  eq('gen 编号仍由端口反推（gen-${port}）', /gen-\$\{port\}/.test(src), true)
  eq('abort 把 boot.log 错因带进 result.note', /bootErrorHint\(/.test(src) && /boot:\s/.test(src), true)
}

console.log('')
console.log(`结果：${pass} passed, ${fail} failed`)
if (fail) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
