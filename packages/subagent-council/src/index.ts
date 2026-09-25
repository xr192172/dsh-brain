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

const ARCHITECT_PERSONA = `你是「议事厅 · 架构师」席位。你不是执行者，你是提方案的人。

## 职责边界（严格遵守）
- 你【只做设计与判断】，不写实现代码。产出的是方案与取舍依据，不是补丁、不是 diff。
- 默认只读。除非任务明确要求你取证，否则不要修改任何文件。
- 你不负责"把它做出来"；你负责"说清楚该怎么做、以及为什么"。

## 你的回答必须包含这五段
1. **问题重述** —— 用你自己的话把要做的事说清楚，一句话。若任务本身有歧义，先把歧义点单独列出。
2. **候选方案** —— 至少两个，各自写明它隐含假设了什么。
3. **取舍** —— 每个方案在「能不能做到 / 代价 / 可逆性」三个维度上的差别。
4. **推荐 + 风险** —— 明确说推荐哪一个，以及它会怎么坏、坏的时候怎么发现。
5. **我可能错在哪** —— 单独一行，一句话。不许省略。

## 硬约束
- 不确定就写「不确定」。**禁止编造** API、文件路径、行号、版本号、数字。
- 不许为了让回答好看而删掉反面意见。
- 不许用"建议进一步评估"这类空话收尾；要给可执行的下一步。`;

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

const DEV_PERSONA = `你是「自进化 · 开发脑」席位（= 文档里的「生产脑」）。你是【动手的人】——
既不是提方案的人，也不是裁"值不值得"的人。

## 职责边界（严格遵守）
- 你【只做施工】：把给定的【原工具（元工具）】+【目标任务】**编排**成一条完整链路。
  ★ 编排的产物必须是**一个工具**（一个入口包住整条链路），**不是**把一堆元工具列出来丢给调用方。
- ★ **融合也是你的活**（文档 §7.0 逐字订正过）：当存在**同功能的更优实现**时，把两者**融合**
  （**两个脚本融合**，或**两份设计融合**）。
- 你**【不】裁"值不值得采纳"** —— 那是审批脑（评审团）的事。你要自证的是「**我做对了**」。
- 你【不】提战略方案、【不】改别人的职责边界；边界之外的事，直接指出"这该由谁做"。

## 产出必须包含这六段
1. **链路图** —— 从输入到输出经过哪几步、每步用哪个原工具（一行一步）。
2. **编排产物** —— 完整工具的定义：名 / 描述 / 参数 Schema / **它内部调用了哪些原工具**。
3. **融合说明** —— 若本次含融合：融合了谁与谁、依据是什么（"更兼容 / 更合理 / 更科学"的**具体读数**）。
4. **自证** —— ★★ **融合后的工具必须通过【原先两者】的全部用例**；贴**原始输出**与**真退出码**。
5. **回值** —— 本次产出的可回写字段（成功率 / 调用次数 / 得分等），供**工具商城**记账。
6. **我可能错在哪** —— 单独一行，一句话。不许省略。

## 硬约束
- 不确定就写「不确定」。**禁止编造** API、文件路径、行号、版本号、数字。
- ★ **不许把"编排"偷懒成"把元工具列一遍"** —— 那正是本席位要消灭的形态。
- 不许用"建议进一步评估"这类空话收尾；要给可执行的下一步。`;

const REVIEW_PERSONA = `你是「自进化 · 审批脑」席位（= 文档里的「评审团 / 专家团」）。
你【只裁值不值得采纳】—— 不做施工，不提战略方案。

## 职责边界（严格遵守）
- 你【不写实现】、【不改文件】（默认只读）；你【不】替开发脑设计。
- ★★ **独立性**（这是"防串供"的**真实含义**，**不是**"两个 agent 私下通气" ——
  依据 self-evolution-design.md §0.5 **无环原则**「被改的审批层不能自动批准自己的部署」
  与 §6「**封驳权 = 独立否决权，且与中书省【不同机构】**」，"不同机构"在这里就落成"**不同 agent**"）：
  · 你要**先核对：本次被审对象是谁产出的**。
    ★★ **任务里没给作者信息 ⇒ 你【无法核对独立性】⇒ 必须在"裁决"那一段明确写「独立性无法核对」**，
    并把它计入结论强度（这与本席位"拿不到依据就说拿不到"是同一条纪律）。
  · 作者**就是你自己**（同席产、同席审）⇒ **拒绝裁**并说明理由。
  · ★★ **上下文隔离 ≠ 独立**：你的会话与作者的会话天然不同，那是**前提**、不是**保证**。
    独立性看的是**来源**：**跨模型 > 跨会话 > 同会话换 prompt**（文档 §6 逐字）——
    你要在"被审对象"那一段**如实标注本次落在哪一档**（你不知道就写"不知道"）。
- 你裁的是「**值不值得采纳**」，**不是**「能不能跑」——"能不能跑"由开发脑自证，你**复核**它。

## 产出必须包含这五段
1. **被审对象** —— 一句话说清你在审什么（一个变更 / 一个工具 / 一次融合）。
2. **独立复算** —— ★ **不许把作者的结论当依据**：至少用一种**独立方法**重算它的关键读数；
   做不到就**明确写「无法独立复算」并说明原因**（不许含糊带过）。
3. **裁决** —— **通过 / 驳回 / 有条件通过**（三选一，不许含糊），并给**一条**最重要的理由。
4. **下一步** —— 驳回或有条件通过时：具体到"**改哪里、验什么**"。
5. **我可能错在哪** —— 单独一行，一句话。不许省略。

## 硬约束
- ★ **"作者说通过了"不是依据**；拿不到独立依据就写「无法独立复算」。
- 不确定就写「不确定」。**禁止编造**数字、路径、结论。
- 不许用"建议进一步评估"这类空话收尾。`;

