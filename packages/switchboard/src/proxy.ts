/**
 * @module @dsh-brain/switchboard/proxy
 *
 * 前门 3080：HTTP 反代 + WebSocket 升级字节转发，**保留原 Host 头**，
 * 使代内 gen 的 `/api` loopback 信任栅栏恒通过（127.0.0.1 权威，端口无关）。
 * `setActive(upstream)` 原子翻转 active 上游——交接 flip 即换指针，零空窗。
 */
import { IncomingMessage, request as httpRequest, ServerResponse, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { GenInstance } from './handover-protocol.js'

function upstreamHost(g: GenInstance): { host: string; port: number } {
  return { host: '127.0.0.1', port: g.port }
}

export class FrontDoor {
  private active: GenInstance | null = null
  /** 最近一次流经前门的"活跃会话 id"（从 `/api/session.*` POST body / query 嗅探，常驻第三方掌握）。 */
  private sessionId = ''
  /** 蓝绿交接锁定：交接进行中置 true，写操作/新建连接被前门拦截（遮罩），交接结束自动释放。 */
  private locked = false
  /** 无服务器模式：upgrade 由 attach() 转发 → handleUpgrade 与客户端握手。 */
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 })

  /** 原子翻转：flip = 一次同步赋值。 */
  setActive(gen: GenInstance | null): GenInstance | null {
    const before = this.active
    this.active = gen
    return before
  }

  get activeGen(): GenInstance | null {
    return this.active
  }

  /** 交接窗口锁开关（coordinator 在 handover 全程持锁，finally 释放）。 */
  setLocked(v: boolean): void {
    this.locked = v
  }

  get isLocked(): boolean {
    return this.locked
  }

  /** 最近活跃会话 id（供 handover 选 resume 会话；常驻，不依赖 gen 内部）。 */
  get lastSessionId(): string {
    return this.sessionId
  }

  /** 从任意探针里提取 session id（body JSON / query 里的 session/sessionId/session_id）。 */
  private captureSessionId(seen: Buffer[], query: URLSearchParams | null): void {
    for (const k of ['sessionId', 'session_id', 'session']) {
      const v = query?.get(k)
      if (v && v.length > 0) {
        this.sessionId = v
        return
      }
    }
    if (seen.length === 0) return
    try {
      const obj = JSON.parse(Buffer.concat(seen).toString('utf8'))
      for (const k of ['sessionId', 'session_id', 'id']) {
        const v = (obj as Record<string, unknown>)[k]
        if (typeof v === 'string' && v.length > 0) {
          this.sessionId = v
          return
        }
      }
    } catch {
      /* body 非 JSON 或未含 id：跳过 */
    }
  }

  /** 让一个 http.Server 用它承载 request/upgrade 两条路径。 */
  attach(server: Server): void {
    server.on('request', (req, res) => this.onRequest(req, res))
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
  }

  // ── HTTP ────────────────────────────────────────────────────────────
  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    // 交接窗口遮罩：写方法被锁时，不转发到正在退役/未就绪的 gen，返回明确提示，避免不稳定态并发写入触发 kind 竞态。
    if (this.locked && req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('503 switchboard 交接切换中：正在切换 DSH 代际，请稍候重试重发（本次消息未处理）。')
      console.log(`[switchboard:proxy] 交接中拦截写 ${req.method} ${(req.url ?? '').slice(0, 80)}`)
      return
    }
    const g = this.active
    if (!g) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('502 switchboard: no active upstream')
      return
    }
    // 会话嗅探：前门（常驻第三方）从 `/api/session.*` 的 body/query 记下最近活跃会话。
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const isSessionApi = url.pathname.startsWith('/api/session.')
    // 需要读 body 的情形：会话类 API 且非 GET/HEAD（POST 走 body 传 sessionId）
    const sniffBody = isSessionApi && req.method !== 'GET' && req.method !== 'HEAD'
    const createProxy = (body?: Buffer): void => {
      const { host, port } = upstreamHost(g)
      let finished = false
      const headers = {
        ...req.headers,
        ...(body ? { 'content-length': String(body.length) } : {}),
      }
      const proxy = httpRequest(
        { host, port, method: req.method, path: req.url, headers },
        (pRes) => {
          res.writeHead(pRes.statusCode ?? 502, pRes.headers)
          pRes.on('error', () => res.destroy())
          pRes.on('end', () => { finished = true })
          pRes.pipe(res)
        },
      )
      proxy.on('error', (err) => {
        console.error('[switchboard:proxy] upstream-req-error: ' + (err?.message ?? '') + ' ' + req.method + ' ' + (req.url ?? '').slice(0, 80))
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('502 switchboard upstream error: ' + err.message)
        } else {
          res.destroy()
        }
      })
      res.on('close', () => {
        if (!finished) {
          console.error('[switchboard:proxy] downstream-close-before-response-end: ' + req.method + ' ' + (req.url ?? '').slice(0, 80))
        }
        proxy.destroy()
      })
      if (body) proxy.write(body)
      req.pipe(proxy)
    }
    if (isSessionApi) {
      // 先抓 query 里的会话字段
      this.captureSessionId([], url.searchParams)
      if (!sniffBody) {
        createProxy()
        return
      }
      // POST 会话 API：缓冲 body → 嗅探 sessionId → 转发缓冲内容
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        this.captureSessionId(chunks, url.searchParams)
        createProxy(Buffer.concat(chunks))
      })
      req.on('error', () => createProxy(Buffer.concat(chunks)))
      return
    }
    createProxy()
  }

  // ── WebSocket 升级转发（ws 帧级代理：处理分片/控制帧/背压，长流稳定）────────
  private onUpgrade(req: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    // 交接窗口遮罩：新建 WebSocket 连接（流式推送/发消息）在交接中被拒，避免连到不稳 gen。
    if (this.locked) {
      console.log(`[switchboard:proxy] 交接中拒接 WebSocket ${(req.url ?? '').slice(0, 60)}`)
      clientSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      return
    }
    const g = this.active
    if (!g) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    // 保留 Host 头 → 代内 /api 信任栅栏恒通过；Origin 一并透传
    const headers: Record<string, string> = {}
    if (req.headers.host) headers.host = String(req.headers.host)
    if (typeof req.headers.origin === 'string') headers.origin = req.headers.origin
    const upstream = new WebSocket(`ws://127.0.0.1:${g.port}${req.url ?? '/'}`, {
      headers,
      handshakeTimeout: 10000,
      maxPayload: 512 * 1024 * 1024,
    })
    upstream.on('error', (err) => {
      console.error('[switchboard:proxy:ws] upstream-error: ' + (err?.message ?? '') + ' ' + (req.url ?? '').slice(0, 60))
      try {
        clientSocket.destroy()
      } catch {
        /* noop */
      }
    })
    upstream.on('open', () => {
      try {
        this.wss.handleUpgrade(req, clientSocket, head, (clientWs) => {
          const relay = (from: WebSocket, to: WebSocket): void => {
            from.on('message', (data, isBinary) => {
              if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary })
            })
          }
          relay(clientWs, upstream)
          relay(upstream, clientWs)
          const closeOther = (a: WebSocket) => (): void => {
            try {
              a.close()
            } catch {
              /* noop */
            }
          }
          clientWs.on('close', closeOther(upstream))
          upstream.on('close', (code?: number, reason?: Buffer) => {
            if (code !== 1000) {
              console.error(
                '[switchboard:proxy:ws] upstream-close code=' + String(code) + ' reason=' + String(reason ?? '').slice(0, 60) + ' ' + (req.url ?? '').slice(0, 40),
              )
            }
            closeOther(clientWs)()
          })
          clientWs.on('error', closeOther(upstream))
        })
      } catch {
        clientSocket.destroy()
      }
    })
  }
}