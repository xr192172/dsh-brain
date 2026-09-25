// ablate-l2-behavioral.mjs —— ★ 行为级消融自证（**主线自己做的**，因为子代理那版只读源码文本）
//
// 为什么必须重做：子代理的 `out/l2-ablation-test.mjs` 只 `readFileSync` 源码做文本判定，
// 而 `scripts/test-l2.mjs` 一半是 `gateSrc.includes(...)`、另一半是"镜像实现"（自己重写一遍逻辑）
// ⇒ 两者都**证明不了门真的会拦**（"测试与被检对象一起错"的经典风险）。
//
// 本脚本的做法：**驱动真实 CLI，看真实 verdict**：
//   ① 隔离 DSH_HOME + 拷贝现役 registry（4 个 active 能力，L0/L1 本来就过 ⇒ 由 L2 决定 verdict）
//   ② 跑 `capability-gate.mjs run spawn` ⇒ 期望 **blocked**（criterion a 的行为证据）
//   ③ 把 `l2Baseline` 里「无基线 ⇒ blocked」那一处改成 admitted（精确替换 + 备份）
//   ④ 再跑 ⇒ 期望 **admitted**（消融被抓住 ⇒ 证明那条分支是真闸门，不是装饰）
//   ⑤ 还原 ⇒ 再跑 ⇒ 期望 **blocked**（证明还原干净）
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const WT = 'D:/project_develop/_l2/wt'
const GATE = path.join(WT, 'scripts/capability-gate.mjs')
const HOME = path.join(WT, 'out/_mainline-dsh')
const LIVE = 'C:/Users/Admin/.dsh/capabilities/registry.json'
const NODE = process.execPath

// ★★ 靶子必须打在【真正的决定因子】上。
//   实测发现：`evaluate()` 是 `allChecks.some(c => !c.ok)` —— **它不看 `l2.verdict`**，
//   所以那个 `return { verdict: 'blocked' }` 是**死码**。第一版消融改的就是它 ⇒ **门纹丝不动**。
//   ⇒ 真正的闸门是这一行 `add(...)` 的第二个参数（ok 位）。消融就打它。
const ANCHOR = `  if (!existing) {
    // ★ 无基线（无论 signals 是否为零）→ blocked
    // 这防止了"新能力第一次跑就自动放行"的假绿路径。
    add('基线存在', false, '无已确认基线 —— 须先用 node scripts/eval-baseline-store.mjs set <id> --metrics <json> 写入基线后再评估')
    evidence.noBaseline = true
    return { checks, verdict: 'blocked', evidence }
  }`
const ABLATED = ANCHOR.replace(
  "add('基线存在', false, '无已确认基线",
  "add('基线存在', true, '无已确认基线",
)

// ① 隔离库
fs.mkdirSync(path.join(HOME, 'capabilities'), { recursive: true })
fs.copyFileSync(LIVE, path.join(HOME, 'capabilities/registry.json'))

function runGate(id) {
  const r = spawnSync(NODE, ['scripts/capability-gate.mjs', 'run', id], {
    cwd: WT, env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8', timeout: 120000,
  })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const verdict = /⛔ blocked/.test(out) ? 'blocked' : (/✅ admitted/.test(out) ? 'admitted' : '(未识别)')
  const proof = (out.match(/证明级别[：:]\s*([^\s（(]+)/) ?? [])[1] ?? null
  const unenf = (out.match(/未实施的级[：:]\s*(.+)/) ?? [])[1] ?? null
  return { verdict, proof, unenf, code: r.status, out }
}

const results = []
const step = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`) }

// ② 消融前
const before = runGate('spawn')
console.log(`\n--- ② 消融前 ---\n  verdict=${before.verdict} proof=${before.proof} unenforced=${before.unenf}\n`)
step('② 无基线 ⇒ blocked（行为）', before.verdict === 'blocked', before.verdict)

// ③ 施加消融
const src = fs.readFileSync(GATE, 'utf8')
if (!src.includes(ANCHOR)) { console.error('★ 锚点失配：源码形状变了，本脚本必须重写（不许模糊匹配后硬改）'); process.exit(3) }
fs.writeFileSync(path.join(WT, 'out/_mainline-ablation-backup-gate.mjs'), src, 'utf8')
fs.writeFileSync(GATE, src.replace(ANCHOR, ABLATED), 'utf8')
console.log('\n--- ③ 已施加消融：无基线分支 verdict blocked → admitted ---')

// ④ 消融后
const ablated = runGate('spawn')
console.log(`  verdict=${ablated.verdict} proof=${ablated.proof}\n`)
step('④ 消融后 ⇒ 变 admitted（消融被抓住）', ablated.verdict === 'admitted', ablated.verdict)

// ⑤ 还原
fs.writeFileSync(GATE, src, 'utf8')
const restored = runGate('spawn')
console.log(`\n--- ⑤ 已还原 ---\n  verdict=${restored.verdict} proof=${restored.proof}\n`)
step('⑤ 还原后 ⇒ 复 blocked', restored.verdict === 'blocked', restored.verdict)
step('★ 还原是逐字节的（无残留）', fs.readFileSync(GATE, 'utf8') === src, 'sha 比对')

const pass = results.filter((r) => r.ok).length
console.log(`\n结果：${pass}/${results.length} 通过`)
fs.writeFileSync(path.join(WT, 'out/_mainline-ablation-behavioral.txt'),
  JSON.stringify({ results, before: { verdict: before.verdict, proof: before.proof, unenf: before.unenf },
    ablated: { verdict: ablated.verdict }, restored: { verdict: restored.verdict } }, null, 2), 'utf8')
process.exit(pass === results.length ? 0 : 1)
