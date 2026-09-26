/**
 * @module @dsh-brain/switchboard/preflight
 *
 * **预演体检引擎**（格⑮）：spawn 一个「预演代」→ 对它做**活实例**体检 → **杀掉丢弃**。
 *
 * ★★★ 硬不变量（INVARIANT）：**本模块永远不碰现役**
 *
 * 这不是一句口号，是**类型层面的**约束：`PreflightRunner` 的构造参数只有 `PreflightConfig`
 * 与一个 `PreflightState`（用于把最后一份报告给 `?cmd=preflight-result` 读）。它**拿不到**
 * `FrontDoor`、**拿不到** `LeaseStore`、**拿不到** `Coordinator`。所以它**在编译期就不具备**
 * 改前门 / 改租约 / 换活跃代的能力。对照 `coordinator.ts`（构造参数含 `front` 且 `swapActive`
 * 直接 `front.setActive`）——两者的能力面在类型上就是分开的。
 *
 * 为什么需要这条不变量（用户原话）：以前 DSH 装/拔插件把自己搞崩过。现有的 `?cmd=apply` 是
 * "**先 flip 再 verify**"（`coordinator.ts:430-441`）：坏插件在 `verify` 判失败**之前**就已经
 * 上过前门了。预演这条路刻意与它相反——**先验，且从头到尾不上前门**；验过了再由运维/上层决定
 * 是否换代（换代仍走既有 `apply`，本模块不复制它）。
 *
 * ★ 端口隔离：预演代端口来自 `PREFLIGHT_PORT_BASE`（默认 `GEN_PORT_BASE + 100`），与现役代的
 *   `GEN_PORT_BASE` 段**不重叠**，且经 `allocGenPort` 跳过保留端口（3101）。
 *   ⇒ 预演代与现役代可**同时**存在（这正是"与现役并行"的实现）。
 *
 * ★ 丢弃纪律：`run()` 的 `finally` 里无条件 `stop()`（spawner 的强杀闭环：SIGTERM→SIGKILL→
 *   taskkill /T /F→确证 PID 消失），并在返回后**二次确认** admin 端口不再应答。
 *   失败路径**不允许**留进程、不允许留"半个预演代"（判据 5 的"不留半途污染"）。
 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { AdminClient } from './adminclient.js'
import { spawnGen, type SpawnedGen } from './spawner.js'
import { verifyBootHealth, lastBootSegment } from './boot-health.js'
import { allocGenPort } from './coordinator.js'
import { resolveGenSpawnSpec } from './gen-assembly.js'
import { BUILD_STAMP } from './build-stamp.js'
import type {
  CheckResult,
  DiscardEvidence,
  LiveInventory,
  PreflightReport,
  PreflightRequest,
  RehearsalIdentity,
} from './preflight-contract.js'

/** 预演引擎的配置（全部来自控制面 env；**不含**任何 front/lease 句柄 —— 见 INVARIANT）。 */
export interface PreflightConfig {
  nodeBin: string
  dshBin: string
  /**
   * ★★ 2026-09-26 R1：本控制面的 `DSH_HOME`，显式下传给预演代。
   * ★ 预演代**必须**与真代同一个 home（否则"预演的不是真会发生的事"）。
   */
  dshHome: string
  /** 预演代端口基址（与现役 `GEN_PORT_BASE` 不同段）。 */
  portBase: number
  /** 预演代 admin 端口基址。 */
  adminBase: number
  /** 预演代落地目录根。 */
  workDir: string
  /** 请求未指定 profile 时的缺省（通常 = 控制面缺省 profile）。 */
  profile: string
  /**
   * ★ 「代装配清单」路径。**预演的就是它**：预演代按"下一代将会被装成的样子"起，
   * 于是"改装配前先验"验的是**真的候选装配**（同一份清单、同一个渲染器），
   * 而不是一套预演专用的近似。清单缺省 ⇒ 控制面最小集。
   */
  genAssembly?: string
  /** 透传宿主环境（**仅**清单之外的兜底项；key 池应当由清单的 envFiles 提供）。 */
  envExtra?: Record<string, string>
  /** 启动健康检查窗口（复用既有默认 6000）。 */
  bootHealthTimeoutMs?: number
  /** admin 就绪的有界等待（默认 40000，与交接的 readyTimeoutMs 同量级）。 */
  readyTimeoutMs?: number
}

