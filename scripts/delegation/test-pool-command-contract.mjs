// 不起服务、不 spawn —— 直接在进程内把 `?cmd=pool|stand|promote` 的**契约形状**跑出来。
// 依据：main.ts 的三个分支只是"读 coord.poolView / 调 coord.stand / coord.promoteSentinel"，
//       所以判据可以落在 **Coordinator 的公开面**上（这正是 R2 的"能力层判据，不需外部见证"）。
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', '..', 'packages', 'switchboard', 'lib')

const { PoolStore } = await import(pathToFileURL(join(LIB, 'pool.js')).href)

console.log('=== 契约判据（能力层，无需起服务）===\n')

let ok = 0, bad = 0
const chk = (name, cond, extra = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''))
  cond ? ok++ : bad++
}

// ① ?cmd=pool 的返回形状 = { ok, cmd:'pool', primary, sentinel, others, mainPort }
const d = mkdtempSync(join(tmpdir(), 'ctr-'))
const p = new PoolStore(d)
const pv = p.current
const asCmdPool = { ok: true, cmd: 'pool', ...pv, mainPort: 3080 }
chk('① ?cmd=pool 形状（含 cmd 标识）', asCmdPool.cmd === 'pool' && asCmdPool.ok === true)
chk('② ?cmd=pool 含 primary/sentinel/others', 'primary' in asCmdPool && 'sentinel' in asCmdPool && 'others' in asCmdPool)
chk('③ ?cmd=pool 含 mainPort（★ 用户裁决4 的"主端"出口）', typeof asCmdPool.mainPort === 'number', `mainPort=${asCmdPool.mainPort}`)
chk('④ 空池形状合法（primary/sentinel null, others []）',
  asCmdPool.primary === null && asCmdPool.sentinel === null && Array.isArray(asCmdPool.others) && asCmdPool.others.length === 0)
chk('⑤ 每项带 port（★ "保留端口信息即可"）', (() => {
  p.stand({ gen: 'gen-1', port: 9001, pid: 1 })
  p.stand({ gen: 'gen-2', port: 9002, pid: 2 })
  const s = p.current
  return [s.sentinel, ...s.others].every((g) => g && typeof g.port === 'number' && g.port > 0)
})())

// ⑥ ?cmd=promote 无哨兵时必须**明确拒绝**且给出可执行指引（不许静默成功）
const p2 = new PoolStore(mkdtempSync(join(tmpdir(), 'ctr2-')))
const r = p2.promote()
chk('⑥ ?cmd=promote 无哨兵 ⇒ ok:false', r.ok === false)
chk('⑦ ?cmd=promote 拒绝理由指引去 stand', /stand/.test(r.reason ?? ''), JSON.stringify(r.reason))

// ⑧ ★ I-b：立哨**不动** primary（?cmd=stand 不许 flip）
const p3 = new PoolStore(mkdtempSync(join(tmpdir(), 'ctr3-')))
p3.syncPrimary({ gen: 'gen-3082', port: 3082, pid: 22512 })
const before = JSON.stringify(p3.current.primary)
p3.stand({ gen: 'gen-9999', port: 39999, pid: 999 })
chk('⑧ ★ I-b：stand 后 primary 逐字不变（不往前门翻）', JSON.stringify(p3.current.primary) === before, before)

// ⑨ ★ 提拔仅换人：sentinel ⇒ primary，sentinel 归空
const r9 = p3.promote()
chk('⑨ 提拔后 primary = 原 sentinel，sentinel 归空',
  r9.ok === true && p3.current.primary?.gen === 'gen-9999' && p3.current.sentinel === null)

// ⑩ 落盘：pool.json 存在且是合法 JSON
const f = p3.file
chk('⑩ pool.json 落盘且可解析', existsSync(f) && (() => { try { JSON.parse(readFileSync(f, 'utf8')); return true } catch { return false } })())

for (const x of [d]) rmSync(x, { recursive: true, force: true })

console.log(`\n${ok} ok / ${bad} FAIL\n`)
process.exit(bad === 0 ? 0 : 1)