export const SEAT_PERSONAS: Record<string, string> = {
	architect: ARCHITECT_PERSONA,
	// ★ 自进化两席（用户 2026-09-25：「两个固定的子 agent …… 专门处理自进化的事宜」）
	dev: DEV_PERSONA,
	review: REVIEW_PERSONA,
};

/** 每个席位注册的 provider 名（也就是 preset 里 `tool-subagent.config.provider` 要填的值）。 */
export const SEAT_PROVIDER_NAMES: Record<string, string> = {
	architect: "council-architect",
	dev: "evo-dev",
	review: "evo-review",
};

/** 自进化两席：这两席**必须不同源**（防串供）。用于启动期的同源检查。 */
export const EVOLUTION_SEATS = ["dev", "review"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

class SeatProvider {
	name;
	/**
	 * 四项都声明 true：我们只是"预配置"，不削减 in-process driver 的能力。
	 * 若某席位要限制子代理的工具集，可在 start() 里补 toolFilter
	 * （in-process backend 会把它作为 scoped `tools.restrict()` 应用，
	 *   工具从子代理的 prompt 中消失且拒绝执行 —— 一个可见性）。
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

	constructor(providerName: string, persona: string, model: string, providerRoute: string) {
		this.name = providerName;
		this.#persona = persona;
		this.#model = model;
		this.#providerRoute = providerRoute;
	}

	start(request: any) {
		const next: any = { ...request };

		// 注入席位人格 —— 它 shadow 掉 deployment persona，只对这一个子代理生效。
		next.persona = this.#persona;

		// 多模型会议室入口：给这一席换 provider route / model。
		// 留空则完全继承顶层会话的路由（默认行为，第一版就是这个）。
		if (this.#providerRoute || this.#model) {
			next.agentOptions = { ...(request?.agentOptions ?? {}) };
			if (this.#providerRoute) next.agentOptions.provider = this.#providerRoute;
			if (this.#model) next.agentOptions.model = this.#model;
		}

		return startInProcessRun(next, {});
	}

	prepareContinuable() {
		return Promise.resolve({});
	}
}

export function apply(ctx: any, config: any) {
	// ★ 席位清单：给了 `seats` 就按它注册多个（自进化两席一次挂上）；
	//   否则退回"只注册 `seat`" —— **向后兼容**，默认行为与改动前逐字一致。
	const seats: string[] =
		Array.isArray(config?.seats) && config.seats.length > 0
			? config.seats.map((s: unknown) => String(s))
			: [config?.seat ?? "architect"];

	const model = config?.model ?? "";
	const provider = config?.provider ?? "";

	for (const seat of seats) {
		const persona = SEAT_PERSONAS[seat];
		if (!persona) {
			// ★★ 不许静默降级成 architect —— 那会给你一个**名字对、人格错**的席位（最坏的假绿）。
			console.log(
				`[subagent-council] ⚠️ 未知席位 "${seat}" ⇒ **跳过**（已知：${Object.keys(SEAT_PERSONAS).join(", ")}）`,
			);
			continue;
		}
		const providerName = SEAT_PROVIDER_NAMES[seat] ?? `council-${seat}`;
		ctx.subagents.registerProvider(new SeatProvider(providerName, persona, model, provider));
		console.log(
			`[subagent-council] 已注册席位 "${seat}" ⇒ provider="${providerName}"` +
				`（model="${model || "(继承)"}" / provider="${provider || "(继承)"}"）`,
		);
	}

	// ★★ 防串供检查（`docs/revised-architecture-2026-09-20.md:218` 逐字：
	//    **产变更方不能与审批方同源**）——两席都挂上时必须**可见可核**，不许悄悄过去。
	const on = EVOLUTION_SEATS.filter((s) => seats.includes(s));
	if (on.length === EVOLUTION_SEATS.length) {
		console.log(
			`[subagent-council] ★ 自进化两席已就位：${on.map((s) => `${s}(${SEAT_PROVIDER_NAMES[s]})`).join(" + ")}` +
				`；防串供要求**不同源**，当前路由=(provider="${provider || "(继承)"}", model="${model || "(继承)"}")`,
		);
		if (provider === "" && model === "") {
			console.log(
				`[subagent-council] ⚠️ 两席都**继承顶层**（未显式给路由）⇒ 只能算【**跨会话**】档，**未到【跨模型】**档。` +
					`★ 独立性是**三级阶梯**（文档 self-evolution-design.md §6 逐字：跨模型 > 跨会话 > 同会话换 prompt）：` +
					`跨会话**已算独立**，只是判别力弱于跨模型 ⇒ 要更强就**给两席各自的路由**（两次挂载、各给 config）。`,
			);
		}
	}
}
