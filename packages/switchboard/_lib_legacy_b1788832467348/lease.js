/**
 * @module @dsh-brain/switchboard/lease
 *
 * on-disk 单写租约 + fencing token。放 `{COORD_DIR}/lease.json`。
 * 崩溃后由 coordinator 回读 `state.jsonl` + `lease.json` 恢复托管。
 * 仅 Switchboard（协调器）持有并写本文件——这就是"单一写者"的物理锚点。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const EMPTY = {
    generation: 0,
    activeGen: { gen: '', port: 0, pid: 0 },
    writerToken: '',
    expiresAt: 0,
    freezeSeq: -1,
    lastFencingSeq: 0,
    stage: 'idle',
    mode: 'replay',
};
export class LeaseStore {
    file;
    state;
    constructor(coordDir) {
        this.file = join(coordDir, 'lease.json');
        mkdirSync(coordDir, { recursive: true });
        this.state = this.load();
    }
    get current() {
        return this.state;
    }
    /** 幂等写：就地更新(含 rename 原子替换)，并维护单调 fencing seq。 */
    commit(mut) {
        mut(this.state);
        this.state.lastFencingSeq += 1;
        const tmp = this.file + '.tmp';
        writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
        renameSync(tmp, this.file);
        return this.state;
    }
    /** 授予写权；`token` 给定则复用（须与 spawn 时注入 gen 的 env 一致）。 */
    grant(gen, port, pid, ttlMs, freezeSeq, mode, token) {
        return this.commit((s) => {
            s.generation += 1;
            s.activeGen = { gen, port, pid };
            s.writerToken = token && token.length ? token : randomUUID();
            s.expiresAt = Date.now() + ttlMs;
            s.freezeSeq = freezeSeq;
            s.mode = mode;
        });
    }
    /** 心跳续约：仅当 token 匹配放行；否则不动（等待 coordinator 处理被夺权者）。 */
    heartbeat(token, ttlMs) {
        if (token !== this.state.writerToken)
            return false;
        this.commit((s) => {
            s.expiresAt = Date.now() + ttlMs;
        });
        return true;
    }
    /** 更新当前 stage（阶段镜像，便于崩溃后恢复）。 */
    setStage(stage) {
        return this.commit((s) => {
            s.stage = stage;
        });
    }
    /** 是否仍有效（未过期且确有持有者）。 */
    isHeld() {
        return this.state.writerToken !== '' && this.state.expiresAt > Date.now();
    }
    /** 崩溃恢复判定：token 匹配的旧持有者心跳是否仍在（在即只读续约，否则拒绝写）。 */
    stale() {
        return !this.isHeld();
    }
    /** 崩溃后清空 lease，让新 bootstrap gen 以干净状态启动。 */
    clear() {
        this.commit((s) => {
            s.generation = 0;
            s.activeGen = { gen: '', port: 0, pid: 0 };
            s.writerToken = '';
            s.expiresAt = 0;
            s.freezeSeq = -1;
            s.lastFencingSeq = 0;
            s.stage = 'idle';
            s.mode = 'replay';
        });
    }
    load() {
        if (!existsSync(this.file))
            return { ...EMPTY, generation: 0 };
        try {
            const raw = readFileSync(this.file, 'utf8');
            const j = JSON.parse(raw);
            return { ...EMPTY, ...j };
        }
        catch {
            return { ...EMPTY };
        }
    }
}
export { randomUUID };
