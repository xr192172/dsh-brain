#!/usr/bin/env node
/**
 * verify-p4-after-swap.mjs —— P4（能力变更通知）**换代后**的验收
 *
 * ## 为什么单独一个脚本
 *
 * P4 的离线自证（27 项内核 + 16 项接线）只证明"逻辑与接线对"，
 * **证明不了"真机上真的生效了"** —— 那必须换代之后才谈得上。
 *
 * ## 三段验收（每段都给出可判读的结论，不糊）
 *
 * **A 出生证明**：新代码到底上了没有？
 *   判别器：活跃代的 `boot.log` 里有没有
 *   `[capability-bridge] registered custom session event type: capability/change`。
 *   ★ 这条是**预置好的对照**：2026-09-15 实测 gen-3086（换代前）**没有**这一行，
 *     所以它出现 = 新代码真的在跑；不出现 = 换的是旧代码/没换成功。
 *
 * **B 指纹恒定**：`(system 字符数 | tools 数)` 是否稳定（§6.1.5 的验收口径）。
 *   若变化只发生在压缩附近 ⇒ 可接受（压缩本来就要重写）；
 *   若在**没有压缩**的地方也跳 ⇒ 异常（P4 未生效，或另有改写源）。
 *
 * **C 折叠痕迹**：会话里有没有 `capability/change` 事件 / `能力集合已更新` 文本。
 *   都为 0 是**正常的**（能力库没变过，链路就应当静默）—— 脚本会这么说，不谎报失败。
 *
 * 用法：
 *   node scripts/verify-p4-after-swap.mjs
 *   node scripts/verify-p4-after-swap.mjs --gen gen-3100
 *   node scripts/verify-p4-after-swap.mjs --session <会话目录绝对路径>
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { decompress } from 'fzstd'

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const SW = path.join(HOME, 'switchboard')
const REPO = 'D:/project_develop/dsh-brain'
const ADMIN = 'http://127.0.0.1:31800'
const MARK = 'registered custom session event type'
const NEW_EVENT = 'capability/change'
const NOTICE_TEXT = '能力集合已更新'

/**
 * ★ 复用**生产保险**的实现，而不是在这儿写第三份 boot.log 解析。
 *
 * 为什么必须这样：boot.log 是**跨多次启动追加**的 ——
 * 本脚本第一版对全文 grep 「plugin tree failed to load」，于是**读到了上一次启动的旧错误**，
 * 在 gen-3086（其实起得很干净、尾部有正向信号 `dsh web: http://…`）上误报成"有错误行"。
 * 这正是 `docs/gen-plugin-tree-partial-failure.md` 里已经警告过的坑。
 * ⇒ 一律用 `lastBootSegment` 只读**最后一段**，且判据与 `verifyBootHealth` 完全同源。
 */
const BH = await import(pathToFileURL(path.join(REPO, 'packages/switchboard/lib/boot-health.js')).href)
const { lastBootSegment, findFatalBootErrors, hasReadySignal } = BH

const argv = process.argv.slice(2)
const opt = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i < 0 ? null : argv[i + 1]
}

const pass = []
const warn = []
const fail = []
const out = (s = '') => console.log(s)

// ── 取活跃代（控制面权威）────────────────────────────────────────────────────
async function activeGen() {
  try {
    const r = await fetch(`${ADMIN}/?cmd=status`)
    const j = await r.json()
    return j?.lease?.activeGen?.gen ?? null
  } catch {
    return null
  }
}

// ── 找最新的会话文件 ─────────────────────────────────────────────────────────
function newestSession() {
  const root = path.join(HOME, 'sessions')
  if (!fs.existsSync(root)) return null
  let best = null
  const walk = (dir, depth) => {
    if (depth > 3) return
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === 'session.jsonl.zstd') {
        const m = fs.statSync(p).mtimeMs
        if (!best || m > best.m) best = { p, m }
      }
    }
  }
  walk(root, 0)
  return best?.p ?? null
}

