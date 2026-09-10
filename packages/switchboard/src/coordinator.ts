/**
 * @module @dsh-brain/switchboard/coordinator
 *
 * 交接状态机：idle→spawn→ready→freeze→promote→flip→verify→retire。
 * 前门翻转由 FrontDoor.swapActive 原子完成；单写者由 LeaseStore 保证。
 * 失败路径：spawn/ready/freeze 未达标 → abort（旧 gen 继续服务，绝不 flip）；
 * verify 失败 → 非破坏回滚 flip 回旧 gen。退役由控制面触发（非 agent 强杀）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { LeaseStore } from './lease.js'
import type { FrontDoor } from './proxy.js'
import { spawnGen, type SpawnedGen, type SpawnOptions } from './spawner.js'
import { AdminClient } from './adminclient.js'
import { writeOverlay } from './overlay.js'
import type { GenInstance, HandoverStage, StateRecord, FreezeReply } from './handover-protocol.js'

export interface CoordinatorConfig {
  nodeBin: string
  dshBin: string
  profile: string
  portBase: number
  adminBase: number
  /** 外部 memory_observe 观测用的 --inspect 端口基址；gen 的 inspect = base + (port - portBase)。0=关闭。 */
  inspectPortBase: number
  coordDir: string
  workDir: string
  envExtra?: Record<string, string>
  ttlMs: number
  readyTimeoutMs: number
  freezeTimeoutMs: number
  retainMs: number
  /** delay切换：>0 时先请活跃代收尾本轮再 spawn 新代（等 turn/end 或该毫秒数兜底）；0=关（立即切）。 */
  deferMs: number
  /** verify 稳定观察窗口：flip 后 probe ok 仍需稳定存活该毫秒数（再探一次成功）才判定成功，拦截"probe 假 ok、稍后进程才崩"的假成功。 */
  verifyStableMs: number
  /** 可选验证闸（自进化·实验脑）：非空时，staging 除探活外还须跑该命令且返回 ok 才 flip。默认空=只探活。 */
  verifyCmd?: string
  /** 安全白名单：verifyCmd 指向的可执行/脚本的绝对路径（目录前缀匹配）。不在白名单 → 拒绝执行并回滚（安全失败）。 */
  verifyAllowList?: string[]
  /** verifyCmd 执行超时 ms（默认 120000）。超时视为失败。 */
  verifyTimeoutMs?: number
  /** verifyCmd 工作目录（缺省 cfg.workDir）。 */
  verifyCwd?: string
}

interface Cage {
  inst: GenInstance
  spawned: SpawnedGen
  client: AdminClient
}

/** 一次交接的可读结果（供 `?cmd=status` / handover-status.jsonl / 控制台横幅展示）。 */
export interface HandoverResult {
  t: number
  result: 'success' | 'aborted' | 'rolled-back'
  note: string
  gen?: string
  resumeSession?: string
  reason?: string
}

export class Coordinator {
  private readonly lease: LeaseStore
  private readonly stateLog: (r: StateRecord) => void
  private readonly front: FrontDoor
  private active: Cage
  private stage: HandoverStage = 'idle'
  private genCounter = 0
  private lastResult: HandoverResult | null = null

  constructor(
    private readonly cfg: CoordinatorConfig,
    front: FrontDoor,
    active: Cage,
  ) {
    mkdirSync(cfg.coordDir, { recursive: true })
    this.lease = new LeaseStore(cfg.coordDir)
    const stateFile = join(cfg.coordDir, 'state.jsonl')
    this.stateLog = (r: StateRecord) => appendFileSync(stateFile, JSON.stringify(r) + '\n', 'utf8')
    this.front = front
    this.active = active
    // 初始 active 指向 bootstrap gen A（前门翻转必需）
    front.setActive(active.inst)
    // 给 bootstrap 活跃代写租约：让 status/lease 反映真实 active（而非空），并启用心跳续约
    if (!this.lease.isHeld()) {
      this.lease.grant(active.inst.gen, active.inst.port, active.inst.pid, cfg.ttlMs, -1, 'replay')
    }
  }

  get stageName(): HandoverStage {
    return this.stage
  }

