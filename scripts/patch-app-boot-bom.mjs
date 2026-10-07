// patch-app-boot-bom: 给 @deepseek-ai/dsh-app-boot 的 JSON 清单读取加统一 BOM 防护。
//
// 背景（2026-09-14）：
//   DSH 启动时会读若干 package.json（app anchor / profile manifest / 每个 bundle 的 manifest）。
//   这些文件若带 UTF-8 BOM(EF BB BF)，JSON.parse 会在首字节抛
//     SyntaxError: Unexpected token '\uFEFF'
//   → readProfileManifest / loadProfile 直接抛 → 整个 gen 起不来。
//   写入方是 Windows 侧"顺手写 JSON"的工具（PowerShell 5.1 的 Set-Content -Encoding UTF8、记事本等）。
//
// ★★ 2026-10-07 大段重写（原先是 4 个定点锚，已全部失效）：
//   症状：postinstall 报「已是最新 1 处 | ★未命中 4 处 (edit-1..4)」⇒ helper 插进去了，
//         但**没有任何调用点改用它** ⇒ 补丁**完全惰性**，BOM 防护一处都没生效。
//   原因：上游重构过这段代码 —— 原先的 4 个锚（`installAnchor` / `manifest:` 属性式 /
//         `join(packageDir,...)` / 手写 BOM 剥离）在现行源码里都不存在了；
//         实测现在有 **8 处** `JSON.parse(readFileSync(..., "utf8"))`，形态各异
//         （`anchor` 变量名、赋值式、`join(candidate, "package.json")`…）。
//   判断：**逐个修锚点 = 治标**（上游下次再动还得再来一遍）。改为**扫描式**：
//         凡是 `JSON.parse(readFileSync(<expr>, "<utf8>"))` 一律换成 `readJsonManifest(<expr>)`。
//         这不是"四行改动"，是"一类写法"的收口 —— 上游加新的读取点也会被覆盖。
//
//   为什么敢全量替换：**剥 BOM 对不带 BOM 的文件是无操作**（`charCodeAt(0)!==0xfeff` 原样返回），
//   所以把"所有 JSON 文件读取"都纳入防护是安全的，不必猜哪几处"可能会带 BOM"。
//
// 判据（三态，交给 reportAndExit）：
//   · applied = 本次新改的调用点
//   · already = 本次之前就已经走 readJsonManifest 的调用点 + helper 本身
//   · missing = 认不出的形态（编码参数不是 utf8/utf-8 之类）⇒ **严格模式下判红**
//   ★ 若扫描后**一个调用点都没有**（说明上游把这段整个删了/改名了），也判红 ——
//     否则会像旧版那样"文件在、helper 在、却什么都没改"地**假绿**。
//
// 重复执行安全：已打过时 applied 为空、already 非空。
// 注意：这是直接改 node_modules，`npm install` 会被冲掉 —— 已挂在 package.json 的 postinstall。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { reportAndExit, resolveEntities } from './patch-anchors.mjs'

const PATHS = resolveEntities('@deepseek-ai/dsh-app-boot')

const MARK = 'function parseJsonNoBom('

const HELPER = `/**
* BOM 防护（本地补丁，见 scripts/patch-app-boot-bom.mjs）：
* Windows 侧写入方（PowerShell 5.1 的 Set-Content -Encoding UTF8、记事本等）可能给
* package.json 落 UTF-8 BOM(EF BB BF)；JSON.parse 对首字节 '\\uFEFF' 会抛
* "SyntaxError: Unexpected token" 导致整个 gen 起不来。统一在这里剥掉。
*/
function parseJsonNoBom(raw) {
	return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}
function readJsonManifest(file) {
	return parseJsonNoBom(readFileSync(file, "utf8"));
}
`

const CALL = 'readJsonManifest('
const RAW = 'JSON.parse(readFileSync('

/** 从 open（指向 '('）出发找配对的 ')' 下标；找不到返回 -1。跳过字符串内的括号。 */
function matchParen(text, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 行号（1 基），用于报告里的定位 */
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length

function patchFile(file) {
  const out = { file, exists: true, applied: [], already: [], missing: [] }
  if (!existsSync(file)) return { ...out, exists: false }
  const src = readFileSync(file, 'utf8')
  if (src === '') return { ...out, exists: false }

  const srcHasHelper = src.includes(MARK)

  // ── 1) 先补 helper（没有才插；插在 import 块之后，保证 readFileSync 在作用域里）──
  let text = src
  if (!srcHasHelper) {
    const imports = [...text.matchAll(/^import\s[^\n]*\n/gm)]
    const at = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : 0
    text = text.slice(0, at) + '\n' + HELPER + text.slice(at)
  }

  // ── 2) 扫描所有裸调用点，从后往前替换（保偏移）──
  const hits = []
  let from = 0
  for (;;) {
    const start = text.indexOf(RAW, from)
    if (start < 0) break
    const openParen = start + 'JSON.parse('.length
    const closeRead = matchParen(text, openParen)
    if (closeRead < 0) { hits.push({ start, ok: false, label: `L${lineOf(text, start)}` }); from = start + RAW.length; continue }
    // JSON.parse( readFileSync(...) ) —— 两个闭括号之间只允许空白
    let j = closeRead + 1
    while (j < text.length && /\s/.test(text[j])) j++
    if (text[j] !== ')') { hits.push({ start, ok: false, label: `L${lineOf(text, start)}` }); from = start + RAW.length; continue }
    const args = text.slice(openParen + 1, closeRead)
    const enc = args.match(/,\s*['"](utf-?8)['"]\s*$/)
    if (!enc) { hits.push({ start, ok: false, label: `L${lineOf(text, start)}` }); from = start + RAW.length; continue }
    hits.push({
      start,
      end: j + 1,
      ok: true,
      label: `L${lineOf(text, start)}`,
      replace: `${CALL}${args.slice(0, enc.index).trimEnd()})`,
    })
    from = j + 1
  }

  for (const h of hits.reverse()) {
    if (!h.ok) { out.missing.push(h.label); continue }
    text = text.slice(0, h.start) + h.replace + text.slice(h.end)
    out.applied.push(h.label)
  }

  // ── 3) 已经有几处走 helper（用于幂等时的 already 计数）──
  const guarded = (text.match(new RegExp(CALL.replace('(', '\\('), 'g')) || []).length
  if (srcHasHelper || guarded > 0) out.already.push('helper', ...Array(Math.max(0, guarded - out.applied.length)).fill('已走helper'))

  // ── 4) 假绿防线：一个调用点都没命中 ⇒ 上游结构已变，必须报红 ──
  if (!out.applied.length && !guarded && !out.missing.length) out.missing.push('未找到任何 JSON.parse(readFileSync(...,"utf8"))')

  if (text !== src) writeFileSync(file, text, 'utf8')
  return out
}

reportAndExit('patch-app-boot-bom', PATHS.map(patchFile))
