#!/usr/bin/env node
/**
 * @module @dsh-brain/switchboard/main
 *
 * 脑代际蓝绿交接控制面入口。职责：
 *  1. 读 env 契约，组装 CoordinatorConfig。
 *  2. spawn 初始 active gen A（bootstrap），把前门 3080 指到 A。
 *  3. 起 Switchboard 自身 admin（SWITCH_ADMIN_PORT）接收交接命令。
 *  4. 周期为 active gen 续租约（心跳）。
 *
 * env 契约：
 *   SWITCH_ADDR         前门绑定，默认 `127.0.0.1:3080`
 *   SWITCH_ADMIN_PORT   控制面 admin，默认 31800
 *   GEN_PORT_BASE       代端口基址，默认 3081
 *   HANDOVER_ADMIN_PORT_BASE 代内 handover-agent admin 基址，默认 31810
 *   DSH_HOME           （默认 %USERPROFILE%/.dsh）
 *   WORK_DIR            工作目录（协调+gen 底座），默认 {DSH_HOME}/switchboard
 *   WEB_PROFILE         dsh profile，默认 web
 *   DSH_BIN             dsh lib/bin.js
 *   NODE_BIN            node 可执行
 *   GEN_ENV_EXTRA       透传到 gens 的 JSON 对象（含 key 池等）
 */
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { FrontDoor } from './proxy.js'
import { Coordinator, type CoordinatorConfig } from './coordinator.js'
import { AdminClient } from './adminclient.js'
import { spawnGen } from './spawner.js'
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

function envStr(k: string, d: string): string {
  return process.env[k] || d
}
function envInt(k: string, d: number): number {
  const v = process.env[k]
  return v && /^\d+$/.test(v) ? Number(v) : d
}

function boot(config: CoordinatorConfig): void {
  const front = new FrontDoor()

  // bootstrap：spawn 初始 active gen A
  const genId = 'gen-' + String(config.portBase + 1)
  const port = config.portBase + 1
  const adminPort = config.adminBase + 1
  const genDir = join(config.workDir, genId)
  const nodeBin = config.nodeBin
  const spawnedA = spawnGen({
    nodeBin,
    dshBin: config.dshBin,
    profile: config.profile,
    port,
    adminPort,
    gen: genId,
    leaseToken: '', // A 启动即 active，token 在首次 grant 时定
    mode: 'active',
    genDir,
    envExtra: config.envExtra,
    inspectPort: config.inspectPortBase ? config.inspectPortBase + (port - config.portBase) : undefined,
  })
  const activeCage = {
    inst: {
      id: genId,
      gen: genId,
      port,
      adminPort,
      pid: spawnedA.pid,
      role: 'active' as const,
      state: 'active' as const,
      lastHeartbeat: Date.now(),
      caughtUpSeq: 0,
    },
    spawned: spawnedA,
    client: new AdminClient(`http://127.0.0.1:${adminPort}`),
  }

  const coord = new Coordinator(config, front, activeCage)

  // 崩溃恢复：仅当 lease 指向的代"进程已死"才清空 lease（新 bootstrap 代 pid 刚 spawn 必然存活，不受影响）。
  // 用 pid 存活判定，而非 admin 端口响应度——避免"刚 grant 的代 admin 尚未起来就误判为 stale"的竞态。
  const staleLease = coord.getLease().current
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  if (staleLease.generation > 0 && staleLease.activeGen.pid > 0) {
    if (!pidAlive(staleLease.activeGen.pid)) {
      console.error(
        `[switchboard] stale lease detected: gen=${staleLease.activeGen.gen} port=${staleLease.activeGen.port} pid=${staleLease.activeGen.pid} is dead — clearing lease`,
      )
      coord.getLease().clear()
    } else {
      console.log(
        `[switchboard] lease recovery OK: gen=${staleLease.activeGen.gen} port=${staleLease.activeGen.port} pid=${staleLease.activeGen.pid} alive`,
      )
    }
  }
  // 恢复后确保 bootstrap 活跃代持有租约（热重启时磁盘 lease 可能被 clear，需重新授予活跃代）
  coord.ensureActiveLease()

  // 前门 3080
  const host = envStr('SWITCH_HOST', '127.0.0.1')
  const switchPort = envInt('SWITCH_PORT', 3080)
  const server = createServer()
  front.attach(server)
  server.listen(switchPort, host, () => {
    console.log(`[switchboard] front door http://${host}:${switchPort} -> gen A :${port}`)
  })

  // 控制面 admin（交接命令）
  const adminPortSwitch = envInt('SWITCH_ADMIN_PORT', 31800)
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const cmd = url.searchParams.get('cmd') ?? 'health'
    res.setHeader('content-type', 'application/json')
    if (cmd === 'handover' || cmd === 'apply') {
      // apply = 蓝绿部署闭环：P0 内容已落盘 → 控制面 spawn 新代 → 追平 → 冻结 → 翻转 → 验证 → 失败回滚
      // 可选 `&profile=<name>`：指定 staging 代运行的脑 profile（接入 three-brain/sandbox 代际，默认为 web）
      // 可选 `&fail=spawn|catchup|freeze`：注入确定性失败，触发 abort（验证失败自证+强杀闭环，不真崩 staging）
      // 立即确认：handover 可能含 defer（等活跃代收尾，秒级~20s+），阻塞到这个结果会拖爆调用方（如 tool_apply 15s 超时）。
      // → 先回 stage=started，后台异步执行，最终结果落 state.jsonl / ?cmd=result 供轮询。
      res.end(JSON.stringify({ ok: true, cmd, stage: 'started', profile: url.searchParams.get('profile') ?? 'web' }))
      void coord.handover(url.searchParams.get('fail') ?? undefined, url.searchParams.get('profile') ?? undefined).catch((e) =>
        console.error('[switchboard] handover error:', e instanceof Error ? e.message : String(e)),
      )
    } else if (cmd === 'status') {
      const lease = coord.getLease()
      res.end(JSON.stringify({ ok: true, stage: coord.stageName, result: coord.lastHandoverResult, lease: lease?.current, locked: coord.switchLocked }))
    } else if (cmd === 'result') {
      res.end(JSON.stringify({ ok: true, result: coord.lastHandoverResult }))
    } else if (cmd === 'fail') {
      res.end(JSON.stringify({ ok: true, note: 'manual fail injection accepted' }))
    } else {
      res.end(JSON.stringify({ ok: true, stage: coord.stageName }))
    }
  }).listen(adminPortSwitch, '127.0.0.1', () => {
    console.log(`[switchboard] control admin http://127.0.0.1:${adminPortSwitch}`)
  })

  // 心跳续约：持有写租约时按当前 token 续期
  const ttl = config.ttlMs
  setInterval(() => {
    const cur = coord.getLease()
    if (cur?.isHeld()) cur.heartbeat(cur.current.writerToken, ttl)
  }, Math.max(500, ttl / 4))
}

