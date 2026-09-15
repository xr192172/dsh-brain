/**
 * @module @dsh-brain/switchboard/boot-health
 *
 * 「启动健康」判据（2026-09-15 重构，修 gen-3083 漏判）。
 *
 * ## 为什么单独成模块
 *
 * 原实现是 coordinator 里的两个私有函数（`findFatalBootErrors` + `lastBootSegment`），
 * **纯否定式**、且**读一次就定论**。它漏判了 gen-3083：
 * 崩溃文本与 `result:success` 之间只差 637ms，健康检查读到的是"还没写完"的段
 * ⇒ 判 ok ⇒ 本该拦截的"环境漂移"代接了会话。
 *
 * 把它抽出来并配单测，是因为**这个判据本身就是事故的保险**：保险失效比事故更危险，
 * 必须有可执行夹具把它钉住，而不是靠下次真出事再发现。
 *
 * ## 两条设计原则（都由这次事故反推）
 *
 * 1. **否定式判据无法区分「干净」与「还没写完」。**
 *    必须叠加一个**正向完成信号**（`BOOT_READY_PATTERNS`）：只有在真正启动成功后
 *    才会出现的日志。观测不到 ⇒ **不允许判健康**（宁可回滚，不可放行）。
 * 2. **健康检查必须有界等待 + 重读**，而不是读一次就定论。
 *    日志是跨进程的异步产物，落盘时机不可控（本次实测 637ms）。
 *    ⇒ `verifyBootHealth` 轮询直到"出现正向信号"或"命中致命模式"或"超时"。
 *
 * ## 三态结论（不是 bool）
 *
 * - `healthy`  ：正向信号已出现，且无致命模式。
 * - `fatal`    ：命中致命模式（或进程已退出）——**确定**失败，早退不浪费等待。
 * - `unknown`  ：窗口内既没等到正向信号也没见致命模式（超时）。
 *   这是**欠证据**，不是健康。调用方（coordinator）对它必须走保守策略：
 *   与致命同等对待（回滚），因为"我们不知道它好不好"与"它不好"在代际交接里
 *   同样是不可接受的放行风险。
 */
import { existsSync, readFileSync } from 'node:fs'

/** 一次启动健康判定的结论。 */
export type BootHealthVerdict = 'healthy' | 'fatal' | 'unknown'

/** 判定结果（含可读依据，便于落盘自证与人工复盘）。 */
export interface BootHealth {
  verdict: BootHealthVerdict
  /** 命中的致命原因（可读中文标签）。`fatal` 时非空。 */
  fatal: string[]
  /** 是否观测到"启动完成"正向信号。 */
  readySeen: boolean
  /** 本次判定消耗的毫秒数（诊断用：判断是"立刻失败"还是"等满了窗口"）。 */
  waitedMs: number
  /** 判据读到的启动段行数（诊断用：0 表示日志还没写出来）。 */
  segmentLines: number
}

/**
 * boot.log 中代表「本次启动装配失败」的致命模式。
 *
 * 背景：probe 只反映「端口通不通、进程活不活」，**不反映插件树是否装配完整**。
 * 实测 gen-3086/3087/3088 因 `duplicate loader entry id: design-canvas-bridge`
 * 导致 `plugin tree failed to load`，但 gen 仍以「能力残缺」状态就绪：
 *   - 工具集少 25 个（design-canvas 全套）
 *   - Code Mode 因 codeRuntime 服务缺失而静默回落 native
 *     （dsh-agent-tool-presentation 的 `ctx.inject(["codeRuntime"], ...)` 回调不执行）
 *   - system + tools 同时变化 → prompt 前缀全失效（会话迁移后首轮命中率 0%）
 * 这类 gen 一旦 promote，会话迁过去就是「环境漂移」，模型只能靠试探发现。
 */
