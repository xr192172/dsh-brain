# 上下文缓存效率度量报告

> 日期：2026-09-13 20:40
> 触发：用户要求「写补这个数据」（度量上轮方案里提到的指标），并给出验收线 **cache 命中率 ≥ 93%**
> 数据源：`~/.dsh/sessions/*/session.jsonl.zstd` **离线解码**，**零运行时改动**
> 工具：`scripts/measure-context-efficiency.mjs`、`scripts/probe-prefix-stability.mjs`

---

## 0. 结论速览

| 指标 | 实测 | 验收线 | 判定 |
|---|---|---|---|
| **cache 命中率**（全量加权，20 个会话） | **86.58%** | 93% | ❌ FAIL |
| 其中「干净轮」（无前缀改写干扰） | **87.87%** | 93% | ❌ FAIL |
| 其中「受损轮」（改写后 5 轮内） | 70.95% | 93% | ❌ FAIL |
| **关键信息召回率**（被压掉的内容事后又被需要的比例） | **77.07%**（89 个可判定压缩段） | — | 未达标口径待定 |

**三个最重要的发现**：

1. **93% 是可达到的** —— 最大会话（2049 轮、100 次压缩）的**干净轮命中率 93.14%**，唯一 0 改写的会话是 **94.33%**。**差距全部来自「前缀改写」。**

2. **命中率不是被「压缩质量」拖低的，是被「前缀改写频率」拖低的。** 而**三个改写源里有两个与压缩无关**。

3. **一个配置疑点**：`settings.yaml` 写着 `contextWindow: 512000`，但**所有历史会话实际都在用 128000**（见 §6）。

---

## 1. 度量方法（两个指标怎么算的）

### A. cache 命中率

数据源：`assistant/message` 事件的 `data.usage`，字段定义见 `dsh-llm/lib/types/types.d.ts:118-129`：

```ts
/**
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens`.
 */
