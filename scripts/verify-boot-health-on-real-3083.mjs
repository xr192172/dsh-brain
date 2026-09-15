/**
 * 集成验证（非单测）：拿**真实磁盘上的 gen-3083 boot.log** 跑真实现，
 * 证明修复在原始证据上生效（而不是只在手搓夹具上生效）。
 *
 * 两个场景：
 *  A. 模拟"检查发生在崩溃文本落盘之前" —— 把日志截断到落盘时刻之前的状态，
 *     用真 lastBootSegment 读临时文件 ⇒ 应判 unknown（旧实现会判健康）。
 *  B. 完整文件 ⇒ 应判 fatal（因为该代确实崩了）。
 */
import fs from 'node:fs'
import { verifyBootHealth, lastBootSegment, findFatalBootErrors, hasReadySignal } from '../packages/switchboard/lib/boot-health.js'

const REAL = 'C:/Users/Admin/.dsh/switchboard/gen-3083/boot.log'
const TMP = 'D:/project_develop/dsh-brain/out/.tmp-real-3083.log'
const full = fs.readFileSync(REAL, 'utf8').replace(/^\uFEFF/, '')
const lines = full.split(/\r?\n/)

let mk = -1
for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('===== BOOT ')) mk = i
console.log('真实文件 gen-3083/boot.log：总行数', lines.length, '｜最后 BOOT 标记在第', mk + 1, '行')

const fakeClock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

// A. 落盘前状态：BOOT 标记后 18 行（实测崩溃文本在第 621 行 = 标记后第 23 行）
const earlyText = lines.slice(0, mk + 18).join('\n')
fs.writeFileSync(TMP, earlyText, 'utf8')
const segA = lastBootSegment(TMP)
console.log('')
console.log('== A. 崩溃文本落盘之前（标记后 18 行）==')
console.log('  真 lastBootSegment 读到行数 :', segA.split(/\r?\n/).length)
console.log('  命中致命模式               :', findFatalBootErrors(segA).join('、') || '(无)')
console.log('  有完成信号                 :', hasReadySignal(segA))
const rA = await verifyBootHealth({ readSegment: () => lastBootSegment(TMP) }, { timeoutMs: 6000, intervalMs: 250, ...fakeClock() })
console.log('  ⇒ 新判据 verdict           :', rA.verdict, `（等待 ${rA.waitedMs}ms）`)
console.log('  ⇒ 旧判据会给出的结论        : 健康 → 放行崩溃代 ★ 这就是漏判')

// B. 完整文件
console.log('')
console.log('== B. 完整真实文件（崩溃已落盘）==')
const segB = lastBootSegment(REAL)
console.log('  命中致命模式               :', findFatalBootErrors(segB).join('、'))
const rB = await verifyBootHealth({ readSegment: () => lastBootSegment(REAL) }, { timeoutMs: 6000, intervalMs: 250, ...fakeClock() })
console.log('  ⇒ 新判据 verdict           :', rB.verdict, `（等待 ${rB.waitedMs}ms，早退=${rB.waitedMs < 6000}）`)
console.log('  ⇒ 原因                     :', rB.fatal.join('、'))

fs.unlinkSync(TMP)

const okA = rA.verdict !== 'healthy'
const okB = rB.verdict === 'fatal' && rB.fatal.some((s) => s.includes('插件树加载失败'))
console.log('')
console.log(okA && okB ? '集成验证 PASS：真实证据上两种状态都被正确拦截' : '集成验证 FAIL')
process.exit(okA && okB ? 0 : 1)
