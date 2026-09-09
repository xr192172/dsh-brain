import { LeaseStore } from './lease.js';
import type { FrontDoor } from './proxy.js';
import { type SpawnedGen } from './spawner.js';
import { AdminClient } from './adminclient.js';
import type { GenInstance, HandoverStage } from './handover-protocol.js';
export interface CoordinatorConfig {
    nodeBin: string;
    dshBin: string;
    profile: string;
    portBase: number;
    adminBase: number;
    coordDir: string;
    workDir: string;
    envExtra?: Record<string, string>;
    ttlMs: number;
    readyTimeoutMs: number;
    freezeTimeoutMs: number;
    retainMs: number;
}
interface Cage {
    inst: GenInstance;
    spawned: SpawnedGen;
    client: AdminClient;
}
export declare class Coordinator {
    private readonly cfg;
    private readonly lease;
    private readonly stateLog;
    private readonly front;
    private active;
    private stage;
    private genCounter;
    constructor(cfg: CoordinatorConfig, front: FrontDoor, active: Cage);
    get stageName(): HandoverStage;
    /** 确保当前活跃代持有租约（供 main 在崩溃恢复后调用；修复"热重启时活跃代无租约"）。 */
    ensureActiveLease(): void;
    /** 对外暴露租约（main 用于心跳续约与状态查询）。 */
    getLease(): LeaseStore;
    private record;
    /** 原子换 active：返回被换下的旧代。 */
    private swapActive;
    private activeSeq;
    handover(profileOverride?: string): Promise<HandoverStage>;
    private waitCatchUp;
    private abort;
}
export {};
