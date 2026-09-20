/**
 * check-config-tolerance.mjs —— 插件配置「无配置健壮性」门禁（2026-09-15）
 *
 * ## 为什么需要它（一次真事故）
 *
 * gen-3083 于 2026-09-14 08:25 启动即 `EXIT code=1`，根因是 `capability-bridge` 的
 * `cordis.patch.yml` 漏写 `config:` ⇒ loader 传 `undefined` ⇒ 插件 `Config = z.object({...})`
 * 抛 `ValidationError: expected object, received undefined` ⇒ **整棵插件树装配失败**。
 * 更隐蔽的是：换代接口当时仍报 `success`（另一个保险盲区，同日单独修）。
 *
 * ## 这个门禁断言什么
 *
 * 取**真实构建产物**（`packages/<pkg>/lib/index.js`）里的 `Config`，
 * 经 cordis 的**真实** `resolveConfig(runtime, config)`（＝ `Config["~standard"].validate(x)`
 * 加抛错逻辑；已确认与上游逐字同一份实现）喂 5 种输入：
 *
 * | 输入 | 期望 |
 * |---|---|
 * | `undefined`（缺 config 块） | **通过**，且**字段默认值全部生效** |
 * | `null`                   | **通过**，且字段默认值全部生效 |
 * | `{}`                     | 通过，默认值生效 |
 * | 值正确                    | 通过，值被保留 |
 * | **值类型错**              | **必须报错**（防「无脑吞掉配置」的过度修复） |
 *
 * ★ 第 1、2 行的「且默认值生效」是关键：`.default({})` 也能让 `undefined` "通过"，
 * 但它短路内层解析、返回字面量 `{}`，使所有字段变成 `undefined` —— 比崩更隐蔽。
 * 所以本脚本**同时检查字段值**，而不只看"有没有抛错"。
 *
 * ★ 最后一行同样关键：修复不能把校验变成橡皮图章。
 *
 * 用法：node scripts/check-config-tolerance.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:/project_develop/dsh-brain'

/**
 * ★ 优先用 cordis **真实的** `resolveConfig`，而不是脚本自己仿写一份。
 *
 * 理由：仿写会与上游实现漂移。真实实现里那三行（`~standard.validate` → 异步拒 →
 * `issues` ⇒ 抛 `ValidationError`）就是 gen-3083 崩溃的同一段代码；调它等于调生产路径。
 * 若导入失败（例如 cordis 未安装）才退回仿写版，并**明说**这是降级模式。
 */
