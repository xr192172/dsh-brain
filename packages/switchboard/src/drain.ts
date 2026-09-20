/**
 * @module @dsh-brain/switchboard/drain
 *
 * 交接前的**真静止点**：让本代在交出会话之前，确实不再往会话日志里追加。
 *
 * ## 为什么这个文件在 2026-09-15 深夜被重写
 *
 * 旧实现（`evaluateStatic`）的判据是 `static = armed && lastSeq >= 0` —— 只要**能读到一个 seq**
 * 就算"静止"，既没停任何在跑的回合，也没等任何落盘。它把一句**意图**当成了断言：
 * 注释写着"在下一次模型请求/agent-pre-step 边界不再发起新请求"，但**没有任何代码实现它**。
 * 结果：`freeze` 恒返回 `static:true`、`lastSeq:0`（实测 171 条记录，**全部** `lastSeq=0`），
 * 于是换代协议真正做的是「**旧代照写、新代照接**」。
 *
 * ## 事故形态（实测 `session-3d8ea18d`，2026-09-15 22:30）
 *
 * 同一个会话被两代同时追加，日志里出现 **seq 回退 + 区间重叠**：
 *
 * ```text
 * #58..61  seq=623..626  tool_apply → step/end → step/start        ← 旧代 gen-3086 活着，回合在跑
 * #62..64  seq=627..629  step/end, turn/end(interrupted), end-seed ← 另一写者从**磁盘前缀**取 seq
 * #65..78  seq=627..912  assistant/chunk…turn/end(completed)       ← 旧代把这一轮**跑完**了
 * #79..    seq=630..     turn/end 之后的下一轮                      ← 又从 630 续
 * ```
 *
 * 为什么会撞：`dsh-session` 的 seq **就是 `log.length`**（`get seq()`），而新载入的会话是
 * **用磁盘上那份日志当种子**（`repair.js` 合成 closers 时 `let seq = last.seq + 1`；
 * 构造函数再补一条 `session/end-seed`）。旧代的内存计数器**永远领先于磁盘前缀**，
 * 于是**任何**第二个加载同一会话的实例，都会从旧代即将写的位置重新开始 —— 这不是小概率竞态，
 * 是**必然**重叠，只要旧代还在写、新代已经能服务同一个会话。
 *
 * 而"旧代还在写"是当时的常态：`retainMs` 默认 **30s**（旧代 flip 后仍活着），
 * 它正在跑的那一轮会一直写到结束（实测 flip 后 8.6s 才写完）。
 *
 * ## 因此本模块的契约
 *
 * `drainForHandover()` 返回的 `quiesced` 才是"本代不会再写"的**唯一**判据，它要求：
 *   1. 开工时**正在跑回合的 agent 全部被 cancel**，且在预算内**观察到它们转入 idle**；
 *   2. 维护型活动（压缩等）**等待结束**（不 cancel —— 半途中断可能留下悬空的 compaction 标记）；
 *   3. 每个 live 会话都经**官方 `sessions.flush()`** 落盘且**未抛错**。
 * 任一条不成立 ⇒ `quiesced:false`，控制面必须按"旧代未停写"处理（见 `sealPlan`）。
 *
 * `lastSeq` 也在这里修正：取 live 会话 `session.seq - 1` 的最大值（`seq` 是**下一个**序号），
 * 而不是旧实现那个恒 0 的暖机读数 —— 控制面用它写租约的 `freezeSeq`、新代用它当追平目标。
 */

