/**
 * mgmt.ts —— **控制面的管理面**：让"DSH 自己（或外部 agent）"通过**长服务**驱动开发链，
 * 而不必每次起 shell。依据用户 2026-09-25：
 *   *"我希望就是我只需要点在桌面启动这个**蓝绿面板**，然后你就可以通过这个**蓝绿面板去绕过这个 Shell**，
 *    毕竟它**已经是个长服务**了，去绕过这个 Shell 去用这个蓝绿面板去**管理这个 DSH**。"*
 *
 * ★★ 安全三前提（**缺一不可**；这是把管理面开在 HTTP 上必须付的代价）：
 *   ① **具名动作白名单** —— 不是"任意命令"，是一组**固定的管理动作**；
 *   ② **参数先校验** —— 题必须在题库里、臂必须在 `_arms/` 里、名字只允许 `[a-zA-Z0-9._-]`；
 *   ③ **绝不经 shell** —— 一律 `spawnSync(node, [脚本, ...已校验的参数])`（**数组**，没有字符串拼接 ⇒ 无注入面）。
 *
 * 动作（`?cmd=mgmt&action=…`）：
 *   · `tasks`                                   列题（题库，agent-agnostic）
 *   · `verdict&task=<id>`                       该题的重放轨迹与报警数
 *   · `experiment&task=<id>&arm=A[&dry=1]`      ★ **异步**跑一次实验（立即回 started + runId）
 *   · `result&runId=<id>`                       取异步结果
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const ACTIONS = ['tasks', 'verdict', 'experiment', 'result'] as const
export type Action = (typeof ACTIONS)[number]

/** 名字允许的字符（**先卡死字符集**，再谈别的）。 */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export interface Validated {
  action: Action
  task?: string
  arm?: string
  dry?: boolean
  runId?: string
}

/**
 * ★★ **纯函数**：校验并**归一化**请求（不 spawn、不落盘 ⇒ 可被判据直接测）。
 * @returns `{ok:true, v}` 或 `{ok:false, reason}`
 */
export function validate(url: URL, wt: string): { ok: true; v: Validated } | { ok: false; reason: string } {
  const action = (url.searchParams.get('action') ?? '') as Action
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, reason: `未知 action "${action}"（只允许：${ACTIONS.join(' / ')}）` }
  }
  const v: Validated = { action }

  if (action === 'tasks') return { ok: true, v }

  if (action === 'result') {
    const runId = url.searchParams.get('runId') ?? ''
    if (!SAFE_NAME.test(runId)) return { ok: false, reason: 'runId 不合法（只允许字母数字与 . _ -）' }
    v.runId = runId
    return { ok: true, v }
  }

  // verdict / experiment 都要一道**真实存在**的题
  const task = url.searchParams.get('task') ?? ''
  if (!SAFE_NAME.test(task)) return { ok: false, reason: 'task 不合法（只允许字母数字与 . _ -）' }
  if (!fs.existsSync(path.join(wt, 'evals', 'tasks', task, 'task.md'))) {
    return { ok: false, reason: `题 "${task}" 不在题库里（evals/tasks/${task}/task.md 不存在）` }
  }
  v.task = task

  if (action === 'experiment') {
    const arm = url.searchParams.get('arm') ?? 'A'
    if (!/^[a-zA-Z0-9_-]+$/.test(arm)) return { ok: false, reason: 'arm 不合法' }
    // ★★ 2026-09-25 修：臂**不在仓库里**，而是**仓库的同级目录** `D:\project_develop\_arms\<名>\dshhome`
    //   （权威定义见 `scripts/arm-ports.mjs` 的 `rootForArm()`／`dshHomeForArm()`）。
    //   我第一版写成 `path.join(wt,'_arms',…)` ⇒ 恒不存在 ⇒ **误拒**（而 `tasks` 能跑 ⇒ 让我误以为 wt 没问题）。
    const armHome = path.resolve(wt, '..', '_arms', arm.toLowerCase(), 'dshhome')
    if (!fs.existsSync(armHome)) {
      return { ok: false, reason: `臂 "${arm}" 没有实例（${armHome} 不存在）⇒ 先 arm-up ${arm}` }
    }
    v.arm = arm
    v.dry = url.searchParams.get('dry') === '1'
  }
  return { ok: true, v }
}

/**
 * ★★ **纯函数**：把已校验的请求翻成 **argv 数组**（`[node, 脚本, ...参数]`）。
 * ★ **绝不返回字符串** —— 返回数组就从根上消灭了"拼接/注入"这一类。
 */
export function argvFor(v: Validated, wt: string, nodeExe: string): string[] {
  const S = (n: string) => path.join(wt, 'scripts', n)
  switch (v.action) {
    case 'tasks':
      return [nodeExe, S('task-bank.mjs'), 'list']
    case 'verdict':
      return [nodeExe, S('task-bank.mjs'), 'verdict', v.task as string]
    case 'experiment': {
      const a = [nodeExe, S('run-experiment.mjs'), v.task as string, '--arm', v.arm as string]
      if (v.dry) a.push('--dry')
      return a
    }
    case 'result':
      return [] // 不 spawn（读文件）
  }
}

/** 执行（spawn **数组**，不经 shell）。 */
export function execAction(v: Validated, wt: string, nodeExe = process.execPath): { code: number; stdout: string; stderr: string } {
  const argv = argvFor(v, wt, nodeExe)
  if (argv.length === 0) return { code: 0, stdout: '', stderr: '' }
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 900_000, cwd: wt })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 异步实验的台账目录。 */
export const mgmtDir = (wt: string) => path.join(wt, 'evals', 'runs', '_mgmt')
