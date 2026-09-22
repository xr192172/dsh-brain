#!/usr/bin/env node
/**
 * ds-token-count.mjs —— 用 DeepSeek **官方开源** tokenizer 计 token 数（离线、只读）
 *
 * 目的：测试实际跑在 AGNES 上游（免费），但需要同时知道「按 DeepSeek 计价口径」的 token 数。
 *
 * tokenizer 来源（官方，非近似）：
 *   deepseek-ai/DeepSeek-V4-Flash 的 tokenizer.json（= 会话里 model: deepseek-v4-flash 的官方分词器）
 *   资产固化在 vendor/deepseek-tokenizer/，加载器用 HF 官方纯 JS 实现 @huggingface/tokenizers@0.2.0。
 *   版本/哈希/许可 详见 vendor/deepseek-tokenizer/PROVENANCE.md
 *
 * 用法：
 *   node scripts/ds-token-count.mjs --text "要算的文本"
 *   node scripts/ds-token-count.mjs --file <path>
 *   node scripts/ds-token-count.mjs --session <sessionId|前缀>
 * 选项：
 *   --json <path>           把同样的单行 JSON 落盘
 *   --sessions-root <dir>   会话根目录（默认 ~/.dsh/sessions）
 *
 * 计数口径（重要，别混用）：
 *   - tokens = Tokenizer.encode(text).ids.length，**不加任何特殊 token**（该 tokenizer.json 的
 *     post_processor 是纯 ByteLevel，无 BOS/EOS，add_special_tokens 无效果）
 *   - chars  = JS String.length（UTF-16 code unit），与仓库既有经验值口径一致
 *   - charsPerToken = chars / tokens
 *   - --session 模式：
 *       system = request/header.system 原文
 *       tools  = JSON.stringify(request/header.tools)  ← 与 out/face-anatomy.txt 口径一致
 *       messages = user/message | assistant/message | tool/result 的 **prompt 生效文本**
 *                  （text / tool-call(name+arguments) / tool-result；**reasoning 不计入**，
 *                    单独汇总到 reasoningExcluded 字段，不静默丢弃）
 *       totals = system + tools + 所有 messages
 *       firstStep = system + tools + 首个 assistant/message **之前**的消息
 *                   （= 第 1 步真正发出去的提示词）
 *   - providerUsage 直接抄会话日志里 provider 返回的 usage。
 *     依 dsh-llm TokenUsage 注释，inputTokens / cacheReadTokens / cacheWriteTokens 三者 disjoint，
 *     故 promptTokens = 三者之和。★ 这是 **provider（AGNES）口径**，与上面的 DeepSeek 口径是两套东西。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const VENDOR = path.join(REPO, 'vendor', 'deepseek-tokenizer');

/** 官方 tokenizer 资产（blob sha1 可与 HF tree API 的 oid 对拍，见 PROVENANCE.md） */
const TOKENIZER = {
  id: 'deepseek-v4-flash',
  repo: 'deepseek-ai/DeepSeek-V4-Flash',
  url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/resolve/main/tokenizer.json',
  file: path.join(VENDOR, 'v4-flash', 'tokenizer.json'),
  config: path.join(VENDOR, 'v4-flash', 'tokenizer_config.json'),
  bytes: 6367146,
  gitBlobSha1: '628e3364caad11bdf9e67cea06eae7878122811d',
  sha256: '8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf',
};
const LOADER = path.join(VENDOR, 'lib', 'tokenizers.mjs');

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const SESSION_FILES = ['session.jsonl.zstd', 'session.v2.jsonl.zstd'];

const USAGE = `用法:
  node scripts/ds-token-count.mjs --text "<文本>"
  node scripts/ds-token-count.mjs --file <path>
  node scripts/ds-token-count.mjs --session <sessionId|前缀>
选项:
  --json <path>               同时把单行 JSON 写入文件
  --sessions-root <dir>       会话根目录（默认 ~/.dsh/sessions）`;

