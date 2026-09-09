/**
 * 版本化构建：不再原地构建/删除 lib。
 *
 * 问题：原地 `tsc -p tsconfig.json`（outDir=lib）会就地覆盖/删除在用 lib/*.js，
 * 运行中/启动中的进程句柄占用 → Windows EBUSY/EPERM → 切换引擎崩溃。
 *
 * 方案（不可变版本快照 + 别名翻转）：
 *   1. 编译到全新 out/<buildId>（同时覆盖 outDir 与 declarationDir，绝不触碰在用 lib）；
 *   2. 把 lib 翻成 junction -> out/<buildId>。junction 翻转只改目录项，已打开的句柄
 *      （指向旧 out/<旧Id>）不受影响，运行中进程也因 require 缓存不用重读 —— 安全。
 *   3. 一次性迁移：旧的真实 lib/（非 junction）只在干净停机点归档为 _lib_legacy_*，从不删除。
 */
import { execSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const buildId = 'b' + Date.now()
const outId = join(root, 'out', buildId)

if (!existsSync(outId)) mkdirSync(outId, { recursive: true })

// 1) 编到全新 out/<buildId>
execSync(`tsc -p tsconfig.json --outDir "out/${buildId}" --declarationDir "out/${buildId}/types"`, {
  stdio: 'inherit',
  cwd: root,
})

// 2) 把 lib 翻成 junction -> out/<buildId>
const libPath = join(root, 'lib')
if (existsSync(libPath)) {
  const st = lstatSync(libPath)
  if (st.isDirectory() && !st.isSymbolicLink()) {
    // 一次性迁移：真实目录 → 归档（必须在干净停机点执行；这里若失败说明仍有占用，退出保安全）
    const archive = join(root, `_lib_legacy_${buildId}`)
    renameSync(libPath, archive)
    console.log('[build] migrated legacy lib ->', archive)
  } else {
    // 已是 junction：仅移除目录项（open 句柄不受影响），再重建
    // 用 rmSync 移除 junction 本身（不跟随、不删目标）；失败即退出，绝不破坏在用 lib
    rmSync(libPath)
  }
}
symlinkSync(outId, libPath, 'junction')
console.log(`[build] ${buildId} done; lib -> out/${buildId}`)

// 3) 真实启动器 bin.cjs：compiled main.js 带 isMain 守卫（仅当它是直接 argv[1] 入口时才启动；
//    作为 import 进来的模块会静默跳过）。故不负责任何通过 junction/import 的间接入口。
//    bin.cjs（真实文件）用 child_process spawn 最新 out/<buildId>/main.js 作为【直接入口】运行。
const entryPath = join(root, 'bin.cjs')
writeFileSync(
  entryPath,
  `const { spawn } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const here = __dirname;
const outs = readdirSync(join(here, 'out')).filter((d) => d && d.startsWith('b')).sort();
const latest = outs[outs.length - 1];
if (!latest) { console.error('[switchboard] no builds under out/'); process.exit(1); }
const main = join(here, 'out', latest, 'main.js');
const child = spawn(process.execPath, [main], { stdio: 'inherit', env: process.env });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (c) => process.exit(c ?? 1));
`,
  'utf8',
)
console.log(`[build] wrote bin.cjs -> spawns out/${buildId}/main.js directly`)