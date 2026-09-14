# 缓存命中率 A/B 实验记录

> 目标：把 cache 命中率从 **86.58%** 提到 **≥93%**（用户定的验收线）
> 方法：**一次只改一个变量**，每次改动前后各取一次快照，用 `--compare` 出差异表
> 度量来源：`~/.dsh/sessions/*/session.jsonl.zstd` 离线解码，**零运行时改动**

---

## 怎么用（每次实验三步）

```bash
cd D:\project_develop\dsh-brain
N=.tools\node\node.exe

# 1) 改动前取基线（已有则跳过）
$N scripts/measure-context-efficiency.mjs --snapshot <基线标签>

# 2) 改配置 → 用你自己的终端重启 switchboard（或换代）→ 正常用一段时间

# 3) 改动后取新快照，并对比
$N scripts/measure-context-efficiency.mjs --snapshot <新标签>
$N scripts/measure-context-efficiency.mjs --compare <基线标签> --to <新标签>
```

**对比输出会直接给出**：命中率变化（pp）、干净轮/受损轮变化、prune 次数变化、分会话变化（按提升降序）、以及 `PASS/FAIL` 判定。

**注意**：新快照只反映**在改动生效之后产生的会话数据**。所以改完要**真的用一段时间**再看，别立刻测。

---

## 已固化的基线

| 标签 | 文件 | 说明 |
|---|---|---|
| `baseline-128k` | `out/snapshots/baseline-128k.json` | **128K 窗口时代 + pruner 启用（4096）** |

**基线数值**（16 会话 / 3,443 有效轮）：

| 指标 | 值 |
|---|---|
| **cache 命中率** | **86.58%** |
| 干净轮命中率（无改写干扰） | 87.87%（2,911 轮） |
| 受损轮命中率（改写后 5 轮内） | 70.95%（532 轮） |
| 前缀改写总数 | 161（**summary 89 / prune 72**） |
| 计费 input | 314,543,592（uncached 42,197,480） |
| 关键信息召回率 | 77.07%（89 个可判定压缩段） |

---

## 实验 #1：关闭 `tool-result-pruner` ✅ 已改，待复测

**改动**（`~/.dsh/profiles/web/cordis.patch.yml`，2026-09-13 21:30）：

```yaml
- id: tool-result-pruner
  disabled: true        # ← 唯一变更（原为启用，thresholdChars: 4096）
  config: { thresholdChars: 4096, headChars: 4096, tailChars: 1024 }
```

**为什么**（依据 `docs/context-cache-efficiency-measurement.md` §3.3 / §11.1）：

- prune 是 **`surfaceOp: replace`** —— 在消息**已进入 surface 之后**去改它 → **必然改写前缀**
- 一次前缀改写的代价：之后 5 轮命中率 45.06% → 57.49% → 75.22% → 76.98% → 82.01%（**全部 < 93%**）
- 全量 161 次改写中 **prune 占 72 次**；design-canvas 两个会话 19 轮裁 6 次 / 13 轮裁 7 次 → 命中率 **44% / 36%**
- **被裁原文直接丢弃、无召回入口**
- 而你的配置里**同时启用了 `dsh-spill-policy`**，它做同一件事但**时机相反**：在 `tools/post-execute`
  **写入历史之前**替换 → 写入的就是小消息 → **前缀不动**，且全文存 `spillStore` + 带回 locator → **可召回**
- 叠加你已说明的 **token 全免费** ⇒ prune 的"省 token"收益为 0

**单一变量**：本次**只关 pruner，不动 spill-policy**（`maxInlineBytes: 8000` 保持），保证对比干净。

**预期**：

| 指标 | 预期方向 |
|---|---|
| `prune` 改写次数 | → **0** |
| 受损轮数 | 显著下降（基线 532 轮，其中相当部分与 prune 有关） |
| cache 命中率 | 上升；目标 ≥93% |
| 计费 input / 上下文增长 | 可能略升（不裁了），**这是预期的代价** |
| 关键信息召回率 | 应上升或持平（原文不再被丢弃） |

**判定**：

- **PASS**：命中率 ≥ 93%，且 prune 次数 = 0
- **部分**：命中率上升但未到 93% → 继续做实验 #2、#3
- **FAIL（需回滚）**：命中率下降，或上下文增长导致压缩次数显著增加（说明"不裁"的代价超过收益）
  - 回滚：把 `disabled: true` 删掉即可

---

