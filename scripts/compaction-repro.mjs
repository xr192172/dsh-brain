// compaction-repro.mjs — 离线精确复现压缩崩溃。
// 用真实 Session（构造时会完整校验 surface 折叠）+ 真实 tool-pairing 函数 + 真实 TokenMeter，
// 驱动 compaction 的校验/提交路径，抓取真实堆栈。
// 用法： node scripts/compaction-repro.mjs <sessionDirRelPath> [--upto <seq>]
import fs from 'node:fs'
import path from 'node:path'
import { decompress } from 'fzstd'

const root = 'C:/Users/Admin/.dsh/sessions'
const rel = process.argv[2]
const OUT = 'D:/project_develop/dsh-brain/out/comp-repro.txt'
const buf = []
const log = (...a) => { buf.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
const flush = () => fs.writeFileSync(OUT, buf.join('\n'), 'utf8')
process.on('exit', flush)

const upToIdx = process.argv.indexOf('--upto')
const upto = upToIdx > 0 ? Number(process.argv[upToIdx + 1]) : Number.POSITIVE_INFINITY

const file = path.join(root, rel, 'session.jsonl.zstd')
const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
const all = []
for (const l of text.split('\n')) { if (!l.trim()) continue; try { all.push(JSON.parse(l)) } catch {} }
const events = all.filter((e) => typeof e.seq === 'number' && e.seq <= upto)
log(`parsed ${all.length} records; ${events.length} carry a numeric seq (upto ${upto})`)
log(`first seq=${events[0]?.seq} last seq=${events[events.length - 1]?.seq}`)
{
  const contig = []
  events.forEach((e, i) => { if (e.seq !== i) contig.push(`idx ${i} has seq ${e.seq}`) })
  log('seq contiguity from 0: ' + (contig.length ? 'BROKEN -> ' + contig.slice(0, 5).join('; ') : 'OK'))
}

const show = (label, e) => {
  log(`\n########## ${label} ##########`)
  log(String(e && e.stack ? e.stack : e).slice(0, 2500))
}

// ---------- Stage 1: 真实 Session 构造（完整 surface 折叠校验） ----------
let Session
try {
  const mod = await import('@deepseek-ai/dsh-session')
  Session = mod.Session
  log('\n[dsh-session] loaded')
} catch (e) { show('import dsh-session FAILED', e); process.exit(0) }

let session
try {
  session = new Session('repro-session', events)
  log('[Stage1] new Session OK; log length=' + session.log.length)
} catch (e) {
  show('Stage1 new Session THREW', e)
  // 逐前缀定位毒化事件
  log('\n--- 二分定位毒化 seed 事件 ---')
  let lo = 1, hi = events.length, bad = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    try { new Session('probe', events.slice(0, mid)); lo = mid + 1 } catch { bad = mid; hi = mid - 1 }
  }
  if (bad > 0) {
    const off = events[bad - 1]
    log(`first failing seed length=${bad} -> offending event seq=${off?.seq} type=${off?.type}`)
    log('offending event: ' + JSON.stringify(off).slice(0, 600))
  }
  process.exit(0)
}

// ---------- Stage 2: surface ----------
let nodes
try {
  nodes = session.surface.nodes
  log('[Stage2] surface.nodes len=' + nodes.length + ' replaceGeneration=' + session.surface.replaceGeneration)
  log('  first 5 seqs=' + JSON.stringify(nodes.slice(0, 5)) + ' last 5 seqs=' + JSON.stringify(nodes.slice(-5)))
} catch (e) { show('Stage2 surface.nodes THREW', e); process.exit(0) }

// ---------- Stage 3: tool-pairing 边界校验 ----------
try {
  const { toolPairingBalancedBefore, toolPairingBalancedAfter } = await import('@deepseek-ai/dsh-compaction')
  log('\n[Stage3] tool-pairing loaded')
  let beforeFails = 0, firstBeforeErr = null
  let afterFails = 0, firstAfterErr = null
  for (const seq of nodes) {
    try { toolPairingBalancedBefore(session, seq) } catch (e) {
      beforeFails++
      if (!firstBeforeErr) firstBeforeErr = { seq, e }
    }
    try { toolPairingBalancedAfter(session, seq) } catch (e) {
      afterFails++
      if (!firstAfterErr) firstAfterErr = { seq, e }
    }
  }
  log(`  balancedBefore failures=${beforeFails} balancedAfter failures=${afterFails}`)
  if (firstBeforeErr) { log('  first BEFORE error at seq=' + firstBeforeErr.seq); log(String(firstBeforeErr.e.stack).slice(0, 1200)) }
  if (firstAfterErr) { log('  first AFTER error at seq=' + firstAfterErr.seq); log(String(firstAfterErr.e.stack).slice(0, 1200)) }
} catch (e) { show('Stage3 import/tool-pairing THREW', e) }

// ---------- Stage 4: 真实 TokenMeter ----------
try {
  const tmMod = await import('@deepseek-ai/dsh-token-meter')
  const meter = Object.create(tmMod.TokenMeter.prototype)
  meter.states = new WeakMap()
  const m = meter.measure(session)
  log('\n[Stage4] meter.measure OK totalTokens=' + m.totalTokens + ' nodes=' + m.nodes.length)
} catch (e) { show('Stage4 meter.measure THREW', e) }

// ---------- Stage 5: 模拟提交（compaction/start + replace user/message） ----------
log('\n[Stage5] 模拟提交 ---')
try {
  const startEvent = session.append('compaction/start', { compactionId: 'repro-id', turn: 999 })
  log('  compaction/start OK seq=' + startEvent.seq)
  const { createUserMessage, compactCheckpointSource } = { createUserMessage: null, compactCheckpointSource: null }
  const { CompactionId, compactCheckpointSource: ccs } = await import('@deepseek-ai/dsh-compaction')
  const llmMod = await import('@deepseek-ai/dsh-llm')
  const checkpoint = llmMod.createUserMessage({
    content: [{ type: 'text', text: '[repro summary]' }],
    source: ccs('repro-id', undefined)
  })
  const start = nodes[0]
  const end = nodes[Math.max(0, Math.floor(nodes.length / 4))]
  log('  attempting replace range ' + start + '..' + end)
  session.append('user/message', checkpoint, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, ...nodes.slice(0, Math.max(1, Math.floor(nodes.length / 4)) + 1)]
  })
  log('  replace append OK; new surface len=' + session.surface.nodes.length)

  const ending = session.append('compaction/end', { compactionId: 'repro-id', turn: 999 })
  log('  compaction/end OK seq=' + ending.seq)
} catch (e) { show('Stage5 commit THREW', e) }

log('\n=== done ===')
