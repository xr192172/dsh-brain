/**
 * @dsh-brain/skill-tree —— 能力库**数据层**骨架（2026-09-20）
 *
 * 来源：`ai-base/agent-shell/internal/memory/skill_tree.go`（只读参考，不改）。
 * 依据：`docs/revised-architecture-2026-09-20.md` §7.3 ——
 *       「能力库不需要设计，`SkillTree` 已经是了。它唯一缺的是执行方式。」
 * 边界：**数据先行、执行器可替换**。本包刻意**不含** `GetActiveSkills` / 注入 / 委派
 *       那半边 —— 那是要被换掉的"执行器"，等数据层稳了再单独做（见 port-plan §6）。
 *
 * ⚠ 序列化边界：Go 侧 JSON tag 是 **snake_case**（`use_count` / `success_rate` …），
 *   本文件用 **camelCase**（照 Go 字段名）。两边要互通就得有一层显式映射，
 *   **不许靠"字段名刚好一样"的默契**。映射层未写之前，本包不接 ai-base 的 skill_tree.json。
 */

// ─────────────────────────────────────────────────────────────────────────────
// ch22 §6: Skill-as-Capability —— 工具声明
// 对应 external.ToolDef（external/skill_registry.go）
// ─────────────────────────────────────────────────────────────────────────────

/** 技能声明的可调用工具。注册到 ToolRegistry 后才是"能力"，否则只是描述。 */
export interface ToolDef {
  /** 工具名（全局唯一，建议前缀如 scout_） */
  Name: string
  /** 给 LLM 看的描述 */
  Description: string
  /** "python" | "shell" | "subprocess" */
  Kind: string
  /** 脚本入口（相对 skill 目录） */
  Entry: string
  /** 调用的函数名（python）或子命令（shell） */
  Fn: string
  /** JSON Schema（注册到 ToolRegistry） */
  Schema: Record<string, unknown>
  /** true = 纯计算/查询，不修改文件系统（跳过权限审批） */
  ReadOnly: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// 生命周期枚举（skill_tree.go:27 / :85 / :92 / :107）
// ─────────────────────────────────────────────────────────────────────────────

/** `Status`：active | demoted | archived，外加非导出的 absorbed。 */
export const SkillStatus = {
  Active: 'active',
  Demoted: 'demoted',
  Archived: 'archived',
  /** 已被别的节点吸收，从各索引中排除 —— Go 侧是未导出的 `statusAbsorbed`。 */
  Absorbed: 'absorbed',
} as const
export type SkillStatus = (typeof SkillStatus)[keyof typeof SkillStatus]

/** `Source`：learned（自学）| user（用户）| community（社区）| shared（跨脑同步）。 */
export const SkillSource = {
  Learned: 'learned',
  User: 'user',
  Community: 'community',
  Shared: 'shared',
} as const
export type SkillSource = (typeof SkillSource)[keyof typeof SkillSource]

/**
 * `AbsorbOutcome`：跨路径吸收的结果（ch09 §5）。
 * 用数字枚举以保住 Go 的 iota 序（0..3），便于跨语言日志/回执对齐。
 */
export const AbsorbOutcome = {
  /** 6 条合并规则已应用，被吸收节点标记 status="absorbed" */
  Succeeded: 0,
  /** 目标节点 Exclusive=true —— 用户显式要求它保持独立 */
  RejectedExclusive: 1,
  /** 合并后 validation_score < min(合并前两者) */
  RejectedValidation: 2,
  /** 两个 ID 有一个不在 Nodes 里 */
  RejectedNotFound: 3,
} as const
export type AbsorbOutcome = (typeof AbsorbOutcome)[keyof typeof AbsorbOutcome]

/** ch09 §3 文本学习率：单个 epoch 内每个技能最多允许被接受编辑的次数。 */
export const MaxEditsPerEpoch = 3

/** `SendInputRequired`：`conditional` | `never` | `always`。 */
export type SendInputRequired = 'conditional' | 'never' | 'always'

// ─────────────────────────────────────────────────────────────────────────────
// SkillNode（skill_tree.go:21-74）—— 33 个字段，一字不减
// ─────────────────────────────────────────────────────────────────────────────

/** 编辑审计：一次编辑操作的留痕（`EditRecord`，skill_tree.go:77）。 */
export interface EditRecord {
  /** 所属 epoch（对应 SkillTree 内部的自增 epoch，Save() 时 +1） */
  Epoch: number
  /** 操作类型：reflect_fix | reflect_triggers | reflect_rejected */
  Op: string
  /** 改动内容 / 拒绝理由 */
  Delta: string
  /** 是否被接受；false 的条目不计入 MaxEditsPerEpoch */
  Accepted: boolean
}

/**
 * 技能树上的一个节点。Path A（自学）与 Path B（用户/社区）共用同一 schema。
 *
 * 分组照 Go 原文件的注释块划分，**字段顺序即 Go 顺序**，便于逐行核对。
 */
export interface SkillNode {
  // ── 基础 ──
  ID: string
  /** 恒为 "skill" */
  Type: string
  Parent: string
  Source: SkillSource | string
  /** 归属脑；空串表示跨脑共享（MergeRemote 里两个脑不一致时会被清空） */
  Brain: string
  Status: SkillStatus | string
  /** 0=archived, 1=普通, 3=L3（score≥0.7 ∧ use_count≥10） */
  Level: number
  Score: number
  UseCount: number
  SuccessRate: number
  Principle: string
  Fix: string
  /** 路由依据 */
  Triggers: string[]

