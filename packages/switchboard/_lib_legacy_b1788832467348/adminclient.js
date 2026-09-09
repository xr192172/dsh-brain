/**
 * @module @dsh-brain/switchboard/adminclient
 *
 * Switchboard → 代内 handover-agent 的 loopback admin HTTP 客户端。
 */
import { request as httpRequest } from 'node:http';
function json(url, method, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } }, (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => {
                try {
                    resolve(buf ? JSON.parse(buf) : {});
                }
                catch {
                    reject(new Error('bad json from admin: ' + buf.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        if (data)
            req.write(data);
        req.end();
    });
}
export class AdminClient {
    base;
    constructor(base) {
        this.base = base;
    }
    async health(timeoutMs = 3000) {
        try {
            return (await this.withTimeout(json(this.base + '/admin/health', 'GET'), timeoutMs));
        }
        catch {
            return null;
        }
    }
    async freeze(timeoutMs = 20000) {
        return (await this.withTimeout(json(this.base + '/admin/freeze', 'POST'), timeoutMs));
    }
    async promote(token, gen) {
        return (await json(this.base + '/admin/promote', 'POST', { writerToken: token, gen }));
    }
    async probe(timeoutMs = 3000) {
        return (await this.withTimeout(json(this.base + '/admin/probe', 'GET'), timeoutMs));
    }
    withTimeout(p, ms) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('admin timeout')), ms);
            p.then((v) => {
                clearTimeout(t);
                resolve(v);
            }, (e) => {
                clearTimeout(t);
                reject(e);
            });
        });
    }
}
