#!/usr/bin/env node
/**
 * hub-bridge.mjs —— dsh-hub ↔ dsh 前门 的 bridge shim（§15.11 批准拓扑）
 *
 * 一个进程 = 一个席位（role）接入 elv/dsh-hub，背后挂一个 dsh 实例（前门 HTTP 面）。
 *
 * 方向翻译：
 *   hub command.input{text,session_id,turn_id} ──► POST {front}/api/session.prompt（mode='steer'）
 *   dsh journal（.dsh/sessions/<profile>/<sid>/session.jsonl[.zstd]）──►
 *       tool/call      → event.tool_call
 *       tool/result    → event.tool_result
 *       turn/end       → event.turn_done
 *       message/*      → event.message（启发式：取 data.message.content[].text，见 NOTES §1.3）
 *   permission 透传：POST http://127.0.0.1:<bridgePort>/permission 原样发 permission.request，
 *                    按 correlation_id 等回 permission.response，payload 不变形。
 *   交接包：command.input 是交接包（# 交接包 头 / payload.handoff）先过 handoff-contract 校验，
 *          不合格 fail-closed（只回 event.notice 问题清单，不下发）。
 *
 * 排除项（§15.11）：不带老 Hub left/right/sandbox 三脑角色、不接 dsh.swap 换代业务。
 *
 * 用法：
 *   node hub-bridge.mjs --hub ws://127.0.0.1:15813/ws --role executor-alpha \
 *     --name dsh-alpha --front http://127.0.0.1:3080 [--session <dsh sid>] \
 *     [--bridge-port 15900] [--poll-ms 1000]
 *   （env 等价：HUB_URL / BRIDGE_ROLE / BRIDGE_NAME / DSH_FRONT / DSH_SESSION_ID / DSH_JOURNAL_ROOT / BRIDGE_PORT / POLL_MS）
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openHub, genId } from '../spike/hubconn.mjs'

// ── 可选依赖（缺了不崩，降级并如实标注）────────────────────────────────
let decompressZstd = null
try {
  decompressZstd = (await import('fzstd')).decompress
} catch {
  /* journal .zstd 将不可读，仅 .jsonl 明文可用 */
}

let handoffValidator = null
try {
  handoffValidator = await import('../../../scripts/seats/handoff-contract.mjs')
} catch {
  /* 交接包校验降级为放行+notice（handoff-validator-unavailable） */
}

const DEFAULTS = {
  hub: 'ws://127.0.0.1:15813/ws',
  role: 'executor-default',
  name: 'dsh-bridge',
  front: 'http://127.0.0.1:3080',
  ctrl: 'http://127.0.0.1:31800',
  journalRoot: 'C:/Users/Admin/.dsh/sessions',
  sessionId: '', // 固定 dsh sessionId；空 = 首次 command.input 时从 session.list 自动挑
  pollMs: 1000,
  bridgePort: 0, // >0 时开本地 permission/health HTTP 面
  permTimeoutMs: 120_000,
  eventTo: 'ui', // event.* 的默认投递 role（hub eventService 按 msg.to 路由，发给 hub 等于发回自己）
  backoffBaseMs: 500,
  backoffMaxMs: 15_000,
  welcomeTimeoutMs: 8_000, // hello 后等 welcome 的时限（hub 拒 role 时会发 system.error 后干净 close，openHub 永不落定）
  handoffEnforce: true, // 交接包校验不合格则不下发（fail-closed）
  replayJournal: false, // true = 首次轮询重放 journal 全史（默认跳过历史）
  log: (...a) => console.log('[bridge]', ...a),
}