## 实验 #2：修复「gen 实例端口写进 system prompt」 ✅ 已改，待复测

**改动**（两处，2026-09-14）：

1. **代码补丁** `scripts/patch-web-app-public-url.mjs` → 改 `@deepseek-ai/dsh-web-app` 的 `localWebUrl()`：
   优先读 `process.env.DSH_PUBLIC_WEB_URL`，未设置时保持原行为。
   （profiles 下是同名符号链接，一处修改全局生效；已加入 `package.json` 的 `postinstall`）
2. **环境变量注入**：两个启动器都加 `DSH_PUBLIC_WEB_URL = http://127.0.0.1:3080`（前门）

**为什么**（详见 `gen-port-prefix-invalidation.md`）：

- DSH 把 `http://127.0.0.1:<本实例 webServer.port>` 写进 **system prompt**
- 而 gen 池里每个实例端口不同（实测 3082~3089，共 8 个）
- 实测 `28f50f57`：19 次 header 里**端口变化 13 次**，
  **每次变化后第一条请求命中率都是 `0.0%`**，第二条恢复 97~99%
- ⇒ **每次蓝绿换代 / 会话迁移 = 一次全量 prompt 重算**

**预期**：

| 指标 | 预期 |
|---|---|
| header 中的 GUI 端口 | 全部为 **3080**（统一） |
| 换代/迁移后的 0% 骤降 | **消失** |
| 受损轮数 / 稳态命中率 | 改善 |

**验证**：`scripts/probe-gen-port.mjs` 看端口分布；`--snapshot` + `--compare` 看命中率。

**遗留（P1）**：同一 header 序列里还有第二种形态差异（`6449|94~96` vs `1783|70`，system 差 4666 字符、
少 25 个工具），推测是**不同 gen 加载了不同插件集**。若成立，端口修复只覆盖部分场景。

---

## 待做实验队列（按 ROI）

| # | 变量 | 依据 | 预期 |
|---|---|---|---|
| **#2** | **固定工具呈现模式**（消除 Native ↔ Code 切换） | §3.4：`system=1789\|tools=69` 与 `system=75429\|tools=1` 两形态前缀不兼容；`fd6d7819` 0 次压缩却仅 71.64%，13 个骤降点全对应 header 重建 | 短会话命中率大幅提升 |
| **#3** | **会话内冻结 tools 清单** | §3.4：tools 数量 69→70→71 会触发 header 重建 → 前缀失效 | 消除一类隐式改写 |
| **#4** | **512K 窗口生效后的复测** | §10：模型本身 512K，此前因配置幻觉跑在 128K；压缩阈值 = `contextWindow × thresholdRatio`，阈值将 ×4 | 压缩次数大幅下降 |
| #5 | 大文件读取走 Code Mode / subagent | §11.3：Code Mode「only the outer curated result enters model history」 | 大输出根本不进主上下文 |
| #6 | 移植 ai-base FileBuffer（path 去重 + `file_recall` + 索引走尾部） | §11.2 | 外置化 + 可召回 + 不击穿 |
| #7 | 批次化 prune（若 #1 失败、确实需要裁剪） | §7 优化 5 | 把 N 次改写压成 1 次 |

**顺序原则**：先做**配置级**（#1–#4，零代码），再考虑代码级（#5–#7）。

---

## 需要注意的干扰因素

1. **新快照只能反映改动后的新会话**。老会话的数据不会变，所以对比时"分会话变化"表里只有新会话才有差异。
2. **`cleanHit` / `damHit` 的分组依赖"损伤窗口 = 5 轮"**（脚本里的 `DAMAGE_WINDOW`）。如果想更严格，可调小。
3. **`recall`（关键信息召回率）是代理指标**，口径见报告 §1.B，不要当成"用户真的需要那段原文"。
4. **不要把多个变量一起改**，否则无法归因（这次的 pruner 关闭是单一变量，请保持）。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/measure-context-efficiency.mjs` | 度量工具（`--list` / `--sample` / `--rel` / `--all` / `--impact` / `--cf` / `--snapshot` / `--compare`） |
| `scripts/probe-prefix-stability.mjs` | 前缀稳定性取证（header 形态指纹 + 骤降点归因） |
| `docs/context-cache-efficiency-measurement.md` | 完整实测报告（含根因、来源追溯、更优设计对比） |
| `out/snapshots/*.json` | 快照存档（对比用） |
| `out/context-efficiency.txt` | 最近一次运行的完整文本输出 |
