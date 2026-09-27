/**
 * 端到端证据：`toolFilter` 真的落成子代理作用域的 restrict 了吗？
 *
 * ★ 上一版判据（test-seat-toolscope.mjs）只证到"源码里有那行赋值"——
 *   那是**文本判据**，离"运行时真的挡住了"还隔着一层。
 *   本脚本直接调 **上游真实函数** `applyChildComposition`，喂一个假 ctx，
 *   看它有没有调 `tools.restrict()`、参数是什么。
 *
 * 这样才叫"证明机制在工作"（铁律 11：去数判据为真的次数，不读意图）。
 *
 * 用法：node scripts/seats/test-seat-toolscope-e2e.mjs
 * 退出码：0 = 机制确实被触发；1 = 没触发（或抛错）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChildComposition } from '@deepseek-ai/dsh-subagent';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(HERE, '..', '..');
// ★ 用【绝对路径】导入我们自己的产物 —— 相对路径会随脚本搬家而断（本文件刚从 out/ 挪进来）。
const { toolFilterForSeat, toolScopeForSeat } = await import(
	`file://${path.join(WT, 'packages/subagent-council/lib/index.js').replace(/\\/g, '/')}`
);

const log = [];
const say = (s) => { log.push(s); console.log(s); };

let restrictCalls = [];
const makeChildCtx = () => ({
	// 上游要求的能力（可选消费方，缺了也不炸）：
	get: (k) => (k === 'agentPresets' ? { composeFrom: () => {} } : undefined),
	systemPrompt: { context: () => {}, section: () => {} },
	tools: {
		restrict: (filter) => {
			restrictCalls.push(filter);
			return () => {};
		},
	},
});
const parent = { ctx: { get: () => undefined } };

/** 复刻 SeatProvider.start() 里那一步（只取 toolFilter 相关）。 */
function compositionFor(seat) {
	const f = toolFilterForSeat(seat);
	return f === undefined ? {} : { toolFilter: f };
}

say('=== 逐席位调上游 applyChildComposition，看它有没有真去 restrict ===');
const rows = [];
for (const seat of ['architect', 'dev', 'review']) {
	restrictCalls = [];
	const childCtx = makeChildCtx();
	try {
		applyChildComposition(childCtx, parent, compositionFor(seat));
	} catch (e) {
		rows.push({ seat, scope: toolScopeForSeat(seat), calls: -1, allow: `★ 抛错: ${e.message}` });
		continue;
	}
	const n = restrictCalls.length;
	const allow = n ? JSON.stringify(restrictCalls[0].allow ?? restrictCalls[0].deny ?? null) : '(不设限)';
	rows.push({ seat, scope: toolScopeForSeat(seat), calls: n, allow });
}
for (const r of rows) {
	say(`  ${r.seat.padEnd(10)} 档位=${String(r.scope).padEnd(9)} restrict 调用=${r.calls}  实参=${r.allow}`);
}

const arch = rows.find((r) => r.seat === 'architect');
const dev = rows.find((r) => r.seat === 'dev');
const rev = rows.find((r) => r.seat === 'review');

// ★★ 第一版这两条判据写错了（假红）——`/write/.test('["read",...,"todo_write"]')` 会命中
//    **`todo_write` 里的子串 `write`** ⇒ 把"没有 write 工具"误判成"有"。
//    ⇒ 这是铁律 41 的同族：**子串匹配必须做边界限定**。改成【精确名字比对】。
const archAllow = restrictCallsOf('architect');
const hasExact = (list, name) => list.includes(name);

function restrictCallsOf(seat) {
	restrictCalls = [];
	try {
		applyChildComposition(makeChildCtx(), parent, compositionFor(seat));
	} catch {
		return null;
	}
	const f = restrictCalls[0];
	return f ? (f.allow ?? f.deny ?? []) : [];
}

const archList = restrictCallsOf('architect') ?? [];
const WRITE_NAMES = ['write', 'edit', 'pwsh', 'bash'];
const writeIntruders = WRITE_NAMES.filter((n) => hasExact(archList, n));

const ok1 = arch.calls === 1 && hasExact(archList, 'read') && writeIntruders.length === 0;
const ok2 = rev.calls === 1;
const ok3 = dev.calls === 0; // ★ 阳性对照：dev 必须【不】被 restrict
const ok4 = hasExact(archList, 'ask_user_question');

say('');
say('=== 判据 ===');
say(
	`${ok1 ? 'ok  ' : 'FAIL'} E1 architect 席真的调了 restrict，且 allow 里有 read、没写工具` +
		`（精确比对；混入的写工具=${JSON.stringify(writeIntruders)}）`,
);
say(`${ok2 ? 'ok  ' : 'FAIL'} E2 review 席真的调了 restrict`);
say(`${ok3 ? 'ok  ' : 'FAIL'} E3 ★ 阳性对照：dev 席【没有】被 restrict（能动手）`);
say(`${ok4 ? 'ok  ' : 'FAIL'} E4 allow 里保留了 ask_user_question（席位遇歧义要能问人）`);

const failed = [ok1, ok2, ok3, ok4].filter((x) => !x).length;
say('');
say(`结果：${4 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
