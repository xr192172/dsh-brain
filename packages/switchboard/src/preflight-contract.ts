/**
 * @module @dsh-brain/switchboard/preflight-contract
 *
 * 预演体检（preflight）的**契约层**：只有类型与判据分类学，零 import、零副作用。
 *
 * ★★ 为什么单独成层（2026-09-24，格⑮；本文件在主仓语境下由重放臂叠加进来）
 *
 * 用户对本控制面的关键澄清（逐字）：
 *   「这个控制面其实就是做一个 DSH 启动器，然后 DSH 启动器通过【遥控器】——就是插件的方式——
 *     给 DSH 植入一个遥控器，然后每一代分别持有不同的遥控器，然后对其他的代进行开启和关闭以及测试。」
 *   「它现在真正的用途是：安装插件以后怎么知道这个插件是否能够运行 ——
 *     因为以前是有 DSH 装插件或者拔插件把自己给搞崩了的情况，而现在我们可以判断它是可以正常运行
 *     之后再换代。这才是这个控制面真正的收益。」
 *
 * ⇒ 一句话目标：**改 profile 装配（装/拔插件）后，先在【预演代】上验证它能跑，确认了再换代；
 *   不通过就丢弃，现役不受影响。**
 *
 * 已有的「换代」机制（`coordinator.ts`）是「flip 之后才 verify」——它把 staging 代**先**推上前门，
 * 判失败再回滚。这对"日常代码改动"够用（回滚免费），但对"装/拔插件"不是最优：
 * 插件的坏法恰恰是**整棵插件树装配失败**（`TypeError: duplicate loader entry id` / 模块找不到），
 * 此时前门已经指到过那个坏代上，回滚窗口里可能已经接走了一个会话。
 *
 * 本子系统因此刻意**不碰前门**：它只 spawn 一个**预演代**、**读活实例**、**杀掉丢弃**。
 * 前门、租约、活跃代在整个预演期间**一个字节都不变** —— 这是本契约的硬不变量（见 `preflight.ts`
 * 的 INVARIANT 注释与 `preflight.ts::PreflightRunner` 的依赖面：它拿不到 FrontDoor/Lease）。
 *
 * 判据分类学（体检项 kind）刻意固定为五种，每种对应**一种物理事实**，而不是"某段配置写着什么"：
 *   · `boot`    —— 预演代的启动日志有**正向完成信号**且无致命装载错误（复用 `boot-health.ts`）
 *   · `admin`   —— 预演代的 loopback admin 应答，且自报 gen 与我们的账本一致（进程真的活着）
 *   · `plugin`  —— 声明要装配的插件，在**活实例的 Loader 树**里存在、启用、且 root Fiber phase=active
 *   · `tool`    —— 声明要注册的工具，出现在**活实例的模型面工具表**（`ctx.tools.schemas()`）里
 *   · `command` —— 声明要注册的 host 命令，出现在活实例的命令注册表里
 *
 * ★ 「活实例」的定义（这是本子系统与"读配置"的分水岭）：所有 `plugin`/`tool`/`command` 的
 *   **实测值**都来自**预演代进程内的运行时注册表**，经 gen 侧 admin `/admin/inventory` 吐出来
 *   （`inventory.ts` / `admin.ts` / `index.ts`），**不是**解析 `cordis.patch.yml` 得到的。
 *   路径是：控制面 → 预演代 admin → `ctx.loader.entries()` / `ctx.tools.schemas()` → 回传。
 *   一个模块 `import` 就抛错的插件，在配置里与健康插件**完全同形**，只有这条路径能把它认出来。
 */

/** 体检项的类别。固定五值：每一值对应一种物理事实，见模块头。 */
export type CheckKind = 'boot' | 'admin' | 'plugin' | 'tool' | 'command'

/** 单条体检项的结果。 */
export interface CheckResult {
  kind: CheckKind
  /** 体检项稳定标识（报告里直接引用；`plugin:<id>` / `tool:<name>` 形态）。 */
  name: string
  ok: boolean
  /** 一句话：通过=读数，失败=为什么（含期望/实测）。 */
  detail: string
  /** 声明侧期望（可读形式）。 */
  expect?: string
  /** 活实例实测（可读形式）。 */
  actual?: string
}

/**
 * 声明侧清单：本次预演**应该**存在的东西。
 *
 * 它从哪来？由调用方给（控制面 `?cmd=preflight` 的 `plugins=`/`tools=`/`commands=` 参数，
 * 或由上层从候选 profile 的装配意图生成）。本子系统**不**自己去推导"应该有什么"——
 * 那是"读配置"，而契约要的是"配置说的"与"活实例有的"**两个来源独立**，否则判据退化成同义反复。
 */
export interface PreflightManifest {
  /** 期望装配且 root Fiber phase=active 的 loader 条目 id。 */
  plugins?: string[]
  /** 期望出现在模型面工具表里的工具名。 */
  tools?: string[]
  /** 期望出现在 host 命令注册表里的命令名。 */
  commands?: string[]
}

