#!/usr/bin/env node
// ★★★ 席位定义 → TS 常量 生成器（构建期跑，运行时不读 md）
//
// 依据（用户 2026-09-27）：「把我们现在硬编码的那些乱七八糟的东西向它那边迁移改造。」
// 迁移目标 = `wshobson/agents` 的优点（见 docs/prior-art-subagent-marketplace-2026-09-27.md）：
//   · 一份源（seats/library/*.md）→ 生成物
//   · ★ 生成物**必须被门覆盖**，且**能侦测漂移**（对应它的 `make generate-all` + CI gates registry drift）
//
// ★ 为什么是"构建期生成"而不是"运行时读 md"：
//   运行时要读文件系统 ⇒ 多一个失败面（路径/编码/BOM/权限），且**无法被静态门覆盖**。
//   构建期生成 ⇒ 生成物是纯 TS 常量，**门可以逐字节比对**，漂移立刻红。
//
// 用法：
//   node scripts/seats/gen-seat-registry.mjs            # 写生成物
//   node scripts/seats/gen-seat-registry.mjs --check    # 只比对，不写（门用这个）

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LIB = join(REPO, 'seats', 'library');
const OUT = join(REPO, 'packages', 'subagent-council', 'src', 'seat-registry.generated.ts');

const CHECK = process.argv.includes('--check');

/** 解析一份席位定义。与 check-seat-defs.mjs 用同一套解析规则（形状由那边把关）。 */
function parseDef(p) {
  const raw = readFileSync(p, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error(`${basename(p)}: 没有 frontmatter`);
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: m[2].trimEnd() };
}

/** 生成 TS 字面量：用 JSON.stringify 保证转义正确（★ 不许手拼模板字符串）。 */
function emit(files) {
  const seats = [];
  for (const p of files) {
    const { fm, body } = parseDef(p);
    if (fm.tools !== 'readonly' && fm.tools !== 'full') {
      throw new Error(`${basename(p)}: tools="${fm.tools}" 不合法（只允许 readonly/full）`);
    }
    seats.push({ name: fm.name, description: fm.description, tools: fm.tools, model: fm.model, persona: body, file: basename(p) });
  }
  seats.sort((a, b) => a.name.localeCompare(b.name));

  const L = [];
  L.push('// ★★★ 本文件由 scripts/seats/gen-seat-registry.mjs 自动生成 —— 不要手改。');
  L.push('//');
  L.push('// 源：seats/library/*.md（格式规格 seats/schema.json，来源 wshobson/agents 的 agent 格式，MIT）。');
  L.push('// 漂移由两道门守着：');
  L.push('//   · scripts/seats/gen-seat-registry.mjs --check  ⇒ 生成物与源不一致就红');
  L.push('//   · scripts/seats/check-seat-defs.mjs          ⇒ 源本身的形状');
  L.push('// 手改本文件 ⇒ git diff 里会出现，第二道门会报"生成物与源不一致"。');
  L.push('');
  L.push('export interface SeatDef {');
  L.push('\t/** 席位唯一名（= provider 名） */');
  L.push('\tname: string;');
  L.push('\t/** 第三人称，含触发短语，只写"何时用" */');
  L.push('\tdescription: string;');
  L.push('\t/** 工具档位（机制层强度）：readonly = 白名单 fail-closed；full = 继承父会话 */');
  L.push('\ttools: "readonly" | "full";');
  L.push('\tmodel: string;');
  L.push('\t/** persona 正文（注入子代理，shadow 掉 deployment persona） */');
  L.push('\tpersona: string;');
  L.push('\t/** 来源文件名（可追溯） */');
  L.push('\tfile: string;');
  L.push('}');
  L.push('');
  L.push('/** 所有已上线席位，按 name 排序（★ 顺序稳定 ⇒ 生成物可逐字节比对）。 */');
  L.push('export const SEAT_DEFS: readonly SeatDef[] = [');
  for (const s of seats) {
    L.push('\t{');
    L.push(`\t\tname: ${JSON.stringify(s.name)},`);
    L.push(`\t\tdescription: ${JSON.stringify(s.description)},`);
    L.push(`\t\ttools: ${JSON.stringify(s.tools)},`);
    L.push(`\t\tmodel: ${JSON.stringify(s.model)},`);
    L.push(`\t\tpersona: ${JSON.stringify(s.persona)},`);
    L.push(`\t\tfile: ${JSON.stringify(s.file)},`);
    L.push('\t},');
  }
  L.push('];');
  L.push('');
  L.push('/** name → 定义。★ 未知席位 = undefined（调用方必须显式处理，不许静默降级）。 */');
  L.push('export const SEAT_BY_NAME: Record<string, SeatDef> = Object.fromEntries(');
  L.push('\tSEAT_DEFS.map((s) => [s.name, s]),');
  L.push(');');
  L.push('');
  return L.join('\n');
}

if (!existsSync(LIB)) {
  console.error(`[gen-seat-registry] seats/library/ 不存在: ${LIB}`);
  process.exit(1);
}
const files = readdirSync(LIB).filter((n) => n.endsWith('.md')).map((n) => join(LIB, n));
if (!files.length) {
  console.error('[gen-seat-registry] seats/library/ 下没有 .md');
  process.exit(1);
}

let next;
try {
  next = emit(files);
} catch (e) {
  console.error(`[gen-seat-registry] 生成失败: ${e.message}`);
  process.exit(1);
}

const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;

if (CHECK) {
  if (cur === null) {
    console.error(`[gen-seat-registry] ★ 生成物不存在: ${OUT}`);
    console.error('  ⇒ 跑 `node scripts/seats/gen-seat-registry.mjs` 生成它。');
    process.exit(1);
  }
  if (cur.replace(/\r\n/g, '\n') !== next.replace(/\r\n/g, '\n')) {
    console.error('[gen-seat-registry] ★★ 生成物与源不一致（漂移）——');
    console.error('  源: seats/library/*.md');
    console.error('  物: packages/subagent-council/src/seat-registry.generated.ts');
    console.error('  ⇒ 若你改的是源：重跑生成器。若你改的是生成物：**别手改**，去改源。');
    process.exit(1);
  }
  console.log(`[gen-seat-registry] OK —— ${files.length} 份定义与生成物一致`);
  process.exit(0);
}

writeFileSync(OUT, next, 'utf8');
console.log(`[gen-seat-registry] 已写入 ${OUT}`);
console.log(`  席位 ${files.length} 个: ${files.map((p) => basename(p, '.md')).join(', ')}`);
