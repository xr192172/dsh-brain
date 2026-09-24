/**
 * 格⑮ · **独立**丢弃核验（判据 5 的"进程真死"）。
 *
 * ★ 为什么需要它：报告里的 `discarded={stopped,pidGone,adminDead}` 是**引擎自述**。
 *   自述可以因为代码 bug 而说谎（例如 pidAlive() 写错）。所以这里**换一种独立方法**再测一遍：
 *     · PID 存活：`process.kill(pid, 0)`（EPERM 视为存活）——不读报告的 pidGone 字段；
 *     · admin 死没死：直接 fetch 那个 adminPort，超时/拒连 = 死。
 *   两条独立读数与报告自述**交叉验证**：一致才算这一条过。
 *
 * 用法：node out/_replay/run/verify-discard.mjs <report1.json> [report2.json ...]
 *   退出码 0 = 全部通过；1 = 有反例。
 */
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: verify-discard.mjs <report.json> ...')
  process.exit(2)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

let bad = 0
console.log('file\tgen\tpid\tPID存活(独立)\tadmin应答(独立)\t报告自述\t判定')
for (const f of files) {
  let raw
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    console.log(`${f}\t-\t-\t-\t-\t-\tREAD_FAIL: ${e.message}`)
    bad++
    continue
  }
  const j = raw?.report ?? raw
  if (!j || !j.rehearsal) {
    console.log(`${f}\t-\t-\t-\t-\t-\tNO_REPORT`)
    bad++
    continue
  }
  const pid = j.rehearsal.pid
  const adminPort = j.rehearsal.adminPort
  const gen = j.rehearsal.gen

  const alive = pid > 0 ? pidAlive(pid) : false
  let adminAnswers = false
  try {
    const r = await fetch(`http://127.0.0.1:${adminPort}/admin/health`, { signal: AbortSignal.timeout(1500) })
    adminAnswers = r.status > 0
  } catch {
    adminAnswers = false
  }

  const selfClaim = j.discarded
  const selfOk = selfClaim?.stopped === true && selfClaim?.pidGone === true && selfClaim?.adminDead === true
  const independentOk = !alive && !adminAnswers
  const verdict = independentOk && selfOk ? 'PASS' : 'MISMATCH'
  if (verdict !== 'PASS') bad++

  console.log(
    `${f.split(/[\\/]/).pop()}\t${gen}\t${pid}\t${alive ? 'ALIVE!!' : 'gone'}\t${adminAnswers ? 'ANSWERS!!' : 'dead'}\t` +
      `${selfOk ? 'stopped/pidGone/adminDead=true' : JSON.stringify(selfClaim)}\t${verdict}`,
  )
}

console.log('')
if (bad === 0) console.log(`独立丢弃核验：${files.length}/${files.length} 全部通过（进程真死、admin 真不应答、与报告自述一致）`)
else console.log(`独立丢弃核验：${bad}/${files.length} 条不符（见上）`)
process.exit(bad === 0 ? 0 : 1)
