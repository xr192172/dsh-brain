/**
 * arm-ports.mjs —— **训练场端口/根目录的唯一定义**（纯模块，**无副作用，可安全 import**）。
 *
 * ★ 为什么单独一个文件（而不是从 `arm-up.mjs` import）：
 *   `arm-up.mjs` **有顶层主流程** ⇒ 一 `import` 它就会**真去起服务**。
 *   （这正是 2026-09-25 修 `skill-sieve.mjs` 时踩过的同一个坑：**脚本必须 import-safe**。）
 *   ⇒ 凡"要被多处共用的推导"，都放这里；**算法只有一份**，谁都不许再写第二遍。
 *
 * 使用者：`scripts/arm-up.mjs`（启动器）、`scripts/delegation/dsh-delegate.mjs`（派活要按臂名找到同一个实例）。
 */

/** 现役占用的端口 —— 派生结果**不许落进来**（实测：池端口曾抢现役的 3101，现役前门整个掉）。 */
export const LIVE_PORTS = new Set([3080, 3081, 3101, 31800, 31810])

/** 现役（`--live` 模式）的地址与 DSH_HOME。 */
export const LIVE_SPEC = {
  arm: '(live)',
  dshHome: 'C:\\Users\\Admin\\.dsh',
  switchboardDir: 'C:\\Users\\Admin\\.dsh\\switchboard',
  ports: { base: 3080, genBase: 3081, pool: 3101, admin: 31800, handover: 31810, env: {} },
  front: 'http://127.0.0.1:3080',
  admin: 'http://127.0.0.1:31800',
}

/**
 * ★★ **唯一的推导**：臂名 + 臂清单 ⇒ 整段端口。**外部不再给任何端口变量。**
 * 步长 40：switch=base ／ gen=base+1 ／ **pool=base+21** ／ admin=base+100 ／ handover=base+110。
 */
export function portsForArm(armName, allArms) {
  const idx = Math.max(0, allArms.indexOf(armName))
  const base = 33080 + idx * 40
  return {
    base,
    env: {
      SWITCH_PORT: String(base),
      GEN_PORT_BASE: String(base + 1),
      SWITCH_ADMIN_PORT: String(base + 100),
      HANDOVER_ADMIN_PORT_BASE: String(base + 110),
      DSH_PUBLIC_WEB_URL: `http://127.0.0.1:${base}`,
    },
    front: `http://127.0.0.1:${base}`,
    admin: `http://127.0.0.1:${base + 100}`,
    pool: base + 21,
    genBase: base + 1,
  }
}

/** 该臂的根目录（与 `isolated-instance.mjs` 的 `DEFAULT_ROOT` 一致）。 */
export const rootForArm = (armName) => `D:/project_develop/_arms/${String(armName).toLowerCase()}`

/** 该臂的 DSH_HOME 与 switchboard 目录（派活/读日志都要用）。 */
export const dshHomeForArm = (armName) => `${rootForArm(armName)}/dshhome`
export const switchboardDirForArm = (armName) => `${dshHomeForArm(armName)}/switchboard`

/** 该臂的 `DSH_ARM_DENY`（其它臂的 cwd+store，逗号分隔）。★ 与 `isolated-instance` 同一算法。 */
export function denyForArm(armName, arms) {
  const out = []
  for (const a of arms ?? []) {
    if (a.name === armName) continue
    if (a.cwd && String(a.cwd).trim()) out.push(String(a.cwd).trim())
    if (a.store && String(a.store).trim()) out.push(String(a.store).trim())
  }
  return out.join(',')
}
