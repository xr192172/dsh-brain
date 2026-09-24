# 预演体检（preflight）——「先验后换」的插件装配验收通道

> 格⑮（2026-09-24）。本文件是这条子系统的**一等公民文档**：边界、契约、不变量、失败分类学、
> 以及"怎么跑一次"。
>
> ★ 代码身份戳（`src/build-stamp.ts`）取**这份代码所属的树**的身份：主仓 = `dsh-brain-…`。
> 任何在**独立臂树**里重放这份代码的实验，必须把前缀改成**它自己的**树身份 —— 好让
> "这份读数出自哪棵树"在证据里可当场分辨（口径见该文件注释）。

## 1. 它解决什么

用户对本控制面的原话：

> 「这个控制面其实就是做一个 DSH 启动器，然后 DSH 启动器通过【遥控器】——就是插件的方式——
> 给 DSH 植入一个遥控器，然后每一代分别持有不同的遥控器，然后对其他的代进行开启和关闭以及测试。」
>
> 「它现在真正的用途是：安装插件以后怎么知道这个插件是否能够运行 ——
> 因为以前是有 DSH 装插件或者拔插件把自己给搞崩了的情况，而现在我们可以判断它是可以正常运行
> 之后再换代。这才是这个控制面真正的收益。」

⇒ **装/拔插件（= 改 profile 装配）后，先在【预演代】上验证它能正常运行，确认了再换代；
不通过就丢弃，现役不受影响。**

## 2. 与既有「换代」的关系（为什么不是复用 `?cmd=apply`）

既有的 `?cmd=apply`（`coordinator.ts`）是**先 flip 再 verify**：

```
spawn → ready → freeze → promote → **flip** → probe → boot-health → verify-gate → (失败: rollback)
```

也就是说，坏装配在 `verify` 判失败**之前**已经上过一次前门了。对"日常代码改动"这没问题
（回滚免费）；但"装/拔插件"的典型坏法恰恰是**整棵插件树装配失败**（模块找不到、条目 id 重复、
顶层抛错），此时前门指向坏代的那几百毫秒里可能已经接走了一个会话。

预演体检刻意与之**相反**：**先验，且从头到尾不上前门**。验过之后由运维/上层决定是否换代——
换代仍然走既有 `apply`，本子系统**不复制**它。

| | `?cmd=apply` | `?cmd=preflight` |
|---|---|---|
| 前门 | 中途 flip 到新代 | **从不触碰** |
| 租约 | 会 grant / 回授 | **从不触碰** |
| 失败处理 | rollbackFlip（回滚） | 强杀 + 丢弃（本来就没上过前门） |
| 产出 | 换代 | 一份可取证报告（pass/reject/error） |
| 典型用途 | 已确认的改动上线 | 装/拔插件**之前**的验收 |

## 3. 子系统边界（结构）

```
main.ts  ── ?cmd=preflight / ?cmd=preflight-result ──┐
                                                     ▼
                                          preflight.ts::PreflightRunner
                                            │  spawnGen(profile + --patch overlays)
                                            │  AdminClient → 预演代 admin
                                            ▼
                        ┌────────────── 预演代（mode=staging，独立端口段） ──────────────┐
                        │ index.ts::apply  → handlers.inventory()                        │
                        │   inventory.ts::collectInventory()                             │
                        │     · ctx.loader.entries()   （Loader 是插件生命的唯一权威）    │
                        │     · ctx.tools.schemas()    （模型面工具表 = 喂给 systemPrompt）│
                        │     · ctx.commands.list()    （host 命令注册表）                │
                        │ admin.ts  → GET /admin/inventory                               │
                        └────────────────────────────────────────────────────────────────┘
                                                     │
                                      强杀丢弃 + 丢弃取证(stopped/pidGone/adminDead)
                                                     ▼
                             preflight-contract.ts::PreflightReport（落盘 JSON）
```

文件职责：

| 文件 | 角色 |
|---|---|
| `src/preflight-contract.ts` | **契约层**：类型 + 判据分类学。零 import、零副作用 |
| `src/inventory.ts` | **实测半边**：活实例清点器（注入式依赖面 ⇒ 可离线单测） |
| `src/preflight.ts` | **引擎**：spawn → 体检 → 丢弃。构造参数里**没有** front/lease/coordinator |
| `src/build-stamp.ts` | 代码身份戳：控制面与 gen 两端对账，防"改了没生效被误读成通过" |
| `src/admin.ts` / `src/index.ts` / `src/adminclient.ts` | gen 侧 `/admin/inventory` 与它的客户端 |
| `test/preflight.test.mjs` | 纯函数单测：保护"观测不到 ≠ 没有"这条反假绿不变量 |

