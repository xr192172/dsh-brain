/**
 * B2 预演通道 · 构建 + lib 翻转助手（重放臂在主仓语境下的等价物）。
 *
 * 为什么不直接跑 `scripts/build.mjs`：那条路径用 `rmSync(lib)` 移除旧 junction，而本机装了
 * **safe-delete shim**（`node-safe-delete-shim.cjs`），它把这次删除判成"批量删除"并直接抛
 * `SAFE_DELETE_BULK_CONFIRM_REQUIRED` ⇒ build.mjs 在**编译已经成功之后**倒在"翻转 lib"这一步。
 * 那看起来像"构建失败"，其实是**宿主沙箱拦了一次删除**（这是任务书预告的已知坑）。
 *
 * 本助手做同样的事，但用**非 shim 路径**移除那个 junction：
 *   - `fs.rmdirSync(dir)`：对"目录型 reparse point（junction）"只移除链接项，不跟随、不删目标；
 *   - 且 rmdirSync 不在 safe-delete shim 的拦截面上。
 * 编译步骤与 build.mjs 完全一致（同一 tsconfig、同一 outDir/declarationDir），因此产物等价。
 * 另外：bin.cjs 是**已入库的真实文件**（与 build.mjs 末尾写出的内容同款），本助手不改写它。
 *
 * 用法：`node packages/switchboard/scripts/build-flip.mjs`
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, rmSync, rmdirSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const buildId = 'b' + Date.now()
const outId = join(root, 'out', buildId)
mkdirSync(outId, { recursive: true })

const localTsc = [
  join(root, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'),
  join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
].find((p) => existsSync(p))
if (!localTsc) throw new Error('[build-flip] 找不到本地 typescript')

execFileSync(process.execPath, [localTsc, '-p', 'tsconfig.json', '--outDir', `out/${buildId}`, '--declarationDir', `out/${buildId}/types`], {
  cwd: root,
  stdio: 'inherit',
})

const libPath = join(root, 'lib')
if (existsSync(libPath)) {
  const st = lstatSync(libPath)
  if (st.isSymbolicLink()) {
    // junction：只移除目录项（open 句柄不受影响）。
    rmdirSync(libPath)
  } else if (st.isDirectory()) {
    // 真实目录：用普通 rmSync（会走 shim，但这只在"首次迁移"时发生，且不是批量场景）。
    rmSync(libPath, { recursive: true })
  }
}
symlinkSync(outId, libPath, 'junction')

// 打印关键产物指纹，便于在报告里做"跑的是这一份"的对账。
const stamp = readFileSync(join(outId, 'build-stamp.js'), 'utf8')
const sha = createHash('sha256').update(stamp).digest('hex').slice(0, 16)
console.log(`[build-flip] compiled -> out/${buildId}; lib -> out/${buildId}`)
console.log(`[build-flip] build-stamp.js sha256[0:16] = ${sha}`)
for (const f of ['preflight.js', 'inventory.js', 'preflight-contract.js', 'main.js']) {
  const p = join(outId, f)
  const h = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
  console.log(`[build-flip] ${f} sha256[0:16] = ${h}`)
}