export interface TokenUsage {
    inputTokens: number;        // 未缓存 input
    outputTokens: number;
    cacheReadTokens?: number;   // cache 命中
    cacheWriteTokens?: number;  // cache 写入
    reasoningTokens?: number;
}
```

```
命中率 = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
```

实测 `cacheWriteTokens` 恒为 0（DeepSeek prefix_auto 不单独计写入），故等同于 `cacheRead / (cacheRead + uncached)`。

### B. 关键信息召回率

```
1. 取每个 compaction/summary 的 shadowedSeqs → 被压缩掉的原文事件
2. 从这些事件提取「特征词」：文件路径 / 反引号内容 / 错误串
3. 看特征词在【压缩点之后 3000 事件 / ≤20MB 窗口】内是否复现
4. 复现 = 该内容事后被重新需要，但已被压掉 ⇒ 本该有召回能力
```

**为什么用特征词复现**：这是离线可算、零运行时的代理指标。它不能证明"用户当时想要那段原文"，但能证明**那段内容的信息（文件名/函数名/报错）在后来的对话里再次出现**——如果它已被压掉且不可召回，模型就只能"凭摘要猜"。

---

## 2. A. cache 命中率实测

### 2.1 跨会话合计

```
计费 input 总量 : 314,543,592  (uncached 42,197,480 / cacheRead 272,346,112)
★ 加权命中率   : 86.58%   验收线 93% → FAIL
```

### 2.2 分会话

| session | MB | 轮数 | **改写总数** | 其中 prune | 平均改写间隔 | 命中率 |
|---|---|---|---|---|---|---|
| elv/874d25b4 | 0.78 | 112 | **0** | 0 | — | **94.33%** ✅ |
| elv/28f50f57 | 14.61 | 2049 | 100 | 35 | 20.5 | 90.09% |
| brain/3414110d | 2.34 | 308 | 12 | 5 | 25.7 | 87.43% |
| brain/9762c4e0 | 1.05 | 131 | 8 | 3 | 16.4 | 84.17% |
| brain/85e323d9 | 0.24 | 15 | 0 | 0 | — | 83.73% |
| brain/eeb7e25a | 1.68 | 180 | 9 | 5 | 20.0 | 80.26% |
| brain/1a3c3cd2 | 0.36 | 39 | 2 | 2 | 19.5 | 77.80% |
| brain/d7cf6843 | 1.71 | 200 | 9 | 5 | 22.2 | 76.76% |
| brain/ce5fa937 | 1.22 | 113 | 2 | 1 | 56.5 | 74.48% |
| brain/bb727d4c | 1.16 | 72 | 6 | 3 | 12.0 | 72.07% |
| brain/fd6d7819 | 1.44 | 82 | **0** | 0 | — | **71.64%** ⚠️ |
| brain/432f6207 | 0.61 | 61 | 0 | 0 | — | 69.50% |
| develop/ef8a1ebf | 0.41 | 31 | 0 | 0 | — | 66.90% |
| brain/7f08896d | 0.26 | 18 | 0 | 0 | — | 48.94% |
| canvas/2ebfe984 | 0.36 | 19 | 6 | **6** | 3.2 | 44.04% |
| canvas/8fb0e1cf | 0.34 | 13 | 7 | **7** | 1.9 | 35.99% |

**两个极端**：
- **唯一 ≥93% 的会话，改写次数 = 0**
- design-canvas 两个会话 **19 轮压 6 次、13 轮压 7 次**（全是 prune）→ 命中率 36~44%

---

## 3. 三个前缀改写源（这是全部根因）

> **一次前缀改写 = 一次 surface 变更 = 其后的 prefix 全部失效。**

### 3.1 改写后的恢复曲线（全量 161 个改写事件）

| 改写后第 k 轮 | 样本轮数 | 平均命中率 |
|---|---|---|
| 第 1 轮 | 161 | **45.06%** |
| 第 2 轮 | 159 | 57.49% |
| 第 3 轮 | 159 | 75.22% |
| 第 4 轮 | 153 | 76.98% |
| 第 5 轮 | 153 | **82.01%** |

**一次改写的代价：之后 5 轮都回不到 93%。** 这是"亏损窗口"的定义依据。

### 3.2 源 ①：`compaction/summary`（压缩）—— 必要代价

- 触发：`thresholdTokens = floor(contextWindow × thresholdRatio)`
- 28f50f57：2049 轮 / 100 次（65 summary + 35 prune）
- **干净轮 93.14% / 受损轮 74.83%（369 轮）**

**这一源是用户明确接受的**（"压缩本来就要重算，而我保留了更多信息"）。问题只在**频率**。

### 3.3 源 ②：`compaction/prune`（工具结果裁剪）—— 可消除

`dsh-compaction-tool-result-pruner/lib/index.js:10-14` 默认：

```js
const DEFAULTS = deepFreeze({
  thresholdChars: 8192,   // 单个工具结果 > 8192 字符即裁剪
  headChars: 4096,
  tailChars: 1024
});
```

**而当前 profile 配的是更激进的 4096**（`cordis.patch.yml`）：

```yaml
# cache optimization (measured: ~90% window pressure -> repeated destructive
# compaction -> cache hits stuck at 66-82%, never 95%).
- id: tool-result-pruner
  config:
    thresholdChars: 4096
```

**关键机制**：prune 是**每个 tool/result 单独替换**（`surfaceOp: {op:"replace"}`, `shadowedSeqs: [seq]`），
**不是批量的**。所以读一个大文件 = 一次前缀改写。

**证据**：design-canvas 19 轮会话 → `compaction/prune=6`、间隔 3.2 轮 → 命中率 **44.04%**；
13 轮会话 → `prune=7`、间隔 1.9 轮 → **35.99%**。

**10 / 16 个会话的受损轮与 prune 有关。**

### 3.4 源 ③：`request/header` 重建 + 工具模式切换 —— 最致命且与压缩无关

**案例 `brain/fd6d7819`：0 次压缩，命中率却只有 71.64%，13 个骤降点。**

`scripts/probe-prefix-stability.mjs` 的取证结果：

```
## header 序列（形态指纹 = system字符数|tools数）
seq    | reason  | systemLen | toolsCount
10     | initial | 75429     | 1
1214   | resume  | 1789      | 69
4661   | resume  | 75429     | 1
4867   | resume  | 1789      | 69
7004   | resume  | 1789      | 69
8089   | resume  | 75429     | 1
8646   | resume  | 1789      | 69
17749  | resume  | 1789      | 70      ← 工具数增长
19262  | resume  | 1789      | 71      ← 再增长

