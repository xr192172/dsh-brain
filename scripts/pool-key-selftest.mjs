#!/usr/bin/env node
/**
 * pool-key-selftest.mjs —— key-pool-proxy 的「逐 key 自检」（挑出池里坏的那把）
 *
 * ★★ 一句话：**池里有几把 key、每把（脱敏尾 4 位）有效/无效** —— 逐把打上游探测，不经过池。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么要有它
 *
 *   `@dsh-brain/key-pool-proxy` 平时把请求在池内 round-robin 轮换，**不告诉调用方这次用了哪把**。
 *   若池里有一把坏 key（上游回 401 `Invalid token`），症状是"会话随机中途死"，且
 *   坏 key 的失败被**平摊给了所有调用方**（失败率 ≈ 1/N）。看不清是"哪把"坏 —— 这个脚本就是干这个的。
 *
 *   ★ 它【不改池的任何行为】：只读同样的 env 名、对**上游**逐把发一次请求。
 *     池的转发语义（P0 工具行为）保持原样 —— 见报告「设计缺口与最小修法（只方案）」。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 用法
 *
 *     node scripts/pool-key-selftest.mjs                              # 从当前进程环境读
 *     node scripts/pool-key-selftest.mjs --env-file <path>            # 补读 dotenv 风格文件（可重复）
 *     node scripts/pool-key-selftest.mjs --model agnes-2.5-flash
 *     node scripts/pool-key-selftest.mjs --models                     # 便宜的弱校验（★ 会漏判，见下）
 *     node scripts/pool-key-selftest.mjs --env-file <p> --leak-scan <file...>   # 反查文件里有没有完整 key
 *     node scripts/pool-key-selftest.mjs --json
 *
 *   参数：
 *     --env-file <p>     读取 `KEY=VALUE` 文件（**仅补 process.env 缺的名字**，不覆盖已有；可重复）
 *     --pool-env <名>     覆盖主池 env 名（缺省取自 cordis.patch.yml）
 *     --fallback-env <名> 覆盖回退池 env 名（可重复）
 *     --base <url>        覆盖上游根地址（缺省取自 cordis.patch.yml）
 *     --path <p>          探测路径（缺省 /v1/chat/completions）
 *     --chat              POST 探测（--path 缺省即 chat；本开关保留兼容）
 *     --models            改用 GET /v1/models（★ 便宜，但对本上游**验不出坏 key**，见下）
 *     --model <名>        POST 探测用的模型名（缺省 agnes-2.5-flash，= DSH 实际下游模型）
 *     --timeout <ms>      单次探测超时（缺省 15000）
 *     --repeat <n>        每把 key 探测次数（缺省 1）
 *     --healthz <url>     顺带读一次**在跑的池**的 key 数对账（缺省 http://127.0.0.1:3101/healthz；--no-healthz 关）
 *     --no-config         不读 cordis.patch.yml，直接用硬编码缺省
 *     --json              机器可读输出
 *     --help
 *
 *   退出码：0 = 全部有效；1 = 发现无效 key；2 = **读不到 key**（池为空）；3 = 用法/IO 错。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 为什么默认探 `POST /v1/chat/completions`（而不是更便宜的 `/v1/models`）
 *
 *   实测（2026-09-23）：同一把坏 key（回退池里那把 35 字符的 DeepSeek key）在
 *     `GET  /v1/models`          ⇒ **200**（认证未被校验 ⇒ 会把坏 key 误报成有效！）
 *     `POST /v1/chat/completions` ⇒ **401** `{"error":{"type":"AgnesAI_error","message":"Invalid token…"}}`
 *   ⇒ 只有 **chat 面**能复现调用方看到的那个失败。用 `--models` 会把坏 key 判成 VALID（**假绿**）。
 *   ★ 本脚本在 `/v1/models` 模式下会打印这条已知局限，避免误读。
 *
 * ★ 易踩参数坑（Git Bash / MSYS）：`--path /v1/...` 的**前导斜杠会被 MSYS 转成 Windows 路径**。
 *   在 Git Bash 里请用 `MSYS_NO_PATHCONV=1 node scripts/pool-key-selftest.mjs --path "/v1/..."`，
 *   或干脆用缺省（不传 --path）。PowerShell / cmd 无此问题。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★★ 安全纪律（本脚本自己保证）
 *   1. **绝不打印完整 key** —— 报告里只有「序号 + 脱敏尾 4 位 + 长度」；
 *   2. 上游响应体在打印前**先把该 key 的出现替换成 [redacted]**（防上游回显 token）；
 *   3. 收尾**自检**：若本次任何输出里出现了任一完整 key ⇒ 直接非零退出并报错（见 `assertNoLeak`）；
 *   4. **不写任何文件**、不落盘 key（只 stdout）。
 *
 * 依赖：只用 node 标准库。
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PATCH_YML = path.join(ROOT, 'packages', 'key-pool-proxy', 'cordis.patch.yml')

// 硬编码缺省 = cordis.patch.yml 当前值的快照（读 yml 失败时兜底）
const HARD_DEFAULTS = {
  poolEnv: 'AGENTSHELL_MAIN_LLM_API_KEYS',
  fallbackEnvs: ['AGENTSHELL_MAIN_LLM_API_KEY', 'DEEPSEEK_API_KEY'],
  upstreamBase: 'https://apihub.agnes-ai.com',
  port: 3101,
}

// ★ 默认探测面 = 调用方真实走的那个面（chat）；/v1/models 验不出坏 key（见文件头实测）
const DEFAULT_CHAT_PATH = '/v1/chat/completions'
const DEFAULT_MODELS_PATH = '/v1/models'
// DSH 实际下游模型（agent-shell/.env 的 AGENTSHELL_MAIN_LLM_MODEL，非敏感）
const DEFAULT_MODEL = 'agnes-2.5-flash'

/**
 * 从 `packages/key-pool-proxy/cordis.patch.yml` 里抠出池的配置（**单一来源 = 池自己的 patch**）。
 * 只做极浅的逐行扫描（不引 yaml 依赖）；抠不到就返回 null 走硬编码缺省。
 */