/** 本代 agent 代理在交接期需要的能力（agent-loop 的 Agent 上都有；全可选=优雅降级）。 */
export interface DrainAgent {
  /** 标识（仅日志/自证用，缺省用下标）。 */
  id?: string
  /** 该 agent 正在编辑的会话 id（用于挑"主活跃会话"）。 */
  sessionId?: string
  /**
   * ★ **实时**读阶段（2026-09-20 真机验收暴露的 bug 的修复）。
   *
   * 为什么必须是函数而不是一个字段：原先 `phaseKind` 是在**建列表那一刻拍下的快照**，
   * 于是 `stillBusy` 永远报的是"取消之前的状态" ⇒ 真机上出现了
   * `quiesced=false stillBusy=[…]`（明明 cancel 已经把回合停掉了、`turn/end aborted(hook)` 都写进日志了）。
   * **判据读的是旧数据 = 假红**，与"读注释"是同一类错误。
   */
  readPhase?(): 'idle' | 'running' | 'maintenance' | undefined
  /** 兜底快照（仅给假件/测试用；生产路径走 `readPhase`）。 */
  phaseKind?: 'idle' | 'running' | 'maintenance'
  /** 兜底：`agent.status`（'idle' | 'running'）。 */
  status?: string
  /** 中断本回合/维护（`agent.cancel(cause, opts)`）。 */
  cancel?(cause: { kind: string; reason?: string }, opts?: { keepInbox?: boolean }): void
  /** 等本 agent 回到 idle（`agent.whenIdle()`）。 */
  whenIdle?(): Promise<void>
}

/** 本代 live 会话的最小面（`dsh-session` 的 `Session`：`id` + `get seq()`）。 */
export interface DrainSession {
  id?: string
  /** = `log.length` = **下一个**序号（所以"已落盘最大 seq"是 seq - 1）。 */
  seq?: number
}

export interface DrainDeps {
  agents: DrainAgent[]
  /**
   * ★ 我们**有没有能力观察 agent**（注册表拿得到、且有 `list()`）。
   *
   * 缺省 `true`（调用方确认过能力）。为什么必须显式：拿不到注册表时 `agents` 会是空数组，
   * 而"看不到任何 agent"**不是**"没有 agent 在跑"的证据 —— 那种情况下若报 `quiesced:true`，
   * 控制面会放心地把旧代留着（回滚网在），而它可能正在写 ⇒ **回到原事故**。
   * 所以：无法观察 ⇒ `quiesced:false` ⇒ 控制面按"未停写"强杀旧代（安全方向）。
   */
  agentsObservable?: boolean
  /**
   * ★ 我们**有没有能力观察会话**（`sessions` 服务拿得到，且 `list`/`flush` 都在）。
   *
   * 缺省 `true`。为什么也要显式：真机验收（2026-09-20）抓到过 —— 未声明服务依赖时
   * `ctx.sessions` 是 `undefined`，于是 `sessions=0` / `lastSeq=-1` / **flush 一次都没跑**，
   * 而空闲场景下 `quiesced` 仍然报 `true`（**假绿**：以为落盘确认过了）。
   * ⇒ 看不到会话服务时必须报"未停写"，让控制面走封口强杀。
   */
  sessionsObservable?: boolean
  sessions: DrainSession[]
  /** 官方落盘：`sessions.flush(session)`（会 await 持久化回调，失败会 throw）。 */
  flush(session: DrainSession): Promise<unknown>
  /** 事件流跟踪到的"最近活跃会话"（兜底挑 resume 目标用）。 */
  lastActiveSessionId?: string
  /** 等回合成 idle 的预算 ms（默认 8000；控制面的 freeze 超时默认 20s）。 */
  turnTimeoutMs?: number
  /** 等维护（压缩等）结束的预算 ms（默认 8000）。 */
  maintenanceTimeoutMs?: number
  now?(): number
}

/** 一次 drain 的完整可读结果（`static` 与 `lastSeq` 都从它导出，不再各自为政）。 */
export interface DrainOutcome {
  /** 开工时正在跑回合的 agent 数 —— 这才是「有没有活在跑」的真判据。 */
  runningAtEntry: number
  cancelled: number
  stillBusy: string[]
  /** 调用方是否**有能力**观察 agent（拿不到注册表 ⇒ 空列表 ≠ 空闲，见 DrainDeps.agentsObservable）。 */
  agentsObservable: boolean
  /** 是否**有能力**观察会话服务（看不到 ⇒ quiesced 必须为 false）。 */
  sessionsObservable: boolean
  maintenanceAtEntry: number
  maintenanceTimedOut: boolean
  flushFailed: string[]
  /** ★ 唯一判据：本代此刻确实不会再往会话日志里追加。 */
  quiesced: boolean
  /** 已落盘的全局最大 seq（无会话 ⇒ -1）。 */
  lastSeq: number
  /** 全部 live 会话（id + 各自已落盘 max seq）。 */
  sessions: Array<{ id: string; seq: number }>
  /** 建议新代 resume 的主活跃会话（可能为空串）。 */
  primarySessionId: string
  waitedMs: number
}

