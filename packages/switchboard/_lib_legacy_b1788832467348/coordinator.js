/**
 * @module @dsh-brain/switchboard/coordinator
 *
 * 交接状态机：idle→spawn→ready→freeze→promote→flip→verify→retire。
 * 前门翻转由 FrontDoor.swapActive 原子完成；单写者由 LeaseStore 保证。
 * 失败路径：spawn/ready/freeze 未达标 → abort（旧 gen 继续服务，绝不 flip）；
 * verify 失败 → 非破坏回滚 flip 回旧 gen。退役由控制面触发（非 agent 强杀）。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LeaseStore } from './lease.js';
import { spawnGen } from './spawner.js';
import { AdminClient } from './adminclient.js';
import { writeOverlay } from './overlay.js';
export class Coordinator {
    cfg;
    lease;
    stateLog;
    front;
    active;
    stage = 'idle';
    genCounter = 0;
    constructor(cfg, front, active) {
        this.cfg = cfg;
        mkdirSync(cfg.coordDir, { recursive: true });
        this.lease = new LeaseStore(cfg.coordDir);
        const stateFile = join(cfg.coordDir, 'state.jsonl');
        this.stateLog = (r) => appendFileSync(stateFile, JSON.stringify(r) + '\n', 'utf8');
        this.front = front;
        this.active = active;
        // 初始 active 指向 bootstrap gen A（前门翻转必需）
        front.setActive(active.inst);
        // 给 bootstrap 活跃代写租约：让 status/lease 反映真实 active（而非空），并启用心跳续约
        if (!this.lease.isHeld()) {
            this.lease.grant(active.inst.gen, active.inst.port, active.inst.pid, cfg.ttlMs, -1, 'replay');
        }
    }
    get stageName() {
        return this.stage;
    }
    /** 确保当前活跃代持有租约（供 main 在崩溃恢复后调用；修复"热重启时活跃代无租约"）。 */
    ensureActiveLease() {
        if (!this.lease.isHeld()) {
            this.lease.grant(this.active.inst.gen, this.active.inst.port, this.active.inst.pid, this.cfg.ttlMs, -1, 'replay');
        }
    }
    /** 对外暴露租约（main 用于心跳续约与状态查询）。 */
    getLease() {
        return this.lease;
    }
    record(note) {
        this.stateLog({ t: Date.now(), stage: this.stage, gen: this.active.inst.gen, note });
    }
    /** 原子换 active：返回被换下的旧代。 */
    swapActive(next) {
        const old = this.active;
        this.active = next;
        this.front.setActive(next.inst);
        return old;
    }
    async activeSeq() {
        const h = await this.active.client.health(3000);
        return h?.caughtUpSeq ?? -1;
    }
    async handover(profileOverride) {
        const cfg = this.cfg;
        // 覆盖 profile：允许 apply 指定 staging 代运行某个脑 profile（接入 three-brain/sandbox 代际）
        const profile = profileOverride && profileOverride.trim() ? profileOverride.trim() : cfg.profile;
        this.stage = 'spawn';
        const genId = `gen-${cfg.portBase + this.genCounter + 2}`;
        this.genCounter += 1;
        const port = cfg.portBase + this.genCounter + 1;
        const adminPort = cfg.adminBase + this.genCounter + 1;
        const genDir = join(cfg.workDir, genId);
        mkdirSync(genDir, { recursive: true });
        const overlayFile = writeOverlay(join(genDir, 'run'), {
            // 只钉 per-gen sqlite；投影缓存保留共享（非权威，冷读走日志重建）——同脑的 overlay 修复
            querySqlitePath: join(genDir, 'query.sqlite'),
        });
        const token = randomUUID();
        const spawned = spawnGen({
            nodeBin: cfg.nodeBin,
            dshBin: cfg.dshBin,
            profile,
            port,
            adminPort,
            gen: genId,
            leaseToken: token,
            mode: 'staging',
            overlayFile,
            genDir,
            envExtra: cfg.envExtra,
        });
        const b = {
            inst: {
                id: genId,
                gen: genId,
                port,
                adminPort,
                pid: spawned.pid,
                role: 'staging',
                state: 'starting',
                lastHeartbeat: Date.now(),
                caughtUpSeq: 0,
            },
            spawned,
            client: new AdminClient(`http://127.0.0.1:${adminPort}`),
        };
        this.record('spawned ' + genId);
        this.stage = 'ready';
        const targetSeq = await this.activeSeq();
        if (!(await this.waitCatchUp(b, targetSeq)))
            return this.abort(b, 'b-catchup-failed');
        this.stage = 'freeze';
        const fr = await this.active.client.freeze(cfg.freezeTimeoutMs);
        if (!fr.static || fr.lastSeq < 0)
            return this.abort(b, 'freeze-a-not-static');
        this.record('freeze a lastSeq=' + fr.lastSeq);
        this.stage = 'promote';
        if (!(await this.waitCatchUp(b, fr.lastSeq)))
            return this.abort(b, 're-ready-b-behind');
        this.stage = 'promote';
        await b.client.promote(token, b.inst.gen); // B 绑定 key-pool + 确认写权 token
        this.stage = 'flip';
        this.lease.grant(b.inst.gen, b.inst.port, spawned.pid, cfg.ttlMs, fr.lastSeq, 'replay', token);
        const old = this.swapActive(b);
        b.inst.role = 'active';
        b.inst.state = 'active';
        this.record('flip to ' + b.inst.gen);
        this.stage = 'verify';
        const probe = await b.client.probe(5000);
        if (!probe.ok) {
            // 非破坏回滚：指回旧 active，退役 B
            this.swapActive(old);
            old.inst.role = 'active';
            old.inst.state = 'active';
            this.stage = 'rolled-back';
            await b.spawned.stop();
            return this.stage;
        }
        this.stage = 'retire';
        this.record('retire ' + old.inst.gen);
        setTimeout(() => void old.spawned.stop(), cfg.retainMs);
        this.stage = 'idle';
        return 'idle';
    }
    async waitCatchUp(b, target) {
        const deadline = Date.now() + this.cfg.readyTimeoutMs;
        for (;;) {
            const h = await b.client.health(3000);
            if (h && h.caughtUpSeq >= target)
                return true;
            if (Date.now() > deadline)
                return false;
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    async abort(b, reason) {
        this.record('abort ' + reason);
        writeFileSync(join(this.cfg.coordDir, 'abort.txt'), reason, 'utf8');
        await b.spawned.stop();
        return 'aborted';
    }
}
