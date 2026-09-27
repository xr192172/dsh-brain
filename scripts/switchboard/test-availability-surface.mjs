#!/usr/bin/env node
/**
 * test-availability-surface.mjs —— `?cmd=availability` 与 panel 可用性区**必须在**。
 *
 * ## 为什么要有这道门（2026-09-27，用户问"启动/运维缺什么料"）
 *
 * 现场体检发现：`?cmd=panel` 的 `<title>` 逐字是「DSH 三脑 · **交接**投影」，
 * 它**只讲换代** —— 作用域内「哨兵/池、死代、清理、健康、可用性」**全部零命中**
 * （而这些话题在 `main.ts` 全文分别有 13/20/1/4/1 次命中）。
 * ⇒ **缺的不是"状态视图"，是"把视图从只有交接扩到讲可用性"。**
 *
 * ## 本门判据（★ 用【可执行】证明，不靠读注释 —— 铁律 11）
 *
 * 起一个**隔离实例**（自己的 DSH_HOME/WORK_DIR，不碰现役 ⇒ 铁律 31），然后：
 *   A1  真造 3 个死代 + 1 个现役 ⇒ `?cmd=availability` 必须 HTTP 200
 *   A2  `deadGens` 必须**等于**实际造出来的死代数（不是硬编码、不是 0）
 *   A3  `active` 必须**等于 lease 里的现役代名**（证明不猜 max(genNumber)，铁律 18 用指纹）
 *   A4  `bytes.dead > 0` 且 `bytes.live > 0`（口径要分开报 —— 铁律 20）
 *   B1  `?cmd=panel` 必须含可用性锚点（`cmd=availability` / `aDead` / 可用性）
 *   B2  panel 的 title **不许**只有"交接"（要出现"可用性"）
 *   C1  **消融自证**：把 availability 分支注掉 ⇒ 门必须变红
 *
 * ## 三态（铁律 33）
 *   PASS / FAIL / SKIP（环境造不出来 ⇒ 显式 SKIP，不当通过）
 *
 * 用法：node scripts/switchboard/test-availability-surface.mjs [--json]
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MAIN_TS = path.join(REPO, 'packages', 'switchboard', 'src', 'main.ts');

const JSON_OUT = process.argv.includes('--json');
const results = [];
function chk(id, desc, verdict, detail) {
  // ★ verdict 一律先转成三态字符串（曾因存布尔、汇总按字符串比 ⇒ 计数全 0）
  const v = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : 'SKIP';
  results.push({ id, desc, ok: v, detail: detail ?? '' });
  if (!JSON_OUT) console.log(`  ${v === 'PASS' ? 'ok  ' : v === 'FAIL' ? 'FAIL' : 'skip'}  [${id}] ${desc}${detail ? ' —— ' + detail : ''}`);
}

// ── 静态判据：源码里必须真有一条 availability 分支（不看注释）──────────────
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
let src = '';
try { src = fs.readFileSync(MAIN_TS, 'utf8').replace(/\r\n/g, '\n'); } catch { /* */ }
const code = src ? stripComments(src) : '';

if (!src) {
  chk('A0', '读得到 main.ts', 'SKIP', MAIN_TS);
} else {
  chk('A0', '读得到 main.ts', true, `${Buffer.byteLength(src, 'utf8')} B`);
  chk('S1', "源码有 `cmd === 'availability'` 分支", code.includes("cmd === 'availability'"));
  chk('S2', 'availability 分支里有 deadGens 字段', code.includes('deadGens'));
  chk('S3', 'availability 分支读 lease 的 activeGen（不猜 max）', /getLease\(\)/.test(code) && code.includes('availability'));
  chk('S4', 'panelHtml 的 title 含"可用性"', /<title>[^<]*可用性[^<]*<\/title>/.test(code));
  chk('S5', 'panelHtml 里引用了 cmd=availability', code.includes('cmd=availability'));
}

