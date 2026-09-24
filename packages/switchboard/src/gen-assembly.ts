/**
 * @module @dsh-brain/switchboard/gen-assembly
 *
 * 「代装配清单」——**模型接入 / key 池属于「代」的内容，不属于控制面**。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么有这一层（2026-09-24）
 *
 * 病：控制面与代**共用同一个 profile**（`WEB_PROFILE`），而且 key 池的凭据是
 * 控制面进程自己的 env（`GEN_ENV_EXTRA` → `AGENTSHELL_MAIN_LLM_API_KEYS`）。
 * 于是"模型接入 / key 池"被**装配进了控制面**：
 *   · 改 provider / 模型 / 池端口 → 改 profile（控制面启动时被钉住的那一个）；
 *   · 改 key → 改控制面进程 env（只有重启控制面才会重读）；
 * 两者都要求**重启控制面**——而控制面重启是"整套栈重来"，正是这个项目最想避免的动作。
 *
 * 药：把模型接入/key 池**降级为「一代的内容」**——一份清单（本模块），
 * **每次 spawn 一个代时读一次**（含 bootstrap 代）：
 *   · 清单声明：脑剖面 + 代 overlay + 代 env 文件（key 池）+ 池规格 + 模型规格；
 *   · 控制面把它们渲染成"本代的装配"（`--profile` + `--patch` + env），自己不持有任何一样；
 *   · ⇒ 改模型/key/provider/pool = 改清单 = **换代**（有验证闸 + 回滚）⇒ **不需要重启控制面**。
 *
 * 三条不变量（写进代码，不只是注释）：
 *   INV-A **控制面最小集不含模型接入**：控制面进程不读 key、不装池。清单缺省 ⇒ 最小集。
 *   INV-B **每次 spawn 必重读**：本模块的 value 面全是纯函数；读取发生在 spawn 那一刻，
 *         绝不在控制面 boot 时缓存（否则又变回"要重启控制面"）。
 *   INV-C **坏清单必须响**：解析失败 ⇒ 抛错并 abort 该次换代；绝不"降级成最小集接着换"
 *         （那会把一次配置错误静默地变成一次"服务能力被拔掉"的上线）。
 *
 * 设计边界：本模块**只产出 spawn 规格**，不 spawn、不碰前门、不碰租约。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 池规格：把 key-pool-proxy 装进本代的描述。 */
export interface PoolSpec {
  /**
   * 是否随本代装配池。
   *
   * ★ 缺省（`undefined`）= **不装**：这正是"控制面最小集"的形态——
   *   控制面在没有清单的情况下也能启动并服务，只是没有模型接入。
   *   需要模型的代由清单显式写 `enabled: true`。
   */
  enabled?: boolean
  /**
   * 池端口 = **本代端口 + portOffset**（派生）。
   *
   * ★ 为什么派生而不是固定 3101：固定端口让"池"退化成控制面级的共享资源——
   *   多代并存时必须靠 EADDRINUSE 容忍 + promote/freeze 事件抢它，且 3101 因此
   *   必须被 `RESERVED_GEN_PORTS` 永久保留（见 coordinator.ts 的事故注释）。
   *   派生之后每个代有**自己的池口**（= `gen-3043` 的池在 3143），
   *   并存不再互相抢、端口不再需要为池让路。
   */
  portOffset?: number
  /** 显式端口（与 portOffset 二选一；同时给 ⇒ explicitPort 优先）。 */
  explicitPort?: number
  /** 池的上游（OpenAI 兼容根，不含 /v1）。 */
  upstreamBase?: string
  /** 池从哪个 env 读 key（逗号分隔）。 */
  poolEnv?: string
  /** 回退 env 名。 */
  fallbackEnvs?: string[]
  cooldownMs?: number
  maxRetries?: number
  retryStatuses?: number[]
}

/** 模型规格：本代默认走哪个 provider/model，以及它的上游怎么来。 */
export interface ModelSpec {
  provider: string
  id: string
  displayName?: string
  /** OpenAI 兼容端点。给 `pool:true` 时按本代池口算，不给则用 `baseURL`。 */
  baseURL?: string
  /** true（默认当 pool.enabled）⇒ baseURL = 本代池；显式 baseURL 优先。 */
  routeThroughPool?: boolean
  /** provider 认的 key 引用名（pi-ai 的 apiKeyEnv）。 */
  apiKeyEnv?: string
  contextWindow?: number
  maxTokens?: number
}

