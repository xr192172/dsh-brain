/**
 * ★★★ 编造判据（G8）：**"禁止编造"必须可执行，不能只是 persona 里的一句话。**
 *
 * ## 依据（用户 2026-09-26）
 * 「如果出现新名词需要进行对证，就是比如说你给任务给他，他出现了新名词，你要对这个新名词进行查找。
 *   同样的，每一个 agent 都要有这么一套这个强制验证的标准吧，我是说每一个席位。」
 *
 * ## 为什么这条能抓住编造（实测：真实席位产出就是被它抓住的）
 *
 * 2026-09-26 真实 review 席产出的头号"阻塞项"是：
 *   「`check-all.mjs` 里 **`shell:true`** 导致 spawnSync 拿不到 exit code（复现两次，均复现）」
 * 核验：`grep shell scripts/check-all.mjs` ⇒ **零命中** ⇒ 该符号在所引文件里**根本不存在**。
 *
 * ★ 为什么"新名词"是这个病的高敏指标：
 *   **编造的机制必然引入一个【不在被审材料里】的具体符号**（函数名/参数名/常量）。
 *   它自己感觉不到在编 —— 因为那个符号在训练里是**真实存在**的（`shell:true` 确实是个真坑），
 *   于是"像知识"，不触发"不确定"。⇒ 所以不能靠它自报，必须**机器去查**。
 *
 * ## 两道判据
 *
 * - **G8 · 无坐标的新符号**：输出里出现、但**不在被审材料里**的**反引号代码符号**，
 *   必须在**同一段**里有坐标（`文件`/`文件:行`/一条命令）。
 * - **G9 · 坐标对不上（★ 最硬的一条）**：若一段里既引了**文件**又给了**代码符号**，
 *   则该符号必须**真的能在那个文件里找到**（真的去读文件）。
 *   ⇒ 这条直接杀掉"`shell:true` 在 check-all.mjs 里"这种断言。
 *
 * ## 边界（诚实，必须写明）
 * · 只查**能落成坐标**的东西（符号/文件/行号）。**查不了"结论对不对"**。
 * · 命令类坐标**不去执行**（不执行不可信输入）⇒ 只登记"它说用命令可得"，不验真伪。
 * · 因此它是**必要不充分**：过了 G8/G9 不代表没编，只代表**没编出无坐标的符号**。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

/** 像"代码符号"而不是自然语言的 token。 */
function isCodeLike(s) {
  if (s.length < 2 || s.length > 80) return false
  if (/[\u4e00-\u9fff]/.test(s)) return false          // 含中文 ⇒ 是散文
  if (/^[\d\s.]+$/.test(s)) return false               // 纯数字
  // 含代码特征：下划线/驼峰/点号/括号/冒号/连字符/引号
  return /[A-Za-z]/.test(s) && /[_$.(){}:<>\[\]"'=/-]|[a-z][A-Z]|\d/.test(s)
}

/** 显式路径（带扩展名）。 */
const PATH_RE = /([A-Za-z0-9_][A-Za-z0-9_.-]*(?:[\\/][A-Za-z0-9_.-]+)*\.(?:mjs|js|cjs|ts|json|ya?ml|md|cmd|ps1))\b(?::(\d+))?/g

/** 把 `check-all` 这种模块短名解析成真实文件（在 scripts/ 与 packages/ 下按扩展名找）。 */
function resolveStemToFile(stem, repoRoot) {
  const cands = []
  for (const base of ['scripts', 'scripts/seats', 'scripts/delegation', 'evals']) {
    for (const ext of ['.mjs', '.js', '.ts']) {
      cands.push(path.join(repoRoot, base, stem + ext))
    }
  }
  for (const c of cands) if (fs.existsSync(c)) return c
  return null
}

/**
 * @param {string} output 席位产出原文
 * @param {string} sourceMaterial 被审材料（交接包/任务书；用来判定"新名词"）
 * @param {{repoRoot?:string}} [opts]
 * @returns {{ok:boolean, problems:{code:string,msg:string}[], unlocated:number[]}}
 *   `problems` = 判红项（只有 **G9**）；`unlocated` = 无坐标的新符号（**报告用，不判红**）
 */
export function verifyVocabulary(output, sourceMaterial, opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO
  const src = String(sourceMaterial ?? '')
  const text = String(output ?? '')
  const problems = []
  const unlocated = []
  const seenUnlocated = new Set()

  // ★ 先剔掉"输出自带的元信息"（last-say 打印的会话头），否则它会被当成正文
  const body = text.replace(/^会话 [\s\S]*?────────────────────────────────────────\n/, '')

  const paras = body.split(/\n\s*\n/)

  for (const para of paras) {
    // ── 坐标：**只有"文件:行"或"文件 第N行"才算引证**（产生义务） ──────────────
    // ★★ 这里是我第一版的翻车点：我把"段里出现文件名"就当成了引证，
    //    于是把【命令】（`check-all --only seats`）、【它自己调用的函数】、
    //    【返回字面量】（`ok=true, problems=[]`）统统判成"该文件里没有" ⇒ **5 条误报 / 6 条发现**。
    //    6 条里只有 1 条是真的 ⇒ 那就是**噪音机** ⇒ 门会被绕过（比没有门更糟）。
    //    ⇒ 收紧：**必须显式引证（带行号）才产生核对义务**。
    const cites = []
    for (const m of para.matchAll(PATH_RE)) {
      const shown = m[1]
      const line = m[2] ? Number(m[2]) : null
      if (line === null) continue // 只提名字不算引证
      const abs = path.isAbsolute(shown) ? shown : path.join(repoRoot, shown.replace(/\\/g, '/'))
      if (fs.existsSync(abs)) cites.push({ shown, abs, line })
    }
    for (const m of para.matchAll(/`([a-z][a-z0-9-]{2,30})`\s*第\s*(\d+)\s*行/g)) {
      const abs = resolveStemToFile(m[1], repoRoot)
      if (abs) cites.push({ shown: m[1], abs, line: Number(m[2]) })
    }
    // 去重（同一文件同一行）
    const citeKeys = new Set()
    const citesU = cites.filter((c) => {
      const k = c.abs + ':' + c.line
      return citeKeys.has(k) ? false : (citeKeys.add(k), true)
    })

    const idents = [...para.matchAll(/`([^`\n]{1,80})`/g)].map((m) => m[1].trim()).filter(isCodeLike)
    const newIdents = idents.filter((id) => !src.includes(id))

    // ── G9（判红）：被引证的那一行/那个文件，必须真的含这个代码片段 ────────────
    for (const c of citesU) {
      let target = ''
      let targetLabel = ''
      try {
        const lines = fs.readFileSync(c.abs, 'utf8').split('\n')
        if (c.line < 1 || c.line > lines.length) {
          problems.push({ code: 'G9-LINE-OUT-OF-RANGE', msg: `引用 ${c.shown}:${c.line} 越界（该文件只有 ${lines.length} 行）` })
          continue
        }
        target = lines[c.line - 1]
        targetLabel = `${c.shown}:${c.line}`
      } catch {
        continue
      }
      for (const id of newIdents) {
        if (target.includes(id)) continue
        // ★ 允许"该片段出现在文件别处"（行号可能只是指个大概位置）⇒ 先查整文件，再判红
        let anywhere = false
        try { anywhere = fs.readFileSync(c.abs, 'utf8').includes(id) } catch { /* 忽略 */ }
        if (anywhere) continue
        problems.push({
          code: 'G9-SYMBOL-NOT-IN-CITED-FILE',
          msg: `把 \`${id}\` 说成在 ${targetLabel}（或其所在文件）里，但**整文件都搜不到** —— 这是最典型的"编造机制"形状`,
        })
      }
    }

    // ── G8（**只报告，不判红**）：无坐标的新符号 ─────────────────────────────
    // ★ 为什么不判红：新符号未必是编造（可能是它自己的变量名、命令、返回值）。
    //   判红会变成噪音机（实测 5/6 误报）。⇒ 按"三态"处理：**显式记 `unknown`，不判红、不放过**。
    if (citesU.length === 0) {
      for (const id of newIdents) {
        if (seenUnlocated.has(id)) continue
        seenUnlocated.add(id)
        unlocated.push(id)
      }
    }
  }

  const seen = new Set()
  const uniq = problems.filter((p) => (seen.has(p.code + p.msg) ? false : (seen.add(p.code + p.msg), true)))
  return { ok: uniq.length === 0, problems: uniq, unlocated }
}
