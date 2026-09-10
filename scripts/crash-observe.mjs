#!/usr/bin/env node
/**
 * crash-observe —— staging/gen 崩溃现场守望。
 *
 * 背景：偶发 staging 进程 native 崩溃（code=0xC0000409/段错误类），原因疑似在
 * DSH 自身（promote 后恢复会话时），非必然、难稳定复现。本脚本常驻监听所有
 * gen 的 <genDir>/lifecycle.log，一旦出现异常退出码，立即抓现场：
 *   1) Windows Application Error 事件（faulting module name/offset）—— 定位 native 崩在哪个 DLL
 *   2) 该 gen boot.log 尾部（有无 JS/native 栈）
 *   3) 退出码行
 * 落到 <switchboard>/crash-investigation/{gen}-{pid}-{ts}.txt，供后续定位。
 *
 * 用法：node scripts/crash-observe.mjs   （常驻，每 5s 扫一次；Ctrl+C 退出）
 * 判断"异常 native 崩"：code 非 0 且非正常 SIGTERM（gradient stop 杀的是受控退出，
 *   spawner 对有意的 stop 也会走这里，但会标注 —— 这里统一捕获，人工据内容区分）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

const SW = 'C:/Users/Admin/.dsh/switchboard'
const INV = path.join(SW, 'crash-investigation')
fs.mkdirSync(INV, { recursive: true })

/** 已处理的 lifecycle 行（按 gen+行前 100 字去重），脚本启动时先预载所有历史行，避免重复处理旧 EXIT。 */
let seen = new Set()
for (const dir of fs.readdirSync(SW, { withFileTypes: true })) {
  if (!dir.isDirectory() || !/^gen-/.test(dir.name)) continue
  const lc = path.join(SW, dir.name, 'lifecycle.log')
  if (!fs.existsSync(lc)) continue
  for (const ln of fs.readFileSync(lc, 'utf8').split(/\r?\n/)) if (ln.trim()) seen.add(dir.name + '|' + ln.trim().slice(0, 100))
}

function capture(gen, rawLine) {
  const pidM = /pid=(\d+)/.exec(rawLine)
  const codeM = /code=([0-9-]+)/.exec(rawLine)
  const pid = pidM ? pidM[1] : '?'
  const code = codeM ? codeM[1] : '?'
  const file = path.join(INV, `${gen}-${pid}-${Date.now()}.txt`)

  /// 1) Windows Application Error 事件（faulting module name/offset）
  execFile(
    'powershell',
    ['-NoProfile', '-Command',
      "try { $e = Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000} -MaxEvents 8 -ErrorAction Stop | Where-Object { $_.Message -match 'node.exe' } | Select-Object -First 1; if ($e) { $e.TimeCreated.ToString('u') + \"`n\" + $e.Message } else { '(no matching Application Error 1000 event)' } } catch { 'event-log query failed: ' + $_.Exception.Message }",
    ],
    { timeout: 12_000 },
    (err, stdout) => {
      if (err) console.log('[crash-observe] event query err:', err.message)
      const eventInfo = stdout || '(no event info)'
      /// 2) boot.log 尾部
      let boot = '(no boot.log)'
      try {
        boot = fs.readFileSync(path.join(SW, gen, 'boot.log'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(-40).join('\n')
      } catch { /* ignore */ }
      const body = `=== CRASH ${gen} pid=${pid} code=${code} ===\n${rawLine}\n\n--- Windows Application Error (faulting module) ---\n${eventInfo.trim()}\n\n--- boot.log tail ---\n${boot}\n`
      try { fs.writeFileSync(file, body, 'utf8') } catch { /* ignore */ }
      console.log(`[crash-observe] CRASH CAPTURED → ${file} (code=${code})`)
    },
  )
}

function scan() {
  for (const dir of fs.readdirSync(SW, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^gen-/.test(dir.name)) continue
    const gen = dir.name
    const lc = path.join(SW, gen, 'lifecycle.log')
    if (!fs.existsSync(lc)) continue
    let raw
    try { raw = fs.readFileSync(lc, 'utf8') } catch { continue }
    for (const ln of raw.split(/\r?\n/)) {
      if (!ln.trim()) continue
      if (!/gen EXIT/.test(ln)) continue
      const key = gen + '|' + ln.trim().slice(0, 100)
      if (seen.has(key)) continue
      seen.add(key)
      const m = /code=(\d+)/.exec(ln)
      const code = m ? parseInt(m[1], 10) : 0
      // 异常退出：非 0。0xC0000409=3221225794、0xC0000005=3221225477 等 native 崩码。
      // 有意终止(signal/SIGTERM)也捕获，人工按内容区分。
      if (code !== 0 && Number.isFinite(code)) capture(gen, ln.trim())
    }
  }
}

scan()
setInterval(scan, 5000)
console.log('[crash-observe] watching gen lifecycle logs → ' + INV + ' (Ctrl+C to stop)')