/** 一次预演的请求。 */
export interface PreflightRequest {
  /** 预演代要跑的 profile（= 候选装配的底座）。与现役 profile 可以不同。 */
  profile: string
  /**
   * 候选装配的 **overlay 叠加层**（绝对路径数组，dsh `--patch`）。
   *
   * ★ 为什么要有它：用户说的"装/拔插件"在 dsh 里就是**改 profile 的装配**（`cordis.patch.yml`
   * 的 insert / disable / 覆盖块）。若预演只能按 profile 名跑，那每做一次实验都得在
   * `$DSH_HOME/profiles/` 下铸造一个永久 profile ⇒ 实验变重、且把一次性实验固化成持久状态。
   * 有了 overlay，一次实验 = `(profile, overlay/overlay2/...)`，用完即弃。
   *
   * 语义与 dsh CLI 的 `--patch` 一致（在 profile 层与 home 层之后应用，优先级最高）。
   */
  patches?: string[]
  /** 声明侧清单（缺省=只跑结构与启动体检，不查具体插件/工具）。 */
  manifest?: PreflightManifest
  /** 单条有界等待预算 ms（默认 15000）。 */
  timeoutMs?: number
}

/**
 * 预演结论。三值刻意分开：
 *   · `pass`   —— 全部体检项通过。**注意这只是"可以换代"的必要条件之一，不是自动换代**。
 *   · `reject` —— 体检项有 red。原因为何写在 `checks[].detail`（绝不吞）。
 *   · `error`  —— 预演**本身**没能完成（spawn 失败 / engine 内部异常）。与 reject 分开，
 *                 因为"这台机器起不来"和"这个插件是坏的"是两件事，混在一起会误导运维。
 */
export type PreflightVerdict = 'pass' | 'reject' | 'error'

/** 预演代的身份（取证用）。 */
export interface RehearsalIdentity {
  gen: string
  /** 预演代主端口（dsh web）。 */
  port: number
  /** 预演代 loopback admin 端口。 */
  adminPort: number
  pid: number
  profile: string
  /** 预演代落地目录（boot.log/lifecycle.log 在此）。 */
  genDir: string
}

/** 丢弃取证：证明"不留半途污染"。 */
export interface DiscardEvidence {
  /** spawner 的强杀闭环是否报告进程已退出。 */
  stopped: boolean
  /** PID 是否已从系统消失（真消失，不是"发过信号"）。 */
  pidGone: boolean
  /** 杀掉后 admin 是否确实不再应答（"端口不在了"的第二道确认）。 */
  adminDead: boolean
}

/** 一次预演的完整报告。**这是本子系统的产出契约**，落盘为 JSON，也可直接给面板渲染。 */
export interface PreflightReport {
  verdict: PreflightVerdict
  rehearsal: RehearsalIdentity
  checks: CheckResult[]
  /** 预演代是否已被确认丢弃。 */
  discarded: DiscardEvidence
  /** reject/error 时的一句话总因（checks 里仍有逐条细节）。 */
  reason?: string
  startedAt: number
  finishedAt: number
  /** 控制面 build stamp：证明这次预演跑的是哪一份代码（防止"改了没生效"被误读成通过）。 */
  build?: string
}

/**
 * 活实例清点：gen 侧 `/admin/inventory` 的返回形状。
 *
 * 这是「对活实例查」的**wire 契约**。三个数组都来自**本进程运行时**：
 *   · `plugins`  ← `ctx.loader.entries()`（Loader 是唯一生命周期权威）
 *   · `tools`    ← `ctx.tools.schemas()`（模型面可见工具，registry 喂给 systemPrompt 的同一份表）
 *   · `commands` ← `ctx.commands.list()`（host 命令注册表）
 * 每项都带"取不到"的表达（`null` / 空数组 / `unavailable`），因为**观测不到必须可分辨**：
 * "查不到"若与"没有"同形，判据就是假绿。
 */
export interface LiveInventory {
  gen: string
  mode: string
  /**
   * Loader 条目。`id` 是**归一化**后的（剥掉跟 include 根的前缀，见 `inventory.ts`），
   * 因此可以直接与候选装配里写的条目 id 对账；`rawId` 仅在归一化发生时出现（取证用）。
   */
  plugins: Array<{ id: string; module: string; enabled: boolean; phase: string | null; rawId?: string }>
  /** 模型面可见工具名（排序后）。 */
  tools: string[]
  /** host 命令名（排序后）。 */
  commands: string[]
  /** 服务未装配时的可分辨标记（如 `tools: 'service-unavailable'`）。 */
  unavailable?: Record<string, string>
  at: number
  /** 本进程 build stamp（与 PreflightReport.build 对账，确认两端同一份代码）。 */
  build?: string
}

/** `?cmd=preflight` 的同步应答（真正的报告走 `?cmd=preflight-result` 轮询，与 apply 同款）。 */
export interface PreflightAccepted {
  ok: true
  cmd: 'preflight'
  stage: 'started'
  profile: string
}
