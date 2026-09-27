/**
 * test-seat-toolscope.mjs —— O8 的判据：**席位的工具档位必须在机制层可核**
 *
 * 背景（见 `packages/subagent-council/src/index.ts` 的 READONLY_ALLOW 注释）：
 *   `architect` 席的 persona 写着「默认只读。…不要修改任何文件」，
 *   但它**真的往仓库里写了一个脚本**（现场证据 `out/seat-wrote-this-_analyze-personas.mjs`）。
 *   ⇒ 教训：**写在 persona 里的约束不是约束**（铁律 40 同族：最坏的形状是"该管的没人管"）。
 *
 * 本门验三件事：
 *   P1 **机制接线**：`start()` 真的把 `toolFilter` 放进 request（不是只声明 capabilities）
 *   P2 ★★ **阳性对照**：`dev` 席**必须不设限** —— 若三席全被禁写，那不是修好了，是把能力掐死了
 *   P3 ★★ **名字真的存在**：allow 名单里的每一个名字都必须在**真实工具面**里出现过
 *      （`tools.restrict()` 对未知名字**抛错** ⇒ 名字写错会让席位**起不来**；
 *        而如果只做 P1 不做 P3，就会造出"filter 设了、但一套上去就崩"的假绿）
 *   P4 **fail-closed**：未知席位默认 readonly（不是默认全开）
 *   P5 ★★ **消融自证**：撤掉 start() 里那两行 ⇒ P1 必须变红
 *   P6 ★★★ **作用域限定**（铁律 41）：只在**代码**里找 `toolFilter` 赋值/`tools.restrict(`
 *      —— 上一版我在 `_o8-repro.mjs` 里用裸正则命中了 `capabilities.toolFilter: true`
 *        （那是"我支持"，不是"我限制"）⇒ **假绿**。这条把那个错误固化成判据。
 *
 * 用法：node scripts/seats/test-seat-toolscope.mjs
 * 退出码：0 = 全过；1 = 有 FAIL
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decompress } from 'fzstd';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '..', '..');
const SRC = path.join(WT, 'packages/subagent-council/src/index.ts');
const HOME = 'C:/Users/Admin/.dsh';

const results = [];
const check = (n, ok, detail) => {
  results.push({ n, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`);
};

const src = fs.readFileSync(SRC, 'utf8');
/** 去掉注释 ⇒ 只在真实代码里判定（P6）。 */
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─── P1 机制接线 ─────────────────────────────────────────────────────────────
// 判据：`next.toolFilter = ...` 这行**在代码里**（不是注释里）
const assignsFilter = /next\.toolFilter\s*=/.test(codeOnly);
check(
  'P1 start() 真的把 toolFilter 放进 request',
  assignsFilter,
  assignsFilter ? '找到 `next.toolFilter = {...}`' : '★ 没找到 —— 席位仍然继承全部工具',
);