/** 一份代装配清单的完整形状。 */
export interface GenAssembly {
  /** 清单自身的版本戳；用于在报告/日志里指认"这次换代用的是哪一版装配"。 */
  version: number | string
  /** 脑剖面。缺省 ⇒ 用控制剖面（控制面最小集）。 */
  profile?: string
  /** 代额外 overlay（绝对路径或相对清单文件所在目录，可重复）。 */
  patches?: string[]
  /** 代 env 的来源文件（`.env` 形状）；**key 池与凭据住在这里**，不住在控制面进程里。 */
  envFiles?: string[]
  /** 代 env 内联（非机密项，如 provider 端点开关）。 */
  env?: Record<string, string>
  pool?: PoolSpec
  model?: ModelSpec
}

/** 解析成功/失败的统一结果（失败带人可读原因，供 abort 的 note 直读）。 */
export interface AssemblyLoad {
  /** 清单来源的可读身份：`none`（最小集）/ `file:<abs>@<mtimeMs>`。 */
  source: string
  /** 生效的清单（file 缺失时 = 最小集）。 */
  assembly: GenAssembly
  /** 清单文件绝对路径（最小集时 undefined）。 */
  file?: string
}

/** 「控制面最小集」：没有清单时的装配 = 一个**不含模型接入**的普通代。 */
export const MINIMAL_ASSEMBLY: GenAssembly = Object.freeze({
  version: 'minimal(no-model-access)',
}) as GenAssembly

/** 该值必须是非空字符串，否则抛错。 */
function needString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where}: 期望非空字符串，实际 ${JSON.stringify(v)}`)
  return v
}

function optString(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null) return undefined
  return needString(v, where)
}

function optInt(v: unknown, where: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${where}: 期望整数，实际 ${JSON.stringify(v)}`)
  return v
}

function optBool(v: unknown, where: string): boolean | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new Error(`${where}: 期望布尔，实际 ${JSON.stringify(v)}`)
  return v
}

function optStringArray(v: unknown, where: string): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error(`${where}: 期望字符串数组，实际 ${JSON.stringify(v)}`)
  return v.map((x, i) => needString(x, `${where}[${i}]`))
}

function optIntArray(v: unknown, where: string): number[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new Error(`${where}: 期望整数数组，实际 ${JSON.stringify(v)}`)
  return v.map((x, i) => {
    const n = optInt(x, `${where}[${i}]`)
    if (n === undefined) throw new Error(`${where}[${i}]: 期望整数`)
    return n
  })
}

