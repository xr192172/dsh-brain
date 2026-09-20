#!/usr/bin/env node
/**
 * verify-drain-after-swap.mjs —— **真机验收**：换代写入竞态的修复到底有没有生效
 *
 * 为什么需要它：`test-handover-drain.mjs` 是"假件 + 源码"级的门，它证明不了真机上
 * gen 侧接线通不通（`ctx.inject(['agents'])` / `agent.phase` / `sessions.flush`）。
 * 那三件事只有**跑过一次真换代**才能确认。手工看 `state.jsonl` 容易看漏，所以做成一条命令。
 *
 * 判据（全部来自真机落盘物，不看注释、不看意图）：
 *   R1 最近一次交接的 `freeze` 记录带 `quiesced=` 读数 —— 没有 ⇒ 这次交接是**旧版代码**跑的
 *   R2 `quiesced=true`        —— 旧代确认停写（这是"两代并发写"被消除的**唯一**证据）
 *   R3 `canSeeAgents=true`    —— gen 侧真能看到 agent（false ⇒ drain 会退化成每次强杀旧代）
 *   R4 `stillBusy=[]` `flushFailed=[]`
 *   R5 `seal: keep-old`       —— 与 R2 一致性：quiesced=true 时不该走强杀
 *   R6 `post-freeze catchup(观测项)` 在场（说明跑的是新版控制面）
 *   R7 `resume-session=` 非空（黄：`(hard-switch, no-freeze)` 说明没冻住但走了强切）
 *   R8 旧代的 `<genDir>/resume.jsonl` 有 `{"phase":"drain"}`（gen 侧真的执行了 drain）
 *      + 其 boot.log 有 `[switchboard:agent] drain quiesced=…`（第二见证，黄）
 *   R9 `check-session-integrity.mjs --limit 12` 通过（没有把会话写坏）
 *
 * 用法：
 *   node scripts/verify-drain-after-swap.mjs                      # 验收真机
 *   node scripts/verify-drain-after-swap.mjs --state <jsonl> --gens <dir>
 *   node scripts/verify-drain-after-swap.mjs --selftest           # 两方向自证（必修·后必须红/绿分明）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'D:/project_develop/dsh-brain'
const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : (argv[i + 1] ?? null)
}
const selftest = argv.includes('--selftest')
const STATE = argOf('--state') ?? 'C:/Users/Admin/.dsh/switchboard/state.jsonl'
const GENS = argOf('--gens') ?? 'C:/Users/Admin/.dsh/switchboard'

const rows = []          // { level: 'ok'|'red'|'yellow', id, what, detail }
const add = (level, id, what, detail = '') => rows.push({ level, id, what, detail })
const t = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })

/** 真·修复前日志（2026-09-15 22:52 那次交接的原文，逐字抄自 ~/.dsh/switchboard/state.jsonl）。 */
const PREFIX_SCENARIO = [
  '{"t":1789483948198,"stage":"idle","gen":"gen-3087","note":"fast 模式：跳过 defer / verify-gate / 稳定观察窗（仍保留 probe + 启动健康检查 + 失败回滚）"}',
  '{"t":1789483948217,"stage":"spawn","gen":"gen-3087","note":"spawned gen-3088"}',
  '{"t":1789483950246,"stage":"freeze","gen":"gen-3087","note":"freeze a lastSeq=0"}',
  '{"t":1789483950246,"stage":"promote","gen":"gen-3087","note":"resume-session=session-3d8ea18d-be29-4ab1-894f-ad84857cff68 (via-gen)"}',
  '{"t":1789483950251,"stage":"flip","gen":"gen-3088","note":"flip to gen-3088"}',
  '{"t":1789483950531,"stage":"retire","gen":"gen-3088","note":"retire gen-3087"}',
].join('\n')

