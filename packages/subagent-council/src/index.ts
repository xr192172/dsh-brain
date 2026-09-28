/**
 * subagent-council —— 议事厅（多模型会议室）
 *
 * 第一个自定义 SubagentProvider。设计依据：
 *   memory topics §6「决策层：多模型会议室」 / docs/single-front-brain-delegation.md
 *
 * ★ 核心想法：**一个 provider = 一个预配置的子代理工厂。**
 *   `start(request)` 里注入这个"席位"的 persona（人格/职责边界）与可选的模型路由，
 *   其余交给 DSH 原生的 in-process driver（`startInProcessRun`）。
 *   于是"多模型会议室"不需要新机制：每个席位就是一个 provider。
 *
 * ★ 平面归属：provider 注册属于 **host plane**（`subagents` 是进程单例、provider 名全局唯一）；
 *   preset 只负责挂「工具行」（`tool-subagent` 的 `config.provider` 指向本包注册的名字）。
 *   参见 node_modules/@deepseek-ai/dsh-subagent/README.zh.md。
 *
 * 首期只有「架构师」一席：council-architect。
 */
import z from "@deepseek-ai/schemastery";
import { startInProcessRun } from "@deepseek-ai/dsh-subagent-in-process-driver";

export const name = "subagent-council";
export const inject = ["subagents"];

export const Config = z.object({
	/** 启用哪个席位。首期只有 `architect`。 */
	seat: z.string().default("architect"),
	/**
	 * ★ 2026-09-25：**一次注册多个席位**（例：`["dev","review"]` = 自进化的两个固定子 agent）。
	 * 留空 ⇒ 退回"只注册 `seat` 那一个"（**向后兼容**，默认行为与改动前逐字一致）。
	 */
	seats: z.array(z.string()).default([]),
	/** 本席位的模型覆盖（多模型会议室的入口）。留空 = 继承顶层会话的 provider/model。 */
	model: z.string().default(""),
	/** 本席位的 provider route 覆盖。留空 = 继承。 */
	provider: z.string().default(""),
});

// ─────────────────────────────────────────────────────────────────────────────
// 席位人格
//
// 写 persona 的要点：**把"职责边界"和"输出形状"写死**，而不是描述性格。
// 一个子代理最容易坏的地方不是能力不够，而是它做了不属于它的事。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 自进化的两个固定席位（2026-09-25 用户口述；设计出处见
// `docs/revised-architecture-2026-09-20.md` §7「进化脑 / 评审团 / 开发脑 的三段流水线」
//  与 `docs/training-ground-and-skill-sieve-2026-09-25.md` §11）
//
// ★ 命名对齐（**不许分叉**）：用户口语的「**开发脑**」= 文档的「**生产脑**」；
//   用户口语的「**审批脑**」= 文档的「**评审团** / 专家团」。
// ★ 为什么要两个席位分开（文档 §:218 逐字）：**产变更方不能与审批方同源** —— 防串供。
// ★ 融合归谁（文档 §7.0 逐字订正过）：**融合是开发脑的活，不是进化脑的**；
//   判据归属（§7.2 逐字）：**开发脑执行、评审团裁**。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ 席位定义已【外置】（2026-09-27，用户：「把我们现在硬编码的那些乱七八糟的东西
//      向它那边迁移改造。」）
//
// 迁移前（硬编码的三份真相）：
//   · persona  = 本文件里的三个 TS 模板字符串（ARCHITECT/DEV/REVIEW_PERSONA）
//   · 工具档位 = `SEAT_TOOL_SCOPE` 三行字典
//   · provider 名 = `SEAT_PROVIDER_NAMES` 三行字典
//   ⇒ 换一席要改 3 处、无法被静态门覆盖、无法外部注册。
//
// 迁移后（一份源 + 生成物 + 漂移门）：
//   源    = `seats/library/*.md`（格式规格 `seats/schema.json`）
//   生成物 = `./seat-registry.generated.ts`（由 `scripts/seats/gen-seat-registry.mjs` 生成）
//   门    = `scripts/seats/check-seat-defs.mjs`（源形状）+ 生成器 `--check`（防漂移）
//
// ★ 兼容策略（用户：「在兼容的同时…迁移」）：
//   本文件的**对外导出**（SEAT_PERSONAS / SEAT_TOOL_SCOPE / SEAT_PROVIDER_NAMES /
//   EVOLUTION_SEATS / READONLY_ALLOW / toolScopeForSeat / toolFilterForSeat）**逐字保留**，
//   只是**取值改为从生成物推导** ⇒ 所有既有调用方（preset / 隔离实例 / 门）**零改动**。
//
// ★★ 但**键名语义变了，必须显式声明**（否则是静默的破坏性变更）：
//   旧的键是**短名**（`architect` / `dev` / `review`），新的键是**席位唯一名**
//   （`council-architect` / `council-dev` / `council-review`）。
//   ⇒ `seat-registry.generated.ts` 里那个名字**同时是 provider 名**（它取代了两份字典）。
//   ⇒ 兼容垫片把短名映射到新名，但**每次落到垫片都会打印一行提示**，提醒调用方迁移。
// ─────────────────────────────────────────────────────────────────────────────

