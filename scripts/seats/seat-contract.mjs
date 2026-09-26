/**
 * @module scripts/seats/seat-contract
 *
 * ★★★ 把「席位产出契约」从**散文**变成**可执行判据**（S0′；依据 `docs/agent-seats-spec-2026-09-26.md` §6.1）。
 *
 * ## 为什么需要它
 *
 * `packages/subagent-council/src/index.ts` 里的三席 persona **已经写好了契约**：
 *   · 「## 产出必须包含这五段 / 这六段」+ 每段的名字
 *   · 「我可能错在哪」**单独一行，不许省略**
 *   · 「不许用"建议进一步评估"这类空话收尾」
 *   · review 席另有：裁决三态（通过/驳回/有条件通过）、独立性档位须如实标注
 *
 * **但没有任何东西在检查它。** `scripts/probe-verify-council.mjs` 是个需要前门的
 * 人工一次性探针，只把回答写进 `out/verify-council.txt` 给人眼看，**不含机器判据**。
 * ⇒ 散文契约 = 只在"读到且选择遵守"时生效。本模块把它变成**确定性**的门
 *   （零 LLM、零网络、零副作用）。
 *
 * ## G0 ★★ 单一真相源（**本模块最重要的一条**）
 *
 * 契约**从 persona 源码里解析出来**，**不许手抄第二份** ——
 * 第二份副本必然与源码漂移（铁律 18：判据要用比名字更强的指纹）。
 * ⇒ 解析失败（persona 形状变了）必须 **fail-closed 抛错**，
 *   **绝不许**"解析不到就跳过校验"（那会变成假绿，比没有门更糟）。
 *
 * ## 边界（明确不做，见规格 §6.1「明确不做」）
 * · **不改 persona** —— 本模块只读源码，不写。三席挂在现役 preset 上，擅改有风险。
 * · `claim → 工件指针`（规格 D0 的机械部分）暂不实现：它要求席位产出结构化 claim，
 *   属"改 persona + 定新格式"，见规格 O 清单。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
/** ★ 单一真相源：三席 persona 住在这里。 */
export const SEAT_SOURCE = path.join(REPO, 'packages/subagent-council/src/index.ts')

/** 契约解析失败时抛这个 —— 调用方**必须**让它冒出去（fail-closed）。 */
export class SeatContractParseError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// G0 · 解析（从源码，不手抄）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 取出 `const NAME = \`...\`` 的模板字面量正文。
 * ★ persona 正文里不含反引号（实测），故"第一个反引号到下一个反引号"即可；
 *   但要**断言取到了**，取不到就抛 —— 不许返回空串然后静默通过。
 */
function templateBody(src, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*\``)
  const m = re.exec(src)
  if (!m) throw new SeatContractParseError(`找不到 persona 常量 ${constName}（源码形状变了？）`)
  const start = m.index + m[0].length
  const end = src.indexOf('`', start)
  if (end < 0) throw new SeatContractParseError(`${constName} 的模板字面量没有闭合`)
  const body = src.slice(start, end)
  if (body.trim().length < 50) throw new SeatContractParseError(`${constName} 正文过短（${body.length} 字符）—— 解析大概率错了`)
  return body
}

/** 解析 `export const SEAT_PERSONAS = { seat: CONST, ... }` ⇒ `{ seat: CONST }` */
function seatConstMap(src) {
  const m = /export\s+const\s+SEAT_PERSONAS\s*:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/.exec(src)
  if (!m) throw new SeatContractParseError('找不到 SEAT_PERSONAS 定义')
  const out = {}
  for (const line of m[1].split('\n')) {
    const e = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,/.exec(line)
    if (e) out[e[1]] = e[2]
  }
  if (Object.keys(out).length === 0) throw new SeatContractParseError('SEAT_PERSONAS 里一条席位都没解析出来')
  return out
}

/** 中文数词 → 数字。解析不出就返回 null（调用方必须 fail-closed）。 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
function cnNum(w) {
  if (CN_NUM[w] !== undefined) return CN_NUM[w]
  if (/^\d+$/.test(w)) return Number(w)
  return null
}

/**
 * 解析出**每席位的契约**：必需段落 + 被禁的收尾句式。
 * @returns {Record<string, {constName:string, sections:string[], sectionCountWord:string, bannedClosings:string[], persona:string}>}
 */
