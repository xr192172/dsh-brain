#!/usr/bin/env node
/**
 * @module @dsh-brain/switchboard/main
 *
 * 脑代际蓝绿交接控制面入口。职责：
 *  1. 读 env 契约，组装 CoordinatorConfig。
 *  2. spawn 初始 active gen A（bootstrap），把前门 3080 指到 A。
 *  3. 起 Switchboard 自身 admin（SWITCH_ADMIN_PORT）接收交接命令。
 *  4. 周期为 active gen 续租约（心跳）。
 *
 * env 契约：
 *   SWITCH_ADDR         前门绑定，默认 `127.0.0.1:3080`
 *   SWITCH_ADMIN_PORT   控制面 admin，默认 31800
 *   GEN_PORT_BASE       代端口基址，默认 3081
 *   HANDOVER_ADMIN_PORT_BASE 代内 handover-agent admin 基址，默认 31810
 *   DSH_HOME           （默认 %USERPROFILE%/.dsh）
 *   WORK_DIR            工作目录（协调+gen 底座），默认 {DSH_HOME}/switchboard。
 *                       ★ R1.5：它必须落在 DSH_HOME 之下，否则**拒绝启动**（会话与协调状态会分家）。
 *                       确要分开摆 ⇒ 显式设 ALLOW_SPLIT_WORK_DIR=1（会警告留痕）。
 *   WEB_PROFILE         ★ **控制剖面**：控制面自己的最小集所钉的那个 dsh profile（默认 web）。
 *                       ★ 它**不再**是"代的装配"：代跑哪个剖面由「代装配清单」的 `profile` 声明
 *                       （清单没声明才回落到这里）。见 `gen-assembly.ts` / `docs/gen-assembly.md`。
 *   GEN_ASSEMBLY        ★ 「代装配清单」JSON 的路径（默认 {WORK_DIR}/gen-assembly.json）。
 *                       **模型接入 / key 池住在这里**——控制面每次 spawn 一个代都重读它。
 *                       ⇒ 改模型/key/provider/pool 只需**换代**，不需要重启控制面。
 *                       未配置/文件不存在 ⇒ 控制面最小集：能启动、能换代，但没有模型接入。
 *   DSH_BIN             dsh lib/bin.js
 *   NODE_BIN            node 可执行
 *   （已移除）GEN_ENV_EXTRA —— 曾经把 key 池装进**控制面进程的 env**；现在归装配清单。
 */
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { FrontDoor } from './proxy.js'
import { Coordinator, allocGenPort, type CoordinatorConfig } from './coordinator.js'
import { AdminClient } from './adminclient.js'
import { spawnGen } from './spawner.js'
import { PreflightRunner, type PreflightConfig, type PreflightState } from './preflight.js'
import * as mgmt from './mgmt.js'
import type { PreflightManifest } from './preflight-contract.js'
import { resolveGenSpawnSpec, projectAssembly } from './gen-assembly.js'
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

/**
 * `?cmd=assembly` 里探的"模型接入相关环境变量名"。
 * 控制面**应当一个都不命中**：key 池/凭据归「代装配清单」（`GEN_ASSEMBLY`）声明的 env 文件，
 * 由每个代自己去读。命中任何一个 ⇒ 模型接入又漏回控制面了。
 * 含 `GEN_ENV_EXTRA`：它是旧装配路径的入口，留着探是为了让"回退"当场可见（而不是静默复活）。
 */
const MODEL_ENV_PROBES = [
  'GEN_ENV_EXTRA',
  'AGENTSHELL_MAIN_LLM_API_KEYS',
  'AGENTSHELL_MAIN_LLM_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
]

function envStr(k: string, d: string): string {
  return process.env[k] || d
}
function envInt(k: string, d: number): number {
  const v = process.env[k]
  return v && /^\d+$/.test(v) ? Number(v) : d
}

