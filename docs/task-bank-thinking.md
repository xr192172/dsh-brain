# 题库思路（全量拉一遍）+ 环境体检 · 2026-09-21 11:3x

> 这份是**判据层（题库）的现状与思路**的单一入口。写完时的事实来源：`evals/pilot/tasks.jsonl`、
> `docs/eval-*.md`、`.workbuddy/memory/2026-09-20.md` 与 `2026-09-21.md`（今天的修订都已并入）。
> 一句话定位：**题库只服务一件事——回答"我们这一层改了以后，是变强还是变弱"**（不是"模型会不会做题"）。

## 1. 当前题库（全量）

> ★ **2026-09-21 11:35 由主会话更新**：`cli-0004` **已落盘为真题**（此前本节写的是"不存在"）。
> 新增 `evals/checks/cli-0004.mjs`（oracle）+ `evals/pilot/tasks.jsonl` 追加一行；
> `eval-validate` 实测 **5 题有效 / 0 题有问题**（此前 4）。规格来自
> `docs/eval-task-design-harder.md` §5，但**判据名按真代码核过**（见下）。

| id | 类型 | 不变量（题面核心） | oracle | seed | 状态 |
|---|---|---|---|---|---|
| `cli-0001-injected-message-identity` | regression-repair | switchboard 注入会话的消息必须带 `id` 与 `source`，否则整份历史读不出来 | `scripts/test-injected-message-shape.mjs` | 1 处打回 | ✓ 有效；有单臂基线 |
| `cli-0002-seal-before-unlock` | regression-repair | 未确认停写的旧代必须在释放前门锁**之前**被强杀（否则两代并发写同一份会话） | `scripts/test-handover-drain.mjs` | 1 处 | ✓ 有效 |
| `cli-0003-prepareswitch-real-phase` | regression-repair | defer 判断"有没有活在跑"要**直读 agent 真实阶段**，不许跨插件事件 | `scripts/test-handover-drain.mjs` | 1 处 | ✓ 有效；**噪声基线**已测（`pass^k` ×3） |
| **`cli-0004-verify-drain-json-output`** | **capability-task** | **给 `verify-drain-after-swap.mjs` 加 `--json`**：stdout 只出 JSON（诊断走 stderr）；每条判据一个键、值 `{status:ok|warn|fail,detail}`；另有 `{ok,fails}` 汇总；**不带 `--json` 时输出与退出码一字不变** | **`evals/checks/cli-0004.mjs`** | **0 处（空 seed）** | ✓ 有效（`eval-validate` 实测"HEAD 上 oracle 红 + regression 绿"）；**无 git 捷径**（HEAD 里 `--json` 出现 0 次） |
| `cli-0005-symbol-rename-design-canvas` | **capability-task** | 把模块级导出 `computeHash` **按语义**改名 `digestOf`（跨 3 文件、含注释）；但 ① 同名**局部变量**不许改 ② 字符串常量 `'computeHash-v1'` 不许改 ③ 行为逐字不变 | `evals/pilot/rename-target/check.mjs` | **0 处（空 seed）** | ✓ 有效；**单臂基线已拿**（FIXED / steps+13 / 5948 tok / 37.8s / 24 调用） |

★ **写 cli-0004 的 oracle 时发现一个"区分度来源"**（设计草案没写到这一层）：
核对真代码后判据实为 **14 条**，且**两种形态不同** ——
`R1..R9b`（11 条）走统一结构（`verify-drain-after-swap.mjs:181-182` 用 `r.id/r.level/r.what` 打印）⇒ **易改**；
**`R0a/R0b/R0c`（3 条）是裸 `console.log`，没有 id/level 结构** ⇒ **要额外结构化、最容易漏**。
⇒ **oracle 必须查全 14 条**，否则"只改那 11 条"也能蒙过 ⇒ 题目失去区分度。
（草案写的 `R0a…R9b` 是凭记忆；实际 **`R0` 是段标题、不是判据**。）

## 2. 两种题型，各自测什么（以及各自的坑）

| 题型 | 做法 | 测的是 | 已知的坑 |
|---|---|---|---|
| `regression-repair` | 把**已提交的修复**反向打回（seed），让 agent 修 | "**能不能修好**" | ★ **可被 `git checkout --` 秒解**（正解常就是"改回 HEAD"）⇒ 只能测"会不会找"，测不到"会不会做" |
| `capability-task`（空 seed） | **不打回**，直接要求做一件还没做的事 | "**没有这层能力时做不做得成 / 做得贵不贵**" | 难度须靠**规则陷阱 + 成本**区分（否则谁都能做出来）；判据必须是"行为 + 结构"两条腿 |

