/**
 * evolve.mjs —— 自进化·单指令闭环门面
 *
 * 把"改动 → 实验内核 → 实验 gen → 验证 → 通过才切换"串成一条命令：
 *   1. 用 build-experiment-kernel 把 --patch 建出独立内核产物 --out；
 *   2. 触发 switchboard `apply&kernel=<out>`：本次 staging 单独加载实验内核
 *      （coordinator 把 DESIGN_CANVAS_KERNEL_DIR 注入该 staging，生产 gen 不受影响）；
 *   3. 轮询 admin status 直到交接落定，回报成功(成功 flip 实验核) / 回滚 / 中止。
 *
 * 前提：控制面启动时已配 VERIFY_CMD / VERIFY_ALLOW（P0-3 验证闸），
 * 使 staging 在加载实验核后跑该验证判定才 flip。--verify 仅用于提示确认。
 *
 * 用法：
 *   node scripts/evolve.mjs \
 *     --src <design-canvas 源码根> --patch <改动 JSON/.mjs> --out <EXPT_ROOT> \
 *     [--admin <控制面 admin 端口›, 默认 31800] [--profile web] [--verify <验证脚本绝对路径>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function fail(msg) {
  console.error(`[evolve] ✗ ${msg}`);
  process.exit(1);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const src = arg('src', '');
  const patch = arg('patch', '');
  const out = path.resolve(arg('out', ''));
  const admin = arg('admin', '31800');
  const profile = arg('profile', 'web');
  const verify = arg('verify', '');
  if (!src) fail('--src 必填（design-canvas 源码根）');
  if (!patch) fail('--patch 必填（改动 JSON/.mjs）');
  if (!out) fail('--out 必填');

  // 1) 建实验内核产物
  console.log(`[evolve] ① build 实验内核产物 → ${out}`);
  const b = spawnSync(process.execPath, [path.join(HERE, 'build-experiment-kernel.mjs'), '--src', src, '--patch', patch, '--out', out], { encoding: 'utf8', timeout: 400_000 });
  if (b.status !== 0) fail(`build-experiment-kernel 失败：\n${(b.stderr || b.stdout || '').slice(0, 1200)}`);

  // 2) 校验验证脚本提示（须在控制面启动 env 的 VERIFY_ALLOW 白名单内）
  if (verify) {
    console.log(`[evolve]   提示：验证脚本 ${verify} 须在控制面启动 env 的 VERIFY_ALLOW 白名单内；否则 verify-gate 会安全拒绝。`);
  } else {
    console.log(`[evolve]   未显式给 --verify：本次仅探活（若控制面未配 VERIFY_CMD，实验核不做测试闸只 probe）。`);
  }

  // 3) 触发 apply&kernel=<out>
  const applyUrl = `http://127.0.0.1:${admin}/?cmd=apply&profile=${encodeURIComponent(profile)}&kernel=${encodeURIComponent(out)}`;
  console.log(`[evolve] ② 触发 apply → ${applyUrl}`);
  const ar = await fetch(applyUrl).then((r) => r.json());
  console.log(`[evolve]   apply: ${JSON.stringify(ar)}`);

  // 4) 轮询直到交接落定（status.lastHandoverResult 可见且 stage 稳定）
  console.log(`[evolve] ③ 轮询交接结果…`);
  let last = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1500);
    let s;
    try {
      s = await fetch(`http://127.0.0.1:${admin}/?cmd=status`).then((r) => r.json());
    } catch {
      continue;
    }
    if (s?.result?.t) last = s.result; else last = null;
    const done = ['idle', 'rolled-back', 'aborted'].includes(s?.stage);
    const idle = s?.stage === 'idle';
    if ((done && !(/^(spawn|ready|freeze|promote|flip|verify)/.test(s?.stage))) || (idle && last)) {
      break;
    }
    if (i % 10 === 0) console.log(`[evolve]     …stage=${s?.stage}`);
  }
  if (!last) fail('轮询超时，未取到交接结果（可能仍在进行/控制面未就绪）');

  const ok = last.result === 'success';
  console.log(`\n[evolve] ④ 结果: ${last.result.toUpperCase()}`);
  console.log(`   note: ${last.note ?? ''}`);
  if (last.result === 'rolled-back' && /不在白名单|verify-gate/.test(last.note ?? '')) {
    console.log(`   → 验证闸拒绝（安全），现役保持。请核对验证脚本是否在 VERIFY_ALLOW 白名单内。`);
  }
  console.log(`   gen: ${last.gen ?? ''}`);
  process.exit(ok ? 0 : 2);
}

main().catch((e) => {
  console.error('[evolve] ✗', e);
  process.exit(1);
});