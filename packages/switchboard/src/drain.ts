/**
 * @module @dsh-brain/handover-agent/drain
 *
 * 工具子步骤边界的静止点判定（方案②切点）。
 * 收到 freeze 后：武装 drainArmed → 在下一次模型请求/agent-pre-step 边界不再发起
 * 新请求 → 让当前在跑的子步骤自然完成 → flush 全部会话 → 报告 static 与 lastSeq。
 *
 * DSH 的持久化检查点在"模型请求前/顶级工具副作用前/agent/pre-step 前"执行，
 * 因此"上一步工具结果已落盘、下一步未开跑"就是一个可静止点；我们在此边界挂门。
 */
import type { Context } from '@deepseek-ai/cordis'
import { computeCaughtUpSeq } from './preseed.js'

export interface DrainState {
  armed: boolean
  lastStaticSeq: number
}

export function newDrain(): DrainState {
  return { armed: false, lastStaticSeq: -1 }
}

/**
 * 静止点判定：只有当无进行中模型请求、无进行中工具、且已 flush 后才算 static。
 * DSH 在 agent/工具边界自行 flush，因此计算 caughtUpSeq（=已落盘 max seq）即代表
 * "已持久化到哪"。armed 且到达静止点 → 视为 static。
 * @returns 是否已静止 + 当前已落盘 seq。
 */
export async function evaluateStatic(
  ctx: Context,
  state: DrainState,
): Promise<{ static: boolean; lastSeq: number }> {
  const lastSeq = await computeCaughtUpSeq(ctx)
  state.lastStaticSeq = lastSeq
  return { static: state.armed && lastSeq >= 0, lastSeq }
}

/**
 * 冻结实现：armed 后配合 evaluateStatic 到达静止点即返回 static。
 * 轮内正在跑的那一步（未落盘）允许被"只丢"，与方案②定义吻合。
 */
export { evaluateStatic as freezeCompute }