`cli-0005` 的设计就是按这个来的：**规则是公开的**（不是陷阱），但**文本替换会踩**（同名局部变量/字符串常量/注释），
所以"按语义改名"的能力（`safe_rename` 类）与"grep+手改"会在**准确率与成本**上分开。

## 3. 有效性的三道关 + `regression`（判据自身也踩过三个坑）

**每题必须过**：① 干净态 oracle 绿 ② 打 seed 后 oracle **必须红**（能力题改成"**HEAD 上必须红**"）
③ 还原后复绿；另加 `regression = node scripts/check-all.mjs` 必须绿。`npm run eval:validate` 就是跑这个。

**判据自身踩过的三个坑（都已修，值得当纪律）**：

| 坑 | 现象 | 真因 | 修法 |
|---|---|---|---|
| **计数虚高**（今天挖出） | 报"5 题有效"而题库只有 4 题 | 能力题在 `try` 里 push 后 `continue`，**`continue` 仍会跑 `finally`** ⇒ `finally` 又 push 一次 | **单一计数点**（别用"幂等 push"遮病根）；标题 5→4、JSON 4==题数 4 |
| **假红 #1** | 我的 `cli-0005` oracle 把**正确解法**判红 | 我写"旧名必须只剩 1 处"，但同名**局部变量**的声明+使用共 2 处，且描述它的注释**本就不该改** | 改成**逐项断言**（另两文件零残留 / 局部变量保留 / 文件头注释已跟改） |
| **假红 #2** | 臂自证判 A 臂"没拿到 design-canvas 工具" | 我按**包内注册名**（`design_canvas_index`）写期望，模型实际看到的是 **MCP 名**（`mcp__design-canvas__*`） | 期望按**模型实际看到的工具面**写 + 支持**前缀家族匹配** |

⇒ 纪律：**只读汇总不读明细 = 假绿**；判据红了先证明"判据错了"，再改判据。

## 4. 测的轴：固定模型 + 固定任务 + **只动我们这一层**

- **模型是受控常量**：`--pair` 先建两臂会话 → 回读 preset 与模型 → **两臂模型不同即弃跑**（`--dry-run` 有负向自证）；
  实测证明必须回读（模型会被外部改）。报告里每臂都记 `model` 与 `dsh{build,profile}`。
- **上游 preset（council/code/minimal）只作参照/地板**，不作主臂 —— 它换的是上游产品配置，不是我们改的东西。
- **主臂 = profile 变体或 build 版本**；`council vs minimal` 那类结果归档为"参照"。

## 5. 臂的机械装置（都已各自验证过）

```
make-profile-variant（改 deps + bundles 两处；--drop-insert 断第二条路）
   → ?cmd=handover&profile=<name>（换代切臂；端口跳号已修并真机验证）
   → 就绪闸：真读一次工具面 + 家族 must/forbid + 【稳定窗口】（防 MCP 工具迟到挂载）
   → B1：每臂独立 worktree + 每臂 session 用 --cwd（判据在该 worktree 内跑）
   → 臂自证（按模型实际工具面） + 模型回读锁定
   → 指标（callsTotalMs/slowestCalls/approvalWaitHits + 索引冷热 + 痕迹清单 + 隔离审计 + 污染排除）
```

要点：
- **能力可能有两/三条进工具的路**（bundle / profile 里的 `mcp-client` insert / **独立 MCP server 进程**）⇒
  只 drop bundle **关不掉**（实测 B 臂仍有 `mcp__design-canvas__*`；今天又发现 **MCP server 会迟到挂载**）。
- **换代污染必须排除出 delta**：`contaminated:true` 的轮此前被计入 ⇒ 修掉后 n 才是"有效 n"。
- **臂切换要按指纹硬验证**：指纹不符 = 目标 profile 没生效 ⇒ **硬失败**（此前只警告 ⇒ B 臂实际跑在 `web` 上）。

## 6. ⚠️ 现在最重要的一条：**自变量（能力开/关）的效度还不成立**

即使机械装置全绿，当前的 delta **不能读成"工具多寡"**，因为：
1. **design-canvas 自身未完成**；
2. 它配置的 `kernelDir` **指向真项目**，与题目的目标（本仓库的 `evals/pilot/rename-target`）**不匹配**；
3. **`exp-base-nodc` 摘掉的是 bridge 插件，但 `design-canvas` 的 MCP server 是独立进程** ⇒ 它会（迟到地）把工具挂上来 ⇒
   "能力关"这一臂**并不真的没有那个能力**。

