#!/usr/bin/env node
/**
 * e2e-handover.mjs — 蓝绿交接端到端验证（Node 24 全局 fetch）。
 *
 * 前置：已用 start-switchboard.ps1 启动 switchboard（前门 3080 + 控制面 31800）。
 * 流程：等前门/admin 就绪 → 触发 handover → 轮询 status 到 idle → 断言 3080 仍 200 →
 * 再跑一次证明可重复（V2→V3）。
 *
 * 用法：node scripts/e2e-handover.mjs
 */
const FW = process.env.SWITCH_ADDR ?? 'http://127.0.0.1:3080'
const CTL = process.env.SWITCH_ADMIN ?? 'http://127.0.0.1:31800'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (url, tries = 1, gap = 1000) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (r.ok) {
        const ct = (r.headers.get('content-type') || '').toLowerCase()
        const body = ct.includes('application/json') ? await r.json() : await r.text()
        return { status: r.status, body }
      }
    } catch {}
    await sleep(gap)
  }
  return null
}

async function assertFrontAlive() {
  const r = await get(FW + '/', 3)
  if (!r || r.status !== 200) throw new Error('front door not reachable at ' + FW)
  console.log(`front door ${FW} -> ${r.status}`)
  return true
}

async function waitStage(target, ms = 120000) {
  const dl = Date.now() + ms
  for (;;) {
    const s = await get(CTL + '/?cmd=status', 1, 500)
    if (s && s.body?.stage) {
      console.log('stage =', s.body.stage)
      if (s.body.stage === target) return s.body
    }
    if (Date.now() > dl) throw new Error('timeout waiting stage=' + target)
    await sleep(1200)
  }
}

async function main() {
  if (!(await assertFrontAlive())) return process.exit(1)
  await waitStage('idle', 60000)

  console.log('--- apply #1 (V1 -> V2, via /cmd=apply blue-green) ---')
  const h1 = await get(CTL + '/?cmd=apply')
  console.log('apply trigger:', h1?.body ?? '(no reply)')
  await waitStage('idle')
  if (!(await assertFrontAlive())) throw new Error('front down after apply #1')

  console.log('--- apply #2 (V2 -> V3, repeatability) ---')
  const h2 = await get(CTL + '/?cmd=apply')
  console.log('apply trigger:', h2?.body ?? '(no reply)')
  await waitStage('idle')
  if (!(await assertFrontAlive())) throw new Error('front down after apply #2')

  console.log('E2E PASS: two blue-green apply (self-evolution) loop closed; front door stayed up.')
}

main().catch((e) => {
  console.error('E2E FAIL:', e.message)
  process.exit(1)
})