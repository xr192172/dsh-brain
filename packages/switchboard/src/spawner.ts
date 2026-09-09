/**
 * @module @dsh-brain/switchboard/spawner
 *
 * 拉起一个 dsh gen 进程（新代际），注入 per-gen env 与 `--port/--patch`。
 * 是"控制面 spawn"而非 agent 调 Stop-Process——进程生亡归 Switchboard 管。
 *
 * v2（失败自证）：
 *  - gen 的 stdout/stderr 不再 inherit 到控制面终端（会丢），改写入 `<genDir>/boot.log`，
 *    供 abort 时把"它为什么不成功"连同失败原因一起落盘自检。
 *  - stop() 升级为"强杀闭环"：SIGTERM → SIGKILL → (win32) taskkill /T /F → 确认 PID 消失，
 *    禁止留下"既不成功也不消亡"的僵尸代。
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

export interface SpawnOptions {
  nodeBin: string
  dshBin: string
  profile: string
  port: number
  adminPort: number
  gen: string
  leaseToken: string
  mode: 'staging' | 'active'
  /** 预留；当前端口走 CLI --port，config 走 env，不再用 --patch。 */
  overlayFile?: string
  /** 透传 key 池等宿主环境。 */
  envExtra?: Record<string, string>
  /** per-gen 落地目录（sqlite/cache/live 文件底座 + boot.log）。 */
  genDir: string
}

export interface StopResult {
  /** 进程是否已退出（exit code 可见）。 */
  exited: boolean
  /** PID 是否已从系统中消失（确认无僵尸）。 */
  pidGone: boolean
}

export interface SpawnedGen {
  proc: ChildProcess
  pid: number
  /** 本代落地目录。 */
  genDir: string
  /** 本代 stdout/stderr 落盘路径（abort 时读尾自检）。 */
  logPath: string
  /**
   * 强杀闭环：SIGTERM → SIGKILL →（win32）taskkill /T /F → 确证 PID 消失。
   * @param graceMs  优雅 SIGTERM 等待毫秒。
   */
  stop(graceMs?: number): Promise<StopResult>
}

/** PID 是否存活（signal 0 探活；EPERM 表示存在但无权限 → 视为存活）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function spawnGen(opts: SpawnOptions): SpawnedGen {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.envExtra,
    HANDOVER_GEN: opts.gen,
    HANDOVER_ADMIN_PORT: String(opts.adminPort),
    HANDOVER_LEASE_TOKEN: opts.leaseToken,
    HANDOVER_MODE: opts.mode,
    HANDOVER_GEN_DIR: opts.genDir,
    HANDOVER_CONTROL: process.env.HANDOVER_CONTROL || 'http://127.0.0.1:31800',
  }
  const args = [
    opts.dshBin,
    '--profile',
    opts.profile,
    '--port',
    String(opts.port),
    '--no-open',
  ]
  // 本代日志统一落盘，abort 时可读尾自检"为什么会不成功"。
  // 用 openSync 同步拿到已打开的 fd 直接喂给 stdio——createWriteStream 是异步打开
  // （spawn 时 fd 仍为 null，Node 会拒绝该 stdio），故不可用。
  mkdirSync(opts.genDir, { recursive: true }) // bootstrap 代不保证 genDir 已建，这里兜底
  const logPath = join(opts.genDir, 'boot.log')
  let logFd = openSync(logPath, 'a')
  let logClosed = false
  const closeLog = (): void => {
    if (logClosed || logFd < 0) return
    logClosed = true
    try {
      closeSync(logFd)
    } catch {
      /* 已关闭/无效 fd 忽略 */
    }
    logFd = -1
  }
  const proc = spawn(opts.nodeBin, args, { env, stdio: ['ignore', logFd, logFd], windowsHide: true })
  // 底层进程自行退出（崩溃/被杀）时顺带释放我们的 fd，避免泄漏。
  proc.on('exit', closeLog)
  proc.on('error', closeLog)

  const awaitExit = (ms: number): Promise<boolean> => {
    if (proc.exitCode !== null || proc.killed) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  const stop = async (graceMs = 4000): Promise<StopResult> => {
    const pid = proc.pid ?? 0
    if ((proc.exitCode !== null || proc.killed) && !pidAlive(pid)) {
      closeLog()
      return { exited: true, pidGone: true }
    }
    // 梯度强杀：SIGTERM（优雅）→ SIGKILL →（win32）taskkill 整树强制。
    if (proc.exitCode === null && !proc.killed) proc.kill() // SIGTERM
    if (await awaitExit(graceMs)) {
      closeLog()
      return { exited: true, pidGone: !pidAlive(pid) }
    }
    if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL')
    if (await awaitExit(1000)) {
      closeLog()
      return { exited: true, pidGone: !pidAlive(pid) }
    }
    if (process.platform === 'win32' && pid > 0) {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      })
      await new Promise((r) => setTimeout(r, 500))
    }
    closeLog()
    return { exited: !pidAlive(pid), pidGone: !pidAlive(pid) }
  }

  return { proc, pid: proc.pid ?? 0, genDir: opts.genDir, logPath, stop }
}