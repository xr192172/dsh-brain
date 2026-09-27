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

/**
 * ★★ G11（独立性档位）对各席位的**区分度**声明。
 *
 * 依据 2026-09-26 与 architect 席讨论的**反驳 2**：
 *   architect 的 persona 里**写死了**"填不适用"，而 G11 对 architect 只检查是否含「不适用」
 *   ⇒ 席位**照抄就过** ⇒ 该判据对 architect **恒真、区分度为 0**。
 * architect 主张保留（结构对称），我要求**必须显式声明它没有区分度** —— 不许让它看起来像一道门。
 * ★ 项目纪律：**判据与信号不可混。**
 */
export const G11_DISCRIMINATIVE = { architect: false, dev: true, review: true }

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

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ G12 · 职责边界解析（P3 路由判据的**唯一数据来源**）
//
// ## 为什么要有这一层（2026-09-27）
//
// 上面那句「契约从 persona 源码解析，**不许手抄第二份**」是本模块最重要的纪律。
// 而 persona 里其实有**两节**是契约：
//   · 「## 产出必须包含这N段」 —— 回答**长什么样**（已被上面解析）
//   · 「## 职责边界（严格遵守）」—— 回答**这活该不该给我**（**本节才解析**）
//
// 用户要的「把对应的部分提交给对应的部门」缺的正是第二节：
// 没有它，路由只能靠 LLM 自由发挥（`docs/single-front-brain-delegation.md` §5④ 明确禁止）。
// ⇒ 本节把「职责边界」也从散文变成**可执行数据**，且仍然**不手抄**。
//
// ## 解析的是【句式】，不是【关键词】—— 这条是区分度的生死线
//
// 三席的边界**大量用否定句写**（"你不写实现代码"、"你【不】裁值不值得采纳"），
// 而否定句里**含**别的席位的正面词（architect 的"不写**实现**代码"含 dev 的"施工/实现"语义）。
// ⇒ 若按关键词匹配，architect 会被自己的否定句判成"它会写实现" ⇒ **每席都命中每席** ⇒ 区分度归零。
// ⇒ 一律按**句式标记**取：`你【只做X】` = admits；`你不…` / `你【不】…` = refuses。
// ─────────────────────────────────────────────────────────────────────────────

/** 职责边界小节的标题（**放宽到措辞**：允许"（严格遵守）"等后缀；与上面段数锚点同族）。 */
const BOUNDARY_HEAD = /##\s*职责边界[^\n]*\n([\s\S]*?)(?=\n##\s|\s*$)/

/**
 * 从一段职责边界正文里取出各条 `- ` 列表项，并**剥掉续行/注释噪音**。
 *
 * ★ 必须按"条目"归并续行：dev 的第 1 条正文跨两行（第 2 行以 `  ★` 开头续写）。
 *   若逐行当独立条目，`admits` 就会把续行误判成一条独立边界（形状噪声）。
 */
function boundaryItems(body) {
  const items = []
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*[-*]\s+/.test(line) || /^\s*·\s+/.test(line)) {
      items.push(line.replace(/^\s*[-*·]\s+/, '').trim())
    } else if (items.length > 0 && line.trim() !== '') {
      // 续行：并到上一条（**不许丢弃** —— 丢弃会让"边界少一条"变成静默）
      items[items.length - 1] += ' ' + line.trim()
    }
  }
  return items
}

/**
 * ★★ 从【条目文本】里抽「它只做什么」与「它不做什么」。
 *
 * 中间那堆 `**` / `【】` / `★` 全是 markdown 强调，**先抹平再匹配**，
 * 否则同一句话因加粗与否而失配 ⇒ 假红（本模块已因此栽过，见 `cleanBody` 注释）。
 */
