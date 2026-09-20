#!/usr/bin/env node
/**
 * capability-store.mjs —— 能力库（`~/.dsh/capabilities/registry.json`）的唯一读写口
 *
 * ## 为什么要抽出来（回执 B3）
 *
 * `~/.dsh/capabilities/` 是**共享可变状态**：运行中的 gen、自进化子 agent、别的会话
 * 都会同时读写它。回执里记的两条证据 —— 目录里长期残留 `registry.json.7272.tmp`、
 * `registry.json` 的 `updatedAt` 在实验窗口内被改过多次 —— 都指向同一件事：
 * **写侧/读侧都没有把"写到一半"当成一种会发生的常态。**
 *
 * ## 这里保证什么（也就保证这些，多一分不说）
 *
 * 写侧 `atomicWriteJson`
 *   - tmp → fsync → rename：**读者永远看不到半文件**（rename 在同目录是原子的）。
 *   - **失败不留残 tmp**：任何一步抛错都把 tmp 收走。回执里那条 `.7272.tmp` 就是
 *     以前"写完 tmp 但 rename 没走到"留下的 —— 它不是脏数据，却是"这里崩过"的体检阳性指标。
 *   - tmp 名字带随机后缀：两个进程同 pid 号也不会互相踩。
 *
 * 读侧 `readJsonTolerant`
 *   - **从不裸抛**。返回 `{ ok:false, reason, detail }`，`detail` 里给字节数、
 *     头尾片段、同目录 `.tmp`  siblings —— 出问题时够指着报错而不是猜。
 *   - `missing` / `empty` / `malformed` 三种坏法分开报，因为补救方式不同。
 *   - 会对 `malformed` 重试几次（默认 3 次 × 20ms）：并发写者 rename 的那一瞬间
 *     可能抓到"正在被替换"的中间态，重读比报错更接近真相。
 *
 * ★★ 刻意**不**做的事：**半文件不兜底成空库。** 读到坏 JSON 就 fail-closed 报错。
 *    静默当成"还没有能力库"会让门继续往一个坏库里写 —— 那就是"保险自己失效"，
 *    本项目已经交过两次学费了。
 *
 * ★ 本文件只导出纯函数，不自己决定退出码 —— 那是调用方（各脚本）的事。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 同步睡（不引依赖，不占事件循环）。Atomics.wait 在主线程可用。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function randomSuffix() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 写字节到临时文件，并在 rename **之前** fsync。
 * fsync 的意义：没有它，掉电/蓝屏后 rename 出来的可能是一个 0 字节的 registry.json。
 */
function writeFileFsync(p, text) {
  const fd = fs.openSync(p, 'w')
  try {
    fs.writeSync(fd, text, 0, Buffer.byteLength(text, 'utf8'))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 原子写一个 JSON 文件（tmp + fsync + rename）。失败时**不留残 tmp**。
 *
 * @param {string} file   目标文件（目录不存在会创建）
 * @param {any}    value  可 JSON 序列化的值
 * @returns {{ ok: true, bytes: number }}
 * @throws {Error} 写或 rename 失败 —— 临时文件已回滚后才抛
 */
export function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${randomSuffix()}.tmp`
  try {
    writeFileFsync(tmp, JSON.stringify(value, null, 2) + '\n')
    fs.renameSync(tmp, file)
    return { ok: true, bytes: fs.statSync(file).size }
  } catch (e) {
    // ★ 失败必须把 tmp 收走，否则下次看到的就是"这里曾经崩过"的唯一证据
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 到这步已经是在收拾残局，收拾不掉也不该盖掉原始错误 */
    }
    throw new Error(`[capability-store] 原子写失败：${file} — ${e.message}（临时文件已回收，目标文件未被改动）`)
  }
}

function tmpSiblings(file) {
  const base = path.basename(file)
  try {
    return fs
      .readdirSync(path.dirname(file))
      .filter((n) => n.startsWith(base) && n.endsWith('.tmp'))
  } catch {
    return []
  }
}

/** 单次尝试。返回 { ok, data } 或 { ok:false, reason, detail }，从不抛。 */
function tryReadOnce(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'missing', detail: { file, bytes: 0 } }
    return { ok: false, reason: 'malformed', detail: { file, bytes: -1, readError: `${e.code ?? ''} ${e.message}`, siblings: tmpSiblings(file) } }
  }

  const text = buf.toString('utf8').replace(/^\uFEFF/, '')
  if (!text.trim()) {
    return { ok: false, reason: 'empty', detail: { file, bytes: buf.length, siblings: tmpSiblings(file), hint: '文件是空的 —— 典型地是写到一半被打断，或 rename 前被读了' } }
  }

  try {
    return { ok: true, data: JSON.parse(text) }
  } catch (e) {
    return {
      ok: false,
      reason: 'malformed',
      detail: {
        file,
        bytes: buf.length,
        parseError: e.message,
        head: text.slice(0, 80),
        tail: text.slice(-80),
        siblings: tmpSiblings(file),
        hint: '读到半文件 / 损坏 JSON —— 没当成空库，也没覆盖：目标文件保持原样',
      },
    }
  }
}

/**
 * 容忍半文件的 JSON 读。**从不抛。**
 *
 * @param {string} file
 * @param {{ retries?: number, delayMs?: number }} [opts]
 * @returns {{ ok: true, data: any } | { ok: false, reason: 'missing'|'empty'|'malformed', detail: object }}
 */
export function readJsonTolerant(file, opts = {}) {
  const attempts = opts.retries ?? 3
  const delayMs = opts.delayMs ?? 20
  let last = null
  for (let i = 0; i < attempts; i++) {
    const r = tryReadOnce(file)
    // missing 重试也没用（等不来），读到就返回
    if (r.ok || r.reason === 'missing') return r
    last = r
    if (i < attempts - 1) sleepSync(delayMs)
  }
  return last
}

/** 把读失败的结果渲染成**可指着看**的诊断文本。 */
export function formatReadFailure(res) {
  const d = res.detail ?? {}
  const lines = [
    `X 读能力库失败（reason=${res.reason}）：${d.file}`,
    `   字节数      : ${d.bytes}`,
  ]
  if (d.readError) lines.push(`   读错误      : ${d.readError}`)
  if (d.parseError) lines.push(`   解析错误    : ${d.parseError}`)
  if (d.head) lines.push(`   开头 80 字  : ${JSON.stringify(d.head)}`)
  if (d.tail) lines.push(`   结尾 80 字  : ${JSON.stringify(d.tail)}`)
  if (d.siblings?.length) lines.push(`   同目录残留  : ${d.siblings.join(', ')}  ← 有写者在半路崩过`)
  if (d.hint) lines.push(`   提示        : ${d.hint}`)
  lines.push('   处置        ：未改动目标文件。确认后可从备份/快照恢复，或人工修复 JSON。')
  return lines.join('\n')
}
