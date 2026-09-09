/**
 * @module @dsh-brain/handover-agent/preseed
 *
 * 冷读暖机：staging gen 用它把共享 home 的投影层暖到当前已落盘 seq，
 * 汇总"本代可读到的全局最大 seq"（caughtUpSeq）供 Switchboard 做 ready 门槛。
 *
 * 走 `sessionProjectionCache.coldSnapshot(id)` = restoreFloor → readFrom → restore
 * 的冷读阶梯（DSH 官方支持多进程读安全）；获取服务一律可选检查、失败降级，绝不让
 * 正常 boot 因为暖机失败而崩。
 */
import type { Context } from '@deepseek-ai/cordis'

type MaybeService = { [k: string]: unknown } | undefined

function svc(ctx: Context, name: string): MaybeService {
  const anyCtx = ctx as unknown as Record<string, unknown>
  return anyCtx[name] as MaybeService
}

/**
 * 计算本代当前读到的全局最大 settle seq。无服务/异常时返回 0（视为"尚未追平"）。
 * E2E 里以"old gen freeze 的 lastSeq ≤ 本值"作为 ready / re-ready 判据。
 */
export async function computeCaughtUpSeq(ctx: Context): Promise<number> {
  let max = 0
  try {
    const cache = svc(ctx, 'sessionProjectionCache')
    const list = svc(ctx, 'sessionPersistence')
    const ids: string[] =
      typeof list?.listSessions === 'function'
        ? ((await (list.listSessions as () => Promise<unknown>)()) as string[])
        : []
    for (const id of ids) {
      if (typeof cache?.coldSnapshot !== 'function') break
      const snap = ((await (cache.coldSnapshot as (i: string) => Promise<unknown>)(id)) as {
        asOfSeq?: number
      }) ?? {}
      if (typeof snap.asOfSeq === 'number' && snap.asOfSeq > max) max = snap.asOfSeq
    }
  } catch {
    // degrade：暖机失败不阻断 boot
    max = 0
  }
  return max
}