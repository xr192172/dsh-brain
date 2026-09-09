/**
 * @module @dsh-brain/handover-agent/deploy
 *
 * `tool_apply`——把"安全自进化"触发放成一个固定工具，而不是让脑临场拼 HTTP 脚本。
 *
 * 语义（P1 激活层）：脑改完 P0 内容（settings/模型/provider/插件/技能/记忆）后，
 * 调本工具 → 它向控制面 admin（默认 127.0.0.1:31800）发 `?cmd=apply`，触发蓝绿交付：
 * spawn 新代→追平→冻结旧→翻转→验证，失败自动回滚。
 * 本工具就是那根"固化"的通道；P2 就地改/自残仍由 guard 拦截。
 * 注：调用本工具会令当前 gen 在交接中被替换（这正是"换成已经自进化后的自己"）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

const CONTROL_URL = process.env.HANDOVER_CONTROL || 'http://127.0.0.1:31800'

export function registerApplyTool(ctx: Context): void {
  ;(ctx as unknown as { inject?: (svc: string[], fn: (c: unknown) => void) => void }).inject?.(['tools'], (tc) => {
    ;(tc as { tools: { register: (d: unknown) => unknown } }).tools.register(
      defineTool({
        name: 'tool_apply',
        description:
          '在你改完 P0 内容（settings/模型/provider、插件数据、技能、记忆、工具行为，准备激活）后调用本工具：' +
          '它经控制面触发蓝绿交付（spawn 新代→追平→冻结旧→翻转→验证，失败自动回滚），把你的改动安全上线。' +
          '这是安全自进化的正式通道——不要就地改 switchboard 源码、不要强杀宿主进程。',
        parameters: {
          note: {
            type: 'string',
            description: '本次改动的简述，便于追溯（可选）。',
          },
          profile: {
            type: 'string',
            description: '可选：staging 代运行的脑 profile（默认 web）。接入 three-brain/sandbox 时传目标脑 profile，验证通过后即一键置换为当前脑。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              stage: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? 'apply 已触发，控制面 stage=' + value.stage + '（蓝绿交付中；失败会自动回滚，你可稍后查 3080 是否还通）'
                : 'apply 触发失败（stage=' + value.stage + '），检查控制面 admin 是否可达',
            },
          ],
        },
        async execute(args) {
          try {
            const q = new URLSearchParams({ cmd: 'apply' })
            if (args.note) q.set('note', args.note)
            // profile 指向 staging 代运行的脑 profile（接入 three-brain/sandbox 代际，验证通过即一键置换为当前脑）
            if (args.profile) q.set('profile', args.profile)
            const res = await fetch(CONTROL_URL + '/?' + q.toString(), { signal: AbortSignal.timeout(15000) })
            const j = (await res.json().catch(() => ({}))) as { stage?: string }
            return { ok: res.ok, stage: (j && j.stage) || String(res.status) }
          } catch (e) {
            return { ok: false, stage: 'apply-error: ' + ((e as Error).message ?? String(e)) }
          }
        },
      }),
    )
  })
}