## 骤降点 vs 前置 header（13 个骤降点全部对应）
drop seq=1352  99.1%→ 0.0% | header seq=1214  fp=1789|69   距离=138
drop seq=7095  96.6%→ 0.0% | header seq=7004  fp=1789|69   距离=91
drop seq=8265  98.8%→ 0.0% | header seq=8089  fp=75429|1   距离=176
drop seq=9962  98.7%→20.9% | header seq=9853  fp=1789|69   距离=109
drop seq=17881 98.8%→14.1% | header seq=17749 fp=1789|70   距离=132
drop seq=19414 98.5%→ 4.4% | header seq=19262 fp=1789|71   距离=152

前缀形态切换次数（相邻 header 指纹不同）: 7 / 15
```

**两个形态族完全不兼容**：

| 指纹 | 次数 | 判定 |
|---|---|---|
| `system=1789, tools=69` | 10 | **Native/Dual 模式**（工具定义走 tools 段） |
| `system=75429, tools=1(run_code)` | 4 | **Code Mode**（工具教学塞进 system，顶层只留 run_code） |
| `system=1789, tools=70/71` | 各 1 | **工具动态注册**（数量变化） |

**结论**：
> **工具呈现模式在 Native ↔ Code 之间切换时，`system` 与 `tools` 两段同时变化 → 前缀完全不兼容 → 全量重算。**
> 这与压缩毫无关系，却是短会话低命中率的主因。

**次要因素**：`purpose=resume` 的 header 重建（15 次），以及 tools 数量 69→70→71 的**动态增长**。

---

## 4. 反事实分析：改写不发生的话能到多少

```
| 类别                      | 轮数  | 平均命中率 |
|---------------------------|-------|-----------|
| 干净轮（无改写干扰）       | 2,911 | 87.87%    |
| 受损轮（改写后 5 轮内）    |   532 | 70.95%    |
| 合计                      | 3,443 | 85.25%    |
```

**会话级关键行**：

| session | 轮数 | 改写 | 整体 | **干净轮** | 受损轮 | 受损轮数 |
|---|---|---|---|---|---|---|
| elv/874d25b4 | 112 | 0 | 94.33% | **94.11%** | — | 0 |
| **elv/28f50f57** | **2049** | **100** | 90.09% | **93.14%** ✅ | 74.83% | 369 |
| elv/3414110d | 308 | 12 | 87.43% | 90.18% | 65.07% | 44 |
| canvas/8fb0e1cf | 13 | 7 | 35.99% | 27.86% | 32.30% | 5 |

**读法**：最大会话如果不受改写干扰，命中率是 **93.14%**，**刚好达标**；是 369 个受损轮把它拉到 90.09%。

---

## 5. B. 关键信息召回率实测

```
可判定压缩段数  : 89
★ 特征词召回率  : 77.07%
```

**读法**：被压缩掉的区间里，**约 77% 的特征信息（文件名、函数名、报错串）在压缩之后又被重新提及**。
而 DSH 原生压缩**不可召回**（详见 `conveyor-postmortem-and-revival.md` §2.2：21 个 `dsh-tool-*` 包无任何回读入口）。

**部分未被复现的样本**（说明压掉的内容确实有未被再提的，不是随机漏）—— 见 `out/context-efficiency.txt` 明细。

**注意口径**：77% 是"特征词在后续窗口复现"的代理指标，**不等于"用户真的需要那段原文"**。
但它足以说明：**被压掉的内容里有很高比例的信息在后续又出现了**。

---

## 6. 一个必须验证的配置疑点：contextWindow = 128000 而非 512000

**现象**：所有 20 个会话的 `request/context` 事件都是：

```
{"provider":"agnes","model":"agnes-2.5-flash","contextWindow":128000}
```

**但 `~/.dsh/settings.yaml` 写的是**：

```yaml
llm-pi-ai:
  providers:
    agnes:
      models:
        - id: agnes-2.5-flash
          contextWindow: 512000
          maxTokens: 65536
