import { randomUUID } from 'node:crypto';
import type { LeaseState } from './handover-protocol.js';
export declare class LeaseStore {
    readonly file: string;
    private state;
    constructor(coordDir: string);
    get current(): Readonly<LeaseState>;
    /** 幂等写：就地更新(含 rename 原子替换)，并维护单调 fencing seq。 */
    private commit;
    /** 授予写权；`token` 给定则复用（须与 spawn 时注入 gen 的 env 一致）。 */
    grant(gen: string, port: number, pid: number, ttlMs: number, freezeSeq: number, mode: 'replay' | 'snapshot', token?: string): LeaseState;
    /** 心跳续约：仅当 token 匹配放行；否则不动（等待 coordinator 处理被夺权者）。 */
    heartbeat(token: string, ttlMs: number): boolean;
    /** 更新当前 stage（阶段镜像，便于崩溃后恢复）。 */
    setStage(stage: LeaseState['stage']): LeaseState;
    /** 是否仍有效（未过期且确有持有者）。 */
    isHeld(): boolean;
    /** 崩溃恢复判定：token 匹配的旧持有者心跳是否仍在（在即只读续约，否则拒绝写）。 */
    stale(): boolean;
    /** 崩溃后清空 lease，让新 bootstrap gen 以干净状态启动。 */
    clear(): void;
    private load;
}
export { randomUUID };
