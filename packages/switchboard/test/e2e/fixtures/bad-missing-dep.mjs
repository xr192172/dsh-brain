/**
 * 格⑮ 预演体检 · **坏样本②「缺依赖」**。
 *
 * 现实对应：插件 package.json 里少写了一个 dependency（本地能跑、装到别的环境就
 * `ERR_MODULE_NOT_FOUND`）—— 这是"装插件把自己搞崩"的经典成因之一。
 *
 * 这里直接 import 一个**确定不存在**的包名，让模块图在解析期就失败。
 * 期望：预演体检**必须拒绝**（判据 5）。
 */
import 'b2-this-package-definitely-does-not-exist-xyz'

export const name = 'b2-bad-missing-dep'

export function apply() {
  // 到不了这里。
}