export const FATAL_BOOT_PATTERNS: Array<[RegExp, string]> = [
  [/plugin tree failed to load/i, '插件树加载失败'],
  [/duplicate loader entry id/i, 'loader entry id 重复'],
  [/failed to apply loader entry include/i, 'loader entry include 应用失败'],
  [/declares no dsh\.bundle/i, '无效 bundle 声明（缺 dsh.bundle）'],
  [/cannot resolve profile bundle/i, 'profile bundle 无法解析'],
  [/SyntaxError: Unexpected token/i, '配置 JSON/YAML 语法错误（常见：UTF-8 BOM）'],
  // gen-3083 教训（2026-09-15）：下面三条是「上面六条的前置形态」。
  // 3083 的报错文本其实命中了第 1、3 条，漏判纯粹因为**读得太早**；
  // 但这三条仍值得单列——它们是不带 `plugin tree` 外壳的**裸根因**，
  // 某些失败路径（单插件构造期报错而非整树重载）只会打这三条。
  [/invalid config/i, '插件配置校验失败（Config schema 拒绝）'],
  [/ValidationError/i, '配置/参数校验异常（zod ValidationError）'],
  [/^\s*Node\.js v\d+/m, '进程因未捕获异常退出（Node 打印版本号后退出）'],
]

/**
 * 「启动已完成」的**正向信号**（2026-09-15 新增，修纯否定式判据的结构性缺陷）。
 *
 * 为什么必须有：健康的启动与"日志还没写完"在观测上完全同形——
 * 都表现为"没命中任何致命模式"。
 *
 * 取 `dsh web: http://127.0.0.1:<port>` 作为信号，因为它是 dsh 在**全部装载完成、
 * web 服务开始监听之后**才打印的最后一行（见 gen-3095 的成功 boot.log：它是末行）。
 * ⇒ 它出现 ⟺ 引导流程已走到底。
 *
 * 宽松匹配（不钉端口号）：本函数拿到的是"最后一段启动"文本，
 * 段内出现即代表本代已就绪。
 */
export const BOOT_READY_PATTERNS: RegExp[] = [/dsh web:\s*http:\/\/127\.0\.0\.1:\d+/]

/**
 * 在给定 boot.log 片段里找致命装载错误，返回可读原因列表（空数组 = 未见致命）。
 *
 * 注意：**空数组 ≠ 健康**——它只代表"没看见致命错误"。
 * 健康还需要 `hasReadySignal` 为真。这一区分是 gen-3083 漏判的直接教训。
 */
export function findFatalBootErrors(boot: string): string[] {
  const hits: string[] = []
  for (const [re, label] of FATAL_BOOT_PATTERNS) {
    if (re.test(boot) && !hits.includes(label)) hits.push(label)
  }
  return hits
}

/** 片段里是否出现「启动完成」正向信号。 */
export function hasReadySignal(boot: string): boolean {
  return BOOT_READY_PATTERNS.some((re) => re.test(boot))
}

/**
 * 取 boot.log 中「最后一次启动」的片段。
 *
 * spawner 每次启动会写 `===== BOOT ... =====` 分隔标记（见 spawner.ts）；
 * 旧日志无标记时退回尾部 `tailFallback` 行 —— 宁可少判，也不把**历史**启动的
 * 错误误判成本次失败。
 *
 * ★ 这里**刻意只按标记切**，不额外做"空段即未就绪"的推断：
 * 空段（标记刚写、子进程还没输出）由调用方的轮询等待处理，
 * 单次调用只负责"把范围圈对"。
 */
export function lastBootSegment(logPath: string, tailFallback = 300): string {
  if (!existsSyncSafe(logPath)) return ''
  try {
    const all = readFileSyncSafe(logPath).replace(/^\uFEFF/, '')
    const idx = all.lastIndexOf('===== BOOT ')
    if (idx >= 0) return all.slice(idx)
    return all.split(/\r?\n/).slice(-tailFallback).join('\n')
  } catch {
    return ''
  }
}

/** 判据签名：便于单测注入替身（真实实现读磁盘）。 */
export interface BootProbe {
  /** 读取当前「最后一次启动」的日志段。 */
  readSegment(): string
}

