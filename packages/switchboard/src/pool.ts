/**
 * @module @dsh-brain/switchboard/pool
 *
 * 哨兵池：`{COORD_DIR}/pool.json`。
 *
 * ★ 用户裁决（2026-09-26，`docs/launcher-sentinel-impl-2026-09-26.md` §0）：
 *   任何时刻**只有一个主代（primary）**在服役；后面开的都是**哨兵**，
 *   ★★ **只有当前主代退役了，才提拔"当前哨兵选定的那个"作新主代**。
 *   ⇒ 模型里有且只有三个动作：**立哨 / 选定 / 提拔**。**没有"算哪个最好"这一步。**
 *
 * ★ 为什么另立 `pool.json` 而**不**往 `lease.json` 里塞字段：
 *   `lease.json` 是**单一写者 + fencing token** 的敏感文件（见 lease.ts:6）——
 *   往里加字段会动它的不变量。⇒ **不碰它**；`primary` 从 `lease.json` **只读**派生。
 *
 * ★ 本文件是**单一写者 = 控制面**（与 lease 同族纪律，铁律 31）。
 *   外部进程**只读，绝不写**。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 一个"代"的可寻址身份 —— ★ 带 `port`，满足用户裁决 4「保留端口信息即可」。 */
export interface GenRef {
  gen: string
  port: number
  pid: number
}

export interface PoolState {
  /** 唯一在服役的主代。★ 由 `lease.json` 的 `activeGen` 派生（只读），不在此自持真相。 */
  primary: GenRef | null
  /** ★ "被选定的下一代"（单数）—— 主代退役时提拔的就是它。 */
  sentinel: GenRef | null
  /** 其余哨兵：都是"下一代"的候选，**不服务**。 */
  others: GenRef[]
}

/**
 * ★★★ 造一份**不与任何模块级对象共享引用**的空状态。
 * ⚠️ 严禁写成常量再 `{ ...CONST }` 返回：那是**浅拷贝** ⇒ `others` 仍是**同一个数组**，
 * 于是**同一进程内所有空池共用一份 `others`**，`stand()` 会往同一个数组里追加 ⇒
 * **每多建一个 `PoolStore` 实例，别的实例就多出一份幻影条目**（实测：副本数 == 实例数）。
 *
 * ★ 为什么以前没暴露：单实例单测永远看不见它。本仓库的
 * `scripts/delegation/test-sentinel-pool.mjs` 逐用例 `new PoolStore(dir)` ⇒ 恰好把它逼出来
 * （⑤/⑥ 假红，而"单独跑同一个场景"却全绿 —— 这就是判据只报红不报"为什么红"时的隐患）。
 * ⇒ **凡是"每个实例一份"的状态，必须是【每次新建出来后赋值】，不许从共享模板浅拷贝。**
 *   同类陷阱：`lease.ts` 的 `get current()` 也直接返回**活对象**（那里目前只被只读消费，未暴露）。
 */
const freshEmpty = (): PoolState => ({ primary: null, sentinel: null, others: [] })

export class PoolStore {
  readonly file: string
  private state: PoolState

  constructor(coordDir: string) {
    this.file = join(coordDir, 'pool.json')
    mkdirSync(coordDir, { recursive: true })
    this.state = this.load()
  }

  /**
   * ★ 只读快照。**不是活的内部对象** —— 外部拿到它之后无论怎么改都不会影响本店，
   * 也不会在下次 `commit` 时"悄悄跟着变"（这正是上面 EMPTY 浅拷贝那类 bug 的温床）。
   */
  get current(): Readonly<PoolState> {
    return { primary: this.state.primary, sentinel: this.state.sentinel, others: this.state.others.slice() }
  }