⇒ **下一步真正该做的**：**选一个"已完成且与题目目标匹配"的能力**当自变量（或者把题改成"确实需要该能力"的形态），
在此之前，n 再大也只是"某两种配置在某题上的成本差"，不能当"能力值不值得留"的结论。

## 7. 数据现状（n=3，干净轮）

```
              A(code@web, 102 工具)      B(code@exp-base-nodc, 30 工具)
FIXED              2/3                       3/3
toolCalls       8 [6–10]                 11 [9–13]
outputTokens 4315 [2800–5591]         8713 [6073–10589]
wallMs      28331 [17026–33987]      51991 [38072–63080]
dangerous        5 [0–9]                  6 [5–7]
```
- **两轮合计 A 4/5 ｜ B 6/6** ⇒ 成功率 **不显著**（Fisher 精确 p≈0.45）；
- **成本上 A 明显更省**（墙钟 ≈ 一半、调用更少、输出 token ≈ 一半）；
- ⚠️ 但 §6 说变量无效 ⇒ 以上数字**只能当"配置 A vs 配置 B"的成本读数**，不是能力结论；
- ★ **n=1 曾给出一个方向，n=3 把它推翻了** ⇒ 纪律：**n=1 只当迹象，不下结论**。

## 8. 题库接下来怎么长（按优先级）

1. **定自变量**（§6）—— 没有它，后面全是空转；
2. **给每道新题补单臂基线**（`docs/eval-baseline-single-arm.md` 的做法：同题单臂跑一次，记成本/成功/危险动作）⇒ 让 delta 有参照；
3. **补"能力敏感"的题**：不只 `cli-0005` 一道；`cli-0004` 要么补成真题要么删掉；
4. **判据接 `verifyCmd`（M2）**：薄脚本读判决 JSON → exit 0/1 ⇒ 判决直接决定 flip；
5. **地板**（BFCL / Terminal-Bench / SWE-bench）—— Docker 侧已就绪（见 §9）。

## 9. 环境体检（2026-09-21 11:2x，实测）

### Docker：**全绿**

| 项 | 读数 |
|---|---|
| 引擎 | `docker version` → **28.0.4**；Docker Desktop 进程 4 个；`desktop status` running |
| 验收 | `docker run --rm hello-world` → **exit 0 / "Hello from Docker!"** |
| 镜像 | `hello-world:latest`、`python:3.13.3-slim-bullseye`、`ghcr.io/open-webui/open-webui:main` |
| 容器 | 都处于 Exited（open-webui 是昨天我按用户要求停的；`python` 那个 17 个月前） |
| 通道 | 拉镜像走 **Windows 系统代理**（Clash）⇒ **不需要给 Docker 单独配代理** |

### WSL：昨天的修复**仍在，且没有复发**

| 项 | 读数（两方向证据） |
|---|---|
| `docker-desktop` 的 `/etc/wsl.conf` | `# crossDistro = true   # unknown key in WSL 2.7 (disabled 2026-09-20)` ← **注释仍在**（145B，mtime 09-20 08:08Z） |
| WSL 版本 / 发行版 | **2.7.14.0**；`Ubuntu-24.04`(Running) + `docker-desktop`(Running) |
| ★ 事件日志 | Application 日志窗口 **09-20 11:40 → 09-21 11:18**，其中 `WSL` 事件只有 **2 条，都在 09-20 16:06/16:08**（= 用户看到的那次 + 修复落地前一次）；**修复之后一整天 + 一次 Docker 重启都没有再报** |

⇒ 结论：**Docker/WSL 这两个环境问题都已结案**（不是"看起来好了"，有验收与两方向证据）。
唯一仍未解释的小疑点（今天的日更里挂着）：`gen-3102/boot.log` 里有 `MODULE_NOT_FOUND`，
但它是现役代、端口正常、前门 200 ⇒ 疑为启动探测期的一次失败，**待查**。

### 还没用上的两条（计划内）

- **B2 真隔离**：每臂独立 HOME/容器（关掉"会话转录 / 能力库 / 索引"三条共享面）—— Docker 就绪后这条**可做**了；
- **公开地板**：BFCL（纯 JSON，需给合成函数做注册层）/ Terminal-Bench（容器化真任务，**推荐**）/ SWE-bench（单独立项）。
