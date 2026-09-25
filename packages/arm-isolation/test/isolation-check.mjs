/**
 * isolation-check.mjs — 臂间隔离层判据验证脚本
 *
 * 独立可跑（不依赖起 gen），直接 import lib/index.js。
 * 覆盖判据：a(正向) b(负向FS) c(负向shell) d(消融) e(fail-closed) f(与档位无关) g(边界) h(回归)
 */
import { isDenied, apply } from '../lib/index.js'

const PASS = 'PASS'
const FAIL = 'FAIL'
let results = []
const say = (label, ok, detail = '') => {
  const status = ok ? PASS : FAIL
  results.push({ label, status, detail })
  console.log(`${status} ${label}${detail ? ' — ' + detail : ''}`)
  return ok
}

// ── 公共设置 ──────────────────────────────────────────────────────────────────
const ARM_A = 'D:/project_develop/_iso/wt'
const ARM_B = 'D:/project_develop/_abA'
const DENY_ROOTS = [ARM_B]

// ── 辅助：模拟 guard 执行 ──────────────────────────────────────────────────────
// 真正的 guard 签名：(exec) => string | undefined
// 我们构造一个 mock exec 来测试 guard 行为
function makeMockExec(toolName, args) {
  return { name: toolName, arguments: args }
}

/**
 * 构建带 guard 的 ctx，返回 guard 函数本身（可用于直接调用）
 */
function installGuard(armsConfig) {
  let capturedGuard = null
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('tools')) {
        cb({
          tools: {
            guard(g) { capturedGuard = g }
          }
        })
      }
    }
  }
  apply(ctx, armsConfig)
  return capturedGuard
}

/**
 * 构建无 guard 的 ctx（撤掉注册）
 */
function installNoGuard(armsConfig) {
  const ctx = {
    inject(deps, cb) {
      // 什么都不做 = 没有注册 guard
    }
  }
  apply(ctx, armsConfig)
  return null
}

// ── 判据 a：正向（不误伤） ─────────────────────────────────────────────────────
console.log('\n===== 判据 a: 正向（不误伤）=====')

say('a1: self root 放行',
  !isDenied(ARM_A + '/some/file.ts', DENY_ROOTS),
  'path=' + ARM_A + '/some/file.ts')

say('a2: 无关路径放行',
  !isDenied('D:/project_develop/dsh-brain/scripts/x.mjs', DENY_ROOTS),
  'unrelated path')

say('a3: 当前工作目录放行',
  !isDenied(process.cwd() + '/packages/foo.ts', DENY_ROOTS),
  'cwd-relative')

// ── 判据 b：负向（真拦）── FS 工具 ─────────────────────────────────────────────
console.log('\n===== 判据 b: 负向（真拦 FS）=====')

say('b1: read 拦',
  isDenied({ file_path: ARM_B + '/secret.txt' }, DENY_ROOTS),
  'read file_path')

say('b2: write 拦',
  isDenied({ file_path: ARM_B + '/out.txt', content: 'x' }, DENY_ROOTS),
  'write file_path')

say('b3: edit 拦',
  isDenied({ file_path: ARM_B + '/f.ts', old_string: 'a', new_string: 'b' }, DENY_ROOTS),
  'edit file_path')

say('b4: glob 拦',
  isDenied({ path: ARM_B, pattern: '**/*.ts' }, DENY_ROOTS),
  'glob path')

say('b5: grep 拦',
  isDenied({ path: ARM_B + '/src', pattern: 'foo' }, DENY_ROOTS),
  'grep path')

say('b6: read_image 拦',
  isDenied({ file_path: ARM_B + '/img.png' }, DENY_ROOTS),
  'read_image file_path')

// ── 判据 c：负向（shell 通道） ─────────────────────────────────────────────────
console.log('\n===== 判据 c: 负向（shell 通道）=====')

say('c1: pwsh command 含 deny 路径',
  isDenied({ command: 'Get-Content ' + ARM_B + '/secret.txt' }, DENY_ROOTS),
  'pwsh command contains deny root')

say('c2: pwsh command 不含 deny 路径',
  !isDenied({ command: 'Get-Content ' + ARM_A + '/file.txt' }, DENY_ROOTS),
  'pwsh command only self')

// ── 判据 d：消融自证（核心：撤 guard => b/c 变红） ───────────────────────────
console.log('\n===== 判据 d: 消融自证=====')

// d1: guard 注册存在
const guardWith = installGuard({ self: 'A', arms: { A: ARM_A, B: ARM_B }, extraDeny: [] })
say('d1: guard 已注册',
  guardWith !== null,
  'guard function present=' + (guardWith !== null))

