/**
 * @module scripts/arm-stop
 *
 * **停**：把 DSH 这套（switchboard 本体 + 它拉起的代）干净地停掉。
 *
 * ★ 为什么需要它（2026-09-26 用户点破）：
 *   `arm-up.mjs` 只有"**起**"，**没有"停"** —— 想停只能手工 `taskkill`，
 *   或者到任务管理器里瞎点。**起停不对称** = 每次都得人肉扫一遍，
 *   而且极容易**误杀别的 node**（这台机器上同时跑着十几个 node，见当天实测）。
 *   ⇒ 用户原话：*"我要把所有的那些任务，就是 Node js 的窗口……全都关掉是吗？"*
 *     —— **不，不该全关**。要关的只有**本项目自己拉起的那两个**。
 *
 * ★★ 本模块是**纯模块（无副作用）**，可安全 `import`（同 `arm-ports.mjs` 的纪律：
 *    算法只有一份；`arm-up.mjs` 有顶层主流程 ⇒ 不许 import 它）。
 *
 * ★★ 安全性（**这是本模块最重要的不变量**）：
 *   只停「**本仓库** `packages/switchboard` 起的进程」以及**它派生的子进程**。
 *   判据是**命令行里含本仓库路径** —— 不按进程名杀、不按端口乱杀、**绝不 `taskkill /IM node.exe`**。
 *   ⇒ 别的 node（WorkBuddy 自己的、无关工具的）**一个都不许碰**。
 */

/**
 * 给定一批 `{pid, ppid, cmd}`，挑出「属于本仓库这套」的那一群。
 *
 * @param {Array<{pid:number, ppid:number, cmd:string}>} procs 全机 node 进程快照
 * @param {string} repoRoot 本仓库根（大小写不敏感、分隔符归一化后比较）
 * @returns {{ roots:number[], children:number[], all:number[] }}
 *   `roots`    = switchboard 本体（命令行里 `packages\switchboard\...\main.js`）
 *   `children` = 那些 root 派生的代（ppid 落在 roots 里）
 *   `all`      = 两者并集（**先子后父**，见 `stopAll` 的顺序纪律）
 */
export function selectDsBrainProcs(procs, repoRoot) {
  const norm = (s) => String(s ?? '').replace(/\\/g, '/').toLowerCase()
  const root = norm(repoRoot).replace(/\/+$/, '')

  // ① switchboard 本体：命令行里同时有「本仓库根」和「switchboard」和 main.js
  const roots = procs
    .filter((p) => {
      const c = norm(p.cmd)
      return c.includes(root) && c.includes('/switchboard/') && /main\.js(\s|$)/.test(c)
    })
    .map((p) => p.pid)

  // ② 代：父进程是 ①（不再往下递归 —— 代自己再去 spawn 的东西不属于"这套"）
  const childSet = new Set()
  for (const p of procs) {
    if (roots.includes(p.pid)) continue
    if (roots.includes(p.ppid)) childSet.add(p.pid)
  }

  return { roots, children: [...childSet], all: [...childSet, ...roots] }
}

/**
 * 停在跑的那套。**先子后父**：先杀代，再杀 switchboard —— 反过来的话
 * switchboard 一死，代就成了孤儿（ppid 变 0/1，下次再想按父子关系找它就找不到了）。
 *
 * @param {object} deps 注入依赖（便于单测：不真杀进程）
 * @param {() => Promise<Array<{pid:number,ppid:number,cmd:string}>>} deps.snapshot
 * @param {(pid:number) => Promise<boolean>} deps.kill 返回是否真把它停了
 * @param {(pid:number) => boolean} deps.alive 判活（用于**复核**：杀了之后必须确认它没了）
 */
export async function stopAll(deps, repoRoot) {
  const procs = await deps.snapshot()
  const sel = selectDsBrainProcs(procs, repoRoot)

  if (sel.all.length === 0) return { found: [], killed: [], survivors: [] }

  const killed = []
  for (const pid of sel.all) {           // ← 已在 all 里排好"先子后父"
    const ok = await deps.kill(pid)
    if (ok) killed.push(pid)
  }

  // ★ 复核：**不许只信 kill 的返回值**（铁律 21 家族：报成功 ≠ 真成功）
  //   等一个短窗口让它退干净，再问"还在不在"。
  const survivors = []
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    survivors.length = 0
    for (const pid of sel.all) if (deps.alive(pid)) survivors.push(pid)
    if (survivors.length === 0) break
  }

  return { found: sel.all, killed, survivors }
}

/** 端口→pid 的探活结果里，挑出属于"这套"的（备用判据：命令行取不到时按端口兜底）。 */
export function pidsListeningOn(lines, ports) {
  const want = new Set(ports.map(String))
  const out = new Set()
  for (const l of lines) {
    const m = l.match(/\s(\d+)\s*$/) // netstat 行尾就是 pid
    if (!m) continue
    if ([...want].some((p) => l.includes(`:${p} `))) out.add(Number(m[1]))
  }
  return [...out]
}
