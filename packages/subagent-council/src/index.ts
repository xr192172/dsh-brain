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

const SEAT_PERSONAS: Record<string, string> = { architect: ARCHITECT_PERSONA };

/** 每个席位注册的 provider 名（也就是 preset 里 `tool-subagent.config.provider` 要填的值）。 */
const SEAT_PROVIDER_NAMES: Record<string, string> = { architect: "council-architect" };

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
	const seat = config?.seat ?? "architect";
	const persona = SEAT_PERSONAS[seat] ?? SEAT_PERSONAS.architect;
	const providerName = SEAT_PROVIDER_NAMES[seat] ?? `council-${seat}`;
	ctx.subagents.registerProvider(
		new SeatProvider(providerName, persona, config?.model ?? "", config?.provider ?? ""),
	);
}