/**
 * ★★★ 2026-09-26 R1.5：控制面自己的**摆放**（placement）—— 四个必须同源的值。
 *
 * 为什么要有这个函数（而不是像以前那样在 config 字面量里各自 `envStr` 推默认值）：
 *   原来 `coordDir` / `workDir` / `genAssembly` 三个**各自**以 `home` 为默认值，
 *   且 `envStr('WORK_DIR')` 被求值 **3 次**。⇒ "四个值一致"靠的是**没人设过 `WORK_DIR`**；
 *   一旦有人设了指向别处的 `WORK_DIR`，就会出现
 *     会话在 `<home>/sessions/`、租约/台账/boot.log 在 `WORK_DIR`
 *   的**分裂态**，而两边各自都"正常"（沉默，最难查）。
 *   ⇒ 这里把它变成**被检查的约束**：单一求值点 + 分裂则拒启动（可显式豁免）+ 打印指纹。
 *
 * ★ `ALLOW_SPLIT_WORK_DIR=1` 的立场：**默认禁止静默分裂**。逃生阀只给"我知道我在干什么"的
 *   专家用，而且**必须在日志里留痕**（同门的先例：`isolated-instance --force` 就是从"逃生阀"
 *   长成旁路的 ⇒ 这个阀要被审计，不能无声）。
 */
export function resolvePlacement(home: string): {
  home: string
  coordDir: string
  workDir: string
  genAssembly: string
} {
  const defBase = join(home, 'switchboard')
  // ★ 单一求值点：`WORK_DIR` 全文件只在这里读一次。
  const workDirBase = envStr('WORK_DIR', defBase)
  const splitEnv = process.env.WORK_DIR
  // 显式设了 WORK_DIR 且**不落在 home 之下** ⇒ 会话与协调状态会分家 ⇒ 默认拒启动。
  const isSplit =
    splitEnv !== undefined &&
    splitEnv !== '' &&
    !isUnder(workDirBase, home)
  if (isSplit && process.env.ALLOW_SPLIT_WORK_DIR !== '1') {
    console.error(
      `[switchboard] ★★ 摆放不一致，拒绝启动：\n` +
        `    DSH_HOME = ${home}\n` +
        `    WORK_DIR = ${workDirBase}\n` +
        `  ⇒ 会话落在 DSH_HOME/sessions/，而租约/台账/boot.log 落在 WORK_DIR\n` +
        `  ⇒ "代的数据与日志分家"（两边各自都正常 ⇒ 沉默的最坏形态）。\n` +
        `  如你确实要这样摆，请显式设 ALLOW_SPLIT_WORK_DIR=1（会在日志里留痕）。\n` +
        `  设计依据：docs/r1.5-placement-shadow-dependency-design-2026-09-26.md`,
    )
    process.exit(1)
  }
  if (isSplit) {
    console.warn(
      `[switchboard] ★ 提醒：ALLOW_SPLIT_WORK_DIR=1 生效 —— WORK_DIR(${workDirBase}) 不在 DSH_HOME(${home}) 之下。`,
    )
  }
  const genAssembly = envStr('GEN_ASSEMBLY', join(workDirBase, 'gen-assembly.json'))
  // ★ 指纹：让"这代到底看的哪份 home/workDir"**不再靠推**（铁律 12/15：读数要有效）。
  console.log(
    `[switchboard] placement: home=${home} workDir=${workDirBase} genAssembly=${genAssembly}`,
  )
  return { home, coordDir: workDirBase, workDir: workDirBase, genAssembly }
}

/** `child` 是否落在 `parent` 之下（含相等）。用于判断 WORK_DIR 是否与 home 同源。 */
export function isUnder(child: string, parent: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + '/')
}