/** 预演引擎的可观测状态（供 `?cmd=preflight-result` 读；单写者=引擎自身）。 */
export interface PreflightState {
  stage: 'idle' | 'rehearsing' | 'done'
  last: PreflightReport | null
}

/** PID 是否存活（signal 0 探活；EPERM=存在但无权，视为存活）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 把数组里的元素按"声明侧"顺序稳定去重（保持可读的报告顺序）。 */
function uniq(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of list) {
    const t = s.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

export class PreflightRunner {
  /** 预演代序号（只增不减；映射到端口/adminPort 段）。 */
  private counter = 0

  constructor(
    private readonly cfg: PreflightConfig,
    private readonly state: PreflightState,
  ) {}

  /**
   * 跑一次预演体检。**任何**出口（通过/拒绝/引擎异常）都已保证：预演代被强杀、PID 消失、
   * admin 不再应答。报告落盘到 `<workDir>/preflight-<gen>.json` 便于取证。
   */
  async run(req: PreflightRequest): Promise<PreflightReport> {
    const startedAt = Date.now()
    this.state.stage = 'rehearsing'

    const slot = this.counter + 1
    this.counter += 1
    const port = allocGenPort(this.cfg.portBase, slot)
    const gen = `reh-${port}`
    const adminPort = this.cfg.adminBase + slot
    const genDir = join(this.cfg.workDir, gen)
    mkdirSync(genDir, { recursive: true })

    // ★ 预演 = 用**当前代装配清单**起一个代（同一份清单、同一个渲染器 ⇒ 预演与换代同形）。
    //   与 coordinator 一样，读盘发生在此刻（不是控制面 boot）；清单坏 ⇒ 抛错，报告落 error，绝不当通过。
    const spec = resolveGenSpawnSpec({
      file: this.cfg.genAssembly,
      genPort: port,
      genDir,
      defaultProfile: this.cfg.profile,
      baseEnv: this.cfg.envExtra ?? {},
    })
    const profile = (req.profile || spec.profile).trim()

    const identity: RehearsalIdentity = { gen, port, adminPort, pid: 0, profile, genDir }
    let spawned: SpawnedGen | undefined
    const checks: CheckResult[] = []
    let verdict: PreflightReport['verdict'] = 'error'
    let reason: string | undefined

    try {
      // ── spawn 预演代：mode 固定 'staging'（它永远不是活跃代） ──
      spawned = spawnGen({
        nodeBin: this.cfg.nodeBin,
        dshBin: this.cfg.dshBin,
        profile,
        port,
        adminPort,
        // ★★ R1：预演代必须与真代**同一个 home** —— 否则"预演的不是真会发生的事"
        //   （它在别的会话库/别的装配语境里跑，判据就失去意义）。见 preflight 的 INVARIANT。
        dshHome: this.cfg.dshHome,
        gen,
        leaseToken: '',
        mode: 'staging',
        genDir,
        ...(spec.extraPatches.length + (req.patches?.length ?? 0) > 0
          ? { extraPatches: [...spec.extraPatches, ...(req.patches ?? [])] }
          : {}),
        envExtra: spec.envExtra,
      })
      identity.pid = spawned.pid
      console.log(`[switchboard:preflight] ${gen} assembly=${spec.source} profile=${profile} poolPort=${spec.poolPort ?? 'none'}`)

      const client = new AdminClient(`http://127.0.0.1:${adminPort}`)

      // ── check：admin 应答（进程真的活着，且自报身份对得上） ──
      const healthOk = await this.waitAdmin(client, spawned)
      if (healthOk.ok) {
        checks.push({
          kind: 'admin',
          name: `admin:${adminPort}`,
          ok: true,
          detail: `admin 应答 gen=${healthOk.gen} mode=${healthOk.mode} pid=${spawned.pid}`,
          actual: `gen=${healthOk.gen} mode=${healthOk.mode}`,
        })
      } else {
        checks.push({
          kind: 'admin',
          name: `admin:${adminPort}`,
          ok: false,
          detail: `admin 未就绪（${healthOk.why}）`,
          expect: `gen=${gen} mode=staging`,
          actual: healthOk.gen ? `gen=${healthOk.gen}` : '(无应答)',
        })
      }

      // ── check：启动健康（复用既有 verifier：有界等待 + 正向完成信号 + 进程死亡信号） ──
      const bootHealth = await verifyBootHealth(
        { readSegment: () => lastBootSegment(join(genDir, 'boot.log')) },
        {
          timeoutMs: this.cfg.bootHealthTimeoutMs ?? 6000,
          hasExited: () => spawned!.proc.exitCode !== null,
          isAlive: () => pidAlive(spawned!.pid),
        },
      )
      checks.push({
        kind: 'boot',
        name: `boot:${gen}`,
        ok: bootHealth.verdict === 'healthy',
        detail:
          bootHealth.verdict === 'healthy'
            ? `启动完成信号已出现（等待 ${bootHealth.waitedMs}ms / 日志 ${bootHealth.segmentLines} 行）`
            : bootHealth.verdict === 'fatal'
              ? `启动致命错误：${bootHealth.fatal.join('、')}`
              : `启动完成信号未出现（等待 ${bootHealth.waitedMs}ms / 日志 ${bootHealth.segmentLines} 行）`,
        expect: '无致命装载错误 且 出现 dsh web: http://... 完成信号',
        actual: `verdict=${bootHealth.verdict}`,
      })

      // ── check：活实例清点（plugin / tool / command） ──
      // 只有在 admin 通的时候才能读；admin 不通 ⇒ 明确记一条 red，不假装"没有插件"。
      if (healthOk.ok) {
        try {
          const inv = await client.inventory((req.timeoutMs ?? 15_000) + 5_000)
          checks.push(...this.checkInventory(inv, req))
        } catch (e) {
          checks.push({
            kind: 'plugin',
            name: 'inventory',
            ok: false,
            detail: '活实例清点失败（/admin/inventory 不可用）：' + (e instanceof Error ? e.message : String(e)),
            expect: '活实例可清点（loader/tools/commands）',
            actual: 'unavailable',
          })
        }
      } else {
        checks.push({
          kind: 'plugin',
          name: 'inventory',
          ok: false,
          detail: 'admin 未就绪 ⇒ 无法对活实例清点（不臆测为"没有插件"）',
          expect: '活实例可清点',
          actual: 'unreachable',
        })
      }

      const red = checks.filter((c) => !c.ok)
      verdict = red.length === 0 ? 'pass' : 'reject'
      if (verdict === 'reject') reason = red.map((c) => `${c.name}: ${c.detail}`).join(' | ')
    } catch (e) {
      verdict = 'error'
      reason = '预演引擎异常：' + (e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    } finally {
      // ── 丢弃（无条件）：这里失败也不能让异常逃出去，否则报告拿不到 ──
      try {
        if (spawned) await spawned.stop(1500)
      } catch {
        /* stop 自身异常下面用 pidAlive 兜底判定 */
      }
    }

    // ── 丢弃取证（在 finally 之后做，独立于上面的路径） ──
    const stoppedFlag = spawned ? spawned.proc.exitCode !== null || spawned.proc.killed : false
    const pidGone = spawned ? !pidAlive(spawned.pid) : false
    let adminDead = false
    try {
      const probe = await new AdminClient(`http://127.0.0.1:${identity.adminPort}`).health(1500)
      adminDead = probe === null
    } catch {
      adminDead = true
    }
    const discarded: DiscardEvidence = { stopped: stoppedFlag, pidGone, adminDead }

    const report: PreflightReport = {
      verdict,
      rehearsal: identity,
      checks,
      discarded,
      startedAt,
      finishedAt: Date.now(),
      build: BUILD_STAMP,
    }
    if (reason) report.reason = reason
    // 丢弃不干净 ⇒ 结论**不得**是 pass（这是判据 5「不留半途污染」的内建护栏）。
    if (verdict === 'pass' && !(pidGone && adminDead)) {
      report.verdict = 'reject'
      report.reason = `预演通过但丢弃不干净（pidGone=${pidGone} adminDead=${adminDead}）⇒ 判 reject（不留半途污染）`
    }

    this.state.last = report
    this.state.stage = 'done'
    try {
      writeFileSync(join(this.cfg.workDir, `preflight-${identity.gen}.json`), JSON.stringify(report, null, 2), 'utf8')
    } catch {
      /* 报告落盘失败不影响结论（结论已在内存里返回） */
    }
    return report
  }

  /** 有界等待 admin 就绪；进程死亡立即早退（不空等）。 */
  private async waitAdmin(
    client: AdminClient,
    spawned: SpawnedGen,
  ): Promise<{ ok: boolean; gen?: string; mode?: string; why?: string }> {
    const deadline = Date.now() + (this.cfg.readyTimeoutMs ?? 40_000)
    for (;;) {
      if (spawned.proc.exitCode !== null || !pidAlive(spawned.pid)) {
        return { ok: false, why: `进程已退出（exitCode=${spawned.proc.exitCode}）` }
      }
      const h = await client.health(3000)
      if (h && typeof h.gen === 'string' && h.gen.length > 0) {
        return { ok: true, gen: h.gen, mode: String(h.mode) }
      }
      if (Date.now() > deadline) return { ok: false, why: '等待超时' }
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  /**
   * 把「声明侧的清单」与「活实例的清点」对账，产出 plugin/tool/command 三类体检项。
   *
   * ★ 方向性：**只查"声明的物到了没有"**（声明 ⊆ 实测）。反方向（实测里有声明外的插件）
   *   **不**判 red —— 因为一个 profile 本来就会装配大量"没被声明"的框架插件，
   *   把它们判红等于让判据永远红。这与"清单是候选装配意图"的语义一致。
   *
   * ★ 缺清单（manifest 为空）⇒ 只报一条**中性**的 plugin 项说明"本次没给清单"，
   *   而不是假装通过（否则"我没查"与"查过没问题"同形）。
   */
  private checkInventory(inv: LiveInventory, req: PreflightRequest): CheckResult[] {
    const out: CheckResult[] = []
    const man = req.manifest ?? {}
    const plugins = uniq(man.plugins ?? [])
    const tools = uniq(man.tools ?? [])
    const commands = uniq(man.commands ?? [])

    // build stamp 对账：两端不同 ⇒ 本次"活实例读数"来自另一份代码，必须当场可见。
    const buildMismatch = !!inv.build && inv.build !== BUILD_STAMP

    if (plugins.length === 0 && tools.length === 0 && commands.length === 0) {
      out.push({
        kind: 'plugin',
        name: 'manifest',
        ok: true,
        detail:
          `本次未给声明清单 ⇒ 只验结构（活实例报 ${inv.plugins.length} 个 loader 条目 / ` +
          `${inv.tools.length} 个工具 / ${inv.commands.length} 个命令）。` +
          `注意：这不等于"插件都对"，只等于"没声明要查什么"。`,
        actual: `plugins=${inv.plugins.length} tools=${inv.tools.length} commands=${inv.commands.length}`,
      })
    }

    // ── plugin：存在 + enabled + phase=active ──
    for (const id of plugins) {
      const hit = inv.plugins.find((p) => p.id === id)
      if (!hit) {
        out.push({
          kind: 'plugin',
          name: `plugin:${id}`,
          ok: false,
          detail: `声明要装配的插件在活实例的 Loader 树里**不存在**`,
          expect: '存在且 enabled 且 phase=active',
          actual: 'missing',
        })
        continue
      }
      const ok = hit.enabled && hit.phase === 'active'
      out.push({
        kind: 'plugin',
        name: `plugin:${id}`,
        ok,
        detail: ok
          ? `活实例 Loader 条目 phase=active（module=${hit.module || '?'}）`
          : `Loader 条目存在但未达 active：enabled=${hit.enabled} phase=${hit.phase ?? 'null'}`,
        expect: 'enabled=true 且 phase=active',
        actual: `enabled=${hit.enabled} phase=${hit.phase ?? 'null'}`,
      })
    }

    // ── tool：出现在模型面工具表（ctx.tools.schemas()）──
    // 活实例的 tools 若"观测不到"（unavailable）⇒ 判 red（观测不到 ≠ 没问题）。
    const toolsUnavailable = inv.unavailable?.tools
    for (const name of tools) {
      if (toolsUnavailable) {
        out.push({
          kind: 'tool',
          name: `tool:${name}`,
          ok: false,
          detail: `工具面观测不到（tools ${toolsUnavailable}）⇒ 无法证明它存在`,
          expect: '出现在 ctx.tools.schemas() 的模型面工具表里',
          actual: 'unobservable',
        })
        continue
      }
      const ok = inv.tools.includes(name)
      out.push({
        kind: 'tool',
        name: `tool:${name}`,
        ok,
        detail: ok
          ? `出现在活实例模型面工具表里（本代共 ${inv.tools.length} 个工具）`
          : `**不在**活实例模型面工具表里（本代 ${inv.tools.length} 个工具：${inv.tools.slice(0, 12).join(',')}${inv.tools.length > 12 ? '…' : ''}）`,
        expect: '在 ctx.tools.schemas() 中',
        actual: ok ? 'present' : 'absent',
      })
    }

    // ── command：出现在 host 命令注册表 ──
    const cmdUnavailable = inv.unavailable?.commands
    for (const name of commands) {
      if (cmdUnavailable) {
        out.push({
          kind: 'command',
          name: `command:${name}`,
          ok: false,
          detail: `命令表观测不到（commands ${cmdUnavailable}）⇒ 无法证明它存在`,
          expect: '出现在 ctx.commands.list() 里',
          actual: 'unobservable',
        })
        continue
      }
      const ok = inv.commands.includes(name)
      out.push({
        kind: 'command',
        name: `command:${name}`,
        ok,
        detail: ok ? `出现在活实例命令注册表里（本代共 ${inv.commands.length} 条）` : `**不在**活实例命令注册表里（本代 ${inv.commands.length} 条）`,
        expect: '在 ctx.commands.list() 中',
        actual: ok ? 'present' : 'absent',
      })
    }

    // 两端代码身份不一致 ⇒ 追加一条显式 red（防止"改了没生效"被误读成通过）。
    if (buildMismatch) {
      out.push({
        kind: 'plugin',
        name: 'build-stamp',
        ok: false,
        detail: `预演代与控制面的代码身份戳不一致 ⇒ 本次活实例读数来自另一份代码`,
        expect: BUILD_STAMP,
        actual: inv.build,
      })
    } else if (inv.build) {
      out.push({ kind: 'plugin', name: 'build-stamp', ok: true, detail: `两端代码身份戳一致（${inv.build}）`, actual: inv.build })
    }

    return out
  }
}

/** 便捷：只看报告里有没有 red（面板/上层判断用）。 */
export function hasRed(report: PreflightReport): boolean {
  return report.checks.some((c) => !c.ok)
}

/** 报告落盘路径（与 `run()` 实际写入保持一致；供上层读取）。 */
export function reportPath(workDir: string, gen: string): string {
  return join(workDir, `preflight-${gen}.json`)
}