function readPoolConfigFromPatch(file = PATCH_YML) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  let poolEnv = null
  let upstreamBase = null
  let port = null
  const fallbackEnvs = []
  let inFallback = false
  for (const line of lines) {
    const bare = line.trim()
    const mPool = /^poolEnv:\s*(\S+)\s*$/.exec(bare)
    if (mPool) {
      poolEnv = mPool[1]
      inFallback = false
      continue
    }
    const mBase = /^upstreamBase:\s*(\S+)\s*$/.exec(bare)
    if (mBase) {
      upstreamBase = mBase[1]
      inFallback = false
      continue
    }
    const mPort = /^port:\s*(\d+)\s*$/.exec(bare)
    if (mPort) {
      port = Number(mPort[1])
      inFallback = false
      continue
    }
    if (/^fallbackEnvs:\s*$/.test(bare)) {
      inFallback = true
      continue
    }
    if (inFallback) {
      const mItem = /^-\s*(\S+)\s*$/.exec(bare)
      if (mItem) {
        fallbackEnvs.push(mItem[1])
        continue
      }
      inFallback = false
    }
  }
  if (!poolEnv) return null
  return { poolEnv, fallbackEnvs, upstreamBase, port }
}

/** 读一个 dotenv 风格的 `KEY=VALUE` 文件（去 BOM、忽略注释/空行、去引号）。 */
function readEnvFile(file) {
  const out = new Map()
  let text
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (e) {
    throw new Error(`读不到 env 文件：${file}（${e.code ?? e.message}）`)
  }
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    if (k && !out.has(k)) out.set(k, v)
  }
  return out
}

