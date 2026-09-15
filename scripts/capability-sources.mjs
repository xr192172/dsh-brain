/**
 * capability-sources.mjs —— 外部能力源（MCP server / 工具插件）的**共享**描述与扫描
 *
 * 为什么要抽成共享模块：这个扫描**曾经有两个副本**，而且副本还是**过期**的。
 *
 *   旧版 `capability-registry.mjs` 里的 `scanMcpSource` 用正则去源码里找
 *   `{ name: '...' }` 与 `id: '...'` —— 那是 design-canvas 2026-09-14 改造**之前**的格式。
 *   改造后「工具集合由注册表 `TOOL_DEFS` 运行时派生、人工只维护 `LANE_OF` 归属」，
 *   于是旧正则必然失效，并把「67 个工具全部未归线」这种**假漂移**报出来。
 *
 *   ★ 假漂移比不报更坏：它骗人去修一个不存在的问题，还会让人不再信任这个检查。
 *
 * 现在只有**一份**实现，且与 `scripts/diff-dc-capability-map.mjs` 走**同一条权威路径**：
 *   import 编译产物 → `validateLanes` / `buildLanes` → 取 unassigned / stale。
 *   注册表（数据层）与注册门（判据层）都从这里取，不可能再漂移。
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * 外部能力源登记表。
 *
 * 为什么必须登记它们：**模型手里大部分工具来自 MCP** —— design-canvas 一家就 60+ 个。
 * 只登记 subagent provider 的能力库，给模型的是**半个答案**。
 *
 * 而且 design-canvas 自带 `capability_map`（6 条能力线 / direct 直调白名单），
 * **它已经在做工具层的能力导航** ⇒ 我们**对接而不是重复造**：
 *   · 我们的 `list_capabilities` 给**跨源总览**（委派能力 + 工具能力源）
 *   · 它的 `capability_map` 给它自己**内部的线级导航**
 *   · 桥接：总览里点名"design-canvas：6 条能力线，细节调 capability_map"
 */
export const MCP_SOURCES = [
  {
    id: 'design-canvas',
    kind: 'mcp-server',
    label: '设计画布（人机共享可视化 MCP：DSL → 自包含 HTML）',
    repo: 'D:/project_develop/design-canvas',
    entry: 'D:/project_develop/design-canvas/dist/src/server.js',
    // ★ 扫描走**编译产物**（真注册表），不解析源码文本 —— 源码副本/包装层都不算数。
    regEntry: 'D:/project_develop/design-canvas/dist/src/server_registry.js',
    cmEntry: 'D:/project_develop/design-canvas/dist/src/tools/capability_map.js',
    // 仅作人读参考（旧版正则扫的就是这两个 .ts，已废弃）
    registryFile: 'src/server_registry.ts',
    laneFile: 'src/tools/capability_map.ts',
    navTool: 'capability_map',
    transport: 'stdio',
    /**
     * ★ 工具层能力源也要声明 L1 不变量（P3：验收对象必须含 `kind: mcp-server`）。
     * 诚实的值：本地 stdio 子进程、不走凭据；有 edit_code/rename_files 等写工具
     * ⇒ writeScope = workspace（不是 production）。
     */
    invariants: { role: 'provider', writeScope: 'workspace', credentials: 'none', budget: { source: 'none', maxTokens: null } },
  },
]

/** 按 id 取能力源描述。 */
export const mcpSourceById = (id) => MCP_SOURCES.find((m) => m.id === id) ?? null

/**
 * 扫一个 MCP 源的「工具面」：实际注册的工具 + 能力线目录 + 漂移。
 *
 * 异步：需要 `await import()`。调用方（registry / gate）均在 ESM 顶层，可直接 await。
 */
export async function scanMcpSource(m) {
  const out = {
    mode: 'derived-from-TOOL_DEFS',
    toolCount: 0,
    laneCount: 0,
    lanes: [],
    laneToolCount: 0,
    directCount: 0,
    drift: null,
    scannedAt: new Date().toISOString(),
  }
  try {
    if (!m?.regEntry || !m?.cmEntry) throw new Error('能力源未声明 regEntry / cmEntry')
    if (!fs.existsSync(m.regEntry) || !fs.existsSync(m.cmEntry)) {
      throw new Error(`找不到编译产物（先在 design-canvas 里 build）：${m.regEntry}`)
    }
    const reg = await import(pathToFileURL(m.regEntry).href)
    const cm = await import(pathToFileURL(m.cmEntry).href)
    const catalog = reg.TOOL_DEFS.map((d) => ({ name: d.name, title: d.title, description: d.description }))
    const errors = typeof cm.validateLanes === 'function' ? cm.validateLanes(catalog) : []
    const { lanes, unassigned, stale } = cm.buildLanes(catalog)

    out.toolCount = reg.TOOL_DEFS.length
    out.laneCount = lanes.length
    out.lanes = lanes.map((l) => l.id)
    out.laneToolCount = lanes.reduce((n, l) => n + l.tools.length, 0)
    out.directCount = new Set(lanes.flatMap((l) => l.direct)).size
    out.drift = {
      // 已注册但没进任何线 —— 靠 capability_map 导航的 agent 看不见它们
      registeredNotInLanes: (unassigned ?? []).map((t) => t.name).sort(),
      // 线里写了但没注册 —— 陈旧条目，会把 agent 指向不存在的工具
      inLanesNotRegistered: stale ?? [],
      exempt: [],
    }
    if (errors.length) out.laneErrors = errors
  } catch (e) {
    out.error = e.message
  }
  return out
}
