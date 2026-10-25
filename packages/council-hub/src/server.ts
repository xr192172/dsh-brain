/**
 * server.ts —— council-hub 的 WS 服务端与路由。
 *
 * 单一职责：席位注册/寻址/任务下发/产物回收/交接包通道/队列与并发 —— **评审团流水线的运行时**。
 * 协议判据全在 protocol.ts（信封、白名单、通道名），队列与席位表分别在 queue.ts / registry.ts；
 * 本文件只做「接线」与「路由」，不新造任何一条判据。
 *
 * ## 三条路由纪律
 *
 * ① **未知基角色拒连**（`system.error{code:'ROLE_NOT_FOUND'}` 后关连接，1008）：
 *    白名单即闸口，接进来再拒等于让它先占一个 client_id。
 * ② **交接包 fail-closed**：校验器**不可用**时也拦（notice `handoff_validator_unavailable`），
 *    不转交、不猜。★ 这是刻意与 bridge 相反的选择 —— 那边 import 路径坏了被 try/catch 吞成
 *    「放行 + notice」，等于校验器不在也照样下发。
 * ③ **task.result 不假装判定**：hub 只回执 `task.verdict{verdict:'received'}` 并把产物转给
 *    review-board；采纳/驳回是评审席的语义判定，hub 不越权。
 */

import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

import {
  CHANNELS,
  COUNCIL_PROTOCOL,
  ROLES,
  baseRole,
  makeEnvelope,
  parseEnvelope,
  validateHandoffText,
} from './protocol.js'
import type { Address, Envelope, HandoffVerdict, Role } from './protocol.js'
import { TaskQueue } from './queue.js'
import { SeatRegistry } from './registry.js'
import type { Seat } from './registry.js'

export interface HubConfig {
  /** 0 / 缺省 = 让操作系统分配随机端口（测试要的就是这个） */
  port?: number
  host?: string
  /** 全局并发上限（PROJECT-MAP §四：config.maxConcurrent） */
  maxConcurrent?: number
  log?: (...args: unknown[]) => void
  /** 交接包校验器（测试可注入替身；缺省用 handoff-contract.mjs） */
  handoffValidate?: (md: string) => Promise<HandoffVerdict>
}

export interface HubAddress {
  port: number
  url: string
}

export interface SentinelAlertRecord {
  at: number
  from: string
  payload: Record<string, unknown>
}

export interface CouncilHub {
  start(): Promise<HubAddress>
  stop(): Promise<void>
  readonly registry: SeatRegistry
  readonly queue: TaskQueue
  readonly alerts: readonly SentinelAlertRecord[]
  readonly port: number
  readonly url: string
}

interface SocketState {
  seat: Seat | null
}