## 4. 硬不变量

**INV-1（类型层面）预演永不碰现役。** `PreflightRunner` 的构造参数只有 `PreflightConfig` 与
`PreflightState`；它**没持有** `FrontDoor` / `LeaseStore` / `Coordinator` ⇒ 编译期就不具备
改前门 / 改租约 / 换活跃代的能力。对照 `Coordinator`（构造参数含 `front`，`swapActive` 直接
`front.setActive`）——两者能力面在类型上分开。

**INV-2 端口隔离。** 预演代端口来自 `PREFLIGHT_PORT_BASE`（默认 `GEN_PORT_BASE + 100`），
经 `allocGenPort` 跳过保留端口（`RESERVED_GEN_PORTS`，3101）。⇒ 预演代与现役代可并行共存。

**INV-3 无条件丢弃。** `run()` 的 `finally` 里无论走哪条出口都 `stop()`（SIGTERM→SIGKILL→
`taskkill /T /F`→确证 PID 消失），随后**二次确认** admin 端口不再应答。

**INV-4 丢弃不干净 ⇒ 不许 pass。** 若 `pidGone` 或 `adminDead` 为假，即便所有体检项都绿，
结论也强制降为 `reject`（"不留半途污染"是判据的一部分，不是注释）。

**INV-5 观测不到 ≠ 没有。** 三个读数各自 try/catch；取不到时在 `unavailable` 里留**可分辨**标记，
并且任何"声明要查的东西"落在不可观测面上时判 **red**，绝不判绿。`test/preflight.test.mjs` 守这条。

## 5. 契约：清单（声明）与清点（实测）**来源独立**

- **声明侧**（`PreflightManifest`）：`?cmd=preflight&plugins=…&tools=…&commands=…`。
  它表达**装配意图**（"这次装/拔的插件应当提供什么"）。
- **实测侧**（`LiveInventory`）：预演代进程内运行时注册表，经 `/admin/inventory` 回传。
  它表达**活实例事实**。

两者**不许互相推导**。若"应该有什么"也从活实例读，判据就退化成同义反复。
方向性是单向包含：**声明 ⊆ 实测** 才绿；实测里有声明外的条目**不判红**
（一个 profile 本来就会装配大量未被声明的框架插件，反过来判红等于让判据永远红）。

判据分类学（`CheckKind`，每值对应一种物理事实）：

| kind | 判什么 | 物理来源 |
|---|---|---|
| `boot` | 启动有**正向完成信号**且无致命装载错误 | `boot-health.ts`（有界等待重读 + 进程死亡信号） |
| `admin` | loopback admin 应答且自报 gen 一致 | 预演代 admin |
| `plugin` | 声明要装的 loader 条目**存在 + enabled + phase=active** | `ctx.loader.entries()` + `entry.fiber.state` |
| `tool` | 声明要注册的工具在**模型面工具表**里 | `ctx.tools.schemas()` |
| `command` | 声明要注册的命令在 host 命令注册表里 | `ctx.commands.list()` |

## 6. 「工具面」为什么这样验（且不花一分 key）

`ctx.tools.schemas()` 返回的是 registry 喂给 `ctx.systemPrompt.tools()` 的**同一份**工具 schema
表 ⇒ 「工具到了模型手里」等价于「`schemas()` 里有它」。

因此预演体检**不需要发起任何 LLM 请求**就能回答"插件注册的工具是否真的在模型手里"。
这不是省钱技巧，而是**安全属性**：预演代**结构上**不可能把负载压到现役共享 key 池上
（见 §7 的 profile 隔离），因为这条路根本不经过 LLM。

## 7. 预演代与现役共享 key 池的隔离（本仓库的实例）

★ 做法：把整个预演环境放在**隔离的 `DSH_HOME`** 下（**不**动现役所在的 `~/.dsh`）：

```
DSH_HOME = <repo>/out/_replay/dshhome
profiles/<name>/            ← 与 web **逐项对应**的预演 profile（只改两条 LLM 通路）
```

