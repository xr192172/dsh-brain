/**
 * key-pool-proxy — 多 key 轮换反代插件（@dsh-brain/key-pool-proxy）。
 *
 * 思路 #5「LLM Router + 多 key 轮换池」在 DSH 上的落地：DSH 的 credentials/apiKeyEnv
 * 只认单个环境变量（无原生多 key 轮换），因此本插件起一个本地 OpenAI 兼容反向代理，
 * 作为 AGNES 下游：
 *   DSH(agnes 路由 baseURL=http://127.0.0.1:<port>/v1)
 *     → key-pool-proxy(在 key 池间轮换 + 429/5xx 冷却换 key 重试)
 *     → https://apihub.agnes-ai.com/v1 (Bearer <rotating key>)
 *
 * 轮换语义对齐本地 agent-shell 的 CACHE_AWARE=false：**限流即轮换**——
 * 遇 429 / 5xx 把当前 key 打入冷却窗口，立即换下一个 key 重试，直到成功或重试耗尽。
 * 平时按 round-robin 摊分各 key 用量。
 */
import type { Context } from '@deepseek-ai/cordis'
import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'key-pool-proxy'
export const inject: string[] = []

export interface Config {
  /** 主池：环境变量名，值形如逗号分隔的多个 key。 */
  poolEnv: string
  /** 回退池：额外读取的环境变量名（也按逗号分隔合并）。 */
  fallbackEnvs: string[]
  /** 上游 OpenAI 兼容根地址（不含 /v1）。 */
  upstreamBase: string
  /** 本地监听端口。 */
  port: number
  /** 某 key 被判定限流/失败后冷却多久（ms）。 */
  cooldownMs: number
  /** 一次请求最多尝试几个 key。 */
  maxRetries: number
  /** 命中这些状态码触发换 key 轮换。 */
  retryStatuses: number[]
}

// schemastery-style default schema（插件可仅用 zod 浅校验，DSH 不强制本包用 schemastery）
import { z } from 'zod'

export const Config = (() => {
  const s = z.object({
    poolEnv: z.string().default('AGNES_KEY_POOL'),
    fallbackEnvs: z.array(z.string()).default([]),
    upstreamBase: z.string().default('https://apihub.agnes-ai.com'),
    port: z.number().int().default(3101),
    cooldownMs: z.number().int().min(0).default(15000),
    maxRetries: z.number().int().min(0).default(3),
    retryStatuses: z.array(z.number().int()).default([429, 500, 502, 503, 504]),
  })
  return s
})()

/** 从主池 + 回退池读取去重 key 列表。 */
function loadPool(config: Config): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (value: string): void => {
    for (const raw of value.split(',')) {
      const k = raw.trim()
      if (k && !seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  const main = process.env[config.poolEnv]
  if (main) add(main)
  for (const e of config.fallbackEnvs) {
    const v = process.env[e]
    if (v) add(v)
  }
  return out
}

/** 上游请求头上的 Authorization 一定是 Bearer；替换成所选 key。 */
function buildHeaders(orig: http.IncomingHttpHeaders, host: string, key: string, bodyLength: number): http.OutgoingHttpHeaders {
  const h: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(orig)) {
    if (k === 'host' || k === 'authorization' || k === 'connection' || k === 'content-length' || k === 'transfer-encoding') continue
    h[k] = v
  }
  h.authorization = 'Bearer ' + key
  h.host = host
  h['content-length'] = String(bodyLength)
  if (!h['accept-encoding']) h['accept-encoding'] = 'gzip, deflate'
  return h
}

export function apply(ctx: Context, config: Config): void | (() => void) {
  const pool = loadPool(config)
  if (pool.length === 0) {
    throw new Error(
      '[key-pool-proxy] empty key pool: poolEnv=' + config.poolEnv + ' fallbackEnvs=' + config.fallbackEnvs.join(','),
    )
  }

  // 轮换状态
  let ptr = 0
  const blockedUntil = new Array<number>(pool.length).fill(0)
  const retrySet = new Set<number>(config.retryStatuses)

  const pickIndex = (now: number): number => {
    for (let i = 0; i < pool.length; i++) {
      const idx = (ptr + i) % pool.length
      if (blockedUntil[idx] <= now) {
        ptr = (idx + 1) % pool.length
        return idx
      }
    }
    return -1
  }
  const hasAvailable = (now: number): boolean => blockedUntil.some((t) => t <= now)

  /** 读完整请求体（限制大小，免得把巨大工具结果顶进内存）。 */
  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size <= 50_000_000) chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', () => resolve(Buffer.concat(chunks)))
    })

  /** 向上游发一次请求，拿到响应头（不落 body）；网络错误返回 null。 */
  const forward = (
    method: string | undefined,
    pathAndSearch: string,
    orig: http.IncomingHttpHeaders,
    body: Buffer,
    base: URL,
    key: string,
  ): Promise<{ res: IncomingMessage; status: number } | null> =>
    new Promise((resolve) => {
      const mod = base.protocol === 'https:' ? https : http
      const upstreamPath = base.pathname.replace(/\/$/, '') + pathAndSearch
      const headers = buildHeaders(orig, base.host, key, body.length)
      const preq = mod.request(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port ? Number(base.port) : undefined,
          method,
          path: upstreamPath,
          headers,
        },
        (res) => {
          resolve({ res, status: res.statusCode ?? 502 })
        },
      )
      preq.on('error', () => resolve(null))
      if (body.length) preq.write(body)
      preq.end()
    })

  const server = http.createServer(async (reqIn, resIn) => {
    const now = Date.now()
    try {
      // 健康检查
      if (reqIn.url === '/healthz') {
        resIn.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: pool.length, ok: true }))
        return
      }
      const body = await readBody(reqIn)
      const base = new URL(config.upstreamBase)
      let attempted = 0
      // 抽走原 authorization 再逐 key 尝试
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        const t = Date.now()
        if (!hasAvailable(t)) break
        const idx = pickIndex(t)
        if (idx < 0) break
        attempted++
        const key = pool[idx]
        const out = await forward(reqIn.method, reqIn.url ?? '', reqIn.headers, body, base, key)
        if (out === null) {
          blockedUntil[idx] = Date.now() + config.cooldownMs
          continue
        }
        const { res, status } = out
        if (retrySet.has(status) && attempt < config.maxRetries && hasAvailable(Date.now())) {
          blockedUntil[idx] = Date.now() + config.cooldownMs
          res.destroy()
          continue
        }
        // 最终响应：透传（含 SSE 流）
        resIn.writeHead(status, res.headers)
        res.pipe(resIn)
        return
      }
