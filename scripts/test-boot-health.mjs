/**
 * test-boot-health.mjs —— 启动健康判据回归（钉住 gen-3083 漏判）
 *
 * ## 为什么这个测试必须存在
 *
 * `verify-boot-health` 是**事故的保险本身**。2026-09-14 它失效了：
 * gen-3083 因 `capability-bridge` 缺 `config:` 崩溃（`EXIT code=1`），
 * 但 switchboard 记的是 `result:success · 已快速切换 → gen-3083`，
 * 于是这个"能力残缺且随即死亡"的代接了会话。
 *
 * 保险失效比事故更危险 —— 事故会被发现，失效不会。所以把它做成可执行夹具：
 * 下面每个用例都对应一个**真实观测到的时间戳/文本**，而不是想象中的边界。
 *
 * ## 核心断言（按重要性）
 *
 * 1. **gen-3083 证据重放**：喂"崩溃前那一段"（致命文本尚未落盘）⇒ 必须【不】判健康。
 *    这是旧实现必然失败、新实现必须通过的用例 —— 即本次修复的**出生证明**。
 * 2. **崩溃文本齐了 ⇒ fatal，且早退**（不把 6s 窗口耗满）。
 * 3. **健康启动 ⇒ healthy**（正向信号出现即返回，不空等）。
 * 4. **进程已死 ⇒ fatal**（不等日志）。
 *
 * 用法：node scripts/test-boot-health.mjs
 */
import fs from 'node:fs'
import {
  verifyBootHealth,
  findFatalBootErrors,
  hasReadySignal,
  lastBootSegment,
} from '../packages/switchboard/lib/boot-health.js'

const OUT = 'D:/project_develop/dsh-brain/out/test-boot-health.txt'
const log = []
let pass = 0
let fail = 0