// ---------------------------------------------------------------- 参数
function parseArgs(argv) {
  const out = { _: [] };
  const takesValue = new Set(['text', 'file', 'session', 'json', 'sessions-root']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'help' || key === 'h') { out.help = true; continue; }
    if (!takesValue.has(key)) throw new Error(`未知参数: ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`参数 ${a} 缺少值`);
    out[key] = v;
  }
  return out;
}

function die(msg, code = 2) {
  process.stderr.write(`${msg}\n\n${USAGE}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------- tokenizer
let tok = null;
async function loadTokenizer() {
  if (tok) return tok;
  if (!fs.existsSync(LOADER)) throw new Error(`缺少 tokenizer 加载器: ${LOADER}`);
  if (!fs.existsSync(TOKENIZER.file)) throw new Error(`缺少 tokenizer 资产: ${TOKENIZER.file}`);
  const { Tokenizer } = await import(pathToFileURL(LOADER).href);
  tok = new Tokenizer(
    JSON.parse(fs.readFileSync(TOKENIZER.file, 'utf8')),
    fs.existsSync(TOKENIZER.config) ? JSON.parse(fs.readFileSync(TOKENIZER.config, 'utf8')) : {},
  );
  return tok;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function measure(t, text) {
  const s = text ?? '';
  const chars = s.length;
  const tokens = s.length ? t.encode(s).ids.length : 0;
  return { chars, tokens, charsPerToken: tokens ? round3(chars / tokens) : null };
}

// ---------------------------------------------------------------- 会话解码
/** DSH 的 session.jsonl.zstd 是**多帧 zstd 顺序拼接**，node:zlib 的解压器只认第一帧 ⇒ 按帧魔数切分 */
function decodeSessionFile(file) {
  const raw = fs.readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offsets.push(i);
  }
  if (!offsets.length) throw new Error(`${file}: 不是 zstd 容器`);
  const parts = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length;
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(start, end)));
    } catch (e) {
      throw new Error(`${file}: 第 ${i + 1}/${offsets.length} 帧解压失败（${e.message}）`);
    }
  }
  const text = Buffer.concat(parts).toString('utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return { events, frames: offsets.length };
}

function findSessions(root, spec) {
  const hits = [];
  if (!fs.existsSync(root)) return hits;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dp = path.join(root, d.name);
    for (const s of fs.readdirSync(dp, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      if (!`${d.name}/${s.name}`.includes(spec)) continue;
      for (const cand of SESSION_FILES) {
        const f = path.join(dp, s.name, cand);
        if (fs.existsSync(f)) { hits.push({ dir: d.name, session: s.name, file: f }); break; }
      }
    }
  }
  return hits;
}

/** 把 content 部件数组拍成「prompt 生效文本」+「reasoning 文本」 */
function splitContent(parts) {
  const eff = [], rea = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { eff.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (typeof v !== 'object') return;
    if (v.type === 'reasoning') { if (typeof v.text === 'string') rea.push(v.text); return; }
    if (v.type === 'tool-call') { eff.push(`${v.name ?? v.toolName ?? ''}${v.arguments ?? ''}`); return; }
    if (v.type === 'tool-result') { walk(v.content); return; }
    if (typeof v.text === 'string') { eff.push(v.text); return; }
    if (v.content !== undefined) { walk(v.content); return; }
  };
  walk(parts);
  return { effective: eff.join('\n'), reasoning: rea.join('\n') };
}