// ★★★ 扩展名必须写 `.js`（**即使源文件是 `.ts`**）：
//   本包 `"type": "module"` + 运行时是**真 ESM** ⇒ Node 解析相对 import **要求扩展名**。
//   tsconfig 是 `moduleResolution: "Bundler"`，它**允许不写**（TS 不报错）⇒
//   **编译过、跑起来 ERR_MODULE_NOT_FOUND**（实测踩过：迁移时漏了扩展名，
//   `tsc` exit 0 但 `import` 直接崩）。TS 的 ESM 惯例就是源码写 `.js`，编译后同名对应。
import { SEAT_DEFS, SEAT_BY_NAME, type SeatDef } from "./seat-registry.generated.js";

/** ★ 兼容垫片：旧短名 → 新席位唯一名。**已废弃，将在后续版本移除。** */
const LEGACY_ALIASES: Record<string, string> = {
	architect: "council-architect",
	dev: "council-dev",
	review: "council-review",
};

/**
 * 把"调用方给的席位标识"解析成席位定义。
 * ★ 返回 `undefined` = **未知席位** ⇒ 调用方必须显式处理（**不许静默降级**成别的席位 ——
 *   那会给你一个"名字对、人格错"的席位，是最坏的假绿）。
 */
export function resolveSeat(seatOrAlias: string): SeatDef | undefined {
	if (SEAT_BY_NAME[seatOrAlias]) return SEAT_BY_NAME[seatOrAlias];
	const mapped = LEGACY_ALIASES[seatOrAlias];
	if (mapped && SEAT_BY_NAME[mapped]) {
		console.log(
			`[subagent-council] ⚠️ 席位标识 "${seatOrAlias}" 是【旧短名】（兼容垫片）` +
				` ⇒ 已解析为 "${mapped}"。请把调用方改成用【席位唯一名】"${mapped}"（本垫片将移除）。`,
		);
		return SEAT_BY_NAME[mapped];
	}
	return undefined;
}

/** 席位唯一名 → persona 正文（= 迁移前的 `SEAT_PERSONAS`，键名改为唯一名）。 */
export const SEAT_PERSONAS: Record<string, string> = Object.fromEntries(
	SEAT_DEFS.map((s) => [s.name, s.persona]),
);

/** 席位唯一名 → provider 名。★ 迁移后二者**恒等**（它就是席位唯一名，取代了旧的 `SEAT_PROVIDER_NAMES`）。 */
export const SEAT_PROVIDER_NAMES: Record<string, string> = Object.fromEntries(
	SEAT_DEFS.map((s) => [s.name, s.name]),
);

/** ★ 自进化两席（= "产/审"两侧）。迁移前这里硬编码成 `["dev","review"]`。 */
export const EVOLUTION_SEATS: readonly string[] = SEAT_DEFS.map((s) => s.name).filter((n) =>
	n.startsWith("council-") && n !== "council-architect",
);