/** `verifyBootHealth` 的可选参数（默认值面向真实交接场景）。 */
export interface VerifyBootHealthOptions {
  /**
   * 有界等待窗口 ms（默认 6000）。窗口内轮询，直到：
   * 出现正向信号（→healthy）／命中致命模式（→fatal，早退）／窗口耗尽（→unknown）。
   *
   * 默认 6000 的依据：gen-3083 的崩溃文本在 BOOT 标记后 **3.41s** 落盘，
   * 留约 1.75× 余量。健康启动的信号通常 <1s 就出现（gen-3095 实测亚秒级）。
   */
  timeoutMs?: number
  /** 轮询间隔 ms（默认 250）。 */
  intervalMs?: number
  /**
   * 进程存活探测（注入用；返回 false ⇒ 立即判 fatal，不空等）。缺省不探（纯日志判据）。
   *
   * ★ 优先级低于 `hasExited`：`isAlive` 走 `process.kill(pid, 0)`，在 Windows 上
   * 对"刚退出但 PID 尚未回收"存在窗口期；而 `child_process` 的 `exitCode` 是内核
   * 直接回填的**确定性**事实。两者都给时，`hasExited` 先判。
   */
  isAlive?: () => boolean
  /**
   * 进程**是否已退出**（首选信号；由 `spawned.proc.exitCode !== null` 提供）。
   * 相比 `isAlive` 的轮询，这是事件驱动的确定事实，**没有竞态窗口**。
   */
  hasExited?: () => boolean
  /** 时钟注入（单测用），返回当前 ms。 */
  now?: () => number
  /** 睡眠注入（单测用），返回一个已 resolve 的 Promise。 */
  sleep?: (ms: number) => Promise<void>
}

/**
 * 有界等待地判定一次启动健康（2026-09-15 新增，替换"读一次就定论"）。
 *
 * 返回三态结论而非 bool —— `unknown`（欠证据）与 `fatal` 在交接语义下**同等不可放行**，
 * 但保留区分是为了让回执诚实（"确定坏了" vs "没等到证据"是两种不同的运营信号）。
 */
export async function verifyBootHealth(
  probe: BootProbe,
  opts: VerifyBootHealthOptions = {},
): Promise<BootHealth> {
  const timeoutMs = opts.timeoutMs ?? 6000
  const intervalMs = opts.intervalMs ?? 250
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  const deadline = started + timeoutMs

  let segmentLines = 0
  // 进程死亡：**先看确定性信号**（exitCode 已回填），再退回 PID 轮询。
  const dead = (): boolean => (opts.hasExited ? opts.hasExited() : false) || (opts.isAlive ? !opts.isAlive() : false)
  for (;;) {
    // 进程已死 ⇒ 不必再等日志（日志会随之封闭，等待纯属浪费）。
    if (dead()) {
      const seg0 = probe.readSegment()
      const fatal0 = findFatalBootErrors(seg0)
      return {
        verdict: 'fatal',
        fatal: fatal0.length > 0 ? fatal0 : ['进程已退出（未通过启动）'],
        readySeen: hasReadySignal(seg0),
        waitedMs: now() - started,
        segmentLines: countLines(seg0),
      }
    }

    const seg = probe.readSegment()
    segmentLines = countLines(seg)

    // ① 致命优先：确定坏了就立刻回，不把窗口耗满（早失败 = 早回滚 = 少影响）。
    const fatal = findFatalBootErrors(seg)
    if (fatal.length > 0) {
      return { verdict: 'fatal', fatal, readySeen: hasReadySignal(seg), waitedMs: now() - started, segmentLines }
    }

    // ② 正向信号：只有在"无致命 + 已就绪"同时成立时才判健康。
    if (hasReadySignal(seg)) {
      return { verdict: 'healthy', fatal: [], readySeen: true, waitedMs: now() - started, segmentLines }
    }

    // ③ 窗口耗尽 → 欠证据（**不是**健康）。
    if (now() >= deadline) {
      return { verdict: 'unknown', fatal: [], readySeen: false, waitedMs: now() - started, segmentLines }
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
  }
}

function countLines(s: string): number {
  return s ? s.split(/\r?\n/).length : 0
}

function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

function readFileSyncSafe(p: string): string {
  return readFileSync(p, 'utf8')
}
