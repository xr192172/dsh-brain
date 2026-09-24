/**
 * 格⑮ 预演体检 · **坏样本③/④「声明了但查不到」**。
 *
 * 本文件是**合法可装载**的插件（`apply` 不抛、不 import 任何东西）——它的问题不在"能不能装"，
 * 而在"宣称提供的能力到底有没有真的到模型手里"。这正是配置视角**看不见**的一类坏：
 * `cordis.patch.yml` 里它和健康插件完全同形。
 *
 * 它刻意**什么都不注册**，用来配对两种"声明不存在的端点"的实验：
 *   ③ overlay 声明的 loader 条目 id 指向一个**不存在的模块路径** ⇒
 *      活实例 Loader 树里查不到 ⇒ plugin 体检项 red（或 boot fatal）。
 *   ④ overlay 插入的插件是好的，但清单声明了它应当提供的工具 `b2_ghost_tool`，
 *      而活实例的模型面工具表里没有 ⇒ tool 体检项 red。
 *
 * 期望：两种都**必须被拒**（判据 5 的"声明不存在的端点"）。
 */
export const name = 'b2-silent-plugin'

/**
 * 元数据式的"宣称"：本插件**自称**提供这些工具/这个端点。
 * 注意：没有任何机制会自动去注册它们 —— 这个常量只是一句声明，
 * 正是"声明"与"实测"必须分开取证的原因。
 */
export const declaredTools = ['b2_ghost_tool']
export const declaredEndpoint = '/b2/ghost-endpoint'

export function apply() {
  // 有意为空：一个"装上了但什么也没接上"的插件。
}