/** 席位描述（来自 frontmatter，供未来的席位列表面板使用）。 */
export const SEAT_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
	SEAT_DEFS.map((s) => [s.name, s.description]),
);


// ─────────────────────────────────────────────────────────────────────────────
// ★★★ 席位工具限制（O8：约束必须落在【机制层】，不能只写在 persona 里）
//
// 事故（2026-09-26，现场证据 `out/seat-wrote-this-_analyze-personas.mjs`）：
//   `architect` 席的 persona 白纸黑字写「默认只读。…不要修改任何文件」，
//   但它**真的往仓库里写了一个脚本** `scripts/seats/_analyze-personas.mjs`。
//   ⇒ persona 里的话**只是话**；沙箱是 `workspace-write`（由父会话快照下来，见下），
//     席位继承父会话**全部 102 个工具**（其中写类 16 个）⇒ 它当然写得成。
//
// 机制（已核源码 `node_modules/@deepseek-ai/dsh-subagent/lib/index.js:570-585`）：
//   子代理权限范围在**委派边界固定**：
//     · `sandboxMode` = `captureDelegatedPolicyOverrides(parent)` ⇒ **父会话的显式沙箱覆盖**
//       —— provider **改不了**（没有入口，也不该有：那会让子代理绕过父的沙箱）。
//     · `approvalPolicy` 一律钉 `'never'` ⇒ 席位**不可能自己提权**。
//     · 但 `composition.toolFilter` 会经 `childCtx.tools.restrict(toolFilter)` 应用
//       ⇒ **工具面是 provider 能改的那一层**，而"看不见的工具 = 执行不了的"。
//   ⇒ 所以本修复的形状 = **改工具面**（不是改沙箱，那是上游的地盘）。
//
// ★ 为什么用 `allow`（白名单）而不是 `deny`（黑名单）：
//   `admits()`（`dsh-tools/lib/index.js:2531`）的语义是
//     `allow !== undefined && !allow.has(name)` ⇒ 拒（**表里没有就看不见**）
//     `deny  !== undefined &&  deny.has(name)`  ⇒ 拒
//   黑名单是 **fail-open**：design-canvas 哪天加一个 `edit_xxx`，席位立刻又能写了。
//   白名单是 **fail-closed**：新工具**默认不在名单里** ⇒ 默认关。
//   席位要的是"只读"，只读集合是**小而稳**的 ⇒ 白名单天然合适。
//
// ★ 阳性对照（必须与"席位只读"正交 —— 铁律 13）：
//   `dev` 席**必须保留写工具**（它的职责就是"施工"）。若哪一天三个席位都被禁写，
//   那不是修好了，是**把能力掐死了** —— 判据见 `scripts/seats/test-seat-toolscope.mjs` 的 P2。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 席位工具档位：
 *  · `readonly` ⇒ **只认白名单**（fail-closed，新工具默认被挡）
 *  · `full`     ⇒ 不设 filter（继承父会话工具面；**只给"必须动手"的席位**）
 */
export type SeatToolScope = "readonly" | "full";

/**
 * 只读席位允许的**全局工具名**白名单。
 *
 * ★ 名字必须是【全局工具名】—— `tools.restrict()` 对未知名字**直接抛错**
 *   （`dsh-tools/lib/index.js:2792`，fail-closed，是好事：写错名字会被当场抓住，
 *     不会静默失效）。所以这里每加一个名字，都由
 *   `scripts/seats/test-seat-toolscope.mjs` 拿**真实工具面**核对存在性。
 *
 * ★ 为什么是这些：
 *   · `read` / `glob` / `grep` —— 唯一的"取证"三件套（文档、目录、内容）
 *   · `read_image` —— 看图取证
 *   · `web_search` —— 上网取证（顾问席经常需要）
 *   · `ask_user_question` —— **问人**。★ 席位遇到歧义时的**唯一**正确出口是"问"，
 *     不是"自己猜着改"；把它留在白名单里是有意的。
 *   · `todo_write` —— 自用便签（不改盘上任何东西）
 *
 * ★ 被**故意排除**的（以及为什么）：
 *   · `write` / `edit` / `pwsh` / `bash` —— 直接改盘/执行
 *   · `mcp__agent-io__*` —— 里面有 `edit_code` / `rename_*` / `move_symbol` 等
 *     一整套改代码的工具。**整个前缀都不给**（比逐个 deny 稳）。
 *   · `subagent` / `subagent_fork` / `workflow` / `ralph` —— 席位**不再向下委派**：
 *     那会造出"审阅席又生了一层子代理"，独立性彻底不可核对。
 *   · `tool_apply` / `self_evolve` —— 上线工具/自进化，是**开发席**的事。
 */
