// 一次性修正 web profile manifest：
//  1) 移除悬空的 @dsh-brain/handover-agent 依赖（包已并入 @dsh-brain/switchboard）
//  2) 显式钉住 @deepseek-ai/dsh-base（原生工具来源，摆脱 hoist 隐式依赖）
//  3) 确保无 UTF-8 BOM（DSH readProfileManifest JSON.parse 会因 BOM 崩溃）
// 工作目录受限，本脚本在 D:\project_develop\dsh-brain 下执行，直写外部 profile 路径。
import fs from 'node:fs'
import path from 'node:path'

const file = 'C:/Users/Admin/.dsh/profiles/web/package.json'
const raw = fs.readFileSync(file, 'utf8')
const stripped = raw.replace(/^\uFEFF/, '')
const j = JSON.parse(stripped)

const deps = j.dependencies ?? {}
delete deps['@dsh-brain/handover-agent']               // 包已并入 switchboard，遗留悬空依赖
deps['@deepseek-ai/dsh-base'] = 'link:C:/Users/Admin/.dsh/profiles/node_modules/@deepseek-ai/dsh-base'
j.dependencies = deps

// bundles：确保 dsh-base 已在（原生工具 bundle），如缺则补
const bundles = j.dsh?.profile?.bundles ?? []
if (!bundles.includes('@deepseek-ai/dsh-base')) {
  j.dsh = j.dsh ?? {}
  j.dsh.profile = j.dsh.profile ?? {}
  j.dsh.profile.bundles = ['@deepseek-ai/dsh-base', ...bundles]
}

fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8') // 无 BOM
console.log(`patched ${path.basename(file)}`)
console.log('  deps:', Object.keys(deps).join(', '))
console.log('  bundles:', (j.dsh?.profile?.bundles ?? []).join(', '))
// 自检 BOM
const chk = fs.readFileSync(file, 'utf8')
console.log('  BOM:', chk.charCodeAt(0) === 0xfeff ? 'PRESENT(bad)' : 'none(ok)')