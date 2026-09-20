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
