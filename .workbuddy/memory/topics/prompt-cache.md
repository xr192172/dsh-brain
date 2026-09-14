# prompt 缓存命中率

> 上级索引：`../MEMORY.md` ｜ 相关：`profile-and-gen-integrity.md`、`compaction-engine.md`
> 完整文档：`docs/context-cache-efficiency-measurement.md`、`docs/cache-ab-experiment-log.md`

## 口径：命中率是"会话状态的函数"，不是系统常数

```
命中率 ≈ 1 − (本轮新增 / 总 token)
```

计算用 `TokenUsage` 三个 **disjoint** 字段（`dsh-llm/lib/types/types.d.ts:118-129`）：

```
cacheReadTokens / (cacheReadTokens + inputTokens)     // inputTokens = 未缓存 input
```

**所以"全局平均 ≥93%"是不可达指标** —— 它被两项**不可消除**的成本稀释。
验收应看**稳态命中率**。

| 口径 | 定义 | 实测 |
|---|---|---|
| **稳态命中率** ★ | 排除冷启动轮 + 间隔 >5min 的轮 | **96~99%，已达标** ← 真正的验收线 |
| 连续工作 | 间隔 <1 分钟 | 88.48% |
| 全局平均 | 全部轮 | 85~86%，**仅观察，不作验收** |

**测量工具**：`scripts/measure-context-efficiency.mjs`（`--all` / `--rel` / `--impact` / `--cf` /
`--snapshot <name>` / `--compare <a> --to <b>`）、`scripts/analyze-idle-gap.mjs`、
`scripts/probe-prefix-stability.mjs`。**零运行时改动**，全部离线解码 `session.jsonl.zstd`。

## 四类压制源（2026-09-13/14 实测）

| 源 | 可否消除 | 证据 |
|---|---|---|
| ① `compaction/summary` 压缩 | **必要代价**（用户已接受："压缩本来就要重算，而我保留了更多信息"） | 一次改写 → 后 5 轮 45.06/57.49/75.22/76.98/82.01%，均 <93% |
| ② `compaction/prune` 工具结果裁剪 | **已消除**（`cordis.patch.yml` 里 `disabled: true`） | prune 是 `surfaceOp: replace`（**事后改写，必击穿**）；全量 161 次改写中占 72 次 |
| ③ gen 端口 / header 重建 / 工具模式切换 | **端口已修**（见 `profile-and-gen-integrity.md`），其余待查 | `fd6d7819` **0 次压缩**却仅 71.64%，13 个骤降点全对应前置 `request/header` |
| ④ 冷启动 + 空闲过期 | **不可消除**（结构性 / provider 侧 TTL） | 每 turn 第一条 **28.58%**；间隔 >30min → **7.04%**；连续 <1min → 88.48% |

**③ 的形态指纹**：`(system 字符数 | tools 数)` 在几种不兼容形态间跳变 ——
`75429|1`（Code Mode，工具教学进 system，只留 `run_code`）、`1789|69~71`（Native/Dual，工具动态注册）。
**两种形态前缀完全不兼容，切换即全量重算。**

## 关键实验结论

- **最大会话的干净轮 = 93.14%（刚好达标）**；是受损轮（改写后 5 轮内 74.83%）把它拖到 90.09%。
- **一次前缀改写，5 轮后仍未回到 93%。** 恢复曲线：45% → 75% → 82%。
- **唯一达标（94.33%）的会话，改写次数 = 0。**
- 反事实：干净轮（2,911 轮）87.87% vs 受损轮（532 轮）70.95%。
- 基线快照：`out/snapshots/baseline-128k.json`（86.58%）。

## 外置化的时机决定成败（架构原则）

> **外置化 / 缩减必须发生在「写入时」（append-only），不能发生在「事后」（replace）。**

| 方案 | 大内容的命运 | 缓存代价 | 可召回 |
|---|---|---|---|
| Code Mode / subagent | **从不进入主上下文** | **0** | 原文在子上下文 |
| `dsh-spill-policy` | 存 spillStore，历史留 preview + locator | **0** | ✅ |
| ai-base `FileBuffer`（自研，可移植） | 存盘，历史留引用 | **0** | ✅（`file_recall`） |
| `tool-result-pruner` | **丢弃** | **击穿前缀** | ❌ |

- `dsh-spill-policy` 是 `tools/post-execute` **写入前**替换 → 写进去的就是小消息 → 前缀不动 ✅
- `dsh-compaction-tool-result-pruner` 用 `surfaceOp: replace` 事后改写已有节点，原文丢弃 ❌
- **推论**：**动态的东西不要放前缀，放尾部或按需**。
  同理"能力清单"不应进 tools 段（见 `self-evolution-design.md` 的分层方案 C）。
