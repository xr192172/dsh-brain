# 换代卡住：`handover` 连续 `b-not-ready`（2026-09-20 20:40–20:50 实测，**未修**）

> 归口：**switchboard（P2 安全层）** —— 按规矩"禁止就地修改，进化只允许经整体替换"，
> 所以我**只报不修**。这条直接挡住"按次切 profile 做能力开/关实验"（我的 B 臂切换机制）。

## 现象

```
?cmd=handover&profile=web-nodc
  → ok:true stage:started
  → 随后 result: { result:"aborted", note:"切换失败 (b-not-ready) · 旧代 gen-3100 继续服务", reason:"b-not-ready" }
```
连试 **3 次**都同样失败（staging 代分别 gen-3101 / gen-3102 / …），旧代 gen-3100 一直继续服务；
控制面停在 `stage=ready`（这个状态不阻止新的 handover，但也不自动清）。

## 两个 staging 代的 boot.log 直接给出的错因

| 代 | 错误 | 读数 |
|---|---|---|
| **gen-3101** | `EADDRINUSE` `127.0.0.1:3101` | ★ **gen 自身要监听的端口号 = 3101，而 3101 已被现役 gen-3100 占着**（`netstat` 显示 `3100` 与 `3101` 都是 pid 9932 = 现役 gen 在听，3101 是 **key-pool-proxy** 的固定端口，见 profile 里 design-canvas 的 `AGNES_UPSTREAM_BASE: http://127.0.0.1:3101`） |
| **gen-3102** | `MODULE_NOT_FOUND`（`requireStack: []`） | 入口模块路径解析不到 ⇒ 像是起在了一个不存在的路径上（本代目录未完整生成？） |

## 推断（待主干确认）

1. **端口撞号**：gen 编号递增到 **3101** 正好撞上**保留端口**（key-pool-proxy）⇒ 这一代永远起不来。
   若成立，则"编号 ≈ 端口"的分配策略与保留端口集合需要一个**排除表**；
2. `MODULE_NOT_FOUND` 很可能是 ① 的连带（staging 目录/入口在失败路径上生成不全）。

## 影响

- 我的"**按臂切 profile**"（`?cmd=handover&profile=…`）现在**不可用** ⇒ 能力开/关实验跑不了；
- 顺带印证：**实验台必须把"换代真的生效"当硬判据**——我已把 `ensureProfile` 改成
  **指纹不符就硬失败**（此前只在日志里警告 ⇒ 上一次实验的 B 臂实际跑在 `web` 上，读数全废）。

## 期望的修法（二选一或都做）

1. **端口分配避开保留端口**（至少避开 key-pool-proxy 的 3101 与任何 `?cmd=status` 用到的端口）；
2. 或者 **staging 代失败时把 boot.log 的错因带进 `result.note`**（现在只写 `b-not-ready`，
   要人去翻 gen 目录才能知道是 EADDRINUSE 还是 MODULE_NOT_FOUND）——这条对可诊断性很关键。

## 我这边可用的临时绕法（不依赖 handover）

**由用户终端用环境变量起另一份 profile**：
`WEB_PROFILE=web-nodc node scripts/relaunch-switchboard.mjs`（跑 B 臂），跑完再 `WEB_PROFILE=web` 起回来。
代价：每臂一次人工重启；换来的是**不依赖那条坏掉的 handover 路径**。

---

# 修法（2026-09-20 晚，主干侧实施）

## 根因（一句话）

**gen 的编号 = gen 自己的监听端口**（`gen-3100` → `--port 3100`，`spawner.ts` 的 `--port`），
而 **3101 是 key-pool-proxy 的固定监听口**（`packages/key-pool-proxy/src/index.ts`：`port: z.number().int().default(3101)`），
活跃代会在**自己进程内**再占一个 3101（netstat 实测 3100/3101 同 pid）。
⇒ 编号递增到 **3101** 的那一代要同时绑两个 3101 ⇒ **必然 EADDRINUSE** ⇒ 永远 `b-not-ready`、旧代一直服务。
（key-pool-proxy 自己容忍 EADDRINUSE，但 gen 的主端口不容忍 ⇒ 崩的是 gen 自己。）

## 改了什么