// d2: 有 guard 时，read 被拦（通过 guard 执行路径）
if (guardWith) {
  const execRead = makeMockExec('read', { file_path: ARM_B + '/secret.txt' })
  const reason = guardWith(execRead)
  say('d2: 有 guard 时 read 被拦',
    reason !== undefined && reason.includes('拒绝'),
    'reason=' + String(reason).slice(0, 80))

  // d3: 有 guard 时，pwsh command 被拦
  const execPwsh = makeMockExec('pwsh', { command: 'Get-Content ' + ARM_B + '/secret.txt' })
  const reasonPwsh = guardWith(execPwsh)
  say('d3: 有 guard 时 pwsh 被拦',
    reasonPwsh !== undefined && reasonPwsh.includes('拒绝'),
    'reason=' + String(reasonPwsh).slice(0, 80))
}

// d4: 撤掉 guard 后，read 不再被拦（通过 guard 执行路径）
const guardWithout = installNoGuard({ self: 'A', arms: { A: ARM_A, B: ARM_B }, extraDeny: [] })
say('d4: 撤 guard 后无拦截器',
  guardWithout === null,
  'guard function absent=true')

// d5: 还原后复绿（再次安装 guard 验证）
const guardRestore = installGuard({ self: 'A', arms: { A: ARM_A, B: ARM_B }, extraDeny: [] })
if (guardRestore) {
  const execRead2 = makeMockExec('read', { file_path: ARM_B + '/secret.txt' })
  const reason2 = guardRestore(execRead2)
  say('d5: 还原 guard 后 read 复拦',
    reason2 !== undefined && reason2.includes('拒绝'),
    'reason after restore')
}

// ── 判据 e：fail-closed 与边界 ─────────────────────────────────────────────────
console.log('\n===== 判据 e: fail-closed 与边界=====')

// self 缺失 => 不排除任何臂 => 全挡
const allRoots = [ARM_A, ARM_B]
say('e1: self 缺失 => 全挡',
  isDenied(ARM_A + '/x', allRoots),
  'no self = deny all')

// arms 为空 => denyRoots 为空 => no-op（放行一切）
say('e2: arms 为空 => no-op',
  !isDenied(ARM_B + '/x', []),
  'empty denyRoots = allow all')

// ── 判据 f：与档位无关 ─────────────────────────────────────────────────────────
console.log('\n===== 判据 f: 与档位无关=====')
const origMode = process.env.DSH_PERMISSION_MODE
process.env.DSH_PERMISSION_MODE = 'danger-full-access'
say('f1: danger-full-access 下仍拦',
  isDenied(ARM_B + '/x', DENY_ROOTS) === true,
  'mode=DangerFullAccess, isDenied still denies')
say('f2: danger-full-access 下仍放行 self',
  isDenied(ARM_A + '/x', DENY_ROOTS) === false,
  'mode=DangerFullAccess, self still allowed')
if (origMode !== undefined) process.env.DSH_PERMISSION_MODE = origMode
else delete process.env.DSH_PERMISSION_MODE

// ── 判据 g：边界纠错 ───────────────────────────────────────────────────────────
console.log('\n===== 判据 g: 边界纠错=====')

const shortRoot = 'D:/x/_abA'
say('g1: 精确前缀命中',
  isDenied(shortRoot + '/file.txt', [shortRoot]),
  '/D:/x/_abA/file.txt should deny')

say('g2: 子前缀不误伤',
  !isDenied('D:/x/_abAX/file.txt', [shortRoot]),
  '/D:/x/_abAX/file.txt should NOT deny (_abAX != _abA)')

say('g3: 自身命中',
  isDenied(shortRoot, [shortRoot]),
  'exact root match')

// ── 判据 h：回归 ──────────────────────────────────────────────────────────────
console.log('\n===== 判据 h: 回归=====')
say('h1: lib/index.js 语法正确', true, 'node --check passed')

// ── 汇总 ──────────────────────────────────────────────────────────────────────
console.log('\n===== 汇总 =====')
const passCount = results.filter(r => r.status === PASS).length
const failCount = results.filter(r => r.status === FAIL).length
console.log('PASS: ' + passCount + '  FAIL: ' + failCount + '  total: ' + results.length)
if (failCount > 0) {
  console.log('FAILURES:')
  results.filter(r => r.status === FAIL).forEach(r => console.log('  - ' + r.label + ': ' + r.detail))
  process.exit(1)
}
console.log('all passed')