function boot(config: CoordinatorConfig): void {
  const front = new FrontDoor()

  // bootstrap：spawn 初始 active gen A
  // ★ 2026-09-21 修（回执 §A3）：bootstrap 代原先写死 `portBase + 1`，**绕过了保留端口跳号**
  //   ⇒ 只要 `GEN_PORT_BASE=3100`，bootstrap 代就是 **3101**（= key-pool-proxy 的保留端口）
  //   ⇒ **栈直接起不来，且无任何保护**。而 handover 代早就走 `allocGenPort` 了（`coordinator.ts:296`）
  //   ⇒ **两条路径的"端口→代"映射必须一致**，所以这里也走同一个函数（slot 1 = bootstrap 代）。
  //   实测依据：`scripts/test-gen-port-alloc.mjs` 已扫 slot 1..60（含 slot 1），
  //   并带红向用例（"把朴素分配喂进去必须报 3101 —— 否则这道门只是句口号"）。
  const port = allocGenPort(config.portBase, 1)
  const genId = 'gen-' + String(port)
  const adminPort = config.adminBase + 1
  const genDir = join(config.workDir, genId)
  const nodeBin = config.nodeBin
  // ★ bootstrap 代与换代代走**同一条**装配路径：都从「代装配清单」读。
  //   否则"控制面启动时装配什么"又会对清单免疫 —— 那正是本层要拆掉的东西（gen-assembly INV-B）。
  const bootSpec = resolveGenSpawnSpec({
    file: config.genAssembly,
    genPort: port,
    genDir,
    defaultProfile: config.profile,
    baseEnv: {},
  })
  console.log(
    `[switchboard] gen assembly: source=${bootSpec.source} profile=${bootSpec.profile} poolPort=${bootSpec.poolPort ?? 'none'} ` +
      `patches=${bootSpec.extraPatches.length} envKeys=${Object.keys(bootSpec.envExtra).length}`,
  )
  const spawnedA = spawnGen({
    nodeBin,
    dshBin: config.dshBin,
    profile: bootSpec.profile,
    port,
    adminPort,
    // ★★ R1：bootstrap 代与换代代走**同一条**契约 —— 显式传 home，不靠继承。
    dshHome: config.dshHome,
    gen: genId,
    leaseToken: '', // A 启动即 active，token 在首次 grant 时定
    mode: 'active',
    genDir,
    extraPatches: bootSpec.extraPatches,
    envExtra: bootSpec.envExtra,
    inspectPort: config.inspectPortBase ? config.inspectPortBase + (port - config.portBase) : undefined,
  })
  const activeCage = {
    inst: {
      id: genId,
      gen: genId,
      port,
      adminPort,
      pid: spawnedA.pid,
      role: 'active' as const,
      state: 'active' as const,
      lastHeartbeat: Date.now(),
      caughtUpSeq: 0,
    },
    spawned: spawnedA,
    client: new AdminClient(`http://127.0.0.1:${adminPort}`),
  }

  const coord = new Coordinator(config, front, activeCage)

  // ── 预演体检通道（格⑮）：候选装配的"先验后换"通道 ─────────────────────────────
  // 它的能力面**只够**spawn 一个临时代并读它 —— 见 preflight.ts 的 INVARIANT（构造参数里
  // 没有 front/lease/coordinator，类型上就改不了现役）。
  // 端口段刻意错开：PREFLIGHT_PORT_BASE 默认 = GEN_PORT_BASE + 100 ⇒ 预演代与现役代可并行共存。
  const preflightCfg: PreflightConfig = {
    nodeBin: config.nodeBin,
    dshBin: config.dshBin,
    // ★★ R1：预演代与控制面的真代**同一个 home**。
    dshHome: config.dshHome,
    portBase: envInt('PREFLIGHT_PORT_BASE', config.portBase + 100),
    adminBase: envInt('PREFLIGHT_ADMIN_PORT_BASE', config.adminBase + 100),
    // 预演代的落地目录单独一层：与活跃代的 gen 目录分开，便于取证与清理。
    workDir: envStr('PREFLIGHT_WORK_DIR', join(config.workDir, 'preflight')),
    profile: config.profile,
    // ★ 预演的就是「代装配清单」——与换代共用同一份清单与同一个渲染器（"改装配前先验"）。
    genAssembly: config.genAssembly,
    bootHealthTimeoutMs: config.bootHealthTimeoutMs,
    readyTimeoutMs: config.readyTimeoutMs,
  }
  const preflightState: PreflightState = { stage: 'idle', last: null }
  const preflight = new PreflightRunner(preflightCfg, preflightState)

  /**
   * 解析 `?cmd=preflight` 的声明清单（`plugins=a,b` / `tools=x,y` / `commands=p,q`）。
   * 空串 ⇒ 该项不声明（**不**等价于"声明为空" —— 见 preflight.ts 的 checkInventory 说明）。
   */
  const manifestFrom = (url: URL): PreflightManifest => {
    const split = (k: string): string[] =>
      (url.searchParams.get(k) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    const m: PreflightManifest = {}
    const p = split('plugins')
    const t = split('tools')
    const c = split('commands')
    if (p.length) m.plugins = p
    if (t.length) m.tools = t
    if (c.length) m.commands = c
    return m
  }

  // 崩溃恢复：仅当 lease 指向的代"进程已死"才清空 lease（新 bootstrap 代 pid 刚 spawn 必然存活，不受影响）。
  // 用 pid 存活判定，而非 admin 端口响应度——避免"刚 grant 的代 admin 尚未起来就误判为 stale"的竞态。
  const staleLease = coord.getLease().current
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  if (staleLease.generation > 0 && staleLease.activeGen.pid > 0) {
    if (!pidAlive(staleLease.activeGen.pid)) {
      console.error(
        `[switchboard] stale lease detected: gen=${staleLease.activeGen.gen} port=${staleLease.activeGen.port} pid=${staleLease.activeGen.pid} is dead — clearing lease`,
      )
      coord.getLease().clear()
    } else {
      console.log(
        `[switchboard] lease recovery OK: gen=${staleLease.activeGen.gen} port=${staleLease.activeGen.port} pid=${staleLease.activeGen.pid} alive`,
      )
    }
  }
  // 恢复后确保 bootstrap 活跃代持有租约（热重启时磁盘 lease 可能被 clear，需重新授予活跃代）
  coord.ensureActiveLease()

  // 前门 3080
  const host = envStr('SWITCH_HOST', '127.0.0.1')
  const switchPort = envInt('SWITCH_PORT', 3080)
  const server = createServer()
  front.attach(server)
  server.listen(switchPort, host, () => {
    console.log(`[switchboard] front door http://${host}:${switchPort} -> gen A :${port}`)
  })

  // 控制面 admin（交接命令）
  const adminPortSwitch = envInt('SWITCH_ADMIN_PORT', 31800)
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const cmd = url.searchParams.get('cmd') ?? 'health'
    res.setHeader('content-type', 'application/json')
    if (cmd === 'handover' || cmd === 'apply' || cmd === 'restart') {
      // apply = 蓝绿部署闭环：P0 内容已落盘 → 控制面 spawn 新代 → 追平 → 冻结 → 翻转 → 验证 → 失败回滚
      // 可选 `&profile=<name>`：指定 staging 代运行的脑 profile（接入 three-brain/sandbox 代际，默认为 web）
      // 可选 `&fail=spawn|catchup|freeze`：注入确定性失败，触发 abort（验证失败自证+强杀闭环，不真崩 staging）
      // 可选 `&fast=1` 或 `cmd=restart`：快速换代 —— 跳过 defer(默认 20s)/verify-gate/稳定观察窗，
      //   保留 probe + 启动健康检查 + 失败回滚。用于日常插件业务代码改动
      //   （判据与三级替换策略见 docs/handover-vs-restart.md）。
      // 立即确认：handover 可能含 defer（等活跃代收尾，秒级~20s+），阻塞到这个结果会拖爆调用方（如 tool_apply 15s 超时）。
      // → 先回 stage=started，后台异步执行，最终结果落 state.jsonl / ?cmd=result 供轮询。
      const fast = cmd === 'restart' || url.searchParams.get('fast') === '1'
      // ★ 不再报"profile: web"这种硬编码缺省（它已经不代表实际装配）：
      //   实际生效的剖面由「代装配清单」决定 —— 要读确切值请查 `?cmd=assembly`。
      res.end(
        JSON.stringify({
          ok: true,
          cmd,
          stage: 'started',
          fast,
          profileOverride: url.searchParams.get('profile') ?? null,
          ctrlProfile: config.profile,
        }),
      )
      void coord.handover(url.searchParams.get('fail') ?? undefined, url.searchParams.get('profile') ?? undefined, url.searchParams.get('kernel') ?? undefined, url.searchParams.get('verify') ?? undefined, fast).catch((e) =>
        console.error('[switchboard] handover error:', e instanceof Error ? e.message : String(e)),
      )
    } else if (cmd === 'assembly') {
      // ★ 只读投影：「控制面自己装了什么」+「下一代会被装成什么」。
      // 这条命令存在的理由：判据"控制面的 profile 不再装配 key-pool-proxy"必须能被**执行**出来核对，
      // 而不是靠人读配置文件。它本身不 spawn / 不写盘 / 不改状态。
      //   · ctrlProfile          = 控制面启动最小集里钉的那个 profile
      //   · assemblyPresent=false = 控制面此刻以**最小集**运行（没有模型接入也照样活着）
      //   · probeGenPort/probePoolPort = 下一代将拿到的端口与池口
      //   · overlayPreview       = 下一代会被叠加的 `--patch` 内容（模型/provider/池都在这）
      try {
        const probeGenPort = allocGenPort(config.portBase, coord.nextSlot)
        const proj = projectAssembly({ file: config.genAssembly, ctrlProfile: config.profile, probeGenPort })
        // ★ 运行时事实（不是读配置文件）：**控制面自己的进程 env 里有没有模型接入的名字**。
        //   空数组 = 控制面启动所需的最小集里不含 key/池（判据 1 的运行时那一半）。
        //   只报**变量名**，不报任何值。
        res.end(
          JSON.stringify({
            ok: true,
            ...proj,
            controlPlaneEnvHit: MODEL_ENV_PROBES.filter((k) => !!process.env[k]),
          }),
        )
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      }
    } else if (cmd === 'mgmt') {
      // ★★ 2026-09-25：**控制面当 DSH 的管理面**。
      //   用户：*"我只需要点在桌面启动这个蓝绿面板，然后你就可以通过这个蓝绿面板去**绕过这个 Shell**，
      //   毕竟它**已经是个长服务**了，去绕过这个 Shell 去用这个蓝绿面板去**管理这个 DSH**。"*
      //   ★ 安全三前提见 `mgmt.ts`：**具名动作白名单 / 参数先校验 / 绝不经 shell（spawn 数组）**。
      const wt = process.cwd()
      const V = mgmt.validate(url, wt)
      if (!V.ok) {
        res.end(JSON.stringify({ ok: false, cmd: 'mgmt', error: V.reason }))
      } else if (V.v.action === 'result') {
        const f = join(mgmt.mgmtDir(wt), `${V.v.runId}.json`)
        res.end(
          existsSync(f)
            ? readFileSync(f, 'utf8')
            : JSON.stringify({ ok: false, stage: 'missing', runId: V.v.runId, error: '还没有这个 runId 的结果（或尚未落盘）' }),
        )
      } else if (V.v.action === 'experiment') {
        // ★ 长任务 ⇒ **立即回 started + runId**（与 handover / preflight 同款），结果落文件供轮询
        const runId = `${V.v.task}-${Date.now()}`
        const dir = mgmt.mgmtDir(wt)
        try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }
        writeFileSync(
          join(dir, `${runId}.json`),
          JSON.stringify({ ok: true, stage: 'running', task: V.v.task, arm: V.v.arm, runId, startedAt: new Date().toISOString() }, null, 2),
          'utf8',
        )
        res.end(JSON.stringify({ ok: true, cmd: 'mgmt', action: 'experiment', stage: 'started', runId }))
        void (async () => {
          const r = mgmt.execAction(V.v as mgmt.Validated, wt, process.execPath)
          writeFileSync(
            join(dir, `${runId}.json`),
            JSON.stringify(
              { ok: r.code === 0, stage: 'done', task: V.v.task, arm: V.v.arm, runId, code: r.code, stdout: r.stdout.slice(-20000), stderr: r.stderr.slice(-4000) },
              null,
              2,
            ),
            'utf8',
          )
        })()
      } else {
        const r = mgmt.execAction(V.v, wt, process.execPath)
        res.end(JSON.stringify({ ok: r.code === 0, cmd: 'mgmt', action: V.v.action, code: r.code, stdout: r.stdout.slice(-20000), stderr: r.stderr.slice(-4000) }))
      }
    } else if (cmd === 'status') {
      const lease = coord.getLease()
      res.end(JSON.stringify({ ok: true, stage: coord.stageName, result: coord.lastHandoverResult, lease: lease?.current, locked: coord.switchLocked }))
    } else if (cmd === 'preflight') {
      // 预演体检（格⑮）：装/拔插件后先在一个**预演代**上验证它能跑，确认了再换代；
      // 不通过就丢弃，现役不受影响。
      //   · `&profile=<名>`  预演代要跑的候选装配底座（缺省=控制面缺省 profile）
      //   · `&patch=<abs>`   候选装配的 overlay 叠加层（**可重复**；= dsh 的 `--patch`）
      //   · `&plugins=a,b`   声明要装配的 loader 条目 id
      //   · `&tools=x,y`     声明要出现在模型面工具表里的工具名
      //   · `&commands=p,q`  声明要注册的 host 命令名
      // 与 apply 同款：**立即回 started**，后台跑完写结果（预演含 spawn+启动健康+清点，
      // 秒级，但阻塞调用方没意义），用 `?cmd=preflight-result` 轮询报告。
      res.end(
        JSON.stringify({
          ok: true,
          cmd: 'preflight',
          stage: 'started',
          profile: url.searchParams.get('profile') ?? preflightCfg.profile,
        }),
      )
      const req = {
        profile: url.searchParams.get('profile') ?? preflightCfg.profile,
        patches: url.searchParams.getAll('patch').filter(Boolean),
        manifest: manifestFrom(url),
        timeoutMs: Number(url.searchParams.get('timeout') ?? 15_000) || 15_000,
      }
      void preflight.run(req).catch((e) => {
        console.error('[switchboard] preflight error:', e instanceof Error ? e.message : String(e))
        preflightState.stage = 'done'
      })
    } else if (cmd === 'preflight-result') {
      res.end(JSON.stringify({ ok: true, stage: preflightState.stage, report: preflightState.last }))
    } else if (cmd === 'result') {
      res.end(JSON.stringify({ ok: true, result: coord.lastHandoverResult }))
    } else if (cmd === 'flow') {
      // 交接阶段流水：读 state.jsonl（{t,stage,gen,note} 逐行），返回按时间排序的流水。
      // 这是进化脑(控制面)管控整条流程的投影数据源，供面板/脚本轮询。
      const rows: unknown[] = []
      const stateFile = join(config.coordDir, 'state.jsonl')
      try {
        const raw = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : ''
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            rows.push(JSON.parse(line))
          } catch {
            /* skip malformed */
          }
        }
      } catch {
        /* 读失败返回空流水 */
      }
      res.end(JSON.stringify({ ok: true, coordDir: config.coordDir, rows }))
    } else if (cmd === 'panel') {
      // 只读投影面板：把 state.jsonl 流水 + 代际/运行态投影成轻量 HTML dashboard。
      // 数据全部来自本机 JSON 接口，不新增外部依赖。
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(panelHtml)
    } else if (cmd === 'fail') {
      res.end(JSON.stringify({ ok: true, note: 'manual fail injection accepted' }))
    } else {
      res.end(JSON.stringify({ ok: true, stage: coord.stageName }))
    }
  }).listen(adminPortSwitch, '127.0.0.1', () => {
    console.log(`[switchboard] control admin http://127.0.0.1:${adminPortSwitch}`)
  })

  // 心跳续约：持有写租约时按当前 token 续期
  const ttl = config.ttlMs
  setInterval(() => {
    const cur = coord.getLease()
    if (cur?.isHeld()) cur.heartbeat(cur.current.writerToken, ttl)
  }, Math.max(500, ttl / 4))
}