/** 合成的"修复后"日志（形状照 `coordinator.ts` 的 record 文本造，用于自证绿的这一侧）。 */
const FIXED_SCENARIO = [
  '{"t":1789484948198,"stage":"ready","gen":"gen-3090","note":"defer: 请活跃代 gen-3090 先收尾本轮 (grace=20000ms)"}',
  '{"t":1789484960246,"stage":"freeze","gen":"gen-3090","note":"freeze a lastSeq=2244 quiesced=true (canSeeAgents=true running=1→cancel=1 stillBusy=[] flushFailed=[] 37ms)"}',
  '{"t":1789484960246,"stage":"promote","gen":"gen-3090","note":"seal: keep-old — 旧代已确认停写（回合全停 + 落盘成功）→ 留作回滚网，按 retainMs 优雅退役"}',
  '{"t":1789484960247,"stage":"promote","gen":"gen-3090","note":"resume-session=session-3d8ea18d-be29-4ab1-894f-ad84857cff68 (via-freeze-primary)"}',
  '{"t":1789484961740,"stage":"promote","gen":"gen-3090","note":"post-freeze catchup(观测项)：ok=false target=2244"}',
  '{"t":1789484960251,"stage":"flip","gen":"gen-3091","note":"flip to gen-3091"}',
  '{"t":1789484960531,"stage":"retire","gen":"gen-3091","note":"retire gen-3090"}',
].join('\n')

function readRows(file) {
  const out = []
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* skip */
    }
  }
  return out
}