// ── CLI ───────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const out = {}
  const pick = (flag, env, key) => {
    const i = argv.indexOf(flag)
    if (i >= 0 && argv[i + 1] !== undefined) out[key] = argv[i + 1]
    else if (process.env[env]) out[key] = process.env[env]
  }
  pick('--hub', 'HUB_URL', 'hub')
  pick('--role', 'BRIDGE_ROLE', 'role')
  pick('--name', 'BRIDGE_NAME', 'name')
  pick('--front', 'DSH_FRONT', 'front')
  pick('--ctrl', 'DSH_CTRL', 'ctrl')
  pick('--session', 'DSH_SESSION_ID', 'sessionId')
  pick('--journal-root', 'DSH_JOURNAL_ROOT', 'journalRoot')
  pick('--poll-ms', 'POLL_MS', 'pollMs')
  pick('--event-to', 'EVENT_TO', 'eventTo')
  pick('--bridge-port', 'BRIDGE_PORT', 'bridgePort')
  if (out.pollMs !== undefined) out.pollMs = Number(out.pollMs)
  if (out.bridgePort !== undefined) out.bridgePort = Number(out.bridgePort)
  if (argv.includes('--replay-journal')) out.replayJournal = true
  if (argv.includes('--no-handoff-enforce')) out.handoffEnforce = false
  return out
}

