/**
 * arm-isolation — 臂间隔离层（只禁止互读互写）
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolGuard } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import path from 'node:path'

export const name = 'arm-isolation'
export const inject: string[] = []

function normalizePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  let s = p.replace(/\\/g, '/')
  s = s.replace(/\/+/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  const isWin = process.platform === 'win32'
  if (isWin) s = s.toLowerCase()
  return s
}

function pathDenyCheck(pathStr: string, denyRoots: string[]): boolean {
  if (typeof pathStr !== 'string' || pathStr.length === 0) return false
  const np = normalizePath(pathStr)
  for (const root of denyRoots) {
    const nr = normalizePath(root)
    if (np === nr || np.startsWith(nr + '/')) return true
  }
  return false
}

function collectStringValues(obj: unknown, depth: number = 5): string[] {
  if (depth <= 0) return []
  if (typeof obj === 'string') return [obj]
  if (Array.isArray(obj)) return obj.flatMap((v) => collectStringValues(v, depth - 1))
  if (obj !== null && typeof obj === 'object') {
    return Object.values(obj as Record<string, unknown>).flatMap((v) => collectStringValues(v, depth - 1))
  }
  return []
}

function resolveAbs(p: string): string {
  if (p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p)) return p
  return path.resolve(process.cwd(), p)
}

/** 从 shell 命令文本中提取绝对路径（Windows/Linux） */
function extractPathsFromCmd(cmd: string): string[] {
  const paths: string[] = []
  // Windows: X:\... 或 X:/...
  const winRe = /[A-Za-z]:[/\\][^\s;|&<>"]+/g
  // POSIX: /...  (至少1段)
  const posixRe = /\/[^\s;|&<>"]+/g
  let m
  while ((m = winRe.exec(cmd)) !== null) paths.push(m[0])
  while ((m = posixRe.exec(cmd)) !== null) paths.push(m[0])
  return paths
}

export function isDenied(pathOrArgs: unknown, denyRoots: string[]): boolean {
  if (!denyRoots || denyRoots.length === 0) return false
  if (typeof pathOrArgs === 'string') {
    const abs = resolveAbs(pathOrArgs)
    return pathDenyCheck(abs, denyRoots)
  }
  if (pathOrArgs !== null && typeof pathOrArgs === 'object') {
    const args = pathOrArgs as Record<string, unknown>
    // 对 shell 命令，先从 command 字段提取路径再判
    const cmd = String(args.command ?? '')
    if (cmd) {
      for (const p of extractPathsFromCmd(cmd)) {
        if (pathDenyCheck(p, denyRoots)) return true
      }
    }
    // 兜底：扫所有字符串值
    const strings = collectStringValues(pathOrArgs)
    for (const s of strings) {
      const abs = resolveAbs(s)
      if (pathDenyCheck(abs, denyRoots)) return true
    }
  }
  return false
}

function tolerantConfig<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return z.preprocess((v) => v ?? {}, schema)
}

export const Config = tolerantConfig(
  z.object({
    self: z.string().optional(),
    arms: z.record(z.string(), z.string()).default({}),
    extraDeny: z.array(z.string()).default([]),
  }),
)

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const denyRoots: string[] = []
  if (config.arms) {
    for (const [armName, root] of Object.entries(config.arms)) {
      if (config.self && armName === config.self) continue
      if (root && root.trim()) denyRoots.push(normalizePath(root.trim()))
    }
  }
  if (config.extraDeny) {
    for (const r of config.extraDeny) {
      if (r && r.trim()) denyRoots.push(normalizePath(r.trim()))
    }
  }
  console.log(`[arm-isolation] apply running; denyRoots=${denyRoots.length} 条`)
  ctx.inject(['tools'], (tctx) => {
    tctx.tools.guard((exec) => {
      const toolName = exec.name
      const args = exec.arguments as Record<string, unknown> | undefined
      if (args && typeof args === 'object') {
        if (isDenied(args, denyRoots)) {
          return buildDenyReason(toolName, args, denyRoots)
        }
      }
      const shellNames = ['pwsh', 'bash']
      if (shellNames.includes(toolName) && args?.command) {
        const cmd = String(args.command)
        for (const root of denyRoots) {
          const idx = cmd.toLowerCase().indexOf(root.toLowerCase())
          if (idx !== -1) {
            return buildShellDenyReason(toolName, cmd, root)
          }
        }
      }
      return undefined
    })
  })
}

function buildDenyReason(toolName: string, args: Record<string, unknown>, denyRoots: string[]): string {
  const hits: string[] = []
  function walk(obj: unknown, segPath: string, depth = 0) {
    if (depth > 4 || hits.length >= 5) return
    if (typeof obj === 'string') {
      const abs = resolveAbs(obj)
      for (const root of denyRoots) {
        if (abs === root || abs.startsWith(root + '/')) {
          hits.push(`${segPath}="${obj}"`)
          break
        }
      }
    } else if (obj !== null && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        walk(v, `${segPath}.${k}`, depth + 1)
      }
    }
  }
  walk(args, 'args')
  const hitDesc = hits.length > 0 ? ` (命中: ${hits.join('; ')})` : ''
  return (
    `[arm-isolation] 拒绝：工具 ${toolName} 的 arguments 中检测到另一臂路径${hitDesc}。` +
    '\n臂间互读互写禁令：每臂只能访问自己的根目录。' +
    '\n请在属于自己的臂内操作，不要跨臂访问。'
  )
}

function buildShellDenyReason(toolName: string, cmd: string, matchedRoot: string): string {
  return (
    `[arm-isolation] 拒绝：工具 ${toolName} 的命令文本中包含另一臂路径 "${matchedRoot}"。` +
    '\n臂间互读互写禁令：每臂只能访问自己的根目录。' +
    '\n请在属于自己的臂内操作，不要跨臂访问。'
  )
}
