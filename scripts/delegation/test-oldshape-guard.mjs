// _probe-oldshape-guard.mjs —— 验证"旧形状 node_modules ⇒ 拒跑"，**并且证明它没删任何东西**
//
// 背景：旧版脚本把隔离实例的 node_modules 建成【指向现役的目录联接】。若操作者已有一个这样的旧产物，
// 再跑新脚本会走"幂等跳过"⇒ 产出"旧联接 + 新脚本"的混合体（假成功）。
// 修法 = **拒跑（fail-closed）**，且**不写任何删除代码**（递归删联接会顺着链删掉现役那层）。
// ⇒ 本判据要证两件：① 拒跑（exit 1 + 明确原因）；② ★ **目标层完好无损**（标记文件幸存）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const WT = 'D:/project_develop/dsh-brain'
const SCRIPT = path.join(WT, 'scripts/delegation/isolated-instance.mjs')
const NODE = process.execPath
const TMP = path.join(WT, 'out/_oldshape-probe')
fs.rmSync(TMP, { recursive: true, force: true })

// ① 造一个"假现役层"（带标记文件）+ 一个旧形状的隔离根（node_modules = 指向它的联接）
const FAKE_LIVE = path.join(TMP, 'fake-live-node_modules')
fs.mkdirSync(path.join(FAKE_LIVE, '@dsh-brain'), { recursive: true })
fs.writeFileSync(path.join(FAKE_LIVE, 'MARKER-KEEP-ME.txt'), '这个文件必须幸存\n', 'utf8')

const ROOT = path.join(TMP, 'a')
const PROFILE = path.join(ROOT, 'dshhome/profiles/web')
fs.mkdirSync(PROFILE, { recursive: true })
// 骨架（至少要 cordis.patch.yml 才走到 node_modules 那步）
fs.writeFileSync(path.join(PROFILE, 'cordis.patch.yml'), '- id: agent-default-model\n', 'utf8')
fs.writeFileSync(path.join(PROFILE, 'cordis.yml'), '[]\n', 'utf8')
fs.writeFileSync(path.join(ROOT, 'dshhome/settings.yaml'), 'agent-presets:\n  default: council\n', 'utf8')
// ★ 旧形状：node_modules 是一个【目录联接】指向 fake-live
fs.symlinkSync(FAKE_LIVE, path.join(PROFILE, 'node_modules'), 'junction')

const results = []
const check = (n, ok, detail) => { results.push({ n, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${n} — ${detail}`) }

// ★ 必须带 --force：否则会**先撞上**「dshhome 已存在且非空 ⇒ 拒绝覆盖」那道守卫，
//   根本走不到 node_modules 那一步。而"操作者手里已有旧产物、用 --force 重跑"正是本判据要覆盖的真实场景。
const r = spawnSync(NODE, [SCRIPT, '--arm', 'A', '--root', ROOT, '--force'], { encoding: 'utf8', timeout: 300000 })
const out = (r.stdout ?? '') + (r.stderr ?? '')

check('① 旧形状 ⇒ **拒跑**（非 0 退出）', r.status !== 0, `exit=${r.status}`)
check('② 原因明确（指向 existing-node-modules-is-a-symlink）', out.includes('existing-node-modules-is-a-symlink'), out.split('\n').filter((l) => l.includes('符号链接') || l.includes('existing-node')).slice(0, 1)[0] ?? '(没找到)')
check('③ ★★ **目标层完好**：假现役的标记文件仍存在', fs.existsSync(path.join(FAKE_LIVE, 'MARKER-KEEP-ME.txt')), '标记文件幸存 = 没删任何东西')
check('④ ★★ **目标层内容未被清空**：@dsh-brain 目录仍在', fs.existsSync(path.join(FAKE_LIVE, '@dsh-brain')), '')
check('⑤ 那个联接本身也还在（我们没动它，留给操作者自己摘）', fs.lstatSync(path.join(PROFILE, 'node_modules')).isSymbolicLink(), '')

const pass = results.filter((x) => x.ok).length
console.log(`\n结果：${pass}/${results.length} 通过`)
// ★ 清理：必须 recursive:true（本机 node 的 rmSync 对目录用 recursive:false 会报 EISDIR）；
//   临时目录内的联接目标也在本目录内 ⇒ 递归不会波及外面。
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(pass === results.length ? 0 : 1)