/** 脱敏：只暴露尾 4 位与长度。★ 这是本脚本唯一允许暴露的 key 形状。 */
function mask(key) {
  const tail = key.length <= 4 ? key : key.slice(-4)
  return `…${tail} (len=${key.length})`
}

/**
 * 汇总池 = 主池 + 回退池（去重），与池 `loadPool()` 同口径。
 * ★ 返回 `{keys, byName}`：byName 只记「env 名 → 【来自哪个源】+ 段数」，**不记值**。
 */
function loadPool({ poolEnv, fallbackEnvs }, overlay) {
  const keys = []
  const seen = new Set()
  const byName = []
  const push = (key) => {
    if (key && !seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }
  const take = (name) => {
    const fromProc = process.env[name]
    const fromFile = overlay.get(name)
    let value = null
    let source = '(absent)'
    if (fromProc !== undefined && fromProc !== '') {
      value = fromProc
      source = 'process.env'
    } else if (fromFile !== undefined && fromFile !== '') {
      value = fromFile
      source = 'env-file'
    }
    const parts = value === null ? [] : value.split(',').map((s) => s.trim()).filter((s) => s !== '')
    for (const p of parts) push(p)
    byName.push({ name, source, segments: parts.length })
    return value !== null
  }
  take(poolEnv)
  for (const n of fallbackEnvs) take(n)
  return { keys, byName }
}

/** 一次上游探测。返回 `{ok, status, verdict, message, error}`；**message 已脱敏**。 */
function probe({ base, method, probePath, key, timeout, model }) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(base)
    } catch {
      resolve({ ok: false, status: 0, verdict: 'UNKNOWN', message: `非法 --base：${base}`, error: 'bad-base' })
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    const upstreamPath = url.pathname.replace(/\/$/, '') + probePath
    let body = Buffer.alloc(0)
    const headers = { authorization: 'Bearer ' + key, host: url.host, 'accept-encoding': 'identity' }
    if (method === 'POST') {
      const payload = JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      })
      body = Buffer.from(payload, 'utf8')
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(body.length)
    }
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        method,
        path: upstreamPath,
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => {
          if (chunks.reduce((a, b) => a + b.length, 0) < 4000) chunks.push(c)
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          let text = Buffer.concat(chunks).toString('utf8')
          // ★ 脱敏：把 key 与 Bearer 形状抹掉（防上游回显 token）
          text = text.split(key).join('[redacted]').replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]')
          text = text.replace(/\s+/g, ' ').trim().slice(0, 300)
          let verdict
          if (status >= 200 && status < 300) verdict = 'VALID'
          else if (status === 401 || status === 403) verdict = 'INVALID'
          else if (status === 429 || (status >= 500 && status < 600)) verdict = 'UNKNOWN'
          else if (status === 404) verdict = 'UNKNOWN'
          else verdict = 'UNKNOWN'
          resolve({ ok: true, status, verdict, message: text })
        })
      },
    )
    req.setTimeout(timeout, () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (e) => {
      resolve({ ok: false, status: 0, verdict: 'UNREACHABLE', message: String(e.message || e), error: 'network' })
    })
    if (body.length) req.write(body)
    req.end()
  })
}

/** 顺带读一次在跑的池的 /healthz（无鉴权），拿它的 key 数对账。 */
function probeHealthz(url, timeout) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(url)
    } catch {
      resolve({ ok: false, note: `非法 URL：${url}` })
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get({ hostname: u.hostname, port: u.port ? Number(u.port) : undefined, path: u.pathname, timeout }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        let keys = null
        try {
          const j = JSON.parse(text)
          if (typeof j.keys === 'number') keys = j.keys
        } catch {
          /* 非 JSON ⇒ 保持 null */
        }
        resolve({ ok: res.statusCode === 200, status: res.statusCode, keys, raw: text.slice(0, 200) })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => resolve({ ok: false, note: String(e.message || e) }))
  })
}

