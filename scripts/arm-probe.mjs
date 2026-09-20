#!/usr/bin/env node
/**
 * arm-probe.mjs —— **臂分离探针**：换代到某个 profile 后，真发一句话、真读一次"模型实际拿到的工具面"。
 *
 * 与 `eval-isolation-audit.mjs`（看"两臂之间有没有互相碰"）配套；本脚本回答的是
 * **"这一臂到底拿到哪些工具"** —— 因为"我们改了 profile" ≠ "模型看见的变了"（实测踩过：
 * 换代刚 flip 完插件还在注册工具，臂跑在只有 4 个工具的 gen 上；也踩过只 drop bundle
 * 但能力还有第二条路 = mcp-client insert）。
 *
 * 用法：
 *   node scripts/arm-probe.mjs web-nodc            # 换代到该 profile 并探一次
 *   node scripts/arm-probe.mjs web-nodc web        # 探完再切回来（两方向）
 *   node scripts/arm-probe.mjs --current           # 不换代，只探当前代
 *
 * 前置：控制面可达（`DSH_CTRL` 默认 http://127.0.0.1:31800）；控制面必须 idle 才能换代。
 */
import { spawnSync } from 'node:child_process'

const CTRL = process.env.DSH_CTRL ?? 'http://127.0.0.1:31800'
const REPO = 'D:/project_develop/dsh-brain'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8' })
const status = async () => (await fetch(`${CTRL}/?cmd=status`)).json()

async function flip(profile) {
  const s0 = await status()
  if (s0.stage !== 'idle') throw new Error(`控制面 stage=${s0.stage}，先别换代`)
  await fetch(`${CTRL}/?cmd=handover&profile=${encodeURIComponent(profile)}`)
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const s = await status()
    if (s.stage === 'idle' && s.result) return s
  }
  throw new Error('换代超时')
}

async function probe(label) {
  const sid = String(sh('node', ['scripts/session-create.mjs']).stdout).trim().split('\n').pop().trim()
  sh('node', ['scripts/session-drive.mjs', 'prompt', sid, '只回一个字：好'])
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const r = sh('node', ['scripts/eval-run.mjs', '--traj', sid])
    try {
      const m = JSON.parse(r.stdout).metrics
      if (m?.toolSetSize) {
        const fam = (re) => m.toolSet.filter((t) => re.test(t))
        console.log(
          `  ${label}: 工具面 ${m.toolSetSize} 个 | design-canvas 家族 ${fam(/design[-_]canvas/i).length} | ` +
            `mcp__* ${fam(/^mcp__/).length} | self_evolve ${fam(/^self_evolve$/).length}`,
        )
        return { sid, metrics: m }
      }
    } catch {
      /* 还没写盘 */
    }
  }
  console.log(`  ${label}: 探不到工具面（会话 ${sid}）`)
  return { sid, metrics: null }
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (process.argv.includes('--current') || !args.length) {
  const s = await status()
  await probe(`当前代 ${s.lease.activeGen.gen}`)
} else {
  for (const p of args) {
    console.log(`\n=== 换代到 ${p} ===`)
    const s = await flip(p)
    console.log('  ' + String(s.result?.note ?? '').slice(0, 60) + '  代=' + s.lease.activeGen.gen)
    await probe(p)
  }
}
