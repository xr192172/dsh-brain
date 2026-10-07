#!/usr/bin/env node
/**
 * switchboard-mcp —— **遥控器**：把控制面 `?cmd=` 面暴露成 MCP 工具给 agent 用。
 *
 * ## 为什么是这一层（而不是魔改一个 UI 启动器）
 * 依据 `docs/launcher-function-list-2026-09-26.md`（用户 2026-09-26 原话）：
 *   *"做好了这个启动器之后，我们再**反向把这个 API 的使用权做成工具封装好**，
 *     然后你也可以用，**也可以注册到 DSH 的工具列表里面用**。"*
 * 而 §3 现状审计已判定：**启动器缺的不是能力** —— 能力层（控制面 `?cmd=`）已有，
 * 缺的是 **G-1「管代数的门面」** 与 **G-2「面向代数的状态视图」**。
 * ⇒ 本文件把已有能力**包成 MCP**，agent 即拿到遥控器。
 *
 * ## 为什么它不受上游 DSH 版本影响
 * 它只依赖两样：**HTTP（控制面 :31800）** + **MCP stdio 协议**。
 * 不 import 任何 `@deepseek-ai/*`、不碰上游 `lib/index.js` ⇒ 上游改内部结构打不到它。
 *
 * ## 零依赖（故意的）
 * 手写 stdio JSON-RPC（MCP 的 wire 协议足够简单），只用 Node 内置 `fetch`。
 * ★ 好处：不依赖 `@modelcontextprotocol/sdk` 的版本与解析位置 —— 那正是今天咬过我们的那类坑
 *   （pnpm 链接模式下包解析不到）。**一个 .mjs 拷到哪都能跑。**
 *
 * ## 用法
 *   node packages/switchboard-mcp/server.mjs          # 以 stdio 跑（给 mcp-client 用）
 *   HANDOVER_CONTROL=http://127.0.0.1:31800 …         # 控制面地址（默认就是这个）
 *
 * ## 装到 DSH（照 `$DSH_HOME/profiles/web/cordis.patch.yml` 里 agent-io 那条的样式）
 *   - insert:
 *       - id: switchboard-mcp
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           transport: stdio
 *           serverName: switchboard
 *           command: node
 *           args: [<本文件绝对路径>]
 */

const CONTROL = process.env.HANDOVER_CONTROL ?? 'http://127.0.0.1:31800'

/** 调控制面。★ 控制面在 `:31800`，`?cmd=` 即动作；`:3080` 是前门（不要混）。 */
async function control(cmd, extra = {}) {
  const u = new URL(CONTROL)
  u.searchParams.set('cmd', cmd)
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) u.searchParams.set(k, String(v))
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000) })
  const text = await res.text()
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) }
  } catch {
    return { ok: res.ok, status: res.status, text: text.slice(0, 4000) }
  }
}

/** 从 `?cmd=status` 里取"活跃代"。★ 取值刻意宽松：控制面字段名可能演化，取不到就如实说取不到。 */
function activeGenOf(j) {
  if (!j || typeof j !== 'object') return undefined
  const cand = j.activeGen ?? j.active ?? j.generation ?? j.lease?.activeGen ?? j.lease?.generation
  return typeof cand === 'string' || typeof cand === 'number' ? String(cand) : undefined
}

const TOOLS = [
  {
    name: 'switchboard_status',
    description:
      '看控制面状态：活跃代 / 阶段 / 最近一次换代结果 / 锁。★ 这是「第几代、谁在跑」的入口（F1）。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await control('status')
      const gen = activeGenOf(r.json)
      return `${gen ? `活跃代：${gen}` : '活跃代：取不到'}\n${JSON.stringify(r.json ?? r.text, null, 1)}`
    },
  },
  {
    name: 'switchboard_handover',
    description:
      '★ 触发一次蓝绿换代（F2），并**等到代数真的变化**才返回。' +
      '★ 判据写死于此（见 docs/launcher-function-list-2026-09-26.md 的 F2）：**代数是「+1」还是「没动」—— 没动就是失败，不许报成功**。' +
      '★ 控制面的 handover 是异步的（立即回 started），所以本工具会**轮询 status** 直到代数变化或超时。' +
      '参数：profile（换到哪套装配）/ fail（故意注入失败，用于验证回滚）/ fast（快速路径）/ timeoutMs。',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: '目标 profile 名（省略 = 控制面默认）' },
        fail: { type: 'string', description: '注入失败以验证回滚（省略 = 正常换代）' },
        fast: { type: 'boolean', description: 'true = 快速路径' },
        timeoutMs: { type: 'number', description: '等代变化的超时（默认 180000）' },
      },
      additionalProperties: false,
    },
    run: async (a) => {
      const before = activeGenOf((await control('status')).json)
      const trig = await control('handover', {
        profile: a.profile,
        fail: a.fail,
        fast: a.fast === true ? 1 : undefined,
      })
      const timeoutMs = Number.isFinite(a.timeoutMs) ? a.timeoutMs : 180_000
      const t0 = Date.now()
      let after = before
      let lastStage
      while (Date.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 1500))
        const s = await control('status')
        after = activeGenOf(s.json) ?? after
        lastStage = s.json?.stage ?? s.json?.lease?.stage ?? lastStage
        if (before !== undefined && after !== undefined && after !== before) break
        if (before === undefined && after !== undefined) break
      }
      const moved = before !== after
      return (
        `${moved ? '✅ 代数变了' : '❌ 代数没动 —— 按 F2 判据这算**失败**（不许报成功）'}\n` +
        `  换代前：${before ?? '（取不到）'}\n  换代后：${after ?? '（取不到）'}\n` +
        `  阶段：${lastStage ?? '（取不到）'} · 耗时 ${Math.round((Date.now() - t0) / 1000)}s · 超时预算 ${timeoutMs}ms\n` +
        `  触发响应：${JSON.stringify(trig.json ?? trig.text).slice(0, 600)}`
      )
    },
  },
  {
    name: 'switchboard_flow',
    description: '按时间排序的阶段流水（换代过程发生了什么）。只读。用于事后复盘（F5）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await control('flow')
      return JSON.stringify(r.json ?? r.text, null, 1).slice(0, 12_000)
    },
  },
  {
    name: 'switchboard_assembly',
    description: '投影：控制面当前装了什么 / 下一代会被装成什么（只读）。回答「换代会换成什么」。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await control('assembly')
      return JSON.stringify(r.json ?? r.text, null, 1).slice(0, 12_000)
    },
  },
]

// ─────────────────────────── stdio JSON-RPC（MCP）骨
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) void onLine(line)
  }
})

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function onLine(line) {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req
  const reply = (result) => send({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  if (method === 'initialize') {
    return reply({
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'switchboard', version: '0.1.0' },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    return reply({
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    })
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name)
    if (!tool) return fail(-32602, `未知工具：${params?.name}`)
    try {
      const text = await tool.run(params?.arguments ?? {})
      return reply({ content: [{ type: 'text', text }] })
    } catch (e) {
      // ★ 失败就如实说失败（本仓纪律：不许兜底、不许静默）
      return reply({ content: [{ type: 'text', text: `✗ ${tool.name} 失败：${e?.message ?? e}` }], isError: true })
    }
  }
  if (id !== undefined) fail(-32601, `未实现的方法：${method}`)
}