  // ── Path B：由 SkillRegistry 导入时填充 ──
  SourceFile: string
  /** 源文件 SHA256，用于探测上游变更 → update_pending */
  SourceHash: string
  ImportedAt: string
  ImportVersion: number

  // ── Direction 4：能力泛化（可组合 + 可继承）──
  /** 配套脚本相对路径 */
  Script: string
  /** python / shell / js / go */
  ScriptLang: string
  /** 配套归档压缩包相对路径 */
  Archive: string
  SendInputRequired: SendInputRequired | string
  /** 继承：父技能名/ID。子继承父的 body + triggers + script/archive（未覆盖时） */
  Extends: string
  /** 组合：激活本技能时依赖也被拉进来（一层深，不递归） */
  Requires: string[]

  // ── 进化追踪 / 谱系 ──
  EditHistory: EditRecord[]
  MergedFrom: string[]
  /** 吸收了本节点的那个节点 ID */
  AbsorbedBy: string
  RejectedAttempts: number
  LastValidated: string
  ValidationScore: number

  // ── ch22 §6：工具声明（有 Script/Tools ⇒ 可升格 sub agent）──
  Tools: ToolDef[]

  /** ch09 §5：用户钉住不许被跨路径合并 */
  Exclusive: boolean

  // ── 时间戳 ──
  LastUsedAt: string
  CreatedAt: string
}

/** 已被吸收的判据（skill_tree.go:112）—— Status=absorbed 或 AbsorbedBy 非空。 */
export function isAbsorbed(node: SkillNode): boolean {
  return node.Status === SkillStatus.Absorbed || node.AbsorbedBy !== ''
}

// ─────────────────────────────────────────────────────────────────────────────
// 树级元数据与评估门（skill_tree.go:145 / gate.go:41-50）
// ─────────────────────────────────────────────────────────────────────────────

/** 树文件顶层元数据（`SkillTreeMeta`，skill_tree.go:145）。 */
export interface SkillTreeMeta {
  Version: number
  /** 环形缓冲，上限 20（skill_tree.go 里截断到末 20 条） */
  RejectedEdits: string[]
}

/** 留出集评估结果（`EvalResult`，gate.go:41）。 */
export interface EvalResult {
  /** 留出集上的 validation_score */
  Score: number
  /** 分数变化 ≤ ±0.02 容差 */
  Passed: boolean
  /** 人可读原因；"无验证集"这类原因不算门控（见 IsEvalReady） */
  Reason: string
}

/**
 * 评估器接口（`SkillEvaluator`，gate.go:50）。
 * 刻意只留接口：换评估策略不该碰到 SkillTree —— 这也是 §7.4 安全门（L1/L3）的挂载点。
 */
export interface SkillEvaluator {
  Evaluate(skill: SkillNode, validationSet?: unknown[]): EvalResult
}

/** 初始信任分（skill_tree.go:254）：user .60 / community|shared .55 / learned .30。 */
export function initialScore(source: string): number {
  switch (source) {
    case SkillSource.User:
      return 0.6
    case SkillSource.Community:
      return 0.55
    case SkillSource.Shared:
      return 0.55
    default:
      return 0.3
  }
}

/** ch09 §5 合并规则 5：加权平均（被吸收方 .3 + 目标方 .7）。 */
export function mergedScore(absorbed: number, into: number): number {
  return absorbed * 0.3 + into * 0.7
}
