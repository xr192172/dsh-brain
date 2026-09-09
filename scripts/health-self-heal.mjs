#!/usr/bin/env node
/**
 * health-self-heal —— switchboard 前端健康自愈守护。
 *
 * 目的：当 front door (3080) 因 active gen 异常退出 / control plane 状态卡死而
 * 持续 502 时，自动"停旧控制面 + 按 start-switchboard.ps1 重启"，把服务拉回。
 * 降低"用户看到 502 卡死"的影响（分钟级自愈）。
 *
 * 运行方式：
 *   - 常驻守护：node scripts/health-self-heal.mjs            （每 20s 轮询）
 *   - 一次检测：node scripts/health-self-heal.mjs --once     （配计划任务每 1-2min 用）
 *
 * 判定"需要自愈"：front door 非 200 **且** control plane 判定为 active 的 gen 进程
 * 已不存在（连不上 gen）。纯"交接中/verify 暂不可用"（active 进程仍活）不会误自愈。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FRONT = 'http://127.0.0.1:3080/'
const ADMIN = 'http://127.0.0.1:31800/?cmd=status'
const SWITCH = path.join(ROOT, 'scripts', 'start-switchboard.ps1')
const LOG = path.join(ROOT, 'logs', 'self-heal.log')
const EVERY_MS = 20_000
const FAIL_BEFORE_HEAL = 3
const COOLDOWN_AFTER_HEAL = 6

fs.mkdirSync(path.dirname(LOG), { recursive: true })
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}\n`
  try { fs.appendFileSync(LOG, line) } catch { /* ignore */ }
  process.stdout.write(line)
}

async function httpGet(url, timeoutMs = 6000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ac.signal })
    return { ok: r.ok, status: r.status }
  } catch {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

async function adminStatus() {
  try {
    const r = await fetch(ADMIN)
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

/** 进程是否存在（Windows 下 process.kill(pid,0) 探测，ESRCH=不存在）。 */
function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 停掉当前 control plane 的 node 进程树（精确匹配 switchboard），再按脚本重启。 */
function heal(reason) {
  log(`HEAL TRIGGER: ${reason}`)
  try {
    const stop =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'switchboard|out\\\\|bin\\.cjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    execFileSync('powershell', ['-NoProfile', '-Command', stop], { stdio: 'ignore', timeout: 15_000 })
  } catch {
    /* 没有可停进程，直接重启 */
  }
  const child = spawn('pwsh', ['-NoProfile', '-File', SWITCH], { detached: true, stdio: 'ignore' })
  child.unref()
  log(`control plane restarted -> ${SWITCH}`)
}

/** 一次探测：健康则 true；需要自愈（front down 且 active 进程死）则 false。 */
async function needsHeal() {
  const front = await httpGet(FRONT)
  if (front.ok) return false
  const st = await adminStatus()
  // active 进程仍活着 → 只是交接中/临时不可达，不误自愈
  if (st && pidAlive(st?.lease?.activeGen?.pid)) return false
  return true
}

async function main() {
  const once = process.argv.includes('--once')
  log(`health-self-heal started (once=${once}, failThreshold=${FAIL_BEFORE_HEAL})`)
  let fails = 0
  let cooldown = 0
  for (;;) {
    const bad = await needsHeal()
    if (!bad) {
      fails = 0
      cooldown = 0
    } else if (cooldown > 0) {
      cooldown--
    } else {
      fails++
      log(`front door unhealthy (fails=${fails})`)
      if (fails >= FAIL_BEFORE_HEAL) {
        heal(`front door down for ${FAIL_BEFORE_HEAL} checks with dead active gen`)
        fails = 0
        cooldown = COOLDOWN_AFTER_HEAL
      }
    }
    if (once) break
    await new Promise((r) => setTimeout(r, EVERY_MS))
  }
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack : String(e)}`)
  process.exitCode = 1
})