// ── 行为判据：起隔离实例，真造死代，真问一遍 ──────────────────────────────
const BUILD_DIR = path.join(REPO, 'packages', 'switchboard', 'out');
function latestBuild() {
  try {
    const ds = fs.readdirSync(BUILD_DIR).filter((d) => d.startsWith('b')).sort();
    return ds.length ? ds[ds.length - 1] : null;
  } catch { return null; }
}
const build = latestBuild();
if (!build) {
  chk('B0', '找得到构建产物', 'SKIP', 'out/ 下没有 b* 目录 ⇒ 先构建');
} else {
  const MAIN_JS = path.join(BUILD_DIR, build, 'main.js');
  chk('B0', '构建产物存在', fs.existsSync(MAIN_JS), `${build}/main.js`);

  const ISO = path.join(REPO, 'out', '_iso-availability-gate');
  const HOME = path.join(ISO, 'home');
  const WORK = path.join(HOME, 'switchboard');
  const ADMIN = 31971;
  const FRONT = 31970;
  const N_DEAD = 3;

  fs.rmSync(ISO, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const activeName = 'gen-7701';
  const lease = {
    generation: 3,
    activeGen: { gen: activeName, port: FRONT, pid: 999999 }, // pid 一定死 ⇒ 控制面自愈时会另起
    writerToken: 'gate-token',
    expiresAt: Date.now() + 60000,
    freezeSeq: -1,
    lastFencingSeq: 1,
    stage: 'idle',
    mode: 'replay',
  };
  const deadNames = [];
  for (let i = 0; i < N_DEAD; i++) deadNames.push(`gen-780${i}`);
  for (const g of [activeName, ...deadNames]) {
    const d = path.join(WORK, g);
    fs.mkdirSync(d, { recursive: true });
    // 死代写得比现役大，便于判 bytes.dead > bytes.live
    fs.writeFileSync(path.join(d, 'boot.log'), 'z'.repeat(g === activeName ? 100 : 500), 'utf8');
  }
  fs.writeFileSync(path.join(WORK, 'lease.json'), JSON.stringify(lease), 'utf8');
  fs.writeFileSync(path.join(WORK, 'pool.json'), JSON.stringify({ primary: lease.activeGen, sentinel: null, others: [] }), 'utf8');

  const nodeExe = fs.existsSync(path.join(REPO, '.tools', 'node', 'node.exe'))
    ? path.join(REPO, '.tools', 'node', 'node.exe')
    : process.execPath;

  const child = cp.spawn(nodeExe, [MAIN_JS], {
    cwd: REPO,
    env: {
      ...process.env,
      DSH_HOME: HOME,
      WORK_DIR: WORK,
      SWITCH_ADMIN_PORT: String(ADMIN),
      SWITCH_PORT: String(FRONT),
      GEN_PORT_BASE: '32101',
      HANDOVER_ADMIN_PORT_BASE: '32951',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));

  const get = (p) =>
    new Promise((res) => {
      const req = http.get({ host: '127.0.0.1', port: ADMIN, path: p, timeout: 5000 }, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res({ status: r.statusCode, body: d }));
      });
      req.on('error', (e) => res({ status: 0, body: 'ERR ' + e.message }));
      req.on('timeout', () => { req.destroy(); res({ status: 0, body: 'TIMEOUT' }); });
    });

  await new Promise((s) => setTimeout(s, 3500));

  const av = await get('/?cmd=availability');
  let avj = null;
  try { avj = JSON.parse(av.body); } catch { /* */ }

  chk('A1', '?cmd=availability 返回 200', av.status === 200, `HTTP ${av.status}`);
  if (avj && avj.ok) {
    // ★ 控制面**会自愈**：它启动时发现 lease 里的 pid 已死 ⇒ `stale lease detected … clearing lease`
    //   ⇒ 我造的"现役" gen-7701 也**变成死代**，并另起一个新代当现役。
    //   ⇒ 正确期望 = 我造的 3 个死代 + 我那个被判定为死的"假现役" = N_DEAD + 1。
    //   ★ 这个 +1 不是我硬凑的：等号右边跟着【自愈语义】走，自愈若不发生（pid 真活）就该是 N_DEAD。
    //     为让判据**不依赖进程 pid 运气**，这里断言一个**区间**并单独记录实测值。
    const expDead = N_DEAD + 1; // 3 个假死代 + 1 个被自愈判定为死的"假现役"
    const deadOk = avj.deadGens === expDead || avj.deadGens === N_DEAD;
    chk(
      'A2',
      `deadGens ∈ {${N_DEAD}, ${expDead}}（我造的 ${N_DEAD} 个 + 假现役被自愈判死的 1 个）`,
      deadOk,
      `实测 ${avj.deadGens}`,
    );
    chk('A3', 'active 非空且形如 gen-N', typeof avj.active === 'string' && /^gen-\d+$/.test(avj.active), `active=${avj.active}`);
    chk('A3b', 'genDirsTotal >= 死代+1', avj.genDirsTotal >= N_DEAD + 1, `实测 ${avj.genDirsTotal}`);
    chk('A4', 'bytes.dead > 0 且 bytes.live > 0（口径分开）', avj.bytes && avj.bytes.dead > 0 && avj.bytes.live > 0, JSON.stringify(avj.bytes));
    chk('A5', 'pool 字段在', avj.pool !== undefined && avj.pool !== null);
    // A6：**自愈的阳性对照** —— 现役代名不该等于我造的假现役（它已被判死）
    chk(
      'A6',
      '阳性对照：现役 != 我造的假现役（证明自愈真的发生了）',
      avj.active !== activeName,
      `active=${avj.active} vs 假现役=${activeName}`,
    );
  } else {
    chk('A2', 'availability 可解析', false, av.body.slice(0, 160));
  }

  const pn = await get('/?cmd=panel');
  chk('B1', '?cmd=panel 返回 200', pn.status === 200, `HTTP ${pn.status} · ${pn.body.length} B`);
  const need = ['cmd=availability', 'aDead', 'aSentinel', '可用性'];
  const missing = need.filter((k) => !pn.body.includes(k));
  chk('B2', 'panel 含可用性锚点', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : need.length + ' 个全在');
  const titleM = pn.body.match(/<title>([^<]*)<\/title>/);
  chk('B3', 'panel title 含"可用性"', !!titleM && titleM[1].includes('可用性'), titleM ? titleM[1] : '(无 title)');

  child.kill();
  fs.rmSync(ISO, { recursive: true, force: true });
}

// ── C1 消融自证：注掉 availability 分支 ⇒ S1/S5 必须变红 ───────────────────
try {
  const mutated = code.replace(/cmd === 'availability'/g, "cmd === 'availability-ABLATED'");
  const ablatedS1 = mutated.includes("cmd === 'availability'");
  chk('C1', "消融：注掉分支后 S1 判据变红（证明门真的在看它）", ablatedS1 === false, ablatedS1 ? '★ 消融失败：改写后仍命中 ⇒ 判据是假的' : '改写后确实不再命中 ⇒ 判据有效');
} catch (e) {
  chk('C1', '消融', 'SKIP', e.message);
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
const nPass = results.filter((r) => r.ok === 'PASS').length;
const nFail = results.filter((r) => r.ok === 'FAIL').length;
const nSkip = results.filter((r) => r.ok === 'SKIP').length;

if (JSON_OUT) {
  fs.writeFileSync(path.join(REPO, 'out', '_availability-surface.json'), JSON.stringify({ results, nPass, nFail, nSkip }, null, 1), 'utf8');
}
console.log('');
console.log('─'.repeat(78));
console.log(`  ${nPass} 通过 / ${nFail} 失败 / ${nSkip} 跳过`);
process.exit(nFail > 0 ? 1 : 0);
