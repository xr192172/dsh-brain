/**
 * @module @dsh-brain/switchboard/proxy
 *
 * 前门 3080：HTTP 反代 + WebSocket 升级字节转发，**保留原 Host 头**，
 * 使代内 gen 的 `/api` loopback 信任栅栏恒通过（127.0.0.1 权威，端口无关）。
 * `setActive(upstream)` 原子翻转 active 上游——交接 flip 即换指针，零空窗。
 */
import { type Server } from 'node:http';
import type { GenInstance } from './handover-protocol.js';
export declare class FrontDoor {
    private active;
    /** 无服务器模式：upgrade 由 attach() 转发 → handleUpgrade 与客户端握手。 */
    private readonly wss;
    /** 原子翻转：flip = 一次同步赋值。 */
    setActive(gen: GenInstance | null): GenInstance | null;
    get activeGen(): GenInstance | null;
    /** 让一个 http.Server 用它承载 request/upgrade 两条路径。 */
    attach(server: Server): void;
    private onRequest;
    private onUpgrade;
}