if (isMain) {
  const home = envStr('DSH_HOME', join(homedir(), '.dsh'))
  const nodeBin = envStr('NODE_BIN', join(process.cwd(), '.tools', 'node', 'node.exe'))
  const dshBin = envStr('DSH_BIN', join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const envExtraRaw = envStr('GEN_ENV_EXTRA', '{}')
  let envExtra: Record<string, string> = {}
  try {
    envExtra = JSON.parse(envExtraRaw) as Record<string, string>
  } catch {
    envExtra = {}
  }
  // 控制面必须存活：单个坏请求/上游错误不得击穿 3080（此处记录并继续）
  process.on('uncaughtException', (e) => console.error('[switchboard] uncaughtException:', e?.message))
  process.on('unhandledRejection', (e) => console.error('[switchboard] unhandledRejection:', String((e as Error)?.message ?? e)))

  const config: CoordinatorConfig = {
    nodeBin: existsSync(nodeBin) ? nodeBin : join(homedir(), '.dsh', '.tools', 'node', 'node.exe'),
    dshBin,
    profile: envStr('WEB_PROFILE', 'web'),
    portBase: envInt('GEN_PORT_BASE', 3081),
    adminBase: envInt('HANDOVER_ADMIN_PORT_BASE', 31810),
    inspectPortBase: envInt('SWITCH_INSPECT_PORT_BASE', 32810),
    coordDir: envStr('WORK_DIR', join(home, 'switchboard')),
    workDir: envStr('WORK_DIR', join(home, 'switchboard')),
    envExtra,
    ttlMs: envInt('SWITCH_LEASE_TTL_MS', 10_000),
    readyTimeoutMs: envInt('SWITCH_READY_TIMEOUT_MS', 40_000),
    freezeTimeoutMs: envInt('SWITCH_FREEZE_TIMEOUT_MS', 20_000),
    // 旧代 flip 后多存活 30s：DSH 在优雅停机时 flush 全部 live 会话（write-behind 200ms），
    // 足够长即保证"先落盘再换"，避免在途未提交的会话被强杀带走。
    retainMs: envInt('SWITCH_RETAIN_MS', 30_000),
    deferMs: envInt('SWITCH_DEFER_MS', 20_000),
    // verify 稳定观察窗口（ms）：flip 后再稳 2s 并二次探测，拦"probe 假 ok、稍后崩"的假成功
    verifyStableMs: envInt('SWITCH_VERIFY_STABLE_MS', 2_000),
  }
  boot(config)
}

export { boot }