const MESSAGE_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result']);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function countSession(t, hit) {
  const { events, frames } = decodeSessionFile(hit.file);
  const meta = events.find((e) => e.type === 'session') ?? {};
  const header = events.find((e) => e.type === 'request/header')?.data?.header;
  const ctx = events.find((e) => e.type === 'request/context')?.data;

  const system = measure(t, typeof header?.system === 'string' ? header.system : '');
  const toolsArr = Array.isArray(header?.tools) ? header.tools : [];
  const tools = { count: toolsArr.length, ...measure(t, JSON.stringify(toolsArr)) };
  const faceChars = system.chars + tools.chars;
  const faceTokens = system.tokens + tools.tokens;
  const face = { chars: faceChars, tokens: faceTokens, charsPerToken: faceTokens ? round3(faceChars / faceTokens) : null };

  const messages = [];
  let reasoningChars = 0, reasoningTokens = 0;
  for (const e of events) {
    if (!MESSAGE_EVENTS.has(e.type)) continue;
    const m = e.data?.message ?? e.data;
    const { effective, reasoning } = splitContent(m?.content);
    if (reasoning) {
      const r = measure(t, reasoning);
      reasoningChars += r.chars; reasoningTokens += r.tokens;
    }
    messages.push({ seq: e.seq, event: e.type, role: m?.role ?? null, ...measure(t, effective) });
  }

  const sumTokens = (xs) => xs.reduce((a, x) => a + x.tokens, 0);
  const sumChars = (xs) => xs.reduce((a, x) => a + x.chars, 0);

  // 第 1 步真正发出去的提示词 = 脸 + 首个 assistant/message 之前的消息
  const firstAsstSeq = events.find((e) => e.type === 'assistant/message')?.seq;
  const head = firstAsstSeq === undefined ? messages : messages.filter((m) => m.seq < firstAsstSeq);

  const mk = (n, chars, tokens) => ({ messages: n, chars, tokens, charsPerToken: tokens ? round3(chars / tokens) : null });

  const providerUsage = [];
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    const u = e.data?.usage;
    if (!u || typeof u !== 'object') continue;
    providerUsage.push({
      seq: e.seq, turn: e.data?.turn ?? null, step: e.data?.step ?? null,
      inputTokens: num(u.inputTokens), cacheReadTokens: num(u.cacheReadTokens),
      cacheWriteTokens: num(u.cacheWriteTokens), outputTokens: num(u.outputTokens),
      reasoningTokens: num(u.reasoningTokens),
      promptTokens: num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens),
    });
  }

  return {
    tokenizer: { id: TOKENIZER.id, repo: TOKENIZER.repo, gitBlobSha1: TOKENIZER.gitBlobSha1 },
    session: meta.id ?? hit.session,
    dir: hit.dir,
    file: hit.file,
    preset: meta.agentPreset ?? null,
    provider: ctx?.provider ?? null,
    model: ctx?.model ?? null,
    contextWindow: ctx?.contextWindow ?? null,
    frames,
    events: events.length,
    system,
    tools,
    face,
    messages,
    totals: mk(messages.length, faceChars + sumChars(messages), faceTokens + sumTokens(messages)),
    firstStep: mk(head.length, faceChars + sumChars(head), faceTokens + sumTokens(head)),
    reasoningExcluded: { chars: reasoningChars, tokens: reasoningTokens },
    providerUsage,
  };
}

// ---------------------------------------------------------------- main
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { die(`参数错误: ${e.message}`); }
  if (args.help) { process.stdout.write(`${USAGE}\n`); return; }

  const picked = ['text', 'file', 'session'].filter((k) => args[k] !== undefined);
  if (picked.length !== 1) die(`必须且只能指定 --text / --file / --session 之一（当前: ${picked.length ? picked.join('+') : '无'}）`);

  const t = await loadTokenizer();
  let result;

  if (args.text !== undefined) {
    result = { tokenizer: TOKENIZER.id, ...measure(t, args.text) };
  } else if (args.file !== undefined) {
    let text;
    try { text = fs.readFileSync(args.file, 'utf8'); } catch (e) { die(`读文件失败: ${e.message}`); }
    result = { tokenizer: TOKENIZER.id, ...measure(t, text) };
  } else {
    const root = args['sessions-root'] ?? DEFAULT_SESSIONS_ROOT;
    const hits = findSessions(root, args.session);
    if (!hits.length) die(`找不到会话: ${args.session}（在 ${root} 下）`);
    if (hits.length > 1) {
      die(`会话前缀歧义，匹配到 ${hits.length} 条:\n` + hits.map((h) => `  ${h.dir}/${h.session}`).join('\n'), 3);
    }
    result = countSession(t, hits[0]);
  }

  const line = JSON.stringify(result);
  if (args.json) fs.writeFileSync(args.json, `${line}\n`, 'utf8');
  process.stdout.write(`${line}\n`);
}

main().catch((e) => {
  process.stderr.write(`错误: ${e.message}\n`);
  process.exit(1);
});