/**
 * 一个 agent 代理此刻处在哪个阶段。
 *
 * 优先 `phase.kind`（`agent-loop` 的真实三态）；拿不到 phase 时退回 `status`，
 * 并把**认不出的状态保守当成 running**（宁可多等/多杀，也不要误判成"没在写"）。
 */
/**
 * 一个 agent 代理此刻处在哪个阶段。
 *
 * 优先**实时** `readPhase()`（生产路径）；其次快照 `phaseKind`（假件/测试）；
 * 最后 `status` 兜底，且**认不出的状态保守当成 running**（宁可多等/多杀，也不要误判成"没在写"）。
 *
 * ⚠️ `status` 把 `maintenance`（压缩等）也算成 `'idle'`，所以只看 status 会漏掉正在写 `compaction/*` 的活动。
 */
export function agentPhase(a: DrainAgent): 'idle' | 'running' | 'maintenance' {
  const live = a.readPhase?.()
  if (live === 'running' || live === 'maintenance' || live === 'idle') return live
  if (a.phaseKind === 'running' || a.phaseKind === 'maintenance' || a.phaseKind === 'idle') return a.phaseKind
  if (a.status === 'running') return 'running'
  return a.status === 'idle' ? 'idle' : 'running'
}

/**
 * 等一组 promise 最多 `ms`（**不抛错**）；返回是否在预算内全部完成。
 * 不能用 `whenIdle()` 单独兜底：它在极端情况下可能永不 settle，而这里必须有界。
 */
