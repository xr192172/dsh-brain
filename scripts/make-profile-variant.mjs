#!/usr/bin/env node
/**
 * make-profile-variant.mjs —— 造一份**脑 profile 变体**（同 build、只少/多装配某个包）。
 *
 * 为什么需要它：本方向的实验轴是「**我们这一层**」（见 `docs/eval-challenger-arm.md` §11），
 * 而 switchboard **本来就支持按次指定 profile**（`?cmd=handover&profile=<name>`，
 * 见 `coordinator.handover(…, profileOverride, …)`）⇒ "能力开/关"两臂 = 两份 profile + 一次换代。
 *
 * 规矩（照 `topics/runtime-and-launch.md` / `guard.ts` 的 P2 边界）：
 *  · **绝不改 `profiles/web`**（它是 P2 安全层，护栏明令禁止就地修改）——本脚本只**新建**目标目录。
 *  · `disabled ≠ 移除`：控制"装不装"的是 `package.json` 的 `dsh.profile.bundles`（**决定装配**）
 *    与 `dependencies`（决定能不能解析）。两个都要动，缺一不可。
 *  · `node_modules` 用 **junction 指向源 profile 的**（不复制、不重装、零网络）。
 *
 * 用法：
 *   node scripts/make-profile-variant.mjs --from web --to web-notev --drop @dsh-brain/tool-evolution
 *   node scripts/make-profile-variant.mjs --from web --to web-notev --drop X --drop Y --force
 *   node scripts/make-profile-variant.mjs --list            # 列出所有 profile 与其 bundles 数
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PROFILES = 'C:/Users/Admin/.dsh/profiles'
const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i < 0 ? null : argv[i + 1]
}
const drops = argv.reduce((acc, a, i) => (a === '--drop' ? [...acc, argv[i + 1]] : acc), [])
/** `--drop-insert <loader-id>`：从 `cordis.patch.yml` 里删掉某个 `- insert:` 块。
 *  ★ 为什么必须有它（2026-09-20 实测）：能力可能有**两条**进工具的路径 ——
 *    包（bundle）+ profile 里 `- insert: id: mcp-client`（指向外部 MCP server）。
 *    只 drop bundle ⇒ 那个能力的工具**照样在**（实测：B 臂仍有 mcp__design-canvas__*）。 */
const dropInserts = argv.reduce((acc, a, i) => (a === '--drop-insert' ? [...acc, argv[i + 1]] : acc), []).filter(Boolean)

if (argv.includes('--list')) {
  for (const d of fs.readdirSync(PROFILES, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'node_modules') continue
    let n = '?'
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PROFILES, d.name, 'package.json'), 'utf8'))
      n = (j?.dsh?.profile?.bundles ?? []).length
    } catch {
      /* ignore */
    }
    console.log(`  ${d.name.padEnd(18)} bundles=${n}`)
  }
  process.exit(0)
}

const from = argOf('--from')
const to = argOf('--to')
if (!from || !to || (!drops.length && !dropInserts.length)) {
  console.error(
    '用法: --from <src> --to <dst> (--drop <包名> | --drop-insert <loader-id>) […] [--force]\n' +
      '  --drop         从 dependencies + dsh.profile.bundles 里摘掉包（断①「包」这条路）\n' +
      '  --drop-insert  从 profile 的 cordis.patch.yml 里删掉某个 `- insert:` 条目（断②「profile insert」这条路）\n' +
      '  ★ 一个能力可能【两条路都在】⇒ 两条都要断（见脚本头注释与 docs/eval-independent-variable-plan.md §1）',
  )
  process.exit(1)
}
const fromDir = path.join(PROFILES, from)
const toDir = path.join(PROFILES, to)
if (!fs.existsSync(fromDir)) {
  console.error(`源 profile 不存在: ${fromDir}`)
  process.exit(1)
}
if (fs.existsSync(toDir) && !argv.includes('--force')) {
  console.error(`目标已存在（要覆盖加 --force）: ${toDir}`)
  process.exit(1)
}

// ① 复制定义文件（不碰 node_modules）
fs.mkdirSync(toDir, { recursive: true })
const DEF_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']
for (const f of DEF_FILES) {
  const s = path.join(fromDir, f)
  if (!fs.existsSync(s)) continue
  fs.copyFileSync(s, path.join(toDir, f))
  console.log(`  复制 ${f}`)
}

// ② 从 dependencies + dsh.profile.bundles 里删掉要 drop 的包
const pkgPath = path.join(toDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const removed = []
for (const d of drops) {
  if (pkg.dependencies?.[d]) {
    delete pkg.dependencies[d]
    removed.push(`dependencies:${d}`)
  }
  const b = pkg?.dsh?.profile?.bundles
  if (Array.isArray(b)) {
    const i = b.indexOf(d)
    if (i >= 0) {
      b.splice(i, 1)
      removed.push(`bundles:${d}`)
    }
  }
}
// 名字区分开，免得到处认错 profile
pkg.name = String(pkg.name ?? 'dsh-profile').replace(/-[^-]*$/, '') + `-${to}`
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.variantOf = from
pkg.dsh.profile.dropped = drops
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`  改 package.json：移除 ${removed.length} 处（deps+bundles 各一次才算干净）`)
for (const r of removed) console.log(`    - ${r}`)
if (removed.length !== drops.length * 2) {
  console.warn(`  ⚠ 期望移除 ${drops.length * 2} 处，实际 ${removed.length} 处 —— 检查包名拼写`)
}

