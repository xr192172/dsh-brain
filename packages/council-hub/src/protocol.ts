/**
 * protocol.ts —— council-hub 的协议单一真相。
 *
 * 这里的每一条都是「判据」而不是「工具函数」：信封怎么长、谁能接进来、有哪些通道、
 * 交接包怎么算合格 —— 全部只许住这一个文件。server.ts 只调用，不许再写第二份。
 *
 * ## 两条兼容性决定（都是被现役组件逼出来的，不是想当然）
 *
 * ① **信封 protocol 字段**：本仓对外自称 `council-hub/1`（PROJECT-MAP §四的规格），
 *    但 `bridge/hub-bridge.mjs` 经由 `scripts/spike/hubconn.mjs` 说话时带的是 `protocol: '2.0'`
 *    与 `timestamp` 字段。⇒ 出站一律写 `council-hub/1` **并同时写 `timestamp` 别名**（与 `ts` 同值）；
 *    入站 `2.0` 与 `council-hub/1` **都认**，其它值判为不合格。
 *    ★ 只认一种会让现役 bridge 一句都不通 —— 兼容不是宽容，是不打断在役链路。
 *
 * ② **角色是「基角色白名单 + 归一化」而不是全名白名单**：bridge 以 `--role executor-alpha`
 *    接入（编号化是待建队列 #3）。若按全名比对，`executor-alpha` 会被判成 ROLE_NOT_FOUND
 *    ⇒ 白名单变成断头闸。⇒ `baseRole()` 先把 `agent:` 前缀与 `-序号` 后缀剥掉再比对。
 *    ★ `review-board` 自带连字符 ⇒ 必须先按整名/最长前缀匹配，再退到 '-' 前段
 *      （否则 `review-board` 会被切成 `review`，一个真实存在的席位被拒之门外）。
 */

/** 本仓对外协议标识 */
export const COUNCIL_PROTOCOL = 'council-hub/1'

/** 仍然接受的旧协议标识（bridge/hubconn 现役形态） */
export const LEGACY_PROTOCOLS: readonly string[] = ['2.0']

/** 六基角色白名单（★ 无 left/right/sandbox —— 老角色不接） */
export const ROLES = ['hub', 'ui', 'secretary', 'review-board', 'executor', 'sentinel'] as const

export type Role = (typeof ROLES)[number]

/** 通道名（唯一出处；server 与测试都从这里取，不许写字面量） */
export const CHANNELS = {
  hello: 'session.hello',
  welcome: 'session.welcome',
  taskAssign: 'task.assign',
  handoffSubmit: 'handoff.submit',
  taskResult: 'task.result',
  taskVerdict: 'task.verdict',
  sentinelAlert: 'sentinel.alert',
  permissionRequest: 'permission.request',
  permissionResponse: 'permission.response',
  notice: 'event.notice',
  error: 'system.error',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

export interface Address {
  role: string
  id?: string
}

export interface Envelope {
  protocol: string
  id: string
  correlation_id?: string
  type: string
  from: Address
  to: Address
  /** 时间戳（本仓字段名） */
  ts: number
  /** 时间戳的兼容别名（bridge/hubconn 读这个） */
  timestamp: number
  payload: Record<string, unknown>
}

/** 按长度降序 —— `review-board` 必须先于 `review` 被匹配（见文件头 ②） */
const ROLES_LONGEST_FIRST: readonly Role[] = [...ROLES].sort((a, b) => b.length - a.length)

/**
 * 把任意角色串归一化成基角色；不在白名单里返回 null（调用方据此 ROLE_NOT_FOUND）。
 * `agent:executor-alpha` / `executor-alpha` / `executor` 都 → `executor`；
 * `review-board` → `review-board`（不被切成 review）。
 */
export function baseRole(raw: unknown): Role | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null
  if (s.startsWith('agent:')) s = s.slice('agent:'.length).trim()
  if (!s) return null
  for (const role of ROLES_LONGEST_FIRST) {
    if (s === role || s.startsWith(role + '-')) return role
  }
  return null
}

export interface MakeEnvelopeInput {
  type: string
  from: Address
  to: Address
  payload?: Record<string, unknown>
  correlation_id?: string
  id?: string
}

let idSeq = 0

/** 出站信封的唯一构造器（各处手拼 = 第二份口径） */
export function makeEnvelope(input: MakeEnvelopeInput): Envelope {
  const ts = Date.now()
  idSeq = (idSeq + 1) % 1_000_000
  const id = input.id ?? `msg_${ts.toString(36)}_${idSeq}`
  const env: Envelope = {
    protocol: COUNCIL_PROTOCOL,
    id,
    type: input.type,
    from: input.from,
    to: input.to,
    ts,
    timestamp: ts,
    payload: input.payload ?? {},
  }
  if (input.correlation_id) env.correlation_id = input.correlation_id
  return env
}

