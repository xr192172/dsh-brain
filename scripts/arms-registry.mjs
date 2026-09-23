/**
 * arms-registry.mjs —— **臂注册表**（配置型 / 注册型）的唯一装载口径。
 *
 * ## 为什么要有它（用户的架构洞见）
 *   "所谓 A/B 两臂，其实就是两个**沙箱**或**比赛区**。可不可以多放几个？这个**位**能不能做成
 *    **配置型/注册型**？"
 *   ⇒ 旧形态把"臂"写死成**两个固定槽位**（A=控制 / B=处理），于是：
 *     · 臂数扩不了（3 个臂没处声明）；
 *     · "臂 = 一个代/比赛区"这件事表达不出来（只有"控制组 vs 处理组"）；
 *     · 每条臂的**场地**（cwd 沙箱区）与**记忆库**（store）散在命令行里，没人记得住。
 *   ⇒ 现在：**一份注册表 = 一族臂**。每个臂一条：
 *     ```
 *     { "name": "A", "role": "control", "cwd": "<沙箱根>", "store": "<记忆库>",
 *       "preset": "<可选：preset 名或工具面声明>", "label": "<人读的说明>" }
 *     ```
 *   · `cwd`   = 这条臂的**沙箱/比赛区**（被测 agent 的工作目录）；
 *   · `store` = 这条臂的**记忆库**（与 cwd 分开，互不污染）；
 *   · `role`  ∈ `control`（对照）/ `treat`（处理）/ `gen`（一个**代**——同样是"处理"位，
 *     只是语义上表示"这是某一代进化后的臂"）；
 *   · `preset` = 可选的 preset 名或工具面声明（**自变量**的一种）；
 *   · `label` = 人读的一句话（报告里直接引用，免得回头看不懂这一臂是什么）。
 *
 * ## 向后兼容（硬要求）
 *   本模块**只在显式传了注册表时才被调用**（`--arms <file>`）⇒ 不传时两个消费方的行为
 *   **逐字不变**（用 `memory-effect-judge.mjs --selftest` 对拍基线证明）。
 *
 * ## 纪律
 *   · 校验从严：**绝不**因为少写一个字段就静默降级（缺 cwd/store/label 一律报错停下）；
 *   · 路径必须是**带盘符的绝对路径**（`D:/…` / `C:/…`）—— `/d/…` 这种 Git-Bash 风格会被
 *     win32 的 `path.isAbsolute` 判成绝对，但它**不是**被测 agent 能用的路径，必须拦下；
 *   · 读文件时**先剥 UTF-8 BOM**（本仓有"BOM 破坏 JSON.parse"的历史，见 dsh-profile-integrity）。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 注册表里允许的 role。★ `gen` = 一个"代"（结构性上仍是处理位）。 */
export const ARM_ROLES = ['control', 'treat', 'gen']

/**
 * ★ 注册表的 role → 判据机器的**结构角色**。
 *   判据机器只认识 `control`（对照，记忆库必须空）与 `treat`（处理，记忆库随 k 递增）；
 *   `gen`（一个代）在结构上就是处理位 ⇒ 映射成 `treat`。★ **打印时仍写原来的 role**
 *   （映射这件事必须看得见，不许把"gen"静默说成"treat"）。
 */
export const JUDGE_ROLE_OF = { control: 'control', treat: 'treat', gen: 'treat' }

/** 注册表相关的用法错误（消费方应把它变成 `usage()` ⇒ 退出码 2，而不是抛栈）。 */
export class ArmsRegistryError extends Error {
  constructor(msg) {
    super(msg)
    this.name = 'ArmsRegistryError'
  }
}

/** 带盘符的绝对路径（win32 口径：`D:/x` 或 `C:\x`）。 */
const DRIVE_ABS = /^[A-Za-z]:[\\/]/

/**
 * 校验并规范化一份注册表对象。
 * @param {unknown} raw 已 JSON.parse 的对象
 * @param {{where?:string, knownDims?:string[]}} opt
 * @returns {{arms:Array<{name:string,role:string,cwd:string,store:string,preset:string|null,label:string}>, controlled:string[]|null}}
 */
