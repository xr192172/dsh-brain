/**
 * DSH Cat Meme Desktop Pet Plugin - Server Half
 * @module catpet-desktop-pet
 */

export const name = 'catpet-desktop-pet'
export const inject = []

export function apply(ctx) {
  const harness = ctx.get('harness')
  if (!harness) return

  let currentStatus = 'idle'

  // 监听Agent状态变化
  ctx.on('agent/status', (payload) => {
    currentStatus = payload.status
    console.log('Cat Pet: Agent status changed:', currentStatus)
  })

  // 监听任务完成
  ctx.on('agent/turn-stopping', (payload) => {
    console.log('Cat Pet: Task completed, turn:', payload.turn)
  })

  // 注册状态查询handler
  harness.handle('queryPetStatus', () => {
    const agents = ctx.get('agents')
    if (!agents) return { status: 'idle' }
    const current = agents.currentInitiator()
    if (!current) return { status: 'idle' }
    return { status: currentStatus }
  })

  // 注册状态更新handler
  harness.handle('updatePetStatus', () => {
    return { status: currentStatus }
  })

  // 注册任务完成handler（触发客户端庆祝）
  harness.handle('petTaskComplete', () => {
    return { completed: true }
  })

  // 清理函数
  ctx.effect(() => {
    return () => {
      // 清理逻辑
    }
  })
}