  /** 最近一次交接的可读结果（`?cmd=status` 返回；也写入 handover-status.jsonl）。 */
  get lastHandoverResult(): HandoverResult | null {
    return this.lastResult
  }

  /** 交接窗口锁状态（`?cmd=status` 附带；便于运维/前端观察"切换中，请勿操作"）。 */
  get switchLocked(): boolean {
    return this.front.isLocked
  }

  /** 记录一次交接结果：落盘 handover-status.jsonl + 控制台可读横幅。 */
  private recordResult(r: HandoverResult): void {
    this.lastResult = r
    try {
      appendFileSync(join(this.cfg.coordDir, 'handover-status.jsonl'), JSON.stringify(r) + '\n', 'utf8')
    } catch {
      /* 结果日志失败不影响交接 */
    }
    const [icon, word] =
      r.result === 'success' ? ['✓', '成功'] : r.result === 'aborted' ? ['✗', '失败'] : ['↩', '回滚']
    console.log(`[switchboard] ${icon} 切换${word}: ${r.note}${r.resumeSession ? ' · resume=' + r.resumeSession : ''}`)
  }

  /** 确保当前活跃代持有租约（供 main 在崩溃恢复后调用；修复"热重启时活跃代无租约"）。 */
  ensureActiveLease(): void {
    if (!this.lease.isHeld()) {
      this.lease.grant(this.active.inst.gen, this.active.inst.port, this.active.inst.pid, this.cfg.ttlMs, -1, 'replay')
    }
  }

  /** 对外暴露租约（main 用于心跳续约与状态查询）。 */
  getLease(): LeaseStore {
    return this.lease
  }

  private record(note: string): void {
    this.stateLog({ t: Date.now(), stage: this.stage, gen: this.active.inst.gen, note })
  }

  /** 原子换 active：返回被换下的旧代。 */
  private swapActive(next: Cage): Cage {
    const old = this.active
    this.active = next
    this.front.setActive(next.inst)
    return old
  }

  private async activeSeq(): Promise<number> {
    const h = await this.active.client.health(3000)
    return h?.caughtUpSeq ?? -1
  }