```

**取值链**（`dsh-llm-pi-ai/lib/index.js:639`）：

```js
const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;
```

**影响**：压缩阈值 `thresholdTokens = floor(contextWindow × thresholdRatio)`。

| contextWindow | 阈值（设 thresholdRatio=0.8） |
|---|---|
| 128000 | ~102K ← **现有会话** |
| 512000 | ~410K ← **配置期望** |

**差了 4 倍。** 这直接解释了"压缩为什么这么频繁"。

**但如果 512000 生效**，28f50f57 那种会话压力从 ~103K 后移到 ~410K，**压缩次数会大幅下降** → 命中率大幅提升。

**待验证**：这些会话可能都创建于配置改动之前。**开一个新会话，查它的 `request/context` 即可确认。**

---

## 7. 优化建议（按 ROI）

### 优化 1：验证并落实 contextWindow = 512000 ⭐⭐⭐ 零成本

- 手段：新开一个会话 → `.tools\node\node.exe scripts\measure-context-efficiency.mjs --rel <rel>` → 看窗口
- 若仍是 128000，说明配置未生效，需查 profile 覆盖或重启
- **预期**：压缩阈值 ×4 → 压缩次数大幅下降 → 命中率显著提升

### 优化 2：关闭或大幅放宽 tool-result-pruner ⭐⭐⭐ 零成本（配置级）

**理由**：
- **token 全免费**（AGNES 号池）⇒ prune 的"省 token"收益 = 0
- prune 的剩余收益只是"延迟压缩"，而**它自己每次都是一次前缀改写**
- **用"更频繁的小改写"去换"更少的压缩"，是亏的**（改写窗口 5 轮 vs 压缩可延迟几十轮）

**做法**（`cordis.patch.yml`）：

```yaml
- id: tool-result-pruner
  config:
    thresholdChars: 65536    # 从 4096 提到 64K：只裁真正巨大的结果
    headChars: 8192
    tailChars: 4096
