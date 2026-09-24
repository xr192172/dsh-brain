/**
 * @module @dsh-brain/switchboard/adminclient
 *
 * Switchboard → 代内 handover-agent 的 loopback admin HTTP 客户端。
 */
import { request as httpRequest } from 'node:http'
import type { FreezeReply, HealthReply, PrepareReply, ProbeReply } from './handover-protocol.js'
import type { LiveInventory } from './preflight-contract.js'

function json(url: string, method: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      url,
      { method, headers: body === undefined ? {} : { 'content-type': 'application/json' } },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve(buf ? JSON.parse(buf) : {})
          } catch {
            reject(new Error('bad json from admin: ' + buf.slice(0, 200)))
          }
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

export class AdminClient {
  constructor(private readonly base: string) {}

  async health(timeoutMs = 3000): Promise<HealthReply | null> {
    try {
      return (await this.withTimeout(json(this.base + '/admin/health', 'GET'), timeoutMs)) as HealthReply
    } catch {
      return null
    }
  }

  async freeze(timeoutMs = 20000): Promise<FreezeReply> {
    return (await this.withTimeout(json(this.base + '/admin/freeze', 'POST'), timeoutMs)) as FreezeReply
  }

  async promote(token: string, gen: string, resumeSessionId?: string): Promise<{ ok: boolean }> {
    return (await json(this.base + '/admin/promote', 'POST', { writerToken: token, gen, ...(resumeSessionId ? { resumeSessionId } : {}) })) as { ok: boolean }
  }

  async probe(timeoutMs = 3000): Promise<ProbeReply> {
    return (await this.withTimeout(json(this.base + '/admin/probe', 'GET'), timeoutMs)) as ProbeReply
  }

  /**
   * 活实例清点（`/admin/inventory`）。预演体检用它读"这一代实际装上了什么"。
   *
   * 它是**只读**调用，但**不**吞异常：调用方（preflight 引擎）需要在"清点不到"时
   * 判 `reject` 而不是 `pass`（观测不到 ≠ 没问题）。所以这里不做 `catch → null` 的降级
   * （`health()` 那种降级只适合"探活"语义）。
   */
  async inventory(timeoutMs = 8000): Promise<LiveInventory> {
    return (await this.withTimeout(json(this.base + '/admin/inventory', 'GET'), timeoutMs)) as LiveInventory
  }

  /** 延迟切换：请活跃代收尾当前回合（等其 turn/end 或 grace 兜底）。 */
  async prepareSwitch(graceMs = 20000): Promise<PrepareReply> {
    return (await this.withTimeout(json(this.base + '/admin/prepareSwitch', 'POST', { graceMs }), graceMs + 5000)) as PrepareReply
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('admin timeout')), ms)
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }
}