// ─── P2 阳性对照：dev 席必须不设限 ───────────────────────────────────────────
// 这条与"只读席位被挡住"**正交**：它证明限制是"按席位"的，不是"一刀切"。
const devFull = /dev\s*:\s*["']full["']/.test(codeOnly);
const architectRo = /architect\s*:\s*["']readonly["']/.test(codeOnly);
const reviewRo = /review\s*:\s*["']readonly["']/.test(codeOnly);
check(
  'P2 阳性对照：dev 席 = full（不被禁写）',
  devFull,
  devFull ? 'dev: "full" ⇒ 施工席保留全部工具（若全禁 = 把能力掐死，不是修好）' : '★ dev 席也被限了 ⇒ 阳性对照缺失',
);
check(
  'P2b 只读两侧：architect / review 都是 readonly',
  architectRo && reviewRo,
  `architect=${architectRo} review=${reviewRo}`,
);

// ─── P3 名字真的存在（拿真实工具面核）────────────────────────────────────────
/** 从现役会话里取一个【真实生效过】的工具面。 */
function realToolFace() {
  const root = path.join(HOME, 'sessions');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  const files = [];
  for (const d of dirs) {
    const dp = path.join(root, d);
    let kids = [];
    try { kids = fs.readdirSync(dp); } catch { continue; }
    for (const s of kids) {
      const f = path.join(dp, s, 'session.jsonl.zstd');
      if (fs.existsSync(f)) files.push({ f, mtime: fs.statSync(f).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files) {
    let text;
    try { text = Buffer.from(decompress(fs.readFileSync(f))).toString('utf8'); } catch { continue; }
    const evs = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const h = evs.find((e) => e.type === 'request/header');
    const tools = (h?.data?.header?.tools ?? []).map((t) => (typeof t === 'string' ? t : t?.name ?? t?.function?.name)).filter(Boolean);
    if (tools.length) return { tools, file: path.relative(root, f) };
  }
  return null;
}

const face = realToolFace();
// 从源码里抽出 allow 名单的字面量
const allowBlock = codeOnly.match(/READONLY_ALLOW[^=]*=\s*\[([\s\S]*?)\]/);
const allowNames = allowBlock
  ? [...allowBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];

check(
  'P3a 能从源码抽出 allow 名单',
  allowNames.length > 0,
  `抽到 ${allowNames.length} 个: ${allowNames.join(',')}`,
);

if (face) {
  const missing = allowNames.filter((n) => !face.tools.includes(n));
  check(
    'P3b allow 里每个名字都在【真实工具面】里出现过',
    missing.length === 0,
    missing.length === 0
      ? `样本=${face.file}（工具面 ${face.tools.length} 个）；${allowNames.length} 个名字全部命中`
      : `★ 未知名字 ${JSON.stringify(missing)} ⇒ tools.restrict() 会【抛错】⇒ 席位起不来`,
  );
  // ★ 反向断言：allow 里**不许**混进写类工具
  const writey = allowNames.filter((n) => /^(write|edit|bash|pwsh)$/.test(n) || /__(edit|rename|move|scaffold|archive|rollback|remove_dead)/.test(n));
  check(
    'P3c allow 里不许混进写类工具',
    writey.length === 0,
    writey.length === 0 ? '无写类工具混入' : `★ 混进了 ${JSON.stringify(writey)}`,
  );
  // ★★ 反向断言：父会话工具面里**确实有**写工具 ⇒ 证明 P1 的修复是【必要的】（不是空修复）
  const parentWrites = face.tools.filter((n) => /^(write|edit|pwsh|bash)$/.test(n));
  check(
    'P3d 前置事实：父会话工具面里确有写工具（⇒ 席位的限制不是多余的）',
    parentWrites.length > 0,
    `父会话里有 ${JSON.stringify(parentWrites)} ⇒ 若不限制，席位继承它们`,
  );
} else {
  check('P3b allow 里每个名字都在【真实工具面】里出现过', false, '★ 读不到真实工具面 ⇒ 无法核对（不判"通过"：铁律 14/33）');
}

// ─── P4 fail-closed：未知席位默认 readonly ───────────────────────────────────
const defaultsRo = /\?\?\s*["']readonly["']/.test(codeOnly) || /工具档位.*默认\s*readonly/.test(src);
check(
  'P4 未知席位默认 readonly（fail-closed）',
  defaultsRo,
  defaultsRo ? '有 `?? "readonly"` 兜底' : '★ 未知席位会落到"不加限制" ⇒ fail-open',
);

// ─── P5 消融：撤掉 start() 里那两行 ⇒ P1 变红 ────────────────────────────────
{
  const ablated = codeOnly.replace(/next\.toolFilter\s*=\s*\{[^}]*\}\s*;?/g, '/* ablated */');
  const stillAssigns = /next\.toolFilter\s*=/.test(ablated);
  check(
    'P5 消融：撤掉 next.toolFilter 赋值 ⇒ P1 必须变红',
    !stillAssigns,
    !stillAssigns ? '撤掉后确实找不到赋值 ⇒ P1 判据有效' : '★ 撤掉后仍命中 ⇒ P1 是同义反复（铁律 28）',
  );
}

// ─── P6 作用域限定：不许把 capabilities 声明当限制（铁律 41）─────────────────
{
  // 在【带注释的全文】里，`capabilities.toolFilter: true` 是存在的（那是"支持"）
  const declInFull = /toolFilter\s*:\s*true/.test(src);
  // 在【代码】里，我们用来判定"真的限制了"的那个正则**不该**被 capabilities 命中
  const naive = /toolFilter\s*:/.test(codeOnly); // 会命中 capabilities
  const scoped = /next\.toolFilter\s*=/.test(codeOnly); // 只命中真实赋值
  check(
    'P6 作用域限定：不会把 capabilities.toolFilter:true 当成"真的限制了"',
    declInFull && naive && scoped,
    `全文含 capabilities 声明=${declInFull}；裸正则命中=${naive}（会假绿）；作用域正则命中=${scoped}（正确）`,
  );
}

console.log('\n' + '='.repeat(60));
const failed = results.filter((r) => !r.ok);
console.log(`结果：${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  · ${f.n} — ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