async function settleWithin(ps: Array<Promise<unknown>>, ms: number): Promise<boolean> {
  if (ps.length === 0) return true
  const all = Promise.all(ps.map((p) => Promise.resolve(p).catch(() => undefined)))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((res) => {
    timer = setTimeout(() => res(false), Math.max(0, ms))
  })
  try {
    return await Promise.race([all.then(() => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 交接前的真静止点：停掉在跑的回合 → 等维护结束 → 落盘 → 报出真实位置。
 *
 * 全程**不抛错**（交接不能因为 drain 失败而挂死）：任何一步异常都折算成 `quiesced:false`，
 * 由控制面的封口逻辑决定下一步（强杀旧代），而不是让 handover 卡在 freeze。
 */
export async function drainForHandover(deps: DrainDeps): Promise<DrainOutcome> {
  const now = deps.now ?? Date.now
  const turnBudget = deps.turnTimeoutMs ?? 8000
  const maintBudget = deps.maintenanceTimeoutMs ?? 8000
  const t0 = now()

  const running = deps.agents.filter((a) => agentPhase(a) === 'running')
  const maint = deps.agents.filter((a) => agentPhase(a) === 'maintenance')
  const agentsObservable = deps.agentsObservable !== false
  const sessionsObservable = deps.sessionsObservable !== false

  // ① 停回合：cancel 后**等它真的 idle**。回合的流式 chunk/step/end/turn/end 都在这之前写完，
  //    所以这些写入仍然属于"旧代冻结前"，是干净的尾；冻结之后再写才是重叠。
  let cancelled = 0
  for (const a of running) {
    try {
      a.cancel?.({ kind: 'hook', reason: 'handover/freeze' }, { keepInbox: true })
      cancelled += 1
    } catch {
      /* 单个 agent 取消失败不阻断：下面仍按"没停住"处理 */
    }
  }
  const turnsWaited = await settleWithin(
    running.map((a) => Promise.resolve().then(() => a.whenIdle?.())),
    turnBudget,
  )

  // ② 维护（压缩等）：**等**它结束，不 cancel —— 半途中断可能留下悬空 compaction 标记。
  const maintWaited = await settleWithin(
    maint.map((a) => Promise.resolve().then(() => a.whenIdle?.())),
    maintBudget,
  )

  // ③ 落盘：走官方 sessions.flush（await 真正的持久化回调），逐会话记录失败。
  const flushFailed: string[] = []
  for (const s of deps.sessions) {
    try {
      await deps.flush(s)
    } catch {
      flushFailed.push(String(s.id ?? '?'))
    }
  }

  const stillBusy = deps.agents
    .map((a, i) => ({ a, name: String(a.id ?? `#${i}`) }))
    .filter(({ a }) => agentPhase(a) !== 'idle')
    .map(({ name }) => name)

  const lastSeqOf = (s: DrainSession): number => (typeof s.seq === 'number' && Number.isFinite(s.seq) ? s.seq - 1 : -1)
  const sessions = deps.sessions.map((s) => ({ id: String(s.id ?? ''), seq: lastSeqOf(s) }))
  const lastSeq = sessions.reduce((m, s) => (s.seq > m ? s.seq : m), -1)

  // 主活跃会话：优先"开工时正在跑回合的那个 agent 的会话"（用户正在看的这一份），
  // 再退到事件流记录的 lastActiveSessionId（必须在 live 列表里），再退到 seq 最大的 live 会话。
  const runningSessionIds = running.map((a) => String(a.sessionId ?? '')).filter(Boolean)
  const lastActive = deps.lastActiveSessionId && deps.sessions.some((s) => s.id === deps.lastActiveSessionId) ? deps.lastActiveSessionId : ''
  const biggest = sessions.slice().sort((a, b) => b.seq - a.seq)[0]?.id ?? ''
  const primarySessionId = runningSessionIds[0] || lastActive || biggest

  return {
    runningAtEntry: running.length,
    cancelled,
    stillBusy,
    agentsObservable,
    sessionsObservable,
    maintenanceAtEntry: maint.length,
    maintenanceTimedOut: maint.length > 0 && !maintWaited,
    flushFailed,
    // ★ "看不到 agent" 不是"没有 agent 在跑"的证据 ⇒ 不可观察时一律不当成停写。
    quiesced:
      agentsObservable && sessionsObservable && stillBusy.length === 0 && flushFailed.length === 0 && turnsWaited && maintWaited,
    lastSeq,
    sessions,
    primarySessionId,
    waitedMs: now() - t0,
  }
}

/**
 * 冻结标记（`state.drain.armed`）：只有**收到过 freeze** 的代才允许上报 static。
 * 它是个"这一代已经被要求交出"的显式痕迹，供身份提示与自检读；**不**参与静止判定
 * （旧实现把 `armed && lastSeq>=0` 当静止判据，等于没判 —— 见本文件头部）。
 */
export interface DrainState {
  armed: boolean
  lastStaticSeq: number
}

export function newDrain(): DrainState {
  return { armed: false, lastStaticSeq: -1 }
}

/**
 * 交接收尾的封口决策：**旧代还能不能写？**
 *
 * - 已 `quiesced`（冻结时观察到回合全停 + 落盘成功）⇒ 旧代可留作回滚网，按 `retainMs` 优雅退役。
 * - 未 `quiesced`（强切 / drain 超时 / 落盘失败）⇒ **必须在交出前门之前把它杀到确认消失**：
 *   它正在写的会话，下一步就会被新代以"磁盘前缀"重新加载并续写 ⇒ 必然重叠。
 *   代价是这一段没有"非破坏回滚"（旧代已死），这是**故意**的取舍：
 *   回滚丢的是几十秒可用性，重叠丢的是**该会话的全部历史**（永久、且事后难判）。
 */
export function sealPlan(quiesced: boolean): { killNow: boolean; why: string } {
  return quiesced
    ? { killNow: false, why: '旧代已确认停写（回合全停 + 落盘成功）→ 留作回滚网，按 retainMs 优雅退役' }
    : { killNow: true, why: '旧代未确认停写 → 交出前门之前必须强杀到 PID 消失（否则两代并发写同一份会话）' }
}