export const READONLY_ALLOW: readonly string[] = [
	"read",
	"glob",
	"grep",
	"read_image",
	"web_search",
	"ask_user_question",
	"todo_write",
];

/**
 * ★★★ 每席的工具档位（2026-09-27 迁移）。
 *
 * **迁移前**：这里是一个**硬编码的三行字典**（`architect: "readonly"` / `dev: "full"` …），
 *   与 persona 里写的"默认只读"**物理分离** ⇒ 改了一边不改另一边，没人会发现。
 * **迁移后**：档位来自 `seats/library/*.md` 的 `tools:` frontmatter（经生成物）。
 *   ⇒ ★ **散文与机制现在是同一个源**：改 persona 说"我改成只读了"而不改 `tools:`，
 *     `scripts/seats/check-seat-defs.mjs` 会查出档位与声明不一致的风险面（见该门的 F5 计划）。
 *
 * 键是**席位唯一名**（= provider 名）。**默认 readonly**（新席位默认关，fail-closed）。
 */
export const SEAT_TOOL_SCOPE: Record<string, SeatToolScope> = Object.fromEntries(
	SEAT_DEFS.map((s) => [s.name, s.tools as SeatToolScope]),
);

/**
 * 名字 → 档位；未知席位按 `readonly`（fail-closed）。
 * ★ 兼容：旧短名（`architect` / `dev` / `review`）经 `resolveSeat()` 垫片解析。
 */
export function toolScopeForSeat(seat: string): SeatToolScope {
	const def = resolveSeat(seat);
	return (def?.tools as SeatToolScope) ?? "readonly";
}