/** 核心判定：给定 state.jsonl 的行 + gen 目录，产出判据表（自证用的就是它）。 */
function judge(lines, gensDir, { skipIntegrity = false } = {}) {
  const res = []
  const push = (level, id, what, detail = '') => res.push({ level, id, what, detail })
  let last = -1
  for (let i = 0; i < lines.length; i++) if (String(lines[i].note || '').startsWith('freeze ')) last = i
  if (last < 0) {
    push('red', 'R1', '最近一次交接里没有 freeze 记录', 'state.jsonl 里没有以 "freeze " 开头的 note ⇒ 根本没换过代？')
    return res
  }
  const fr = lines[last]
  const note = String(fr.note)
  const after = lines.slice(last)
  const noteAfter = (prefix) => after.find((r) => String(r.note || '').startsWith(prefix))

  const hasReadings = /quiesced=/.test(note)
  push(
    hasReadings ? 'ok' : 'red',
    'R1',
    'freeze 记录带 quiesced= 读数（说明跑的是新版 gen）',
    hasReadings ? `${t(fr.t)} ${fr.gen} :: ${note}` : `${t(fr.t)} :: ${note} —— **这是旧版代码**（新版一定会带 quiesced=）`,
  )

  const q = /quiesced=(\w+)/.exec(note)?.[1]
  push(q === 'true' ? 'ok' : 'red', 'R2', 'quiesced=true（旧代确认停写）', `读到 quiesced=${q ?? '(缺)'}`)

  const cs = /canSeeAgents=(\w+)/.exec(note)?.[1]
  push(cs === 'true' ? 'ok' : 'red', 'R3', 'canSeeAgents=true（gen 侧能看到 agent）', `读到 canSeeAgents=${cs ?? '(缺)'}${cs === undefined ? ' —— 老版本 gen 没有这项诊断' : ''}`)

  const busy = /stillBusy=\[([^\]]*)\]/.exec(note)?.[1]
  const flush = /flushFailed=\[([^\]]*)\]/.exec(note)?.[1]
  push(busy === '' && flush === '' ? 'ok' : 'red', 'R4', 'stillBusy=[] 且 flushFailed=[]', `stillBusy=[${busy ?? '?'}] flushFailed=[${flush ?? '?'}]`)

  const seal = noteAfter('seal: ')
  const sealTxt = seal ? String(seal.note) : ''
  if (!seal) push('red', 'R5', 'seal 决策落盘（说明跑的是新版控制面）', '交接流水里没有 "seal: " 行')
  else if (/keep-old/.test(sealTxt)) push('ok', 'R5', 'seal=keep-old（与 quiesced=true 一致）', sealTxt)
  else push(q === 'true' ? 'red' : 'yellow', 'R5', 'seal 走了 KILL-OLD', `${sealTxt}${q === 'true' ? ' —— 与 quiesced=true 矛盾，必须查' : '（quiesced 未真 ⇒ 强杀是**预期**行为，但要查为什么没停住）'}`)

  const cu = noteAfter('post-freeze catchup')
  push(cu ? 'ok' : 'red', 'R6', 'post-freeze catchup 观测项在场（新版控制面）', cu ? String(cu.note) : '没有这一行')

  const rs = noteAfter('resume-session=')
  const rsTxt = rs ? String(rs.note) : ''
  if (!rs || /resume-session=none/.test(rsTxt)) push('yellow', 'R7', 'resume-session', rsTxt || '没有这一行（冷启/无会话时属正常）')
  else if (/hard-switch, no-freeze/.test(rsTxt)) push('yellow', 'R7', 'resume-session 走的是强切（没冻住）', rsTxt)
  else push('ok', 'R7', 'resume-session 已记录', rsTxt)

  // R8 gen 侧 drain 痕迹：freeze 记录的 gen = **被冻结的那个旧代**（drain trace 写在它的 genDir）
  const oldGen = String(fr.gen || '')
  const traceFile = path.join(gensDir, oldGen, 'resume.jsonl')
  const bootFile = path.join(gensDir, oldGen, 'boot.log')
  let traceOk = false
  if (fs.existsSync(traceFile)) {
    const tr = fs.readFileSync(traceFile, 'utf8')
    traceOk = tr.includes('"phase":"drain"')
    push(traceOk ? 'ok' : 'red', 'R8', `${oldGen}/resume.jsonl 有 {"phase":"drain"}`,
      traceOk ? '在（gen 侧真的执行了 drain）' : `文件在、但没有 drain 记录 ⇒ ${oldGen} 跑的是旧版 gen`)
  } else {
    push('red', 'R8', `${oldGen}/resume.jsonl 存在`, `找不到 ${traceFile}`)
  }
  if (fs.existsSync(bootFile)) {
    const line = fs.readFileSync(bootFile, 'utf8').split('\n').filter((l) => l.includes('[switchboard:agent] drain')).pop()
    push(line ? 'ok' : 'yellow', 'R8b', `${oldGen}/boot.log 有 drain 日志行`, line ?? '没有（黄：gen 被强杀时可能没来得及写；以 R8 为准）')
  }

  if (!skipIntegrity) {
    const r = spawnSync(process.execPath, ['scripts/check-session-integrity.mjs', '--limit', '12'], { cwd: REPO, encoding: 'utf8' })
    const body = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
    // 取摘要行（含 ERROR/WARN/个会话 的那条），别把最后的"修复建议"当结论
    const ls = body.split('\n').map((s) => s.trim()).filter(Boolean)
    const summary = ls.find((l) => /ERROR|WARN|帧契约|个会话/.test(l)) ?? ls.slice(-1)[0] ?? ''
    push((r.status ?? 1) === 0 ? 'ok' : 'red', 'R9', '会话体健（最近 12 个，帧契约 = 阻塞级）', summary.slice(0, 160))

    // R9b ★ 这一条才是本 bug 类别的**直接**指纹：新的 seq gap。
    // 检查器本身只把 gap 记成 WARN（不阻塞启动），所以"新增 gap"必须靠**基线对比**才看得见。
    const gapIds = [...body.matchAll(/WARN\s+(session-[0-9a-f-]+)/g)].map((m) => m[1])
    const baseFile = argOf('--baseline') ?? path.join(REPO, 'out', 'drain-acceptance-baseline.json')
    let base = { ids: [], savedAt: null }
    if (fs.existsSync(baseFile)) {
      try {
        base = { ...base, ...JSON.parse(fs.readFileSync(baseFile, 'utf8')) }
      } catch {
        /* 坏基线当作没有 */
      }
    }
    const newIds = gapIds.filter((id) => !(base.ids ?? []).includes(id))
    if (!base.savedAt) {
      push('yellow', 'R9b', 'seq gap 基线（首次建立）', `已记录 ${gapIds.length} 个既有 gap 会话 → ${baseFile}；**从下一次起**才能判"新增"`)
      fs.writeFileSync(baseFile, JSON.stringify({ ids: gapIds, savedAt: new Date().toISOString() }, null, 2), 'utf8')
    } else if (newIds.length) {
      push('red', 'R9b', '**新增**了 seq gap 的会话（本 bug 的直接指纹）', `${newIds.join(', ')} —— 对照基线（${base.savedAt}：${(base.ids ?? []).join(', ') || '无'}）`)
    } else {
      push('ok', 'R9b', '没有新增 seq gap 会话', `既有 gap：${gapIds.join(', ') || '无'}`)
      fs.writeFileSync(baseFile, JSON.stringify({ ids: gapIds, savedAt: new Date().toISOString() }, null, 2), 'utf8')
    }
  }
  return res
}