function optRecord(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where}: 期望对象，实际 ${JSON.stringify(v)}`)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[needString(k, `${where}.<key>`)] = needString(val, `${where}.${k}`)
  }
  return out
}

/**
 * 解析一份清单（JSON）。**只做形状校验，不做兜底**：任何不认识的形状都抛错，
 * 因为"静默降级成最小集"会让一次配置笔误伪装成一次成功的换代（INV-C）。
 */
export function parseGenAssembly(raw: string, where = 'gen-assembly'): GenAssembly {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${where}: 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）`)
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${where}: 顶层必须是对象`)
  }
  const o = obj as Record<string, unknown>
  if (o.version === undefined) throw new Error(`${where}.version: 必填（用于指认本次换代用的哪一版装配）`)
  const version = typeof o.version === 'number' ? o.version : needString(o.version, `${where}.version`)

  const pool = ((): PoolSpec | undefined => {
    const p = o.pool
    if (p === undefined || p === null) return undefined
    if (typeof p !== 'object' || Array.isArray(p)) throw new Error(`${where}.pool: 期望对象`)
    const q = p as Record<string, unknown>
    return {
      enabled: optBool(q.enabled, `${where}.pool.enabled`),
      portOffset: optInt(q.portOffset, `${where}.pool.portOffset`),
      explicitPort: optInt(q.explicitPort, `${where}.pool.explicitPort`),
      upstreamBase: optString(q.upstreamBase, `${where}.pool.upstreamBase`),
      poolEnv: optString(q.poolEnv, `${where}.pool.poolEnv`),
      fallbackEnvs: optStringArray(q.fallbackEnvs, `${where}.pool.fallbackEnvs`),
      cooldownMs: optInt(q.cooldownMs, `${where}.pool.cooldownMs`),
      maxRetries: optInt(q.maxRetries, `${where}.pool.maxRetries`),
      retryStatuses: optIntArray(q.retryStatuses, `${where}.pool.retryStatuses`),
    }
  })()

  const model = ((): ModelSpec | undefined => {
    const m = o.model
    if (m === undefined || m === null) return undefined
    if (typeof m !== 'object' || Array.isArray(m)) throw new Error(`${where}.model: 期望对象`)
    const q = m as Record<string, unknown>
    return {
      provider: needString(q.provider, `${where}.model.provider`),
      id: needString(q.id, `${where}.model.id`),
      displayName: optString(q.displayName, `${where}.model.displayName`),
      baseURL: optString(q.baseURL, `${where}.model.baseURL`),
      routeThroughPool: optBool(q.routeThroughPool, `${where}.model.routeThroughPool`),
      apiKeyEnv: optString(q.apiKeyEnv, `${where}.model.apiKeyEnv`),
      contextWindow: optInt(q.contextWindow, `${where}.model.contextWindow`),
      maxTokens: optInt(q.maxTokens, `${where}.model.maxTokens`),
    }
  })()

  const assembly: GenAssembly = {
    version,
    ...(optString(o.profile, `${where}.profile`) ? { profile: o.profile as string } : {}),
    ...(optStringArray(o.patches, `${where}.patches`) ? { patches: o.patches as string[] } : {}),
    ...(optStringArray(o.envFiles, `${where}.envFiles`) ? { envFiles: o.envFiles as string[] } : {}),
    ...(optRecord(o.env, `${where}.env`) ? { env: o.env as Record<string, string> } : {}),
    ...(pool ? { pool } : {}),
    ...(model ? { model } : {}),
  }
  return assembly
}

/**
 * 读一份清单。**每次调用都读盘**（INV-B）——调用点必须落在 spawn 那一刻。
 *
 * @param file 清单路径；`undefined`/空 ⇒ 返回控制面最小集（`source='none'`）。
 */
export function loadGenAssembly(file: string | undefined): AssemblyLoad {
  if (!file || file.trim() === '') return { source: 'none', assembly: MINIMAL_ASSEMBLY }
  const abs = resolve(file)
  if (!existsSync(abs)) return { source: 'none', assembly: MINIMAL_ASSEMBLY }
  const raw = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')
  const mtimeMs = statSync(abs).mtimeMs
  const assembly = parseGenAssembly(raw, `gen-assembly(${abs})`)
  return { source: `file:${abs}@${mtimeMs}`, assembly, file: abs }
}

/** 解析一个 `.env` 形状的文本：`KEY=VALUE`，`#` 注释，两侧去空白，值两侧引号去掉。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim()
    if (!k) continue
    let v = line.slice(eq + 1).trim()
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    if (v) out[k] = v
  }
  return out
}

/**
 * 本代的池端口。**派生**（`genPort + portOffset`）优先；`explicitPort` 其次；
 * `enabled` 不为真 ⇒ 返回 `null`（本代没有池）。
 *
 * @param pool 池规格。
 * @param genPort 本代主端口。
 */
export function poolPortOf(pool: PoolSpec | undefined, genPort: number): number | null {
  if (!pool || pool.enabled !== true) return null
  if (typeof pool.explicitPort === 'number') return pool.explicitPort
  const off = typeof pool.portOffset === 'number' ? pool.portOffset : 1000
  return genPort + off
}

/** 本代 spawn 所需的三样装配（其余一概不碰）。 */
export interface GenSpawnSpec {
  /** `dsh --profile <这里>` */
  profile: string
  /** `--patch <path>` 列表（清单声明的 + 本模块渲染的池/模型 overlay）。 */
  extraPatches: string[]
  /** 注入本代进程的 env（key 池与凭据来自清单声明的 env 文件）。 */
  envExtra: Record<string, string>
  /** 本代池端口（无池 ⇒ null）。 */
  poolPort: number | null
  /** 可读的"这份装配从哪来"，写进日志/状态便于对账。 */
  source: string
}

/** YAML 标量渲染（够用即可：本模块只渲染自己生成的字符串/数字/数组）。 */
function y(v: string | number): string {
  return typeof y === 'number' ? String(v) : JSON.stringify(v)
}

function lines(indent: string, items: string[]): string[] {
  return items.map((s) => indent + s)
}

/**
 * 把一个 key-pool-proxy 的 `insert` 渲染成 YAML 片段（不含前置 `- `）。
 * 与 `packages/key-pool-proxy/cordis.patch.yml` 的 insert 形状**逐字段对应**，
 * 差异只有：`port` 来自本代派生值，`upstreamBase` 来自清单。
 */
