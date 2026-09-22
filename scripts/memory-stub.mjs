#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/memory-stub.mjs
//
// ★ 这是**记忆面的 stub**（桩），**不是真实现**。
//   **契约形状 = 将来真 MCP 记忆面的形状**：
//     【读】检索(recall) + 【写】记录(remember) + 【条目数】状态读数(count/reset)
//   依据：docs/memory-effect-judge-design.md §7（判据只需要这三样）。
//   ⇒ 将来把本 stub 换成真 MCP 面时，**命令名 / 参数 / stdout 形状不变**，
//     判据机器无需改动，只换实现。
//
// CLI 契约（不可改）：
//   node scripts/memory-stub.mjs count    --db <path>
//       → stdout 单行 JSON {"db":"<path>","count":N}
//   node scripts/memory-stub.mjs recall   --db <path> --query <text> [--limit N]
//       → stdout 单行 JSON 数组，每项 {"text":..,"kind":..,"at":..}
//   node scripts/memory-stub.mjs remember --db <path> --text <t> [--kind <k>]
//       → 追加一条；stdout 单行 JSON {"db":..,"count":N}
//   node scripts/memory-stub.mjs reset    --db <path>
//       → 清空；stdout 单行 JSON {"db":..,"count":0}
//
// 其它约定：
//   - db 是一个 JSON 文件路径（UTF-8 无 BOM），内容 = [{text,kind,at}, ...]。
//     文件不存在 ⇒ count=0 / recall=[] / remember 会自动创建（含父目录）。
//   - 除用法错误、参数缺失（exit 2 + 打印用法到 stderr）外，**一律 exit 0**。
//   - 只依赖 node:fs / node:path，**无第三方包**。
//   - stdout 只输出一行 JSON（诊断信息一律走 stderr），便于判据直接解析。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

const USAGE = `记忆面 stub（非真实现；契约形状 = 将来 MCP 面的形状）

用法：
  node scripts/memory-stub.mjs count    --db <path>
  node scripts/memory-stub.mjs recall   --db <path> --query <text> [--limit N]
  node scripts/memory-stub.mjs remember --db <path> --text <t> [--kind <k>]
  node scripts/memory-stub.mjs reset    --db <path>

参数：
  --db     <path>  JSON 库文件路径（不存在会被 remember 创建，含父目录）
  --query  <text>  recall 的查询串（中文按字符 bigram + 整段包含匹配）
  --limit  <N>     recall 最多返回条数，默认 5
  --text   <t>     remember 的记忆文本
  --kind   <k>     remember 的记忆类别，默认 "note"
`;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 2) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined) return { opts, error: `选项 ${a} 缺少取值` };
    opts[key] = val;
    i++;
  }
  return { opts, error: null };
}

function usageError(msg) {
  process.stderr.write(`[memory-stub] 用法错误：${msg}\n\n${USAGE}`);
  process.exit(2);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// 库读写
// ---------------------------------------------------------------------------

function readDb(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // 不存在 ⇒ 空库
  }
  const s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // 去掉 BOM（若有）
  if (s.trim() === '') return [];
  let data;
  try {
    data = JSON.parse(s);
  } catch (e) {
    process.stderr.write(`[memory-stub] 警告：${file} 不是合法 JSON，按空库处理（${e.message}）\n`);
    return [];
  }
  if (!Array.isArray(data)) {
    process.stderr.write(`[memory-stub] 警告：${file} 顶层不是数组，按空库处理\n`);
    return [];
  }
  return data;
}

function writeDb(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // ★ 只用 writeFileSync(path, string)，不玩任何编码技巧；JSON.stringify 不转义中文。
  fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 朴素检索：按 非字母数字/非汉字 切段；中文段再补「整段 + 字符 bigram」
// ---------------------------------------------------------------------------

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function tokenize(s) {
  const out = [];
  const segs = String(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const seg of segs) {
    out.push(seg); // 整段（ASCII 单词 / 中文连写都先当 1 个 token）
    if (CJK.test(seg)) {
      const chars = [...seg];
      if (chars.length === 1) out.push(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]); // 中文 bigram
    }
  }
  return out;
}

function recall(items, query, limit) {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];
  const scored = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const text = typeof it.text === 'string' ? it.text : '';
    const lower = text.toLowerCase();
    const iTokens = new Set(tokenize(text));
    let hits = 0;
    // 命中 = 该 query 词元整体出现（含中文单字的包含判断）或 bigram 命中
    for (const t of qTokens) if (iTokens.has(t) || lower.includes(t)) hits++;
    if (hits > 0) scored.push({ entry: it, hits });
  }
  // 命中数降序；其次「最近的在前」（ISO 时间串按字典序比较即可）
  scored.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return String(b.entry.at || '').localeCompare(String(a.entry.at || ''));
  });
  return scored.slice(0, limit).map((s) => ({
    text: String(s.entry.text),
    kind: String(s.entry.kind),
    at: String(s.entry.at),
  }));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv[0];

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

const { opts, error } = parseArgs(argv.slice(1));
if (error) usageError(error);

const KNOWN = ['count', 'recall', 'remember', 'reset'];
if (!KNOWN.includes(cmd)) usageError(`未知子命令 ${cmd}`);

if (opts.db === undefined) usageError(`子命令 ${cmd} 缺少 --db`);
const dbArg = opts.db; // 原样回显（契约里的 "<path>"）
const file = path.resolve(dbArg);

if (cmd === 'count') {
  emit({ db: dbArg, count: readDb(file).length });
} else if (cmd === 'recall') {
  if (opts.query === undefined) usageError('子命令 recall 缺少 --query');
  let limit = 5;
  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 0) usageError(`--limit 需要一个非负整数，收到 ${opts.limit}`);
    limit = n;
  }
  emit(recall(readDb(file), opts.query, limit));
} else if (cmd === 'remember') {
  if (opts.text === undefined) usageError('子命令 remember 缺少 --text');
  const items = readDb(file);
  items.push({
    text: String(opts.text),
    kind: opts.kind === undefined ? 'note' : String(opts.kind),
    at: new Date().toISOString(),
  });
  writeDb(file, items);
  emit({ db: dbArg, count: items.length });
} else {
  // reset
  writeDb(file, []);
  emit({ db: dbArg, count: 0 });
}