function print(res, title) {
  console.log(`\n=== ${title} ===`)
  for (const r of res) {
    const icon = r.level === 'ok' ? '  ok  ' : r.level === 'red' ? ' FAIL ' : ' warn '
    console.log(`${icon} ${r.id.padEnd(4)} ${r.what}`)
    if (r.detail) console.log(`        ${r.detail}`)
  }
  const red = res.filter((r) => r.level === 'red').length
  const yellow = res.filter((r) => r.level === 'yellow').length
  console.log(`  → ${res.length - red - yellow} ok / ${yellow} warn / ${red} FAIL`)
  return red
}

// ── --selftest：判据自身两方向自证 ─────────────────────────────────────────
if (selftest) {
  const tmp = path.join(REPO, 'out/_drain-acceptance')
  fs.mkdirSync(path.join(tmp, 'gen-3090'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'gen-3090', 'resume.jsonl'), '{"t":1,"phase":"drain","quiesced":true,"lastSeq":2244}\n', 'utf8')
  fs.writeFileSync(path.join(tmp, 'gen-3090', 'boot.log'), '[switchboard:agent] drain quiesced=true lastSeq=2244 canSeeAgents=true sessions=1 (37ms)\n', 'utf8')
  fs.writeFileSync(path.join(tmp, 'prefix.jsonl'), PREFIX_SCENARIO, 'utf8')
  fs.writeFileSync(path.join(tmp, 'fixed.jsonl'), FIXED_SCENARIO, 'utf8')
  const redPrefix = print(judge(readRows(path.join(tmp, 'prefix.jsonl')), tmp, { skipIntegrity: true }), '自证①：真·修复前日志 —— 必须红')
  const redFixed = print(judge(readRows(path.join(tmp, 'fixed.jsonl')), tmp, { skipIntegrity: true }), '自证②：合成修复后日志 —— 必须全绿/无红')
  console.log('')
  const pass = redPrefix > 0 && redFixed === 0
  console.log(pass ? '判据自证通过（该红的红、该绿的不红）' : `判据自证失败：redPrefix=${redPrefix}（应>0） redFixed=${redFixed}（应=0）`)
  process.exit(pass ? 0 : 1)
}

// ── 真机验收 ───────────────────────────────────────────────────────────────
if (!fs.existsSync(STATE)) {
  console.error(`找不到 ${STATE} —— switchboard 从未启动过？`)
  process.exit(1)
}
const lines = readRows(STATE)
const lastFreeze = lines.filter((r) => String(r.note || '').startsWith('freeze ')).slice(-1)[0]
console.log(`state.jsonl 共 ${lines.length} 行；最近一次 freeze：${lastFreeze ? t(lastFreeze.t) + ' ' + lastFreeze.gen : '(无)'}`)
console.log(`（验收口径：node scripts/test-handover-drain.mjs 是离线门；本脚本验的是**真机上有没有生效**）`)