export interface ParseResult {
  ok: boolean
  envelope?: Envelope
  problems: string[]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asAddress(v: unknown): Address | null {
  const r = asRecord(v)
  if (!r) return null
  const role = typeof r['role'] === 'string' ? r['role'].trim() : ''
  if (!role) return null
  const id = typeof r['id'] === 'string' && r['id'] ? r['id'] : undefined
  return id ? { role, id } : { role }
}

/**
 * 入站信封校验（fail-closed：缺 type / from.role / to.role 一律不合格）。
 * ★ 不合格的信封**不许猜着处理** —— 猜出来的路由比不路由更危险。
 */
export function parseEnvelope(raw: unknown): ParseResult {
  let obj: Record<string, unknown> | null
  if (typeof raw === 'string') {
    try {
      obj = asRecord(JSON.parse(raw))
    } catch {
      return { ok: false, problems: ['不是合法 JSON'] }
    }
  } else {
    obj = asRecord(raw)
  }
  if (!obj) return { ok: false, problems: ['信封必须是 JSON 对象'] }

  const problems: string[] = []

  const protocol = typeof obj['protocol'] === 'string' ? obj['protocol'] : ''
  if (protocol && protocol !== COUNCIL_PROTOCOL && !LEGACY_PROTOCOLS.includes(protocol)) {
    problems.push(`protocol 不认：${protocol}（只认 ${COUNCIL_PROTOCOL} 与 ${LEGACY_PROTOCOLS.join(' / ')}）`)
  }

  const type = typeof obj['type'] === 'string' ? obj['type'].trim() : ''
  if (!type) problems.push('缺 type')

  const from = asAddress(obj['from'])
  if (!from) problems.push('缺 from.role')
  const to = asAddress(obj['to'])
  if (!to) problems.push('缺 to.role')

  if (problems.length > 0 || !from || !to) return { ok: false, problems }

  const tsRaw = obj['ts'] ?? obj['timestamp']
  const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) ? tsRaw : Date.now()
  const rawId = typeof obj['id'] === 'string' ? obj['id'] : ''
  const rawCorr = typeof obj['correlation_id'] === 'string' ? obj['correlation_id'] : ''
  const envelope: Envelope = {
    protocol: protocol || COUNCIL_PROTOCOL,
    id: rawId || `msg_${ts.toString(36)}`,
    type,
    from,
    to,
    ts,
    timestamp: ts,
    payload: asRecord(obj['payload']) ?? {},
  }
  if (rawCorr) envelope.correlation_id = rawCorr
  return { ok: true, envelope, problems: [] }
}

// ─────────────────────────────────────────────────────────────
// 交接包校验：复用 scripts/seats/handoff-contract.mjs（不另写一把尺）
// ─────────────────────────────────────────────────────────────

export interface HandoffVerdict {
  ok: boolean
  problems: string[]
  meta: Record<string, string>
  sections: string[]
  /** 判定来自哪份实现（便于回执里点名"是复用来的，不是自造"） */
  source: string
}

interface RawHandoffContract {
  validateHandoff(md: string): {
    ok: boolean
    problems: string[]
    sections: string[]
    meta: Record<string, string>
  }
}

/**
 * 契约模块地址：`packages/council-hub/src/` → 上三层 = 仓库根。
 * ★ 用 `new URL(..., import.meta.url)` 而不是裸相对说明符 —— 编译到 `lib/` 后层级不变（同样上三层），
 *   而裸说明符会让 tsc 去解析一个没有类型声明的 .mjs（本包不为此伪造一份类型）。
 */
const HANDOFF_CONTRACT_URL = new URL('../../../scripts/seats/handoff-contract.mjs', import.meta.url).href

let validatorPromise: Promise<RawHandoffContract> | null = null

/** 交接包契约模块的绝对地址（回执/诊断用；测试据此断言"真的指向那一份"） */
export function handoffContractUrl(): string {
  return HANDOFF_CONTRACT_URL
}

/**
 * 加载交接包校验器。**加载失败会抛**（不许降级成"放行"）——
 * 这是与 bridge 的已知缺陷刻意相反的选择：那边 import 路径写错被 try/catch 吞成
 * 「放行 + notice」，等于校验器不在也照样下发。
 */
export async function loadHandoffValidator(): Promise<RawHandoffContract> {
  if (!validatorPromise) {
    validatorPromise = import(/* @vite-ignore */ HANDOFF_CONTRACT_URL).then((mod) => {
      const m = mod as RawHandoffContract
      if (typeof m.validateHandoff !== 'function') {
        throw new Error(`交接包契约模块没有导出 validateHandoff：${HANDOFF_CONTRACT_URL}`)
      }
      return m
    })
    // ★ 失败不缓存：下一次调用要能重试（缓存一个 rejected promise 会让进程永久残废）
    validatorPromise.catch(() => {
      validatorPromise = null
    })
  }
  return validatorPromise
}

/** 校验一份交接包 markdown；不合格时 `problems` 逐条可读（fail-closed 由调用方执行） */
export async function validateHandoffText(md: string): Promise<HandoffVerdict> {
  const contract = await loadHandoffValidator()
  const r = contract.validateHandoff(String(md ?? ''))
  return {
    ok: r.ok === true,
    problems: Array.isArray(r.problems) ? r.problems : [],
    meta: r.meta ?? {},
    sections: Array.isArray(r.sections) ? r.sections : [],
    source: 'scripts/seats/handoff-contract.mjs',
  }
}
