/**
 * 两脑定义（three-brain 在该代际体系里的收敛形态）。
 *
 * 合并自 three-brain，但砍掉 sandbox：在本控制面体系里，sandbox 的"隔离验证"角色
 * 已被蓝绿的 staging 代（独立进程、真隔离）完全取代——无需再进程内开一个假沙箱脑。
 * 只保留 left（主行动脑，无委派目标 = 主线自身）与 right（只读研究/审计脑）。
 */
export interface BrainDef {
  kind: 'left' | 'right'
  role: string
  /** 是否允许变更工具（right 禁写）。 */
  mutating: boolean
  /** 对应可委派的 subagent 工具名（left 为 0，表示主线自身）。 */
  delegateTool?: string
}

export const BRAINS: readonly BrainDef[] = [
  { kind: 'left', role: '直接服务执行的主行动脑', mutating: true },
  { kind: 'right', role: '只读研究/审计脑（禁写，多轮检索复盘）', mutating: false, delegateTool: 'brain_right' },
]