// ── R0 前置：先分清"没验成"和"没通过"（2026-09-20 加）────────────────────
// 用户第一次跑这份脚本时，栈其实**从没启动过**（机器维修后一直没起 DSH），
// 而当时的结论行只有两种措辞（"未生效"或"未验收"），容易读成"蓝绿还有问题"。这里把它分清楚。
const BUILD_DIR = path.join(REPO, 'packages/switchboard/out')
const bins = fs.existsSync(BUILD_DIR) ? fs.readdirSync(BUILD_DIR).filter((d) => d.startsWith('b')).sort() : []
const newestBuild = bins.slice(-1)[0] ?? ''
const buildPath = path.join(BUILD_DIR, newestBuild)
let buildHasFix = false
let buildAt = 0
if (newestBuild) {
  buildAt = fs.statSync(buildPath).mtimeMs
  try {
    const c = fs.readFileSync(path.join(buildPath, 'coordinator.js'), 'utf8')
    buildHasFix = c.includes('KILL-OLD') && c.includes('sealPlan')
  } catch {
    /* 读不到就当没有 */
  }
}
const stackUp = await (async () => {
  try {
    const r = await fetch('http://127.0.0.1:31800/?cmd=status', { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch {
    return false
  }
})()
const newestRowAt = lines.slice(-1)[0]?.t ?? 0
const swappedSinceBuild = newestRowAt > buildAt
console.log('')
console.log('== R0 前置（先分清"没验成"和"没通过"）==')
console.log(`  ${stackUp ? 'ok  ' : '····'} R0a 开关板在跑？（探测控制面 31800）          ${stackUp ? '在' : '**没在跑**'}`)
console.log(`  ${buildHasFix ? 'ok  ' : 'FAIL'} R0b 磁盘上最新 build 含本次修复？              ${newestBuild || '(无 build)'} ${buildHasFix ? '含（重启即生效）' : '**不含**'}`)
console.log(`  ${swappedSinceBuild ? 'ok  ' : '····'} R0c 这次 build 之后换过代吗？                 ${swappedSinceBuild ? '换过' : '**没有**（state.jsonl 最新一条早于 build 时间）'}`)

if (!stackUp || !swappedSinceBuild) {
  console.log('')
  console.log('结论：**还没到能验收的状态** —— 不是"蓝绿有问题"，是这两件事还没做：')
  if (!stackUp) console.log('  ① 整个 DSH 栈没在跑。**在你自己的终端里**（Agent 起不了：即使 detached+unref 也会被回收）：')
  if (!stackUp) console.log('     cd D:\\project_develop\\dsh-brain')
  if (!stackUp) console.log('     node scripts\\relaunch-switchboard.mjs        # 分离式拉起；日志 → out\\switchboard-run.log')
  console.log('  ② 起来之后，空档时发一次**非 fast** 换代，让新代码真正跑一遍：')
  console.log('     node scripts\\check-session-integrity.mjs --all      # 换代前体检（坏帧契约会让整代起不来）')
  console.log('     curl.exe "http://127.0.0.1:31800/?cmd=handover"      # 非 fast；空档时发（PowerShell 里要写 curl.exe）')
  console.log('  然后**重跑本脚本**。上面 R1..R8 的 FAIL 全是"旧版代码跑的旧交接"的必然结果，不是回归证据。')
  if (!buildHasFix) console.log('  ⚠️ 另：磁盘上的 build 不含本次修复 ⇒ 先 `cd packages/switchboard && node scripts/build.mjs` 再重启。')
  process.exit(2) // 与"换代了但没通过"(1) 区分开：2 = 还没法验收
}

const red = print(judge(lines, GENS), '真机验收：drain 修复是否生效')
console.log('')
if (red) {
  console.log('结论：**换代了，但没生效**（跑的还是旧版/接线不通）。最常见：')
  console.log('  1) 控制面还是旧进程 ⇒ 重启 switchboard（用户终端），再发一次 `?cmd=handover`；')
  console.log('  2) 换过代但 gen 侧接线不通（canSeeAgents=false / 没有 drain trace）⇒ 看上面的 R3/R8。')
} else {
  console.log('结论：**这次的交接跑在新版代码上，且旧代是"确认停写"后交出的。**')
}
process.exit(red ? 1 : 0)