function boundaryOfSeat(seat, persona) {
  const m = BOUNDARY_HEAD.exec(persona)
  if (!m) {
    // ★ fail-closed：与段数一致性同族。**绝不**"解析不到就返回空集"
    //   —— 空集会让路由判据退化成"谁都不匹配 ⇒ 全拒派"，那是**假红**；
    //   而若后来有人把空集当"无限制"，又变成**假绿**。两种都不可接受。
    throw new SeatContractParseError(
      `席位 ${seat} 的 persona 里找不到「## 职责边界」小节 ⇒ 路由判据没有数据来源，拒绝继续（fail-closed）`,
    )
  }
  const items = boundaryItems(m[1])

  /** 抹平 markdown 强调标记（保留正文）。 */
  const flat = (s) => s.replace(/[*`_]/g, '').replace(/【/g, '').replace(/】/g, '')

  const admits = []
  const refuses = []

  // ★ admits：`你只做X` / `你只裁X`（「只」是**排他**标记 —— 它自己就表达了边界）
  //   例：architect「你【只做设计与判断】，不写实现代码」 ⇒ admits = 设计与判断
  //       dev      「你【只做施工】：…」              ⇒ admits = 施工
  //       review   「你【只裁值不值得采纳】」          ⇒ **在引言里，不在节内**（见下）
  const ADMITS = /你(?:是|只|负责)?\s*只\s*(?:做|裁|负责)?\s*([^，。；:：]{1,24})/
  // ★ 节内的另一种正面写法：`你裁的是「X」`（review 席第 3 条这么写）——
  //   它**没有「只」字**，但句子里有「裁的是」这个**排他性谓语**。
  const ADMITS2 = /你(?:裁|做|负责)的(?:是|就是)\s*[「"“]?([^」"”，。；]{1,24})/

  // ★ refuses：`你不X` / `你不负责X` / `你【不】X` 或 `【不】X`（并列省略主语）
  //   ★★ 必须做【作用域限定】（铁律 41 —— 本模块已因此栽过两次，这是第三次）：
  //     实测 review 席第 3 条里有一句 "（你不知道就写"不知道"）"，
  //     它不是边界、只是**括号里的操作说明**，但全局正则把它当成了一条 refuse。
  //     ⇒ 「你」必须出现在**子句开头**（行首 / `；` / `——` / `。` 之后），不允许从句中命中。
  //   ★★ 且必须**全局扫**（`/g`）：dev 第 4 条写「你【不】提战略方案、【不】改别人的职责边界」
  //     —— 两个并列否定，只取第一个会**静默丢掉**第二条边界（判据少一条 = 路由漏一类任务）。
  const REFUSES = /(?:^|[；;。]|——)\s*(?:你|本席位)?\s*[【\[]?不[】\]]?\s*(?:负责|做|写|改|提|裁|替)?\s*([^，。；;]{1,24})/g

  /**
   * ★★ 边界词清洗（实测两轮才做对，见下方注释）。
   *
   * 目标形状：一个**短、名词性、可直接读**的边界（`把它做出来` / `战略方案`）。
   * 实测踩到的三个形状（都出自 dev / review 的真实 persona）：
   *   ① `值不值得采纳" —— 那是审批脑（评审团）的事` ⇒ 引号 + 破折号 + **解释**
   *   ② `实现、不改文件（默认只读）`               ⇒ 顿号并列 + **括号补充**
   *   ③ `【不】改别人的职责边界`                    ⇒ 方括号标记（`flat` 已剥）
   *
   * ⇒ 规则：**在第一个破折号 / 冒号 / 顿号 / 括号处截断**，再剥剩余引号。
   *   ★ 截断是**对的**，不是信息丢失：破折号之后是**解释**（"那是谁的事"），
   *     解释不该进"不接"栏 —— 它会让那一栏读起来像半句话（顶层 AI 看得出歧义）。
   *   ★ 顿号截断同样对：`不改文件、不改目录` 里的第二项由 REFUSES 的 `/g` 各自捕获，
   *     不靠这里的字符串切分。
   */
  const cleanBoundary = (s) =>
    String(s ?? '')
      .split(/——|—|[:：]|[（(【\[]|、/)[0]
      .replace(/["“”「」『』'''`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  for (const raw of items) {
    const text = flat(raw)
    const a = ADMITS.exec(text) ?? ADMITS2.exec(text)
    if (a) admits.push(a[1].trim())
    for (const r of text.matchAll(REFUSES)) {
      const clean = cleanBoundary(r[1])
      if (clean !== '' && clean.length <= 20) refuses.push(clean)
    }
  }

  // ★★ 回退：节内一条 admits 都抽不到时，去 **persona 引言**取（席位定义句）。
  //   这**不是放宽判据**，而是承认一个真实结构差异：
  //   review 席把正面职责写在引言（「你【只裁值不值得采纳】」），节内只列否定边界。
  //   ★ 回退**必须显式标记来源**（`admitsFrom`）—— 静默回退 = 判据读者分不清
  //     "节内真有职责" 与 "节内没有、我从别处补的"（铁律 33：不确定要能被下游读到）。
  let admitsFrom = 'boundary'
  if (admits.length === 0) {
    const lead = flat(persona.split('\n').slice(0, 3).join(' '))
    const a = ADMITS.exec(lead) ?? ADMITS2.exec(lead)
    if (a) {
      admits.push(a[1].trim())
      admitsFrom = 'lead'
    }
  }

  if (admits.length === 0) {
    throw new SeatContractParseError(
      `席位 ${seat} 的「职责边界」节与引言里都解析不出「你只做… / 你裁的是…」（admits）⇒ 路由判据对该席无正面依据，拒绝继续（fail-closed）`,
    )
  }

  // ── ★★ keywords：职责边界节里**作者自己加粗**的动作/交付物词 ─────────────
  //
  // 依据：persona 作者把关键动作都加粗了（`**编排**` / `**融合**` / `**复核**`）。
  //   ★ 这是**自带的信号**，不是我的手抄映射 —— 仍然符合 G0。
  //   ★ 为什么需要它：`admits` 是抽象职责（"施工"），与任务描述的语言距离太远；
  //     加粗词是具体动作（"编排"），匹配能力显著更强（实测见 test-route-task.mjs 的压力组）。
  //
  // ★ 过滤（**必须做，否则噪音会造出假判**）：
  //   · 虚词/连词/指代（不是、前提、保证、来源、就是你自己…）—— 它们不是动作
  //   · 含引号的（`【不】裁"值不值得采纳"`）—— 那是**引用别人的话**，不是自己的动作
  //   · 长度 < 2 或 > 8
  const KEYWORD_STOP = /^(不是|前提|保证|来源|真实含义|上下文隔离|独立性|一个工具|同功能的更优实现|两个脚本融合|两份设计融合|我做对了|就是你自己|不同 ?agent|如实标注本次落在哪一档)$/
  const keywords = []
  for (const bm of m[1].matchAll(/\*\*([^*\n]{2,12})\*\*/g)) {
    const w = bm[1].trim()
    if (w.length < 2 || w.length > 8) continue
    if (/["“”「」'']/.test(w)) continue // 引用别人的话，不是本席动作
    if (KEYWORD_STOP.test(w)) continue
    keywords.push(w)
  }

  return { admits, refuses, itemCount: items.length, admitsFrom, keywords: [...new Set(keywords)] }
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

    out[seat] = { constName, persona, countWord, declaredCount: declared, sections, bannedClosings: banned, boundary: boundaryOfSeat(seat, persona) }
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
 * 剥掉行首的标题标记。★ 必须**循环剥**，因为标记顺序不定：
 *   `## 3. 裁决` / `**4. 推荐 + 风险**` / `4. 取舍` / `**问题重述**`
 *   —— 单条正则按固定顺序写（先 `#` 再数字再 `**`）会漏掉 `**4.` 这种"`**` 在数字前"的形状
 *   （实测：加了标题形定位后，`推荐与风险` 变体因此被判缺段 ⇒ 又是一次假红）。
 */
function stripHeadingMarkers(line) {
  let s = line
  for (;;) {
    const before = s
    s = s.replace(/^\s+/, '')
    s = s.replace(/^#{1,6}/, '')
    s = s.replace(/^\*\*/, '')
    s = s.replace(/^\d+\s*[.、)）]/, '')
    if (s === before) break
  }
  return s
}

/**
 * ★★★ 找每个必需段落的**起点**（优先"行首标题形"，回退"裸出现"）。
 *
 * ## 为什么必须有这一步（2026-09-26，真实席位产出校准抓出来的**假红**）
 *
 * 原先直接 `output.indexOf(name)` 取**全文第一次出现**。
 * 而真实产出里，段落名会**先出现在正文里**，再出现在它自己的标题上：
 *
 * ```
 * 关键数据已收集完毕。以下是独立复核**裁决**。      ← indexOf 命中的是这个
 * ...
 * ## 3. **裁决**：有条件通过                      ← 真正的段落在这里
 * ```
 *
 * ⇒ 切出来的正文是 `。\n\n---\n\n## 1.` ⇒ 「没有三态词」**假红**，
 *   而那份产出其实写得**完全合契约**（`## 3. 裁决：有条件通过`）。
 *
 * ★★ 这与**铁律 41**（文本型判据必须做作用域限定）是**同一个病** ——
 *   而铁律 41 正是我在同一天稍早、在另一道门（`test-handover-drain`）上刚诊断出来的。
 *   **我把刚诊断完的 bug 立刻在隔壁重犯了一次。** 记在这里，作为该铁律的第二个实例。
 */
function findSectionHeads(output, sections) {
  const lines = output.split('\n')
  const lineStarts = []
  let off = 0
  for (const l of lines) { lineStarts.push(off); off += l.length + 1 }

  const heads = new Map()
  for (const name of sections) {
    const nName = normalizeWithMap(name).text
    let start = -1
    let afterName = -1

    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // ★★ 代码块内的内容**不算段落**（同族 scope 修正）。
      //   实测：architect 轮 1/2 的产出里**引用了拟议的 persona 片段**：
      //       （architect 第 6 段）
      //       6. **独立性档位** —— 不适用（本席位不做独立复核）。
      //   ⇒ 该行命中"行首标题形" ⇒ 被判成"它真的产出了这一段" ⇒ **假绿（旧产出被放行）**。
      //   席位经常引用契约原文/示例，所以这个洞必须堵。
      if (/^\s*```/.test(line)) { inFence = !inFence; continue }
      if (inFence) continue

      const stripped = stripHeadingMarkers(line)
      const { text: nStripped, map } = normalizeWithMap(stripped)
      if (!nStripped.startsWith(nName)) continue
      const strippedStart = lineStarts[i] + (line.length - stripped.length)
      const idxAfter = map[nName.length] ?? stripped.length
      start = strippedStart
      afterName = strippedStart + idxAfter
      break
    }

    if (start < 0) {
      // ★★ 2026-09-26 删掉了"裸出现"兜底（原实现：`output.indexOf(name)`）——
      //   它是**又一处铁律 41 式的 scope 泄漏**：
      //   段名出现在**正文散文**里也会被当成"该段落存在"。
      //   实测：review 样本的第 6 段写着「本次**裁决**的档位：跨会话」⇒
      //   W2「删掉『裁决』段」那条**构造不出阴性条件**（正文里还有个"裁决"）⇒ 假绿。
      //   ★ 检查过：紧凑写法 `**1. 问题重述**` 本来就能被上面的"行首标题形"命中
      //     （`stripHeadingMarkers` 会循环剥掉 `**` 与 `1.`）⇒ **兜底是多余的**。
      //   ⇒ 归零：找不到就**真的**是缺段。
      start = -1
      afterName = -1
    }
    heads.set(name, { start, afterName })
  }
  return heads
}

/**
 * 把产出按"必需段落名"切分，返回每段正文。
 * ★ 段落名必须真的出现 —— persona 明确要求分段，所以这是契约的一部分。
 *   找不到就是不合格（错误信息里会指名是哪一段）。
 */
function sliceSections(output, sections) {
  const heads = findSectionHeads(output, sections)
  const found = {}
  for (const name of sections) {
    const me = heads.get(name)
    if (!me || me.start < 0 || me.afterName < 0) { found[name] = null; continue }
    // 到"下一个已定位段落"的起点，或文末
    let end = output.length
    for (const other of heads.values()) {
      if (other.start < 0) continue
      if (other.start >= me.afterName && other.start < end) end = other.start
    }
    found[name] = output.slice(me.afterName, end).trim()
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

  // ── G10 探针自证（**交叉核对**：段落自述 × 全文扫描反证）───────────────────
  // 依据：2026-09-26 与 architect 席讨论后收敛的设计（`out/architect-round3-output.md`）。
  //
  // ★ 为什么**不能**做成"席位自评"（讨论里最强的一条反驳）：
  //   若让席位自己判断"我这次有没有遇到矛盾"，一个不自省的席位写「无矛盾」就绕过了
  //   —— 而"没有怀疑自己的探针"**正是**那次真实事故的病根。
  //   ⇒ 把举证责任放在唯一不该信的那一方，等价于"自证清白"。
  //
  // ★★ 实现时发现的两个洞（**我改了收敛设计，理由在此**）：
  //   ① 收敛设计把「探针自证」声明为一个**条件性段落**（未矛盾则无需写）
  //      ⇒ 与 G1「段落必须非空」**直接冲突**（它自己在轮 2 也承认"G1 需为此调整"）；
  //      而若改成"总是必填且写'无矛盾'"，那内容就退化成**席位自评** = 被反驳 1 杀掉的东西。
  //      ⇒ **干脆不新增段落**：G10 改为全文扫描，阳性对照**放在哪一段都行**（通常放「独立复算」）。
  //   ② 因此不能只查某个段落 ⇒ 否则"要求"无处落实 = **无从合规 = 噪音机**。
  //
  // ⇒ 最终形状：**全文出现「文件引用 + 负面结果」= 它在做归因 ⇒ 全文必须存在一条阳性对照**。
  //   阳性对照 = 一条**已知应通过**的操作 + 它的**真实输出**（`exit=0` / `passed` / `阳性对照` 等）。
  //   ★ 这既不需要自评、也不需要新段落，且**可满足**。
  //
  // ⚠️ **已知窄触发面（如实记）**：信号词要求出现**负面**结果词（零命中/没找到/不存在…）。
  //   而真实事故 B 那句是「…`shell:true` **导致** spawnSync 拿不到 exit code」——**不含负面词**
  //   ⇒ **G10 抓不到事故 B**（它由 G9 抓）。G10 管的是**另一件事**：
  //   「你**确实**发现了一个对不上的读数时，有没有先怀疑自己的探针」。
  if (seat === 'dev' || seat === 'review') {
    const NEG = /零命中|找不到了|没找到|没有找到|不存在|未发现|无命中|无结果|返回空|未匹配到|无一命中|对不上|不一致/
    const HAS_FILE = /`[^`\n]+\.(?:mjs|js|cjs|ts|json|ya?ml|md|cmd|ps1)[^`\n]*`/
    const POSITIVE = /exit\s*[=:]\s*\d+|passed|阳性对照|阴性对照|✓|仅命中|命中\s*\d|全绿/
    const signalParas = String(text).split(/\n\s*\n/).filter((p) => HAS_FILE.test(p) && NEG.test(p))
    if (signalParas.length > 0 && !POSITIVE.test(text)) {
      problems.push({
        code: 'G10-NO-PROBE-SELF-PROOF',
        msg: `全文有 ${signalParas.length} 段「文件引用 + 负面结果」（=在做归因），但**全文找不到一条阳性对照**` +
          `（一条已知应通过的操作 + 它的真实输出，如 \`exit=0\` / "全绿"）。★ 先证明你的探针看得见阳性，再归因给别人。`,
      })
    }
  }

  // ── G11 独立性档位成【必需段落】───────────────────────────────────────────
  // ★ 与上面 G5 的区别：G5 只看"全文里有没有档位词"（弱）；G11 要求它是一个**独立必需段落**。
  //   ⇒ G11 生效后 G5 是冗余的，但**保留 G5**：它覆盖"段落还没加"的过渡期，且历史事故 A 由它发现。
  // ★ architect 席的 G11 合法值只有「不适用」⇒ 该判据对 architect **恒真**（照抄即过）。
  //   这是与 architect 讨论后**明知的取舍**（它主张结构对称；我要求必须显式声明"无区分度"）。
  //   ⇒ 见本文件下方 `G11_DISCRIMINATIVE` 常量：**architect 的 G11 不计入区分度**。
  {
    const INDEP = '独立性档位'
    const body = sliced[INDEP]
    if (body === undefined || body === null) {
      problems.push({ code: 'G11-MISSING', msg: `必需段落「${INDEP}」缺失（persona 的产出清单里要有它）` })
    } else {
      const allowed = seat === 'architect'
        ? ['不适用']
        : ['跨模型', '跨会话', '同会话换 prompt', '无法核对']
      if (!allowed.some((v) => body.includes(v))) {
        problems.push({
          code: 'G11-INVALID-VALUE',
          msg: `「${INDEP}」的合法值是 ${allowed.join(' / ')}，实际：${JSON.stringify(body.slice(0, 50))}`,
        })
      }
    }
  }

  return { ok: problems.length === 0, seat, problems, sections: sliced }
}
