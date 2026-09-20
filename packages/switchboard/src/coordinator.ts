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
import { request as httpRequest } from 'node:http'
import { LeaseStore } from './lease.js'
import { sealPlan } from './drain.js'
import type { FrontDoor } from './proxy.js'
import { spawnGen, type SpawnedGen, type SpawnOptions } from './spawner.js'
import { verifyBootHealth, lastBootSegment } from './boot-health.js'
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
  /**
   * 启动健康检查的有界等待窗口 ms（2026-09-15 新增，默认 6000）。
   *
   * 为什么需要：boot.log 是**跨进程异步产物**，落盘时机不可控 —— gen-3083 的崩溃文本
   * 比 `result:success` **晚 637ms** 才写到磁盘，读一次必然读到"还没写完"的干净段。
   * 窗口内轮询重读，直到出现正向完成信号（健康）／命中致命模式（失败，早退）／窗口耗尽
   * （欠证据，按失败处理）。**fast 模式同样适用**（它跳过的是耗时项，不是判据）。
   */
  bootHealthTimeoutMs?: number
  /** 可选验证闸（自进化·实验脑）：非空时，staging 除探活外还须跑该命令且返回 ok 才 flip。默认空=只探活。 */
  verifyCmd?: string
  /** 安全白名单：verifyCmd 指向的可执行/脚本的绝对路径（目录前缀匹配）。不在白名单 → 拒绝执行并回滚（安全失败）。 */
  verifyAllowList?: string[]
  /** verifyCmd 执行超时 ms（默认 120000）。超时视为失败。 */
  verifyTimeoutMs?: number
  /** verifyCmd 工作目录（缺省 cfg.workDir）。 */
  verifyCwd?: string
  /**
   * 交接后自动续接：>0 时，flip+verify 稳定后，coordin 向新代 gen 端口**串行（await）**补发一次
   * `session.prompt`，让被交接的 web 会话自动续跑（不再等用户手动再发一条）。为 0 或未设则关闭。
   * 缺省文案由 cfg.resumePromptText 提供。
   */
  reissueMs?: number
  /** 补发续接 prompts 的文本（多句以 \n 分隔）。缺省用内部默认「交接完成，请继续」。 */
  resumePromptText?: string
}

/**
 * 保留端口：gen 端口分配**必须跳过**这些号（2026-09-20 事故）。
 *
 * 现场：gen 的编号就是它自己的监听端口（`gen-3100` → `--port 3100`，见 `spawner.ts` 的 `--port`）。
 * 而 **3101 是 key-pool-proxy 的固定监听口**（`packages/key-pool-proxy/src/index.ts`：
 * `port: z.number().int().default(3101)`）—— 活跃代会在**自己的进程内**再占一个 3101
 * （netstat 实测：`127.0.0.1:3100` 与 `127.0.0.1:3101` 同属现役 gen 的 pid）。
 * ⇒ 编号递增到 3101 的那一代，要**同时**绑"自己的 3101"和"key-pool-proxy 的 3101"
 *   ⇒ **必然 EADDRINUSE** ⇒ 这一代永远起不来（表现为 handover 恒 `b-not-ready`、旧代一直服务）。
 *
 * 注：key-pool-proxy 自己**容忍** EADDRINUSE（它注释里的"per-gen 单活跃代独占"），
 * 但 gen 的**主端口**不容忍 ⇒ 崩的是 gen 自己。所以只能从"分配"侧回避，不能指望容错。
 */
export const RESERVED_GEN_PORTS: readonly number[] = [3101]

/**
 * 由"第几代"（slot，1 = bootstrap 代；handover 从 2 起）算出 gen 端口，跳过 `RESERVED_GEN_PORTS`。
 *
 * ★ 跳号不能只做"撞上就 +1"：那会让"跳过 3101 落到 3102"与**下一个 slot 的 3102** 撞车
 *   （旧代默认还要留活 30s，同号必冲突）。这里按"区间内被挡了几个就整体后推几格"来算，
 *   保证 slot→port **严格单调递增**（单射），见 `scripts/test-gen-port-alloc.mjs`。
 */