| 文件 | 改动 |
|---|---|
| `packages/switchboard/src/coordinator.ts` | 新增具名常量 `RESERVED_GEN_PORTS = [3101]`（注释写明归属 key-pool-proxy）+ 导出 `allocGenPort(portBase, slot)`，handover 的端口改由它分配；`genId` 由 `port` 反推（保持"编号=端口"不变量） |
| `packages/switchboard/src/coordinator.ts` | `abort()` 把 staging 代 boot.log 的错因摘要（新导出 `bootErrorHint`，≤240 字符）带进 `result.note` |
| `scripts/test-gen-port-alloc.mjs`（新增） | 端口分配的机验守卫：3101 被跳过 / slot→port 严格单调递增 / 朴素实现必须撞 3101（反例）/ 接线不许绕过 `allocGenPort` |

**为什么不能只写"撞上就 +1"**：那会让"跳过 3101 落到 3102"与**下一个 slot 的 3102** 撞车
（旧代默认还要留活 30s）。现在按"区间内被挡几个就整体后推几格"算，保证 slot→port 单射。
实测序列（`GEN_PORT_BASE=3098`，slot 1 起）：`3099, 3100, **3102**, 3103, 3104 …`（**3101 永不出现**）。

## 自证读数（本机实跑）

| 项 | 读数 |
|---|---|
| `cd packages/switchboard && node scripts/build.mjs` | **成功**（`b1789910762643`，`lib -> out/b1789910762643`） |
| `node scripts/test-gen-port-alloc.mjs` | **16 passed, 0 failed** |
| `node scripts/check-all.mjs` | **12 通过 / 3 失败**（见下方"没做到/做不到"） |

`check-all` 的 3 项失败**全部**指向 `packages/conveyor-context` 被删除（另一会话在工作区的未提交删除）：
`profile`（`cannot resolve profile bundle "@dsh-brain/conveyor-context"`）、`plugin-hygiene`
（`conveyor-context` 四连错）、`test:config-tolerance`（48 passed / 1 failed，唯一失败项 = `conveyor-context 产物存在`）。
与本次改动无关（改动只碰 `coordinator.ts` 的端口分配与 abort note），**我没有回退别人的删除去凑绿**。
在该包恢复（或构建产物补回）后应回到 15/0。

另：本次开始时 `node_modules/@deepseek-ai`（204 个包）在本检出里**整体缺失**（与本次改动无关的环境损伤，
`check-all` 基线当时是 7 通过 / 8 失败）。已用**离线、纯新增**的方式从本机 npm 缓存按 lock 的
integrity 还原 202/204（缺的 2 个是 linux-only 可选包），**未**跑 npm install/postinstall
（绝不动 `~/.dsh/profiles/web/**`），`tsc` 与 `build.mjs` 因此恢复为 0 错误。

## 待用户重启控制面后执行的真机验证

活动控制面跑的是**旧构建**，新代码必须由**用户**重启 switchboard 才生效（agent 不杀宿主 PID）。重启后：

```bash
# ① 切到 B 臂
curl "http://127.0.0.1:31800/?cmd=handover&profile=web-nodc"
curl "http://127.0.0.1:31800/?cmd=result"          # 期望 result:"success"
curl "http://127.0.0.1:31800/?cmd=status"           # 期望 lease.activeGen.gen 不是 gen-3101
# 新代的 boot.log 不应出现 EADDRINUSE：
#   C:\Users\Admin\.dsh\switchboard\<新代>\boot.log

# ② 再切回来（同样期望 success）
curl "http://127.0.0.1:31800/?cmd=handover&profile=web"
curl "http://127.0.0.1:31800/?cmd=result"
```

预期编号序列：重启后 bootstrap 代 = `gen-3099`，第一次 handover = `gen-3100`，第二次 = `gen-3102`
（**3101 被跳过**）。⚠ 若重启时旧代 `gen-3100` 未随控制面一起退出，第一次 handover 想绑的 3100 会被它占着 ——
那是"重启后 genCounter 归零"的既有行为，**不是**本次保留端口问题；重启前请确认旧控制面/gen 进程已退出。

## 没做 / 做不到

- **真机 handover 成功**：未做 —— 需用户重启控制面（项目规矩禁止 agent 杀宿主 PID），活动进程仍是旧构建。
- **`check-all` 15/0**：未达成（12/3），3 项失败全部由 `packages/conveyor-context` 被删引起，未回退他人改动去凑绿。
- **`main.ts` 的 bootstrap 代端口**（`portBase + 1`）未纳入跳号：现役配置 `portBase=3098` → 3099 不撞 3101；
  只有把 `GEN_PORT_BASE` 设成 3100 才会撞，属配置面，本次未动（如需，可让 bootstrap 也走 `allocGenPort`）。
- **未**新增/修改 `~/.dsh/profiles/**`（P2 安全层），**未**启动/重启/杀死任何长期进程。