profile 与 `web` 只有两处不同：

```yaml
- id: key-pool-proxy
  disabled: true                 # 不占用、不向现役 3101 转发
- id: llm-pi-ai
  config:
    providers:
      agnes:
        baseURL: http://127.0.0.1:31913/v1   # 无监听的死端口
```

它保留了 provider 与 delegate 的装配（否则预演代就不再能代表现役），只把**上游**钉死。
⇒ 预演代"调也调不到现役池"，这是可被审查的硬事实，而不是"我保证不调用"。

## 8. 失败分类学（`PreflightVerdict`）

- `pass` —— 全部体检项绿，且丢弃干净。**注意：这只是"可以换代"的必要条件，不自动换代。**
- `reject` —— 有 red。逐条原因在 `checks[].detail`，总因在 `reason`。
- `error` —— **预演本身**没跑完（spawn 失败 / 引擎异常）。与 `reject` 分开：
  "这台机器起不来"和"这个插件是坏的"是两件事，混在一起会误导运维。

已实测的四种 red 形态（见 `out/_replay/REPORT.md` 判据 5）：

| 形态 | 为什么配置视角看不见 | 被哪一条体检抓住 |
|---|---|---|
| 启动即抛错（模块顶层 throw） | 配置里与健康插件同形 | `boot` fatal（整棵树装载失败）+ `inventory` 不可达 |
| 缺依赖（`ERR_MODULE_NOT_FOUND`） | 同上 | 同上 |
| 声明不存在的端点（模块路径不存在） | 同上 | 同上 |
| 插件合法但**声明的工具没真的注册** | 插件 `phase=active`、boot healthy | **`tool`**（模型面工具表里没有）← 只有活体清点能抓 |

最后一行是本子系统存在的理由：**配置视角下它完全正常。**

## 9. 怎么跑

```bash
# 控制面（与现役并行的一段端口）
SWITCH_PORT=3092 SWITCH_ADMIN_PORT=31902 \
GEN_PORT_BASE=3060 HANDOVER_ADMIN_PORT_BASE=30960 \
WORK_DIR=<dir> WEB_PROFILE=<profile> DSH_HOME=<隔离 home> \
PREFLIGHT_PORT_BASE=3160 PREFLIGHT_ADMIN_PORT_BASE=31960 PREFLIGHT_WORK_DIR=<dir>/preflight \
NODE_BIN=<node.exe> DSH_BIN=<dsh lib/bin.js> \
node packages/switchboard/bin.cjs

# 一次预演（候选装配 = profile + 可重复的 --patch overlay；声明清单可含 plugins/tools/commands）
curl "http://127.0.0.1:31902/?cmd=preflight&profile=<profile>\
&patch=C:/.../add-good.yml&plugins=b2-good,switchboard&tools=b2_probe_tool,tool_apply\
&commands=preflight_probe_cmd"
curl "http://127.0.0.1:31902/?cmd=preflight-result"     # 轮询报告

# 端到端一键复现（8 场景 + 前置自检 + 自检断言；用法见 test/e2e/README.md）
bash packages/switchboard/test/e2e/run-preflight-e2e.sh

# 纯函数单测（无需起进程）
node packages/switchboard/test/preflight.test.mjs
```

`--patch` overlay 用 **`file://` URL** 指向插件文件（绝对 Windows 路径会被 Node ESM loader
以 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 拒绝；dsh 的整机 boot 路径不做 `pathToFileURL`）。

## 10. 已知限制 / 未做

- `command` 这一类已在契约与清点器里实现并单测，**并且有了端到端的正/负两向实测**：
  `test/e2e/fixtures/cmd-plugin.mjs` 注册的 `preflight_probe_cmd` 被接受（`H-cmd-positive`），
  而声明一个它没注册的 `preflight_ghost_cmd` 被拒（`I-cmd-negative`）。
- 预演**只是体检**：它不执行"体检通过 ⇒ 自动换代"。这条策略留在上层（运维 / 进化脑）。
  理由：把两者合成一个动作会让"验"和"换"的失败原因混在一起（本子系统刻意把它们分开）。
- `plugin` 检查只覆盖"声明的 id 存在且 active"，不检查条目**配置内容**是否与候选 overlay 一致
  （那需要一个 planner 去比对 patch 栈，属下一层能力）。
