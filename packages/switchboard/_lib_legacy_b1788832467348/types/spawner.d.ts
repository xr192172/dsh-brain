/**
 * @module @dsh-brain/switchboard/spawner
 *
 * 拉起一个 dsh gen 进程（新代际），注入 per-gen env 与 `--port/--patch`。
 * 是"控制面 spawn"而非 agent 调 Stop-Process——进程生亡归 Switchboard 管。
 */
import { type ChildProcess } from 'node:child_process';
export interface SpawnOptions {
    nodeBin: string;
    dshBin: string;
    profile: string;
    port: number;
    adminPort: number;
    gen: string;
    leaseToken: string;
    mode: 'staging' | 'active';
    /** 预留；当前端口走 CLI --port，config 走 env，不再用 --patch。 */
    overlayFile?: string;
    /** 透传 key 池等宿主环境。 */
    envExtra?: Record<string, string>;
    /** per-gen 落地目录（sqlite/cache/live 文件底座）。 */
    genDir: string;
}
export interface SpawnedGen {
    proc: ChildProcess;
    pid: number;
    /** 优雅中断：先 SIGTERM，给若干毫秒后仍不退才 SIGKILL。 */
    stop(graceMs?: number): Promise<void>;
}
export declare function spawnGen(opts: SpawnOptions): SpawnedGen;
