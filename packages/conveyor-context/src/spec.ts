/**
 * Projection type tables (merge-extensible): host fold-state table + client-visible
 * wire table. A domain plugin augments both so `register<key>` type-checks and the
 * client (web UI) can read the conveyor directory / kept facts.
 * @module @dsh-brain/conveyor-context
 */

/** One indexed entry in the folded turn directory (摘要目录). */
export interface ConveyorDirectoryEntry {
  /** Session event seq that ended this turn. */
  seq: number
  turn: number
  /** Turn-end reason kind. */
  reason: string
  /** Folded summary placeholder — real summarization is DSH compaction's async job. */
  summary: string
}

/** One key fact lifted out of a tool result via a [[KEEP]] marker. */
export interface KeptFact {
  seq: number
  turn: number
  text: string
}

/** One real compaction fold recorded by DSH (from a `compaction/summary` / `compaction/prune` event). */
export interface ConveyorFold {
  /** DSH compaction id, when present. */
  compactionId: string
  /** Session event seq of the compaction/summary (or prune) event. */
  seq: number
  /** Folded summary text (extracted from the summary ContentBlocks; empty for a prune). */
  summary: string
  /** Seq set of the surface nodes that were shadowed/replaced by this fold. */
  shadowedSeqs: number[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
  /** Summarizing model (absent for a model-free prune). */
  model: string
}

/** Host-side fold state. Plain JSON (persisted-cache precondition). */
export interface ConveyorState {
  directory: ConveyorDirectoryEntry[]
  folds: ConveyorFold[]
  kept: KeptFact[]
  lastFoldSeq: number
}

/** Client-visible wire value (web UI reads this). */
export interface ConveyorView {
  directory: ConveyorDirectoryEntry[]
  folds: ConveyorFold[]
  kept: KeptFact[]
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    conveyor: ConveyorState
  }
  interface SessionProjectionMap {
    conveyor: ConveyorView
  }
}