/**
 * ★ 零泄漏自检：把即将打印的整段文本拿来，断言**任一完整 key 都不出现**。
 * 违反 ⇒ 抛错（宁可不输出，也不泄漏）。
 */
function assertNoLeak(text, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].length >= 8 && text.includes(keys[i])) {
      throw new Error(`零泄漏自检失败：输出里出现了第 ${i + 1} 把 key 的完整值 ⇒ 已中止输出（不打印任何结果）`)
    }
  }
}

/**
 * ★ 泄漏扫描（`--leak-scan <file...>`）：拿**池的全部 key** 去扫给定文件，
 * 看有没有哪个文件的字节里出现了完整 key。**只报计数与文件名，绝不打印命中的片段**。
 * 另附一条通用形状统计（像 token 的长串有多少个），用于发现"形似 key"的残留。
 * @returns {{file:string, bytes:number, fullKeyHits:number, shaped:number}[]}
 */
function leakScan(files, keys) {
  const SHAPED = /(?:sk|api|tok|key)[-_][A-Za-z0-9_-]{16,}/g
  return files.map((file) => {
    let buf
    try {
      buf = fs.readFileSync(file)
    } catch (e) {
      return { file, bytes: -1, fullKeyHits: -1, shaped: -1, error: String(e.code ?? e.message) }
    }
    const text = buf.toString('utf8')
    let fullKeyHits = 0
    for (const k of keys) {
      if (k.length >= 8 && text.includes(k)) fullKeyHits += 1
    }
    const shaped = (text.match(SHAPED) ?? []).length
    return { file, bytes: buf.length, fullKeyHits, shaped, error: null }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `pool-key-selftest.mjs —— key-pool-proxy 的「逐 key 自检」

  node scripts/pool-key-selftest.mjs [选项]

  --env-file <p>       读取 KEY=VALUE 文件（仅补 process.env 缺的名字；可重复）
  --pool-env <名>      覆盖主池 env 名
  --fallback-env <名>  覆盖回退池 env 名（可重复）
  --base <url>         覆盖上游根地址
  --path <p>           探测路径（缺省 /v1/chat/completions）
  --chat               POST 探测（缺省即 chat）
  --models             改用 GET /v1/models（★ 便宜但对本上游验不出坏 key ⇒ 假绿）
  --model <名>         POST 探测的模型名（缺省 agnes-2.5-flash）
  --timeout <ms>       单次探测超时（缺省 15000）
  --repeat <n>         每把 key 探测次数（缺省 1）
  --healthz <url>      在跑的池的 key 数对账（缺省 http://127.0.0.1:3101/healthz）
  --no-healthz         关掉对账
  --no-config          不读 cordis.patch.yml
  --json               机器可读输出
  --leak-scan <file>   泄漏扫描模式：用池的 key 扫这些文件，只报计数（可重复）
  --help

退出码：0=全有效；1=有无效 key；2=读不到 key；3=用法/IO 错
`

function parseArgv(argv) {
  const o = {
    envFiles: [],
    poolEnv: null,
    fallbackEnvs: [],
    base: null,
    probePath: DEFAULT_CHAT_PATH,
    chat: false,
    models: false,
    model: DEFAULT_MODEL,
    timeout: 15000,
    repeat: 1,
    healthz: 'http://127.0.0.1:3101/healthz',
    noHealthz: false,
    noConfig: false,
    json: false,
    leakScan: [],
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const need = (name) => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`参数 ${name} 缺少取值`)
      return v
    }
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--env-file') o.envFiles.push(need(a))
    else if (a === '--pool-env') o.poolEnv = need(a)
    else if (a === '--fallback-env') o.fallbackEnvs.push(need(a))
    else if (a === '--base') o.base = need(a)
    else if (a === '--path') o.probePath = need(a)
    else if (a === '--chat') o.chat = true
    else if (a === '--models') o.models = true
    else if (a === '--model') o.model = need(a)
    else if (a === '--timeout') o.timeout = Number(need(a))
    else if (a === '--repeat') o.repeat = Number(need(a))
    else if (a === '--healthz') o.healthz = need(a)
    else if (a === '--no-healthz') o.noHealthz = true
    else if (a === '--no-config') o.noConfig = true
    else if (a === '--json') o.json = true
    else if (a === '--leak-scan') {
      // 可变参数：吃掉后面所有不以 `--` 开头的 token（也允许后续再给一个 --leak-scan）
      let got = 0
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        o.leakScan.push(argv[++i])
        got += 1
      }
      if (got === 0) throw new Error('参数 --leak-scan 缺少取值（至少要一个文件）')
    } else throw new Error(`未知参数 "${a}"（--help 看用法）`)
  }
  return o
}

