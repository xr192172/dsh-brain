#!/usr/bin/env node
/**
 * check-upstream-drift.mjs —— 上游漂移体检（**手动跑**，需要网络；不在 check:all 里）
 *
 * ## 为什么需要它
 *
 * 项目铁律是「**不追**上游版本」，但那不等于可以不知道上游动了什么。真正危险的是两种静默：
 *
 *   1. **我们依赖的上游形状变了** ⇒ 我们自己的代码静默退化
 *      （例：`drain.ts` 依赖 `agent.phase` / `agent.cancel` / `agent.whenIdle` /
 *       `session.seq` / `sessions.flush`；`session.seq` 若变成别的语义，
 *       "换代写入竞态"的整个推理与修法都要重做）。
 *   2. **我们打过的补丁靶子消失了** ⇒ 补丁打不上。好消息：我们的锚点应用器是**严格模式**
 *      （`patch-anchors.mjs`：两态都不在 ⇒ postinstall 非 0 退出），所以这一项在装机时就会喊；
 *      本脚本的价值是**升级前**先告诉你会不会喊。
 *
 * ## 三组判据
 *
 *   A 依赖形状（必须命中 —— 不命中 = 升级会打破我们自己的机制）
 *   B 补丁靶子（靶子在 ⇒ 还能打；顺带报"上游是否已自行修好，可考虑撤补丁"）
 *   C 上游新增能力（给架构决策用：有没有现成的东西可以少造轮子）
 *
 * 用法：
 *   node scripts/check-upstream-drift.mjs                 # 默认比 registry 上 dsh 的 latest
 *   node scripts/check-upstream-drift.mjs 0.1.6-alpha.2
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project_develop/dsh-brain'
const OUT = path.join(REPO, 'out')
const REG_CACHE = path.join(OUT, 'upstream-reg')
const LOCAL_AI = path.join(REPO, 'node_modules', '@deepseek-ai')
const PKGS = ['dsh-session', 'dsh-agent-loop', 'dsh-agent', 'dsh-web-app', 'dsh-app-boot', 'dsh-session-persistence']

fs.mkdirSync(REG_CACHE, { recursive: true })
const log = []
const say = (s) => {
  log.push(s)
  console.log(s)
}

async function packument(name) {
  const f = path.join(REG_CACHE, name + '.json')
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
  const r = await fetch(`https://registry.npmjs.org/@deepseek-ai%2F${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) })
  const j = await r.json()
  fs.writeFileSync(f, JSON.stringify(j), 'utf8')
  return j
}

const localVersion = JSON.parse(fs.readFileSync(path.join(LOCAL_AI, 'dsh', 'package.json'), 'utf8')).version
const dshReg = await packument('dsh')
const version = process.argv[2] ?? dshReg['dist-tags'].latest
const dest = path.join(OUT, `upstream-${version}`)
say(`== 上游漂移体检：目标 ${version}（本地安装 ${localVersion}）`)
say(`   registry dist-tags: ${JSON.stringify(dshReg['dist-tags'])}`)

for (const p of PKGS) {
  const dir = path.join(dest, p)
  if (fs.existsSync(path.join(dir, 'package.json'))) continue
  const reg = await packument(p)
  const meta = reg.versions?.[version]
  if (!meta) {
    say(`  [skip] ${p}@${version} 未发布`)
    continue
  }
  fs.mkdirSync(dir, { recursive: true })
  const tgz = path.join(dir, `${p}.tgz`)
  execFileSync('curl', ['-sL', '-m', '120', '-o', tgz, meta.dist.tarball], { stdio: 'inherit' })
  const size = fs.statSync(tgz).size
  if (size < 1024) throw new Error(`${p}@${version} 下载异常：${size} 字节`)
  // ★ npm tarball 内容在 `package/` 前缀下，必须 strip（第一版没 strip，断言全去找错路径，
  //   而它又把"文件不存在"当 skip ⇒ 输出了一句"所有断言仍成立"的假绿。两边都修了。）
  execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'], { stdio: 'inherit' })
  fs.unlinkSync(tgz)
}

const read = (pkg, file) => {
  const f = path.join(dest, pkg, file)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
}

/** A 组：我们依赖的形状。`re` 必须命中。 */
const SHAPES = [
  {
    id: 'agents.list() 返回活的 agent 本体',
    pkg: 'dsh-agent',
    file: 'lib/index.js',
    re: /list\(\)\s*\{\s*return \[\.\.\.this\.store\.values\(\)\]\.map\(\(entry\) => entry\.agent\);/,
    used: 'drain.ts 靠它枚举在跑的 agent（见 scripts/test-handover-drain.mjs 的 C 段）',
  },
  {
    id: 'agent.phase.kind 存在',
    pkg: 'dsh-agent-loop',
    file: 'lib/index.js',
    re: /this\.phase = \{\s*kind: "idle",\s*lastTurn\s*\};/,
    used: 'drain 判断"有没有活在跑"的**唯一**可靠判据（status 会把 maintenance 算成 idle）',
  },
  {
    id: 'agent.cancel(cause, options)',
    pkg: 'dsh-agent-loop',
    file: 'lib/index.js',
    re: /cancel\(cause, options = \{\}\) \{/,
    used: 'freeze 时停回合的唯一手段',
  },
  {
    id: 'agent.whenIdle()',
    pkg: 'dsh-agent-loop',
    file: 'lib/index.js',
    re: /async whenIdle\(\) \{/,
    used: '等回合真的停（有界等待）',
  },
  {
    // ★ 语义判据，不锁字面量：0.1.5 把返回值包成了 `SessionLogOffset(...)` 名牌类型
    //   （`return SessionLogOffset(this.log.length)`）—— 语义没变，但**字面量正则当场变假红**。
    //   这里只断言"seq 仍然由 log.length 派生"。
    id: 'session.seq 仍由 log.length 派生（"seq 是下一个序号"）',
    pkg: 'dsh-session',
    file: 'lib/index.js',
    re: /get seq\(\)\s*\{\s*return [^;{]*log\.length[^;]*;\s*\}/,
    used: '整个"两代并发写同一会话 ⇒ 必然 seq 重叠"推理的地基',
  },
  {
    id: 'sessions.flush 可 await',
    pkg: 'dsh-session',
    file: 'lib/index.js',
    re: /async flush\(session\) \{/,
    used: 'freeze 的落盘确认（比 emit + sleep 可靠）',
  },
]

/** B 组：我们的补丁靶子。`anchor` 在 ⇒ 仍能打；`alreadyFixed` 命中 ⇒ 上游已自行修好，可考虑撤补丁。 */
const PATCHES = [
  {
    id: 'U1 web-app 公开 URL（救 prompt 前缀缓存）',
    pkg: 'dsh-web-app',
    file: 'lib/index.js',
    anchor: 'function localWebUrl(ctx) {\n\tconst port = ctx.get("webServer")?.port;',
    alreadyFixed: /DSH_PUBLIC_WEB_URL/,
    note: '靶子在 ⇒ 补丁仍能打；若 alreadyFixed 命中 ⇒ 上游原生支持了，补丁可退役',
  },
  {
    id: 'U3 agent-loop isOwned 不保护 message.source',
    pkg: 'dsh-agent-loop',
    file: 'lib/index.js',
    anchor: 'function isOwned(message) {\n\treturn message.source.kind === "plugin"',
    alreadyFixed: /message\?\.source\?\.kind/,
    note: '靶子在 + 未修 ⇒ 仍然需要我们的加固补丁（否则缺 source 的历史消息重放会把会话读崩）',
  },
  {
    id: 'BOM app-boot 裸 JSON.parse(readFileSync(...))',
    pkg: 'dsh-app-boot',
    file: 'lib/index.js',
    // ★ 第一版这里写的是 `JSON.parse(fs.readFileSync(` —— **多了一个 `fs.`**，在 0.1.1 与 0.1.5 里都不成立，
    //   于是它既不命中"靶子在"也不命中"已修"，报了一条**假红**。判据要来自真实文本，不是印象。
    anchor: 'JSON.parse(readFileSync(',
    alreadyFixed: /parseJsonNoBom|stripBom|\\\\uFEFF/,
    count: true,
    note: '靶子出现几处就说明**有几处**会被 BOM 崩（0.1.1 三处、0.1.5 四处）⇒ 升级时补丁要按处数重定位',
  },
]

let fails = 0
say('')
say('== A. 我们依赖的上游形状（必须命中）==')
for (const c of SHAPES) {
  const src = read(c.pkg, c.file)
  if (src === null) {
    say(`  FAIL  ${c.id}`)
    say(`        找不到 ${c.pkg}/${c.file}（包结构变了 ⇒ 必须人工复核）`)
    fails++
    continue
  }
  const hit = c.re.test(src)
  if (!hit) fails++
  say(`  ${hit ? 'ok  ' : 'FAIL'}  ${c.id}`)
  say(`        用途：${c.used}`)
}

say('')
say('== B. 我们打过的补丁的靶子（靶子在 ⇒ 升级后仍能打）==')
for (const c of PATCHES) {
  const src = read(c.pkg, c.file)
  if (src === null) {
    say(`  FAIL  ${c.id}: 找不到 ${c.pkg}/${c.file}`)
    fails++
    continue
  }
  const anchored = src.includes(c.anchor)
  const fixed = c.alreadyFixed.test(src)
  const occurrences = c.count ? src.split(c.anchor).length - 1 : null
  if (!anchored && !fixed) fails++
  say(`  ${anchored || fixed ? 'ok  ' : 'FAIL'}  ${c.id}`)
  say(
    `        靶子在=${anchored}${occurrences !== null ? `（${occurrences} 处）` : ''} · 上游已自行修好=${fixed} —— ${c.note}`,
  )
}

say('')
say('== C. 上游新增的模块（架构决策用：有没有现成的可少造轮子）==')
const localPkgs = new Set(fs.readdirSync(LOCAL_AI))
const added = Object.keys(dshReg.versions[version].dependencies).filter(
  (k) => k.startsWith('@deepseek-ai/') && !localPkgs.has(k.replace('@deepseek-ai/', '')),
)
for (const k of added) {
  let desc = ''
  try {
    const reg = await packument(k.replace('@deepseek-ai/', ''))
    desc = String(reg.versions?.[version]?.description ?? reg.description ?? '').split('\n')[0]
  } catch {
    /* 描述拿不到就算了 */
  }
  say(`  + ${k}\n      ${desc.slice(0, 130)}`)
}

say('')
say(
  fails
    ? `结论：A/B 两组里有 ${fails} 条**不成立** ⇒ 升级前必须逐条处理（形状变了要改我们的代码；补丁靶子没了要改锚点）。`
    : '结论：A/B 两组全部成立 ⇒ 升级不会静默打破我们的机制，补丁也仍能打（但这**不等于**"该升"）。',
)
fs.writeFileSync(path.join(OUT, 'upstream-drift-check.txt'), log.join('\n'), 'utf8')
say('→ out/upstream-drift-check.txt')
process.exit(fails ? 1 : 0)
