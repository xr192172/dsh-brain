/**
 * test-seat-toolscope-continuable.mjs —— ★★★ 席位工具域在 **continuable 路径**上是否真受限？
 *
 * ## 这个门为什么必须存在
 *
 * `test-seat-toolscope.mjs` 证的是「`start()` 里有一行 `next.toolFilter = …`」（静态文本），
 * `test-seat-toolscope-e2e.mjs` 证的是「调上游 `applyChildComposition` 会去 `tools.restrict()`」（单元行为）。
 * ★ 两道门**全绿**，现役却仍然能被只读席位写仓库 —— 因为现役委派走的是**另一条路径**。
 *
 * ## 缺陷的完整机制（三条独立通道交叉证实）
 *
 * | 通道 | 读数 |
 * |---|---|
 * | 静态源码 | `SeatProvider.prepareContinuable()` 逐字 `return Promise.resolve({})` |
 * | 上游源码 | continuable 的 `composition` 取 `request.persona/toolFilter`（:824）；one-shot 取 `descriptor.*`（:1168） |
 * | 行为消融 | 同提示同席位：continuable 真跑了 `pwsh`；one-shot 回「我没有 pwsh 工具」 |
 *
 * ⇒ **席位只读的机制只在 one-shot 装上**；continuable 路径**静默漏掉**（不是拒绝，是漏）。
 *
 * ## 三态（铁律 33：不确定既不许当通过、也不许当失败）
 *   PASS  —— 判据为真
 *   FAIL  —— 判据为假
 *   SKIP  —— 读不到（会话/上游源码缺失）⇒ **不判红、显式记、可复探**
 *
 * 用法：node scripts/seats/test-seat-toolscope-continuable.mjs [--json]
 * 退出码：0 = 无 FAIL；1 = 有 FAIL
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '..', '..');

const results = [];
/** @param {string} n @param {boolean|'SKIP'} ok */
const chk = (n, ok, detail) => {
	const tri = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP';
	results.push({ n, ok: tri, detail });
	console.log(`${tri}  ${n} — ${detail}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// A. 我们自己的源码：prepareContinuable() 是否带上 composition
// ─────────────────────────────────────────────────────────────────────────────
const SRC = path.join(WT, 'packages/subagent-council/src/index.ts');
let srcRaw = null;
try { srcRaw = fs.readFileSync(SRC, 'utf8'); } catch { /* 下面按 SKIP 处理 */ }

/**
 * 取类方法体（按大括号配平）。
 * ★ 必须先做行尾归一化（`\r\n`→`\n`，铁律 41 ④）。
 * ★★ 缩进用 `[ \t]*` 而不是钉死 `\t` —— 消融自证喂的是"修复后的样本"，未必与源码同缩进。
 * ★★★ 必须容忍**返回类型标注**（`#enrich(request: any): any {`）——
 *    第一版漏了它，导致 `#enrich` 永远抓不到 ⇒ 委派追踪失效 ⇒ **假红**（铁律 41 现场）。
 * ★ 但**不许**放松到"任意位置"：仍须**行首** + "名字后紧跟 `(`"，
 *   否则会命中调用点 `this.#enrich(request)`（铁律 41 ①：作用域限定）。
 */
function methodBody(src, name) {
	const s = src.replace(/\r\n/g, '\n');
	// 允许：可选 async、方法名、参数表、可选返回类型标注、`{`
	const m = s.match(new RegExp(`^[ \\t]*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*(?::[^{;]*)?\\{`, 'm'));
	if (!m) return null;
	const i = s.indexOf('{', m.index + m[0].length - 1);
	let depth = 0;
	for (let j = i; j < s.length; j++) {
		const c = s[j];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) return s.slice(i, j + 1); }
	}
	return null;
}

/** ★ 剥注释 —— 否则注释里提到 toolFilter 会造成假绿（铁律 41；本模块已栽三次）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let bodyStart = null;
let bodyPrep = null;
let bodyEnrich = null;
if (srcRaw !== null) {
	bodyStart = methodBody(srcRaw, 'start');
	bodyPrep = methodBody(srcRaw, 'prepareContinuable');
	bodyEnrich = methodBody(srcRaw, '#enrich');
}

/**
 * ★★★ 关键：判据必须**跟着委派走**。
 *
 * 如果实现把富化抽成 `#enrich()` 再由两条路径共同调用，那"`start()` 体内有没有 toolFilter"
 * 就**不该再是判据** —— 否则重构一次就报一次假红（铁律 41；长期假红的门会被整体绕过，比没门更糟）。
 *
 * ⇒ 判据改成：「这条路径**最终**能不能把 toolFilter 送到上游」=
 *      **它自己体内有**  ∨  **它体内委派给了 `#enrich()`，而 `#enrich()` 里有**。
 * ★ 反过来说：若它既不自己写、也不委派给带 toolFilter 的方法 ⇒ 才是真红。
 */
