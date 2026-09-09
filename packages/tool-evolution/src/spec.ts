/**
 * spec — tool-evolution 的类型表合并 + 自定义会话事件。
 * 合并三张表：SessionProjectionStateMap / SessionProjectionMap / SessionEventMap('tool/review')。
 */

/** 一次工具调用的适应度档案（I3.2 采集信号）。 */
export interface ToolStat {
  calls: number
  failures: number
  /** 命中的错误码（去重，长度上限见 maxTools）。 */
  errors: string[]
  totalLatencyMs: number
  latencyN: number
  avgLatencyMs: number
  /** LLM 提交的打分（1-10）。 */
  scores: number[]
  /** LLM 提交的评分依据/PR 建议（最近若干条）。 */
  reviews: string[]
}

/** 宿主 fold 状态（纯 JSON，可持久化）。 */
export interface ToolEvolState {
  tools: Record<string, ToolStat>
  seq: number
}

/** 客户端可见线值（web UI 读）。 */
export interface ToolEvolView {
  tools: Record<string, ToolStat>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** LLM 使用工具后的自评（I3.1 打分来源）：附加为自定义会话事件，可回放。 */
    'tool/review': {
      caller: string
      tool: string
      score: number
      rationale: string
      suggested?: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    tool_evol: ToolEvolState
  }
  interface SessionProjectionMap {
    tool_evol: ToolEvolView
  }
}

export type {} // 让本文件成为模块，避免声明合并被当成全局