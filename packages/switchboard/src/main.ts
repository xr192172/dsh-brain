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
 *   WORK_DIR            工作目录（协调+gen 底座），默认 {DSH_HOME}/switchboard
 *   WEB_PROFILE         dsh profile，默认 web
 *   DSH_BIN             dsh lib/bin.js
 *   NODE_BIN            node 可执行
 *   GEN_ENV_EXTRA       透传到 gens 的 JSON 对象（含 key 池等）
 */
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { FrontDoor } from './proxy.js'
import { Coordinator, type CoordinatorConfig } from './coordinator.js'
import { AdminClient } from './adminclient.js'
import { spawnGen } from './spawner.js'
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

function envStr(k: string, d: string): string {
  return process.env[k] || d
}
function envInt(k: string, d: number): number {
  const v = process.env[k]
  return v && /^\d+$/.test(v) ? Number(v) : d
}

function boot(config: CoordinatorConfig): void {
  const front = new FrontDoor()

  // bootstrap：spawn 初始 active gen A
  const genId = 'gen-' + String(config.portBase + 1)
  const port = config.portBase + 1
  const adminPort = config.adminBase + 1
  const genDir = join(config.workDir, genId)
  const nodeBin = config.nodeBin
  const spawnedA = spawnGen({
    nodeBin,
    dshBin: config.dshBin,
    profile: config.profile,
    port,
    adminPort,
    gen: genId,
    leaseToken: '', // A 启动即 active，token 在首次 grant 时定
    mode: 'active',
    genDir,
    envExtra: config.envExtra,
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
      res.end(JSON.stringify({ ok: true, cmd, stage: 'started', fast, profile: url.searchParams.get('profile') ?? 'web' }))
      void coord.handover(url.searchParams.get('fail') ?? undefined, url.searchParams.get('profile') ?? undefined, url.searchParams.get('kernel') ?? undefined, url.searchParams.get('verify') ?? undefined, fast).catch((e) =>
        console.error('[switchboard] handover error:', e instanceof Error ? e.message : String(e)),
      )
    } else if (cmd === 'status') {
      const lease = coord.getLease()
      res.end(JSON.stringify({ ok: true, stage: coord.stageName, result: coord.lastHandoverResult, lease: lease?.current, locked: coord.switchLocked }))
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
  const envExtraRaw = envStr('GEN_ENV_EXTRA', '{}')
  let envExtra: Record<string, string> = {}
  try {
    envExtra = JSON.parse(envExtraRaw) as Record<string, string>
  } catch {
    envExtra = {}
  }
  // 控制面必须存活：单个坏请求/上游错误不得击穿 3080（此处记录并继续）
  process.on('uncaughtException', (e) => console.error('[switchboard] uncaughtException:', e?.message))
  process.on('unhandledRejection', (e) => console.error('[switchboard] unhandledRejection:', String((e as Error)?.message ?? e)))

  const config: CoordinatorConfig = {
    nodeBin: existsSync(nodeBin) ? nodeBin : join(homedir(), '.dsh', '.tools', 'node', 'node.exe'),
    dshBin,
    profile: envStr('WEB_PROFILE', 'web'),
    portBase: envInt('GEN_PORT_BASE', 3081),
    adminBase: envInt('HANDOVER_ADMIN_PORT_BASE', 31810),
    inspectPortBase: envInt('SWITCH_INSPECT_PORT_BASE', 32810),
    coordDir: envStr('WORK_DIR', join(home, 'switchboard')),
    workDir: envStr('WORK_DIR', join(home, 'switchboard')),
    envExtra,
    ttlMs: envInt('SWITCH_LEASE_TTL_MS', 10_000),
    readyTimeoutMs: envInt('SWITCH_READY_TIMEOUT_MS', 40_000),
    freezeTimeoutMs: envInt('SWITCH_FREEZE_TIMEOUT_MS', 20_000),
    // 旧代 flip 后多存活 30s：DSH 在优雅停机时 flush 全部 live 会话（write-behind 200ms），
    // 足够长即保证"先落盘再换"，避免在途未提交的会话被强杀带走。
    retainMs: envInt('SWITCH_RETAIN_MS', 30_000),
    deferMs: envInt('SWITCH_DEFER_MS', 20_000),
    // verify 稳定观察窗口（ms）：flip 后再稳 2s 并二次探测，拦"probe 假 ok、稍后崩"的假成功
    verifyStableMs: envInt('SWITCH_VERIFY_STABLE_MS', 2_000),
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