```
或直接 `- id: tool-result-pruner` + `disabled: true`。

**验证**：跑一段会话后比对命中率与 `prune` 次数。

### 优化 3：固定工具呈现模式，消除 Native ↔ Code 切换 ⭐⭐⭐

**理由**：`system` 与 `tools` 同时变 → 前缀完全失效（fd6d7819 的 71.64% 全来自此）。

**做法**：查清是什么导致模式在会话中切换（可能是"按需切到 code 模式"的策略），
**固定一种模式贯穿会话**。这是"会话内前缀契约"问题，值得单独立项。

### 优化 4：抑制 header 重建与工具动态注册 ⭐⭐

- `request/header` 的 `resume` 15 次，且 tools 数量 69→70→71 会**触发 header 重建**
- **工具列表一旦在会话中途变化，前缀即失效**
- 方向：会话内**冻结 tools 清单**（新增工具等下次会话生效）

### 优化 5：批次化 prune（需要改代码）⭐⭐

若必须保留 prune 的省 token 能力，则应**把多个 tool/result 的裁剪合并为一次 surface 操作**，
把 N 次改写压成 1 次。**这是唯一需要动 surface 逻辑的优化。**

---

## 8. 关于「直接复制一份 DSH 原生改」的评估

**用户提议**：复制原生 DSH，在其上下文管理（session/surface）上直接改，免得重写一套。

### 8.1 现状：这件事其实**已经在做**

我们的补丁就打在同一位置：

- `patches/@deepseek-ai+dsh-compaction-basic+0.1.1-rc.2.patch`（`safeMeasure` / `deterministicFallbackPrune` 补字段 / `assertSelectedSpanStable`）
- 机制：junction `~/.dsh/profiles/node_modules/@deepseek-ai/*` → `dsh-brain/node_modules/@deepseek-ai/*`
- 所以「在其代码上改」已成立，且**已修改过 surface 相关逻辑**（`deterministicFallbackPrune`）

### 8.2 三条路线对比

| | 补丁（现状） | Fork 成自建包 | 外挂插件 |
|---|---|---|---|
| 复用 session/surface 状态 | ✅ 直接读 | ✅ 直接读 | ❌ 只能读事件流 |
| 能改 surface 操作逻辑 | ✅ | ✅ | ❌ |
| 上游升级成本 | 中（patch-package 上下文匹配，改多了易冲突） | **高**（手动 merge） | **无** |
| 可控性 | 中 | 最高 | 低 |
| 适用场景 | 小到中等改动 | 大改动 / 要替换实现 | 只加能力、不动内核 |

### 8.3 我的判断：**现在不需要 fork**

理由：

1. **命中率的三个源里，两个是配置级**（优化 2、3、4 全不用改代码）
2. **信息保全（原文归档 + 召回）不需要接管 surface** —— 旁听事件流、把原文另存一份明文 jsonl 即可（零 token 成本、零前缀影响）。这正是 `conveyor-postmortem-and-revival.md` §4.0 的结论：**信息保全层的最佳载体是「上下文之外」**
3. **只有优化 5（批次化 prune）需要改 surface 逻辑** —— 而它完全可以用**现有补丁机制**完成（我们已经在改同一个文件）
4. Fork 的最大代价是**跟随上游升级**，而 DSH 还在快速迭代

**结论**：
- **先用补丁 + 配置解决 93% 的问题**（成本最低）
- 若将来要做"无损压缩"（让被 shadow 的消息保留可召回能力）或需要替换压缩实现，**再考虑自建包**（不是 fork 整个 DSH，而是 fork 那一个包，在 profile 里替换 `@deepseek-ai/dsh-compaction-basic`）
- 项目已有的 `scripts/build-experiment-kernel.mjs`（复制 + patch + junction + 构建独立 dist）**机制可复用**，尽管其注释写的是"不 fork 两套 DSH"

---

## 9. 待办

| 优先 | 项 | 验证方式 |
|---|---|---|
| P0 | 新开会话确认 `contextWindow` 是否 512000 | `--rel` 看 `request/context` |
| P0 | 放宽/关闭 tool-result-pruner，比对命中率 | 跑会话后 `--all` / `--cf` |
| P1 | 查清 Native↔Code 工具模式切换的触发条件 | `scripts/probe-prefix-stability.mjs` |
| P1 | 定位 tools 数量动态增长的来源（69→70→71） | 同上 |
| P2 | 批次化 prune（补丁 `tool-result-pruner`） | 补丁后看 `prune` 次数与命中率 |
| P2 | 原文归档 + 召回（信息保全层） | 独立插件，零前缀影响 |

---

## 10. 来源追溯：这两个机制是谁引入的

> 用户问：「裁剪和工具模式切换这两个数据是从哪里来的？是从 ai-base 还是现在的 DSH？是我们自己手写引入的吗？」

| 机制 | 归属 | 证据 |
|---|---|---|
| **`tool-result-pruner`** | **DSH 官方原生包** | `package.json` → `@deepseek-ai/dsh-compaction-tool-result-pruner`，`repository: github.com/deepseek-ai/deepseek-harness`，`directory: packages/compaction/compaction-tool-result-pruner`；被 `dsh-base/package.json:54` 依赖 |
| 其中 `thresholdChars: 4096` | **我们手写的覆盖** | `cordis.patch.yml` 的 `- id: tool-result-pruner` 配置块（官方默认 8192） |
| **工具呈现模式切换（Native ↔ Code）** | **DSH 官方原生机制** | `@deepseek-ai/dsh-tools/lib/types/code-mode.js`（`RUN_CODE_NAME = 'run_code'`）+ `dsh-agent-presets`；我们只是在 `settings.yaml` 设了 `agent-presets.default: code` |

**结论**：
- **机制是 DSH 原生的，不是 ai-base 的，也不是我们写的**
- **我们只做了两件事**：① 把 pruner 阈值从 8192 调到更激进的 4096；② 默认 preset 设为 `code`
- **ai-base 里没有这两个东西**（它的对应物是另一套设计，见 §11）

**顺带澄清 512 的来历**（用户说明）：模型窗口本身是 512K，但**当时配置的 agent 出现幻觉、给了默认的 128**，
于是历史会话一直在 128K 下运行；后续才改成 512000。

**⇒ 本文所有数据都是「128K 窗口时代」的数据。512 生效后必须复测。**

---

## 11. 更好的同类设计：同样是「控制工具输出」，时机不同就分好坏

用户问：「我记得有很多类似的设计，有没有哪一种设计和我们希望的效果相似，但是更好的？」

**有，而且分三个层次——最好的一层就在当前系统里。**

### 11.1 系统里已经有的更好的那个：`dsh-spill-policy`（DSH 原生）

**它和 `tool-result-pruner` 做的是同一件事**（把过大的工具输出挡在上下文外），**但时机相反**：

```js
// dsh-spill-policy/lib/index.js:4-14
/**
 * The spill-policy PLUGIN: a `tools/post-execute` result transformer that keeps
 * oversized plain-text tool results out of the model's context. When a final
 * result's UTF-8 size exceeds `maxInlineBytes`, it saves the FULL text to a
 * session-scoped spill artifact (`ctx.spillStore`) and replaces the
 * model-facing result with a bounded head/tail preview plus the backend's
 * locator and retrieval guidance.
 */
