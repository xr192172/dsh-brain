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
    gen: string;
    port: number;
    adminPort: number;
    /** 磁盘上 profile/bundle 的快照指纹，用于区分 V1/V2/V3。 */
    bundleHash: string;
}
/** 在线代际在 Switchboard 侧的登记记录。 */
export interface GenInstance {
    id: string;
    gen: string;
    port: number;
    adminPort: number;
    pid: number;
    role: GenRole;
    state: 'starting' | 'ready' | 'active' | 'draining' | 'frozen' | 'retired' | 'failed';
    /** 最近一次心跳时间（epoch ms）。 */
    lastHeartbeat: number;
    /** 新进程回放追平到的全局最大会话 seq（readFrom 读出）或 A 上报的冻结 seq。 */
    caughtUpSeq: number;
}
/** 交接阶段的整体状态机。 */
export type HandoverStage = 'idle' | 'spawn' | 'ready' | 'freeze' | 'promote' | 'flip' | 'verify' | 'retire' | 'aborted' | 'rolled-back';
export type GenRole = 'active' | 'staging';
/**
 * on-disk 单写租约（`{COORD_DIR}/lease.json`）。
 * 第③步之后写入本表：token 是每次授写唯一 UUID；expiresAt 心跳续约；freezeSeq 为
 * 上一代冻结时已落盘的全局最大 seq，新代只能从 ≥freezeSeq 之后 append。
 */
export interface LeaseState {
    generation: number;
    /** 当前持有写权的代。 */
    activeGen: {
        gen: string;
        port: number;
        pid: number;
    };
    /** 每次授写唯一的 fencing token。 */
    writerToken: string;
    /** TTL 过期点（epoch ms）。 */
    expiresAt: number;
    /** 上一代冻结点之后才允许新代写。 */
    freezeSeq: number;
    /** 单调递增门闩序号（防回退/防重复）。 */
    lastFencingSeq: number;
    stage: HandoverStage;
    mode: 'replay' | 'snapshot';
}
/** switchboard 崩溃后可回放的事件溯源日志行（`{COORD_DIR}/state.jsonl`）。 */
export interface StateRecord {
    t: number;
    stage: HandoverStage;
    gen?: string;
    seq?: number;
    note?: string;
}
export interface HealthReply {
    gen: string;
    mode: 'staging' | 'active' | 'demoted';
    holdingLease: boolean;
    caughtUpSeq: number;
    staticAt: number;
}
export interface FreezeReply {
    static: boolean;
    lastSeq: number;
    sessions: Array<{
        id: string;
        seq: number;
    }>;
}
export interface PromoteRequest {
    writerToken: string;
    gen: string;
}
export interface ProbeReply {
    ok: boolean;
    gen: string;
    /** 供刷新的握手结果：http 状态码或错误文本。 */
    detail?: string;
}
export interface HandoverCommand {
    cmd: 'handover' | 'health' | 'fail';
    /** 注入失败用的开关（E2E 用）。 */
    fail?: 'spawn' | 'catchup' | 'freeze';
}
/**
 * 方案③ seam：交接负载槽位。第一版 `mode:'replay'` 且无 payload；
 * 未来 `@dsh-brain/snapshot-full` 在 freeze 时把运行态快照放进 `payload`，
 * promote 时取出导入——对本数据结构与行列式协议零改动。
 */
export interface HandoverEnvelope {
    mode: 'replay' | 'snapshot';
    payload?: Record<string, unknown>;
}