// 诊断：失败原因（exhausted=重试到顶 / all-cooldown=此刻全 key 在冷却）+ 冷却现场
      {
        const inCD = pool.filter((_, i) => blockedUntil[i] > Date.now()).length
        console.log(
          '[key-pool-proxy] FAIL ' + (reqIn.method || 'GET') + ' ' + (reqIn.url || '').slice(0, 60) + ' reason=' + (attempted > 0 ? 'exhausted' : 'all-cooldown') + ' attempted=' + attempted + ' inCooldown=' + inCD + '/' + pool.length,
        )
      }
            resIn.writeHead(attempted > 0 ? 502 : 503, { 'content-type': 'text/plain; charset=utf-8' })
      resIn.end(
        attempted > 0
          ? '[key-pool-proxy] upstream exhausted after retries'
          : '[key-pool-proxy] all keys in cooldown',
      )
    } catch (e) {
      resIn.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e))
    }
  })

  // 多代并存：3101 可能已被 active gen 占用。容忍 EADDRINUSE（复用共享代理，不崩溃），
  // 交接时 staging gen 不应因端口占用而挂掉。
  server.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      console.log('[key-pool-proxy] 127.0.0.1:' + config.port + ' already serving (reused); skipped own bind')
    } else {
      console.log('[key-pool-proxy] server error: ' + (err as Error).message)
    }
  })

  // per-gen：单一活跃代独占 3101（baseURL 共享指 3101，谁服务谁持池）。
  // staging/demoted 代不绑端口；promote 代绑定、freeze 代释放（跨插件事件由 handover-agent emit）。
  let listening = false
  const mode = String(process.env.HANDOVER_MODE || 'active')
  const isStaging = mode === 'staging' || mode === 'demoted'
  const bindProxy = (): void => {
    if (listening) return
    listening = true
    server.listen(config.port, '127.0.0.1', () => {
      console.log(
        '[key-pool-proxy] listening 127.0.0.1:' +
          config.port +
          ' -> ' +
          config.upstreamBase +
          ' (pool=' +
          pool.length +
          ')',
      )
    })
  }
  const closeProxy = (): void => {
    if (!listening) return
    listening = false
    server.close()
  }
  // 跨插件订阅 handover-agent 的模式迁移信号
  type Ev = { on?: (n: string, fn: (...a: unknown[]) => unknown) => unknown; off?: (n: string, fn: (...a: unknown[]) => unknown) => unknown }
  const ev = ctx as unknown as Ev
  const onPromote = (): void => bindProxy()
  const onFreeze = (): void => closeProxy()
  ev.on?.('handover/promote', onPromote)
  ev.on?.('handover/freeze', onFreeze)

  if (!isStaging) bindProxy()

  // 卸载时关服务器并取消订阅：返回 disposer，Cordis 在插件卸载时调用
  return (): void => {
    ev.off?.('handover/promote', onPromote)
    ev.off?.('handover/freeze', onFreeze)
    closeProxy()
  }
}

export type { Config as KeyPoolProxyConfig }

