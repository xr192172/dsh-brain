/**
 * 格⑮ 预演体检 · **command 正样本插件**。
 *
 * 契约里 `command` 是与 `plugin`/`tool` 平级的一等判据分支（`preflight-contract.ts` 的
 * `CheckKind`，对应"活实例命令注册表 `ctx.commands.list()`"这条物理事实）。但在补本夹具之前，
 * e2e 的场景**一次都没声明过 `commands=`** ⇒ 那条分支只有"坏的一定被拒"的推断，
 * 没有"好的一定能过"的正向证据 —— 判据不完整（未被测代码）。
 *
 * 本夹具填上正的那一半：按框架同款方式（模块级 `inject = ['commands']` + `ctx.commands.register`，
 * 与 `@deepseek-ai/dsh-command-feedback` 逐字同形）注册**一个全局 host 命令**
 * `preflight_probe_cmd`，用来证明"一个插件注册的命令真的能被 `ctx.commands.list()` 这条
 * 活实例读数抓出来"。
 *
 * 它不写文件、不联网、不发 LLM 请求（与 `good-plugin.mjs` 同款纪律）。
 * ★ 与 `good-plugin.mjs`（工具面探针）配对：一个验 `tool` 分支，一个验 `command` 分支。
 */
export const name = 'preflight-cmd-fixture'

/** 与框架命令插件同款：只有在 `commands` 服务装配时才 apply（缺装配不崩）。 */
export const inject = ['commands']

export function apply(ctx) {
  ctx.commands.register({
    name: 'preflight_probe_cmd',
    description: '格⑮ 预演体检探针命令：唯一作用是有名字、可被 ctx.commands.list() 看见。不产生副作用。',
    handler: () => ({ kind: 'success', text: 'preflight_probe_cmd ok' }),
  })
}
