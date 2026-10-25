#!/usr/bin/env node
/**
 * handoff-contract.mjs —— 交接包契约（§15.10 dev 阈值转交的标准格式）
 *
 * 交接包 = 子代理到达上下文阈值时的**任务接力**标准产物。
 * 四段固定，顺序不许变（与席位 Output Contract 同族的锚点式解析，fail-closed）。
 *
 * ★ 纯确定性：不联网、不调 LLM、不改盘。
 *
 * 交接包 markdown 形状（锚点 = 段标题）：
 *   # 交接包 · <任务名>
 *   - depth: <递归深度>
 *   - from:  <交出者：席位@深度 或 agent-id>
 *   - to:    review-board
 *   ## 已完成（含证据）
 *   - <条目> —— 证据：<命令/读数/路径>
 *   ## 未完成（剩余）
 *   - <条目> —— 原因：<为什么剩>
 *   ## 关键发现与坑
 *   - <发现>
 *   ## 下一步建议
 *   <一句话>
 */

export const HANDOFF_SECTIONS = ['已完成（含证据）', '未完成（剩余）', '关键发现与坑', '下一步建议']
export const HANDOFF_HEAD = /##\s*(?:已完成（含证据）|未完成（剩余）|关键发现与坑|下一步建议)/

/** 元信息行解析：- depth: N / - from: X / - to: Y */
export function parseMeta(md) {
  const meta = {}
  for (const m of md.matchAll(/^-\s*(depth|from|to):\s*(.+)$/gm)) meta[m[1]] = m[2].trim()
  return meta
}

/** 按锚点切四段；缺段返回 null（fail-closed 由 validate 报）。 */
export function parseHandoff(md) {
  const meta = parseMeta(md)
  const sections = {}
  const re = /^##\s*(已完成（含证据）|未完成（剩余）|关键发现与坑|下一步建议)[^\n]*\n([\s\S]*?)(?=\n##\s|\s*$)/gm
  let m
  while ((m = re.exec(md))) sections[m[1]] = m[2].trim()
  return { meta, sections }
}

/**
 * 校验一份交接包。
 * @returns {{ok:boolean, problems:string[], sections:string[], meta:object}}
 */
export function validateHandoff(md) {
  const problems = []
  const { meta, sections } = parseHandoff(md)

  const present = Object.keys(sections)
  for (const s of HANDOFF_SECTIONS) {
    if (!present.includes(s)) problems.push(`缺段：「${s}」`)
  }

  if (!meta.depth) problems.push('缺元信息：- depth: <递归深度>')
  if (!meta.from) problems.push('缺元信息：- from: <交出者>')
  if (!meta.to) problems.push('缺元信息：- to: review-board（交接必经闸口）')

  // 已完成段：每条必须带证据标记（「证据：」或命令/路径痕迹）
  const done = sections['已完成（含证据）'] || ''
  if (present.includes('已完成（含证据）')) {
    const items = done.split('\n').filter((l) => l.trim().startsWith('- ') && l.trim() !== '-')
    if (items.length === 0) problems.push('「已完成（含证据）」段为空——交了棒就要说清做完了什么')
    for (const it of items) {
      if (!/证据[:：]/.test(it) && !/`/.test(it)) {
        problems.push(`已完成条目缺证据标记（「证据：」或命令/路径）：${it.trim().slice(0, 50)}`)
      }
    }
  }

  // 未完成段：每条带原因
  const todo = sections['未完成（剩余）'] || ''
  if (present.includes('未完成（剩余）')) {
    for (const it of todo.split('\n').filter((l) => l.trim().startsWith('- '))) {
      if (!/原因[:：]|因为|待/.test(it)) {
        problems.push(`未完成条目缺原因：${it.trim().slice(0, 50)}`)
      }
    }
  }

  // 下一步：非空且不是空话
  const next = (sections['下一步建议'] || '').trim()
  if (present.includes('下一步建议') && (!next || /建议进一步评估|再看看/.test(next))) {
    problems.push('「下一步建议」为空或空话收尾——交接包不许以拖延结尾')
  }

  return { ok: problems.length === 0, problems, sections: present, meta }
}