// ── dsh 前门 RPC（eval-run.mjs:85-97 同款 wire 形状）───────────────────
export function dshRpc(front, method, payload, timeoutMs = 20_000) {
  return fetch(`${front.replace(/\/$/, '')}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 响应，保 text */
    }
    return { status: res.status, json, text: text.slice(0, 400) }
  })
}

// ── journal 读取 ──────────────────────────────────────────────────────
/** 在 journalRoot 下找 <profile>/<sid>/session.jsonl[.zstd]，返回 {file, isZstd} 或 null。 */
export function findJournalFile(root, sid) {
  let profiles = []
  try {
    profiles = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const p of profiles) {
    for (const f of ['session.jsonl.zstd', 'session.jsonl']) {
      const file = path.join(root, p, sid, f)
      if (fs.existsSync(file)) return { file, isZstd: f.endsWith('.zstd') }
    }
  }
  return null
}

/** 读 journal 全量记录（含 seq 兜底为行号）。文件不存在返回 null。 */
export function readJournal(jf) {
  let buf
  try {
    buf = fs.readFileSync(jf.file)
  } catch {
    return null
  }
  let text
  if (jf.isZstd) {
    if (!decompressZstd) return null
    try {
      text = Buffer.from(decompressZstd(buf)).toString('utf8')
    } catch {
      return null
    }
  } else {
    text = buf.toString('utf8')
  }
  const recs = []
  let ln = 0
  for (const line of text.split('\n')) {
    ln++
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.seq === undefined) r.seq = ln
      recs.push(r)
    } catch {
      /* 跳过坏行 */
    }
  }
  return recs
}

// ── journal 记录 → hub event 翻译 ─────────────────────────────────────
export function translateRecord(rec) {
  const d = rec?.data ?? {}
  switch (rec?.type) {
    case 'tool/call':
      return { type: 'event.tool_call', payload: { tool_name: String(d.name ?? '?'), tool_args: String(d.arguments ?? '') } }
    case 'tool/result': {
      const c = d?.message?.content?.[0]
      const s = typeof c === 'string' ? c : (c?.text ?? c?.content ?? '')
      return { type: 'event.tool_result', payload: { call_id: d.callId ?? null, is_error: !!c?.isError, snippet: String(s).slice(0, 2000) } }
    }
    case 'turn/end':
      return { type: 'event.turn_done', payload: { turn_id: d.turn !== undefined ? String(d.turn) : '', reason: d.reason ?? null } }
    default:
      if (typeof rec?.type === 'string' && rec.type.startsWith('message/')) {
        const parts = (d?.message?.content ?? [])
          .map((c) => (typeof c === 'string' ? c : (c?.text ?? '')))
          .filter(Boolean)
        if (parts.length) return { type: 'event.message', payload: { role: 'assistant', content: parts.join('\n') } }
      }
      return null
  }
}

/** 交接包识别：text 以「# 交接包」开头，或 payload.handoff 为真。 */
export function looksLikeHandoff(payload) {
  const t = String(payload?.text ?? '')
  return payload?.handoff === true || /^#\s*交接包/.test(t)
}

// ── Bridge 主体 ───────────────────────────────────────────────────────
export function createBridge(userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg }
  const state = {
    host: null, // hubconn 连接（{ws, clientID, send}）
    stopped: false,
    connectAttempts: 0,
    reconnectTimer: null,
    pollTimer: null,
    sessionMap: new Map(), // hub session_id → dsh sid
    autoSid: cfg.sessionId || '', // 自动挑到的 dsh sid
    jf: null, // journal 文件缓存 {file,isZstd}
    lastSeq: 0,
    journalSeen: false,
    currentTurnId: '', // 最近受理的 hub turn_id
    pendingPerms: new Map(), // correlation_id → {resolve, timer}
    httpServer: null,
  }

  const log = cfg.log

  // ── hub → 上行发送 ──
  // event.* 默认投递给观察席位（hub eventService 按 msg.to 路由；spike 同款 {role:'ui',broadcast:true}）；
  // permission.* / 其它走 {role:'hub'}（permissionService 只认 hub 入口）。
  function toHub(type, payload, correlationID, to) {
    if (!state.host?.send) return false
    const target =
      to ??
      (type.startsWith('event.') ? { role: cfg.eventTo, broadcast: true } : { role: 'hub' })
    state.host.send(type, target, payload, correlationID)
    return true
  }

  // ── 下行：hub command.* → dsh 前门 ──
  async function pickDshSession() {
    if (cfg.sessionId) return cfg.sessionId
    if (state.autoSid) return state.autoSid
    const r = await dshRpc(cfg.front, 'session.list', {})
    const items = r.json?.result?.value?.items ?? []
    const idle = items.find((x) => !x.running)
    const sid = (idle ?? items[0])?.sessionId ?? ''
    if (!sid) throw new Error('session.list 无可用会话（items=0）——请在 --session 指定或先建会话')
    state.autoSid = sid
    log(`自动选定 dsh sessionId=${sid}（running=${String(!idle)}）`)
    return sid
  }

  async function handleCommandInput(m) {
    const p = m.payload ?? {}
    const text = String(p.text ?? '')
    let finalText = text
    const meta = { session_id: p.session_id ?? '', turn_id: p.turn_id ?? '' }

    // 交接包闸口（fail-closed）
    if (looksLikeHandoff(p)) {
      if (!handoffValidator) {
        toHub('event.notice', { code: 'handoff-validator-unavailable', detail: 'handoff-contract.mjs 不可导入，交接包未校验即下发' })
      } else {
        const v = handoffValidator.validateHandoff(text)
        if (!v.ok && cfg.handoffEnforce) {
          toHub('event.notice', { code: 'handoff_invalid', problems: v.problems, turn_id: meta.turn_id })
          log('交接包校验不合格，已拦截：', v.problems.join('；'))
          return
        }
        meta.handoff = { depth: v.meta.depth ?? '', from: v.meta.from ?? '', to: v.meta.to ?? '' }
      }
    }

    let sid
    try {
      sid = await pickDshSession()
    } catch (e) {
      toHub('event.notice', { code: 'input_rejected', error: e.message, ...meta })
      log('挑会话失败：', e.message)
      return
    }
    if (meta.session_id) state.sessionMap.set(meta.session_id, sid)

    const r = await dshRpc(cfg.front, 'session.prompt', {
      sessionId: sid,
      mode: 'steer',
      content: [{ type: 'text', text: finalText }],
    })
    if (r.status === 200) {
      state.currentTurnId = meta.turn_id
      toHub('event.notice', { code: 'input_accepted', dsh_session_id: sid, ...meta })
      log(`command.input → session.prompt OK (turn=${meta.turn_id || '-'} sid=${sid})`)
    } else {
      toHub('event.notice', { code: 'input_rejected', status: r.status, error: r.text || JSON.stringify(r.json)?.slice(0, 200), ...meta })
      log(`session.prompt 失败 HTTP ${r.status}`)
    }
  }

  // ── hub 消息入口 ──
  async function handleHubMessage(m) {
    switch (m.type) {
      case 'command.input':
        await handleCommandInput(m)
        break
      case 'command.cancel': {
        const sid = state.sessionMap.get(m.payload?.session_id ?? '') || state.autoSid || cfg.sessionId
        if (sid) await dshRpc(cfg.front, 'session.cancel', { sessionId: sid })
        break
      }
      case 'permission.response': {
        const corr = m.correlation_id
        const waiter = corr && state.pendingPerms.get(corr)
        if (waiter) {
          clearTimeout(waiter.timer)
          state.pendingPerms.delete(corr)
          waiter.resolve(m.payload)
          log(`permission.response 到账 corr=${corr} allowed=${m.payload?.allowed}`)
        } else {
          log(`permission.response（无等待者，原样记录）corr=${corr}`)
        }
        break
      }
      case 'system.error':
        log(`hub system.error：${m.payload?.code} ${m.payload?.message}`)
        break
      default:
        break // 其它类型（peer_update 等）目前不处理
    }
  }

  // ── permission 透传（本地 HTTP 面）──
  async function handleLocalPermission(body) {
    const corr = 'perm_' + genId()
    const payload = {
      tool_name: String(body?.tool_name ?? ''),
      tool_args: String(body?.tool_args ?? ''), // 原样（约定为 JSON 字符串）
      ...(body?.tier !== undefined ? { tier: body.tier } : { tier: 'hard' }),
    }
    const rp = new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.pendingPerms.delete(corr)
        resolve({ allowed: false, reason: 'timeout' })
      }, cfg.permTimeoutMs)
      state.pendingPerms.set(corr, { resolve, timer })
    })
    toHub('permission.request', payload, corr, { role: 'hub' })
    log(`permission.request 已发 corr=${corr} tool=${payload.tool_name}`)
    return rp
  }

  function startHttpServer() {
    if (!cfg.bridgePort) return
    const server = http.createServer(async (req, res) => {
      const json = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.method === 'GET' && req.url === '/health') {
        return json(200, { ok: true, role: cfg.role, name: cfg.name, connected: !!state.host, clientID: state.host?.clientID ?? '' })
      }
      if (req.method === 'POST' && req.url === '/permission') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', async () => {
          try {
            json(200, await handleLocalPermission(JSON.parse(raw || '{}')))
          } catch (e) {
            json(400, { error: e.message })
          }
        })
        return
      }
      json(404, { error: 'not found' })
    })
    state.httpServer = server
    return new Promise((resolve) => server.listen(cfg.bridgePort, '127.0.0.1', () => resolve()))
  }

  // ── journal 轮询 → event.* ──
  async function pollJournal() {
    const sid = state.autoSid || cfg.sessionId
    if (!sid) return
    if (!state.journalSeen) {
      // 基线 = 席位挂接时刻的 journal 末尾（挂接时已有历史则跳过；journal 尚未出现则从 0 起全收）
      state.journalSeen = true
      state.jf = findJournalFile(cfg.journalRoot, sid)
      const recs0 = state.jf ? readJournal(state.jf) : null
      state.lastSeq = cfg.replayJournal ? 0 : recs0 ? Math.max(0, ...recs0.map((r) => r.seq ?? 0)) : 0
      log(`journal 基线：${state.jf ? state.jf.file : '（尚未出现，从 0 起收）'} lastSeq=${state.lastSeq}`)
      if (recs0 && !cfg.replayJournal) return
    } else if (!state.jf || !fs.existsSync(state.jf.file)) {
      state.jf = findJournalFile(cfg.journalRoot, sid)
    }
    if (!state.jf) return
    const recs = readJournal(state.jf)
    if (!recs) return
    if (!state.journalSeen) {
      state.journalSeen = true
      state.lastSeq = cfg.replayJournal ? 0 : Math.max(0, ...recs.map((r) => r.seq ?? 0))
      if (!cfg.replayJournal) return
    }
    const fresh = recs.filter((r) => (r.seq ?? 0) > state.lastSeq).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    for (const rec of fresh) {
      state.lastSeq = Math.max(state.lastSeq, rec.seq ?? state.lastSeq)
      const ev = translateRecord(rec)
      if (!ev) continue
      if (ev.type === 'event.turn_done' && state.currentTurnId && !ev.payload.turn_id) {
        ev.payload.turn_id = state.currentTurnId
      }
      toHub(ev.type, ev.payload)
      log(`↑ ${ev.type} (seq=${rec.seq})`)
    }
  }

  // ── 连接管理（指数退避重连）──
  function scheduleReconnect(reason) {
    if (state.stopped || state.reconnectTimer) return
    state.host = null
    const delay = Math.min(cfg.backoffBaseMs * 2 ** state.connectAttempts, cfg.backoffMaxMs)
    state.connectAttempts++
    log(`断线（${reason}），${delay}ms 后第 ${state.connectAttempts} 次重连`)
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      connect()
    }, delay)
  }

  async function connect() {
    if (state.stopped) return
    try {
      // ★ hubconn.openHub 只在收到 welcome 时 resolve、出错时 reject；
      //   hub 拒 role（system.error + 干净 close）时 promise 永不落定 ⇒ 用超时竞速兜底。
      let raced = false
      const host = await Promise.race([
        openHub({
          hub: cfg.hub,
          role: cfg.role,
          id: cfg.name,
          name: cfg.name,
          extra: { project_root: process.cwd() },
          onMsg: (m) => {
            void handleHubMessage(m)
          },
        }).then((h) => {
          if (raced) {
            try {
              h.ws.close()
            } catch {
              /* ignore */
            }
            log('迟到的 welcome 已丢弃（超时后已重连）')
          }
          return h
        }),
        new Promise((_, reject) =>
          setTimeout(() => {
            raced = true
            reject(new Error(`welcome 超时（${cfg.welcomeTimeoutMs}ms）——检查 hub 是否拒了 role（ROLE_NOT_FOUND）`))
          }, cfg.welcomeTimeoutMs),
        ),
      ])
      if (state.stopped) {
        try {
          host.ws.close()
        } catch {
          /* ignore */
        }
        return
      }
      host.ws.on('close', () => scheduleReconnect('ws close'))
      state.host = host
      state.connectAttempts = 0
      log(`已接入 hub（role=${cfg.role} client_id=${host.clientID}）`)
    } catch (e) {
      scheduleReconnect(e.message)
    }
  }

  // ── 生命周期 ──
  async function start() {
    await startHttpServer()
    await connect()
    state.pollTimer = setInterval(() => void pollJournal(), cfg.pollMs)
    return api
  }

  function stop() {
    state.stopped = true
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer)
    if (state.pollTimer) clearInterval(state.pollTimer)
    try {
      state.host?.ws?.close()
    } catch {
      /* ignore */
    }
    if (state.httpServer) state.httpServer.close()
    state.host = null
  }

  // 测试钩子（不装门面，直通内部）
  const api = {
    cfg,
    start,
    stop,
    _state: state,
    _handleHubMessage: handleHubMessage,
    _pollJournal: pollJournal,
    _handleLocalPermission: handleLocalPermission,
    toHub,
    whenConnected: (timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now()
        const iv = setInterval(() => {
          if (state.host) {
            clearInterval(iv)
            resolve(state.host)
          } else if (Date.now() - t0 > timeoutMs) {
            clearInterval(iv)
            reject(new Error('等待 hub 连接超时'))
          }
        }, 20)
      }),
    /** 主动发 permission.request（等价于 POST /permission），返回 response payload。 */
    permissionRequest: handleLocalPermission,
  }
  return api
}

// ── CLI 入口 ──────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const bridge = createBridge(parseArgs(process.argv.slice(2)))
  const cfg = bridge.cfg
  bridge.start().then(() => {
    console.log(`[bridge] 启动：role=${cfg.role} hub=${cfg.hub} front=${cfg.front} port=${cfg.bridgePort || '-'}（Ctrl+C 退出）`)
  })
}