let realResolveConfig = null
try {
  const cordis = await import(
    pathToFileURL(path.join(ROOT, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href
  )
  if (typeof cordis.resolveConfig === 'function') realResolveConfig = cordis.resolveConfig
} catch {
  /* 降级到仿写版 */
}
const PKGS = [
  'capability-bridge',
  // ★ 2026-09-20 移除 'conveyor-context'：该包由用户**有意删除**
  //   （自研上下文层放弃，改用回**上游自带的** `dsh-compaction*` 一套）
  //   ⇒ 它的产物不存在是**预期**，继续期望它存在就是过时的判据。
  'design-canvas-bridge',
  'key-pool-proxy',
  'subagent-council',
  'tool-evolution',
  'switchboard',
]

let pass = 0
let fail = 0
const failures = []
const ok = (name) => {
  pass++
  console.log('  ok   ' + name)
}
const bad = (name, detail) => {
  fail++
  failures.push(`${name} — ${detail}`)
  console.log('  FAIL ' + name + ' — ' + detail)
}

/**
 * cordis 的 resolveConfig 走的就是这条：`Config["~standard"].validate(config)`。
 *
 * 优先转发给**真实的** cordis `resolveConfig`（见文件头），只在它不可用时才用本地仿写。
 * 两者行为一致；用真件是为了让门禁与生产路径**同一份实现**，杜绝漂移。
 */
function cordisResolve(Config, config) {
  if (realResolveConfig) return realResolveConfig({ Config }, config)
  const result = Config['~standard'].validate(config)
  if ('then' in result) throw new TypeError('async config validation not supported')
  if (result.issues) throw new Error('ValidationError')
  return result.value
}

/** 找出所有值为 undefined 的字段（`.default({})` 陷阱的探测器）。 */
function undefinedFields(v) {
  if (v === null || typeof v !== 'object') return []
  return Object.entries(v)
    .filter(([, val]) => val === undefined)
    .map(([k]) => k)
}

/**
 * 剥掉 `tolerantConfig` 的 preprocess 外壳，取回内层 `z.object`。
 *
 * zod 把 `z.preprocess(fn, S)` 编成 **pipe**：内层 S 在 `def.out`。
 * 若直接内省外壳的 `def.shape` 会拿到 undefined（本脚本第一版就栽在这），
 * 于是"坏值"用例会因探不到字段名而退化成只发一个未知键 —— 而未知键是被**忽略**而非
 * 拒绝的，导致假失败。这里显式下钻。
 */
function innerObject(schema) {
  const d = schema?.def ?? schema?._def
  if (!d) return null
  if (d.type === 'object' && d.shape) return schema
  // preprocess / pipe：内层在 out
  if (d.out) return innerObject(d.out)
  return null
}

/** 取内层 object schema 的**全部字段名**（不论有无默认值）—— 键集合比对的基准。 */
function shapeKeys(schema) {
  try {
    const obj = innerObject(schema)
    const shape = obj?.def?.shape ?? obj?._def?.shape
    if (shape) return Object.keys(shape)
    const dict = schema?.dict
    if (dict && typeof dict === 'object') return Object.keys(dict)
    return null
  } catch {
    return null
  }
}

/** 取内层 object schema 里"声明了默认值"的字段 → 默认值。 */
function declaredDefaults(schema) {
  try {
    // —— 路径 A：zod（含 tolerantConfig 的 preprocess 外壳）——
    const obj = innerObject(schema)
    const shape = obj?.def?.shape ?? obj?._def?.shape
    if (shape) {
      const out = {}
      for (const [k, f] of Object.entries(shape)) {
        const fd = f?.def ?? f?._def
        const dv = fd?.defaultValue
        if (typeof dv === 'function') {
          try {
            out[k] = dv()
          } catch {
            /* 默认值需要参数时跳过 */
          }
        } else if (dv !== undefined) out[k] = dv
      }
      return Object.keys(out).length ? out : null
    }
    // —— 路径 B：@deepseek-ai/schemastery（`schema.dict[field].meta.default`）——
    const dict = schema?.dict
    if (dict && typeof dict === 'object') {
      const out = {}
      for (const [k, f] of Object.entries(dict)) {
        const dv = f?.meta?.default
        if (dv !== undefined) out[k] = dv
      }
      return Object.keys(out).length ? out : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * 断言"所有声明过的字段都出现在了结果里"。
 *
 * ★ 为什么不能只看"值是不是 undefined"：`.default({})` 陷阱对 `undefined` 输入返回
 * **字面量 `{}`** —— 空对象里没有任何"值为 undefined 的字段"，
 * 于是"扫 undefined"这种检查会**空过**（本脚本第一版就漏过）。
 * ⇒ 必须做**键集合比对**（declared keys vs result keys）。
 */
function assertAllDefaultsApplied(pkg, label, value, defaults, shapeKeys) {
  const expected = shapeKeys ?? (defaults ? Object.keys(defaults) : null)

  if (value === null || typeof value !== 'object') {
    bad(`${pkg} · ${label} · 字段默认值生效`, `结果不是对象：${JSON.stringify(value)}`)
    return
  }

  if (expected && expected.length > 0) {
    const missing = expected.filter((k) => !(k in value))
    if (missing.length > 0) {
      bad(
        `${pkg} · ${label} · 字段默认值生效`,
        `字段缺失：${missing.join(', ')}（疑似 .default({}) 短路了内层解析）`,
      )
      return
    }
  }

  const undef = undefinedFields(value)
  if (undef.length > 0) {
    bad(`${pkg} · ${label} · 字段默认值生效`, `以下字段为 undefined：${undef.join(', ')}`)
    return
  }

  ok(`${pkg} · ${label} · 字段默认值生效`)
}

console.log('== 插件配置「无配置健壮性」门禁 ==')
console.log(
  realResolveConfig
    ? '  路径：cordis 真实 resolveConfig(runtime, config)（与生产逐字同一份实现）'
    : '  ⚠️ 降级：未导入到 cordis，使用本地仿写 resolveConfig（与生产同逻辑但非同实现）',
)
console.log('')

for (const p of PKGS) {
  const libDir = path.join(ROOT, 'packages', p, 'lib')
  let entry = path.join(libDir, 'index.js')
  if (!fs.existsSync(entry)) entry = path.join(libDir, 'main.js')
  if (!fs.existsSync(entry)) {
    bad(`${p} · 产物存在`, `未找到 ${entry}（先构建该包）`)
    continue
  }

  let mod
  try {
    mod = await import(pathToFileURL(entry).href)
  } catch (e) {
    bad(`${p} · 可导入`, e.message.slice(0, 120))
    continue
  }
  const Config = mod.Config
  if (!Config || !Config['~standard']) {
    // 没有 Config 的包（不需要配置）天然免疫 —— 记为通过但不虚报。
    ok(`${p} · 无 Config（不需要配置，天然免疫）`)
    continue
  }

  const defaults = declaredDefaults(Config)
  const keys = shapeKeys(Config)
  if (!keys) {
    bad(`${p} · 内省出字段集`, '无法从 schema 读到字段名（门禁会退化，宁可报出来）')
  }

  // ① ★ 缺 config 块（真事故输入）—— 必须通过且默认值生效
  for (const [label, input] of [
    ['缺 config（undefined）', undefined],
    ['config: null', null],
  ]) {
    let v
    try {
      v = cordisResolve(Config, input)
    } catch (e) {
      bad(`${p} · ${label}`, `仍抛错（会崩 gen）: ${e.message.slice(0, 90)}`)
      continue
    }
    ok(`${p} · ${label} · 不抛错`)
    // 内省失败时**不要**报"字段默认值生效" —— 那是无知的空过（本门禁的第一版漏过 .default({})）。
    if (keys) assertAllDefaultsApplied(p, label, v, defaults, keys)
    else bad(`${p} · ${label} · 字段默认值生效`, '无法内省字段集，此项**未能验证**（不假装通过）')
  }

  // ② 空对象
  try {
    const v = cordisResolve(Config, {})
    ok(`${p} · config: {} · 不抛错`)
    if (keys) assertAllDefaultsApplied(p, 'config: {}', v, defaults, keys)
    else bad(`${p} · config: {} · 字段默认值生效`, '无法内省字段集，此项**未能验证**（不假装通过）')
  } catch (e) {
    bad(`${p} · config: {}`, e.message.slice(0, 90))
  }

  // ③ 显式值应被保留（不能因为归一化把用户配置吃掉）
  if (defaults) {
    const pick = Object.entries(defaults).find(([, dv]) => ['number', 'boolean', 'string'].includes(typeof dv))
    if (pick) {
      const [k, dv] = pick
      const probe = typeof dv === 'number' ? dv + 1 : typeof dv === 'boolean' ? !dv : dv + '_x'
      try {
        const v = cordisResolve(Config, { [k]: probe })
        if (v[k] === probe) ok(`${p} · 显式值保留（${k}=${JSON.stringify(probe)}）`)
        else bad(`${p} · 显式值保留`, `${k} 期望 ${JSON.stringify(probe)}，实得 ${JSON.stringify(v[k])}`)
      } catch (e) {
        bad(`${p} · 显式值保留`, e.message.slice(0, 90))
      }
    } else {
      ok(`${p} · 显式值保留（跳过：无可构造的标量字段）`)
    }
  }

  // ④ ★ 反向：坏值必须仍被拒绝（防"过度修复成橡皮图章"）
  //    注意语义：**未知键会被 zod 忽略（strip）而非拒绝**，所以这里必须构造
  //    "已知字段 + 错误类型"才是有效用例 —— 只发未知键测不出任何东西（第一版栽在此）。
  {
    const bogus = bogusOf(defaults)
    if (!bogus) {
      // 该 schema 没有可用于构造错误值的字段（例如全是 enum / 数组）。**如实跳过，不虚报通过。**
      ok(`${p} · 坏值仍被拒绝（跳过：无可构造类型错的标量字段）`)
    } else {
      let rejected = false
      try {
        cordisResolve(Config, bogus)
      } catch {
        rejected = true
      }
      if (rejected) ok(`${p} · 坏值仍被拒绝（${JSON.stringify(bogus)}）`)
      else bad(`${p} · 坏值仍被拒绝`, `类型错误被静默接受：${JSON.stringify(bogus)}（校验已成橡皮图章）`)
    }
  }

  console.log('')
}

/**
 * 造一个"已知字段 + 类型必然错"的值。
 * 只挑标量（number/boolean/string）字段，因为对象/数组/enum 的"错值"不好构造。
 * 返回 `null` 表示无法构造 —— 调用方应如实跳过，而不是假装通过。
 */
function bogusOf(defaults) {
  if (!defaults) return null
  for (const [k, v] of Object.entries(defaults)) {
    if (typeof v === 'number') return { [k]: 'not-a-number' }
    if (typeof v === 'boolean') return { [k]: 'not-a-boolean' }
    if (typeof v === 'string') return { [k]: 12345 }
  }
  return null
}

console.log('=========================================')
console.log(`结果：${pass} passed, ${fail} failed`)
if (failures.length) {
  console.log('')
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
