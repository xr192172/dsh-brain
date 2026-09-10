/**
 * design-canvas-bridge — design-canvas 原生接入桥（@dsh-brain/design-canvas-bridge）。
 *
 * 分工：
 *   - MCP 承载：DSH 原生 @deepseek-ai/dsh-mcp-client 以 stdio 连 design-canvas，
 *     把 55 个工具注册到 ctx.tools，命名空间 `mcp__<serverName>__<rawName>`
 *     （如 `mcp__design-canvas__import_project` / `explore_code` / `impact_analysis`）。
 *   - 本插件：在用户“选中/新建工作区”时，自动调用 `import_project` 对工作区做
 *     前置解析 —— tree-sitter 建立符号/import/调用边/类型引用索引并持久化 DSL，
 *     之后 explore_code / find_references / impact_analysis 等直接走已建索引（AST 前置工作）。
 *
 * 触发点：包一层 `ctx.workspaceRegistry.create(path, title)`。工作区建立即取
 * `workspace.path`（realpath 规范路径）→ 预热 import_project。按规范路径去重 + 在途合并，
 * 不阻塞 create 返回；工具未就绪（mcp-client 尚未连上）时静默跳过、不抛错。
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import v8 from 'node:v8'
import { pathToFileURL } from 'node:url'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
// 触发 @deepseek-ai/dsh-tools 的 Context.tools 声明合并（纯类型，无运行时副作用）
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'

let callSeq = 0

// ── 内存观测：memory_observe 的跨调用状态（单进程内，本插件所在 gen 进程）──
// 多次 LLM 工具调用之间需要记住基线，才能做"前次调用 → 本次调用"的内存增长/泄漏判定。
interface MemorySample {
  t: number
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
}
/** 进程级内存基线（key='default'；单进程场景足够）。 */
const memoryBase = new Map<string, MemorySample>()
/** 当前进程是否可强制 GC（需 gen 启动时带 --expose-gc；缺省不可）。 */
function canForceGc(): boolean {
  return typeof (globalThis as { gc?: unknown }).gc === 'function'
}

export const name = 'design-canvas-bridge'
// 顶层声明这两个关节：apply 时已就绪；mcp-client 的 ToolRuntime 同属 ctx.tools，
// 但其工具注册是异步的，故预热前仍需 get() 判在。
export const inject: string[] = ['workspaceRegistry', 'tools']

export interface Config {
  /** 总开关。 */
  enabled: boolean
  /** mcp-client 实例的 serverName（与它的 StdioConfig.serverName 一致，决定 mcp__<serverName>__ 前缀）。 */
  serverName: string
  /** import_project.max_files：默认 300，防大项目失控。 */
  maxFiles: number
  /** 是否索引测试文件（默认 false，测试通常是架构噪声）。 */
  includeTests: boolean
  /** 是否索引归档/历史目录（默认 false）。 */
  includeArchive: boolean
  /** 设计模式：聚合文件到目录层级而非每个文件一个节点（默认 false）。 */
  designMode: boolean
  /**
   * 深度注入的内核仓库根目录（含 dist/src/tools/）。非空则启用 `symbol_edit`
   * 复合工具：本进程直接 `import` design-canvas 内核的 editCode / findReferences
   * 纯函数串联（不走 stdio MCP 子进程）。这也绕开了"工具内再 execute 其它 MCP
   * 工具"的嵌套调度问题——深度注入没有经 ctx.tools 的二次工具调用。
   */
  kernelDir: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  serverName: z.string().default('design-canvas'),
  maxFiles: z.number().int().min(1).max(10000).default(300),
  includeTests: z.boolean().default(false),
  includeArchive: z.boolean().default(false),
  designMode: z.boolean().default(false),
  kernelDir: z.string().default(''),
})

/** 从规范路径取一个 import_project 可用的 feature 名（只允许 [a-zA-Z0-9_-]）。 */
function featureNameFrom(canonicalPath: string): string {
  const base = canonicalPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'ws'
  const feat = base.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return feat || 'ws'
}

/**
 * 预热一次工作区：去重 + 在途合并。工具未注册（MCP 还没连上）时静默跳过，
 * import_project 失败记录日志但不外抛（create 链不能被预热拖垮）。
 */
