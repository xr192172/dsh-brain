/**
 * 格⑮ 预演体检 · **坏样本⑤「装配期同步抛错」**（重放臂新增，B2 没有这一条）。
 *
 * 与 `bad-throws.mjs` 的差别（这是"另一种坏法"，不是同一件事）：
 *   · `bad-throws.mjs` 在**模块求值期**（顶层）抛 ⇒ 模块图都进不去；
 *   · 本文件在**模块求值期是合法的**（`export` 正常、`import` 正常），
 *     但 `apply()` 一被调用就抛 ⇒ 失败发生在 **loader 把条目 apply 到 ctx 的那一刻**。
 *
 * 现实对应：插件 `apply(ctx)` 里写的初始化逻辑炸了（例如读了一个不存在的 config 字段就
 * `cfg.foo.bar`）。这在 `cordis.patch.yml` 里同样与健康插件完全同形。
 *
 * 期望：预演体检**必须拒绝**（判据 5）。
 */
export const name = 'b2-bad-apply-throws'

export function apply() {
  throw new Error('B2-FIXTURE：apply() 装配期同步抛错')
}