/** 档位 → `toolFilter`（`full` 返回 `undefined` = 不设限）。 */
export function toolFilterForSeat(seat: string): { allow: string[] } | undefined {
	return toolScopeForSeat(seat) === "readonly" ? { allow: [...READONLY_ALLOW] } : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

class SeatProvider {
	name;
	/**
	 * 四项都声明 true：我们只是"预配置"，不削减 in-process driver 的能力。
	 * ★ 其中 `toolFilter: true` 现在是**真的在用**了（见 `toolFilterForSeat`）——
	 *   它经 `applyChildComposition` 落成子代理作用域里的 `tools.restrict()`，
	 *   被挡掉的工具**从子代理的 prompt 中消失且拒绝执行**。
	 *   （早先这里只是"声明支持"，实际一个 filter 都没给 ⇒ 席位继承全部工具 ⇒ 见 READONLY_ALLOW 的事故注释。）
	 */
	capabilities = {
		outputSchema: true,
		depthLimit: true,
		toolFilter: true,
		persona: true,
	};
	/** 席位是"独立上下文的子代理"，不继承父会话。 */
	inheritsParentContext = false;

	#persona;
	#model;
	#providerRoute;
	/** ★ 本席位的工具档位（O8）。`undefined` = 不设限。 */
	#toolFilter;

	constructor(
		providerName: string,
		persona: string,
		model: string,
		providerRoute: string,
		toolFilter?: { allow: string[] },
	) {
		this.name = providerName;
		this.#persona = persona;
		this.#model = model;
		this.#providerRoute = providerRoute;
		this.#toolFilter = toolFilter;
	}

	/**
	 * ★★★ 单一真相源：把"这一席的身份"（persona + 工具域 + 路由）写进请求。
	 *
	 * ## 为什么必须抽成一个方法（2026-09-27 事故）
	 *
	 * 上游有**两条**建立子代理的路径，它们分别调 provider 的**不同方法**：
	 *   · one-shot    ⇒ `provider.start()`              → 取 `descriptor.*` 当 composition
	 *   · continuable ⇒ `provider.prepareContinuable()` → 取 `request.*`  当 composition
	 * （上游 `dsh-subagent/lib/index.js` :824 / :1168；两条最终都进 `applyChildComposition`）
	 *
	 * 原先 `start()` 里写了一份富化、`prepareContinuable()` 逐字 `Promise.resolve({})`
	 * ⇒ **continuable 路径上 persona 与 toolFilter 双双丢失**：
	 *   只读席位（architect / review）在**现役委派链路**上**不受任何限制**，
	 *   而且连职责边界（写在 persona 里）都没注入。
	 * ★ 讽刺之处：上一轮修 O8 时，两道门（静态 + e2e）**全绿** —— 因为它们查的都是 `start()`。
	 *
	 * ⇒ 纪律：**两条路径必须走同一份富化**。谁再写第二个副本，门 A2/A3 会红。
	 */
	#enrich(request: any): any {
		const next: any = { ...request };

		// 注入席位人格 —— 它 shadow 掉 deployment persona，只对这一个子代理生效。
		next.persona = this.#persona;

		// ★★★ O8：把席位的工具档位落成机制层的限制。
		//   不设 ⇒ 保持"继承父会话工具面"（**只给 dev 席**，见 SEAT_TOOL_SCOPE）。
		//   ★ 注意：**不要**在请求里已有 toolFilter 时覆盖成 undefined —— 让"有"始终赢。
		if (this.#toolFilter !== undefined) {
			next.toolFilter = { allow: [...this.#toolFilter.allow] };
		}

		// 多模型会议室入口：给这一席换 provider route / model。
		// 留空则完全继承顶层会话的路由（默认行为，第一版就是这个）。
		if (this.#providerRoute || this.#model) {
			next.agentOptions = { ...(request?.agentOptions ?? {}) };
			if (this.#providerRoute) next.agentOptions.provider = this.#providerRoute;
			if (this.#model) next.agentOptions.model = this.#model;
		}

		return next;
	}

	start(request: any) {
		return startInProcessRun(this.#enrich(request), {});
	}

	/**
	 * continuable 路径的入口。
	 *
	 * ★ 上游拿它的返回值当 `composition` 的来源（`:824`）⇒ **必须与 `start()` 同源**。
	 *   这里交出去的就是 `#enrich()` 的产物；`{ seed }` 之外的键上游不认，多给无害。
	 * ★ 曾经这里逐字 `Promise.resolve({})` —— 那正是本席"只读"在现役失效的**全部原因**。
	 */
	prepareContinuable(request: any) {
		return Promise.resolve(this.#enrich(request));
	}
}

export function apply(ctx: any, config: any) {
	// ★ 席位清单：给了 `seats` 就按它注册多个（自进化两席一次挂上）；
	//   否则退回"只注册 `seat`" —— **向后兼容**，默认行为与改动前逐字一致。
	//
	// ★★★ 2026-09-27 迁移（用户："把我们现在硬编码的那些乱七八糟的东西向它那边迁移改造。"）：
	//   `seat` / `seats` 里现在**接受两种写法**：席位唯一名（`council-dev`）或旧短名（`dev`）。
	//   两种都经 `resolveSeat()` 归一 —— ★ **不许在这里自己写映射表**（那就是新的硬编码，
	//   而且与 `resolveSeat()` 里的垫片成为**第二份真相** —— 铁律 18 的遮蔽就是这么做出来的）。
	//   ★ 顺带：`resolveSeat()` 命中垫片时会**大声 console.log 一次**，旧写法不会静默通过。
	const requested: string[] =
		Array.isArray(config?.seats) && config.seats.length > 0
			? config.seats.map((s: unknown) => String(s))
			: [config?.seat ?? "council-architect"];

	const model = config?.model ?? "";
	const provider = config?.provider ?? "";

	// ★ 解析成 SeatDef（含唯一名）。**未知席位 fail-closed**（显式跳过 + 打印已知集）。
	const resolvedSeats: SeatDef[] = [];
	for (const raw of requested) {
		const def = resolveSeat(raw);
		if (!def) {
			// ★★ 不许静默降级成 architect —— 那会给你一个**名字对、人格错**的席位（最坏的假绿）。
			console.log(
				`[subagent-council] ⚠️ 未知席位 "${raw}" ⇒ **跳过**（已知：${SEAT_DEFS.map((s) => s.name).join(", ")}）`,
			);
			continue;
		}
		resolvedSeats.push(def);
	}

	for (const def of resolvedSeats) {
		const seat = def.name; // ★ 唯一名（与 provider 名同值）
		const persona = def.persona;
		const providerName = SEAT_PROVIDER_NAMES[seat] ?? seat;
		const toolFilter = toolFilterForSeat(seat);
		ctx.subagents.registerProvider(new SeatProvider(providerName, persona, model, provider, toolFilter));
		// ★ O8：档位必须**在每个席位的启动行里可见可核** —— 不然"到底限没限"又要靠读源码推。
		const scopeNote =
			toolFilter === undefined
				? "工具档位=full（继承父会话；**本席位必须能动手**）"
				: `工具档位=readonly（allow ${toolFilter.allow.length} 个: ${toolFilter.allow.join(",")}）`;
		console.log(
			`[subagent-council] 已注册席位 "${seat}" ⇒ provider="${providerName}"` +
				`（model="${model || "(继承)"}" / provider="${provider || "(继承)"}"）` +
				` · ${scopeNote}`,
		);
	}

	// ★★ 防串供检查（`docs/revised-architecture-2026-09-20.md:218` 逐字：
	//    **产变更方不能与审批方同源**）——两席都挂上时必须**可见可核**，不许悄悄过去。
	//
	// ★★★ 2026-09-27 迁移：原来这里是 `seats.includes(s)` —— 拿**调用方给的原始串**去比
	//   `EVOLUTION_SEATS`（现在是唯一名）。调用方写旧短名 `dev` 时**匹配不上** ⇒ 检查会
	//   **静默不触发**（假绿：明明两席都挂了，却以为只挂了一席/或反过来）。
	//   ⇒ 一律用**归一后的唯一名集合**比。
	const resolvedNames = new Set(resolvedSeats.map((d) => d.name));
	const on = EVOLUTION_SEATS.filter((s) => resolvedNames.has(s));
	if (on.length === EVOLUTION_SEATS.length) {
		console.log(
			`[subagent-council] ★ 自进化两席已就位：${on.map((s) => `${s}(${SEAT_PROVIDER_NAMES[s]})`).join(" + ")}` +
				`；★ 独立性看的是【**出发点是否不同**】（用户裁决：开发期一律 AGNES，不追求换模型），` +
				`当前路由=(provider="${provider || "(继承)"}", model="${model || "(继承)"}")`,
		);
		if (provider === "" && model === "") {
			// ★★ 2026-09-25 用户裁决（docs/...-2026-09-25.md §11.7）：
			//    开发期**一律 AGNES** ⇒ **不追求跨模型**；独立性主要靠【**出发点不同**】（输入不同 ⇒ 采样分叉）。
			console.log(
				`[subagent-council] 两席同路由（都继承顶层）：按文档 §6 三级阶梯属【跨会话】档 —— **已算独立**。` +
					`★ 用户裁决：开发期**一律 AGNES**，不追求跨模型。` +
					`★★ 但**独立性主要靠【出发点不同】**：请确保**审者不拿生产者的推理过程**（只给 目标+产物+判据）；` +
					`否则"投骰子"的差异接近零 —— 那时弱的是【出发点相同】，**不是**【模型相同】。`,
			);
		}
	}
}