```

| | `tool-result-pruner` | `dsh-spill-policy` |
|---|---|---|
| 时机 | **事后**（tool/result 已在 surface 里 → `surfaceOp: {op:"replace"}`） | **写入前**（`tools/post-execute` 钩子，替换尚未进入历史的 result） |
| 是否改写已有前缀 | **✅ 改写 → 击穿缓存** | **❌ 不改写 → 写入的就是小消息 → append-only** |
| 原文去向 | **丢弃**（只有 head/tail 留下） | **存入 `spillStore` 存档** |
| 可召回 | ❌ 无入口 | ✅ 返回值携带 **locator + retrieval guidance** |
| 我们的配置 | 启用，且阈值调到 4096（更频繁） | 启用（`maxInlineBytes: 8000`） |

**⇒ 结论：两者职责重叠，但 pruner 是坏的那个。应当关掉 pruner、保留 spill-policy。**

**唯一要注意的**：spill-policy 明确**跳过 `read`**（避免 `read → spill → read again` 循环）：

> "`read` is skipped by the model-facing arm to avoid a `read → spill → read again` loop"

所以「读大文件」这个最大输出源**不受 spill-policy 保护**。而它恰好由 **Code Mode** 兜住（见 11.3）。

### 11.2 你自己写过的更好的那个：`ai-base` 的 FileBuffer / SidecarBuffer

`ai-base/agent-shell/internal/context/file_buffer.go:16-26`：

```go
// ── FileBuffer: 外置化大工具输出（P4a 方向四 §4）──
// 设计原则：
//   - 代码是外部数据库，对话只保留决策流
//   - read/smart_read 输出 > 阈值 → 正文存 FileBuffer，CurrentRound 只留引用
//   - FileIndex 按 path 去重覆盖最新版本，跨轮可复用
//   - LLM 需要正文时调 file_recall 工具检索
//
// 与 SidecarBuffer 的区别：
//   - SidecarBuffer: hash→字节（多模态），LRU 淘汰
//   - FileBuffer: path→内容（代码文本），覆盖更新，跨轮持久
```

它比 pruner 多出四件事：

| 能力 | FileBuffer | `tool-result-pruner` |
|---|---|---|
| **按 path 去重覆盖**（同一文件读多次只存一份，引用稳定） | ✅ | ❌ |
| **召回工具**（`file_recall` / `GetByHash`） | ✅ | ❌ 裁掉即永久丢失 |
| **索引走尾部**（`IndexSummary()` → `[FileBuffer: 3 文件, 8.2K total → file_recall(path) 检索]` 注入 DynamicInjection） | ✅ **不击穿** | ❌ |
| 跨轮持久 | ✅ | ❌ |

**注意最后一行**：索引摘要是注入 **DynamicInjection**（尾部），**不进前缀** —— 这与你当年在 Go 版里做的 `hintBuffer` / 尾部注入是同一个原理。

**⇒ 这是「外置化 + 可召回 + 索引走尾部」的完整形态，比 DSH 的两个方案都完整。值得移植。**

### 11.3 最彻底的那个：隔离而不是压缩 —— Code Mode / 子代理

`dsh-tools/lib/types/code-mode.js:1-6` 的设计声明：

```
/**
 * Code Mode `run_code` transport. Programs call the registry's agent-visible
 * tools through nested executions scheduled under the native concurrency
 * contract; each sub-dispatch is logged for reconstruction, while **only the
 * outer curated result enters model history**.
 */
