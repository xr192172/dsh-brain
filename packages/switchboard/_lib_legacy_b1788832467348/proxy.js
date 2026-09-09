/**
 * @module @dsh-brain/switchboard/proxy
 *
 * 前门 3080：HTTP 反代 + WebSocket 升级字节转发，**保留原 Host 头**，
 * 使代内 gen 的 `/api` loopback 信任栅栏恒通过（127.0.0.1 权威，端口无关）。
 * `setActive(upstream)` 原子翻转 active 上游——交接 flip 即换指针，零空窗。
 */
import { request as httpRequest } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
function upstreamHost(g) {
    return { host: '127.0.0.1', port: g.port };
}
export class FrontDoor {
    active = null;
    /** 无服务器模式：upgrade 由 attach() 转发 → handleUpgrade 与客户端握手。 */
    wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
    /** 原子翻转：flip = 一次同步赋值。 */
    setActive(gen) {
        const before = this.active;
        this.active = gen;
        return before;
    }
    get activeGen() {
        return this.active;
    }
    /** 让一个 http.Server 用它承载 request/upgrade 两条路径。 */
    attach(server) {
        server.on('request', (req, res) => this.onRequest(req, res));
        server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    }
    // ── HTTP ────────────────────────────────────────────────────────────
    onRequest(req, res) {
        const g = this.active;
        if (!g) {
            res.writeHead(502, { 'content-type': 'text/plain' });
            res.end('502 switchboard: no active upstream');
            return;
        }
        const { host, port } = upstreamHost(g);
        let finished = false;
        const proxy = httpRequest({
            host,
            port,
            method: req.method,
            path: req.url,
            headers: req.headers, // 原样保留 Host，栅栏信任
        }, (pRes) => {
            res.writeHead(pRes.statusCode ?? 502, pRes.headers);
            pRes.on('error', () => res.destroy());
            pRes.on('end', () => {
                finished = true;
            });
            pRes.pipe(res);
        });
        proxy.on('error', (err) => {
            // 诊断：上游请求失败
            console.error('[switchboard:proxy] upstream-req-error: ' + (err?.message ?? '') + ' ' + req.method + ' ' + (req.url ?? '').slice(0, 80));
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain' });
                res.end('502 switchboard upstream error: ' + err.message);
            }
            else {
                res.destroy();
            }
        });
        res.on('close', () => {
            // 诊断：响应流在"上游 body 未结束"前被下游关闭 → 疑似流被掐断
            if (!finished) {
                console.error('[switchboard:proxy] downstream-close-before-response-end: ' + req.method + ' ' + (req.url ?? '').slice(0, 80));
            }
            proxy.destroy();
        });
        req.pipe(proxy);
    }
    // ── WebSocket 升级转发（ws 帧级代理：处理分片/控制帧/背压，长流稳定）────────
    onUpgrade(req, clientSocket, head) {
        const g = this.active;
        if (!g) {
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            return;
        }
        // 保留 Host 头 → 代内 /api 信任栅栏恒通过；Origin 一并透传
        const headers = {};
        if (req.headers.host)
            headers.host = String(req.headers.host);
        if (typeof req.headers.origin === 'string')
            headers.origin = req.headers.origin;
        const upstream = new WebSocket(`ws://127.0.0.1:${g.port}${req.url ?? '/'}`, {
            headers,
            handshakeTimeout: 10000,
            maxPayload: 512 * 1024 * 1024,
        });
        upstream.on('error', (err) => {
            console.error('[switchboard:proxy:ws] upstream-error: ' + (err?.message ?? '') + ' ' + (req.url ?? '').slice(0, 60));
            try {
                clientSocket.destroy();
            }
            catch {
                /* noop */
            }
        });
        upstream.on('open', () => {
            try {
                this.wss.handleUpgrade(req, clientSocket, head, (clientWs) => {
                    const relay = (from, to) => {
                        from.on('message', (data, isBinary) => {
                            if (to.readyState === WebSocket.OPEN)
                                to.send(data, { binary: isBinary });
                        });
                    };
                    relay(clientWs, upstream);
                    relay(upstream, clientWs);
                    const closeOther = (a) => () => {
                        try {
                            a.close();
                        }
                        catch {
                            /* noop */
                        }
                    };
                    clientWs.on('close', closeOther(upstream));
                    upstream.on('close', (code, reason) => {
                        if (code !== 1000) {
                            console.error('[switchboard:proxy:ws] upstream-close code=' + String(code) + ' reason=' + String(reason ?? '').slice(0, 60) + ' ' + (req.url ?? '').slice(0, 40));
                        }
                        closeOther(clientWs)();
                    });
                    clientWs.on('error', closeOther(upstream));
                });
            }
            catch {
                clientSocket.destroy();
            }
        });
    }
}