  /** 幂等写：rename 原子替换（与 lease.ts 同款，避免半写文件被读到）。 */
  private commit(mut: (s: PoolState) => void): PoolState {
    mut(this.state)
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.file)
    return this.current
  }

  /**
   * ★ 立哨：新代**不服务**，只进池。
   * 「选定」的语义（用户原话"提拔那个当前哨兵**选定的**下一代哨兵"）：
   *   · `sentinel` 为空 ⇒ **它就成为被选定的那个**（下一任主代候选）；
   *   · `sentinel` 已有人 ⇒ 进 `others` 等着被选定。
   */
  stand(ref: GenRef): PoolState {
    return this.commit((s) => {
      if (s.sentinel === null) s.sentinel = ref
      else s.others.push(ref)
    })
  }

  /** 选定：把 `others` 里的某代提为 `sentinel`（原 `sentinel` 退回 `others`）。 */
  designate(gen: string): { ok: boolean; reason?: string } {
    const idx = this.state.others.findIndex((g) => g.gen === gen)
    if (idx < 0) return { ok: false, reason: `others 里没有 "${gen}"（现有：${this.state.others.map((g) => g.gen).join(', ') || '(空)'}）` }
    return this.commit((s) => {
      const [picked] = s.others.splice(idx, 1)
      if (s.sentinel) s.others.push(s.sentinel)
      s.sentinel = picked
    }), { ok: true }
  }

  /**
   * ★★ 提拔：`sentinel` ⇒ `primary`。**只能由主代退役触发**（裁决 3 / R-c）。
   * ⇒ 本函数**不判断"哪个更好"**，它只做"把已选定的那个换上去"。
   */
  promote(): { ok: boolean; next?: GenRef; reason?: string } {
    if (this.state.sentinel === null) {
      return { ok: false, reason: '池里没有"已选定的下一代"（sentinel 为空）—— 先 `?cmd=stand` 立哨' }
    }
    const next = this.state.sentinel
    this.commit((s) => {
      s.primary = next
      s.sentinel = null
    })
    return { ok: true, next }
  }

  /** 让 `primary` 与 `lease.json` 的 `activeGen` 对齐（只读派生，不在此自持真相）。 */
  syncPrimary(ref: GenRef | null): PoolState {
    return this.commit((s) => {
      s.primary = ref
    })
  }

  /** 从池里摘掉一个代（退役 / 探活失败时清理）。 */
  drop(gen: string): PoolState {
    return this.commit((s) => {
      if (s.sentinel?.gen === gen) s.sentinel = null
      s.others = s.others.filter((g) => g.gen !== gen)
    })
  }

  /**
   * ★ 清理陈旧哨兵：`alive` 返回 false 的从池里摘掉。
   * 为什么需要：`?cmd=stand` 起的代可能中途崩掉 ⇒ 池里留下"看不见的死代"
   * （与 R3 `ensureActiveLease` 同族问题）。**本函数是纯函数**，便于单测。
   */
  pruneDead(alive: (ref: GenRef) => boolean): { dropped: GenRef[]; state: PoolState } {
    const dropped: GenRef[] = []
    // ★ 每个代**只探活一次**（原实现在 sentinel 与 filter 里各调一次 ⇒ 死代被重复计入 dropped）。
    const verdict = new Map<string, boolean>()
    const once = (g: GenRef): boolean => {
      const key = g.gen + ':' + g.pid
      let v = verdict.get(key)
      if (v === undefined) {
        v = alive(g)
        verdict.set(key, v)
        if (!v) dropped.push(g)
      }
      return v
    }
    this.commit((s) => {
      if (s.sentinel && !once(s.sentinel)) s.sentinel = null
      s.others = s.others.filter(once)
    })
    return { dropped, state: this.current }
  }

  private load(): PoolState {
    if (!existsSync(this.file)) return freshEmpty()
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PoolState>
      return {
        primary: j.primary ?? null,
        sentinel: j.sentinel ?? null,
        // ★ 复制一份，不把 JSON.parse 出来的数组直接交给实例（防外部持有后互相影响）。
        others: Array.isArray(j.others) ? j.others.slice() : [],
      }
    } catch {
      return freshEmpty()
    }
  }
}