export function normalizeArmsRegistry(raw, { where = '注册表', knownDims = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArmsRegistryError(`${where} 顶层必须是对象`)
  if (!Array.isArray(raw.arms)) throw new ArmsRegistryError(`${where} 缺 arms 数组`)
  if (!raw.arms.length) throw new ArmsRegistryError(`${where} 的 arms 是空数组（至少要 1 个臂）`)

  const arms = raw.arms.map((a, i) => {
    const at = `${where} 第 ${i + 1} 个臂`
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ArmsRegistryError(`${at} 必须是对象`)
    const name = a.name
    if (typeof name !== 'string' || !name.trim()) throw new ArmsRegistryError(`${at} 缺非空 name`)
    if (!ARM_ROLES.includes(a.role)) throw new ArmsRegistryError(`${at}（${name}）的 role 只能是 ${ARM_ROLES.join(' / ')}；收到 ${JSON.stringify(a.role)}`)
    for (const k of ['cwd', 'store', 'label']) {
      if (typeof a[k] !== 'string' || !a[k].trim()) throw new ArmsRegistryError(`${at}（${name}）缺非空 ${k}（臂的场地 / 记忆库 / 人读说明都必须写清楚）`)
    }
    for (const k of ['cwd', 'store']) {
      if (!DRIVE_ABS.test(a[k])) {
        throw new ArmsRegistryError(`${at}（${name}）的 ${k} 必须是**带盘符的绝对路径**（用 D:/… 或 C:/… 而不是 /d/…）：${a[k]}`)
      }
    }
    if (a.preset !== undefined && a.preset !== null && typeof a.preset !== 'string') {
      throw new ArmsRegistryError(`${at}（${name}）的 preset 要么不写，要么是字符串；收到 ${JSON.stringify(a.preset)}`)
    }
    return {
      name: name.trim(),
      role: a.role,
      cwd: path.resolve(a.cwd),
      store: path.resolve(a.store),
      preset: a.preset === undefined || a.preset === null || a.preset === '' ? null : String(a.preset),
      label: a.label.trim(),
    }
  })

  const dupes = arms.map((a) => a.name).filter((n, i, all) => all.indexOf(n) !== i)
  if (dupes.length) throw new ArmsRegistryError(`${where} 的臂名重复：${[...new Set(dupes)].join(', ')}`)

  let controlled = null
  if (raw.controlled !== undefined) {
    if (!Array.isArray(raw.controlled) || !raw.controlled.length) {
      throw new ArmsRegistryError(`${where} 的 controlled 要么不写，要么是**非空**数组（空数组 = 没有任何受控量 = 判据被弱化）`)
    }
    if (knownDims) {
      const unknown = raw.controlled.filter((d) => !knownDims.includes(d))
      if (unknown.length) throw new ArmsRegistryError(`${where} 的 controlled 里有不认识的维度：${unknown.join(', ')}（只认识 ${knownDims.join(' / ')}）`)
    }
    if (new Set(raw.controlled).size !== raw.controlled.length) throw new ArmsRegistryError(`${where} 的 controlled 里有重复维度`)
    controlled = [...raw.controlled]
  }
  return { arms, controlled }
}

/** 读文本（剥 BOM）→ JSON。读不到 / 解析不了都抛 `ArmsRegistryError`。 */
export function parseArmsRegistryText(text, where = '注册表') {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let raw
  try {
    raw = JSON.parse(body)
  } catch (e) {
    throw new ArmsRegistryError(`${where} 不是合法 JSON：${e?.message ?? e}`)
  }
  return raw
}

/**
 * 从文件装载注册表。`file` 相对 `base` 解析（消费方各自传判据根）。
 * @param {string} file
 * @param {{base?:string, knownDims?:string[]}} opt
 */
export function loadArmsRegistry(file, { base = process.cwd(), knownDims = null } = {}) {
  const p = path.resolve(base, String(file))
  let text
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch (e) {
    throw new ArmsRegistryError(`读不到注册表 ${p}：${e?.message ?? e}`)
  }
  const { arms, controlled } = normalizeArmsRegistry(parseArmsRegistryText(text, `注册表 ${p}`), { where: `注册表 ${p}`, knownDims })
  return { file: p, arms, controlled }
}

/** 人读一行：`A=control@D:/project_develop/_abA/wt`（描述符里用，免得回头看不懂）。 */
export function describeArms(arms) {
  return arms.map((a) => `${a.name}=${a.role}@${a.cwd.replace(/\\/g, '/')}`).join('  ')
}
