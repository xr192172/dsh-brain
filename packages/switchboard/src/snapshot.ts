/**
 * @module @dsh-brain/handover-agent/snapshot
 *
 * 方案③ seam：轮内任意点全状态快照的可选提供者。
 * 首版注册 `kind:'none'`（纯日志回放，即方案②）。未来 `@dsh-brain/snapshot-full`
 * 实现 `exportSnapshot`（freeze 时把运行态打进 payload）与 `importSnapshot`
 * （promote 时导入），对协议与 Switchboard 零改动——只要它把本接口的实现
 * 替换注册即可，握手协议里 `payload` 槽位已经留好。
 */
export interface SnapshotBlob {
  mode: 'full'
  exportedAt: number
  gen: string
  payload: Record<string, unknown>
}

export interface SnapshotProvider {
  readonly kind: 'none' | 'full'
  exportSnapshot(gen: string): Promise<SnapshotBlob | null>
  importSnapshot(blob: SnapshotBlob): Promise<void>
}

/** 首版占位提供者：什么都不导出/导入（走日志回放）。 */
export const noSnapshot: SnapshotProvider = {
  kind: 'none',
  async exportSnapshot() {
    return null
  },
  async importSnapshot() {},
}

export { noSnapshot as default }