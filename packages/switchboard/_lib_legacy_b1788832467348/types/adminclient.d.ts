import type { FreezeReply, HealthReply, ProbeReply } from './handover-protocol.js';
export declare class AdminClient {
    private readonly base;
    constructor(base: string);
    health(timeoutMs?: number): Promise<HealthReply | null>;
    freeze(timeoutMs?: number): Promise<FreezeReply>;
    promote(token: string, gen: string): Promise<{
        ok: boolean;
    }>;
    probe(timeoutMs?: number): Promise<ProbeReply>;
    private withTimeout;
}
