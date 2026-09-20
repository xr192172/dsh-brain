// 存储层：用 computeHash 为条目生成稳定 id（注释里的名字也应跟着改名）
import { computeHash, KEY_NAMESPACE } from './math.js'

const entries = new Map()

export function put(key, value) {
  const id = computeHash(key + '|' + value)
  entries.set(id, { key, value, ns: KEY_NAMESPACE })
  return id
}

export function get(id) {
  return entries.get(id) ?? null
}

export function size() {
  return entries.size
}