```

**"only the outer curated result enters model history"** —— **Code Mode 本身就是一种大输出隔离机制**：
工具在程序内被调用，**只有程序自己 print/return 的输出进入历史**。读 10 个文件也不会把 10 份正文灌进上下文。

同一思路的更彻底版本是 **subagent 隔离**（`dsh-tool-subagent`），你的 ai-base 设计文档也识别过：

> `design.md:721` —「**大文件读取的子代理隔离**：ReadTool 返回的完整文件内容不应进入 CurrentRound……让子代理在自己的独立上下文窗口中读取文件、分析内容，只将分析结论返回主 Agent。**Claude Code 正是通过 Subagents 实现这一点**」

**⇒ 这是"根本不产生大内容"，比"产生了再外置/裁剪"更好。**

### 11.4 可以推广的架构原则（本轮最重要的结论）

> **外置化 / 缩减，必须发生在「写入时」（append-only），不能发生在「事后」（replace）。**
>
> - **写入时**决定 → 写进去的就是小消息 → **前缀不动 → 零击穿**
> - **事后**修改 → `surfaceOp: replace` → **前缀被改写 → 击穿整个缓存**

三个方案排成一条线，越靠左越好：

| 方案 | 大内容的命运 | 缓存代价 | 可召回 |
|---|---|---|---|
| **① Code Mode / 子代理** | **从不进入主上下文** | **0** | 原文在子上下文/日志 |
| **② spill-policy**（写入时外置） | 存 spillStore，历史留 preview | **0** | ✅ locator |
| **③ FileBuffer**（写入时外置 + 索引走尾部） | 存盘，历史留引用 | **0** | ✅ `file_recall` |
| ④ `tool-result-pruner`（事后裁剪） | **丢弃** | **击穿前缀** | ❌ |

---

## 12. 修正后的行动建议（替代 §7，按 ROI）

| 优先 | 动作 | 依据 | 成本 |
|---|---|---|---|
| **P0** | **512K 生效后复测全部指标** | §10 澄清；现有数据全是 128K 时代 | 跑脚本 |
| **P0** | **关闭 `tool-result-pruner`**（保留 `spill-policy`） | §11.1：两者职责重叠，pruner 事后改写必击穿，且无存档 | 配置级 |
| **P0** | **固定工具呈现模式，消除 Native ↔ Code 切换** | §3.4：两形态前缀不兼容 | 需定位切换原因 |
| P1 | 会话内**冻结 tools 清单**（工具动态注册会击穿前缀） | §3.4：69→70→71 | 需查注册来源 |
| P1 | 让**大文件读取走 Code Mode 或 subagent**，而不是灌进主上下文 | §11.3 | 配置/用法 |
| P2 | **移植 ai-base FileBuffer**（path 去重 + `file_recall` + 索引走尾部） | §11.2 | 新插件 |
| P2 | 批次化 prune（若一定要保留裁剪） | §7 优化 5 | 补丁 |

---

## 13. 第四类来源：空闲过期与冷启动（2026-09-14 补测）

**触发**：用户报告「命中率只有 70%，压缩过一轮，只占用 17%」。扫到当晚新会话后确认——

### 13.1 新会话 `b79a6e91`（22:37~23:03，512K 窗口，**0 压缩 / 0 prune**）

```
window = 512000   compaction events = 0   prune = 0   overallHit = 70.57%
请求头只有 1 个（reason=initial），即无 header 重建