  async handover(fail?: string, profileOverride?: string): Promise<HandoverStage> {
    // 交接窗口遮罩（后端口令锁）：整个交接期间前门拦截写操作/新建连接，避免不稳定态并发写入触发 kind 竞态。
    // 用 try/finally 确保任何出口（成功/abort/回滚/异常）都释放锁，杜绝交接异常导致永久锁死。
    this.front.setLocked(true)
    try {
    const cfg = this.cfg
    // 覆盖 profile：允许 apply 指定 staging 代运行某个脑 profile（接入 three-brain/sandbox 代际）
    const profile = profileOverride && profileOverride.trim() ? profileOverride.trim() : cfg.profile

    // 延迟切换：先请当前活跃代收尾本轮（注入挂起提示 + 等 turn/end 或 grace 兜底），
    // 让正在生成的这一轮先把话说完，再真正 spawn 新代——避免"成功那一刻就停/中断"。
    if ((cfg.deferMs ?? 0) > 0 && this.active.inst.role === 'active') {
      this.stage = 'ready' // 仅用于阶段日志；真正的状态机仍从 spawn 起步
      this.record('defer: 请活跃代 ' + this.active.inst.gen + ' 先收尾本轮 (grace=' + cfg.deferMs + 'ms)')
      try {
        const prep = await this.active.client.prepareSwitch(cfg.deferMs)
        this.record('defer done: ok=' + prep.ok + ' agent=' + prep.foundAgent + ' waitedTurnEnd=' + prep.waitedForTurnEnd + (prep.reason ? ' reason=' + prep.reason : ''))
      } catch {
        this.record('defer skipped (活跃代 admin 不可达，按原立即切)')
      }
      this.stage = 'spawn'
    }

    this.stage = 'spawn'
    const genId = `gen-${cfg.portBase + this.genCounter + 2}`
    this.genCounter += 1
    const port = cfg.portBase + this.genCounter + 1
    const adminPort = cfg.adminBase + this.genCounter + 1
    const genDir = join(cfg.workDir, genId)
    mkdirSync(genDir, { recursive: true })
    const overlayFile = writeOverlay(join(genDir, 'run'), {
      // 只钉 per-gen sqlite；投影缓存保留共享（非权威，冷读走日志重建）——同脑的 overlay 修复
      querySqlitePath: join(genDir, 'query.sqlite'),
    })
    const token = randomUUID()
    const spawned = spawnGen({
      nodeBin: cfg.nodeBin,
      dshBin: cfg.dshBin,
      profile,
      port,
      adminPort,
      gen: genId,
      leaseToken: token,
      mode: 'staging',
      overlayFile,
      genDir,
      envExtra: cfg.envExtra,
      inspectPort: cfg.inspectPortBase ? cfg.inspectPortBase + (port - cfg.portBase) : undefined,
    } satisfies SpawnOptions)
    const b: Cage = {
      inst: {
        id: genId,
        gen: genId,
        port,
        adminPort,
        pid: spawned.pid,
        role: 'staging',
        state: 'starting',
        lastHeartbeat: Date.now(),
        caughtUpSeq: 0,
      },
      spawned,
      client: new AdminClient(`http://127.0.0.1:${adminPort}`),
    }
    this.record('spawned ' + genId)

    // 注入失败（E2E/自检：确定性触发 abort，验证失败自证与强杀闭环，不用真崩 staging gen）
    if (fail === 'spawn') return this.abort(b, 'injected-fail-spawn')

    this.stage = 'ready'
    const targetSeq = await this.activeSeq()
    if (fail === 'catchup') return this.abort(b, 'injected-fail-catchup')
    if (!(await this.waitCatchUp(b, targetSeq))) return this.abort(b, 'b-catchup-failed')

    this.stage = 'freeze'
    if (fail === 'freeze') return this.abort(b, 'injected-fail-freeze')
    // 强切兜底：freeze 依赖旧代配合（调用 gen 内 admin）。旧代主线程被占/僵死时，freeze 会超时抛错，
    // 若不管它，handover 卡死在 freeze 且无 abort/无推进（观察到的"卡 freeze"现象）。
    // → 失败不 abort、不挂死：吞掉，走"无冻结强切"，直接 promote 新一代 + flip + 退役旧代。
    let fr: FreezeReply | null
    try {
      fr = await this.active.client.freeze(cfg.freezeTimeoutMs)
    } catch {
      fr = null
    }
    if (!fr || !fr.static) {
      this.record('freeze 活跃代无响应 → 走强切（省去静态冻结，直接 promote）')
      fr = null
    } else {
      this.record('freeze a lastSeq=' + fr.lastSeq)
    }

    this.stage = 'promote'
    // 挑"主活跃会话"用于新代 resume，实现对话接续。
    // 优先用常驻前门嗅探到的会话（最可靠，不依赖 gen 内部）；有冻结再用其最高 seq 会话；都没有则空（冷启）。
    const frontSid = this.front.lastSessionId || ''
    const freezeSid = fr && fr.sessions && fr.sessions.length > 0 ? [...fr.sessions].sort((a, b) => b.seq - a.seq)[0].id : ''
    const resumeId = (frontSid || freezeSid) as string | undefined
    const via = frontSid ? ' (via-front-door)' : freezeSid ? ' (via-gen)' : fr ? '' : ' (hard-switch, no-freeze)'
    this.record('resume-session=' + (resumeId ?? 'none') + via)
    // 有冻结时才要求 staging 追平冻结 seq；追不平也**不 abort 挂死**，仍按强切推进
    //（staging 已按自身日志/checkpoint 就绪即视为可接，不给"等旧代配合"留死锁面）。
    if (fr) {
      if (!(await this.waitCatchUp(b, fr.lastSeq))) {
        this.record('re-ready-b-behind → 仍按强切继续（不阻塞旧代追平）')
      }
    }

    this.stage = 'promote'
    await b.client.promote(token, b.inst.gen, resumeId) // B 绑定 key-pool + 确认写权 token + 携带 resume 会话

    this.stage = 'flip'
    this.lease.grant(b.inst.gen, b.inst.port, spawned.pid, cfg.ttlMs, (fr?.lastSeq ?? 0), 'replay', token)
    const old = this.swapActive(b)
    b.inst.role = 'active'
    b.inst.state = 'active'
    this.record('flip to ' + b.inst.gen)

    this.stage = 'verify'
    const probe = await b.client.probe(5000)
    if (!probe.ok) {
      // 非破坏回滚：指回旧 active，退役 B
      this.swapActive(old)
      old.inst.role = 'active'
      old.inst.state = 'active'
      this.stage = 'rolled-back'
      this.recordResult({ t: Date.now(), result: 'rolled-back', note: '(probe 失败) 已回滚旧代 ' + old.inst.gen, gen: b.inst.gen })
      await b.spawned.stop()
      return this.stage
    }

    // 可选验证闸（自进化·实验脑）：verifyCmd 非空时，staging 还须跑白名单内命令且返回 ok 才 flip。
    if (cfg.verifyCmd) {
      const gate = await this.runVerifyGate(cfg, b, old)
      if (!gate.ok) {
        this.swapActive(old)
        old.inst.role = 'active'
        old.inst.state = 'active'
        this.stage = 'rolled-back'
        this.recordResult({ t: Date.now(), result: 'rolled-back', note: `(verify-gate 失败) 已回滚旧代 ${old.inst.gen}：${gate.summary}`, gen: b.inst.gen })
        await b.spawned.stop()
        return this.stage
      }
      this.record('verify-gate ok: ' + gate.summary)
      this.stage = 'verify'
    }

    // verify 竞态修复：probe ok 后仍留稳定观察窗——sleep verifyStableMs 再探一次，
    // 两次连续 ok 才算成功。拦截 gen-3089 型"health 假 ok、隔几毫秒进程才崩"的假成功；
    // 窗口内晚崩会被第二次 probe 拦下并非破坏回滚。
    if ((cfg.verifyStableMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, cfg.verifyStableMs))
      const probe2 = await b.client.probe(5000)
      if (!probe2.ok) {
        this.swapActive(old)
        old.inst.role = 'active'
        old.inst.state = 'active'
        this.stage = 'rolled-back'
        this.recordResult({ t: Date.now(), result: 'rolled-back', note: '(verify 稳定期探测失败) 已回滚旧代 ' + old.inst.gen, gen: b.inst.gen })
        await b.spawned.stop()
        return this.stage
      }
    }

    this.stage = 'retire'
    this.record('retire ' + old.inst.gen)
    setTimeout(() => void old.spawned.stop(), cfg.retainMs)
    this.stage = 'idle'
    this.recordResult({
      t: Date.now(),
      result: 'success',
      note: '已切换 → ' + b.inst.gen,
      gen: b.inst.gen,
      resumeSession: resumeId,
    })
    return 'idle'
    } finally {
      this.front.setLocked(false)
    }
  }

  private async runVerifyGate(
    cfg: CoordinatorConfig,
    b: Cage,
    old: Cage,
  ): Promise<{ ok: boolean; summary: string }> {
    const cmd = cfg.verifyCmd!
    const allow = cfg.verifyAllowList ?? []
    const timeoutMs = cfg.verifyTimeoutMs ?? 120_000
    const parts = cmd.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return { ok: false, summary: 'verifyCmd 为空' }
    let exe = parts[0]
    let script = parts[0]
    let rest = parts.slice(1)
    // 解释器（node/python…）：首 token 是解释器，真正脚本是第二 token
    if (['node', 'node.exe', 'python', 'python3', 'deno'].includes(exe.toLowerCase())) {
      script = parts[1] ?? ''
      rest = parts.slice(2)
    }
    const scriptAbs = script && (isAbsolute(script) ? script : resolve(cfg.verifyCwd ?? cfg.workDir, script))
    if (!scriptAbs || !this.inVerifyAllow(scriptAbs, allow)) {
      return { ok: false, summary: `verifyCmd 脚本不在白名单(verifyAllowList)→安全拒绝：${scriptAbs || script}` }
    }
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      STAGING_PORT: String(b.inst.port),
      ACTIVE_PORT: String(old.inst.port),
    }
    return new Promise((res) => {
      const child = spawn(exe, [scriptAbs, ...rest], {
        cwd: cfg.verifyCwd ?? cfg.workDir,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        if (out.length > 2_000_000) child.kill()
      })
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString()
      })
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }, timeoutMs)
      child.on('error', (e) => {
        clearTimeout(timer)
        res({ ok: false, summary: 'spawn 失败: ' + e.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const line = (out.trim().split(/\r?\n/).find((l) => l.trim().startsWith('{')) ?? out).trim()
        let gate: { ok?: boolean; reason?: string } = {}
        try {
          gate = JSON.parse(line)
        } catch {
          gate = {}
        }
        res({
          ok: gate.ok === true,
          summary: gate.ok === true ? `cmd exit=${code ?? '?'}${gate.reason ? ' ' + gate.reason.slice(0, 120) : ''}` : `cmd exit=${code ?? '?'} 非ok：${(line || err).slice(0, 160)}`,
        })
      })
    })
  }

  /** 校验脚本绝对路径是否落在白名单（allow 中任一项为目录前缀，或相等）。 */
  private inVerifyAllow(scriptAbs: string, allow: string[]): boolean {
    if (allow.length === 0) return false
    return allow.some((a) => {
      const p = resolve(a)
      return scriptAbs === p || scriptAbs.startsWith(p.endsWith(join('\\', '/')) ? p : p + '\\')
    })
  }

  private async waitCatchUp(b: Cage, target: number): Promise<boolean> {
    const deadline = Date.now() + this.cfg.readyTimeoutMs
    for (;;) {
      // 自愈核心：staging 进程已死（崩溃/强杀）→ 立即判失败回滚，不等 readyTimeout 假死。
      // 此前只轮询 health()，staging 崩后连不上一个死进程，会一直磨到超时，表现为"换不了代卡死"。
      if (!pidAliveFrom(b.inst.pid)) return false
      const h = await b.client.health(3000).catch(() => null)
      if (h && h.caughtUpSeq >= target) return true
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  private async abort(b: Cage, reason: string): Promise<HandoverStage> {
    this.record('abort ' + reason)
    this.recordResult({ t: Date.now(), result: 'aborted', note: '切换失败 (' + reason + ') · 旧代 ' + this.active.inst.gen + ' 继续服务', gen: b.inst.gen, reason })
    // 失败自证：把"它为什么不成功"（boot.log 尾）连同失败原因一起落盘，供人工/脑自检。
    const tail = tailFile(b.spawned.logPath, 30)
    const stopRes = await b.spawned.stop()
    if (stopRes.pidGone) {
      writeFileSync(join(this.cfg.coordDir, 'abort.txt'), `reason: ${reason}\npid_cleaned: true\n\n--- ${b.inst.gen} boot.log tail ---\n${tail}`, 'utf8')
    } else {
      // 强杀闭环兜底仍失败：明确记录，绝不静默留僵尸。
      const msg = `reason: ${reason}\npid_cleaned: false\npid: ${b.inst.pid}\nport: ${b.inst.port}\n\n--- ${b.inst.gen} boot.log tail ---\n${tail}`
      writeFileSync(join(this.cfg.coordDir, 'abort.txt'), msg, 'utf8')
      this.record('abort ' + reason + ' pid-still-alive=' + b.inst.pid)
      console.error('[switchboard] zombie staging not cleanly killed:', b.inst.gen, 'pid', b.inst.pid)
    }
    return 'aborted'
  }
}

/** 读文件末尾至多 `n` 行（不存在/读不到 → 空串；用于自检 boot.log）。 */
function tailFile(path: string, n: number): string {
  if (!existsSync(path)) return '(no boot.log)'
  try {
    const all = readFileSync(path, 'utf8')
    const lines = all.replace(/^\uFEFF/, '').split(/\r?\n/)
    return lines.slice(-n).join('\n')
  } catch {
    return '(boot.log unreadable)'
  }
}

/** PID 是否存活（signal 0 探活；ESRCH=不存在，EPERM=存在但无权，视为存活）。 */
function pidAliveFrom(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}