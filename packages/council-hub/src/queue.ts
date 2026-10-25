/**
 * queue.ts —— 任务队列：优先级 + 同优先级 FIFO + dependsOn 依赖序 + 并发上限。
 *
 * ## 三条判据（本文件就是它们的唯一落点）
 *
 * ① **并发上限是硬闸**：`running.size >= maxConcurrent` 时 `nextRunnable()` 必须返回 null。
 *    这一条是「额度用尽自动回闸口」的地基 —— 若允许先出队再排队，上限就只是建议。
 * ② **优先级大者先出**；**同优先级先到先得**（`pending` 保持入队顺序，比较用严格大于，
 *    所以后来的同优先级任务**不会**插到前面）。
 * ③ **依赖序看的是"完成"这个事实，不是入队顺序**：`dependsOn` 里每个 id 都必须在 `done` 里
 *    才允许出队。★ 入队顺序是传输时序，不是依赖事实 —— 拿它当依赖是猜测。
 *
 * ★ 出队即占位（`nextRunnable` 同时把任务移进 `running`）是**有意的原子操作**：
 *   拆成 `pick()` + `markRunning()` 两步，迟早有人忘了第二步，于是上限被绕过。
 */

/** 任务端点（与 protocol 的 Address 同形；本模块刻意不 import protocol，保持可独立单测） */
export interface TaskEndpoint {
  role: string
  id?: string
}

export interface QueuedTask {
  id: string
  /** 大者先出；缺省 0 */
  priority: number
  /** 这些任务 id 全部完成后才允许出队 */
  dependsOn: string[]
  from: TaskEndpoint
  to: TaskEndpoint
  payload: Record<string, unknown>
  enqueuedAt: number
  /** 派发时写入的被指派编号（★ 编号即身份：之后只有它才能了结这个任务） */
  assignee?: string
}

export interface EnqueueInput {
  id: string
  priority?: number
  dependsOn?: string[]
  from: TaskEndpoint
  to: TaskEndpoint
  payload?: Record<string, unknown>
}

export interface QueueConfig {
  maxConcurrent: number
}

export type TaskOutcome = 'completed' | 'failed'

export interface QueueStats {
  pending: number
  running: number
  completed: number
  failed: number
  maxConcurrent: number
  pendingIds: string[]
  runningIds: string[]
}

export class TaskQueue {
  private readonly config: QueueConfig
  private readonly pending: QueuedTask[] = []
  private readonly running = new Map<string, QueuedTask>()
  private readonly done = new Set<string>()
  private readonly failed = new Set<string>()

  constructor(config: Partial<QueueConfig> = {}) {
    const n = Math.floor(Number(config.maxConcurrent ?? 4))
    this.config = { maxConcurrent: Number.isFinite(n) && n >= 1 ? n : 1 }
  }

  get maxConcurrent(): number {
    return this.config.maxConcurrent
  }

  /**
   * 入队。同 id 重复入队**抛错**（不静默覆盖）—— 覆盖会让"两个任务共用一个 id"这种上游
   * bug 变成"只有一个任务在跑"，是最难查的一类静默错。
   */
  enqueue(input: EnqueueInput): QueuedTask {
    const id = String(input.id ?? '').trim()
    if (!id) throw new Error('入队任务必须有非空 id')
    if (this.has(id)) throw new Error(`任务 id 重复：${id}`)
    const task: QueuedTask = {
      id,
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
      dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.map(String) : [],
      from: input.from,
      to: input.to,
      payload: input.payload ?? {},
      enqueuedAt: Date.now(),
    }
    this.pending.push(task)
    return task
  }

  /** 该 id 是否还在本队列的视野内（待跑 / 在跑 / 已了结） */
  has(id: string): boolean {
    return (
      this.pending.some((t) => t.id === id) ||
      this.running.has(id) ||
      this.done.has(id) ||
      this.failed.has(id)
    )
  }

  /** 任务是否已完成（依赖序判据读的就是它） */
  isDone(id: string): boolean {
    return this.done.has(id)
  }

  /**
   * 取出下一个可派发的任务并**就地占位**（进 `running`）。没有可派发的返回 null。
   * 可派发 = 依赖全部完成 ∧ 并发未满。
   */
  nextRunnable(): QueuedTask | null {
    if (this.running.size >= this.config.maxConcurrent) return null
    let best = -1
    for (let i = 0; i < this.pending.length; i += 1) {
      const t = this.pending[i]
      if (!t.dependsOn.every((d) => this.done.has(d))) continue
      if (best < 0) {
        best = i
        continue
      }
      // ★ 严格大于：同优先级保留先到的那个（FIFO）
      if (t.priority > this.pending[best].priority) best = i
    }
    if (best < 0) return null
    const [task] = this.pending.splice(best, 1)
    this.running.set(task.id, task)
    return task
  }

  /** 派发时登记被指派者（★ 编号即身份：之后只有它才能了结这个任务） */
  setAssignee(id: string, clientId: string): boolean {
    const task = this.running.get(id) ?? this.pending.find((t) => t.id === id)
    if (!task) return false
    task.assignee = clientId
    return true
  }

  /** 这个任务被指派给了谁（不在队列视野内 ⇒ undefined） */
  assigneeOf(id: string): string | undefined {
    return this.running.get(id)?.assignee ?? this.pending.find((t) => t.id === id)?.assignee
  }

  /**
   * 了结一个在跑的任务。返回 false = 该 id 不在 running 里（重复回报 / 未派发就回报），
   * 调用方据此回执，**不静默当成功**。
   */
  finish(id: string, outcome: TaskOutcome): boolean {
    const task = this.running.get(id)
    if (!task) return false
    this.running.delete(id)
    if (outcome === 'completed') this.done.add(id)
    else this.failed.add(id)
    return true
  }

  stats(): QueueStats {
    return {
      pending: this.pending.length,
      running: this.running.size,
      completed: this.done.size,
      failed: this.failed.size,
      maxConcurrent: this.config.maxConcurrent,
      pendingIds: this.pending.map((t) => t.id),
      runningIds: [...this.running.keys()],
    }
  }
}
