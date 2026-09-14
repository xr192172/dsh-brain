/**
 * probe-dc-write-through.mjs —— 「改完**立刻**读，索引知道吗？」
 *
 * 回答用户 2026-09-14 的设计问题：
 *   「通过了我们这个工具修改了以后的……能不能监视这些工具？改了的部分才是改了，
 *     就不需要说后台那样做。」
 *
 * 对拍同一个改动（把被引用最多的符号改名），两条路径，各自**改完立刻**问索引三个问题：
 *   ① `not_fresh`：有已索引文件与磁盘不一致吗？（= 索引落后于磁盘）
 *   ② `edges_to_old`：**旧名**的入边还剩多少？（= find_references / impact 会给出的答案，
 *      而磁盘上那个名字已经不存在了 —— 这一条是 LLM 真正会看到的东西）
 *   ③ `stale_resolved`：有"声称 resolved 但目标名已不在索引"的行吗？（漏报信号）
 *
 *   A) **经写入闸**（`write_gate.writeSourceFiles`）：写前快照 → 真写 → 写穿 + 重开引用方
 *   B) **绕过闸**（直接 `fs.writeFileSync`）→ 再用读路径保鲜（`ensureFreshIndex`）兜
 *
 * ★ 指标口径的坑（值得记下来）：B 在"刚写完但还没重同步"时 `stale_resolved` 是 **0** ——
 *   因为索引里的旧节点还在（没人动它），所以旧引用仍然"连得上"。
 *   此时真正的谎言是 ①/②：**索引落后于磁盘，find_references 会给出改名前的老答案**。
 *   `stale_resolved` 只在"重同步把旧节点删掉、却没重开引用"时才出现 —— 那是另一类故障
 *   （见 probe-dc-watch-refresh.mjs）。两件事别混。
 *
 * 用法：node scripts/probe-dc-write-through.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DC = 'D:/project_develop/design-canvas'
const src = `${DC}/src`
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const SKIP = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'build', 'out'])

const { openDb } = await import(`file:///${DC}/dist/src/db/db.js`)
const { ensureFreshIndex } = await import(`file:///${DC}/dist/src/tools/index_freshness.js`)
const { writeSourceFiles, recordSelfWrite, pendingSelfWrites } = await import(
  `file:///${DC}/dist/src/tools/write_gate.js`
)

function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const p = path.join(from, e.name)
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue
      copyTree(p, path.join(to, e.name))
    } else if (EXTS.has(path.extname(e.name))) {
      fs.mkdirSync(path.dirname(path.join(to, e.name)), { recursive: true })
      fs.copyFileSync(p, path.join(to, e.name))
    }
  }
}

async function freshCopy(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wt-${tag}-`))
  copyTree(src, root)
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'))
  const t0 = Date.now()
  await ensureFreshIndex(db, root)
  const coldMs = Date.now() - t0

  const one = (sql, ...a) => db.prepare(sql).get(...a).c
  const notFresh = () => {
    const rows = db.prepare('SELECT path, size, modified_at FROM files').all()
    let n = 0
    for (const r of rows) {
      try {
        const st = fs.statSync(path.join(root, r.path))
        if (st.size !== r.size || Math.round(st.mtimeMs) !== r.modified_at) n++
      } catch {
        /* 磁盘上没有 → 另一类 */
      }
    }
    return n
  }
  const stale = () =>
    one(`SELECT COUNT(*) c FROM unresolved_refs u
         WHERE u.status='resolved' AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.name = u.reference_name)`)

  const pick = db
    .prepare(
      `SELECT n.name AS nm, n.file_path AS f, COUNT(*) AS c
       FROM edges e JOIN nodes n ON n.id = e.target
       WHERE instr(e.target,'#')>0 AND e.source != e.target
         AND EXISTS (SELECT 1 FROM unresolved_refs u WHERE u.reference_name = n.name AND u.status='resolved')
       GROUP BY e.target ORDER BY c DESC LIMIT 1`,
    )
    .get()

  /** 指向某个符号名的入边数（= find_references 会给 LLM 的答案） */
  const edgesTo = (nm) =>
    one(`SELECT COUNT(*) c FROM edges e JOIN nodes n ON n.id = e.target WHERE n.name = ?`, nm)

  return { root, db, coldMs, stale, notFresh, edgesTo, pick, files: one('SELECT COUNT(*) c FROM files') }
}

