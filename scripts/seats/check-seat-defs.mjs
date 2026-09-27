#!/usr/bin/env node
// 席位定义门（seat-definition gate）
//
// 判据照 `seats/schema.json` 写 —— **不照实现写**（铁律 37）。
// 改判据 = 改 schema.json；本文件是 schema 的执行面。
//
// 事故背景：席位原先硬编码在 packages/subagent-council/src/index.ts 里（TS 常量），
//   persona 是散文、工具档位是三行字典、编排顺序靠调用方硬编码。
//   目标：把"一席"变成可外部注册、有职责边界、有工序位置的对象。
//
// ★ 三态（铁律 33）：PASS / UNKNOWN（探不到 ⇒ 不判红、显式记）/ FAIL
//   本门不 spawn 任何外部东西 ⇒ 只需要 PASS / FAIL；但目录缺失要报 SKIP 而非 PASS。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SEATS = join(REPO, 'seats');
const LIB = join(SEATS, 'library');
const CANDS = join(SEATS, 'candidates');

const results = [];
function ok(id, msg) { results.push({ id, status: 'PASS', msg }); }
function bad(id, msg) { results.push({ id, status: 'FAIL', msg }); }
function skip(id, msg) { results.push({ id, status: 'SKIP', msg }); }

// ── S1: schema.json 可解析且含必需键 ─────────────────────────────────────────
let schema = null;
try {
  schema = JSON.parse(readFileSync(join(SEATS, 'schema.json'), 'utf8'));
  const need = ['version', 'frontmatter', 'body', 'libraryRules'];
  const miss = need.filter((k) => !(k in schema));
  if (miss.length) bad('S1', `schema.json 缺键: ${miss.join(', ')}`);
  else ok('S1', `schema.json 可解析，version=${schema.version}`);
} catch (e) {
  bad('S1', `schema.json 读不到/解析失败: ${e.message}`);
}

// ── S2: library/ 存在 ────────────────────────────────────────────────────────
if (!existsSync(LIB)) skip('S2', 'seats/library/ 不存在（本门不判红）');
else ok('S2', `seats/library/ 存在`);

// ── 逐份定义检查 ─────────────────────────────────────────────────────────────
function parseDef(p) {
  const raw = readFileSync(p, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { err: '没有 frontmatter（--- 包裹）' };
  const fmRaw = m[1];
  const body = m[2];
  const fm = {};
  for (const line of fmRaw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) { return { err: `frontmatter 行无法解析: ${line.slice(0, 60)}` }; }
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, fmRaw, body, raw };
}

const defs = [];
if (existsSync(LIB)) {
  for (const n of readdirSync(LIB)) {
    if (!n.endsWith('.md')) continue;
    defs.push(join(LIB, n));
  }
}

