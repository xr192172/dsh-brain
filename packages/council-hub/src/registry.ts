/**
 * registry.ts —— 席位注册表：`client_id` ↔ 席位、基角色 → 席位集合 双索引。
 *
 * ## 为什么两个索引住一个对象
 * 下发的两条寻址路径（按 `client_id` 点名 / 按基角色广播）读的是同一张表。
 * 分成两个 Map 各自维护 = 迟早一边删了另一边还在（幽灵席位），而幽灵席位的症状是
 * 「任务下发成功但没人回」—— 最难查的一类。
 *
 * ## 编号自动化（§15.6，卡 3a 已落地）
 * `client_id` = `agent:<席名>-<序号>`，序号**按席名独立自增**（executor-1 / executor-2 /
 * review-board-1 …）。生成点只有 `nextClientId()` 一处 —— 换策略只改这里。
 */

import type { Role } from './protocol.js'

export interface Seat {
  clientId: string
  /** 席名（编号的头部：executor-alpha / review-board …） */
  seatName: string
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
  /** 每个席名各自计数（executor-1 / executor-2 / review-board-1 …） */
  private readonly seqBySeat = new Map<string, number>()

  /**
   * 生成下一个编号 `agent:<席名>-<序号>`（★ 编号策略的唯一落点）。
   * ★ 序号**按席名独立自增**：同一具席位的第 2 个实例是 executor-2，不是全局第 7 号 ——
   *   §15.6 的「编号 = 席名 + 序号」，跨席共用一个计数器会让「第 2 号执行器」变成「第 7 号」，
   *   编号就失去了「这具席位的第几个实例」这个信息。
   */
  private nextClientId(seatName: string): string {
    const n = (this.seqBySeat.get(seatName) ?? 0) + 1
    this.seqBySeat.set(seatName, n)
    return `agent:${seatName}-${n}`
  }

  /** 席名 = 原始角色串去掉 `agent:` 前缀并清洗（`agent:executor-alpha` → `executor-alpha`） */
  static seatNameOf(raw: string, role: Role): string {
    const cleaned = String(raw ?? '')
      .replace(/^agent:/, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    return cleaned || role
  }

  register(input: RegisterInput): Seat {
    const rawRole = input.rawRole ?? input.role
    const seatName = SeatRegistry.seatNameOf(rawRole, input.role)
    const seat: Seat = {
      clientId: this.nextClientId(seatName),
      seatName,
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

  /**
   * actor 是否就是这个席位的编号（★ 编号即身份）。
   * 容忍 `agent:` 前缀缺省 —— 调度席写人话时会写 `executor-1`，强制全名只会制造摩擦。
   */
  isSeatNumber(seat: Seat, actor: string): boolean {
    const a = String(actor ?? '').trim()
    return a === seat.clientId || a === seat.clientId.replace(/^agent:/, '')
  }

  list(): Seat[] {
    return [...this.byId.values()]
  }

  get size(): number {
    return this.byId.size
  }
}