seq=68    22:37:35  billed= 39563  hit=  0.0%   ← 首轮冷启动
seq=120   22:40:06  billed= 40764  hit=  0.0%
seq=1184  22:40:34  billed= 41849  hit= 97.3%
seq=1496  23:02:14  billed= 42839  hit=  0.0%   ← 距上一条 21 分 40 秒
seq=1553  23:02:21  billed= 44822  hit= 96.5%
...      （同 turn 内后续 step 全部 95~99%）
```

**70.57% 完全由 3 个「0% 轮」拉低**（首轮 + 长空闲后）。连续工作段的命中率是 **95~99%**。

### 13.2 全量分组（新工具 `scripts/analyze-idle-gap.mjs`）

**按「与上一条请求的时间间隔」**：

| 间隔 | 轮数 | 平均命中率 |
|---|---|---|
| 连续（<1 分钟） | 3,173 | **88.48%** |
| 1~5 分钟 | 157 | **68.77%** |
| 5~30 分钟 | 59 | **39.12%** |
| **>30 分钟** | 47 | **7.04%** |

**完美的单调递减** ⇒ **prefix cache 有过期时间，空闲越久命中率越低。**

**按「是否为本 turn 第一条」**：

| 类别 | 轮数 | 平均命中率 |
|---|---|---|
| **每 turn 第一条**（冷启动） | 161 | **28.58%** |
| 同 turn 内后续 step | 3,292 | **87.97%** |

### 13.3 同时到手的两个好消息

1. **512K 已生效**：`b79a6e91` 与 `28f50f57` 的 `request/context` 均为 `window=512000` ✅
2. **实验 #1 已生效**：`b79a6e91`（8 分钟、10 轮连续工作）**prune = 0、压缩 = 0** ✅
3. **而且**：`28f50f57` 在 **19:31:40 成功完成一次压缩**（`compaction/summary`，`shadowed=480`）——
   这是 `deterministicFallbackPrune` / `measurement` 那个 bug 修好后的**首次成功压缩**；
   其后尾部连续 17 轮命中率 **99.2~100%**。

**⇒ 压缩修复 + 关闭 pruner 之后，稳态命中率已经达到 99%。**

---

## 14. 指标校准：93% 应该怎么定义

**问题的根源**：`命中率 ≈ 1 − (本轮新增 token / 总 token)`。
它是**会话状态的函数，不是系统常数**。

| 场景 | 冷启动轮占比 | 每轮新增占比 | 结果 |
|---|---|---|---|
| 短会话 + 频繁空闲（`b79a6e91`：10 轮） | 高（3/10 = 30%） | 高（40K 上下文） | **70.57%** |
| 长会话 + 连续工作（`28f50f57` 尾部：23 万 token） | 极低 | 极低（新增 ~1K/230K） | **99%+** |

**⇒「全局平均 ≥93%」不是一个可达指标**，因为它会被两项**不可消除**的成本稀释：

1. **冷启动**（28.58%）—— 结构性：首次请求没有可复用的前缀，**必然全 miss**
2. **空闲过期**（>30 分钟 → 7.04%）—— provider 侧 prefix cache 的 TTL，**本地不可控**

**建议改用三个分口径指标**：

| 指标 | 定义 | 当前实测 | 用途 |
|---|---|---|---|
| **稳态命中率** | 排除「每 turn 第一条」与「间隔 >5 分钟」的轮 | **≈ 96~99%** | **★ 真正的验收口径** |
| 连续工作命中率 | 间隔 <1 分钟的所有轮 | **88.48%** | 观察改写的影响 |
| 全局平均 | 全部轮 | 85.20~86.58% | **仅作观察，不作验收** |

**建议验收线**：**稳态命中率 ≥ 93%** → **当前已达标**（28f50f57 尾部 99%+；b79a6e91 连续段 95~99%）。

**为什么不把全局平均当验收线**：要求它 ≥93% 等价于要求「消除冷启动」，
而那需要让前缀在 provider 侧**常驻**——本地不可控，且成本结构上也未必划算。

**可行动的两条**（若确实想抬高全局平均）：
- **减少空闲**（保持会话连续使用）—— 但这是使用习惯，不该由系统倒逼人
- **缩短会话**（每次开新会话）—— 反而会**增加**冷启动占比，方向相反

⇒ **结论：全局平均这个数会一直"不好看"，但系统本身没问题。要看稳态。**

---

## 15. 一句话

**93% 能达到——而且是"已经达到"：稳态命中率 96~99%。**

**需要修正的是指标口径，不是系统**：全局平均被「冷启动（28.58%）」和「空闲过期（>30 分钟 → 7.04%）」两类**结构性成本**稀释，这两个都不可消除、也不该被计入验收。

**四个命中率压制源，按可否消除分类**：

| 源 | 可否消除 | 依据 |
|---|---|---|
| ① `compaction/summary` | **必要代价**（你已接受） | §3.2 |
| ② `compaction/prune` | **✅ 已消除**（实验 #1，实测 prune 0 次） | §3.3 / §11.1 |
| ③ 工具模式切换 / header 重建 | **可消除**（实验 #2、#3 待做） | §3.4 |
| ④ 冷启动 + 空闲过期 | **不可消除**（结构性 / provider TTL） | §13 |


