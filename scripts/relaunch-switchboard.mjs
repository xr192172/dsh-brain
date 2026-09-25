// relaunch-switchboard.mjs — 复刻 start-switchboard-ascii.ps1 的环境，分离式拉起 switchboard。
// 用法： node scripts/relaunch-switchboard.mjs [--dry-run]
// 输出： out/switchboard-run.log / out/switchboard-run.err.log
//
// ★ 向后兼容：所有端口/路径默认值与改动前逐字相同。
//   --dry-run：只打印将要用的 env 摘要（key 名 + 长度，不打印值）+ 将要 spawn 的命令行，不 spawn。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = 'D:\\project_develop\\dsh-brain'
const nodeExe = path.join(root, '.tools', 'node', 'node.exe')
const envFile = 'D:\\project_develop\\ai-base\\agent-shell\\.env'

const KEY_NAMES = new Set(['AGENTSHELL_MAIN_LLM_API_KEY', 'AGENTSHELL_MAIN_LLM_API_KEYS'])
const extra = {}
if (fs.existsSync(envFile)) {
  for (const ln of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const t = ln.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const k = t.slice(0, eq)
    if (KEY_NAMES.has(k)) extra[k] = t.slice(eq + 1)
  }
}
console.log('env keys found:', Object.keys(extra).join(',') || '(none)')

const env = {
  ...process.env,
  PATH: path.dirname(nodeExe) + ';' + (process.env.PATH ?? ''),
  // Two channels on purpose: GEN_ENV_EXTRA is what the switchboard forwards to the
  // gens, while dsh-credentials resolves AGENTSHELL_MAIN_LLM_API_KEY from the
  // process environment (and the credentials store) — the gen reports
  // "no credential for provider route agnes" without the direct export.
  ...extra,
  GEN_ENV_EXTRA: JSON.stringify(extra),
  NODE_BIN: nodeExe,
  DSH_BIN: path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  WEB_PROFILE: process.env.WEB_PROFILE ?? 'web',
  SWITCH_ADDR: process.env.SWITCH_ADDR ?? '127.0.0.1:3080',
  SWITCH_PORT: process.env.SWITCH_PORT ?? '3080',
  // dsh-brain patch (2026-09-14): make EVERY gen report the SAME public URL in its system prompt.
  // Each gen otherwise writes its own port (3082~3089) into the prompt, so every blue/green
  // handover / session migration invalidates the whole prompt-prefix cache
  // (measured: 0.0% hit on the first request after each migration).
  // Consumed by the localWebUrl patch in @deepseek-ai/dsh-web-app.
  DSH_PUBLIC_WEB_URL: process.env.DSH_PUBLIC_WEB_URL ?? 'http://127.0.0.1:3080',
  GEN_PORT_BASE: process.env.GEN_PORT_BASE ?? '3081',
  HANDOVER_ADMIN_PORT_BASE: process.env.HANDOVER_ADMIN_PORT_BASE ?? '31810',
  SWITCH_ADMIN_PORT: process.env.SWITCH_ADMIN_PORT ?? '31800',
  DSH_HOME: process.env.DSH_HOME ?? 'C:\\Users\\Admin\\.dsh',
  VERIFY_ALLOW: process.env.VERIFY_ALLOW ?? 'C:\\Users\\Admin\\AppData\\Local\\Temp\\verifyout'
}

const dryRun = process.argv.includes('--dry-run')

if (dryRun) {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  --dry-run 模式：只打印，不 spawn')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  将注入的 env（key = 值长度）：')
  const skipKeys = new Set(['PATH', 'GEN_ENV_EXTRA', 'NODE_BIN', 'DSH_BIN'])
  for (const [k, v] of Object.entries(env)) {
    if (skipKeys.has(k)) continue
    const vs = typeof v === 'string' ? v : JSON.stringify(v)
    console.log(`    ${k} = (${vs.length} chars)`)
  }
  console.log('')
  console.log('  将要 spawn 的命令行：')
  const cmdParts = [
    nodeExe,
    path.join(root, 'packages', 'switchboard', 'bin.cjs'),
  ]
  console.log(`    ${cmdParts.join(' ')}`)
  console.log(`    cwd   : ${root}`)
  console.log('═══════════════════════════════════════════════════════════════')
  process.exit(0)
}

const outLog = path.join(root, 'out', 'switchboard-run.log')
const errLog = path.join(root, 'out', 'switchboard-run.err.log')
const fdOut = fs.openSync(outLog, 'a')
const fdErr = fs.openSync(errLog, 'a')

const child = spawn(nodeExe, [path.join(root, 'packages', 'switchboard', 'bin.cjs')], {
  cwd: root,
  env,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', fdOut, fdErr]
})
child.unref()
console.log('switchboard spawned pid=' + child.pid)
console.log('stdout ->', outLog)
console.log('stderr ->', errLog)
