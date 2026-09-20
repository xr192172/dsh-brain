// 稳定索引工具（本文件是 cli-0005 的**靶子**：其中 `computeHash` 需要被重命名）
// 规格见 ./README.md —— 重点：**按语义重命名**，不是文本替换。

/**
 * 把一个字符串映射成稳定的短摘要（同一输入永远同一输出）。
 * ⚠️ 这个函数的**名字**是本次任务要改的；它的**行为**绝对不许变。
 */
export function computeHash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 持久化 key 的命名空间 —— **字符串常量，任务中不许改**（改了会让旧数据失效）。 */
export const KEY_NAMESPACE = 'computeHash-v1'

/**
 * 旧版兼容层：内部有一个**局部变量**也叫 `computeHash`。
 * ⚠️ 它必须**保持原样**（它不是那个导出函数，只是同名的局部变量）。
 */
export function legacyAlias() {
  const computeHash = 'legacy'
  return computeHash + ':' + KEY_NAMESPACE
}
