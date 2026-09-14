/**
 * probe-dc-cold-start.mjs —— 冷启动路径体检：把真实项目源码复制到临时目录，
 * 计时 `ensureProjectIndex`（空库 → 冷启 bootstrap）并报告各阶段。
 *
 * 为什么要复制：**绝不碰真实项目的 cache.db**（那是别人的索引），
 * 同时又能对真实规模（几百个文件）测出诚实数字。
 *
 * 用法：
 *   node scripts/probe-dc-cold-start.mjs [srcDir] [--max 2000]
 *   默认 srcDir = D:/project_develop/design-canvas/src
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const srcArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `${DC}/src`
const maxArg = process.argv.indexOf('--max')
const maxFiles = maxArg > 0 ? Number(process.argv[maxArg + 1]) : undefined

const { ensureProjectIndex } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)
const { openDb } = await import(`file:///${DC}/dist/src/db/db.js`)

const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.go', '.py', '.java', '.rs', '.cs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])

/** 复制源码树（只带源码文件与常见配置，模拟"选定项目"） */
function copyTree(from, to) {
  let copied = 0
  const walk = (d) => {
    let es = []
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const p = path.join(d, e.name)
      const rel = path.relative(from, p)
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue
        walk(p)
      } else if (EXTS.has(path.extname(e.name)) || /^(tsconfig|package)\.json$/.test(e.name)) {
        const dst = path.join(to, rel)
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(p, dst)
        copied++
      }
    }
  }
  walk(from)
  return copied
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-'))
const t0 = Date.now()
const copied = copyTree(path.resolve(srcArg), root)
const copyMs = Date.now() - t0

const t1 = Date.now()
const { db, report, state } = await ensureProjectIndex(root, maxFiles ? { maxFiles } : {})
const bootMs = Date.now() - t1

const files = db.prepare('SELECT COUNT(*) c FROM files').get().c
const nodes = db.prepare('SELECT COUNT(*) c FROM nodes').get().c
const edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c

// 二次调用（索引已在）——验证"零开销"路径
const t2 = Date.now()
const again = await ensureProjectIndex(root)
const againMs = Date.now() - t2

const lines = [
  `冷启动体检 —— 源：${path.resolve(srcArg)}（复制 ${copied} 文件到临时目录）`,
  `  复制耗时      : ${copyMs}ms`,
  `  ★ 冷启 bootstrap: ${bootMs}ms（${state}）`,
  `  索引结果      : files=${files} nodes=${nodes} edges=${edges}`,
  `  冷启报表      : bootstrapped=${report.bootstrapped} truncated=${report.truncated} failed=${report.failed} checked=${report.checked}`,
  `  ★ 二次调用    : ${againMs}ms（state=${again.state}，应≈0 且无重同步）`,
  `  吞吐          : ${(files / Math.max(1, bootMs) * 1000).toFixed(1)} 文件/秒`,
]
fs.mkdirSync('D:/project_develop/dsh-brain/out', { recursive: true })
fs.writeFileSync('D:/project_develop/dsh-brain/out/cold-start.txt', lines.join('\n'), 'utf8')
console.log(lines.join('\n'))

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch {
  /* Windows 占用留给 OS */
}
