/**
 * types/ws.d.ts —— `ws` 的最小 ambient 声明。
 *
 * ★ 为什么需要它：`ws@8` **不自带类型**（`package.json` 没有 types 字段），根仓也没有
 *   装 `@types/ws`。不声明的话 `tsc` 会在 `import { WebSocketServer } from 'ws'` 上报
 *   TS7016（隐式 any），于是「tsc 0 新增错误」这条验收读数就永远拿不到。
 * ★ 只声明本包真正用到的面（构造、address/close、四个事件、send）——
 *   **不是**在伪造一个完整的 ws 类型；用到新 API 时再加，别一次抄全（抄错的类型比没有更坏）。
 */
declare module 'ws' {
  import type { EventEmitter } from 'node:events'

  export interface WsAddressInfo {
    address: string
    family: string
    port: number
  }

  export class WebSocket extends EventEmitter {
    constructor(address: string, options?: Record<string, unknown>)
    readonly readyState: number
    send(data: string): void
    close(code?: number, reason?: string): void
    terminate(): void
    on(event: 'message', listener: (data: unknown) => void): this
    on(event: 'open', listener: () => void): this
    on(event: 'close', listener: (code?: number, reason?: unknown) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  export interface WebSocketServerOptions {
    port?: number
    host?: string
    server?: unknown
    noServer?: boolean
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: WebSocketServerOptions)
    readonly clients: Set<WebSocket>
    address(): WsAddressInfo | string | null
    close(callback?: () => void): void
    on(event: 'connection', listener: (ws: WebSocket) => void): this
    on(event: 'listening', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }
}