export function createCouncilHub(config: HubConfig = {}): CouncilHub {
  const log = config.log ?? ((): void => {})
  const registry = new SeatRegistry()
  const queue = new TaskQueue({ maxConcurrent: config.maxConcurrent ?? 4 })
  const alerts: SentinelAlertRecord[] = []
  const pendingPermissions = new Map<string, { from: Address; payload: Record<string, unknown> }>()
  const sockets = new Map<WebSocket, SocketState>()
  const server = new WebSocketServer({ port: config.port ?? 0, host: config.host ?? '127.0.0.1' })

  let boundPort = 0
  let boundUrl = ''

  // ── 发送原语 ───────────────────────────────────────────────
  function sendRaw(ws: WebSocket, env: Envelope): void {
    try {
      ws.send(JSON.stringify(env))
    } catch (e) {
      log('[council-hub] send 失败', (e as Error).message)
    }
  }

  function notice(seat: Seat, code: string, detail: string, extra: Record<string, unknown> = {}): void {
    seat.send(
      makeEnvelope({
        type: CHANNELS.notice,
        from: { role: 'hub' },
        to: { role: seat.role, id: seat.clientId },
        payload: { code, detail, ...extra },
      }),
    )
  }

  function replyError(ws: WebSocket, code: string, detail: string): void {
    sendRaw(
      ws,
      makeEnvelope({
        type: CHANNELS.error,
        from: { role: 'hub' },
        to: { role: 'unknown' },
        payload: { code, detail },
      }),
    )
  }

  /** 按基角色广播；返回是否有接收者（★ 没有接收者要如实回报，不许当成功） */
  function relayToRole(role: Role, env: Envelope): boolean {
    const seats = registry.byRole(role)
    for (const s of seats) s.send(env)
    return seats.length > 0
  }

  /** 寻址：点名优先（client_id），否则按基角色取第一个在线席位 */
  function resolveTarget(addr: Address): Seat | undefined {
    if (addr.id) {
      const hit = registry.byClientId(addr.id)
      if (hit) return hit
    }
    const role = baseRole(addr.role)
    if (!role) return undefined
    return registry.byRole(role)[0]
  }

  // ── 派发（队列的唯一出口）───────────────────────────────────
  function dispatch(): void {
    for (;;) {
      const task = queue.nextRunnable()
      if (!task) return
      const seat = resolveTarget(task.to)
      if (!seat) {
        queue.finish(task.id, 'failed')
        const origin = resolveTarget(task.from)
        if (origin) {
          notice(origin, 'task_unroutable', `任务 ${task.id} 的目标 ${task.to.role}${task.to.id ? '#' + task.to.id : ''} 不在线，已判失败`)
        }
        continue
      }
      queue.setAssignee(task.id, seat.clientId)
      seat.send(
        makeEnvelope({
          type: CHANNELS.taskAssign,
          from: task.from,
          to: { role: seat.role, id: seat.clientId },
          payload: task.payload,
          correlation_id: task.id,
        }),
      )
    }
  }

  // ── 各通道处理器 ──────────────────────────────────────────
  function handleHello(ws: WebSocket, env: Envelope): void {
    const raw = String((env.payload['role'] ?? env.from.role) ?? '')
    const role = baseRole(raw)
    if (!role) {
      sendRaw(
        ws,
        makeEnvelope({
          type: CHANNELS.error,
          from: { role: 'hub' },
          to: env.from,
          payload: { code: 'ROLE_NOT_FOUND', role: raw, allowed: [...ROLES] },
          correlation_id: env.id,
        }),
      )
      ws.close(1008, 'ROLE_NOT_FOUND')
      return
    }
    const seat = registry.register({
      role,
      rawRole: raw,
      name: String(env.payload['client_name'] ?? env.from.id ?? raw),
      send: (e) => sendRaw(ws, e as Envelope),
    })
    const state = sockets.get(ws)
    if (state) state.seat = seat
    sendRaw(
      ws,
      makeEnvelope({
        type: CHANNELS.welcome,
        from: { role: 'hub' },
        to: { role: seat.role, id: seat.clientId },
        payload: {
          client_id: seat.clientId,
          protocol: COUNCIL_PROTOCOL,
          role: seat.role,
          raw_role: raw,
          max_concurrent: queue.maxConcurrent,
        },
        correlation_id: env.id,
      }),
    )
    // 新席位可能正是某条待派发任务的目标
    dispatch()
  }

  function handleTaskAssign(seat: Seat, env: Envelope): void {
    const p = env.payload
    const taskId = String(p['task_id'] ?? env.correlation_id ?? env.id)
    const dependsOn = Array.isArray(p['depends_on']) ? (p['depends_on'] as unknown[]).map(String) : []
    try {
      queue.enqueue({
        id: taskId,
        priority: Number(p['priority'] ?? 0),
        dependsOn,
        from: env.from,
        to: env.to,
        payload: p,
      })
    } catch (e) {
      notice(seat, 'task_duplicate', `任务 ${taskId} 未能入队：${(e as Error).message}`)
      return
    }
    dispatch()
  }

  function handleTaskResult(seat: Seat, env: Envelope): void {
    const p = env.payload
    const taskId = String(p['task_id'] ?? env.correlation_id ?? '')
    const ok = p['ok'] !== false
    // ★ §15.6：编号不符**不让接此任务** —— 产物回报只认被指派者（同级不可互接的运行时版）
    const assignee = taskId ? queue.assigneeOf(taskId) : undefined
    if (assignee && assignee !== seat.clientId) {
      notice(seat, 'task_not_yours', `任务 ${taskId} 指派给 ${assignee}；你（${seat.clientId}）不是被指派者 ⇒ 不予了结`)
      return
    }
    const known = taskId ? queue.finish(taskId, ok ? 'completed' : 'failed') : false

    const relayed = relayToRole(
      'review-board',
      makeEnvelope({
        type: CHANNELS.taskResult,
        from: { role: seat.role, id: seat.clientId },
        to: { role: 'review-board' },
        payload: p,
        correlation_id: taskId || env.id,
      }),
    )
    seat.send(
      makeEnvelope({
        type: CHANNELS.taskVerdict,
        from: { role: 'hub' },
        to: { role: seat.role, id: seat.clientId },
        payload: {
          task_id: taskId,
          verdict: 'received',
          tracked_task: known,
          relayed_to_review_board: relayed,
          note: 'hub 只回执「已收并转交」；采纳/驳回由评审席判定',
        },
        correlation_id: env.id,
      }),
    )
    dispatch()
  }

  async function handleHandoffSubmit(seat: Seat, env: Envelope): Promise<void> {
    const p = env.payload
    const md = String(p['markdown'] ?? p['handoff'] ?? p['text'] ?? '')
    let verdict: HandoffVerdict
    try {
      verdict = await (config.handoffValidate ?? validateHandoffText)(md)
    } catch (e) {
      // ★ fail-closed：校验器不可用 ⇒ 不转交（与 bridge 的"降级放行"相反）
      notice(seat, 'handoff_validator_unavailable', `交接包校验器不可用，已拦截：${(e as Error).message}`)
      return
    }
    if (!verdict.ok) {
      notice(seat, 'handoff_invalid', verdict.problems.join('；'), { problems: verdict.problems })
      return
    }
    const relayed = relayToRole(
      'review-board',
      makeEnvelope({
        type: CHANNELS.handoffSubmit,
        from: { role: seat.role, id: seat.clientId },
        to: { role: 'review-board' },
        payload: {
          ...p,
          meta: verdict.meta,
          sections: verdict.sections,
          validated_by: verdict.source,
        },
        correlation_id: env.correlation_id ?? env.id,
      }),
    )
    notice(seat, 'handoff_accepted', relayed ? '交接包合格，已转 review-board' : '交接包合格，但当前无 review-board 在线（未转交）', {
      meta: verdict.meta,
      relayed,
    })
  }

  function handleSentinelAlert(seat: Seat, env: Envelope): void {
    const alertId = `alert_${alerts.length + 1}`
    alerts.push({
      at: Date.now(),
      // ★ 卡 3a：编号即身份 —— 留编号本身（编号已自带席名）
      from: seat.clientId,
      payload: env.payload,
    })
    const outbound = makeEnvelope({
      type: CHANNELS.sentinelAlert,
      from: { role: 'sentinel', id: seat.clientId },
      to: { role: 'review-board' },
      payload: { ...env.payload, alert_id: alertId },
      correlation_id: env.correlation_id ?? env.id,
    })
    const toBoard = relayToRole('review-board', outbound)
    relayToRole('ui', { ...outbound, to: { role: 'ui' } })
    notice(seat, 'sentinel_alert_recorded', `警报已记录（第 ${alerts.length} 条）并转 review-board`, {
      alert_id: alertId,
      relayed_to_review_board: toBoard,
    })
  }

  function handlePermissionRequest(seat: Seat, env: Envelope): void {
    const corr = env.correlation_id ?? env.id
    pendingPermissions.set(corr, { from: { role: seat.role, id: seat.clientId }, payload: env.payload })
    const relayed = relayToRole(
      'hub',
      makeEnvelope({
        type: CHANNELS.permissionRequest,
        from: { role: seat.role, id: seat.clientId },
        to: { role: 'hub' },
        payload: env.payload,
        correlation_id: corr,
      }),
    )
    if (!relayed) notice(seat, 'permission_no_consumer', `permission 请求已登记（corr=${corr}），但当前无 hub 席在线`)
  }

  function handlePermissionResponse(seat: Seat, env: Envelope): void {
    const corr = env.correlation_id ?? ''
    const pending = corr ? pendingPermissions.get(corr) : undefined
    if (!pending) {
      notice(seat, 'permission_unknown', `无等待中的 permission 请求：${corr || '(空 correlation_id)'}`)
      return
    }
    pendingPermissions.delete(corr)
    const target = resolveTarget(pending.from)
    const outbound = makeEnvelope({
      type: CHANNELS.permissionResponse,
      from: { role: seat.role, id: seat.clientId },
      to: pending.from,
      payload: env.payload,
      correlation_id: corr,
    })
    if (target) target.send(outbound)
    else log('[council-hub] permission.response 无接收者', corr)
  }

  // ── 入站 ─────────────────────────────────────────────────
  async function handleRaw(ws: WebSocket, data: unknown): Promise<void> {
    const parsed = parseEnvelope(typeof data === 'string' ? data : String(data))
    if (!parsed.ok || !parsed.envelope) {
      replyError(ws, 'BAD_ENVELOPE', parsed.problems.join('；'))
      return
    }
    const env = parsed.envelope

    if (env.type === CHANNELS.hello) {
      handleHello(ws, env)
      return
    }

    const seat = sockets.get(ws)?.seat ?? null
    if (!seat) {
      replyError(ws, 'HELLO_REQUIRED', '先发 session.hello 完成握手，再发业务消息')
      return
    }

    switch (env.type) {
      case CHANNELS.taskAssign:
        handleTaskAssign(seat, env)
        break
      case CHANNELS.taskResult:
        handleTaskResult(seat, env)
        break
      case CHANNELS.handoffSubmit:
        await handleHandoffSubmit(seat, env)
        break
      case CHANNELS.sentinelAlert:
        handleSentinelAlert(seat, env)
        break
      case CHANNELS.permissionRequest:
        handlePermissionRequest(seat, env)
        break
      case CHANNELS.permissionResponse:
        handlePermissionResponse(seat, env)
        break
      default:
        notice(seat, 'unknown_type', `未实现的通道：${env.type}`)
    }
  }

  server.on('connection', (ws: WebSocket) => {
    sockets.set(ws, { seat: null })
    ws.on('message', (data: unknown) => {
      void handleRaw(ws, data)
    })
    ws.on('close', () => {
      const state = sockets.get(ws)
      if (state?.seat) registry.unregister(state.seat.clientId)
      sockets.delete(ws)
    })
    ws.on('error', (e: Error) => log('[council-hub] socket 错误', e.message))
  })

  // ── 生命周期 ──────────────────────────────────────────────
  async function start(): Promise<HubAddress> {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve())
      server.once('error', (e: Error) => reject(e))
    })
    const addr = server.address()
    boundPort = typeof addr === 'object' && addr !== null ? addr.port : (config.port ?? 0)
    boundUrl = `ws://${config.host ?? '127.0.0.1'}:${boundPort}`
    log(`[council-hub] 已启动 ${boundUrl}（maxConcurrent=${queue.maxConcurrent}）`)
    return { port: boundPort, url: boundUrl }
  }

  async function stop(): Promise<void> {
    for (const ws of sockets.keys()) {
      try {
        ws.terminate()
      } catch {
        /* 已断开 */
      }
    }
    sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return {
    start,
    stop,
    registry,
    queue,
    alerts,
    get port(): number {
      return boundPort
    },
    get url(): string {
      return boundUrl
    },
  }
}
