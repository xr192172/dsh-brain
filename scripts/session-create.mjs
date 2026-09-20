#!/usr/bin/env node
/**
 * session-create.mjs —— 经前门 RPC 建一个**空会话**并打印它的 id。
 *
 * 为什么单独做一个脚本：实验（`eval-run.mjs`）必须用**专门的新建空会话**——
 * 拿在用的会话做题面会把测试记录写进真实历史，而且会话自带历史 ⇒ 两臂不可比。
 * （`session.create` 空载荷即通；这是主干会话在 §1.6 实测出来的用法。）
 *
 * 用法：
 *   node scripts/session-create.mjs                 # 建一个，打印 id
 *   node scripts/session-create.mjs --cwd <路径>    # 指定工作目录（默认当前仓库）
 */
import { randomUUID } from 'node:crypto'

const FRONT = process.env.DSH_FRONT ?? 'http://127.0.0.1:3080'
const argv = process.argv.slice(2)
const i = argv.indexOf('--cwd')
const payload = i >= 0 ? { cwd: argv[i + 1] } : {}

const res = await fetch(`${FRONT}/api/session.create`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.create', payload }),
})
const text = await res.text()
let j = null
try {
  j = JSON.parse(text)
} catch {
  /* 非 JSON */
}
const id = j?.result?.value?.sessionId ?? j?.result?.value?.id ?? j?.result?.sessionId ?? null
if (res.status !== 200 || !id) {
  console.error(`建会话失败：HTTP ${res.status}\n${text.slice(0, 600)}`)
  process.exit(1)
}
console.log(id)
