/**
 * patch-anchors.mjs —— 上游补丁的**严格**锚点应用器（2026-09-15）
 *
 * ## 为什么需要它
 *
 * 各 `patch-*.mjs` 原先锚点找不到时只打印 `FAIL` / `WARN` 然后 `continue`，
 * **没有任何 `process.exit`** —— 而它们挂在 `postinstall`
 * ⇒ **上游一变，补丁静默失效，而没有任何人被告知。**
 * （实证：2026-09-14 上游把 boot 重构成 `profile-resolution/{service,resolver}.ts`，
 *  `patch-app-boot-bom.mjs` 引用的行号 `:412/:430/:551` 当场失效。）
 *
 * 这与本项目反复修的「假绿」是同一类失败 —— 保险自己失效。
 *
 * ## 三态判定（核心）
 *
 * 每处改动都判定成三种之一，**不再"找不到就算了"**：
 *
 * | 态 | 判据 | 处理 |
 * |---|---|---|
 * | `already` | 替换后的形态已在文件里 | 正常（幂等重跑的结果） |
 * | `pending` | 锚点在 | 应用它 |
 * | `missing` | **两者都不在** | **报错** —— 上游结构变了，或上次只打了一半 |
 *
 * ★ 为什么必须单独查 `missing`：旧版有个**隐蔽的假绿** ——
 *   若 helper 插进去了（其 MARK 命中）但后续 `edit` 没打上，
 *   之后每次运行都因 MARK 命中而整文件 `skip`，
 *   于是"有 helper、但没人调用它"= **毫无防护**，却永远显示"已打补丁"。
 *   三态判定能把这个状态抓出来（helper = already，edits = missing）。
 *
 * ## 用法
 *
 * ```js
 * import { applyAnchors, reportAndExit } from './patch-anchors.mjs'
 * const r = applyAnchors(file, [
 *   { id: 'helper', anchor: HELP_A, replace: HELPER + HELP_A, done: 'function parseJsonNoBom(' },
 *   { id: 'call-1', anchor: 'JSON.parse(readFileSync(installAnchor, "utf8"))', replace: 'readJsonManifest(installAnchor)' },
 * ])
 * reportAndExit('patch-xxx', [r])
 * ```
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 严格模式：锚点 missing ⇒ 非 0 退出。设 `DSH_PATCH_STRICT=0` 显式降级为仅告警。 */
export const STRICT = process.env.DSH_PATCH_STRICT !== '0'

/** pnpm 链接模式的实体根（`.pnpm/<目录名>/node_modules/<包>/…`）。 */
function defaultRoots() {
  return [
    path.join(process.cwd(), 'node_modules', '.pnpm'),
    path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '.pnpm'),
  ]
}

/**
 * ★★★ 2026-10-07 新增（升级到 pnpm **链接模式**后必需）：**在 `.pnpm` 里按包名解析实体**。
 *
 * ## 为什么需要它（本轮实测的静默失效）
 * 旧写法把目标路径**硬编码**成 `node_modules/@deepseek-ai/<包>/lib/index.js` ——
 * 那是 **hoisted 布局**下的路径。pnpm 换成链接模式后，**实体只在 `.pnpm/` 里**，
 * 顶层那个路径**根本不存在** ⇒ `applyAnchors` 报 `exists:false` ⇒
 * `reportAndExit` 走「该包未安装？跳过（不算失败）」⇒ **整脚本静默空转**。
 * ★ 实测：升级后 **5 个 patch 脚本全部空转，而 `postinstall` 退出码是 0**。
 *
 * ★ 只面向**新版布局**（按用户裁定 2026-10-07：旧版兼容性不考虑）。
 *
 * @param {string} pkg 包名，如 `@deepseek-ai/dsh-goal-round-driver`
 * @param {string} [rel] 包内相对路径
 * @returns {string[]} 命中的实体文件绝对路径（可能多个：本仓树 + profile 树）
 */
export function resolveEntities(pkg, rel = 'lib/index.js', roots = defaultRoots()) {
  const out = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'node_modules', pkg, rel)
      if (fs.existsSync(p)) out.push(p)
    }
  }
  return out
}


/**
 * 对单个文件应用一组锚点改动。
 *
 * @param {string} file
 * @param {Array<{id:string, anchor:string, replace:string, done?:string}>} edits
 *   `done` = 证明"已应用"的判别串（缺省用 `replace`）
 * @returns {{file:string, exists:boolean, skipped?:string, already:string[], applied:string[], missing:string[]}}
 */
export function applyAnchors(file, edits) {
  const out = { file, exists: true, already: [], applied: [], missing: [] }
  if (!fs.existsSync(file)) {
    out.exists = false
    return out
  }
  let c = fs.readFileSync(file, 'utf8')
  let wrote = false

  for (const e of edits) {
    const done = e.done ?? e.replace
    if (e.all) {
      // 替换**全部**出现。顺序要紧：只要锚点还在就必须继续替换 ——
      // 否则"改了一半"会被误判成 already（`done` 已存在），从此永远停在半成品。
      if (c.includes(e.anchor)) {
        const n = c.split(e.anchor).length - 1
        c = c.split(e.anchor).join(e.replace)
        out.applied.push(`${e.id}×${n}`)
        wrote = true
        continue
      }
      if (c.includes(done)) { out.already.push(e.id); continue }
      out.missing.push(e.id)
      continue
    }
    if (c.includes(done)) {
      out.already.push(e.id)
      continue
    }
    if (c.includes(e.anchor)) {
      c = c.replace(e.anchor, e.replace)
      out.applied.push(e.id)
      wrote = true
      continue
    }
    out.missing.push(e.id)
  }

  if (wrote) fs.writeFileSync(file, c, 'utf8')
  return out
}

/**
 * 汇报结果并在有 `missing` 时按严格模式退出。
 *
 * @param {string} label 补丁名（用于日志）
 * @param {Array} results applyAnchors 的返回值数组
 * @param {{quietOk?:boolean}} [opts]
 */
export function reportAndExit(label, results, opts = {}) {
  const existing = results.filter((r) => r.exists)
  if (!existing.length) {
    console.log(`[${label}] 未找到任何目标文件 —— 该包未安装？跳过（不算失败）`)
    return
  }

  let bad = 0
  for (const r of existing) {
    const bits = []
    if (r.applied.length) bits.push(`新打 ${r.applied.length} 处 (${r.applied.join(',')})`)
    if (r.already.length) bits.push(`已是最新 ${r.already.length} 处`)
    if (r.missing.length) bits.push(`★未命中 ${r.missing.length} 处 (${r.missing.join(',')})`)
    console.log(`[${label}] ${r.file}`)
    console.log(`           ${bits.join(' | ')}`)
    bad += r.missing.length
  }

  if (bad) {
    const msg =
      `[${label}] ✗ 有 ${bad} 处锚点未命中 —— 上游结构很可能已变。\n` +
      `           这些改动**没有生效**（不要以为打过补丁了）。\n` +
      `           处置：人工核对上游新结构并更新锚点；\n` +
      `           确认可忽略时可设 DSH_PATCH_STRICT=0 跳过此检查。`
    if (STRICT) {
      console.error(msg)
      process.exit(1)
    }
    console.warn(msg.replace('✗', '⚠') + '（DSH_PATCH_STRICT=0：仅告警）')
    return
  }
  if (!opts.quietOk) console.log(`[${label}] ✓ 全部锚点就位`)
}
