// 诊断 D:\project_develop 根目录：条目名精确字符 + 类型 + 大小 + git 状态
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:\\project_develop'
const out = { root: ROOT, entries: [], warnings: [] }

function sizeOf(p) {
  let bytes = 0, files = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop()
    let st
    try { st = fs.lstatSync(cur) } catch { continue }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      let kids = []
      try { kids = fs.readdirSync(cur) } catch { continue }
      for (const k of kids) stack.push(path.join(cur, k))
    } else if (st.isFile()) { bytes += st.size; files++ }
  }
  return { bytes, files }
}

function codePoints(s) {
  return [...s].map(c => {
    const cp = c.codePointAt(0)
    return cp > 126 || cp < 32 ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : null
  }).filter(Boolean)
}

for (const name of fs.readdirSync(ROOT)) {
  const full = path.join(ROOT, name)
  let st
  try { st = fs.lstatSync(full) } catch (e) { out.warnings.push(`${name}: lstat fail ${e.message}`); continue }
  const e = {
    name,
    oddChars: codePoints(name),
    rawLen: name.length,
    type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file',
    linkTarget: st.isSymbolicLink() ? (fs.readlinkSync(full) || '') : undefined,
    mtime: st.mtime.toISOString().slice(0, 16),
  }
  if (e.type === 'dir') {
    const s = sizeOf(full)
    e.mb = +(s.bytes / 1048576).toFixed(1)
    e.files = s.files
    e.hasGitDir = fs.existsSync(path.join(full, '.git', 'HEAD'))
    e.hasGitFile = fs.existsSync(path.join(full, '.git')) && !e.hasGitDir
    if (e.hasGitDir) {
      const g = (...a) => { try { return execFileSync('git', ['-C', full, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch (err) { return `<${(err.message || '').split('\n')[0].slice(0, 90)}>` } }
      e.head = g('log', '--oneline', '-1')
      e.branch = g('rev-parse', '--abbrev-ref', 'HEAD')
      e.origin = g('remote', 'get-url', 'origin')
      e.dirty = g('status', '--porcelain').split('\n').filter(Boolean).length
      e.aheadBehind = g('rev-list', '--left-right', '--count', 'origin/HEAD...HEAD')
    }
  } else if (e.type === 'file') {
    e.mb = +(st.size / 1048576).toFixed(3)
    e.files = 1
  }
  out.entries.push(e)
}

out.entries.sort((a, b) => (b.mb || 0) - (a.mb || 0))
fs.writeFileSync('D:\\project_develop\\dsh-brain\\out\\root-diag.json', JSON.stringify(out, null, 2), 'utf8')
fs.writeFileSync('D:\\project_develop\\dsh-brain\\out\\root-diag.txt',
  out.entries.map(e => [
    (e.mb ?? 0).toString().padStart(9),
    String(e.files ?? '').padStart(6),
    e.type.padEnd(5),
    (e.dirty ?? '-').toString().padStart(4),
    (e.mtime || ''),
    e.name,
    e.oddChars.length ? `  <<ODD:${e.oddChars.join(',')}>>` : '',
    e.linkTarget ? `  -> ${e.linkTarget}` : '',
    e.hasGitDir ? `\n            head=${e.head}  branch=${e.branch}\n            origin=${e.origin}  abc=${e.aheadBehind}` : (e.hasGitFile ? '\n            .git 是文件（gitlink/submodule?）' : '\n            (无 .git)'),
  ].join(' ')).join('\n'), 'utf8')
console.log('written')