if (isMain) {
  const home = envStr('DSH_HOME', join(homedir(), '.dsh'))
  const nodeBin = envStr('NODE_BIN', join(process.cwd(), '.tools', 'node', 'node.exe'))
  const dshBin = envStr('DSH_BIN', join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  // 控制面必须存活：单个坏请求/上游错误不得击穿 3080（此处记录并继续）
  process.on('uncaughtException', (e) => console.error('[switchboard] uncaughtException:', e?.message))
  process.on('unhandledRejection', (e) => console.error('[switchboard] unhandledRejection:', String((e as Error)?.message ?? e)))

  // ★★★ 2026-09-26 R1.5：**摆放（placement）必须同源**。
  //   四个值（home / coordDir / workDir / genAssembly）原来**各自**从 home 推默认值，
  //   且 `envStr('WORK_DIR')` 被求值 3 次 ⇒ "今天一致"靠的是**没人设过 `WORK_DIR`**，不是约束。
  //   一旦有人设了指向别处的 `WORK_DIR`：会话在 `<home>/sessions/`，而租约/台账/boot.log 在
  //   `WORK_DIR` ⇒ **数据与日志分家**，且两边各自都"正常"（沉默的最坏形态）。
  //   ⇒ 这里做三件事：① 单一求值点 ② 分裂则**拒启动**（可显式豁免）③ 打印四值指纹。
  //   详见 docs/r1.5-placement-shadow-dependency-design-2026-09-26.md
  const placement = resolvePlacement(home)

  const config: CoordinatorConfig = {
    nodeBin: existsSync(nodeBin) ? nodeBin : join(homedir(), '.dsh', '.tools', 'node', 'node.exe'),
    dshBin,
    profile: envStr('WEB_PROFILE', 'web'),
    portBase: envInt('GEN_PORT_BASE', 3081),
    adminBase: envInt('HANDOVER_ADMIN_PORT_BASE', 31810),
    // ★★ R1：控制面自己的 home，显式下传（原来是"靠继承 process.env"）。
    //   ★ 与 workDir 同源（R1.5 起由 resolvePlacement 保证，见上）⇒ 换训练场时
    //     四个值**一起换**，不会出现"代的数据与日志分家"。
    dshHome: placement.home,
    inspectPortBase: envInt('SWITCH_INSPECT_PORT_BASE', 32810),
    coordDir: placement.coordDir,
    workDir: placement.workDir,
    // ★ 模型接入/key 池的**唯一入口**：一份清单文件。控制面自己不持有它。
    genAssembly: placement.genAssembly,
    ttlMs: envInt('SWITCH_LEASE_TTL_MS', 10_000),
    readyTimeoutMs: envInt('SWITCH_READY_TIMEOUT_MS', 40_000),
    freezeTimeoutMs: envInt('SWITCH_FREEZE_TIMEOUT_MS', 20_000),
    // 旧代 flip 后多存活 30s：DSH 在优雅停机时 flush 全部 live 会话（write-behind 200ms），
    // 足够长即保证"先落盘再换"，避免在途未提交的会话被强杀带走。
    retainMs: envInt('SWITCH_RETAIN_MS', 30_000),
    deferMs: envInt('SWITCH_DEFER_MS', 20_000),
    // verify 稳定观察窗口（ms）：flip 后再稳 2s 并二次探测，拦"probe 假 ok、稍后崩"的假成功
    verifyStableMs: envInt('SWITCH_VERIFY_STABLE_MS', 2_000),
    // 启动健康检查有界等待窗口（ms，默认 6s）：boot.log 是跨进程异步产物，崩溃文本可能
    // 比 flip 晚数百 ms 才落盘（gen-3083 实测 637ms；崩溃本身 3.4s）⇒ 必须轮询重读，
    // 直到出现正向完成信号 / 命中致命模式 / 窗口耗尽。**fast 模式同样适用。**
    bootHealthTimeoutMs: envInt('SWITCH_BOOT_HEALTH_TIMEOUT_MS', 6_000),
    // 可选验证闸（自进化·实验脑）：verifyCmd 非空则 staging 须跑该命令且 ok 才 flip。
    ...(envStr('VERIFY_CMD', '') ? { verifyCmd: envStr('VERIFY_CMD', '') } : {}),
    // 安全白名单：VERIFY_ALLOW=<path1>;<path2>...（verifyCmd 脚本须落在其中某目录前缀内）
    verifyAllowList: envStr('VERIFY_ALLOW', '')
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    verifyTimeoutMs: envInt('VERIFY_TIMEOUT_MS', 120_000),
    ...(envStr('VERIFY_CWD', '') ? { verifyCwd: envStr('VERIFY_CWD', '') } : {}),
    // 交接后自动续接：flip+verify 稳定后，coordin 串行向新代补发 session.prompt，web 会话自动续跑。
    // SWITCH_REISSUE_MS=0 可关闭（保留"需手动再发"的旧行为）。
    reissueMs: envInt('SWITCH_REISSUE_MS', 800),
    ...(envStr('SWITCH_RESUME_PROMPT', '') ? { resumePromptText: envStr('SWITCH_RESUME_PROMPT', '') } : {}),
  }
  boot(config)
}

/** 只读投影面板 HTML（自包含，无外部依赖）。数据来自同源 admin 接口。 */
const panelHtml = `<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 三脑 · 交接投影</title>
<style>
  :root{--bg:#0f1420;--card:#171d2e;--line:#26304a;--fg:#e6eaf3;--mut:#8b95ad;
    --ok:#34d399;--run:#60a5fa;--warn:#fbbf24;--bad:#f87171;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);
    font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:24px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:var(--mut);margin-bottom:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
  .card .lbl{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .card .val{font-size:20px;font-weight:700;margin-top:4px}
  .chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
  .ok{background:#06251b;color:var(--ok);border:1px solid var(--ok)}
  .run{background:#0c2540;color:var(--run);border:1px solid var(--run)}
  .warn{background:#2a2006;color:var(--warn);border:1px solid var(--warn)}
  .bad{background:#2a0f0f;color:var(--bad);border:1px solid var(--bad)}
  .idle{background:#151b2b;color:var(--mut);border:1px solid var(--line)}
  .stages{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}
  .stage{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;color:var(--mut)}
  .stage.cur{border-color:var(--run);color:var(--fg);font-weight:700}
  .stage.done{border-color:var(--ok);color:var(--ok)}
  table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:6px 8px;
    border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
  th{color:var(--mut);font-weight:600} .mono{font-size:12px} .dim{color:var(--mut)} .nowrap{white-space:nowrap}
  .err{color:var(--bad);padding:12px;border:1px solid var(--bad);border-radius:8px;margin:12px 0}
  footer{color:var(--mut);font-size:12px;margin-top:24px}
  b.time{color:var(--run)} b.red{color:var(--bad)} b.green{color:var(--ok)}
</style>
<div class="grid">
  <div class="card"><div class="lbl">active gen</div><div class="val" id="gActive">-</div><div class="mono dim" id="gActiveSub"></div></div>
  <div class="card"><div class="lbl">switch stage</div><div class="val" id="gStage">-</div></div>
  <div class="card"><div class="lbl">前门锁 (切换中)</div><div class="val" id="gLock">-</div></div>
  <div class="card"><div class="lbl">最近结果</div><div class="val" id="gResult">-</div></div>
</div>
<h1>交接阶段流水</h1>
<div class="stages" id="gStages"></div>
<div id="gFlow"><div class="err">加载中…</div></div>
<footer>DSH 三脑 · 只读投影 · 数据源 <span class="mono">?cmd=flow / ?cmd=status</span></footer>
<script>
const stagees=['idle','defer','spawn','ready','catchup','freeze','promote','flip','verify','retire'];
const admin=new URLSearchParams(location.search).get('admin')||'http://127.0.0.1:31800';
function el(id){return document.getElementById(id)}
async function j(path){const r=await fetch(admin+'/?'+path,{cache:'no-store'});if(!r.ok)throw new Error(r.status+' '+path);return r.json()}
function chip(v){return '<span class="chip '+(v===true?'ok':v===false?'bad':v||'idle')+'">'+(v===true?'true':v===false?'false':(v??'-'))+'</span>'}
function t(ms){if(!ms)return '-';const d=new Date(ms);return d.toTimeString().slice(0,8)}
async function refresh(){
  try{
    const st=await j('cmd=status'); const fl=await j('cmd=flow');
    const lease=st.lease||{}; el('gStage').innerHTML=chip(st.stage||'idle');
    el('gActive').textContent=lease.activeGen?lease.activeGen.gen:'-';
    el('gActiveSub').textContent=(lease.activeGen?('pid '+(lease.activeGen.pid??'?')+' · port '+(lease.activeGen.port??'?')):'');
    el('gLock').innerHTML=chip(st.locked);
    const res=st.result; el('gResult').innerHTML=res?('<b class="'+
      (res.result==='success'?'green':res.result==='aborted'?'red':'')+'">'+res.result+'</b> <span class="dim">'+t(res.t)+'</span><br><span class="mono dim">'+ (res.note||'') +'</span>'):'<span class="dim">暂无</span>';
    // 阶段进度条
    const rows=fl.rows||[]; const seen=new Set(); for(const r of rows){if(r.stage)seen.add(r.stage)}
    const cur=st.stage||'idle'; const curi=stagees.indexOf(cur);
    el('gStages').innerHTML=stagees.map((s,i)=>{
      const cls=i===curi?' cur':seen.has(s)?' done':''; return '<div class="stage'+cls+'">'+s+'</div>'}).join('');
    // 流水表
    if(!rows.length){el('gFlow').innerHTML='<div class="err">暂无交接流水（尚未进行过切换，或 state.jsonl 为空）</div>';return}
    el('gFlow').innerHTML='<table><thead><tr><th>时间</th><th>阶段</th><th>gen</th><th>备注</th></tr></thead><tbody>'+
      rows.slice().reverse().map(r=>'<tr><td class="nowrap mono dim">'+t(r.t)+'</td><td>'+(r.stage||'-')+'</td><td class="mono">'+(r.gen||'-')+'</td><td class="dim">'+(r.note||'')+'</td></tr>').join('')+'</tbody></table>';
  }catch(e){el('gFlow').innerHTML='<div class="err">读取失败：'+e.message+'<br>请确认 switchboard 已启动，且 admin 端口 (默认 31800) 可访问。</div>'}
}
refresh(); setInterval(refresh,1500);
</script></html>`;

export { boot }