const say = (s) => {
  log.push(String(s))
  console.log(String(s).split('\n').slice(0, 3).join(' | ').slice(0, 200))
}
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    say(`  ok   ${name}`)
  } else {
    fail++
    say(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

/** 纯内存 probe：按调用次数依次返回预设段（模拟"日志逐步落盘"）。 */
function scriptedProbe(segments) {
  let i = 0
  return {
    readCount: () => i,
    readSegment: () => {
      const s = segments[Math.min(i, segments.length - 1)]
      i++
      return s
    },
  }
}

/** 可控时钟：sleep 推进虚拟时间，使测试瞬时完成。 */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具文本：全部取自磁盘真实内容，非杜撰
// ─────────────────────────────────────────────────────────────────────────────

/** gen-3083 boot.log 的最后启动段**开头**（BOOT 标记 + 正常插件日志，致命文本尚未出现）。 */
const GEN3083_SEGMENT_EARLY = [
  '===== BOOT gen=gen-3083 port=3083 mode=staging at=2026-09-14T08:25:31.328Z =====',
  'Debugger listening on ws://127.0.0.1:32812/a9ed31dd-f804-4c77-86ef-212fdcf5b17e',
  '[tool-evolution] registered custom session event type: tool/review',
  '[switchboard:agent] apply; gen=gen-3083 admin=31812 mode=staging brains=left/right',
  '[key-pool-proxy] listening 127.0.0.1:3101 -> https://apihub.agnes-ai.com (pool=3)',
  '[design-canvas-bridge] config: serverName=design-canvas kernelDir="D:\\\\project_develop\\\\design-canvas" enabled=true',
  '[design-canvas v0.1.3] MCP server started (stdio)',
  '',
].join('\n')

/** gen-3083 落盘后的**致命尾部**（原样摘自 boot.log:621-623）。 */
const GEN3083_FATAL_TAIL = [
  'file:///D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1201',
  '\t\tthrow new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause });',
  '',
  'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry capability-bridge (@dsh-brain/capability-bridge): invalid config:',
  '  - Invalid input: expected object, received undefined (at )',
  'ValidationError: invalid config:',
  '  - Invalid input: expected object, received undefined (at )',
  'Node.js v24.20.0',
].join('\n')

/** gen-3095 成功 boot.log 的末行（正向完成信号）。 */
const READY_LINE = 'dsh web: http://127.0.0.1:3095'

const HEALTHY_SEGMENT = [
  '===== BOOT gen=gen-3095 port=3095 mode=staging at=2026-09-14T09:1x:xx.xxxZ =====',
  '[design-canvas-bridge] apply running; 预热工具=mcp__design-canvas__import_project enabled=true',
  '[design-canvas v0.1.3] MCP server started (stdio)',
  READY_LINE,
  '',
].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// 1. 纯函数层
// ─────────────────────────────────────────────────────────────────────────────
say('== 1. 纯函数：致命模式 / 正向信号 ==')

check('致命尾部命中「插件树加载失败」', findFatalBootErrors(GEN3083_FATAL_TAIL).includes('插件树加载失败'))
check(
  '致命尾部命中「loader entry include 应用失败」',
  findFatalBootErrors(GEN3083_FATAL_TAIL).includes('loader entry include 应用失败'),
)
check(
  '致命尾部命中「插件配置校验失败」（新增裸根因模式）',
  findFatalBootErrors(GEN3083_FATAL_TAIL).includes('插件配置校验失败（Config schema 拒绝）'),
)
check(
  '致命尾部命中「Node 版本号后退出」（新增进程死亡标记）',
  findFatalBootErrors(GEN3083_FATAL_TAIL).includes('进程因未捕获异常退出（Node 打印版本号后退出）'),
)
check('★ 崩溃前那一段【无】致命模式（这正是漏判的成因）', findFatalBootErrors(GEN3083_SEGMENT_EARLY).length === 0)
check('★ 崩溃前那一段【无】正向信号（能区分"干净"与"没写完"）', hasReadySignal(GEN3083_SEGMENT_EARLY) === false)
check('健康段【有】正向信号', hasReadySignal(HEALTHY_SEGMENT) === true)
check('健康段【无】致命模式', findFatalBootErrors(HEALTHY_SEGMENT).length === 0)

// ─────────────────────────────────────────────────────────────────────────────
// 2. ★ 出生证明：gen-3083 证据重放
// ─────────────────────────────────────────────────────────────────────────────
say('')
say('== 2. ★ gen-3083 重放：崩溃文本晚于检查落盘 ==')

{
  // 日志"还没写完"：整个窗口内只看到干净段。
  const probe = scriptedProbe([GEN3083_SEGMENT_EARLY])
  const clock = fakeClock()
  const r = await verifyBootHealth(probe, { timeoutMs: 6000, intervalMs: 250, ...clock })
  check(
    '旧实现会判 ok 的输入 ⇒ 新实现判 unknown（欠证据，不放行）',
    r.verdict === 'unknown',
    `实际 verdict=${r.verdict}`,
  )
  check('unknown 时 readySeen=false', r.readySeen === false)
  check('确实等满了窗口（未早退）', r.waitedMs === 6000, `waitedMs=${r.waitedMs}`)
  check('窗口内发生了多次重读（不是读一次就定论）', probe.readCount() > 1, `readCount=${probe.readCount()}`)
}

{
  // 真实时序：先读到干净段，约 3.4s 后崩溃文本落盘。
  const probe = scriptedProbe([
    GEN3083_SEGMENT_EARLY,
    GEN3083_SEGMENT_EARLY,
    GEN3083_SEGMENT_EARLY + '\n' + GEN3083_FATAL_TAIL,
  ])
  const clock = fakeClock()
  const r = await verifyBootHealth(probe, { timeoutMs: 6000, intervalMs: 250, ...clock })
  check('★ 崩溃文本落盘后被捕获 ⇒ fatal', r.verdict === 'fatal', `实际 verdict=${r.verdict}`)
  check('fatal 原因可读', r.fatal.length > 0 && r.fatal.some((s) => s.includes('插件树加载失败')))
  check('fatal 早退（未耗满 6s 窗口）', r.waitedMs < 6000, `waitedMs=${r.waitedMs}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 健康启动
// ─────────────────────────────────────────────────────────────────────────────
say('')
say('== 3. 健康启动：正向信号出现即返回 ==')

{
  const probe = scriptedProbe([HEALTHY_SEGMENT])
  const clock = fakeClock()
  const r = await verifyBootHealth(probe, { timeoutMs: 6000, intervalMs: 250, ...clock })
  check('healthy', r.verdict === 'healthy', `实际 verdict=${r.verdict}`)
  check('readySeen=true', r.readySeen === true)
  check('首轮即返回（waitedMs=0）', r.waitedMs === 0, `waitedMs=${r.waitedMs}`)
  check('只读一次', probe.readCount() === 1, `readCount=${probe.readCount()}`)
}

{
  // 慢启动：前几轮只有部分日志，最后才出现完成信号。
  const probe = scriptedProbe([
    '===== BOOT gen=gen-3099 =====',
    '[design-canvas-bridge] apply running',
    HEALTHY_SEGMENT,
  ])
  const clock = fakeClock()
  const r = await verifyBootHealth(probe, { timeoutMs: 6000, intervalMs: 250, ...clock })
  check('慢启动最终 healthy', r.verdict === 'healthy', `实际 verdict=${r.verdict}`)
  check('慢启动等待 > 0 且 < 窗口', r.waitedMs > 0 && r.waitedMs < 6000, `waitedMs=${r.waitedMs}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 进程死亡 ⇒ 不等日志
// ─────────────────────────────────────────────────────────────────────────────
say('')
say('== 4. 进程已死：立即 fatal，不空等 ==')

{
  const probe = scriptedProbe([GEN3083_SEGMENT_EARLY])
  const clock = fakeClock()
  const r = await verifyBootHealth(probe, {
    timeoutMs: 6000,
    intervalMs: 250,
    ...clock,
    isAlive: () => false,
  })
  check('进程已死 ⇒ fatal', r.verdict === 'fatal', `实际 verdict=${r.verdict}`)
  check('原因含「进程已退出」', r.fatal.some((s) => s.includes('进程已退出')), r.fatal.join('、'))
  check('未空等（waitedMs=0）', r.waitedMs === 0, `waitedMs=${r.waitedMs}`)
  check('未做无意义重读', probe.readCount() === 1, `readCount=${probe.readCount()}`)
}

{
  // ★ hasExited 优先于 isAlive：即便 isAlive 说"还活着"（Windows PID 未回收的窗口期），
  //   只要 exitCode 已回填就必须判死。
  const probe = scriptedProbe([GEN3083_SEGMENT_EARLY])
  const clock = fakeClock()
  const r = await verifyBootHealth(probe, {
    timeoutMs: 6000,
    intervalMs: 250,
    ...clock,
    hasExited: () => true,
    isAlive: () => true, // 故意撒谎：模拟 PID 尚未回收
  })
  check('★ exitCode 已回填 ⇒ 判死（不被 isAlive 的谎言掩盖）', r.verdict === 'fatal', `实际 verdict=${r.verdict}`)
  check('hasExited 路径也早退', r.waitedMs === 0, `waitedMs=${r.waitedMs}`)
}

{
  // 回归：仅给 hasExited=false 时不得误判死。
  const probe = scriptedProbe([HEALTHY_SEGMENT])
  const clock = fakeClock()
  const r = await verifyBootHealth(probe, {
    timeoutMs: 6000,
    intervalMs: 250,
    ...clock,
    hasExited: () => false,
  })
  check('hasExited=false + 有完成信号 ⇒ healthy（不误判）', r.verdict === 'healthy', `实际 verdict=${r.verdict}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. lastBootSegment：按 BOOT 标记切段（不误吞历史失败）
// ─────────────────────────────────────────────────────────────────────────────
say('')
say('== 5. lastBootSegment：历史失败不得误判本次 ==')

{
  const tmp = 'D:/project_develop/dsh-brain/out/.tmp-boot-health-seg.log'
  const content = [
    '===== BOOT gen=gen-3083 at=2026-09-14T08:00:00.000Z =====',
    'Error: dsh: plugin tree failed to load: 历史启动的失败',
    '',
    '===== BOOT gen=gen-3095 at=2026-09-14T09:00:00.000Z =====',
    '[design-canvas v0.1.3] MCP server started (stdio)',
    'dsh web: http://127.0.0.1:3095',
    '',
  ].join('\n')
  fs.writeFileSync(tmp, content, 'utf8')

  const seg = lastBootSegment(tmp)
  check('切成最后一段', seg.startsWith('===== BOOT gen=gen-3095'))
  check('★ 不含历史失败文本', !seg.includes('历史启动的失败'))
  check('最后一段判为健康（历史失败未污染）', findFatalBootErrors(seg).length === 0 && hasReadySignal(seg))
  fs.unlinkSync(tmp)
}

{
  check('不存在的日志 ⇒ 空串', lastBootSegment('D:/project_develop/dsh-brain/out/.no-such-boot.log') === '')
}

// ─────────────────────────────────────────────────────────────────────────────
say('')
say(`结果：${pass} passed, ${fail} failed`)
fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
fs.writeFileSync(OUT, log.join('\n'), 'utf8')
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'} -> ${OUT}`)
process.exit(fail === 0 ? 0 : 1)
