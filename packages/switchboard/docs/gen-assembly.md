# 代装配清单（gen-assembly）——「模型接入 / key 池属于代，不属于控制面」

> 2026-09-24。本文件是这条子系统的**一等公民文档**：边界、契约、不变量、失败分类学，
> 以及"改一个池配置、换代即生效"为什么成立。

## 1. 它解决什么

审阅者给这一层的原话定位：

> 「这个控制面其实就是做一个 DSH 启动器，然后 DSH 启动器通过【遥控器】——就是插件的方式——
> 给 DSH 植入一个遥控器，然后每一代分别持有不同的遥控器，然后对其他的代进行开启和关闭以及测试。」

⇒ 控制面 = **启动器 + 遥控器**。它负责起代、换代、开关代。
**模型接入（provider / 模型 / key 池）不是"控制面的装配"，而是"一代的内容"。**

拆之前的样子（病）：

- 控制面与代**共用同一个 profile**（`WEB_PROFILE`，默认 `web`）；
- key 池的凭据来自**控制面进程自己的环境变量**（`GEN_ENV_EXTRA` → `AGENTSHELL_MAIN_LLM_API_KEYS`）；
- `key-pool-proxy` 的 insert 就写在那个共用 profile 的 `cordis.patch.yml` 里。

后果：改 provider / 换模型 / 换池口 / 换 key ⇒ 都要求**重启控制面**才会被读到。
而"重启控制面"是整套栈重来——恰恰是本项目最想避免的动作（它有验证闸和回滚的那条路叫**换代**，不叫重启）。

⇒ 于是"改模型"被错配到了一条没有验证闸、没有回滚、且代价最高的路径上。

## 2. 边界：拆的是**哪一层**

```
                   ┌──────────────── 控制面（长期存活，重启代价最高）────────────────┐
   WEB_PROFILE ──▶ │  profile = 控制剖面（最小集）：框架 + web-app + switchboard     │
                   │  ★ 不含 key-pool-proxy、不含任何 provider/凭据                  │
                   └───────────────┬────────────────────────────────────────────────┘
                                   │  每次 spawn 一个代时，读一次清单（INV-B）
                                   ▼
                   GEN_ASSEMBLY ──▶ gen-assembly.json（模型接入 / key 池的唯一入口）
                                   │      profile? · patches? · envFiles? · pool · model
                                   │
                        resolveGenSpawnSpec()  ── 纯函数：清单 + 本代端口 ──▶ spawn 规格
                                   │        · profile       （脑剖面）
                                   │        · extraPatches  （清单 patches + 渲染出的本代 overlay）
                                   │        · envExtra      （清单 envFiles 解出的 key 池/凭据）
                                   │        · poolPort      （= genPort + portOffset，派生）
                                   ▼
                   ┌──────────────── 代（可随时换代，有验证闸 + 回滚）──────────────┐
                   │  profile = 清单声明的脑剖面（缺省回落到控制剖面）               │
                   │  --patch <本代 assembly-overlay.yml>                            │
                   │  key-pool-proxy 装在**本代进程内**，端口 = 本代派生池口         │
                   └────────────────────────────────────────────────────────────────┘
```

⇒ **改清单 = 换代**（走既有 `?cmd=apply` / `?cmd=restart`，有 preflight 先验、有回滚）。
**控制面进程从头到尾不重启。**

## 3. 文件职责

| 文件 | 角色 |
|---|---|
| `src/gen-assembly.ts` | **契约层 + 渲染器**：类型、解析、`?cmd=assembly` 投影、spawn 规格解析。value 面全是纯函数 |
| `src/main.ts` | 控制面：把 `GEN_ASSEMBLY` 传给协调器与预演；新增只读命令 `?cmd=assembly` |
| `src/coordinator.ts` | 换代引擎：在 `handover()` 的 **spawn 那一刻**解析清单（不是 boot 那一刻） |
| `src/preflight.ts` | 预演体检：预演的就是**当前这份清单**（与换代共用清单与渲染器） |
| `test/gen-assembly.test.mjs` | 纯函数单测，重点守红向（该抛就抛）与"池口随代走" |
| `out/_B2/lab/setup-iso.mjs`（实验） | 搭一个**隔离 DSH_HOME**：控制剖面里没有池、没有 provider，用来实测本层 |

## 4. 硬不变量

**INV-A —— 控制面最小集不含模型接入。**
控制面进程**不读 key、不装池**。清单缺省 / 文件不存在 ⇒ 控制面以**最小集**启动并照常服务、照常换代，
只是没有模型接入。这条有两个可执行核对面：

