/**
 * @module @dsh-brain/handover-agent/admin
 *
 * loopback admin HTTP 服务（非浏览器、非 dsh 路由），被 Switchboard 的
 * AdminClient 调用。这是控制面与数据面的连接点。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { FreezeReply, HealthReply, PrepareReply, ProbeReply, PromoteRequest } from './protocol.js'

export interface AdminHandlers {
  getGen(): string
  getMode(): 'staging' | 'active' | 'demoted'
  getCaughtUpSeq(): number
  holdingLease(): boolean
  freeze(): Promise<FreezeReply>
  promote(req: PromoteRequest): Promise<{ ok: boolean }>
  probe(): Promise<ProbeReply>
  prepareSwitch(graceMs: number): Promise<PrepareReply>
  retire(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c: Buffer) => (buf += c))
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : undefined)
      } catch (e) {
        reject(e as Error)
      }
    })
  })
}

async function route(
  path: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  h: AdminHandlers,
): Promise<void> {
  res.setHeader('content-type', 'application/json')
  if (path === '/admin/health' && method === 'GET') {
    const reply: HealthReply = {
      gen: h.getGen(),
      mode: h.getMode(),
      holdingLease: h.holdingLease(),
      caughtUpSeq: h.getCaughtUpSeq(),
      staticAt: -1,
    }
    res.end(JSON.stringify(reply))
  } else if (path === '/admin/freeze' && method === 'POST') {
    res.end(JSON.stringify(await h.freeze()))
  } else if (path === '/admin/promote' && method === 'POST') {
    const body = (await readBody(req)) as PromoteRequest
    res.end(JSON.stringify({ ok: (await h.promote(body)).ok }))
  } else if (path === '/admin/probe' && method === 'GET') {
    res.end(JSON.stringify(await h.probe()))
  } else if (path === '/admin/prepareSwitch' && method === 'POST') {
    const body = (await readBody(req)) as { graceMs?: number }
    res.end(JSON.stringify(await h.prepareSwitch(body?.graceMs ?? 20_000)))
  } else if (path === '/admin/retire' && method === 'POST') {
    await h.retire()
    res.end(JSON.stringify({ ok: true }))
  } else {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  }
}

export function startAdminServer(port: number, h: AdminHandlers): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    void route(url.pathname, req.method ?? 'GET', req, res, h).catch((e) => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: (e as Error).message }))
    })
  }).listen(port, '127.0.0.1')
}