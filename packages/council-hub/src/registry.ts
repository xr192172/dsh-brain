/**
 * registry.ts —— 席位注册表：`client_id` ↔ 席位、基角色 → 席位集合 双索引。
 *
 * ## 为什么两个索引住一个对象
 * 下发的两条寻址路径（按 `client_id` 点名 / 按基角色广播）读的是同一张表。
 * 分成两个 Map 各自维护 = 迟早一边删了另一边还在（幽灵席位），而幽灵席位的症状是
 * 「任务下发成功但没人回」—— 最难查的一类。
 *
 * ## 编号自动化（待建队列 #3）本卡不做，但**生成点收在这里**
 * 现在 `client_id` 是进程内自增（`c_001`…）；将来要换成 `agent:席名-序号` 的分配策略，
 * 只改 `nextClientId()` 一处，不碰调用方。
 */

import type { Role } from './protocol.js'

export interface Seat {
  clientId: string
  /** 基角色（白名单内的六者之一） */
  role: Role
  /** 客户端自称的原始角色串（如 executor-alpha）—— 回执与审计要能看出它到底是谁 */
  rawRole: string
  name: string
  connectedAt: number
  /** 把信封发给这个席位（由 server 注入，registry 不认识 ws） */
  send: (envelope: unknown) => void
}

export interface RegisterInput {
  role: Role
  rawRole?: string
  name?: string
  send: Seat['send']
}

export class SeatRegistry {
  private readonly byId = new Map<string, Seat>()
  private seq = 0

  /** 生成下一个 client_id（★ 编号策略的唯一落点） */
  private nextClientId(): string {
    this.seq += 1
    return `c_${String(this.seq).padStart(3, '0')}`
  }

  register(input: RegisterInput): Seat {
    const rawRole = input.rawRole ?? input.role
    const seat: Seat = {
      clientId: this.nextClientId(),
      role: input.role,
      rawRole,
      name: input.name ?? rawRole,
      connectedAt: Date.now(),
      send: input.send,
    }
    this.byId.set(seat.clientId, seat)
    return seat
  }

  /** 摘除；返回 false = 本来就不在（重复断线不报错，但不假装摘掉了） */
  unregister(clientId: string): boolean {
    return this.byId.delete(clientId)
  }

  byClientId(clientId: string): Seat | undefined {
    return this.byId.get(clientId)
  }

  /** 同基角色的全部席位（评审席/执行席都可能多实例） */
  byRole(role: Role): Seat[] {
    return [...this.byId.values()].filter((s) => s.role === role)
  }

  list(): Seat[] {
    return [...this.byId.values()]
  }

  get size(): number {
    return this.byId.size
  }
}