- 静态：`dsh --profile <ctrl> --dump-config` 里 `key-pool-proxy` 命中 **0**；
- 运行时：`?cmd=assembly` 的 `controlPlaneEnvHit` 为空数组（探的是控制面**进程 env**，不是配置文件）。

**INV-B —— 每次 spawn 必重读。**
`gen-assembly.ts` 的 value 面全是纯函数；读盘发生在 `coordinator.handover()` / `PreflightRunner.run()` /
`boot()` 里 **spawn 的那一刻**，**绝不**在控制面 boot 时缓存成 `config`。
若在 boot 时缓存，清单就又变回"控制面启动时钉住的东西"——等于把病原地复活（只是从 profile 搬到了变量）。
bootstrap 代与换代代走**同一条**解析路径，就是为了让这条没有例外。

**INV-C —— 坏清单必须响。**
解析失败 ⇒ 抛错并 abort 该次换代；`envFiles` 里声明了却不存在的文件、`patches` 里声明了却不存在的路径，
**同样抛错**。绝不"降级成最小集接着换"——那会把一次配置笔误静默地变成一次
"服务能力被拔掉"的上线（前门切到一代没有模型接入的脑，而运维以为自己只是改了个 key）。

**INV-D —— 池口随代派生，不固定。**
`poolPort = genPort + portOffset`（或 `explicitPort`）。
固定池口会让池退化成**控制面级共享资源**：多代并存时要靠 `EADDRINUSE` 容忍 + freeze/promote 事件去抢它，
且那个端口因此必须被 `RESERVED_GEN_PORTS` 永久保留（见 `coordinator.ts` 的事故注释）。
派生之后 `gen-3071` 的池在 `3171`、`gen-3072` 的池在 `3172`，并存互不打扰，端口也不必再为池让路。

## 5. 契约：清单形状

```jsonc
{
  "version": "iso-v1",              // 必填。用于在日志/报告里指认"这次换代用的是哪一版装配"
  "profile": "ctrl",                // 可选。脑剖面；缺省 ⇒ 回落控制剖面（最小集）
  "patches": ["C:/.../extra.yml"],  // 可选。代额外 overlay（绝对或相对清单文件）
  "envFiles": ["C:/.../pool.env"],  // 可选。★ key 池与凭据住在这里
  "env": { "SOME_FLAG": "1" },      // 可选。非机密内联项
  "pool": {
    "enabled": true,                // ★ 缺省（不写）= 不装池。这正是"最小集"形态
    "portOffset": 100,              // 池口 = 本代端口 + 100
    "explicitPort": 31999,          // 与 portOffset 二选一，优先
    "upstreamBase": "http://127.0.0.1:33999",
    "poolEnv": "AGENTSHELL_MAIN_LLM_API_KEYS",
    "fallbackEnvs": ["AGENTSHELL_MAIN_LLM_API_KEY"],
    "cooldownMs": 15000, "maxRetries": 3, "retryStatuses": [429, 500, 502, 503, 504]
  },
  "model": {
    "provider": "agnes", "id": "agnes-2.5-flash",
    "routeThroughPool": true,        // ★ 缺省当 true（有池时）：baseURL 自动指向**本代**池
    "baseURL": "...",                // 显式给出则优先于池路由
    "apiKeyEnv": "AGENTSHELL_MAIN_LLM_API_KEY"
  }
}
```

**env 合并顺序（低 → 高）**：调用方 `baseEnv` → 清单 `envFiles`（解 `.env`）→ 清单 `env` 内联。
`envFiles` 里任何一个文件不存在 ⇒ 抛（INV-C）——"代没有 key 池就不能起"好过"起了个哑代"。

**渲染出的本代 overlay**（`<genDir>/assembly-overlay.yml`，形状与
`packages/key-pool-proxy/cordis.patch.yml` 的 insert **逐字段对应**，
差异只有 `port` 来自本代派生值、`upstreamBase` 来自清单）：

```yaml
- insert:
    - id: key-pool-proxy
      name: '@dsh-brain/key-pool-proxy'
      config: { poolEnv: …, fallbackEnvs: […], upstreamBase: …, port: <本代池口>, … }

- id: llm-pi-ai
  config: { providers: { <provider>: { api: openai-completions, baseURL: http://127.0.0.1:<本代池口>/v1, … } } }
- id: agent-default-model
  config: { provider: <provider>, model: <id> }
```

空清单 / 无池且无模型 ⇒ 渲染出**空串**，调用方跳过 `--patch`，行为与拆之前完全一致。

## 6. `?cmd=assembly`（可执行的"控制面装了什么"）

