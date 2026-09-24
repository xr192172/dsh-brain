/**
 * 格⑮ 预演体检 · **正样本插件**：一个"新装的插件"在装之前该被验成什么样。
 *
 * 它做三件事，正好对应判据 1/2/6：
 *   ① 作为一个**能被装配**的插件（`apply` 不抛）⇒ 预演代应该起得来（判据 1）；
 *   ② 向 `ctx.tools` **注册一个工具** `b2_probe_tool` ⇒ 它应当出现在**活实例的模型面工具表**里
 *      （判据 2 的"插件声明的东西实际查出存在" + 判据 6 的"工具面"）；
 *   ③ 什么都不外加 —— 不写文件、不联网、不发 LLM 请求。
 *
 * ★ 为什么工具是"模型面工具表"而不是"某个自报清单"：`ctx.tools.register` 注册的就是 registry
 *   喂给 `ctx.systemPrompt.tools()` 的同一份定义 ⇒ 能被 `ctx.tools.schemas()` 看见 ==
 *   能被模型看见。预演体检读的正是 `schemas()`，所以它是"工具到了模型手里"的直接证据。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'b2-good-plugin'

export function apply(ctx) {
  // 与 `switchboard/src/deploy.ts` 注册 tool_apply 同款：经 ctx.inject(['tools']) 拿注册表。
  ctx.inject(['tools'], (tc) => {
    tc.tools.register(
      defineTool({
        name: 'b2_probe_tool',
        description:
          '格⑮ 预演体检用的探针工具：它的唯一作用是有名字、可被 ctx.tools.schemas() 看见，' +
          '以证明"插件注册的工具确实出现在模型面工具表里"。不产生任何副作用。',
        parameters: {
          note: { type: 'string', description: '随意字符串（可选）' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean', required: true }, echo: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: 'b2_probe_tool ok=' + String(value.ok) }],
        },
        async execute(args) {
          return { ok: true, echo: typeof args?.note === 'string' ? args.note : '' }
        },
      }),
    )
  })
}
