// patch-app-boot-bom: 给 @deepseek-ai/dsh-app-boot 的 JSON 清单读取加统一 BOM 防护。
//
// 背景（2026-09-14）：
//   DSH 启动时会读若干 package.json（app anchor / profile manifest / 每个 bundle 的 manifest）。
//   这些文件若带 UTF-8 BOM(EF BB BF)，JSON.parse 会在首字节抛
//     SyntaxError: Unexpected token '\uFEFF'
//   → readProfileManifest / loadProfile 直接抛 → 整个 gen 起不来（实测 gen-3085 / gen-3091）。
//
//   写入方是谁：Windows 侧几乎所有"顺手写 JSON"的工具都可能加 BOM ——
//   PowerShell 5.1 的 `Set-Content -Encoding UTF8`、记事本"UTF-8"、部分编辑器插件。
//   （我们自己的 scripts/patch-profile-deps.mjs 已经刻意规避了这一条。）
//
//   上游原本只防护了 readProfileManifest 一处，另外三处仍裸调 JSON.parse：
//     :412 healProfilesModuleFallback  appManifest
//     :430 healProfilesModuleFallback  依赖遍历 manifest
//     :551 loadProfile                 bundle 包的 package.json
//
// 做法（幂等、最小侵入）：抽两个 helper，把 4 处解析统一走它们。
//   重复执行安全：已打补丁时直接跳过。
//
// 注意：这是直接改 node_modules，npm install 会被冲掉 —— 已挂到 package.json 的 postinstall。
import fs from 'node:fs'

// profiles/node_modules/@deepseek-ai/* 是指向 dsh-brain/node_modules 的 junction，
// 内容同一份文件；两个路径都探一下只是为了在 junction 布局变化时也能命中。
const PATHS = [
  'D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'C:/Users/Admin/.dsh/profiles/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
]

const MARK = 'function parseJsonNoBom('

const HELPER = `/**
* BOM 防护（本地补丁，见 scripts/patch-app-boot-bom.mjs）：
* Windows 侧写入方（PowerShell 5.1 的 Set-Content -Encoding UTF8、记事本等）可能给
* package.json 落 UTF-8 BOM(EF BB BF)；JSON.parse 对首字节 '\\uFEFF' 会抛
* "SyntaxError: Unexpected token" 导致整个 gen 起不来。统一在这里剥掉。
*/
function parseJsonNoBom(raw) {
	return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}
function readJsonManifest(file) {
	return parseJsonNoBom(readFileSync(file, "utf8"));
}
`

// [锚点, 替换后]；锚点必须唯一且存在，否则报告未命中（避免上游改动后静默打歪）
const EDITS = [
  [
    'const appManifest = JSON.parse(readFileSync(installAnchor, "utf8"));',
    'const appManifest = readJsonManifest(installAnchor);',
  ],
  [
    'manifest: JSON.parse(readFileSync(manifestPath, "utf8"))',
    'manifest: readJsonManifest(manifestPath)',
  ],
  [
    'const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;',
    'const declared = readJsonManifest(join(packageDir, "package.json")).dsh?.bundle?.patch;',
  ],
  [
    '\tif (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);\n\tconst parsed = JSON.parse(raw);',
    '\tconst parsed = parseJsonNoBom(raw);',
  ],
]

// helper 插在 readProfileManifest 的 JSDoc 之前
const HELPER_ANCHOR = '/**\n* Read a profile\'s manifest.'

let touched = 0
for (const p of PATHS) {
  if (!fs.existsSync(p)) { console.log(`skip    missing: ${p}`); continue }
  let c = fs.readFileSync(p, 'utf8')

  if (c.includes(MARK)) { console.log(`skip    already patched: ${p}`); continue }

  if (!c.includes(HELPER_ANCHOR)) {
    console.log(`FAIL    ${p}\n        helper anchor not found — 上游结构可能已变，请人工核对`)
    continue
  }
  c = c.replace(HELPER_ANCHOR, HELPER + HELPER_ANCHOR)

  let hit = 0
  for (const [from, to] of EDITS) {
    if (!c.includes(from)) {
      console.log(`WARN    ${p}\n        edit anchor not found: ${from.slice(0, 70)}...`)
      continue
    }
    c = c.replace(from, to)
    hit += 1
  }

  fs.writeFileSync(p, c, 'utf8')
  console.log(`patched ${p}  (edits applied: ${hit}/${EDITS.length})`)
  touched += 1
}

console.log(touched ? `done, ${touched} file(s) patched` : 'done, nothing to do')