// ②b 从 `cordis.patch.yml` 里删掉指定的 `- insert:` 块（行级手术；块 = `- insert:` 到下一个**顶格**行为止）
/**
 * 把一个 YAML 顶层数组切成若干「块」。每块 = 一条以顶格 `-` 开头的条目，
 * 到下一个顶格行为止。这里只关心 `- insert:` 这种块。
 * ★ 2026-09-21 修 bug：旧实现用 `findIndex` 拿**第一个** `- insert:` 块 ⇒
 * 一旦 profile 里出现**第二个** `- insert:`（很自然会发生在加第二个 MCP 时），
 * `--drop-insert` 就会去删第一个块里的 id ⇒ 目标没删掉、还误报"块里没有该 id"。
 * 现在改成「**按 id 找到它所属的那个块**」。
 */
function findInsertBlocks(lines) {
  const heads = []
  for (let i = 0; i < lines.length; i++) if (/^-\s*insert:\s*$/.test(lines[i])) heads.push(i)
  return heads.map((i0) => {
    let i1 = lines.length
    for (let i = i0 + 1; i < lines.length; i++) {
      const l = lines[i]
      if (l.trim() === '') continue
      if (!/^[ \t]/.test(l)) {
        i1 = i
        break
      }
    }
    const entryStarts = []
    for (let k = i0; k < i1; k++) {
      const m = /^\s*-\s*id:\s*(\S+)/.exec(lines[k])
      if (m) entryStarts.push({ k, id: m[1] })
    }
    return { i0, i1, entryStarts, ids: entryStarts.map((e) => e.id) }
  })
}

if (dropInserts.length) {
  const ymlPath = path.join(toDir, 'cordis.patch.yml')
  if (!fs.existsSync(ymlPath)) {
    console.warn('  ⚠ 没有 cordis.patch.yml，--drop-insert 无从下手')
  } else {
    const lines = fs.readFileSync(ymlPath, 'utf8').split('\n')
    const done = []
    for (const target of dropInserts) {
      // ★ 每次都**重新切块**（上一轮已经改了 lines）
      const blocks = findInsertBlocks(lines)
      if (!blocks.length) {
        console.warn(`  ⚠ 没找到 \`- insert:\` 块（无法删 ${target}）`)
        continue
      }
      const blk = blocks.find((b) => b.ids.includes(target))
      if (!blk) {
        console.warn(
          `  ⚠ 没有哪个 insert 块含 ${target}（共 ${blocks.length} 块，块内 id：` +
            `${blocks.map((b) => '[' + (b.ids.join(', ') || '(无)') + ']').join(' ')}）`,
        )
        continue
      }
      if (blk.ids.length === 1) {
        // 只有一个条目 ⇒ 整块删掉
        lines.splice(blk.i0, blk.i1 - blk.i0)
        console.log(`  删 insert 块（整块，唯一 id=${target}）`)
      } else {
        // 多个条目 ⇒ 只删那一条（从它的 `- id:` 到下一个条目）
        const at = blk.entryStarts.findIndex((e) => e.id === target)
        const from = blk.entryStarts[at].k
        const to = at + 1 < blk.entryStarts.length ? blk.entryStarts[at + 1].k : blk.i1
        // 回退到它上面的注释/空行也算它的
        let from2 = from
        while (from2 > blk.i0 && /^\s*(#|$)/.test(lines[from2 - 1])) from2--
        lines.splice(from2, to - from2)
        console.log(`  删 insert 条目（块内 ${blk.ids.length} 条，只删 ${target}）`)
      }
      done.push(target)
    }
    fs.writeFileSync(ymlPath, lines.join('\n'), 'utf8')
    // 自证①：目标 id 必须不在了（读回磁盘，不信内存）
    const after = fs.readFileSync(ymlPath, 'utf8')
    const stillThere = dropInserts.filter((d) => new RegExp(`^\\s*-\\s*id:\\s*${d}\\s*$`, 'm').test(after))
    console.log(`  自证①：目标 id 是否仍存在 = ${stillThere.length ? stillThere.join(', ') + '（✗ 没删掉）' : '无 ✓'}`)
    // 自证②：**别的** insert 块不能被我误删（块数应等于 原块数 - 唯一 id 的整块删除数）
    const afterBlocks = findInsertBlocks(after.split('\n'))
    console.log(
      `  自证②：剩余 insert 条目 id = ${afterBlocks.flatMap((b) => b.ids).join(', ') || '(无)'}` +
        `（应恰好等于「原有 id 集 - ${done.join(',')}」）`,
    )
    // 记账：把"断了哪条 insert"写进 package.json（否则事后没人知道这个变体是怎么造的）
    const pkg2 = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    pkg2.dsh.profile.droppedInserts = done
    fs.writeFileSync(pkgPath, JSON.stringify(pkg2, null, 2) + '\n', 'utf8')
  }
}

// ③ node_modules 用 junction 指向源 profile（零复制、零安装）
const nmTo = path.join(toDir, 'node_modules')
const nmFrom = path.join(fromDir, 'node_modules')
if (!fs.existsSync(nmTo) && fs.existsSync(nmFrom)) {
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', nmTo.replace(/\//g, '\\'), nmFrom.replace(/\//g, '\\')], {
    encoding: 'utf8',
  })
  console.log(r.status === 0 ? '  node_modules = junction → 源 profile ✓' : `  ⚠ junction 失败: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`)
}

console.log(`\n已造好 profile 变体：${toDir}`)
console.log(`用它起一代（控制面）：curl "http://127.0.0.1:31800/?cmd=handover&profile=${to}"`)
console.log(`验"没装"的判据：新 gen 的 boot.log 里**不应**出现该包的启动行（例如 tool-evolution 的 '[tool-evolution] apply running'）`)
