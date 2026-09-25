// 测试用 provider (ESM)
export function apply(ctx, config) {
  ctx.subagents.registerProvider({
    name: 'test-provider',
    capabilities: { test: {} },
    inheritsParentContext: true,
    start: () => {},
    prepareContinuable: () => {},
  })
}