export function allocGenPort(portBase: number, slot: number): number {
  let port = portBase + slot
  for (let guard = 0; guard < 1024; guard++) {
    const blocked = RESERVED_GEN_PORTS.filter((p) => p > portBase && p <= port).length
    const want = portBase + slot + blocked
    if (want === port) return port
    port = want
  }
  return port
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

  /**
   * 结构性就绪：staging 进程活着 + admin 可达 + 自报 gen 名一致。
   *
   * 2026-09-20 取代原来的"seq 追平门槛"（那个门槛因为读数是恒 0 的假值，从未量过任何东西）。
   * 注意**不要**在这里比 seq：新代按需懒加载会话，promote 之前它手上没有会话，"追平"没有定义；
   * 真正保证一致性的是 freeze 侧的真停写（`drain.ts`）+ 封口（`sealPlan`），不是这里的读数。
   */
  private async waitReady(b: Cage): Promise<boolean> {
    const deadline = Date.now() + Math.min(this.cfg.readyTimeoutMs, 10_000)
    for (;;) {
      if (!pidAliveFrom(b.inst.pid)) return false
      const h = await b.client.health(3000).catch(() => null)
      if (h && (!h.gen || h.gen === b.inst.gen)) {
        this.record('ready-probe ok: gen=' + h.gen + ' mode=' + h.mode + ' caughtUpSeq=' + h.caughtUpSeq)
        return true
      }
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  /**
   * 执行一次代际交接。
   *
   * `fast=true` 走「快速换代」路径（`?cmd=restart`）：跳过三样**耗时**的东西 ——
   *   ① defer（默认等当前轮收尾，`SWITCH_DEFER_MS` 默认 20s，长轮次可能更久）
   *   ② verify 闸（实验脑/自进化用的白名单验证脚本）
   *   ③ flip 后的稳定观察窗（`SWITCH_VERIFY_STABLE_MS` 默认 2s）
   * 但**保留三样几乎不花时间、却决定成败的**：
   *   · probe（端口通、进程活）
   *   · 启动健康检查（本次启动无插件树装载失败 —— 拦截"环境漂移"）
   *   · rollbackFlip（旧代尚在，回滚是免费的）
   *
   * ★ fast 与健康检查的关系（2026-09-15 修正认知）：fast 跳过的是 **③ 稳定观察窗**，
   * 而稳定观察窗只重探 `probe`（"进程还活吗"）—— 它**不覆盖**"日志落盘了吗"。
   * gen-3083 事故恰好发生在 **fast 路径**上：进程当时确实还活着（probe 会过），
   * 崩溃文本 637ms 后才落盘，于是被判 ok。⇒ 健康检查的**有界等待**是独立机制，
   * 与 `verifyStableMs` 正交，fast 模式不得跳过（现实现亦未跳过）。
   *
   * 定位：日常插件业务代码改动走 fast；内核机制 / 插件树组合 / profile 配置 / 判据自身的改动
   * 走完整路径（见 docs/handover-vs-restart.md 的三级替换策略）。
   * 注意 fast **不等于**"重启"：它是"快速换代"，仍带回滚，因此比真重启更安全、代价≈0。
   */
  async handover(fail?: string, profileOverride?: string, experimentKernelDir?: string, verifyOverride?: string, fast?: boolean): Promise<HandoverStage> {
    // 交接窗口遮罩（后端口令锁）：整个交接期间前门拦截写操作/新建连接，避免不稳定态并发写入触发 kind 竞态。
    // 用 try/finally 确保任何出口（成功/abort/回滚/异常）都释放锁，杜绝交接异常导致永久锁死。
    this.front.setLocked(true)
    try {
    const cfg = this.cfg
    // 覆盖 profile：允许 apply 指定 staging 代运行某个脑 profile（接入 three-brain/sandbox 代际）
    const profile = profileOverride && profileOverride.trim() ? profileOverride.trim() : cfg.profile
    if (fast) {
      this.record('fast 模式：跳过 defer / verify-gate / 稳定观察窗（仍保留 probe + 启动健康检查 + 失败回滚）')
    }

    // 换代后是否向被交接会话注入"续跑"提示。**默认否**，只有确认"确有活、且已干净收尾"才置真。
    // 判据（2026-09-14 定）：`waitedForTurnEnd === true`。
    // 其余情形一律不注入，各自的理由：
    //   · 会话空闲  → 注入会无端唤醒一轮（污染会话、白烧 token）
    //   · grace 超时 → 有活但没收尾，**常见于卡在等人类输入（ask_user_question）**；
    //                  此时注入会把跨代 resume 踢成不一致态（实测会话会变成未 attach）
    //   · fast 模式 → 未做探针，无法确认有无未收尾回合 ⇒ 保守视为"不注入"
    let resumeInject = false
    let resumeSkipReason = fast
      ? 'fast 模式跳过 defer，未探针，无法确认有无未收尾回合'
      : '未做 defer（deferMs=0 或角色非 active），无法确认状态'

    // 延迟切换：先请当前活跃代收尾本轮（注入挂起提示 + 等 turn/end 或 grace 兜底），
    // 让正在生成的这一轮先把话说完，再真正 spawn 新代——避免"成功那一刻就停/中断"。
    // fast 模式刻意跳过：这一步是换代里最贵的一环（默认等 20s，长轮次更久），
    // 而它换来的只是"不打断当前轮"——日常代码改动不值得为它付这个时间。
    if (!fast && (cfg.deferMs ?? 0) > 0 && this.active.inst.role === 'active') {
      this.stage = 'ready' // 仅用于阶段日志；真正的状态机仍从 spawn 起步
      this.record('defer: 请活跃代 ' + this.active.inst.gen + ' 先收尾本轮 (grace=' + cfg.deferMs + 'ms)')
      try {
        const prep = await this.active.client.prepareSwitch(cfg.deferMs)
        this.record(
          'defer done: ok=' + prep.ok + ' agent=' + prep.foundAgent +
          ' turnInFlight=' + prep.turnInFlight + ' waitedTurnEnd=' + prep.waitedForTurnEnd +
          (prep.reason ? ' reason=' + prep.reason : ''),
        )
        resumeInject = prep.waitedForTurnEnd === true
        resumeSkipReason = resumeInject
          ? ''
          : prep.turnInFlight === true
            ? '有回合未在 grace 内收尾（可能在等人类输入）→ 跳过续跑'
            : '会话空闲（reason=' + (prep.reason ?? '?') + '）→ 跳过续跑'
      } catch {
        this.record('defer skipped (活跃代 admin 不可达，按原立即切)')
        resumeSkipReason = '活跃代 admin 不可达，无法确认状态 → 跳过续跑'
      }
      this.stage = 'spawn'
    }

    this.stage = 'spawn'
    // slot：第几代（1 = bootstrap 代，handover 代从 2 起）。端口经 allocGenPort 分配（跳保留端口），
    // 编号沿用既有不变量 **gen 编号 = 本代端口**，故 genId 由 port 反推而非另算一份。
    const slot = this.genCounter + 2
    this.genCounter += 1
    const port = allocGenPort(cfg.portBase, slot)
    const genId = `gen-${port}`
    const adminPort = cfg.adminBase + slot
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
      envExtra: {
        ...cfg.envExtra,
        // 自进化·实验脑：本次 staging 单独加载实验内核产物（P0-2），生产 gen 不受影响。
        ...(experimentKernelDir ? { DESIGN_CANVAS_KERNEL_DIR: experimentKernelDir } : {}),
      },
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
    if (fail === 'catchup') return this.abort(b, 'injected-fail-catchup')
    // ★ 2026-09-20：这里原先比"seq 追平"当 ready 门槛，而那个读数（`computeCaughtUpSeq`）
    //   恒 0（它依赖的 `sessionPersistence.listSessions` 在上游**不存在**）⇒ 门槛从未量过任何东西。
    //   现在改成**结构性就绪**：进程活着 + admin 应答 + 自报 gen 名对得上。
    //   为什么不再比 seq：新代是**按需懒加载**会话的，被 promote 之前根本不持有会话 ⇒ "追平"对它没有定义
    //   （见 `preseed.ts` 头部与 `docs/handover-vs-restart.md` §8.4）。
    if (!(await this.waitReady(b))) return this.abort(b, 'b-not-ready')

    this.stage = 'freeze'
    if (fail === 'freeze') return this.abort(b, 'injected-fail-freeze')
    // 强切兜底：freeze 依赖旧代配合（调用 gen 内 admin）。旧代主线程被占/僵死时，freeze 会超时抛错，
    // 若不管它，handover 卡死在 freeze 且无 abort/无推进（观察到的"卡 freeze"现象）。
    // → 失败不 abort、不挂死：吞掉，走"无冻结强切"，直接 promote 新一代 + flip + 退役旧代。
    //
    // ★ 2026-09-15 补上的另一半：强切意味着**旧代未被冻结**，而它可能正往会话日志里写。
    //   旧实现只是"直接 promote"就完事 ⇒ 两代并发写同一份会话（事故记录见 docs/handover-vs-restart.md §8）。
    //   现在强切会走到下面的 `sealPlan` ⇒ **交出前门之前强杀旧代**（`retire(seal)` 分支）。
    let fr: FreezeReply | null
    try {
      fr = await this.active.client.freeze(cfg.freezeTimeoutMs)
    } catch {
      fr = null
    }
    // 区分两种"没冻住"：① 旧代 admin 不可达/超时（真·强切）；② 有应答但没到静止点
    // （`quiesced:false` —— 回合没停住 / 落盘失败 / gen 看不到 agent）。两者的处理相同
    // （都按"未停写"⇒ 稍后 seal 强杀），但**日志必须能分辨**，否则下次又会被误读成"硬切是主因"。
    const frRaw = fr
    if (!fr || !fr.static) {
      const why = !frRaw
        ? 'freeze 活跃代无响应（admin 不可达/超时）→ 走强切；旧代未停写 ⇒ 稍后 seal 阶段强杀'
        : 'freeze 有应答但**未达静止点**（quiesced=false' +
          (frRaw.drain
            ? `：canSeeAgents=${frRaw.drain.agentsObservable} stillBusy=[${frRaw.drain.stillBusy.join(',')}] flushFailed=[${frRaw.drain.flushFailed.join(',')}]`
            : '：无 drain 诊断=老版本 gen') +
          '）→ 按未停写处理，稍后 seal 阶段强杀'
      this.record(why)
      fr = null
    } else {
      // ★ 记录 freeze 的**真读数**：`lastSeq` 现在来自 live 会话（不再是恒 0 的暖机值），
      //   `quiesced` 才是"旧代确实不会再写会话日志"的判据（缺省=老版本 gen ⇒ 按未停写处理）。
      const d = fr.drain
      this.record(
        'freeze a lastSeq=' + fr.lastSeq + ' quiesced=' + (fr.quiesced === true) +
          (d ? ` (canSeeAgents=${d.agentsObservable} canSeeSessions=${d.sessionsObservable} running=${d.runningAtEntry}→cancel=${d.cancelled} stillBusy=[${d.stillBusy.join(',')}] flushFailed=[${d.flushFailed.join(',')}] ${d.waitedMs}ms)` : ' (无 drain 诊断：老版本 gen)'),
      )
    }
    // ★★ 封口决策（2026-09-15 事故修复）：旧代有没有"确认停写"？
    //   没停写 ⇒ 它正在写的会话会在下一次被新代以"磁盘前缀"重新加载并续写 ⇒ **必然 seq 重叠**
    //   （`dsh-session` 的 seq 就是 `log.length`）。所以必须**在交出前门之前**把它杀到 PID 消失。
    const seal = sealPlan(fr?.quiesced === true)
    this.record('seal: ' + (seal.killNow ? 'KILL-OLD' : 'keep-old') + ' — ' + seal.why)

    this.stage = 'promote'
    // 挑"主活跃会话"用于新代 resume，实现对话接续（顺序见下面的注释）。
    // 注意用 `frRaw`：即使这次没冻住（要强杀旧代），它上报的主活跃会话仍然是最准的线索。
    const frontSid = this.front.lastSessionId || ''
    const primarySid = frRaw?.primarySessionId ?? ''
    const freezeSid = frRaw && frRaw.sessions && frRaw.sessions.length > 0 ? [...frRaw.sessions].sort((a, b) => b.seq - a.seq)[0].id : ''
    // ★ 顺序（2026-09-15）：primarySessionId（= 冻结时**有回合在跑**那个 agent 的会话）→ 前门嗅探 →
    //   冻结上报里 seq 最大者。原先把前门放在最前，实测把 resume 指向了一个**没在跑**的会话。
    const resumeId = (primarySid || frontSid || freezeSid) as string | undefined
    const via = primarySid ? ' (via-freeze-primary)' : frontSid ? ' (via-front-door)' : freezeSid ? ' (via-gen)' : frRaw ? '' : ' (hard-switch, no-freeze)'
    this.record('resume-session=' + (resumeId ?? 'none') + via)
    // 有冻结时才要求 staging 追平冻结 seq；追不平也**不 abort 挂死**，仍按强切推进
    //（staging 已按自身日志/checkpoint 就绪即视为可接，不给"等旧代配合"留死锁面）。
    if (fr) {
      // ⚠️ 这一项**只做有界观测**（1.5s），不再阻塞推进：
      //   旧代一旦交给 drain 处理，落盘确认已经发生（quiesced 才为真），而 staging 是按需懒读共享
      //   日志的 —— "追平"对它本就没有意义。旧实现拿这个恒 0 的读数当门槛，是彻底的假绿。
      const caughtUp = await this.waitCatchUp(b, fr.lastSeq, 1500)
      this.record('post-freeze catchup(观测项)：ok=' + caughtUp + ' target=' + fr.lastSeq)
    }

    this.stage = 'promote'
    // 自愈：health 通过后 gen 仍可能在两次 poll 之间崩溃（ACCESS_VIOLATION 等 native crash），
    // 在 promote 前最后探活一次，避免对已死进程发请求导致未捕获异常。
    if (!pidAliveFrom(b.inst.pid)) return this.abort(b, 'b-promote-precheck-dead')
    try {
      await b.client.promote(token, b.inst.gen, resumeId) // B 绑定 key-pool + 确认写权 token + 携带 resume 会话
    } catch (e) {
      // promote 期间 gen 崩了（native crash 导致连接中断）→ 判失败，不挂死
      this.record('promote failed: ' + (e instanceof Error ? e.message : String(e)))
      return this.abort(b, 'b-promote-crash')
    }

    this.stage = 'flip'
    this.lease.grant(b.inst.gen, b.inst.port, spawned.pid, cfg.ttlMs, (fr?.lastSeq ?? 0), 'replay', token)
    const old = this.swapActive(b)
    b.inst.role = 'active'
    b.inst.state = 'active'
    this.record('flip to ' + b.inst.gen)

    this.stage = 'verify'
    const probe = await b.client.probe(5000)
    if (!probe.ok) {
      return this.rollbackFlip(old, b, cfg, '(probe 失败) 已回滚旧代 ' + old.inst.gen)
    }

    // 启动健康检查（2026-09-14 新增；2026-09-15 重构为「有界等待 + 正向信号」）。
    // probe 只证明「端口通、进程活」，**不证明插件树装配完整**。
    // 插件树部分失败时 gen 仍会就绪，但能力残缺：工具集少 N 个、Code Mode 因 codeRuntime
    // 服务缺失而静默回落 native、system+tools 同时变化使 prompt 前缀全失效
    // （会话迁过去后首轮命中率 0%，且模型只能靠试探发现"现在能用什么"）。
    // 这类 gen 一旦 promote 就是"环境漂移"——必须在此拦下，让它永远接不到会话。
    //
    // ★ gen-3083 教训（2026-09-15）：原实现「读一次 boot.log + 纯否定式判据」漏判了崩溃代 ——
    //   崩溃文本比 `result:success` 晚 637ms 才落盘，健康检查读到的是"还没写完"的段。
    //   修法两条（都在 boot-health.ts 里）：
    //     ① 有界等待重读（崩溃文本 3.4s 落盘，窗口 6s）；
    //     ② 除"无致命模式"外，还要求**正向完成信号**（`dsh web: http://...`）——
    //        否则"还没写完"与"干净启动"观测上同形。欠证据（unknown）按失败处理。
    const bootProbe = { readSegment: () => lastBootSegment(join(cfg.coordDir, b.inst.gen, 'boot.log')) }
    const bootHealth = await verifyBootHealth(bootProbe, {
      timeoutMs: cfg.bootHealthTimeoutMs ?? 6000,
      // 确定性死亡信号优先：child_process 的 exitCode 由内核回填，无竞态窗口。
      // （gen-3083 正是"端上还 probe 得通、进程随即 code=1"——exitCode 是最早可见的硬事实。）
      hasExited: () => b.spawned.proc.exitCode !== null,
      isAlive: () => pidAliveFrom(b.inst.pid),
    })
    if (bootHealth.verdict !== 'healthy') {
      const why =
        bootHealth.verdict === 'fatal'
          ? bootHealth.fatal.join('、')
          : `启动完成信号未出现（等待 ${bootHealth.waitedMs}ms / 日志 ${bootHealth.segmentLines} 行）`
      return this.rollbackFlip(
        old,
        b,
        cfg,
        `(启动健康检查失败·${bootHealth.verdict}) 已回滚旧代 ${old.inst.gen}：${why}`,
      )
    }
    this.record(`verify-boot-health ok: 本次启动无装载失败（等待 ${bootHealth.waitedMs}ms）`)

    // 可选验证闸（自进化·实验脑）：verifyCmd 非空时，staging 还须跑白名单内命令且返回 ok 才 flip。
    // verifyOverride = 本次 apply 由脑(LLM)随 tool_apply 提交的验证脚本。它让交接变成"进化脑管控"：
    // 脑提交改动意图，控制面(coordinator)据此跑验证闸 —— 通过才 flip、拒绝/失败回滚，而非无脑换代。
    const gateCmd = fast ? undefined : (verifyOverride && verifyOverride.trim()) || cfg.verifyCmd
    if (gateCmd) {
      const gateCfg = { ...cfg, verifyCmd: gateCmd }
      const gate = await this.runVerifyGate(gateCfg, b, old)
      if (!gate.ok) {
        return this.rollbackFlip(old, b, cfg, `(verify-gate 失败) 已回滚旧代 ${old.inst.gen}：${gate.summary}`)
      }
      this.record('verify-gate ok: ' + gate.summary + (verifyOverride ? '（本次 apply 指定）' : ''))
      this.stage = 'verify'
    }

    // verify 竞态修复：probe ok 后仍留稳定观察窗——sleep verifyStableMs 再探一次，
    // 两次连续 ok 才算成功。拦截 gen-3089 型"health 假 ok、隔几毫秒进程才崩"的假成功；
    // 窗口内晚崩会被第二次 probe 拦下并非破坏回滚。
    if (!fast && (cfg.verifyStableMs ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, cfg.verifyStableMs))
      const probe2 = await b.client.probe(5000)
      if (!probe2.ok) {
        return this.rollbackFlip(old, b, cfg, '(verify 稳定期探测失败) 已回滚旧代 ' + old.inst.gen)
      }
    }

    // 交接后自动续接：核实新代端口已可服务，**串行 await** 向它补发一次 session.prompt，
    // 让被交接的 web 会话在本代继续跑（不再等用户手动再发一条）。这是状态机内的一步，
    // 不是异步 fire-and-forget——先 etc 稳定、再排队执行，避免"交接未稳就并发注入"的 kind 竞态。
    if ((cfg.reissueMs ?? 0) > 0 && resumeId) {
      if (!resumeInject) {
        // 会话保持 attach（promote 已 resume），但不注入任何内容 —— 由用户/下游机制决定下一步。
        this.record('resume-reissue 跳过：' + resumeSkipReason)
      } else {
        try {
          // 小等待新代 web 端点就绪（probe 已过，但 web app 路由可能再晚几百 ms 挂上）
          await new Promise((r) => setTimeout(r, cfg.reissueMs ?? 0))
          const text = cfg.resumePromptText ?? '交接完成（代际切换已成功）。请直接继续你刚才正在进行的任务，无需重新说明背景。'
          const st = await this.reissuePrompt(b.inst.port, resumeId, text)
          this.record('resume-reissue: ' + st)
        } catch (e) {
          // 补发失败不阻断换代：最坏是仍需用户手动再发一条，不影响本次 flip 成功
          this.record('resume-reissue skipped: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
    }

    this.stage = 'retire'
    if (seal.killNow) {
      // ★★ 2026-09-15 事故修复的收口：旧代**未确认停写**时，必须在**释放前门锁之前**（锁在本方法的
      //    finally 才放）把它杀到 PID 消失。锁期间前门对 WS 升级与非 GET 请求一律 503，
      //    于是"浏览器把同一份会话加载到新代上"这件事被推迟到旧代确定不再写之后。
      //    代价：这一段没有"非破坏回滚"（旧代已死）—— 故意取舍，见 drain.ts 的 sealPlan 注释。
      this.record('retire(seal) ' + old.inst.gen + ' — 强杀旧代（未确认停写）pid=' + old.inst.pid)
      const stopRes = await old.spawned.stop(1500)
      if (stopRes.pidGone) {
        this.record('seal ok：旧代已确认消失 ' + old.inst.gen + '（pid=' + old.inst.pid + '）')
      } else {
        // 绝不静默：落盘现场 + 大字告警。仍然放锁（把前门永久锁死比留下可观测窗口更糟）。
        this.record('⚠ seal 未确认旧代消失：gen=' + old.inst.gen + ' pid=' + old.inst.pid + '（两代并发写同一会话的风险未消除）')
        try {
          writeFileSync(
            join(cfg.coordDir, 'unfenced-old-gen.txt'),
            `gen=${old.inst.gen}\npid=${old.inst.pid}\nport=${old.inst.port}\nreason=seal-kill-unconfirmed\nat=${new Date().toISOString()}\n`,
            'utf8',
          )
        } catch {
          /* 现场落盘失败不影响交接 */
        }
        console.error(
          '[switchboard] ⚠ 旧代未能确认停止写：gen=' + old.inst.gen + ' pid=' + old.inst.pid + ' — 前门即将放锁，存在两代并发写同一会话的风险',
        )
      }
    } else {
      this.record('retire ' + old.inst.gen)
      setTimeout(() => void old.spawned.stop(), cfg.retainMs)
    }
    this.stage = 'idle'
    this.recordResult({
      t: Date.now(),
      result: 'success',
      note: (fast ? '已快速切换 → ' : '已切换 → ') + b.inst.gen,
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

  /** 交接后向新代 gen 端口**串行**补发一次 session.prompt，驱动 web 会话自动续跑。 */
  private reissuePrompt(port: number, sessionId: string, text: string): Promise<string> {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: 'session.prompt',
        payload: {
          sessionId,
          mode: 'steer',
          content: [{ type: 'text', text }],
        },
      })
      const done = (msg: string): void => resolve(msg)
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/session.prompt', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          let data = ''
          res.on('data', (c: Buffer) => (data += c.toString()))
          res.on('end', () => {
            // 不再截到 120 字符：之前 reissue 的失败被砍成 `"code":"internal"` 就没了，
            // 排查时完全看不到内部错误原因（2026-09-14 踩过）。
            if (res.statusCode !== 200) console.error('[switchboard] reissue non-200:', data.slice(0, 2000))
            done(`HTTP ${res.statusCode} ${data.slice(0, 800)}`)
          })
        },
      )
      req.on('error', (e) => done(`error ${e.message}`))
      req.setTimeout(8000, () => {
        req.destroy()
        done('timeout')
      })
      req.write(body)
      req.end()
    })
  }

  /** 非破坏回滚：指回旧 active + 写租约回授给它（flip 已 grant 给 b，需覆盖回旧代）+ 退役 staging + 记录。 */
  private rollbackFlip(old: Cage, b: Cage, cfg: CoordinatorConfig, note: string): HandoverStage {
    this.swapActive(old)
    old.inst.role = 'active'
    old.inst.state = 'active'
    this.stage = 'rolled-back'
    // 修位：flip 时 lease.grant 已把写租约/首门赋给 b(staging)；回滚必须回授给存活的旧 active，
    // 否则 handover-status/status 的 standard activeGen 会指向已被 stop 的 staging（观察到的脏态）。
    // 新 token 由 grant 生成，旧代心跳若不匹配由 coordinator 的 crash-recovery(lease.isHeld=false→re-grant) 兜底。
    this.lease.grant(old.inst.gen, old.inst.port, old.inst.pid, cfg.ttlMs, -1, 'replay')
    this.recordResult({ t: Date.now(), result: 'rolled-back', note, gen: b.inst.gen })
    void b.spawned.stop()
    return this.stage
  }

  /**
   * 轮询 staging 的 `caughtUpSeq` 直到 ≥ `target` 或超时。
   *
   * ⚠️ **只用于"有界观测"，不得用作推进门槛**（2026-09-20 明确）：新代按需懒加载会话，
   * promote 之前它手上没有会话 ⇒ 这个读数对它就是 0，拿它 gate 只会白等。
   * 现在的用法只有一处：freeze 之后记录一次观测（1.5s 上限），供人事后判断。
   * @param timeoutMs 覆盖默认的 `readyTimeoutMs`（40s）—— 观测项一律给短上限。
   */
  private async waitCatchUp(b: Cage, target: number, timeoutMs?: number): Promise<boolean> {
    const deadline = Date.now() + (timeoutMs ?? this.cfg.readyTimeoutMs)
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
    // 可诊断性（2026-09-20）：note 里带上 staging 代 boot.log 的**错因**，
    // 否则失败读数只有一句 `b-not-ready`，要人去翻 gen 目录才知道是 EADDRINUSE 还是 MODULE_NOT_FOUND
    // （那次事故里正是因为这样，才让人连试 3 次都没看出真因）。
    const bootHint = bootErrorHint(tailFile(b.spawned.logPath, 30))
    this.recordResult({
      t: Date.now(),
      result: 'aborted',
      note: '切换失败 (' + reason + ') · 旧代 ' + this.active.inst.gen + ' 继续服务' + (bootHint ? ' · boot: ' + bootHint : ''),
      gen: b.inst.gen,
      reason,
    })
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

/**
 * 启动健康判据已抽到 `./boot-health.ts`（2026-09-15）。
 *
 * 迁出理由：它是**事故的保险本身**，必须可单测。原实现（`FATAL_BOOT_PATTERNS` +
 * `findFatalBootErrors` + `lastBootSegment`）是纯否定式且"读一次就定论"，
 * 漏判了 gen-3083 的崩溃代。新实现加了两条：有界等待重读 + 正向完成信号要求。
 */

/**
 * 从 boot.log 尾部抽出"错因"摘要（单行、截断到 `max` 字符），供 `result.note` 直读。
 *
 * 优先取带错因特征的行（EADDRINUSE / MODULE_NOT_FOUND / errno / Error: …），取最后 3 行；
 * 一行都没有就退回尾部原文——宁可多带一点上下文，也不要只留一句 `b-not-ready`。
 */
export function bootErrorHint(tail: string, max = 240): string {
  if (!tail || tail === '(no boot.log)' || tail === '(boot.log unreadable)') return ''
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return ''
  const errish = lines.filter((l) => /EADDRINUSE|MODULE_NOT_FOUND|EACCES|ERR_[A-Z_]+|Error:|errno|Cannot find|not found/i.test(l))
  const s = (errish.length > 0 ? errish : lines).slice(-3).join(' | ').replace(/\s+/g, ' ')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
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