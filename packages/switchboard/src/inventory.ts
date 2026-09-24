/**
 * @module @dsh-brain/switchboard/inventory
 *
 * **活实例清点器**（gen 侧能力）：在**本进程内**读运行时注册表，产出一份 `LiveInventory`。
 *
 * ★ 它为什么存在（格⑮：插件体检的"实测"半边）
 *
 * 预演体检要把「配置**声明**要装什么」与「活实例**实际**装上了什么」分开取证。后者只能从
 * 进程内部拿——一个模块 `import` 就抛错的插件，在 `cordis.patch.yml` 里和健康插件长得一模一样。
 * 所以本模块的每个读数都指向**运行时权威**：
 *
 * | 读数       | 运行时权威                                     | 为什么是它                                   |
 * |------------|------------------------------------------------|----------------------------------------------|
 * | `plugins`  | `ctx.loader.entries()` + `entry.fiber.state`   | Loader 是插件生命的唯一权威（有 fiber 就有生命） |
 * | `tools`    | `ctx.tools.schemas()`                          | registry 喂给 `systemPrompt.tools()` 的**同一份**表 |
 * | `commands` | `ctx.commands.list()`                          | host 命令注册表本身                           |
 *
 * `tools` 这一项是本子系统对「**工具面**」的回答（另一臂 B1 自认的缺口）：
 * `ctx.tools.schemas()` 返回的正是**模型面可见的工具 schema**——即"插件注册的工具出现在模型手里"
 * 这件事在**不发起任何 LLM 请求**的前提下能被观察到的**最直接**形态。
 * 它不消耗任何 key/token，因此**结构上不可能**把负载压到现役共享 key 池上（见 REPORT 的加分项）。
 *
 * ★ 纯函数 + 注入式依赖面：`collectInventory` 只吃一个 `InventorySources`（loader/tools/commands
 *   三个可选服务引用），不 import 任何 cordis 类型 ⇒ 可离线单测、可作为契约被 stub。
 *   真正的服务引用由 `index.ts` 经 `ctx.inject([...])` 填进来（运行时可选，缺装配不崩）。
 */
import type { LiveInventory } from './preflight-contract.js'

/** Cordis FiberState 的运行时镜像（跨包 const enum，运行时值必须自带一份）。 */
const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/** FiberState → 公开 phase 名（`disposed` 无生命 ⇒ null，与 `pluginInventory` 的投影同源）。 */
const FIBER_PHASE: Record<number, string | null> = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
}

/** Loader 条目的**结构性**最小面（只声明我们要读的字段，不 import loader 类型）。 */
export interface LoaderEntryLike {
  id?: unknown
  disabled?: unknown
  options?: { name?: unknown; group?: unknown } | undefined
  fiber?: { state?: unknown } | undefined
}

/** `ctx.loader` 的最小面。 */
export interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

/** `ctx.tools` 的最小面（`schemas(scope?)` 是模型面工具表的来源）。 */
export interface ToolsLike {
  schemas(scope?: unknown): Array<{ name?: unknown }>
}

/** `ctx.commands` 的最小面。 */
export interface CommandsLike {
  list(agent?: unknown): Array<{ name?: unknown }>
}

/** 清点器的注入式依赖面。三个服务都可缺，缺了就要在 `unavailable` 里**显式说明**。 */
export interface InventorySources {
  gen: string
  mode: string
  loader?: LoaderLike | undefined
  tools?: ToolsLike | undefined
  commands?: CommandsLike | undefined
  build?: string
  /** 覆盖时间戳（单测用）。 */
  now?: number
}

/** 把任意值安全转成字符串名（取不到返回空串，而不是 `"undefined"`）。 */
function nameOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 归一化 loader 条目 id：剥掉**跟 include 根**的前缀。
 *
 * ★ 为什么需要归一化：dsh 把整棵 profile 树挂在 `id: include` 的根条目下，于是真机上的
 * 条目 id 长这样：`include:switchboard` / `include:hmr` / `include:timer`。
 * 而人在候选装配里写的（也就在 `cordis.patch.yml` 里写的）是 `switchboard`。
 * 若不归一，清单与实测会在**同一个东西**上对不上，判据变成假红。
 *
 * 只剥一层 `include:`：更深的 `a:b:c` 是**真实分组结构**，剥多了会让不同的东西同形
 * （那正是判据最怕的"分不清"）。同时保留 `rawId` 供取证。
 */
function normalizeEntryId(id: string): string {
  return id.startsWith('include:') ? id.slice('include:'.length) : id
}

/**
 * 在**本进程**里清点活实例，产出 wire 契约 `LiveInventory`。
 *
 * 三个读数各自独立 try/catch：一个服务查询抛错**不得**带走另外两个读数，
 * 但也**不得**静默——它在 `unavailable` 里留下可分辨的标记（"观测不到"≠"没有"）。
 */
export function collectInventory(src: InventorySources): LiveInventory {
  const unavailable: Record<string, string> = {}

  // ── plugins：Loader 条目（跳过 group 行 —— 它们是结构容器，不是插件） ──
  const plugins: LiveInventory['plugins'] = []
  if (!src.loader || typeof src.loader.entries !== 'function') {
    unavailable.plugins = 'service-unavailable'
  } else {
    try {
      for (const entry of src.loader.entries()) {
        if (entry?.options?.group) continue
        const rawId = nameOf(entry?.id)
        if (!rawId) continue
        const st = entry?.fiber?.state
        const item: LiveInventory['plugins'][number] = {
          id: normalizeEntryId(rawId),
          module: nameOf(entry?.options?.name),
          enabled: entry?.disabled !== true,
          phase: typeof st === 'number' ? (FIBER_PHASE[st] ?? null) : null,
        }
        if (item.id !== rawId) item.rawId = rawId
        plugins.push(item)
      }
    } catch (e) {
      unavailable.plugins = 'entries-threw: ' + (e instanceof Error ? e.message : String(e))
    }
  }

  // ── tools：模型面可见工具表（这就是"工具面"的实测来源） ──
  let tools: string[] = []
  if (!src.tools || typeof src.tools.schemas !== 'function') {
    unavailable.tools = 'service-unavailable'
  } else {
    try {
      tools = src.tools
        .schemas()
        .map((s) => nameOf(s?.name))
        .filter(Boolean)
        .sort()
    } catch (e) {
      unavailable.tools = 'schemas-threw: ' + (e instanceof Error ? e.message : String(e))
    }
  }

  // ── commands：host 命令注册表 ──
  let commands: string[] = []
  if (!src.commands || typeof src.commands.list !== 'function') {
    unavailable.commands = 'service-unavailable'
  } else {
    try {
      // list(agent?)：不传 agent = 全局可见集（scoped 定义不在此列，这正是我们要的"全局注册"面）。
      commands = src.commands
        .list()
        .map((c) => nameOf(c?.name))
        .filter(Boolean)
        .sort()
    } catch (e) {
      unavailable.commands = 'list-threw: ' + (e instanceof Error ? e.message : String(e))
    }
  }

  const out: LiveInventory = {
    gen: src.gen,
    mode: src.mode,
    plugins,
    tools,
    commands,
    at: src.now ?? Date.now(),
  }
  if (Object.keys(unavailable).length > 0) out.unavailable = unavailable
  if (src.build) out.build = src.build
  return out
}
