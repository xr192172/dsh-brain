/**
 * build-experiment-kernel.mjs —— 自进化·实验脑：把生产内核（design-canvas）的一份改动
 * 建成"独立内核产物"（EXPT_ROOT/dist），供实验 gen 以 kernelDir=EXPT_ROOT 加载测试，
 * 不污染共享内核。轻量 diff-apply，不 fork 两套 DSH。
 *
 * 用法：
 *   node scripts/build-experiment-kernel.mjs \
 *     --src <design-canvas 源码根> --out <EXPT_ROOT> [--patch <改动 JSON 或 .mjs>]
 *
 * patch 格式（"脑产出的改动"）：JSON 数组或 .mjs default 导出
 *   [{ "file": "src/tools/edit_code.ts", "content": "整文件新内容" }, ...]
 * 无 --patch 时仅复制 + build 一个干净的实验内核（可用于基线对比）。
 *
 * 产物布局：EXPT_ROOT/dist/src/**（与 design-canvas 的 dist/src 同构，
 * bridge loadKernel(kernelDir) 期望 <kernelDir>/dist/src/tools/*.js）。
 * node_modules 用 junction 指回原仓库（不复制依赖），build 完移除 junction。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function fail(msg) {
  console.error(`[expt-kernel] ✗ ${msg}`);
  process.exit(1);
}

/** 递归复制 dir → dest（跳过 node_modules/.git/dist）。 */
function copyDir(src, dest, skip = new Set(['node_modules', '.git', 'dist'])) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

/** 载入 patch：接受 .json 或 .mjs；返回 [{file, content}]。 */
async function loadPatch(p) {
  if (!p) return [];
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) fail(`patch 文件不存在: ${abs}`);
  const ext = path.extname(abs);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const mod = await import(pathToFileURL(abs).href);
    return Array.isArray(mod.default) ? mod.default : (mod.patches ?? []);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    fail(`patch 解析失败（应 JSON 数组或 .mjs default 导出）: ${e.message}`);
  }
  if (!Array.isArray(raw)) fail('patch 应为数组 [{ file, content }, ...]');
  return raw;
}

import { pathToFileURL } from 'node:url';

async function main() {
  const src = arg('src', '');
  const out = path.resolve(arg('out', ''));
  const patchPath = arg('patch', '');
  if (!src || !fs.existsSync(src)) fail('--src 必须指向 design-canvas 源码根');
  if (!fs.existsSync(path.join(src, 'tsconfig.json'))) fail(`--src 缺少 tsconfig.json（应指向 design-canvas 源码根）: ${src}`);
  if (!out) fail('--out 必填');

  const patches = await loadPatch(patchPath);

  // 1) 复制度量树：复制整棵源码根（排除 node_modules/.git/dist 等编译噪声），供 tsc 正确解析全部依赖（src/schema/assets/…）。
  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  copyDir(src, out, new Set(['node_modules', '.git', 'dist', '.design-canvas']));

  // 2) 应用改动（覆盖副本里的源文件）
  for (const p of patches) {
    const rel = String(p.file).replace(/^a\//, '').replace(/^\/+/, '');
    if (!rel.startsWith('src/')) fail(`patch 路径应落在 src/ 下: ${rel}`);
    const dest = path.join(out, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, String(p.content ?? ''), 'utf8');
  }

  // 3) node_modules junction → 原仓库（tsc 依赖可解析，不复制）
  const nm = path.join(out, 'node_modules');
  try {
    fs.symlinkSync(path.join(src, 'node_modules'), nm, 'junction');
  } catch {
    /* 已是 junction / 冲突则忽略 */
  }

  // 4) tsc 产出 dist（exclusive rootDir=out → dist/src/** 与 bridge 期望对齐）
  const tsc = path.join(src, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: out,
    encoding: 'utf8',
    timeout: 300_000,
  });
  // 移除 junction（避免残留）
  try {
    fs.unlinkSync(nm);
  } catch {
    /* ignore */
  }
  if (r.error) fail(`tsc 启动失败: ${r.error.message}`);
  if (r.status !== 0) {
    console.error(`[expt-kernel] tsc 编译失败（EXPT_ROOT=${out}）：\n${(r.stderr || r.stdout || '').slice(0, 2000)}`);
    process.exit(1);
  }
  const dist = path.join(out, 'dist', 'src', 'tools');
  if (!fs.existsSync(dist)) fail('tsc 未产出 dist/src/tools（outDir/rootDir 未对齐？）');
  console.log(`[expt-kernel] ✓ 实验内核产物就绪: ${path.join(out, 'dist')}`);
  console.log(`[expt-kernel]   改动了 ${patches.length} 个源文件; 用 bridge env 覆盖加载: DESIGN_CANVAS_KERNEL_DIR=${out}`);
}

main().catch((e) => {
  console.error('[expt-kernel] ✗', e);
  process.exit(1);
});