function renderPoolInsert(pool: PoolSpec, port: number): string[] {
  const out: string[] = []
  out.push('- insert:')
  out.push('    - id: key-pool-proxy')
  out.push("      name: '@dsh-brain/key-pool-proxy'")
  out.push('      config:')
  out.push(`        poolEnv: ${y(pool.poolEnv ?? 'AGENTSHELL_MAIN_LLM_API_KEYS')}`)
  const fb = pool.fallbackEnvs ?? ['AGENTSHELL_MAIN_LLM_API_KEY']
  if (fb.length === 0) out.push('        fallbackEnvs: []')
  else {
    out.push('        fallbackEnvs:')
    out.push(...lines('          - ', fb.map(y)))
  }
  out.push(`        upstreamBase: ${y(pool.upstreamBase ?? 'https://apihub.agnes-ai.com')}`)
  out.push(`        port: ${port}`)
  out.push(`        cooldownMs: ${typeof pool.cooldownMs === 'number' ? pool.cooldownMs : 15000}`)
  out.push(`        maxRetries: ${typeof pool.maxRetries === 'number' ? pool.maxRetries : 3}`)
  const rs = pool.retryStatuses ?? [429, 500, 502, 503, 504]
  out.push('        retryStatuses:')
  out.push(...lines('          - ', rs.map((n) => String(n))))
  return out
}

/**
 * 渲染"本代装配"的 overlay：
 *   ①（`pool.enabled`）key-pool-proxy insert，端口 = 本代派生池口；
 *   ②（`model`）`llm-pi-ai` 的 provider 路由 + `agent-default-model` 默认模型。
 * 空/无内容 ⇒ 返回空串（调用方据此跳过 `--patch`，行为与今天完全一致）。
 *
 * 这是**唯一**把清单翻译成 dsh 装配的地方；纯函数，可单测。
 */
export function renderAssemblyOverlay(a: GenAssembly, genPort: number): string {
  const poolPort = poolPortOf(a.pool, genPort)
  const model = a.model
  const wantModel = model && (model.routeThroughPool === true || (model.routeThroughPool === undefined && poolPort !== null))
  if (poolPort === null && !model) return ''

  const out: string[] = []
  out.push('# generated per-gen overlay by switchboard · gen-assembly')
  out.push('# 本文件由 **本代** 的装配清单渲染（不是控制面的装配）。清单变更只会随下一次换代生效。')
  out.push(`# assembly.version=${String(a.version)} genPort=${genPort} poolPort=${poolPort ?? 'none'}`)
  out.push('')

  if (poolPort !== null) {
    out.push(...renderPoolInsert(a.pool!, poolPort))
    out.push('')
  }

  if (model) {
    const baseURL = model.baseURL ?? (wantModel && poolPort !== null ? `http://127.0.0.1:${poolPort}/v1` : undefined)
    out.push('- id: llm-pi-ai')
    out.push('  config:')
    out.push('    providers:')
    out.push(`      ${model.provider}:`)
    if (model.displayName) out.push(`        displayName: ${y(model.displayName)}`)
    if (model.apiKeyEnv) out.push(`        apiKeyEnv: ${y(model.apiKeyEnv)}`)
    out.push("        api: openai-completions")
    if (baseURL) out.push(`        baseURL: ${y(baseURL)}`)
    out.push('        models:')
    out.push(`          - id: ${y(model.id)}`)
    if (model.displayName) out.push(`            name: ${y(model.displayName + ' ' + model.id)}`)
    out.push(`            contextWindow: ${typeof model.contextWindow === 'number' ? model.contextWindow : 512000}`)
    out.push(`            maxTokens: ${typeof model.maxTokens === 'number' ? model.maxTokens : 65536}`)
    out.push('')
    out.push('- id: agent-default-model')
    out.push('  config:')
    out.push(`    provider: ${y(model.provider)}`)
    out.push(`    model: ${y(model.id)}`)
    out.push('')
  }
  return out.join('\n')
}

/** 把本代 overlay 落盘（<genDir>/assembly-overlay.yml）；无内容 ⇒ 返回 null。 */
export function writeAssemblyOverlay(genDir: string, a: GenAssembly, genPort: number): string | null {
  const yaml = renderAssemblyOverlay(a, genPort)
  if (!yaml.trim()) return null
  mkdirSync(genDir, { recursive: true })
  const file = join(genDir, 'assembly-overlay.yml')
  writeFileSync(file, yaml, 'utf8')
  return file
}

