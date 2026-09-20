/**
 * @module @dsh-brain/switchboard/handover-protocol
 *
 * 交接协议共享契约：Switchboard（协调器/前门）与 Handover-agent（代内插件）
 * 之间经 loopback admin HTTP + on-disk JSON 交换的数据结构。
 *
 * 这些类型是**单一真相**（single source）：两端都从这里 import。协议自带的
 * `mode`/`payload` 槽位是方案③（轮内任意点全状态快照）的预留 seam——第一版
 * 恒 `mode:'replay'`、`payload:undefined`，未来补快照可无感升级。
 */

/** 代际来源的 bundle 身份标记（可观察痕迹，便于 E2E 断言"由谁应答"）。 */
export interface GenIdentity {
  gen: string
  port: number
  adminPort: number
  /** 磁盘上 profile/bundle 的快照指纹，用于区分 V1/V2/V3。 */
  bundleHash: string
}

/** 在线代际在 Switchboard 侧的登记记录。 */
export interface GenInstance {
  id: string
  gen: string
  port: number
  adminPort: number
  pid: number
  role: GenRole
  state: 'starting' | 'ready' | 'active' | 'draining' | 'frozen' | 'retired' | 'failed'
  /** 最近一次心跳时间（epoch ms）。 */
  lastHeartbeat: number
  /** 新进程回放追平到的全局最大会话 seq（readFrom 读出）或 A 上报的冻结 seq。 */
  caughtUpSeq: number
}

/** 交接阶段的整体状态机。 */
export type HandoverStage =
  | 'idle'
  | 'spawn'
  | 'ready'
  | 'freeze'
  | 'promote'
  | 'flip'
  | 'verify'
  | 'retire'
  | 'aborted'
  | 'rolled-back'

export type GenRole = 'active' | 'staging'

/**
 * on-disk 单写租约（`{COORD_DIR}/lease.json`）。
 * 第③步之后写入本表：token 是每次授写唯一 UUID；expiresAt 心跳续约；freezeSeq 为
 * 上一代冻结时已落盘的全局最大 seq，新代只能从 ≥freezeSeq 之后 append。
 */
export interface LeaseState {
  generation: number
  /** 当前持有写权的代。 */
  activeGen: { gen: string; port: number; pid: number }
  /** 每次授写唯一的 fencing token。 */
  writerToken: string
  /** TTL 过期点（epoch ms）。 */
  expiresAt: number
  /** 上一代冻结点之后才允许新代写。 */
  freezeSeq: number
  /** 单调递增门闩序号（防回退/防重复）。 */
  lastFencingSeq: number
  stage: HandoverStage
  mode: 'replay' | 'snapshot'
}

/** switchboard 崩溃后可回放的事件溯源日志行（`{COORD_DIR}/state.jsonl`）。 */
export interface StateRecord {
  t: number
  stage: HandoverStage
  gen?: string
  seq?: number
  note?: string
}

/* ── 两端 admin 交互（loopback HTTP，JSON）────────────────────────── */

export interface HealthReply {
  gen: string
  mode: 'staging' | 'active' | 'demoted'
  holdingLease: boolean
  caughtUpSeq: number
  staticAt: number
}

/**
 * 冻结应答。**它的每个字段都必须来自"停写之后"的观测** —— 2026-09-15 的事故正是
 * 因为这里报的是"意图"而不是观测：`static` 恒 true、`lastSeq` 恒 0、`sessions` 报的是
 * 事件流里"最近活跃"的那一条（实测报了个**不是**在跑回合的会话，导致新代 resume 错人）。
 */
export interface FreezeReply {
  /** 旧语义：是否已到静止点。现在 = `quiesced`（保留字段名以兼容两端版本错配）。 */
  static: boolean
  /** 已落盘的全局最大 seq（**由 live 会话的 `seq-1` 算出**，不再是暖机读数）。 */
  lastSeq: number
  /** 全部 live 会话 + 各自已落盘 max seq（控制面按 seq 排序挑 resume 目标时的兜底）。 */
  sessions: Array<{ id: string; seq: number }>
  /**
   * ★★ 真判据：本代此刻**确实不会再往会话日志追加**。要求"开工时在跑的回合全部被 cancel
   * 且在预算内观察到 idle" + "每个会话都经官方 flush 落盘且未抛错"。
   * 缺省（老版本 gen）按 `false` 处理：控制面会强杀旧代再交出前门（安全方向，见 `sealPlan`）。
   */
  quiesced?: boolean
  /** 建议新代 resume 的主活跃会话：优先"有回合在跑的那个 agent 的会话"。 */
  primarySessionId?: string
  /** 诊断留痕（人读；写进 state.jsonl 的 note）。 */
  drain?: {
    runningAtEntry: number
    cancelled: number
    stillBusy: string[]
    /** gen 侧**有没有能力**观察 agent；false ⇒ `quiesced` 必然为 false（看不到 ≠ 空闲）。 */
    agentsObservable: boolean
    /** 同上，会话服务（看不到 ⇒ quiesced 必为 false）。 */
    sessionsObservable?: boolean
    maintenanceAtEntry: number
    maintenanceTimedOut: boolean
    flushFailed: string[]
    waitedMs: number
  }
}

export interface PromoteRequest {
  writerToken: string
  gen: string
  /** 可选：上一代冻结时的"主活跃会话 id"（FreezeReply.sessions 里 seq 最大者）。 */
  resumeSessionId?: string
}

export interface ProbeReply {
  ok: boolean
  gen: string
  /** 供刷新的握手结果：http 状态码或错误文本。 */
  detail?: string
}

/**
 * 延迟切换的"准备就绪"应答：控制面请活跃代先收尾本轮，等其 turn/end（或 grace 兜底）
 * 后才真正 spawn 新代。`foundAgent` = 是否找到了可 steer 的 live 会话代理；
 * `waitedForTurnEnd` = 是否真的等到了一个"回合结束"（而非 grace 超时兜底）。
 *
 * `turnInFlight`（2026-09-14 加）：**调用时刻活跃代是否有未收尾的回合**。
 * 控制面据此决定换代后要不要注入"续跑"提示：
 * - `true`  → 当时真有活在跑 → 换代后注入续跑（这是该机制存在的唯一理由）
 * - `false` → 会话是**空闲**的（或卡在等人类输入）→ **不注入**，
 *   否则会无端唤醒一轮（污染会话、白烧 token），甚至把"等人类确认"的回合踢成不一致态。
 */
export interface PrepareReply {
  ok: boolean
  foundAgent: boolean
  waitedForTurnEnd: boolean
  reason?: string
  /** 调用时刻是否有未收尾的回合。`false` ⇒ idle（或 blocked）⇒ 控制面不应注入续跑。 */
  turnInFlight?: boolean
}

export interface HandoverCommand {
  cmd: 'handover' | 'health' | 'fail'
  /** 注入失败用的开关（E2E 用）。 */
  fail?: 'spawn' | 'catchup' | 'freeze'
}

/**
 * 方案③ seam：交接负载槽位。第一版 `mode:'replay'` 且无 payload；
 * 未来 `@dsh-brain/snapshot-full` 在 freeze 时把运行态快照放进 `payload`，
 * promote 时取出导入——对本数据结构与行列式协议零改动。
 */
export interface HandoverEnvelope {
  mode: 'replay' | 'snapshot'
  payload?: Record<string, unknown>
}