function delivers(src, body, key) {
	if (body === null) return { verdict: 'SKIP', how: '读不到方法体' };
	const own = new RegExp(key).test(stripComments(body));
	if (own) return { verdict: true, how: '方法体内直接有' };
	// 顺着委派找一层：`this.#enrich(...)` / `this.enrich(...)` / `this.<anyMethod>(...)`
	const delegation = [...body.matchAll(/this\.(#[A-Za-z_]\w*|[A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
	for (const callee of delegation) {
		const cb = methodBody(src, callee);
		if (cb !== null && new RegExp(key).test(stripComments(cb))) {
			return { verdict: true, how: `体内委派给 \`${callee}()\`，后者带上了` };
		}
	}
	return {
		verdict: false,
		how: delegation.length
			? `体内没有，且委派给 ${delegation.map((d) => `\`${d}()\``).join('/')} 也都没有`
			: '体内没有，也没有任何委派',
	};
}

// A1 —— 正向：start() 路径必须送到（已知正确形状，= 本门的"标尺"）
if (srcRaw !== null) {
	const r = delivers(srcRaw, bodyStart, 'toolFilter');
	chk(
		'A1 SeatProvider.start() 能把 toolFilter 送到上游（one-shot 路径的正确形状）',
		r.verdict,
		bodyStart === null
			? '★ 读不到 start() 方法体 ⇒ 无法判定（不判红也不判绿）'
			: r.verdict
				? `${r.how} ⇒ **本门有阳性标尺**（判据看得见"正确形状"）`
				: `★ ${r.how} ⇒ 缺陷不是"路径漏了"，是"根本没接线"（另一种病，需重新归因）`,
	);
} else {
	chk('A1 SeatProvider.start() 能把 toolFilter 送到上游（one-shot 路径的正确形状）', 'SKIP', '★ 读不到源码');
}

// A2 —— ★★★ 核心判据：continuable 路径必须**同样**送到
if (srcRaw !== null) {
	const r = delivers(srcRaw, bodyPrep, 'toolFilter');
	chk(
		'A2 ★★★ prepareContinuable() 能把 toolFilter 送到上游（continuable = 现役委派路径）',
		r.verdict,
		bodyPrep === null
			? '★ 读不到 prepareContinuable() 方法体 ⇒ 无法判定'
			: r.verdict
				? `${r.how} ⇒ 只读席位在现役链路上**真的受限**`
				: `★ ${r.how} ⇒ **只读席位在现役链路上【不受限】**`,
	);
} else {
	chk('A2 ★★★ prepareContinuable() 能把 toolFilter 送到上游（continuable = 现役委派路径）', 'SKIP', '★ 读不到源码');
}

// A3 —— 同族：persona 也必须送到（同一个漏，同一个修法）
if (srcRaw !== null) {
	const r = delivers(srcRaw, bodyPrep, 'persona');
	chk(
		'A3 prepareContinuable() 能把 persona 送到上游（席位人格同样被漏）',
		r.verdict,
		bodyPrep === null ? 'SKIP' : r.verdict,
		bodyPrep === null
			? '★ 读不到 ⇒ 无法判定'
			: r.verdict
				? `${r.how}`
				: '★ 没有 ⇒ 席位在 continuable 路径上**连人格都没注入**（比工具域更根本：职责边界全靠 persona）',
	);
} else {
	chk('A3 prepareContinuable() 能把 persona 送到上游（席位人格同样被漏）', 'SKIP', '★ 读不到源码');
}

// ─────────────────────────────────────────────────────────────────────────────
// B. 上游：两条路径把 composition 取自哪
//     ★ 这条是"归因判据"—— 它把"漏在谁身上"钉死，避免下一次又归因到 persona。
// ─────────────────────────────────────────────────────────────────────────────
const UP = path.join(WT, 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js');
let upRaw = null;
try { upRaw = fs.readFileSync(UP, 'utf8').replace(/\r\n/g, '\n'); } catch { /* SKIP */ }

if (upRaw === null) {
	chk('B1 上游 dsh-subagent 源码可读', 'SKIP', '★ 读不到 ⇒ 无法核对 composition 来源');
} else {
	// B1 —— continuable 的 composition 取自 request.*（provider 交出来的）
	const contWindow = upRaw.slice(upRaw.indexOf('async startContinuable(spec)'), upRaw.indexOf('async startContinuable(spec)') + 3000);
	const contFromRequest = /composition:\s*\{\s*persona:\s*request\.persona,\s*toolFilter:\s*request\.toolFilter\s*\}/.test(contWindow);
	chk(
		'B1 上游：continuable 的 composition 取自 `request.*`（= provider.prepareContinuable 交出来的）',
		contFromRequest,
		contFromRequest
			? '★ 归因钉死：**"漏"发生在我们自己的 prepareContinuable()**，不在上游'
			: '★ 形状变了 ⇒ 复核（可能上游改版，判据要跟着改但**不许**为消红而改）',
	);

	// B2 —— ★ 正交对照：one-shot 取自 descriptor.*（另一个来源）
	//   若两条都取 request.*，那 A1 的"start 有"就解释不了 —— 这条正是区分两路径的**唯一**依据。
	const oneShotFromDescriptor = /composition:\s*\{\s*persona:\s*descriptor\.persona,\s*toolFilter:\s*descriptor\.toolFilter\s*\}/.test(upRaw);
	chk(
		'B2 ★ 正交对照：one-shot 的 composition 取自 `descriptor.*`（来源不同 ⇒ 两条路径确实分叉）',
		oneShotFromDescriptor,
		oneShotFromDescriptor
			? '两路径来源不同 ⇒ 只修 start() 对 continuable **无效**（本门存在的理由）'
			: '★ 两条来源相同了 ⇒ 缺陷模型需重新归因',
	);

	// B3 —— 上游：能力校验只在 one-shot 跑（**次要**，因为 composition 才是真因）
	const assertCount = [...upRaw.matchAll(/this\.assertCapabilities\(provider,\s*request\)/g)].length;
	const prepIdx = upRaw.indexOf('async prepareContinuable(name, request)');
	const assertInPrep = prepIdx >= 0 && /assertCapabilities/.test(upRaw.slice(prepIdx, prepIdx + 500));
	chk(
		'B3 上游：能力校验只在 start() 里跑（prepareContinuable 不查 capabilities）',
		assertCount === 1 && !assertInPrep,
		`assertCapabilities 调用点=${assertCount}；prepareContinuable 窗口内命中=${assertInPrep}` +
			'（⇒ 即使 request 里有 toolFilter，continuable 也永不因"provider 不支持"而被拒）',
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. 消融自证（铁律 21/28）：判据必须"有可红的输入、也有可绿的输入"
// ─────────────────────────────────────────────────────────────────────────────
{
	// C1 —— 真判据：塞一段**漏掉**的 prepareContinuable ⇒ delivers() 必须判假
	const BROKEN = `
		prepareContinuable() {
			return Promise.resolve({});
		}
	`;
	const rBroken = delivers(BROKEN, methodBody(BROKEN, 'prepareContinuable'), 'toolFilter');
	chk(
		'C1 ★ 消融自证：判据在【漏掉的形状】上必须判红',
		rBroken.verdict === false,
		rBroken.verdict === false
			? `对空实现判红（${rBroken.how}）⇒ 判据有效`
			: '★ 对空实现也判绿 ⇒ 判据是死的（同义反复，铁律 28）',
	);

	// C2 —— 真判据：塞一段**修好**的 ⇒ 必须判绿（且不能靠"自己体内写"作弊）
	const FIXED_DELEGATING = `
		prepareContinuable() {
			return Promise.resolve(this.#enrich(request));
		}
		#enrich(request) {
			const next = { ...request };
			next.persona = this.#persona;
			if (this.#toolFilter !== undefined) next.toolFilter = { allow: [...this.#toolFilter.allow] };
			return next;
		}
	`;
	const rFixed = delivers(FIXED_DELEGATING, methodBody(FIXED_DELEGATING, 'prepareContinuable'), 'toolFilter');
	chk(
		'C2 ★ 消融自证：判据在【委派给 #enrich 的修复形状】上必须判绿',
		rFixed.verdict === true,
		rFixed.verdict === true
			? `${rFixed.how} ⇒ **跟着委派走**是对的，重构不会造假红（铁律 41）`
			: `★ ${rFixed.how} ⇒ 判据不认委派 ⇒ 一次重构就报假红（比没门更糟）`,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(64));
const nPass = results.filter((r) => r.ok === 'PASS').length;
const nFail = results.filter((r) => r.ok === 'FAIL').length;
const nSkip = results.filter((r) => r.ok === 'SKIP').length;
console.log(`结果：${nPass} PASS / ${nFail} FAIL / ${nSkip} SKIP（共 ${results.length}）`);
if (nSkip) console.log('★ SKIP = 读不到 ⇒ **既不算通过也不算失败**（铁律 14/33），需复探');
if (nFail) {
	console.log('失败项：');
	for (const f of results.filter((r) => r.ok === 'FAIL')) console.log(`  · ${f.n} — ${f.detail}`);
}
if (process.argv.includes('--json')) {
	fs.writeFileSync(path.join(WT, 'out/_seat-toolscope-continuable.json'), JSON.stringify(results, null, 2), 'utf8');
	console.log('（已写 out/_seat-toolscope-continuable.json）');
}
process.exit(nFail ? 1 : 0);