/** `?cmd=assembly` 的只读投影（「控制面装了什么 / 下一代会被装成什么」的可执行证据）。 */
export interface AssemblyProjection {
  /** 控制面自己的剖面名（= 控制面启动最小集里那一个 profile）。 */
  ctrlProfile: string
  /** 清单文件绝对路径（未配置 ⇒ null）。 */
  assemblyFile: string | null
  /** 清单文件此刻是否存在（false ⇒ 控制面以**最小集**启动/换代）。 */
  assemblyPresent: boolean
  /** 可读来源：`none` / `file:<abs>@<mtimeMs>`。 */
  source: string
  version: string | number | null
  profile: string
  poolEnabled: boolean
  poolPortOffset: number | null
  /** 探测用的"下一代端口"（= 下一代将会拿到的端口）。 */
  probeGenPort: number
  /** 下一代池口（无池 ⇒ null）。 */
  probePoolPort: number | null
  /** 清单声明的 env 文件（**只报名字，不报值**）。 */
  envFileNames: string[]
  /** 下一代会被叠加的 `--patch`（含本模块渲染的 overlay）。 */
  patches: string[]
  /** 渲染出的 overlay 预览（**不落盘**，仅供人读）。 */
  overlayPreview: string
}

/**
 * 只读投影：把"控制面自己装了什么"与"下一代会被装成什么"摊成一份可核对的数据。
 * **不 spawn、不写盘、不改状态**，因此可在控制面存活期任意调用。
 * @throws 清单存在但坏 ⇒ 抛错（与 spawn 同一条判据：坏清单必须响）。
 */
export function projectAssembly(opts: { file?: string; ctrlProfile: string; probeGenPort: number }): AssemblyProjection {
  const loaded = loadGenAssembly(opts.file)
  const a = loaded.assembly
  const poolPort = poolPortOf(a.pool, opts.probeGenPort)
  const overlayPreview = renderAssemblyOverlay(a, opts.probeGenPort)
  return {
    ctrlProfile: opts.ctrlProfile,
    assemblyFile: loaded.file ?? null,
    assemblyPresent: loaded.file !== undefined,
    source: loaded.source,
    version: loaded.file ? a.version : null,
    profile: a.profile && a.profile.trim() ? a.profile.trim() : opts.ctrlProfile,
    poolEnabled: poolPort !== null,
    poolPortOffset: a.pool?.portOffset ?? (a.pool?.enabled === true ? 1000 : null),
    probeGenPort: opts.probeGenPort,
    probePoolPort: poolPort,
    envFileNames: (a.envFiles ?? []).map((f) => f),
    patches: (a.patches ?? []).map((p) => (isAbsolute(p) ? p : resolve(p))),
    overlayPreview,
  }
}

/**
 * ★ 本模块的主入口：**在 spawn 那一刻**把清单解析成一份 spawn 规格。
 *
 * @param opts.file        清单路径（`GEN_ASSEMBLY`；空 ⇒ 最小集）。
 * @param opts.genPort     本代主端口（用于派生池口与渲染）。
 * @param opts.genDir      本代落地目录（渲染出的 overlay 写这里）。
 * @param opts.defaultProfile 清单没写 `profile` 时的缺省 = **控制剖面**。
 * @param opts.baseEnv     调用方已有的额外 env（如实验内核目录）；清单 env 覆盖它。
 * @returns spawn 规格 + 清单来源（写进日志用）。
 * @throws 清单存在但坏 ⇒ 抛错（INV-C：调用方必须 abort，不得降级）。
 */
export function resolveGenSpawnSpec(opts: {
  file?: string
  genPort: number
  genDir: string
  defaultProfile: string
  baseEnv?: Record<string, string>
}): GenSpawnSpec {
  const loaded = loadGenAssembly(opts.file)
  const a = loaded.assembly

  // env：清单声明的 env 文件（key 池住在这里）→ 内联 env → 调用方 baseEnv（最低优先）。
  const envExtra: Record<string, string> = { ...(opts.baseEnv ?? {}) }
  for (const ef of a.envFiles ?? []) {
    const abs = isAbsolute(ef) ? ef : resolve(ef)
    if (!existsSync(abs)) {
      throw new Error(`gen-assembly: envFiles 里的 ${ef} 不存在（${abs}）—— 代没有 key 池就不能起，不静默跳过`)
    }
    Object.assign(envExtra, parseEnvFile(readFileSync(abs, 'utf8')))
  }
  Object.assign(envExtra, a.env ?? {})

  const overlay = writeAssemblyOverlay(opts.genDir, a, opts.genPort)
  const declared = (a.patches ?? []).map((p) => (isAbsolute(p) ? p : resolve(p)))
  for (const p of declared) {
    if (!existsSync(p)) throw new Error(`gen-assembly: patches 里的 ${p} 不存在`)
  }

  return {
    profile: a.profile && a.profile.trim() ? a.profile.trim() : opts.defaultProfile,
    extraPatches: [...declared, ...(overlay ? [overlay] : [])],
    envExtra,
    poolPort: poolPortOf(a.pool, opts.genPort),
    source: loaded.source,
  }
}