if (!defs.length) {
  skip('S3', 'seats/library/ 下没有 .md 定义');
} else {
  ok('S3', `找到 ${defs.length} 份席位定义: ${defs.map((p) => p.split(/[\\/]/).pop()).join(', ')}`);

  const seenNames = new Map();
  const required = schema?.frontmatter?.required ?? ['name', 'description', 'tools', 'model'];
  const totalMax = schema?.frontmatter?.totalMaxChars ?? 1024;
  const requiredSections = schema?.body?.requiredSections ?? [];
  const minBody = schema?.body?.minBodyChars ?? 0;

  for (const p of defs) {
    const file = p.split(/[\\/]/).pop();
    const tag = (id) => `${id}[${file}]`;
    const r = parseDef(p);
    if (r.err) { bad(tag('D1'), r.err); continue; }
    const { fm, fmRaw, body } = r;

    // D1 必需字段
    const miss = required.filter((k) => !(k in fm));
    if (miss.length) { bad(tag('D1'), `缺必需字段: ${miss.join(', ')}`); continue; }
    ok(tag('D1'), `四个必需字段齐全`);

    // D2 name 形状 + 唯一性（铁律 18）
    const nameRule = schema?.frontmatter?.fields?.name;
    if (nameRule?.pattern) {
      const re = new RegExp(nameRule.pattern);
      if (!re.test(fm.name)) bad(tag('D2'), `name "${fm.name}" 不符 ${nameRule.pattern}`);
      else if (fm.name.length > (nameRule.maxChars ?? 64)) bad(tag('D2'), `name 过长（${fm.name.length}）`);
      else ok(tag('D2'), `name="${fm.name}" 形状合规`);
    }
    if (seenNames.has(fm.name)) {
      bad(tag('D3'), `★ name 与 ${seenNames.get(fm.name)} 重名 ⇒ 会静默遮蔽（铁律 18）`);
    } else {
      seenNames.set(fm.name, file);
      ok(tag('D3'), `name 唯一`);
    }

    // D4 frontmatter 总量
    if (fmRaw.length > totalMax) bad(tag('D4'), `frontmatter ${fmRaw.length} 字符 > ${totalMax}`);
    else ok(tag('D4'), `frontmatter ${fmRaw.length} 字符 ≤ ${totalMax}`);

    // D5 description 形状
    const dr = schema?.frontmatter?.fields?.description;
    if (dr) {
      if (fm.description.length > (dr.maxChars ?? 500))
        bad(tag('D5'), `description ${fm.description.length} 字符 > ${dr.maxChars}`);
      else {
        const hits = (dr.mustIncludeOneOf ?? []).filter((kw) => fm.description.includes(kw));
        if (!hits.length) bad(tag('D5'), `description 无触发短语（需要其一: ${(dr.mustIncludeOneOf ?? []).join(' | ')}）`);
        else ok(tag('D5'), `description ${fm.description.length} 字符，触发短语="${hits[0]}"`);
      }
    }

    // D6 tools 档位合法
    const toolEnum = schema?.frontmatter?.fields?.tools?.enum ?? ['readonly', 'full'];
    if (!toolEnum.includes(fm.tools)) bad(tag('D6'), `tools="${fm.tools}" 不在 ${JSON.stringify(toolEnum)}`);
    else ok(tag('D6'), `tools=${fm.tools}`);

    // D7 model 合法
    const modelEnum = schema?.frontmatter?.fields?.model?.enum ?? ['inherit'];
    if (!modelEnum.includes(fm.model)) bad(tag('D7'), `model="${fm.model}" 不在 ${JSON.stringify(modelEnum)}`);
    else ok(tag('D7'), `model=${fm.model}`);

    // D8 必需章节
    const missSec = requiredSections.filter((s) => !body.includes(s));
    if (missSec.length) bad(tag('D8'), `缺章节: ${missSec.join(', ')}`);
    else ok(tag('D8'), `${requiredSections.length} 个必需章节齐全`);

    // D9 正文长度
    if (body.length < minBody) bad(tag('D9'), `正文 ${body.length} 字符 < ${minBody}`);
    else ok(tag('D9'), `正文 ${body.length} 字符`);

    // D10 Workflow Position 必须含 After/Complements/Enables（★ 我们原先没有的块）
    const wp = body.match(/## Workflow Position([\s\S]*?)(?=\n## |$)/);
    if (!wp) ok(tag('D10'), '（D8 已覆盖）');
    else {
      const missing = ['After', 'Complements', 'Enables'].filter((k) => !wp[1].includes(k));
      if (missing.length) bad(tag('D10'), `Workflow Position 缺 ${missing.join(', ')}`);
      else ok(tag('D10'), 'Workflow Position 含 After/Complements/Enables');
    }

    // D11 Key Distinctions 必须至少有一条 "vs " 对照
    const kd = body.match(/## Key Distinctions([\s\S]*?)(?=\n## |$)/);
    if (kd && !/vs\s/.test(kd[1])) bad(tag('D11'), 'Key Distinctions 里没有任何 "vs X" 对照');
    else if (kd) ok(tag('D11'), 'Key Distinctions 有跨席对照');

    // ── F5 ★★★ 档位与"我不做"声明的一致性（规格见 schema.json 的 toolScopeConsistency）──
    // ★ 作用域限定（铁律 41）：**只**在 `## Key Distinctions` 节里、以 `你不做` 开头的**那一条**里找，
    //   且只看冒号**之后**的枚举项。理由写在 schema.json 的 `declarationAnchor.why` 里。
    //   ★ 不许退化成全文匹配 —— 实测全文里 `改方案`（合法）与 `改文件`（写动作）只差一个字。
    const f5 = schema?.toolScopeConsistency;
    if (!f5 || !kd) {
      skip(tag('F5'), '规格里没有 toolScopeConsistency 或本节缺失（本门不判红）');
    } else {
      const anchor = f5.declarationAnchor ?? {};
      const prefix = anchor.itemPrefix ?? '你不做';
      // 从 Key Distinctions 节里取那条声明；`你不做` 后面到行尾/下一个列表项之间
      const declRe = new RegExp(`[-*]\\s*[★\\s]*\\*\\*${prefix}\\*\\*\\s*[:：]([^\\n]*)`);
      const dm = declRe.exec(kd[1]);
      const declText = dm ? dm[1] : null;
      // 该条里冒号之后的枚举项（顿号/逗号/分号分隔）
      const items = declText
        ? declText
            .split(/[、,，;；]/)
            .map((s) => s.replace(/[*`]/g, '').trim())
            .filter(Boolean)
        : [];
      const writeTerms = f5.writeActions?.terms ?? [];
      const declaredWriteRefusal = items.filter((it) => writeTerms.some((w) => it.includes(w)));
      const isReadonly = fm.tools === 'readonly';

      // F5-a：声明不做写动作 ⇒ 必须 readonly
      if (declaredWriteRefusal.length > 0) {
        if (isReadonly) ok(tag('F5a'), `声明不做[${declaredWriteRefusal.join(',')}]且 tools=readonly ⇒ 自洽`);
        else
          bad(
            tag('F5a'),
            `★ 正文【你不做】里声明了写动作式约束[${declaredWriteRefusal.join(',')}]，但 tools="${fm.tools}" ⇒ ` +
              `散文与机制脱节（纸上约束）。要么把 tools 改成 readonly，要么从声明里去掉这些项`,
          );
      } else {
        ok(tag('F5a'), `【你不做】里无写动作声明（不做该规则）`);
      }

      // F5-b：readonly ⇒ 必须显式声明了【你不做】的清单
      if (isReadonly) {
        if (declText && items.length > 0) ok(tag('F5b'), `tools=readonly 且【你不做】有 ${items.length} 项声明`);
        else
          bad(
            tag('F5b'),
            `★ tools=readonly 但正文【你不做】清单缺失/为空 ⇒ 下游读者会以为「忘了开权限」而不是「设计如此」`,
          );
      } else {
        ok(tag('F5b'), `tools=${fm.tools}（本条只对 readonly 席生效）`);
      }
    }
  }
}

// ── C1: candidates/ 里的候选必须带 provenance ───────────────────────────────
if (!existsSync(CANDS)) {
  skip('C1', 'seats/candidates/ 不存在（尚未从外部取料）');
} else {
  const cd = readdirSync(CANDS).filter((n) => n.endsWith('.md'));
  if (!cd.length) skip('C1', 'seats/candidates/ 为空');
  else {
    const needKeys = schema?.libraryRules?.provenanceRequiredKeys ?? ['sourceUrl', 'license', 'retrieved', 'modified'];
    let badN = 0;
    for (const n of cd) {
      const t = readFileSync(join(CANDS, n), 'utf8');
      const miss = needKeys.filter((k) => !new RegExp(`\\b${k}\\b`, 'i').test(t));
      if (miss.length) { bad(`C1[${n}]`, `候选缺 provenance 键: ${miss.join(', ')}`); badN++; }
    }
    if (!badN) ok('C1', `${cd.length} 份候选都带 provenance`);
  }
}

// ── 消融自证（铁律 21）：本门必须能红 ───────────────────────────────────────
// 证明方法：把 library 里第一份定义的 "## Red Flags" 删掉 — 若门仍绿，则本门是假的。
// 这里做**只读**的等价检查：确认 D8 的必需章节里确实含 "## Red Flags"。
if (schema?.body?.requiredSections?.includes('## Red Flags')) {
  ok('A1', '消融自证：Red Flags 在必需章节里 ⇒ 删掉它 D8 必红');
} else {
  bad('A1', '★ 消融自证失败：Red Flags 不在必需章节 ⇒ 删掉它门不会红（本门是假的）');
}

// ── A2 ★★★ F5 的消融自证 ─────────────────────────────────────────────────────
// 本门最该防的是"散文与机制脱节"。要证明 F5 真的在跑，得说清**什么输入会让它红**：
//   · F5-a 变红的条件：某席正文【你不做】里声明了写动作（如"改文件"）而 tools 仍是 full；
//   · F5-b 变红的条件：某席 tools=readonly 但【你不做】清单缺失。
// ★ 这里做**只读**的等价检查：确认规格里的 writeActions 非空 **且** declarationAnchor 指到了
//   `## Key Distinctions` —— 少了任一条，F5 就会退化成"恒绿"（假绿，比没有门更糟）。
const f5spec = schema?.toolScopeConsistency;
const f5Wired =
  Array.isArray(f5spec?.writeActions?.terms) &&
  f5spec.writeActions.terms.length > 0 &&
  f5spec?.declarationAnchor?.section === '## Key Distinctions' &&
  schema?.body?.requiredSections?.includes('## Key Distinctions');
if (f5Wired) {
  ok('A2', `消融自证：F5 有 ${f5spec.writeActions.terms.length} 个写动作词 + 锚在必需章节 Key Distinctions ⇒ 两条规则都能红`);
} else {
  bad('A2', '★ 消融自证失败：F5 的规格不完整（写动作词为空 / 锚点不是必需章节）⇒ F5 会恒绿');
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const j = process.argv.includes('--json');
if (j) {
  console.log(JSON.stringify({ results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : 'FAIL';
    console.log(`[${mark}] ${r.id}: ${r.msg}`);
  }
}
const failed = results.filter((r) => r.status === 'FAIL').length;
const passed = results.filter((r) => r.status === 'PASS').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
if (!j) console.log(`\n${passed} PASS / ${failed} FAIL / ${skipped} SKIP`);
process.exit(failed > 0 ? 1 : 0);