判据"控制面的 profile 不再装配 key-pool-proxy"如果只靠人读配置文件，就是不可核对的。
这条**只读**命令（不 spawn / 不写盘 / 不改状态，可在控制面存活期随时调）把事实摊成数据：

| 字段 | 含义 |
|---|---|
| `ctrlProfile` | 控制面自己那个剖面名 |
| `assemblyPresent` | **false ⇒ 控制面此刻以最小集运行**（没有模型接入也照样活着） |
| `source` | `none` / `file:<abs>@<mtimeMs>`（带 mtime ⇒ 能证明"确实重读了"） |
| `poolEnabled` / `probePoolPort` | 下一代是否会装池、池口是多少 |
| `envFileNames` | 清单声明的 env 文件（**只报名字，不报值**） |
| `overlayPreview` | 下一代会被叠加的 `--patch` 全文（模型/provider/池都在这） |
| `controlPlaneEnvHit` | ★ 控制面**进程 env** 里命中的模型接入变量名（空数组 = 没漏回来） |

⚠️ 边界：它读的是**磁盘上的清单**，所以"不换代"时它就已经显示新 `version`。
这是刻意的——它回答的是"**下一代**会被装成什么"，不是"现役是什么"。
"现役是什么"请查 `?cmd=status` + 现役池口的 `/healthz`。

## 7. 怎么跑

```bash
# 控制面（控制剖面 ctrl = 不含池；清单里声明模型接入）
SWITCH_PORT=3098 SWITCH_ADMIN_PORT=31908 GEN_PORT_BASE=3070 \
WORK_DIR=<dir> DSH_HOME=<iso>/home WEB_PROFILE=ctrl \
GEN_ASSEMBLY=<dir>/gen-assembly.json \
NODE_BIN=<node.exe> DSH_BIN=<dsh lib/bin.js> \
node packages/switchboard/bin.cjs

curl "http://127.0.0.1:31908/?cmd=assembly"      # 控制面装了什么 / 下一代会被装成什么
curl "http://127.0.0.1:31908/?cmd=status"        # 现役是哪一代
get  "http://127.0.0.1:3172/healthz"             # 本代池口（gen-3072 的池）

# 改配置的正道：改清单/池文件 ⇒ 先验 ⇒ 换代
curl "http://127.0.0.1:31908/?cmd=preflight"
curl "http://127.0.0.1:31908/?cmd=restart"

# 纯函数单测（无需起进程）
node packages/switchboard/test/gen-assembly.test.mjs      # 32/32
```

## 8. 一次实测的样貌（隔离 DSH_HOME，2026-09-24）

| 观察 | 读数 |
|---|---|
| 控制剖面 dump | 511 行，`key-pool-proxy` 命中 **0** |
| 本代装配 dump | 544 行，`key-pool-proxy` 命中 **2**（同一控制剖面 + 本代 overlay） |
| `?cmd=assembly` | `controlPlaneEnvHit=[]`、`poolEnabled=true`、`probePoolPort=3172` |
| bootstrap 代池 | `gen-3071` → `GET :3171/healthz` = `{"keys":2,"ok":true}` |
| 改配置（2→3 key）+ 换代 | `gen-3072` → `GET :3172/healthz` = `{"keys":3,"ok":true}`，控制面未重启 |
| 改配置（3→4 key）+ **不**换代 | 仍 `{"keys":3,"ok":true}`；下一代池口 `3173` 无人应答 |
| 再换代 | `gen-3073` → `GET :3173/healthz` = `{"keys":4,"ok":true}` |

⇒ 生效**确实来自换代**（不换代就不生效），而不是来自任何"控制面热重载"。

## 9. 还不行的 / 已知边界

- **无热重载**：本层刻意不做"读清单就热更新现役"。清单变更的生效**唯一**途径是换代。
  （这正是要的性质；但意味着"只想换个 key 又不想换代"这种诉求在这里没有捷径。）
- **凭据形态**：`envFiles` 只支持 `.env` 形状（`KEY=VALUE`、`#` 注释、两侧引号去掉）。
  它把 key 明文放在一个文件里——密钥管理（权限、轮换）不在本层职责内。
- **控制面自己的模型接入**：如果控制面自身要用 LLM（本仓库未用），它仍需自己的路径；
  本层只保证"控制面**不需要**模型接入就能启动/服务/换代"。
- **端口区间**：池口派生默认 `+1000`，实例里用 `+100`。需要在部署时保证 `genPort+portOffset`
  不与任何保留端口/其它服务相撞——本层不做全局端口仲裁。
