# 实验指标：从哪儿取、怎么算、什么会骗人（2026-09-20 17:2x）

> 起因：用户问「**指标怎么监控？token 用量、请求次数、工具次数、工具失败记录、上下文压缩次数等**」。
> 本文把每条指标的**权威来源**、**口径**、**已知陷阱**写清楚 —— 判据不许靠猜，来源必须指名。
> 落地：`scripts/eval-run.mjs` 的 `extractMetrics()`（跑完自动写进报告）+ `--traj <sid>`（事后对已有会话复算，不花 token）。

## 1. 指标表（来源与口径都为**实测**）

| 指标 | 权威来源 | 取法 | 已知陷阱 |
|---|---|---|---|
| **token 用量** | ① 会话投影 `session.list.projections.values.tokenUsage{uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`；② 事件里的逐轮 `usage{inputTokens,outputTokens,cacheReadTokens}` | 跑前/跑后各取一次做**差**；事件累计值与之**交叉核对** | 两者口径可能不同（投影含缓存口径）——报告里两个都留 |
| **请求次数** | `request/header` 事件**逐条**（一次 LLM 请求一条） | 计数 | 标题生成也算一次请求（`session/title-llm-request`）⇒ 单独列，别混进主任务 |
| **工具次数** | `tool/call` 事件 | 计数 + 按工具名分组 | `steps` ≠ 工具次数（一步可含多次调用） |
| **工具失败** | `tool/result` 事件的**内容** | 内容判据：`[stderr]` / 错误关键词 / 非零退出 | ★★ **`isError` 位不可信**：实测失败结果里 `isError` 仍是 **`false`**（内容却是 `[stderr] … 运行失败`）。当前口径**偏宽**（读文件/搜索命中的错误词也会算）⇒ 待细化，报告带样本供人工复核 |
| **上下文压缩次数** | `compaction/*` 事件 | 计数 | 短任务**天然为 0**（本次实测 0）⇒ 要测压缩必须用**长上下文任务** |
| **上下文压力** | 投影 `contextPressure{pressureTokens,projectedTokens,contextWindow}` + `request/context.contextWindow` | 直接读 | 这是"要不要压缩"的输入，不是压缩结果 |
| **工具面（工具集）** | `request/header.header.tools[].name` | 去重计数 + 名单 | ★ **这是我们这层自变量的直接证据**（实测一次运行 `toolSetSize=102`）；臂与臂的工具面差异**不用推测** |
| **模型（受控常量）** | `request/header.header.config{provider,model}` 与 `session.models.current` | 两臂必须一致，否则弃跑 | 实测模型会被**外部**改（dry-run 之间 agnes→deepseek 自己变了）⇒ 每次回读 |
| **回合/步** | `turn/start` `turn/end` `step/start` `step/end` | 计数 | `turn/end.reason` 必须看：**被 abort 的和跑完的不能算一类** |
| **事件去重注入/接续** | `agent/inbox/spliced` | 计数 | 这是"我们这层"的机制痕迹（注入/接续） |
| **preset 变更** | `agent-preset/selected` | 计数 | 与 `agentPreset.select` 的**回读**互为佐证 |

## 2. ★ 三个"会骗人"的地方（都是本次实测撞到的）

1. **`isError` 不可信** ⇒ 失败判据必须看内容；并且这**本身就是我们工具层的一个缺陷**
   （`pwsh` 在非重定向 stderr 时会抛 `ResourceUnavailable: StandardErrorEncoding is only supported when…`，
   工具把它当"正常结果"返回）——**应归到"工具完善"议题**（有轨迹为证）。
2. **换代会让正在跑的回合 `aborted(handover/freeze)`** ⇒ 把它读成"被测对象没做出来"就是**把环境事故当成失败**。
   实测：§10 那对成对实验窗口内发生了**两次换代**（`16:31:56 spawn` / `16:37:28 spawn → flip`），
   B 臂会话的 `turn/end` 正是 `aborted(handover/freeze)` ⇒ **那对实验的 B 臂结论作废**；
   A 臂"`regression` 红但不复现"的**未定真因也由此解释**。
   ⇒ 已加判据 `handoverInWindow()`：跑窗口内命中 `spawn/freeze/flip/retire/promote` 即标 **污染**（报告里可查）。
3. **压缩事件为 0 不代表"压缩没工作"** ⇒ 只代表**没被触发**；要断言压缩的价值必须用长上下文任务。

## 3. 什么时候该弃跑（而不是"解释一下"）

- 跑窗口内 `handoverDuringRun.contaminated === true` ⇒ **该次读数不许当结论**（重跑或剔除）。
- 两臂 `model` 不一致 ⇒ 弃跑（那是在测模型）。
- 两臂 `toolSet` 意外相同/不同与预期不符 ⇒ 先核对"臂到底改了什么"再解读 delta。
- `toolFailures` 高但 `toolCalls` 低 ⇒ 先看失败样本（可能是工具层缺陷，不是被测对象的问题）。

## 4. 用法

```bash
# 跑完自动写进 out/eval-run-*.json 的 stages.trajectory.metrics 与 stages.handoverDuringRun
node scripts/eval-run.mjs --task cli-0003 --arm council --repeat 1

# 对**已经跑过**的会话事后复算指标（不重建、不花 token）
node scripts/eval-run.mjs --traj <sessionId>
```

## 5. 待办（指标侧）

1. **`toolFailures` 口径细化**：区分"命令类工具失败"与"内容里恰好出现错误词"（按工具名 + 是否有 exit code）。
2. **把"工具层缺陷"（`isError` 恒 false、`pwsh` 的 StandardErrorEncoding 报错）报给主干**的「工具完善」议题。
3. **长上下文任务**（用于让 `compactions`／`contextPressure` 真正动起来）—— 与 profile 变体臂（压缩开/关）配套。
4. 每轮 **`pass^k` 的指标方差**（现在 k=1 的 k 太少）。
