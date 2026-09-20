/**
 * @module @dsh-brain/handover-agent/preseed
 *
 * 本代"我读到哪儿了"的读数（供 `HealthReply.caughtUpSeq` 与控制面的 ready **观测**用）。
 *
 * ## 2026-09-20：这里原先依赖**两个服务里的一个根本不存在**，所以读数恒 0
 *
 * 旧实现 `computeCaughtUpSeq()` 依次取：
 *   · `sessionPersistence.listSessions()` —— **这个方法在上游不存在**。服务名 `sessionPersistence`
 *     是真的（`@deepseek-ai/dsh-session-persistence` 里 `super(ctx, "sessionPersistence")`），
 *     但它**没有** `listSessions` ⇒ `ids = []` ⇒ 下面的循环一次都不跑；
 *   · `sessionProjectionCache.coldSnapshot(id).asOfSeq` —— 这个**是真的**（服务
 *     `@deepseek-ai/dsh-session-projection-cache`，profile 里也装了）。
 * 于是函数**永远返回 0**：171 条 freeze 记录里 `lastSeq` 全是 0，ready/追平门槛从未量过任何东西。
 * 这与本项目反复修的"假绿"是同一类 —— **一个从未为真的判据**（详见 `docs/handover-vs-restart.md` §8.4）。
 *
 * ⇒ 现在改成只回答一个**能真答**的问题：**本进程此刻持有的 live 会话已落盘到哪个 seq**。
 * 语义变小了，但它是真的：
 *   · active 代：它持有会话 ⇒ 报真实进度；
 *   · 刚拉起的 staging 代：还没加载任何会话 ⇒ **报 0 是诚实的**（"我什么都没读"），
 *     而不是假装"我追平了"。因此**控制面不得**拿这个值当"追平门槛"来 gate 推进
 *     （见 `coordinator.ts` 的 `waitReady()`：结构性就绪 + `observeCatchUp()` 只记录不阻塞）。
 */
/** 会话注册表在本插件里需要的面（`ctx.inject(['sessions'])` 拿到的那个）。 */
export interface SessionsShim {
  list?(): unknown[]
  flush?(session: unknown): Promise<unknown>
}

/**
 * 本进程 live 会话里已落盘的最大 seq（= `session.seq - 1` 的最大值；无 live 会话 ⇒ 0）。
 *
 * ★ 2026-09-20：**必须由调用方把 `sessions` 服务传进来**（在我们插件里经 `ctx.inject(['sessions'])` 取得），
 * 不能直接读 `ctx.sessions` —— 那在真机上是 `undefined`（未声明服务依赖），于是：
 * `sessions=0` / `lastSeq=-1` / **flush 一次都没跑过**。这是 2026-09-20 真机验收当场抓到的假绿
 * （当时明明有一个回合在跑、会话日志也在写）。
 *
 * 为什么不用 `sessionPersistence` 列会话：它那个方法名（`listSessions`）不存在，
 * 是"看起来查过了"的假判据；而 `sessions.list()` 返回的是**本进程真实持有的**会话对象，
 * `get seq()` 就是它的日志长度（上游形状由 `scripts/test-handover-drain.mjs` 的 C 段钉住）。
 */
export async function liveMaxSeq(sessions?: SessionsShim): Promise<number> {
  try {
    const live = typeof sessions?.list === 'function' ? sessions.list() : []
    let max = 0
    for (const s of live as Array<{ seq?: number }>) {
      if (typeof s?.seq === 'number' && Number.isFinite(s.seq) && s.seq - 1 > max) max = s.seq - 1
    }
    return max
  } catch {
    // 拿不到服务不阻断 boot：报 0（"我什么都没读"）而不是假装追平。
    return 0
  }
}
