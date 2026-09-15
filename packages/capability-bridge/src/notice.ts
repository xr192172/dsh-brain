/**
 * notice.ts —— 能力变更通知的「折叠」内核（P4 骨架）
 *
 * 设计依据：`docs/capability-registry-evolution.md` §6.1 / §6.2 / §6.3。
 * 本模块是**纯函数**：不碰 ctx、不碰 IO、不读时钟 —— 因此可离线自证。
 *
 * ## 四条要点（都来自实证结论，不是发明）
 *
 * 1. **写出去的是「完整当前集合快照」，不是增量。**
 *    ⇒ 丢掉的后果是「不知道」（有 `list_capabilities` 兜底），**而不是「以为错」**。
 *    这正是 §6.3.3 —— 它松开了"物化必须与压缩摘要同一次写入"那条约束：
 *    快照里没有"卸载"这种相对量，所以不存在"摘要丢了加载却留下卸载"的错状态。
 *
 * 2. **判据是「当前集合 == 上次折叠时的集合？」**（§6.1.3）
 *    相等 ⇒ **整段 delta 可丢**（不写），只推进已折叠水位。
 *    这比"成对相消"更强也更简单：`+X,-X` 与 `-X,+X` 的**顺序敏感**问题自然消失，
 *    因为我们根本不比对事件，只比对**状态**。
 *
 * 3. **归一化（排序 + 去重）后再比对**，否则集合顺序噪声会造成无意义的重写。
 *
 * 4. **幂等**：同一状态重复折叠 ⇒ 第二次起恒为 `no-pending` / `dropped`，绝不重复写。
 *
 * ## 为什么"不写"也要推进水位
 * 否则那段 delta 会永远留在 pending 里，每次 append 都重新计算一遍 ——
 * 不是错，但是白做功；且会让"有没有待处理变更"这个判断永远为真。
 */

/** 一次能力变更（由能力库的动作产生，写进**非 surface** 会话事件）。 */
export interface CapChange {
  /** 会话事件 seq —— 折叠水位就是比它 */
  seq: number
  at: string
  action: 'registered' | 'gated' | 'superseded' | 'merged' | 'retired'
  id: string
  detail?: string
}

/** 折叠状态：需要持久化（住会话事件的 data 里，或插件的状态文件）。 */
export interface FoldState {
  /** 已折叠到的事件 seq 水位（含） */
  foldedUpToSeq: number
  /** 上次**写出去**的快照指纹；空串 = 从未写过 */
  lastSnapshotHash: string
}

export const initialFoldState: FoldState = { foldedUpToSeq: -1, lastSnapshotHash: '' }

export type FoldOutcome =
  | { kind: 'no-pending'; next: FoldState }
  | { kind: 'dropped'; next: FoldState; droppedCount: number }
  | { kind: 'emit'; text: string; next: FoldState; pendingCount: number }

/**
 * 归一化集合：排序 + 去重。
 * 必须归一化后再比对 —— 否则"同一集合、不同顺序"会被误判成变化，产生无谓的重写。
 */
export function normalizeSnapshot(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('\n')
}

/** 32 位 FNV-1a。够用的变化检测，不需要 crypto。 */
export function hashSnapshot(normalized: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 渲染给模型看的那一行。
 *
 * ★ 它是**快照**（"当前有哪些"），不是 delta（"刚加了什么"）——
 *   这是本设计最关键的一条，见文件头第 1 点。
 */
export function renderNotice(ids: readonly string[]): string {
  const set = [...new Set(ids)].sort()
  if (!set.length) return '能力集合已更新：当前无可用能力。（明细用 list_capabilities）'
  return (
    `能力集合已更新：当前 ${set.length} 项 —— ${set.join(', ')}\n` +
    `（这是**快照**，不是增量；明细与验收状态用 list_capabilities 查）`
  )
}

/**
 * 折叠：给定「全部变更历史 + 折叠状态 + 当前实际能力集合」，决定**要不要写、写什么**。
 *
 * @param changes 全部变更（按 seq 升序或乱序都可，内部会筛）
 * @param state   上次的折叠状态
 * @param liveIds 当前**实际**可用的能力 id 集合（权威来源：能力库 / provider 注册表）
 */
export function foldNotices(changes: readonly CapChange[], state: FoldState, liveIds: readonly string[]): FoldOutcome {
  const pending = changes.filter((c) => c.seq > state.foldedUpToSeq)
  if (!pending.length) return { kind: 'no-pending', next: state }

  const maxSeq = pending.reduce((m, c) => (c.seq > m ? c.seq : m), state.foldedUpToSeq)
  const normalized = normalizeSnapshot(liveIds)
  const h = hashSnapshot(normalized)

  // 当前集合与上次写出去的一致 ⇒ 整段 delta 可丢（§6.1.3）。
  // 注意仍然推进水位：这些变更已经被"考虑过"了，不该永远留在 pending。
  if (h === state.lastSnapshotHash) {
    return { kind: 'dropped', droppedCount: pending.length, next: { foldedUpToSeq: maxSeq, lastSnapshotHash: h } }
  }

  return {
    kind: 'emit',
    text: renderNotice(liveIds),
    pendingCount: pending.length,
    next: { foldedUpToSeq: maxSeq, lastSnapshotHash: h },
  }
}

/**
 * 把一次变更追加进历史（纯粹为了测试与调用方便；真实链路由 session 事件承载）。
 * `seq` 递增由调用方保证 —— 他就是会话事件的 seq。
 */
export function appendChange(changes: CapChange[], c: Omit<CapChange, 'seq'>, nextSeq: number): CapChange[] {
  return [...changes, { ...c, seq: nextSeq }]
}