async function main(argv) {
  const argvOf = argv
  let opts
  try {
    opts = parseArgv(argvOf)
  } catch (e) {
    process.stderr.write(`用法错误：${e.message}\n${USAGE}`)
    return 3
  }
  if (opts.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (opts.models && opts.probePath === DEFAULT_CHAT_PATH) opts.probePath = DEFAULT_MODELS_PATH
  if (opts.chat && opts.probePath === DEFAULT_MODELS_PATH && !opts.models) opts.probePath = DEFAULT_CHAT_PATH
  // ★ 规范化路径：Git Bash/MSYS 会把 `--path /v1/...` 的前导 `/` 转成 Windows 路径 ⇒ 这里兜底
  {
    const raw = String(opts.probePath)
    if (/^[A-Za-z]:[\\/]/.test(raw) || raw.includes('\\')) {
      process.stderr.write(
        `非法 --path（像是被 shell 的路径转换吃掉了）：${raw}\n` +
          '  在 Git Bash 里请加 MSYS_NO_PATHCONV=1，或干脆不传 --path 用缺省。PowerShell/cmd 无此问题。\n',
      )
      return 3
    }
    if (!raw.startsWith('/')) opts.probePath = '/' + raw
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    process.stderr.write('用法错误：--timeout 必须是正数\n')
    return 3
  }
  if (!Number.isFinite(opts.repeat) || opts.repeat < 1) {
    process.stderr.write('用法错误：--repeat 必须是 >=1 的整数\n')
    return 3
  }

  // 配置：patch yml（池自己的单一来源）> 硬编码缺省 > 命令行覆盖
  let configSource = 'hardcoded-defaults'
  let cfg = { ...HARD_DEFAULTS }
  if (!opts.noConfig) {
    const fromPatch = readPoolConfigFromPatch()
    if (fromPatch) {
      configSource = 'cordis.patch.yml'
      cfg = {
        poolEnv: fromPatch.poolEnv,
        fallbackEnvs: fromPatch.fallbackEnvs.length ? fromPatch.fallbackEnvs : HARD_DEFAULTS.fallbackEnvs,
        upstreamBase: fromPatch.upstreamBase ?? HARD_DEFAULTS.upstreamBase,
        port: fromPatch.port ?? HARD_DEFAULTS.port,
      }
    }
  }
  if (opts.poolEnv) cfg.poolEnv = opts.poolEnv
  if (opts.fallbackEnvs.length) cfg.fallbackEnvs = opts.fallbackEnvs
  if (opts.base) cfg.upstreamBase = opts.base

  // env-file 覆盖层
  const overlay = new Map()
  const envFileNotes = []
  for (const f of opts.envFiles) {
    try {
      const m = readEnvFile(f)
      for (const [k, v] of m) if (!overlay.has(k)) overlay.set(k, v)
      envFileNotes.push({ file: f, names: [...m.keys()].length })
    } catch (e) {
      process.stderr.write(`${e.message}\n`)
      return 3
    }
  }

  const { keys, byName } = loadPool(cfg, overlay)

  // ★ 泄漏扫描模式：用池的全部 key 去扫给定文件（只报计数，不打印命中片段）
  if (opts.leakScan.length > 0) {
    if (keys.length === 0) {
      process.stderr.write('泄漏扫描：读不到任何 key ⇒ 无法判断是否泄漏（先补 --env-file）。\n')
      return 2
    }
    const rows = leakScan(opts.leakScan, keys)
    const out = []
    out.push('════════════════════════════════════════════════════════════════════════')
    out.push(`泄漏扫描（--leak-scan）：用池的 ${keys.length} 把 key 逐字节扫给定文件`)
    out.push('  ★ 只报计数；不打印任何命中片段、不打印 key')
    out.push('════════════════════════════════════════════════════════════════════════')
    let leaked = 0
    for (const r of rows) {
      if (r.error) {
        out.push(`  ${r.file} ⇒ 读不到（${r.error}）`)
        continue
      }
      if (r.fullKeyHits > 0) leaked += 1
      out.push(`  ${r.file}`)
      out.push(`      bytes=${r.bytes}  完整key命中=${r.fullKeyHits}  形似token长串=${r.shaped}`)
    }
    out.push('')
    out.push(leaked === 0 ? `★ 结论：${rows.length} 个文件，0 处出现完整 key ⇒ 未泄漏` : `★★ 结论：${leaked} 个文件里出现了完整 key ⇒ 泄漏！`)
    const text = out.join('\n') + '\n'
    assertNoLeak(text, keys)
    process.stdout.write(text)
    return leaked === 0 ? 0 : 1
  }

  const isChat = opts.probePath.includes('chat/completions')
  const method = isChat ? 'POST' : 'GET'
  const lines = []
  const emit = (s) => lines.push(s)

  emit('════════════════════════════════════════════════════════════════════════')
  emit('key-pool-proxy 逐 key 自检（pool-key-selftest.mjs）')
  emit('════════════════════════════════════════════════════════════════════════')
  emit(`配置来源 : ${configSource}${opts.noConfig ? '（--no-config）' : ''}`)
  emit(`主池 env : ${cfg.poolEnv}`)
  emit(`回退 env : ${cfg.fallbackEnvs.join(', ') || '(none)'}`)
  emit(`上游     : ${cfg.upstreamBase}`)
  emit(`探测     : ${method} ${opts.probePath}  timeout=${opts.timeout}ms repeat=${opts.repeat}${isChat ? '' : '  ★ 弱校验面'}`)
  if (!isChat) {
    emit('★ 注意：当前探的是非 chat 面；本上游对该面不校验认证 ⇒ 坏 key 也会显示 VALID（**假绿**）。去掉 --models 即改回 chat 面。')
  }
  if (envFileNotes.length) {
    emit(`env-file : ${envFileNotes.map((n) => `${n.file} (${n.names} 个名字)`).join(' ; ')}`)
  } else {
    emit('env-file : （无；只读当前进程环境）')
  }
  emit('')

  emit('— env 来源（只记「名字 → 来源 + 段数」，不记值）—')
  for (const b of byName) emit(`  ${b.name.padEnd(34)} source=${b.source.padEnd(12)} segments=${b.segments}`)
  emit('')

  if (keys.length === 0) {
    emit('★★ 读不到 key：主池与回退池都是空的（当前进程环境 + 你给的 env-file 里都没有）。')
    emit('   ⇒ 这不是"池里没有坏 key"，而是"本进程看不到池的 key"。')
    emit('   ⇒ 见报告「给用户的自检命令」：请在**启动控制面的那个终端**里跑本脚本，')
    emit('     或显式带上真实来源：--env-file <agent-shell/.env 的路径>。')
    const text0 = lines.join('\n') + '\n'
    assertNoLeak(text0, keys)
    if (opts.json) {
      process.stdout.write(JSON.stringify({ schema: 'dsh-pool-key-selftest/v1', ok: false, reason: 'empty-pool', poolSize: 0, results: [] }, null, 2) + '\n')
    } else {
      process.stdout.write(text0)
    }
    return 2
  }

  // 逐把探测
  const results = []
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    const runs = []
    for (let r = 0; r < opts.repeat; r += 1) {
      // eslint-disable-next-line no-await-in-loop
      const out = await probe({ base: cfg.upstreamBase, method, probePath: opts.probePath, key, timeout: opts.timeout, model: opts.model })
      runs.push(out)
    }
    // 汇总判据：任一次 VALID ⇒ VALID；否则任一次 INVALID ⇒ INVALID；否则取第一次的 verdict
    let verdict = runs[0].verdict
    if (runs.some((x) => x.verdict === 'VALID')) verdict = 'VALID'
    else if (runs.some((x) => x.verdict === 'INVALID')) verdict = 'INVALID'
    results.push({ index: i + 1, masked: mask(key), verdict, runs })
    emit(
      `  #${String(i + 1).padStart(2)}  ${mask(key).padEnd(20)}  status=${String(runs[0].status).padEnd(4)} verdict=${verdict.padEnd(11)} ${runs[0].message.slice(0, 140)}`,
    )
  }

  const valid = results.filter((r) => r.verdict === 'VALID').length
  const invalid = results.filter((r) => r.verdict === 'INVALID').length
  const unknown = results.filter((r) => !['VALID', 'INVALID'].includes(r.verdict)).length

  emit('')
  emit(`★ 池共 ${keys.length} 把 key：有效 ${valid} / 无效 ${invalid} / 未能判定 ${unknown}`)
  if (invalid > 0) {
    emit(`★ 判为无效的（脱敏尾 4 位）：${results.filter((r) => r.verdict === 'INVALID').map((r) => r.masked).join(' , ')}`)
  }

  // 与在跑的池对账
  let health = null
  if (!opts.noHealthz) {
    health = await probeHealthz(opts.healthz, Math.min(opts.timeout, 5000))
    emit('')
    if (health.keys !== null && health.keys !== undefined) {
      const match = health.keys === keys.length ? '一致' : '★ 不一致'
      emit(`— 在跑的池对账 — ${opts.healthz} ⇒ keys=${health.keys}（本进程读到 ${keys.length} 把）⇒ ${match}`)
      if (health.keys !== keys.length) {
        emit('   ⇒ 两者不等 = 本进程读到的 env【不是】在跑的池那份 env（或缺 env-file）⇒ 结论只覆盖本进程读到的这几把。')
      }
    } else {
      emit(`— 在跑的池对账 — ${opts.healthz} ⇒ 读不到（${health.note ?? `status=${health.status}`}）`)
    }
  }

  const text = lines.join('\n') + '\n'
  assertNoLeak(text, keys)
  if (opts.json) {
    const payload = {
      schema: 'dsh-pool-key-selftest/v1',
      ok: invalid === 0 && keys.length > 0,
      configSource,
      poolEnv: cfg.poolEnv,
      fallbackEnvs: cfg.fallbackEnvs,
      upstreamBase: cfg.upstreamBase,
      probe: { method, path: opts.probePath, timeout: opts.timeout, repeat: opts.repeat },
      envSources: byName,
      poolSize: keys.length,
      valid,
      invalid,
      unknown,
      invalidMasked: results.filter((r) => r.verdict === 'INVALID').map((r) => r.masked),
      results: results.map((r) => ({
        index: r.index,
        masked: r.masked,
        verdict: r.verdict,
        status: r.runs[0].status,
        message: r.runs[0].message,
      })),
      healthz: health,
    }
    const jtext = JSON.stringify(payload, null, 2) + '\n'
    assertNoLeak(jtext, keys)
    process.stdout.write(jtext)
  } else {
    process.stdout.write(text)
  }
  if (invalid > 0) return 1
  return 0
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`pool-key-selftest 内部错误：${e.message}\n`)
      process.exit(3)
    })
}

export { loadPool, mask, assertNoLeak, leakScan, readPoolConfigFromPatch, HARD_DEFAULTS }