function loadEvents(file) {
  const text = Buffer.from(decompress(fs.readFileSync(file))).toString('utf8')
  return text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// ── A 出生证明 ───────────────────────────────────────────────────────────────
out('== A 出生证明：新代码上了没有 ==')
const gen = opt('gen') ?? (await activeGen())
if (!gen) {
  fail.push('取不到活跃代（控制面 http://127.0.0.1:31800 未响应？）—— 无法判定')
  out('  ✗ 取不到活跃代。控制面没在跑？用 --gen <name> 手动指定。')
} else {
  const log = path.join(SW, gen, 'boot.log')
  out(`  活跃代: ${gen}`)
  if (!fs.existsSync(log)) {
    fail.push(`找不到 ${log}`)
    out(`  ✗ 找不到 ${log}`)
  } else {
    // ★ 只读**最后一段**（boot.log 跨多次启动追加；全文 grep 会读到旧启动的残留 ⇒ 假红）
    const seg = lastBootSegment(log)
    const mtime = fs.statSync(log).mtime.toISOString()
    const applied = seg.split('\n').filter((l) => l.includes('[capability-bridge] apply running'))
    const registered = seg.includes(MARK) && seg.includes(NEW_EVENT)
    const fatal = findFatalBootErrors(seg)
    const ready = hasReadySignal(seg)

    out(`  boot.log: ${log}`)
    out(`  最后写入: ${mtime}`)
    out(`  本段行数: ${seg.split('\n').length}（只读最后一段，不读旧启动的残留）`)
    out(`  capability-bridge 装配: ${applied.length ? '有' : '【无 —— 插件没被装配？】'}`)

    // 先判"这一代到底起干净了没有"（与 verifyBootHealth 同源判据）
    if (ready && !fatal.length) {
      pass.push(`${gen} 启停干净（有正向完成信号、无致命模式）`)
      out('  ✓ 有正向完成信号且无致命模式 ⇒ 这一代起来了')
      if (!applied.length) {
        warn.push('本段里没看到 capability-bridge 装配行')
        out('  ⚠ 但本段里没看到 capability-bridge 装配行（可能被截断）')
      }
    } else {
      fail.push(`${gen} 启动不健康（fatal=${fatal.length}, ready=${ready}）`)
      out(`  ✗ 启动不健康：致命模式 ${fatal.length} 条 / 正向信号 ${ready}`)
      for (const l of fatal.slice(0, 5)) out(`      ${l}`)
    }

    if (registered) {
      pass.push('boot.log 出现 capability/change 注册行 ⇒ 新代码在跑')
      out(`  ✓ 出现「${NEW_EVENT}」注册行 ⇒ **新代码已生效**`)
    } else {
      fail.push('boot.log 没有 capability/change 注册行 ⇒ 跑的还是旧代码')
      out(`  ✗ 没有「${NEW_EVENT}」注册行 ⇒ **跑的仍是旧代码**（换代没成功，或换的是旧产物）`)
    }
  }
}

// ── B/C：会话分析 ────────────────────────────────────────────────────────────
out('')
out('== B 指纹恒定 / C 折叠痕迹（会话分析）==')
const sessionFile = opt('session')
  ? path.join(opt('session'), 'session.jsonl.zstd')
  : newestSession()
if (!sessionFile || !fs.existsSync(sessionFile)) {
  warn.push('找不到会话文件 ⇒ B/C 未执行')
  out('  ⚠ 找不到会话文件（用 --session <目录> 指定）⇒ B/C 未执行')
} else {
  out(`  会话: ${sessionFile}`)
  const evs = loadEvents(sessionFile)
  out(`  事件数: ${evs.length}`)

  const headers = evs.filter((e) => e.type === 'request/header')
  const compactions = evs.filter((e) => String(e.type).startsWith('compaction/')).map((e) => e.seq)

  const fps = headers.map((e) => {
    const h = e.data?.header ?? {}
    let tools = h.tools ?? h.toolSchemas ?? h.functions ?? null
    if (!Array.isArray(tools) && tools && typeof tools === 'object') tools = Object.values(tools)
    const n = Array.isArray(tools) ? tools.length : null
    const sysLen = typeof h.system === 'string' ? h.system.length : null
    return { seq: e.seq, tools: n, sysLen }
  })

  if (!fps.length) {
    warn.push('该会话没有 request/header ⇒ B 无法判定')
    out('  ⚠ 该会话没有 request/header 事件 ⇒ B 无法判定')
  } else {
    const distinctTools = [...new Set(fps.map((f) => f.tools).filter((n) => n !== null))].sort((a, b) => a - b)
    out(`  request/header 数: ${fps.length}`)
    out(`  tools 数的不同取值: ${distinctTools.length ? distinctTools.join(', ') : '(取不到 tools 字段)'}`)
    if (distinctTools.length <= 1) {
      pass.push('tools 数恒定')
      out(`  ✓ tools 数恒定 ⇒ 能力清单没有改写 tools 段`)
    } else {
      // 变化的那些点，是否紧邻压缩？
      let unexplained = 0
      for (let i = 1; i < fps.length; i++) {
        if (fps[i].tools !== fps[i - 1].tools) {
          const nearCompaction = compactions.some((cs) => Math.abs(cs - fps[i].seq) < 50)
          out(`     · seq=${fps[i].seq}: ${fps[i - 1].tools} → ${fps[i].tools} ${nearCompaction ? '(紧邻压缩，可接受)' : '★ 无压缩伴随'}`)
          if (!nearCompaction) unexplained++
        }
      }
      if (unexplained === 0) {
        pass.push('tools 数仅在压缩处变化（可接受）')
        out('  ✓ 变化都紧邻压缩 ⇒ 可接受')
      } else {
        fail.push(`${unexplained} 处 tools 数变化无压缩伴随 ⇒ P4 未生效或另有改写源`)
        out(`  ✗ ${unexplained} 处变化没有压缩伴随 ⇒ **异常**（P4 未生效，或还有别的改写源）`)
      }
    }
    out(`  指纹样例（seq | system长度 | tools数）：`)
    for (const f of fps.slice(0, 4)) out(`      ${f.seq} | ${f.sysLen} | ${f.tools}`)
    if (fps.length > 4) out(`      … 共 ${fps.length} 条`)
  }

  const capChanges = evs.filter((e) => e.type === NEW_EVENT).length
  const noticeHits = evs.filter((e) => JSON.stringify(e.data ?? {}).includes(NOTICE_TEXT)).length
  out(`  ${NEW_EVENT} 事件数: ${capChanges}`)
  out(`  「${NOTICE_TEXT}」出现次数: ${noticeHits}`)
  if (capChanges === 0 && noticeHits === 0) {
    out('  （都为 0 是**正常的**：能力库自该会话以来没变过 ⇒ 链路应当静默。')
    out('    要端到端触发：改动 `~/.dsh/capabilities/registry.json`（如跑')
    out('    `node scripts/capability-registry.mjs signal <id> --kind invoke`），')
    out('    再做一次工具调用，然后重跑本脚本看 C 段。）')
  } else {
    pass.push('观测到折叠链路痕迹')
    out('  ✓ 观测到链路痕迹 ⇒ 折叠真的发生了')
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
out('')
out('─'.repeat(70))
out(`  ✓ ${pass.length} 项通过   ⚠ ${warn.length} 项未判定   ✗ ${fail.length} 项失败`)
for (const s of pass) out(`  ✓ ${s}`)
for (const s of warn) out(`  ⚠ ${s}`)
for (const s of fail) out(`  ✗ ${s}`)
out('')
out('  用法：换代后再跑本脚本。A 段绿 = 新代码在跑；B 段绿 = 缓存收益拿到了。')
process.exit(fail.length ? 1 : 0)