function warm(ctx: Context, inFlight: Set<string>, imported: Set<string>, toolName: string, canonicalPath: string, config: Config): void {
  if (!config.enabled) return
  if (imported.has(canonicalPath) || inFlight.has(canonicalPath)) return
  if (!ctx.tools.get(toolName)) {
    console.log(`[design-canvas-bridge] '${toolName}' 尚未就绪，跳过 ${canonicalPath} 预热（mcp-client 连接中？）`)
    return
  }
  const feature = featureNameFrom(canonicalPath)
  inFlight.add(canonicalPath)
  const run = ctx.tools
    .execute({
      name: toolName,
      callId: CallId(`ws-prewarm-${++callSeq}-${Date.now()}`),
      arguments: {
        project_dir: canonicalPath,
        feature,
        max_files: config.maxFiles,
        include_tests: config.includeTests,
        include_archive: config.includeArchive,
        ...(config.designMode ? { design_mode: true } : {}),
      },
      signal: new AbortController().signal,
    })
    .then(() => {
      imported.add(canonicalPath)
      console.log(`[design-canvas-bridge] 已预热 ${canonicalPath} -> feature "${feature}"`)
    })
    .catch((err: unknown) => {
      console.log(`[design-canvas-bridge] 预热失败 ${canonicalPath}: ${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => inFlight.delete(canonicalPath))
  // 不 await：预热是后台工作，不阻塞 create。run 内部的 catch 已吞掉错误。
  void run
}

interface ReferenceFileLite {
  file: string
  refs: Array<{ offset: number; line: number; kind?: string }>
}
interface FoundRefsLite {
  ok: boolean
  symbol?: string
  importerCount?: number
  importers?: ReferenceFileLite[]
  blocked?: string[]
}
interface EditResultLite {
  message: string
}
interface RenameSymbolsResultLite {
  ok: boolean
  dryRun?: boolean
  filesWritten?: number
  literalFilesWritten?: number
  blocked?: string[]
  previews?: Array<{ index: number; ok: boolean; blocked?: string[]; result?: { symbol?: string; to?: string; importers?: Array<{ file: string; edits: number; note?: string }>; definition?: { file: string; edits: number } } }>
  applied?: Array<{ index: number }>
  literals?: Array<{ index: number; item?: { symbol?: string; to?: string }; needle: string; toSnake: string; matches: Array<{ file: string; line: number; snippet: string; decision?: string }> }>
  externalRefs?: Array<{ fromAbs: string; source: string; resolved: string }>
}
interface MoveSymbolResultLite {
  ok: boolean
  symbol?: string
  to_file?: string
  filesWritten?: number
  dryRun?: boolean
  source?: { file: string; removed?: string[]; startLine?: number; endLine?: number }
  target?: { file: string; created?: boolean; symbol?: string }
  redirects?: Array<{ file: string; oldSource: string; newSource: string; symbol: string }>
  affectedFiles?: string[]
  blocked?: string[]
  externalRefs?: Array<{ fromAbs: string; source: string; resolved: string }>
  toSymbolDeferred?: boolean
}

interface KernelModule {
  editCode: (args: Record<string, unknown>) => Promise<EditResultLite>
  findReferences: (args: Record<string, unknown>) => Promise<FoundRefsLite>
  renameSymbols: (args: Record<string, unknown>) => Promise<RenameSymbolsResultLite>
  moveSymbol: (args: Record<string, unknown>) => Promise<MoveSymbolResultLite>
}

/** 动态加载 design-canvas 内核（进程内，非 stdio 子进程）。失败即抛，由调用方兜底。 */
async function loadKernel(kernelDir: string): Promise<KernelModule> {
  const toolsDir = path.join(kernelDir, 'dist', 'src', 'tools')
  const ec = (await import(pathToFileURL(path.join(toolsDir, 'edit_code.js')).href)) as {
    editCode: KernelModule['editCode']
  }
  const fr = (await import(pathToFileURL(path.join(toolsDir, 'find_references.js')).href)) as {
    findReferences: KernelModule['findReferences']
  }
  const rs = (await import(pathToFileURL(path.join(toolsDir, 'rename_symbols.js')).href)) as {
    renameSymbols: KernelModule['renameSymbols']
  }
  const sm = (await import(pathToFileURL(path.join(toolsDir, 'symbol_move.js')).href)) as {
    moveSymbol: KernelModule['moveSymbol']
  }
  return { editCode: ec.editCode, findReferences: fr.findReferences, renameSymbols: rs.renameSymbols, moveSymbol: sm.moveSymbol }
}

function shortErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > 200 ? `${m.slice(0, 200)}…` : m
}

/** 读项目 cache.db 的索引规模（文件/符号/边/导入数）；未预热返回 null。 */
function indexCounts(projectDir: string): { files: number; nodes: number; edges: number; imports: number } | null {
  try {
    const p = path.join(projectDir, '.design-canvas', 'cache.db')
    if (!fs.existsSync(p)) return null
    const db = new DatabaseSync(p, { readOnly: true })
    const count = (t: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c?: number | null } | undefined
      return Number(row?.c ?? 0)
    }
    const r = { files: count('files'), nodes: count('nodes'), edges: count('edges'), imports: count('imports') }
    try { db.close() } catch { /* ignore */ }
    return r
  } catch {
    return null
  }
}

/** 目标文件是否已进入目标项目的符号/import 索引（cache.db files 表）。未索引时跑
 *  find_references 会 fallback 对全依赖闭包即时解析——未预热大仓极慢，这里据此降级。 */
function isFileIndexed(projectDir: string, file?: string): boolean {
  if (!file) return false
  try {
    const abs = path.isAbsolute(file) ? file : path.resolve(projectDir, file)
    const rel = path.relative(projectDir, abs).split(path.sep).join('/')
    const dbPath = path.join(projectDir, '.design-canvas', 'cache.db')
    if (!fs.existsSync(dbPath)) return false
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT path FROM files WHERE path = ?').get(rel) as { path?: string } | undefined
      return !!row
    } finally {
      try { db.close() } catch { /* ignore */ }
    }
  } catch {
    return false
  }
}

export function apply(ctx: Context, config: Config): void {
  // 自进化·实验脑：允许逐 gen 用 env 覆盖内核目录（加载改动后的独立内核产物），不污染共享内核。
  // switchboard 可用 GEN_ENV_EXTRA 只给某个（实验）gen 注入 DESIGN_CANVAS_KERNEL_DIR=<独立 dist>。
  if (process.env.DESIGN_CANVAS_KERNEL_DIR) {
    config.kernelDir = process.env.DESIGN_CANVAS_KERNEL_DIR
  }
  const importToolName = `mcp__${config.serverName}__import_project`
  const capMapToolName = `mcp__${config.serverName}__capability_map`
  console.log(`[design-canvas-bridge] config: serverName=${config.serverName} kernelDir=${JSON.stringify(config.kernelDir)} enabled=${config.enabled}`)
  const imported = new Set<string>()
  const inFlight = new Set<string>()
  // 记录已索引的项目（feature → 状态），供轻量工具按需返回，不把 AST 全量回灌模型上下文。
  const indexedFeatures = new Map<string, { projectDir: string; feature: string; importedAt: number }>()

  // 拦截工作区建立：选中/新建工作区即触发 AST + 符号索引前置。
  const registry = ctx.workspaceRegistry as WorkspaceRegistryLike
  const originalCreate = registry.create.bind(registry)
  registry.create = (async (path: string, title?: string): Promise<Workspace> => {
    const workspace = await originalCreate(path, title)
    const feature = featureNameFrom(workspace.path)
    warm(ctx, inFlight, imported, importToolName, workspace.path, config)
    indexedFeatures.set(feature, { projectDir: workspace.path, feature, importedAt: Date.now() })
    return workspace
  }) as never

  // 轻量工具：design_canvas_index —— 返回"已索引工作区 + 能力线导航地图（capability_map）"，head 截断，
  // 让模型先看地图再挑具体工具精查，而非反复 import_project 全量；对标"索引先行 + 按需精取"。
  ctx.tools.register(defineTool({
    name: 'design_canvas_index',
    description:
      '查询所有已被 design-canvas 预热/索引完成的工作区，以及 design-canvas 全量能力线和工具导航地图（轻量、按需），用于在需要符号/关系检索前先定位该用哪个工具。',
    parameters: {
      lane: {
        type: 'string',
        description: '可选：只取某条能力线（design/refactor/observe/harvest/cross/meta），不传返回全量地图',
      },
    },
    output: {
      schema: { type: 'string', description: '精简文本：索引状态 + 能力地图（超 4096 字符会头部截断）' },
      render: (_args, value) => [{ type: 'text' as const, text: value }],
    },
    async execute(args) {
      const lane = args.lane
      const featureList = Array.from(indexedFeatures.values())
        .map((v) => `  - ${v.feature} -> \`${v.projectDir}\``)
        .join('\n')
      const header = `### Design Canvas 索引状态\n\n已预热索引的工作区：\n${featureList || '  (暂无，选中/新建工作区后自动预热)'}\n\n### 能力导航地图\n\n`

      if (!ctx.tools.get(capMapToolName)) {
        return `${header}[design-canvas-bridge] capability_map 工具未就绪（MCP server 未启动/连接中），请稍后重试。`
      }
      const capResult = (await ctx.tools.execute({
        name: capMapToolName,
        callId: CallId(`capmap-index-${Date.now()}`),
        arguments: lane ? { lane } : {},
        signal: new AbortController().signal,
      })) as unknown as { content?: { type?: string; text?: string }[] }
      const mapText = capResult?.content?.[0]?.text ?? '(capability_map 无返回)'
      const full = header + mapText
      return full.length > 4096 ? full.slice(0, 4096) + '\n...(尾部截断；按需传 lane 精查单条能力线)' : full
    },
  }))

  // ── 深度注入 / 精准编辑（symbol_edit）──────────────────────────────────────
  // 探针与 V1 合一：不走 stdio MCP 子进程，而是本进程动态 `import` design-canvas
  // 内核的 editCode / findReferences 纯函数直接串联（见 loadKernel）。因此不存在
  // "工具内再 ctx.tools.execute 其它 MCP 工具"的嵌套调度坑——深度注入天然绕开。
  // 不引内嵌 LLM：模型先给出结构化 file/op/symbol/code，工具负责"影响面→精准落盘→回报"。
  // 命名：用 symbol_edit（而非 design_canvas_edit），不与原生 edit_code/edit_dsl 混淆，
  // 也契合"基础 AST 解析层 + 自动编排能力"的定位。
  if (config.kernelDir) {
    const editEntry = path.join(config.kernelDir, 'dist', 'src', 'tools', 'edit_code.js')
    const kernelReady = fs.existsSync(editEntry)
    if (kernelReady) {
      ctx.tools.register(defineTool({
        name: 'symbol_edit',
        description:
          '符号级精准编辑（编排壳）：按 文件+符号名 定位 AST 边界后 replace/insert/delete/range，' +
          '或按唯一文本 replace_text（edit 工具的安全版）。先算影响面（find_references 引用摘要，仅索引内符号），' +
          '再精准落盘（edit_code 自带 re-parse 语法门 + 同名消歧，replace 要求新代码解析出同名符号防粘贴错函数），' +
          '最后精简回报。不信行号/old_string（replace_text 除外，它要求 old_text 在文件内恰好唯一）。' +
          'Op 选择指引：日常单行/小段修改用 replace_text（给文本就改，带唯一性门 + 语法门）；' +
          '改函数/方法体用 replace+sub="body"（免自包含、自动缩进）；新增用 insert、删除用 delete；' +
          '大改/多行用 range（start/end + code，精确行区间）。不要裸用 range 去改函数体（手写缩进易错）。' +
          '注意：dry_run 对所有 op 生效（只预览 diff + 语法门，不写盘）；replace（整符号）的 code 必须自包含（只含目标符号本身定义，' +
          '不要重复定义文件内已有的类型/函数，否则报重复定义——复杂修改请用 sub="body" 或 range 或 replace_text）。',
        parameters: {
          project_dir: { type: 'string', description: '项目根目录（缺省取最近已预热工作区）' },
          file: { type: 'string', description: '目标文件（相对 project_dir 或绝对路径）' },
          op: {
            type: 'string',
            enum: ['replace', 'insert', 'delete', 'range', 'replace_text'],
            description: '小改用 replace_text(old_text/new_text)；改函数体用 replace+sub=body(code 给新 body)；replace=替换整符号(symbol+code, code 须自包含)；insert=插入新符号(code 必填, symbol 可选锚点)；delete=删除符号(symbol 必填)；range=显式行区间(start/end+code)',
          },
          symbol: { type: 'string', description: '目标符号：replace/delete 必填（qualified_name 优先，短名兜底）；insert 可选锚点；range/replace_text 不需要' },
          parent: { type: 'string', description: '符号父级（类名 / Go receiver 类型名），同名消歧' },
          sub: { type: 'string', enum: ['body'], description: 'replace 专用：body=只替换函数/方法体（code 只给新函数体内容含大括号，签名与大括号保留，引用外部符号无需自包含）' },
          code: { type: 'string', description: 'replace/insert 的新代码（完整符号定义，自包含）；replace+sub=body 时=新函数体（含大括号）；range=区间新内容（空串=删除区间）' },
          old_text: { type: 'string', description: 'replace_text 专用：要替换的旧文本（须在文件中恰好出现 1 次，否则报歧义）' },
          new_text: { type: 'string', description: 'replace_text 专用：替换后的新文本（空串=删除该文本）' },
          start: { type: 'integer', description: 'range 专用：1-based 含端点起始行' },
          end: { type: 'integer', description: 'range 专用：1-based 含端点结束行' },
          dry_run: { type: 'boolean', description: '所有 op 支持：true=只出 diff 预览 + 语法门结果，不写盘、不改索引' },
          preflight: { type: 'boolean', description: '编辑前是否先算 find_references 影响面（默认 true，仅 symbol 存在时）' },
          quiet_overlap: { type: 'boolean', description: 'range 专用：true=区间穿透只报符号计数、不展开明细列表（减少视觉噪声）' },
        },
        output: {
          schema: { type: 'string', description: '精简文本：影响面摘要 + 编辑结果（超 4096 字符头部截断）' },
          render: (_args, value) => [{ type: 'text' as const, text: value }],
        },
        async execute(args) {
          try {
            const projectDir =
              args.project_dir ??
              (() => {
                const list = Array.from(indexedFeatures.values())
                return list.length > 0 ? list[list.length - 1].projectDir : null
              })()
            if (!projectDir) {
              return 'project_dir 未指定，且当前无已预热工作区。请先选中/新建工作区（自动预热），或显式传 project_dir。'
            }
            // dry_run 由内核统一处理（所有 op 均支持，只预览不写盘）。
            const kernel = await loadKernel(config.kernelDir)
            const lines: string[] = []
            console.log(`[dsb-edit] call project=${projectDir} file=${args.file ?? ''} op=${args.op ?? ''} symbol=${args.symbol ?? ''} preflight=${args.preflight !== false}`)

            // 第一步：影响面（find_references），只读；失败不阻断编辑。
            // 智能降级：仅当目标文件已在目标项目的索引(cache.db)中才跑影响面——否则其 fallback
            // 即时展开全依赖闭包，对未预热大仓会拖死编辑。未索引则跳过并提示，编辑仍进行。
            if (args.preflight !== false && args.symbol) {
              if (isFileIndexed(projectDir, args.file)) {
                try {
                  const refs = await kernel.findReferences({ project_dir: projectDir, file: args.file, symbol: args.symbol })
                  if (refs.ok) {
                    const imp = (refs.importers ?? [])
                      .slice(0, 6)
                      .map((i) => `${i.file}[${i.refs.length}]`)
                      .join(', ')
                    if ((refs.importerCount ?? 0) === 0) {
                      lines.push(`● 影响面(${refs.symbol ?? args.symbol}): 未发现引用者（若项目索引不完整，可先对该项目 import_project 全量预热后再算）`)
                    } else {
                      lines.push(`● 影响面(${refs.symbol ?? args.symbol}): importer ${refs.importerCount} 处${imp ? ` · ${imp}` : ''}`)
                    }
                  } else {
                    lines.push(`● 影响面: ${(refs.blocked ?? ['无引用信息']).join('; ')}`)
                  }
                } catch (e) {
                  lines.push(`● 影响面: 计算失败(${shortErr(e)})，继续编辑`)
                }
              } else {
                lines.push(`● 影响面: 目标文件尚未被索引，已跳过（可先对该项目 import_project 预热后再算影响面）`)
                console.log(`[dsb-edit] impact SKIPPED（未索引） file=${args.file ?? ''}`)
              }
            }

            // 第二步：精准落盘（edit_code，AST 定位 + 语法门，失败会拒绝写盘）。
            const res = await kernel.editCode({
              project_dir: projectDir,
              file: args.file,
              op: args.op,
              symbol: args.symbol,
              parent: args.parent,
              code: args.code,
              start: args.start,
              end: args.end,
              dry_run: args.dry_run,
              quiet: args.quiet_overlap === true,
              old_text: args.old_text,
              new_text: args.new_text,
              sub: args.sub,
            })
            lines.push(res.message)

            const out = lines.join('\n')
            console.log(`[dsb-edit] done op=${args.op ?? ''} result=${out.length} chars`)
            return out.length > 4096 ? `${out.slice(0, 4096)}\n...（尾部截断）` : out
          } catch (e) {
            // 编辑失败下放 friendly error（不带 isError 崩溃），并给针对性指引。
            const msg = shortErr(e)
            let hint = ''
            if (/重复的顶层符号|重复定义/.test(msg)) {
              hint = ' 提示：replace 的 code 必须自包含——只含目标符号本身定义，不要重复定义文件内已有的类型/函数（如 Config）。若要改文件内多处，请改用 range。'
            } else if (/锚点不唯一/.test(msg)) {
              hint = ' 提示：insert 锚点存在多个同名符号，请用 parent 消歧，或改用 range 明确行区间。'
            } else if (/符号未找到|未找到/.test(msg)) {
              hint = ' 提示：确认 symbol 用 qualified_name（如 Class.method）；同名需传 parent。'
            }
            return `符号编辑未执行：${msg}${hint}（未写盘或原样返回；请核对 file/op/symbol/code 后重试）`
          }
        },
      }))
      console.log(`[design-canvas-bridge] symbol_edit 已注册（深度注入，kernelDir=${config.kernelDir}）`)

      // ── 安全重命名（safe_rename）：符号层跨文件 AST 重命名 + 文本层字面量引用一并改 ──
      // 编排壳包 renameSymbols：两点原子（任一阻断整体不落盘）；report_literals 扫描旧符号
      // snake 变体的文本命中（README/错误串/工具注册名/历史——正是"改名漏改别家标记"的痛点），
      // apply_literals 自动替换 code/docs/test 且安全跳过 contract/历史/冻结行。
      ctx.tools.register(defineTool({
        name: 'safe_rename',
        description:
          '安全符号重命名（编排壳）：改一个符号名时，先算影响面，再跨文件 AST 重命名，并把项目文本里的字面量引用' +
          '（README/错误串/工具注册名/snake 变体，即"改名常漏改的别家标记"）一并处理。默认 dry_run 先预览' +
          '（符号层将改哪些 import/usage + 文本层 auto 可改/需人审/历史保留的分组），确认后再落盘。' +
          '安全：任一处被阻断则整体不落盘；文本字面量按决策分组——code/docs/test 自动改，contract 需人审，历史与冻结行保留。',
        parameters: {
          project_dir: { type: 'string', description: '项目根目录（缺省取最近已预热工作区）' },
          file: { type: 'string', description: '定义符号的文件（相对 project_dir 或绝对路径），必填' },
          symbol: { type: 'string', description: '旧符号名（模块级声明名/被 import 的远程名），必填' },
          to: { type: 'string', description: '新符号名（合法标识符），必填' },
          rename_file_if_matching: { type: 'boolean', description: 'true=符号是文件主导出(文件名=符号名)时联动改文件名' },
          dry_run: { type: 'boolean', description: 'true(默认)=只预览符号层+文本层决策，不落盘；false=确认真执行（含文本层 apply_literals 自动改）' },
          apply_literals: { type: 'boolean', description: 'true+dry_run=false=执行时自动替换 decision=apply 的字面量(code/docs/test)；contract 需人审、历史/冻结行保留' },
          report_literals: { type: 'boolean', description: 'true(默认)=预览/汇报里包含文本层字面量命中分组' },
        },
        output: {
          schema: { type: 'string', description: '精简文本：符号层重命名结果 + 文本层字面量分组（超 4096 字符头部截断）' },
          render: (_args, value) => [{ type: 'text' as const, text: value }],
        },
        async execute(args) {
          try {
            const projectDir =
              args.project_dir ??
              (() => {
                const list = Array.from(indexedFeatures.values())
                return list.length > 0 ? list[list.length - 1].projectDir : null
              })()
            if (!projectDir) {
              return 'project_dir 未指定，且当前无已预热工作区。请先选中/新建工作区，或显式传 project_dir。'
            }
            if (!args.file || !args.symbol || !args.to) {
              return 'safe_rename 需要 file（定义文件）、symbol（旧名）、to（新名）。'
            }
            // 未预热拦截：rename 需完整 import 闭包才保证不漏改；未预热时全仓即时扫描
            // 会把整个项目解析常驻内存并卡死事件循环（已实测单进程升至 10GB）。定义文件不在
            // 索引 → 拒绝执行，显式要求先 prewarm，从源头杜绝全仓扫描。
            if (!isFileIndexed(projectDir, args.file)) {
              console.log(`[dsb-rename] 未预热拦截 project=${projectDir} file=${args.file}`)
              return '该项目未完整预热（符号/import 索引不完整）。为避免对全仓即时扫描导致卡顿与内存暴涨，本次未执行。请先调 design_canvas_prewarm({ "project_dir": <根路径> }) 建立索引后重试。'
            }
            const kernel = await loadKernel(config.kernelDir)
            const dryRun = args.dry_run !== false // 默认安全预览
            const wantLiteral = args.report_literals !== false
            console.log(`[dsb-rename] call project=${projectDir} file=${args.file} symbol=${args.symbol} to=${args.to} dry=${dryRun}`)

            const res = await kernel.renameSymbols({
              project_dir: projectDir,
              renames: [{ file: args.file, symbol: args.symbol, to: args.to, rename_file_if_matching: args.rename_file_if_matching === true }],
              dry_run: dryRun,
              report_literals: wantLiteral,
              apply_literals: !dryRun && args.apply_literals === true,
            })

            if (!res.ok) {
              return `重命名未执行（${(res.blocked ?? []).join('; ') || '未知原因'}），本次未落盘。`
            }

            const lines: string[] = []
            // 符号层
            if (dryRun || res.dryRun) {
              const def = res.previews?.[0]?.result?.definition
              const imps = res.previews?.[0]?.result?.importers ?? []
              lines.push(`● 符号层预览: 定义文件${def ? ` ${def.file}（${def.edits} 处）` : ''}，import/usage 影响 ${imps.length} 个文件`)
              for (const i of imps.slice(0, 10)) lines.push(`   - ${i.file}: ${i.edits} 处${i.note ? ` · ${i.note}` : ''}`)
            } else {
              lines.push(`● 符号层: 已重命名 ${args.symbol} → ${args.to}，写入 ${res.filesWritten ?? 0} 个文件`)
            }
            // 文本层（字面量）
            if (wantLiteral && res.literals && res.literals.length > 0) {
              const byDecision = new Map<string, number>()
              for (const l of res.literals) for (const m of l.matches ?? []) {
                const d = m.decision ?? '未知'
                byDecision.set(d, (byDecision.get(d) ?? 0) + 1)
              }
              const parts = Array.from(byDecision.entries()).map(([d, n]) => `${d}=${n} 处`).join('，')
              lines.push(`● 文本层字面量: ${parts}${!dryRun ? `（已写盘 ${res.literalFilesWritten ?? 0} 个文件）` : ''}`)
              for (const l of res.literals) {
                const show = (l.matches ?? []).slice(0, 8)
                if (show.length === 0) continue
                lines.push(`   "${l.needle}" → "${l.toSnake}":`)
                for (const m of show) lines.push(`     [${m.decision ?? '?'}] ${m.file}:${m.line} ${(m.snippet ?? '').slice(0, 60)}`)
              }
            } else if (wantLiteral) {
              lines.push('● 文本层字面量: 未发现字符串/文档引用')
            }
            // 项目边界（不追外）：本工作区内 import 解析到工作区外的引用——只提示去向，不落盘外部仓库
            if (res.externalRefs && res.externalRefs.length > 0) {
              lines.push(`● 项目边界（不追外）: ${res.externalRefs.length} 处 import 解析到工作区外，未改动外部`)
              for (const e of res.externalRefs.slice(0, 8)) {
                const shown = e.resolved ? (e.resolved.includes(projectDir) ? e.resolved.slice(projectDir.length + 1) : e.resolved) : e.source
                lines.push(`   - ${shown}${e.source ? `（import ${e.source}）` : ''}`)
              }
              if (res.externalRefs.length > 8) lines.push(`   … 其余 ${res.externalRefs.length - 8} 处略`)
              lines.push('   （如需联动处理这些外部引用，请在对应外部仓库上单独发起 rename）')
            }

            console.log(`[dsb-rename] done dry=${dryRun} files=${res.filesWritten ?? 0} literals=${res.literalFilesWritten ?? 0}`)
            if (dryRun) lines.push('（以上为预览，未写盘；确认后请以 dry_run:false 重放执行）')
            const joined = lines.join('\n')
            return joined.length > 4096 ? `${joined.slice(0, 4096)}\n...（尾部截断）` : joined
          } catch (e) {
            return `重命名未执行：${shortErr(e)}（本次未落盘；请核对 file/symbol/to 后重试，to 须为合法标识符）`
          }
        },
      }))
      console.log(`[design-canvas-bridge] safe_rename 已注册（深度注入，kernelDir=${config.kernelDir}）`)

      ctx.tools.register(defineTool({
        name: 'move_symbol',
        description:
          '跨文件移动模块级符号（语义重构）：把 file 里的模块级符号 symbol 搬到 to_file，' +
          '并自动把工作区内所有「仅引入该符号」的 import 目标从源文件重定向到 to_file；' +
          '导入到工作区外（外部仓库）的引用只反馈不追外。目标撞名 / namespace import / ' +
          'export * 转发 / 一条 import 混入其它符号 → 整体不落盘并说明。缺省安全预览，' +
          'dry_run:false 才真正写盘。v1 仅 TS/JS 模块级符号，to_symbol 改名未启用。',
        parameters: {
          project_dir: { type: 'string', description: '目标项目根目录（相对/绝对均可定位文件）' },
          file: { type: 'string', description: '定义符号的源文件' },
          symbol: { type: 'string', description: '要移动的模块级符号名' },
          to_file: { type: 'string', description: '目标文件（不存在则创建；仅 TS/JS）' },
          to_symbol: { type: 'string', description: '可选：改名为该名（v1 未启用，仅提示）' },
          dry_run: { type: 'boolean', description: '缺省 true=只预览不落盘；false=执行' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text' as const, text: value }],
        },
        async execute(args) {
          try {
            const projectDir =
              args.project_dir ??
              (() => {
                const list = Array.from(indexedFeatures.values())
                return list.length > 0 ? list[list.length - 1].projectDir : null
              })()
            if (!projectDir) return 'move_symbol 需要 project_dir（或先选中/预热一个工作区）。'
            if (!args.file || !args.symbol || !args.to_file) return 'move_symbol 需要 file（源）、symbol（要移动的符号）、to_file（目标）。'
            // 未预热拦截：闭包找 importer 需 import 索引；无索引 fallback 全扫 root 会卡顿/爆内存
            if (!isFileIndexed(projectDir, args.file)) {
              console.log(`[dsb-move] 未预热拦截 project=${projectDir} file=${args.file}`)
              return '该项目未完整预热。为避免全仓即时扫描导致卡顿与内存暴涨，本次未执行。请先 design_canvas_prewarm({ project_dir }) 建索引后重试。'
            }
            const kernel = await loadKernel(config.kernelDir)
            const dryRun = args.dry_run !== false
            const res = await kernel.moveSymbol({
              project_dir: projectDir,
              file: args.file,
              symbol: args.symbol,
              to_file: args.to_file,
              to_symbol: args.to_symbol,
              dry_run: dryRun,
            })
            if (!res.ok) return `移动未执行（${(res.blocked ?? []).join('; ') || '未知原因'}），本次未落盘。`
            const lines: string[] = []
            if (res.source) {
              lines.push(`● 源文件删除 ${res.source.file}（L${res.source.startLine}-${res.source.endLine}）:`)
              for (const l of (res.source.removed ?? []).slice(0, 12)) lines.push(`   - ${l.trimEnd()}`)
            }
            if (res.target) lines.push(`● 目标文件 ${res.target.file}（${res.target.created ? '新建' : '追加'}）: + ${res.target.symbol ?? res.symbol}`)
            lines.push(`● import 重定向 ${res.redirects?.length ?? 0} 处（远程名/用法不变，仅 source 改向）:`)
            for (const d of (res.redirects ?? []).slice(0, 10)) lines.push(`   - ${d.file}: ${d.oldSource} → ${d.newSource}`)
            if (res.externalRefs && res.externalRefs.length > 0) {
              lines.push(`● 项目边界（不追外）: ${res.externalRefs.length} 处 import 解析到工作区外，未改动外部`)
              for (const e of res.externalRefs.slice(0, 8)) {
                const shown = e.resolved ? (e.resolved.includes(projectDir) ? e.resolved.slice(projectDir.length + 1) : e.resolved) : e.source
                lines.push(`   - ${shown}${e.source ? `（import ${e.source}）` : ''}`)
              }
            }
            if (res.toSymbolDeferred) lines.push('⚠ to_symbol 改名未启用（v1 只移动不改名），改名请走 safe_rename。')
            console.log(`[dsb-move] done dry=${dryRun} files=${res.filesWritten ?? 0} redirects=${res.redirects?.length ?? 0}`)
            if (dryRun) lines.push('（以上为预览，未写盘；确认后请以 dry_run:false 重放执行）')
            const joined = lines.join('\n')
            return joined.length > 4096 ? `${joined.slice(0, 4096)}\n...（尾部截断）` : joined
          } catch (e) {
            return `移动未执行：${shortErr(e)}（本次未落盘；请核对 file/symbol/to_file 后重试）`
          }
        },
      }))
      console.log(`[design-canvas-bridge] move_symbol 已注册（深度注入，kernelDir=${config.kernelDir}）`)
    } else {
      console.log(`[design-canvas-bridge] 深度注入跳过：内核入口缺失 ${editEntry}`)
    }
  }

  // ── 项目范围选择 + 预热工具：design_canvas_prewarm_scan ──
  // 自动扫描已知路径（workspaceDir / home/临时等）列出候选项目，
  // 供模型在调用 safe_rename/find_references 前明确选择目标目录，
  // 避免盲目预热大仓或选错目录导致卡死。
  ctx.tools.register(defineTool({
    name: 'design_canvas_prewarm_scan',
    description:
      '扫描已知路径，列出候选项目目录（含 .design-canvas 索引状态），' +
      '供模型在 safe_rename/find_references/symbol_edit 前明确选择目标。' +
      '扫描路径：workspaceDir、home 下级常见源码目录、session 工作目录。' +
      '返回格式：[{path, feature, indexed, fileCount, suggestion}]，' +
      'suggestion=ready|prewarm|empty。建议先对 suggestion=empty 的候选跑 design_canvas_prewarm。',
    parameters: {
      scan_dirs: { type: 'array', items: { type: 'string' }, description: '额外扫描目录（可选，缺省用内置启发式）' },
      max_depth: { type: 'integer', description: '扫描目录深度（缺省 3，防遍历过多）' },
    },
    output: {
      schema: { type: 'string', description: '候选项目清单 + 索引状态 + 预热建议（头部截断）' },
      render: (_args, value) => [{ type: 'text' as const, text: value }],
    },
    async execute(args) {
      try {
        const scanDirs: string[] = args.scan_dirs ?? []
        const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : 3
        // 内置启发式扫描路径
        const builtins: string[] = []
        try { builtins.push(process.env.WORKSPACE_DIR ?? '') } catch { /* ignore */ }
        try { builtins.push(process.env.HOME ?? process.env.USERPROFILE ?? '') } catch { /* ignore */ }
        try { builtins.push(process.cwd()) } catch { /* ignore */ }
        const candidates: Array<{ path: string; feature: string; indexed: boolean; fileCount: number; suggestion: string }> = []
        const seen = new Set<string>()
        const addCandidate = (p: string) => {
          const rp = path.resolve(p)
          if (seen.has(rp) || !fs.existsSync(rp)) return
          seen.add(rp)
          // 检查是否为项目根（含 .design-canvas 或 package.json/go.mod）
          const hasDS = fs.existsSync(path.join(rp, '.design-canvas'))
          const hasPM = fs.existsSync(path.join(rp, 'package.json')) || fs.existsSync(path.join(rp, 'go.mod'))
          if (!hasDS && !hasPM) return
          const idx = indexCounts(rp)
          candidates.push({
            path: rp,
            feature: featureNameFrom(rp),
            indexed: !!hasDS,
            fileCount: idx?.files ?? 0,
            suggestion: hasDS ? 'ready' : (hasPM ? 'prewarm' : 'empty'),
          })
        }
        // 扫描内置路径
        for (const d of builtins) {
          if (!d) continue
          addCandidate(d)
          // 子目录扫描（限深度）
          try {
            const entries = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'node_modules')
            for (const e of entries.slice(0, 20)) addCandidate(path.join(d, e.name))
          } catch { /* ignore */ }
        }
        // 扫描额外目录
        for (const d of scanDirs) addCandidate(d)
        if (candidates.length === 0) return '未发现候选项目（扫描路径均无 package.json/go.mod/.design-canvas）'
        const lines = ['### 候选项目目录\n']
        for (const c of candidates) {
          const tag = c.indexed ? '✅' : (c.suggestion === 'prewarm' ? '⚠️' : '❓')
          lines.push(`${tag} \`${c.path}\` (${c.fileCount} 文件) - ${c.suggestion}`)
        }
        lines.push('\n### 建议操作')
        lines.push('- 已索引候选：直接调用 safe_rename/find_references/symbol_edit')
        lines.push('- 未索引候选：先调用 design_canvas_prewarm 预热')
        return lines.join('\n').slice(0, 4096)
      } catch (e) {
        return `扫描失败：${shortErr(e)}`
      }
    },
  }))
  console.log(`[design-canvas-bridge] design_canvas_prewarm_scan 已注册`)

  // ── 显式预热工具：design_canvas_prewarm ──
  // DSH 不经 workspaceRegistry.create 建工作区（全仓无该调用），原 create 拦截的自动预热
  // 从未触发。这里把预热主动权交给工具层：模型对某仓库跑 find/rename 前，先对其 project_dir
  // 显式预热一次（import_project 全量建 AST/符号/import 索引），之后 find_references/safe_rename
  // 走索引、明显变快（未预热大仓会即时全闭包扫描、极慢）。
  ctx.tools.register(defineTool({
    name: 'design_canvas_prewarm',
    description:
      '对指定项目根目录执行 design-canvas import_project 全量建立符号/import 索引（AST 前置）。' +
      '之后 find_references / safe_rename / symbol_edit 影响面会走索引、明显变快。' +
      '未预热的大仓跑 find/rename 会即时全闭包扫描、极慢——先在动作前对该 project_dir 预热一次。',
    parameters: {
      project_dir: { type: 'string', required: true, description: '项目根目录（绝对路径）' },
      max_files: { type: 'integer', description: '最多解析文件数（缺省取插件 maxFiles，默认 500）' },
    },
    output: {
      schema: { type: 'string', description: '预热结果：索引的文件/符号/边/导入统计或失败原因' },
      render: (_args, value) => [{ type: 'text' as const, text: value }],
    },
    async execute(args) {
      try {
        const p = args.project_dir ? path.resolve(String(args.project_dir)) : ''
        if (!p) return '需要 project_dir（项目根目录绝对路径）'
        if (!ctx.tools.get(importToolName)) {
          return 'import_project 工具未就绪（design-canvas MCP 连接中/未启动），请稍后重试；depth-inject 内核不承担建索引，需经 MCP 子进程。'
        }
        const feature = featureNameFrom(p)
        console.log(`[dsb-prewarm] start ${p} feature=${feature}`)
        await ctx.tools.execute({
          name: importToolName,
          callId: CallId(`prewarm-${++callSeq}-${Date.now()}`),
          arguments: {
            project_dir: p,
            feature,
            max_files: args.max_files ?? config.maxFiles,
            include_tests: config.includeTests,
            include_archive: config.includeArchive,
            ...(config.designMode ? { design_mode: true } : {}),
          },
          signal: new AbortController().signal,
        })
        indexedFeatures.set(feature, { projectDir: p, feature, importedAt: Date.now() })
        imported.add(p)
        const counts = indexCounts(p)
        const stat = counts
          ? `索引 ${counts.files} 文件 / ${counts.nodes} 符号 / ${counts.edges} 边 / ${counts.imports} 导入`
          : '索引统计不可读'
        console.log(`[dsb-prewarm] done ${p} → ${stat}`)
        return `已预热 ${p}（feature=${feature}）：${stat}。`
      } catch (e) {
        return `预热失败：${shortErr(e)}（未建索引；若项目过大请调 max_files 或用更小目录）`
      }
    },
  }))
  console.log(`[design-canvas-bridge] design_canvas_prewarm 已注册`)

  // ── 内存观测：memory_observe（跨运行时通用的检测壳：基线→追踪→触发→快照）──
  // 思路对 GC 与非 GC 运行时通用，换的只是"驱动诊断器"那一层。在 Node/V8 下用
  // process.memoryUsage 采样 + v8.getHeapStatistics + v8.writeHeapSnapshot 落盘。
  // 四个动作一次调用覆盖：
  //   baseline → 记录起点；track → 对比基线算增长与可疑方向；
  //   gc        → 强制 GC 后重采，回落到基线=瞬时占用，仍高于基线=疑似泄漏；
  //   snapshot  → 对增长点写 heap snapshot（喂给 Chrome DevTools/heap diff 分析）。
  // 区分泄漏侧：heapUsed 涨→JS 对象堆；RSS 涨但 heapUsed 稳→external/arrayBuffers(native)。
  ctx.tools.register(defineTool({
    name: 'memory_observe',
    description:
      '内存基线/追踪/触发/快照一体化观测。动作：baseline=记基线；track=对比基线报增量与泄漏方向；' +
      'gc=强制 GC 后重采，判断是瞬时占用还是疑似泄漏；snapshot=写 V8 heap snapshot 到磁盘。' +
      '用途：内存暴涨/疑似泄漏诊断。区分侧：heapUsed 涨→JS 对象堆；RSS 涨但 heapUsed 稳→native(external/arrayBuffers)。',
    parameters: {
      project_dir: { type: 'string', description: 'heap snapshot 落盘目录的归属项目根（缺省 process.cwd）' },
      action: {
        type: 'string',
        enum: ['status', 'baseline', 'track', 'gc', 'snapshot'],
        description: 'status=仅一次性统计；baseline=记基线并返回；track=对比基线报增量；gc=强制GC后重采对比；snapshot=写heap snapshot。缺省 status',
      },
    },
    output: {
      schema: { type: 'string', description: '内存统计 / 基线 / 增量 / 泄漏判定文本' },
      render: (_args, value) => [{ type: 'text' as const, text: value }],
    },
    async execute(args) {
      const a = ((args.action ?? 'status') as string).toLowerCase()
      const mb = (b: number | undefined): number => Math.round((b ?? 0) / 1048576)
      const sample = (): MemorySample => {
        const mu = process.memoryUsage()
        return {
          t: Date.now(),
          rss: mu.rss,
          heapUsed: mu.heapUsed,
          heapTotal: mu.heapTotal,
          external: mu.external,
          arrayBuffers: mu.arrayBuffers ?? 0,
        }
      }
      const fmt = (s: MemorySample): string =>
        `t+${Math.round((s.t - t0) / 1000)}s RSS=${mb(s.rss)}MB heapTotal=${mb(s.heapTotal)}MB heapUsed=${mb(s.heapUsed)}MB external=${mb(s.external)}MB arrayBuffers=${mb(s.arrayBuffers)}MB`
      const t0 = Date.now()
      const key = 'default'
      const hs = v8.getHeapStatistics ? v8.getHeapStatistics() : undefined
      const lines: string[] = []

      if (a === 'baseline') {
        const s = sample()
        memoryBase.set(key, s)
        lines.push(`[基线已记录] ${fmt(s)}`)
        lines.push(`V8 heapSizeLimit=${mb(hs?.heap_size_limit)}MB usedHeap=${mb(hs?.used_heap_size)}MB 强制GC=${canForceGc() ? '可用' : '不可用(--expose-gc)'}`)
      } else if (a === 'track') {
        const base = memoryBase.get(key)
        if (!base) {
          lines.push('无基线，先调 action=baseline 记录起点。当前: ' + fmt(sample()))
        } else {
          const s = sample()
          const dRss = mb(s.rss - base.rss)
          const dHeap = mb(s.heapUsed - base.heapUsed)
          const dExt = mb(s.external - base.external)
          const dtSec = Math.max(1, Math.round((s.t - base.t) / 1000))
          const rate = mb((s.rss - base.rss) / dtSec)
          lines.push(fmt(s))
          lines.push(`相对基线: RSS ${dRss >= 0 ? '+' : ''}${dRss}MB  heapUsed ${dHeap >= 0 ? '+' : ''}${dHeap}MB  external ${dExt >= 0 ? '+' : ''}${dExt}MB（约 ${dtSec}s → ~${rate}MB/s）`)
          if (dHeap > 16) {
            lines.push(`判定: heapUsed 增 ${dHeap}MB → 疑似 JS 对象堆增长；可 action=gc 确认是否可回收，或 snapshot 落盘分析。`)
          } else if (dRss > 32 && dHeap <= 16) {
            lines.push(`判定: RSS 增 ${dRss}MB 但 heapUsed 平稳(${dHeap}MB) → 更可能 native/external(${dExt}MB)/arrayBuffers 侧，V8 heap snapshot 看不到，需看 external。`)
          } else if (dRss <= 16 && dHeap <= 16) {
            lines.push(`判定: 相对基线基本平稳（RSS ${dRss}MB）→ 无明显增长。`)
          } else {
            lines.push(`判定: 温和变化（RSS ${dRss}MB / heapUsed ${dHeap}MB），建议多次 track 累计观察曲线。`)
          }
        }
      } else if (a === 'gc') {
        const gc = (globalThis as { gc?: () => void }).gc
        if (!gc) {
          lines.push('当前进程未带 --expose-gc，无法强制 GC；请给 gen 启动参数加 --expose-gc 后重试。')
        } else {
          const before = sample()
          gc()
          const after = sample()
          const base = memoryBase.get(key)
          lines.push(`[强制GC] 前: ${fmt(before)}`)
          lines.push(`[强制GC] 后: ${fmt(after)}（回收 heapUsed ${mb(before.heapUsed - after.heapUsed)}MB / RSS ${mb(before.rss - after.rss)}MB）`)
          if (base && after.heapUsed > base.heapUsed + 16) {
            lines.push(`判定: GC 后 heapUsed 仍高于基线 ${mb(after.heapUsed - base.heapUsed)}MB → 疑似泄漏（被长期持有，非瞬时）。建议 snapshot 落盘用 heap diff 定位持有者。`)
          } else if (base) {
            lines.push(`判定: GC 后回落至基线附近 ${mb(after.heapUsed - base.heapUsed)}MB → 更可能是瞬时工作负载，非泄漏。`)
          } else {
            lines.push('无基线对比；请先 action=baseline。')
          }
        }
      } else if (a === 'snapshot') {
        const now = sample()
        lines.push(fmt(now))
        if (memoryBase.get(key)) lines.push('已有基线；此快照可与基线期场景对照，或两次快照之间做 heap diff 定位持有者。')
        try {
          const dir = args.project_dir ? path.join(path.resolve(String(args.project_dir)), '.design-canvas') : process.cwd()
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, `heap-${Date.now()}.heapsnapshot`)
          const wrote = v8.writeHeapSnapshot(file)
          lines.push(`heap snapshot 已写: ${wrote}（用 Chrome DevTools 加载，或与另一份做 heap diff）`)
        } catch (e) {
          lines.push(`heap snapshot 失败: ${shortErr(e)}`)
        }
      } else {
        // status（缺省）
        lines.push(fmt(sample()))
        lines.push(`V8 heapSizeLimit=${mb(hs?.heap_size_limit)}MB usedHeap=${mb(hs?.used_heap_size)}MB 强制GC=${canForceGc() ? '可用' : '不可用(--expose-gc)'}`)
        lines.push('用 action=baseline 记基线后 action=track/gc 追踪；或 snapshot 落盘深入。')
      }
      return lines.join('\n')
    },
  }))
  console.log(`[design-canvas-bridge] memory_observe 已注册`)
  console.log(`[design-canvas-bridge] apply running; 预热工具=${importToolName} enabled=${config.enabled}`)
}

/** 便于拦截的类型别名（真正的实例由 @deepseek-ai/dsh-workspace 提供，类型上不透出可变 create）。 */
interface WorkspaceRegistryLike extends Service {
  create(path: string, title?: string): Promise<Workspace>
}