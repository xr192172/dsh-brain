/**
 * 格⑮ 预演体检 · **坏样本①「启动即抛错」**。
 *
 * 现实对应：插件顶层代码里有 `throw`（或者一个在模块求值期就炸的初始化）。
 * DSH 以前就是被这类插件"装上去就崩"。
 *
 * 期望：预演体检**必须拒绝**（判据 5），且现役不受影响、不留半途污染。
 * 拒绝的两条可能路径（都算合格，报告中如实给出走的是哪条）：
 *   · 装载时顶层抛错 ⇒ 该 loader 条目 fiber=FAILED ⇒ plugin 体检项 red；
 *   · 若它的抛错扩散到整棵树 ⇒ 预演代 boot 健康检查拿不到完成信号 ⇒ boot 体检项 red。
 */
export const name = 'b2-bad-throws'

throw new Error('B2-FIXTURE：故意在模块装载期抛错（启动即抛错）')

export function apply() {
  // 到不了这里。
}
