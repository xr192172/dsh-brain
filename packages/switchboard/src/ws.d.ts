/**
 * 最小 `ws` 类型声明（该 npm 版本未内联 .d.ts，且本包不引入 @types/ws）。
 * 只覆盖 proxy.ts 用到的表面。若未来用更多 ws API，在此补充。
 */
declare module 'ws' {
  import type { IncomingMessage } from 'node:http'
  import type { Duplex } from 'node:stream'

  type RawData = Buffer | ArrayBuffer | Buffer[]

  class WebSocket {
    constructor(address: string, options?: Record<string, unknown>)
    static readonly OPEN: number
    static readonly CLOSING: number
    static readonly CLOSED: number
    readonly readyState: number
    send(data: unknown, options?: { binary?: boolean }, cb?: (err?: Error) => void): void
    close(code?: number, reason?: string): void
    on(event: 'open', listener: () => void): this
    on(event: 'close', listener: (code?: number, reason?: Buffer) => void): this
    on(event: 'error', listener: (err?: Error) => void): this
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this
  }

  class WebSocketServer {
    constructor(options: { noServer?: boolean; maxPayload?: number })
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: WebSocket) => void,
    ): void
  }

  export { WebSocket, WebSocketServer }
  export default WebSocket
}