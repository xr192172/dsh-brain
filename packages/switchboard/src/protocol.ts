/**
 * @module @dsh-brain/switchboard (gen-side protocol)
 *
 * wire 契约（HealthReply/FreezeReply/PromoteRequest/ProbeReply/HandoverEnvelope/HandoverStage）
 * **单向真相**：从 ./handover-protocol.ts re-export，两端共用同一份，彻底消除 hand-written 镜像的漂移。
 * 只有 gen 侧本地的环境配置（HandoverConfig / HandoverMode，由 env 或 patch 注入，非 wire 契约）才留在此处。
 */
export type {
  FreezeReply,
  HandoverEnvelope,
  HandoverStage,
  HealthReply,
  PrepareReply,
  ProbeReply,
  PromoteRequest,
} from './handover-protocol.js'

/** gen 侧写模式（随 HANDOVER_MODE env / patch 注入，不属于 wire 交换）。 */
export type HandoverMode = 'staging' | 'active' | 'demoted'

/** gen 侧交接环境配置（由 spawner env 或 bundle patch config 组装）。 */
export interface HandoverConfig {
  port: number
  gen: string
  leaseToken: string
  mode: HandoverMode
  genDir: string
}