export function parseSeatContracts(sourcePath = SEAT_SOURCE) {
  const src = fs.readFileSync(sourcePath, 'utf8')
  const map = seatConstMap(src)
  const out = {}
  for (const [seat, constName] of Object.entries(map)) {
    const persona = templateBody(src, constName)

    // 段落清单：`## …必须包含这N段` 之后，到下一个 `## ` 之前的编号项。
    // ★ 锚点必须**放宽到措辞**：实测三席措辞不一致 ——
    //   `architect` 写「## 你的回答必须包含这五段」，`dev`/`review` 写「## 产出必须包含这N段」。
    //   我第一版只认「产出必须包含」⇒ architect 直接解析失败。
    //   （★ 这一条正是 fail-closed 的价值：它**报错**了，而不是静默算成"0 段 ⇒ 全都通过"。）
    const head = /##\s*[^\n]*?必须包含这(.+?)段\s*\n([\s\S]*?)(?=\n##\s|\s*$)/.exec(persona)
    if (!head) throw new SeatContractParseError(`席位 ${seat} 的 persona 里找不到「…必须包含这N段」小节`)
    const countWord = head[1]
    const sections = []
    for (const line of head[2].split('\n')) {
      const it = /^\s*\d+\.\s*\*\*(.+?)\*\*/.exec(line)
      if (it) sections.push(it[1].trim())
    }

    // ★★★ 段数一致性 —— **这条是消融实验逼出来的，是本模块最重要的一道防线**。
    //   原先只断言 `sections.length > 0`。实测：把 4/5 个段名标记改掉后，
    //   解析出 **1** 段（不是 0）⇒ **不抛错** ⇒ 契约束求被悄悄从 5 段降到 1 段 ⇒ **假绿**。
    //   ⇒ 必须拿标题里**声明的段数**当判据：不一致就是"解析器与 persona 脱节"，**一律抛错**。
    const declared = cnNum(countWord)
    if (declared === null) {
      throw new SeatContractParseError(`席位 ${seat} 声明的段数「这${countWord}段」认不出来 ⇒ 无法核对，拒绝继续（fail-closed）`)
    }
    if (sections.length !== declared) {
      throw new SeatContractParseError(
        `席位 ${seat} 段数不一致：标题声明「这${countWord}段」=${declared}，实际解析出 ${sections.length} 段` +
          `（解析到：${sections.join(' / ') || '(空)'}）—— 解析器与 persona 脱节，拒绝继续`,
      )
    }

    // 被禁的收尾句式：`不许用"X"这类空话`
    const banned = []
    for (const bm of persona.matchAll(/不许用[「"“]([^」"”]+)[」"”]这类空话/g)) banned.push(bm[1])
    if (banned.length === 0) throw new SeatContractParseError(`席位 ${seat} 的 persona 里找不到「不许用…这类空话」约束`)

    out[seat] = { constName, persona, countWord, declaredCount: declared, sections, bannedClosings: banned }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// G1–G5 · 校验
// ─────────────────────────────────────────────────────────────────────────────

/** 「敷衍」的自证伪：空、或只有这些词。 */
const DISMISSIVE = /^(无|没有|暂无|暂时没有|不适用|无其它|同上|N\/?A|None)$/i

/**
 * ★ 正文清洗：切出来的段落**总带着标题的 markdown 残渣**（`**`、`——`、`：`）。
 *   ★ 这是实测踩出来的：`我可能错在哪**\n` 切出来是 `"**"` —— 长度 2、既不为空也匹配不上
 *   "敷衍"正则 ⇒ **漏判**（测试 W3a 抓到了）。所以必须先剥标记再判空/判敷衍。
 */
function cleanBody(s) {
  return String(s ?? '')
    .replace(/^\s*[*`_\s]*(?:——|—|-|:|\uFF1A)?\s*/, '')
    .replace(/[\s*`_]+$/, '')
    .trim()
}

/**
 * ★★ 段落名**归一化**再匹配（容忍措辞、**不容忍缺失**）。
 *
 * 为什么必须做这一步：persona 里的段落名是字面量（例：`推荐 + 风险`），
 * 而 LLM 的产出很可能写成「推荐与风险」「推荐/风险」。
 * 若做**严格字面匹配**，就会在**合格**的产出上报红 ⇒ **长期假红 ⇒ 门被当噪音 ⇒ 整体被绕过**
 * （这正是本规格 §4.3/§1 反复警告的最坏形状）。
 * ⇒ 归一化规则：去掉所有空白；把 `+`/`、`/`与`/`和`/`及`/`/` 视作**同一个连接符**（直接删掉）。
 * ★ 这**不是**放宽：段落**缺失**照样红（见 W2）。放宽的只是"怎么写连接符"。
 */
function normalizeWithMap(s) {
  const out = []
  const map = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (/\s/.test(ch)) continue
    if ('+、与和及/｜|'.includes(ch)) continue
    out.push(ch)
    map.push(i)
  }
  return { text: out.join(''), map }
}

/**
 * 把产出按"必需段落名"切分（**归一化后**定位，再映射回原文切片），返回每段正文。
 * ★ 段落名必须真的出现 —— persona 明确要求分段，所以这是契约的一部分。
 *   找不到就是不合格（错误信息里会指名是哪一段、以及它长什么样）。
 */
function sliceSections(output, sections) {
  const { text: nOut, map } = normalizeWithMap(output)
  const found = {}
  /** 段落 → 归一化坐标里的起点 */
  const spans = []
  for (const name of sections) {
    const nName = normalizeWithMap(name).text
    const at = nOut.indexOf(nName)
    spans.push({ name, at, len: nName.length })
  }
  for (const sp of spans) {
    if (sp.at < 0) { found[sp.name] = null; continue }
    // 归一化坐标 → 原文坐标
    const fromN = sp.at + sp.len
    const startOrig = map[fromN] ?? output.length
    // 到"下一个已定位段落"的起点，或文末
    let endN = nOut.length
    for (const other of spans) {
      if (other === sp || other.at < 0) continue
      if (other.at >= fromN && other.at < endN) endN = other.at
    }
    const endOrig = map[endN] ?? output.length
    found[sp.name] = output.slice(startOrig, endOrig).trim()
  }
  return found
}

/**
 * 校验一份席位产出是否满足该席位**自己声明的**契约。
 *
 * @param {string} seat `architect` / `dev` / `review`
 * @param {string} output 席位产出的原文
 * @param {Record<string, any>} contracts `parseSeatContracts()` 的结果
 * @returns {{ok:boolean, seat:string, problems:{code:string,msg:string}[], sections:Record<string,string|null>}}
 */
export function validateSeatOutput(seat, output, contracts) {
  const c = contracts[seat]
  if (!c) {
    return { ok: false, seat, problems: [{ code: 'G0-UNKNOWN-SEAT', msg: `未知席位 "${seat}"（已知：${Object.keys(contracts).join(', ')}）` }], sections: {} }
  }
  const problems = []
  const text = String(output ?? '')

  // G1 段落完备 + 非空
  const sliced = sliceSections(text, c.sections)
  for (const name of c.sections) {
    const body = sliced[name]
    if (body === null) problems.push({ code: 'G1-MISSING', msg: `必需段落「${name}」在产出里找不到` })
    else if (body.length === 0) problems.push({ code: 'G1-EMPTY', msg: `必需段落「${name}」是空的` })
  }

  // G2 自证伪字段：必须存在、非空、且不敷衍
  const SELF_DOUBT = '我可能错在哪'
  if (c.sections.includes(SELF_DOUBT)) {
    const raw = sliced[SELF_DOUBT]
    if (raw === null) {
      // G1 已报，这里不重复
    } else {
      const body = cleanBody(raw)
      if (body.length === 0) {
        problems.push({ code: 'G2-EMPTY', msg: `「${SELF_DOUBT}」是空的（persona 要求"不许省略"）` })
      } else if (DISMISSIVE.test(body.replace(/[。.！!，,\s]/g, ''))) {
        problems.push({ code: 'G2-DISMISSIVE', msg: `「${SELF_DOUBT}」只写了「${body}」—— 属敷衍，等于没写` })
      }
    }
  }

  // G3 禁止空话收尾
  const tail = text.trim().split(/\n/).filter((l) => l.trim()).slice(-1)[0] ?? ''
  for (const bad of c.bannedClosings) {
    if (tail.includes(bad)) problems.push({ code: 'G3-BANNED-CLOSING', msg: `结尾用了被禁的空话「${bad}」：${JSON.stringify(tail.slice(0, 60))}` })
  }
  // ★ 收尾必须是"可执行的下一步"——若最后一段完全不含动作词，也给一条**弱**提示（不是红）
  //   （故意不做成红：那会变成"逢错必报"。见规格 W1 阳性对照。）

  // G4 三态裁决（仅 review）
  if (seat === 'review') {
    const verdict = sliced['裁决'] ?? ''
    const has = ['驳回', '有条件通过', '通过'].filter((v) => verdict.includes(v))
    // 「有条件通过」包含「通过」⇒ 先判更具体的，只要命中一个即算有裁决词
    const hit = has.length > 0
    if (!hit && verdict.length > 0) {
      problems.push({ code: 'G4-VAGUE-VERDICT', msg: `「裁决」段里没有三态词（通过/驳回/有条件通过）：${JSON.stringify(verdict.slice(0, 60))}` })
    }
  }

  // G5 独立性档位（仅 review）
  // ★ 词形取自 persona 逐字：「跨模型 > 跨会话 > 同会话换 prompt」 + 「独立性无法核对」。
  //   ⚠️ 不能用裸 `同会话` —— 实测 `不同会话` 里含该子串 ⇒ **假绿**
  //   （"作者与我是不同会话"其实**没有**标注档位，却会被判为已标注）。
  if (seat === 'review') {
    if (!/独立性无法核对|跨模型|跨会话|同会话换/.test(text)) {
      problems.push({ code: 'G5-NO-INDEPENDENCE', msg: '没标注独立性档位（跨模型/跨会话/同会话换 prompt），也没写「独立性无法核对」' })
    }
  }

  return { ok: problems.length === 0, seat, problems, sections: sliced }
}
