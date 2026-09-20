#!/usr/bin/env node
/**
 * lib-safe-fs.mjs —— 「删之前先判存在」（回执 B4 的落地）
 *
 * ## 崩法（实测，见 docs/receipt-to-main-2026-09-20.md §B4）
 *
 * 宿主会经 `NODE_OPTIONS=--require …/node-safe-delete-shim.cjs` 接管 fs 的删除 API。
 * 该 shim 在 `tryTrash()` 失败时 **fail-closed 直接抛**（源码注释原文：
 * 「失败时抛错，不调 orig（fail-closed）」）。于是「删一个已经不存在的临时文件」
 * 这种本来无所谓的事，会把整个门打成崩溃退出 —— regression 红，人工跑不复现。
 *
 * 实测（`node out/probe-safe-delete.mjs`，2026-09-20，本会话）：
 *   - `fs.unlinkSync(不存在)`  ⇒ 抛 ENOENT，栈顶就是 node-safe-delete-shim.cjs
 *   - `fs.unlinkSync(已删过的同一路径)` ⇒ 同上（第二次删 = 幂等场景，仍炸）
 *
 * ## 所以这里只有两条纪律
 *
 *   ① **先判存在** —— 不存在就什么都不做。这是幂等，不是偷懒。
 *   ② **删失败也不许把门带崩** —— 清不掉临时文件是**环境卫生**问题，不是判据结论。
 *      谁若真要断言「夹具必须没残留」，请在断言里查 `removeIfExists` 的返回值 /
 *      `fs.existsSync`，而不是靠一次删除调用炸出来。
 *
 * ★ 只在 `scripts/**` 内使用。删的是各门**自己的临时夹具**，不涉及运行数据。
 */
import fs from 'node:fs'

/**
 * 删一个文件或目录树（不存在则安静跳过）。
 *
 * @param {string} target 文件或目录路径
 * @param {{ quiet?: boolean }} [opts] quiet=true 时不打 stderr 提示
 * @returns {boolean} true = 真的删了；false = 本就不存在，或删除失败（已提示）
 *
 * 为什么不复现原先各处的 `unlinkSync` / `rmSync` 两种写法：
 * `rmSync(p, { recursive: true, force: true })` 对文件和目录都成立，
 * 少一种分支就少一处「改了一半」的可能。
 */
export function removeIfExists(target, opts = {}) {
  try {
    if (!fs.existsSync(target)) return false
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch (e) {
    if (!opts.quiet) console.error(`[lib-safe-fs] 清理临时文件失败（不致命，继续跑）：${target} — ${e.message}`)
    return false
  }
}

export default removeIfExists