function renameIn(f, root, nm, suffix) {
  const abs = path.join(root, f)
  const s = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, s.replace(new RegExp(`\\b${nm}\\b`, 'g'), `${nm}${suffix}`), 'utf8')
}

const line = (label, s) =>
  console.log(
    `   ${label}  ① 未保鲜 ${String(s.notFresh()).padStart(3)} ｜ ② 旧名「${s.pick.nm}」入边 ${String(
      s.edgesTo(s.pick.nm),
    ).padStart(3)} ｜ ③ 陈旧断言 ${String(s.stale()).padStart(3)}`,
  )

console.log('「改完立刻读，索引知道吗」对拍 —— 源：' + src)
console.log(`（同一个改动：把 ${''}被引用最多的符号改名；三列都是**改完立刻**测的）`)
console.log('')

// ── A：经写入闸 ──
const A = await freshCopy('gate')
console.log(`A) 经写入闸 writeSourceFiles（索引 ${A.files} 文件，冷启 ${A.coldMs}ms）`)
console.log(`   靶子：${A.pick.f} 的 \`${A.pick.nm}\`（基线入边 ${A.edgesTo(A.pick.nm)}）`)
const tA = Date.now()
const ra = await writeSourceFiles(A.root, [A.pick.f], () => renameIn(A.pick.f, A.root, A.pick.nm, '_viaGate'), {
  label: 'probe: rename via gate',
})
const msA = Date.now() - tA
line(`闸内 ${msA}ms ｜ 同步 ${ra.report.index?.synced} 文件 ｜ 重开引用 ${ra.report.index?.refsReopened} 条 ｜ 快照 ${ra.report.snapshot?.id ? '已建' : '无'}`, A)
console.log('   ⇒ 三列全 0：索引与磁盘一致，LLM 下一步读到的就是真实状态')
A.db.close()
console.log('')

// ── B：绕过闸 ──
const B = await freshCopy('bypass')
console.log(`B) 绕过闸：直接 fs.writeFileSync（索引 ${B.files} 文件，冷启 ${B.coldMs}ms）`)
console.log(`   靶子：${B.pick.f} 的 \`${B.pick.nm}\`（基线入边 ${B.edgesTo(B.pick.nm)}）`)
renameIn(B.pick.f, B.root, B.pick.nm, '_bypass')
line('写盘 ~0ms ｜ 无快照 ｜ 无登记', B)
console.log('   ⇒ ①=1 且 ② 仍等于基线：索引不知道改了，find_references 会把 LLM 指向**已不存在的旧名**')
console.log(`   待消费自写登记：${pendingSelfWrites(B.root).length}（没人登记过这次改动）`)

// L3 兜底：读路径保鲜
const tR = Date.now()
await ensureFreshIndex(B.db, B.root)
const msR = Date.now() - tR
line(`读路径保鲜 ${msR}ms（L3 兜底）`, B)
console.log('   ⇒ ①归零；②旧名入边归零、③仍为 0 —— 因为保鲜路径会**重开引用方**再重解析')
console.log('')

console.log('结论：')
console.log('  · 差别不是"快慢"，而是**索引有没有撒谎**。经闸后 LLM 下一步读到的即真实状态；')
console.log('    绕过闸后它会把 LLM 指向已不存在的旧名（②那一列就是 find_references 会给的答案）。')
console.log('  · `fs.watch` 是**猜**（有 debounce 空窗 + 会丢事件），而"我们自己的写"本来就知道 ⇒')
console.log('    写工具接闸（`writeSourceFiles`）不是优化，是**正确性**。')
console.log('  · 同步签名的工具 await 不了异步的 syncFile ⇒ 走 L1b：`recordSelfWrite` 登记，')
console.log('    读路径（`ensureFreshIndex`）优先消费，同样归零。')

B.db.close()
for (const r of [A.root, B.root]) {  try {
    fs.rmSync(r, { recursive: true, force: true })
  } catch {
    /* Windows 下 sqlite 句柄可能还没释放，留给 OS 清 */
  }
}
