/**
 * @module @dsh-brain/handover-agent/guard
 *
 * P2 宿主安全护栏：拦截运行中脑对"安全层自身"的就地改动/自残。
 * 语义（三层方案）：
 *  - P0 内容层（settings/模型/插件数据/技能/记忆）：**自由改**，本护栏不设限。
 *  - P1 激活层：改完内容后应**走控制面 admin**（`/admin/cmd apply`）触发蓝绿，
 *    而非就地换血——本护栏也不拦（那是正确路径）。
 *  - P2 安全层（switchboard 源码 / 协调租约文件 / profile bundle 注册表 /
 *    杀宿主 PID / 绑端口）：**禁就地改**，只可经"整体替换"进化。
 *
 * 实现：`ctx.tools.guard` 在工具执行前匹配参数里的保护性签名，命中则拒绝。
 * 纯净启发式；可用 config.guardDeny 覆盖默认 deny 表。缺 tools 服务时安全降级（不注册）。
 */
import type { Context } from '@deepseek-ai/cordis'

export interface P2Pattern {
  re: RegExp
  why: string
}

export function defaultP2Patterns(): P2Pattern[] {
  return [
    { re: /\btaskkill\b/i, why: 'host process kill' },
    { re: /\bStop-Process\b/i, why: 'host process kill (self-kill vector)' },
    { re: /packages[/\\]switchboard/i, why: 'P2: switchboard source (in-place edit forbidden)' },
    { re: /\.dsh[/\\]switchboard/i, why: 'P2: coordination/lease files' },
    // 绝对主目录变体（Windows 反斜杠 + 正斜杠都覆盖，避免漏网绝对路径写）
    { re: /C:[/\\]Users[/\\]Admin[/\\]\.dsh[/\\]switchboard/i, why: 'P2: coordination/lease files (abs)' },
    { re: /profiles[/\\]web[/\\]package\.json/i, why: 'P2: profile bundle registry' },
    { re: /profiles[/\\]web[/\\]cordis\.yml/i, why: 'P2: profile patch' },
    { re: /@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js/i, why: 'P2: harness bootstrap bin' },
  ]
}

export function registerHostGuard(ctx: Context, deny: P2Pattern[] = defaultP2Patterns()): void {
  const anyCtx = ctx as unknown as { inject?: (svc: string[], fn: (c: unknown) => void) => void }
  anyCtx.inject?.(['tools'], (tc) => {
    const guard = (exec: { name?: string; arguments?: unknown }): string | undefined => {
      let s = exec.name || ''
      try {
        s += JSON.stringify(exec.arguments ?? {})
      } catch {
        /* preserve partial */
      }
      for (const p of deny) {
        if (p.re.test(s)) return `host-safety: P2 blocked — ${p.why}（进化请走控制面 replace/apply，勿就地改）`
      }
      return undefined
    }
    ;(tc as { tools: { guard: (g: (e: unknown) => string | undefined) => void } }).tools.guard(guard as (e: unknown) => string | undefined)
  })
}