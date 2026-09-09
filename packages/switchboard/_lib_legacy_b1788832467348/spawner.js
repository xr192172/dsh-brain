/**
 * @module @dsh-brain/switchboard/spawner
 *
 * 拉起一个 dsh gen 进程（新代际），注入 per-gen env 与 `--port/--patch`。
 * 是"控制面 spawn"而非 agent 调 Stop-Process——进程生亡归 Switchboard 管。
 */
import { spawn } from 'node:child_process';
export function spawnGen(opts) {
    const env = {
        ...process.env,
        ...opts.envExtra,
        HANDOVER_GEN: opts.gen,
        HANDOVER_ADMIN_PORT: String(opts.adminPort),
        HANDOVER_LEASE_TOKEN: opts.leaseToken,
        HANDOVER_MODE: opts.mode,
        HANDOVER_GEN_DIR: opts.genDir,
        HANDOVER_CONTROL: process.env.HANDOVER_CONTROL || 'http://127.0.0.1:31800',
    };
    const args = [
        opts.dshBin,
        '--profile',
        opts.profile,
        '--port',
        String(opts.port),
        '--no-open',
    ];
    const proc = spawn(opts.nodeBin, args, { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    const spawned = {
        proc,
        pid: proc.pid ?? 0,
        async stop(graceMs = 4000) {
            if (proc.exitCode !== null || proc.killed)
                return;
            proc.kill(); // SIGTERM（Windows 上为 TerminateProcess 语义需降级处理）
            await new Promise((resolve) => {
                const t = setTimeout(() => {
                    proc.kill('SIGKILL');
                    resolve();
                }, graceMs);
                proc.once('exit', () => {
                    clearTimeout(t);
                    resolve();
                });
            });
        },
    };
    return spawned;
}
