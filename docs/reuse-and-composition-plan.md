# 复用与组合：四块 MIT 拼成一个闭环（2026-09-21）

> 本文回答两个问题：**我查到的这些东西能不能复用？能不能结合起来用？** 并给出**新想法**。
> 上游材料**就在本地**（`D:\project_develop\_research\deepseek-harness\deepseek-harness-master`，已逐字读过）；
> 第三方结论的**证据分级**见 `docs/oss-arena-landscape-2026-09.md`（那里标了"直接读过 / 二手 / 推断"）。

---

## 0. 先落纸一条教训（它改变以后每一次开工）

> **做任何"功能组模块"之前，先查三处**：
> ① **GitHub**（同义词 + `topic:` 标签 + star 数）；② **arXiv**（2026 年这个方向多半已经有名字）；
> ③ ★ **本地有没有已经 clone 的源码** —— `_research/` 里**就已经有完整 DSH 源码**，
> 我这一轮差点又去网上搜上游文档。（这一步最便宜，且最常被跳过。）
>
> **判据是「造格子」还是「造房子」**：只有当**这一格确实没人做**，才自造。
> 反面判据（本轮实证）：**同一件事，开源已经做出了更好的版本，而我还在自己写** ——
> 今天两次撞上：`armFaceCheck`（上游 registry 级断言已有）、靶场隔离（VeRO 已有）。

---

## 1. 三块**直接可复用**（今天全部实地核实）

### 1.1 ★★ DSH 上游的 `minimal` —— **它就是上游自己的 RL harness**

**本地证据**（逐字读过）：
`packages/preset/agent-presets` 的设计笔记
`.agents/notes/implemented/bug-fix/2026-08-10-minimal-preset-owns-rl-composition.md`
（标题原文：*"The minimal preset owns the **complete RL agent composition**"*）
与 `.agents/notes/implemented/feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.md`。

它规定（原文要点）：

| 项 | 值 |
|---|---|
| 工具（**恰好两个**） | 持久 `bash`（RL 环境描述，300s 超时）+ `str_replace_editor` |
| persona | **恰好一句**：`You are a helpful software engineer assistant.` |
| 提示 | `complete: true` + **压制 runtime-context**；断言"harness identity / Web orientation / tool guidance / delegation / 其它动态上下文 **都加不进模型输入**" |
| compaction | **不挂**（连"阈值很高的 inert provider"都被否掉，理由是长会话仍可能替换历史） |
| 文件系统 | **bare `fs-local`**（编辑器不受 shell 沙箱策略约束） |
| 会话 | JSONL，`compression: none` |
| 环境变量 | **`DSH_MODEL` / `DSH_CONTEXT_WINDOW` / `DSH_SYSTEM_PROMPT` / `DSH_CWD` / `DSH_SESSION_ROOT`** |
| 验证方式（上游自己的判据） | "断言组装出的请求**恰好是那段固定 prompt + 两个工具**；无 runtime-context 快照；无 compaction；并**真跑一次** bash 与编辑器" |

**⇒ 三条直接后果（对我们）**：

1. ★ **我们的"关掉工具"那一臂不干净。** 自制 `exp-base-nodc` 只是**摘掉了 design-canvas**，
   但它**仍挂着 compaction / 沙箱 / runtime-context**（证据：它的 system prompt 有 **39 605 字符**）。
   上游 minimal 才是真正的**工具面下界**（2 工具、无 runtime context）。
   ⇒ **梯度必须以下游 minimal 为 G0 重建**，而不是以"少装一个包"为下界。
2. ★ **我今天手写的 `armFaceCheck`（用 `dcHits` 判臂）与上游是同一件事** ——
   上游在 registry 层就把"恰好固定 prompt + 两个工具"变成断言，并配了 keyless replay 测试。
   ⇒ **判据形态可以直接借上游的**（我们的版本可保留作"运行期抽检"）。
3. ⚠️ **硬限制：`persistent-bash` 需要 POSIX 终端底座**，笔记原文写明 **"this preset does not support Windows agents"**
   ⇒ 要用它必须走 **WSL 或容器**（本机 Docker **28.0.4 可用**，见 §4）。

#### 1.1.1 ★ 已核验（**但机制我先前引错了，且数字依赖版本轴**）

**⚠️ 我先前把两个不同的对象混为一谈 —— 这是本轮实测纠正的：**

| 对象 | 文件 | 关键差异 |
|---|---|---|
| **例子**（JSON-RPC 示例） | `examples/jsonrpc-agent/minimal.cordis.yml`（82 行） | 用 `@deepseek-ai/dsh-agent-spine-demo`；**有 `DSH_SYSTEM_PROMPT`**；有 `includeHarnessIdentity`/`workspaceContext`/`skills` 那几个旋钮 |
| **真正的 agent preset** | `apps/cli/config/agent-presets/minimal/agent.cordis.yml`（62 行，master） | 用 `@deepseek-ai/dsh-persona` + `complete: true`；**没有 `DSH_SYSTEM_PROMPT`**；persona **硬编码** |

⇒ 我先前那句"上游自测断言 system == 环境变量那句话"**只对「例子」成立**，对「preset」不成立。**结论仍是 46 字符，但要换依据**：

**master 的 preset 原文（我逐字读过）**：
```yaml
# The `minimal` agent preset: a fixed-prompt, two-tool coding-agent composition.
# The persona is the complete system prompt, so global identity, Web orientation,
# tool guidance, and later assembly listeners cannot add prompt text. ...
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false
```
⇒ persona **硬编码**就是那一句，**46 字符**（我复算过 `'You are a helpful software engineer assistant.'.length === 46`），
且 `complete: true` + `includeRuntimeContext: false` ⇒ 别的段落加不进去。

**★ 但工具数是【版本依赖】的（这条是新的）**：

| 版本 | 注释自称 | 工具 |
|---|---|---|
| **master 源码**（`package.json` = 0.1.0-rc.5） | *"a fixed-prompt, **two-tool** … composition"* | `persistent-bash` + `str_replace_editor`（+ `fs-local` 组）= **2** |
| **npm 发布 0.1.5-rc.2**（我们在 WSL 里装的） | *"a fixed-prompt, **single-tool** … composition"* | **只有 shell**（`persistent-bash` / `persistent-pwsh` 二选一）= **1**；**无 `str_replace_editor`、无 fs 组** |
| **我们自己装的 0.1.1-rc.2** | — | **`node_modules/@deepseek-ai/dsh-agent-presets/` 里根本没有 `presets/` 目录** ⇒ 我们这版的 preset 不走"文件式发布" |

另外 master 用 `text:`、发布版 0.1.5 用 `prefix:`（schema 也在变）。
⇒ **所以"G0 = 2 工具"只对 master 那版成立；对我们现役版本，G0 的工具数要按我们自己的 schema 定。**

#### 1.1.2 ★★★ 动态实测（2026-09-21）：**"干净下界"确实存在，而且它就在我们自己装的那份里**

**先纠正我上一段的一个错误**：我说"我们这版没有文件式 preset"——**找错了包**。
随附 preset 在 **`node_modules/@deepseek-ai/dsh/config/agent-presets/{code,cordis,minimal,standard}`**
（不在 `dsh-agent-presets/` 里）。

**用我们现成的装置实测**（`POST /api/agentPreset.select` + **回读** `session.list` 的 `agentPreset` 才算生效；
`eval-run --traj` 读 `metrics.systemChars`/`toolSetSize`；**我独立复算了留档文件**）：

| preset | systemChars | toolSetSize | 含 `bash`/`pwsh`/`str_replace_editor` |
|---|---|---|---|
| `council`（对照，native 模式） | **6 826** | **102** | ✗ / ✓ / ✗ |
| **随附 `minimal`（只读，`trust=system`）** | **46** | **78** | ✗ / ✓ / ✓ |
| 我们自建的 `g0`（同内容、换 id） | **46** | **77** | **✓** / ✗ / ✗ |

- **46 字符 = 就是那一句 persona 本身**，`complete:true` + `includeRuntimeContext:false` 确实把
  harness identity / Web orientation / 工具指引 / runtime context **全挡掉了** ⇒ **上游"干净下界"的说法在运行态成立。**
- ★★ **但"工具面下界"的真实下限**：三臂里都有一个 **76 个工具的底板**
  （design-canvas 的 MCP 59 + `design-canvas-bridge`/`capability-bridge`/`tool-evolution` 的原生 17），
  **preset 只能在这之上做加法**（+1 / +2 / +26）⇒
  **工具面 = profile 底板 + preset 增量**。**光换 preset 压不到 1–2 个工具；要压低必须换 profile。**
  ⇒ 我们现役两臂 `102` vs `30` 的差，正是 **profile 底板**的差（design-canvas 那 72 个）。

**★ 两个必须记住的坑（都实测踩到）**：

1. **`minimal` 这个 id 已被随附（只读，`trust=system`）preset 占用** ⇒ 你在
   `~/.dsh/.agent-presets/minimal/` 建同名 preset 会被**静默遮蔽**：
   `agentPreset.select {agentPreset:'minimal'}` 返回 **HTTP 200**、**回读也显示 `minimal`**，
   但**装的是随附那一份**（实测：读数 46 / **78** / 有 `str_replace_editor`、**无 `bash`**）。
   ⇒ 自建 preset **必须换不撞车的 id**（我们的叫 `g0`）。
   **这与 `exp-base-nodc` 那类坑同源：回读"成功"不等于"你以为的那份生效了"。**
2. ⚠️ **我们的 `g0` 在 Windows 上取错了 shell**：它抄了 `council` 的 `tool-bash` 行但**删掉了**
   `disabled: process.platform === 'win32'`（理由是"只准一行工具，照抄会让本机零 shell"）。
   结果 `g0` 的工具面里有 **`bash`、没有 `pwsh`** —— 而 `council` 之所以给 `tool-bash` 加那条 gate、
   并配一行 `tool-pwsh`，正是因为**本机（win32）要靠 pwsh 兜底**；随附 `minimal` 也是
   `terminal-pwsh`/`persistent-pwsh` 按平台二选一。
   ⇒ **Windows 上正确的 G0 应当用 `persistent-pwsh`（或保留平台 gate）**；`bash` 那条**能装配、但能不能真跑未验证**。
   **⇒ 结论：数（77/78）不是重点，"那一行 shell 在本平台是否真能用"才是。**

**⇒ 修正后的 G0 配方**（把两件事叠起来才能压到真下界）：
**`exp-base-nodc` 那样的 profile（底板 30）+ 随附 `minimal` 那样的 preset（+2，46 字符）**
⇒ 才是"干净工具面下界"；**只换 preset 只到 77–78。**

#### 1.1.3 ★★ 我们这版 preset 的真实机制（**直接决定 G0 怎么做**）

- 用户级 preset 根目录：**`~/.dsh/.agent-presets/<id>/{agent.cordis.yml, preset.yml}`**
  （随附 preset 是**只读**的，"system trust"；要加能力必须走这个 user 根目录 —— 我们仓库的
  `scripts/add-preset-council.mjs` 头注释就写了这一条）。
- 我们现役的 `council` preset 有 **263 行**：**显式逐行列出工具**（`tool-bash`/`tool-pwsh`/`tool-fs`/
  `tool-fs-search`/`tool-jobs`/`tool-skill`/`tool-goal`/…），**并挂 `compaction`**，persona 用 `text:`。
- ⇒ **这就解释了为什么我们的下界臂 `exp-base-nodc` 还有 39 605 字符**：
  它只是"少装了一个 profile 层的包"，**preset 那一层仍带着 compaction + 全部工具行 + harness identity + Web orientation**。
- ⇒ **G0 的正确做法**：**照着我们自己的 schema，从 `council` 裁出一个小 preset**
  （persona `text:` + `complete: true` + `includeRuntimeContext: false`；**只留 `tool-bash`**；
  **不挂 compaction / skills / jobs / goal**），落成 `~/.dsh/.agent-presets/minimal/`。
  **不需要抄上游的文件**（版本 schema 不同，抄过来反而会错）。
  ⇒ 这一步把"工具面"变成**一份 ~40 行、可 diff、显式枚举**的声明 —— 正是 §3.1 想要的形态。


#### 1.1.4 ★★ 但归因要改：那 39 605 字符里，**compaction / 沙箱 / runtime-context 贡献 0**

`exp-base-nodc` 与 `exp-base`（79 405）的 **39 800** 字符差，我按行级 diff 精确分解过（10 个 hunk）：

| hunk | 位置(A 的行) | 删字符 | 增字符 | 内容 |
|---|---|---|---|---|
| 1–2 | 5 / 7 | 991 / 122 | 991 / 122 | **等长替换**（净 0 字符）：身份/模型那两行 |
| 3 | 87 | 1 061 | 0 | `design_canvas_index` 的 guidance + 类型 |
| **4** | 179 | **27 350** | 0 | `mcp__design-canvas__*` 的 guidance + `ToolArgsMap`（**最大一块**） |
| 5–6 | 367 / 431 | 1 645 / 1 881 | 0 | `safe_rename` / `symbol_edit` 的 guidance + 类型 |
| 7 | 581 | 99 | 0 | 三个 `design_canvas_*: string` 类型行 |
| 8 | 674 | 7 182 | 0 | 那批 MCP 工具的 `ToolOutputMap` |
| 9–10 | 1006 / 1048 | 44 / 22 | 0 | `safe_rename`/`self_evolve`/`symbol_edit` 类型行 |

⇒ **8 个"纯删除"块合计 39 284 字符（≈ 净差的 98.7%），全部是工具目录内容**
（逐工具 guidance + `interface ToolArgsMap` / `ToolOutputMap`）
；另有 2 处**等长替换（净 0）**。

⇒ **★★ 结论（这条推翻了我一小时前的"2×2"设想）**：
**在 code(PTC) 模式下，工具目录是被【渲染进 system prompt】的** ——
所以 **"工具数量" 与 "提示长度" 在这个模式下不是两个可独立操纵的变量，后者是前者的函数**。
⇒ **我原来打算的「工具多/少 × 提示长/短」2×2，在 code 模式下做不出来**；
要做只能在 **native 模式**（工具在 `tools[]` 里、只有逐工具 guidance 进 prompt）下做。
⇒ 而**更诚实的表述**是：**在 code 模式下，"工具面"这个自变量本身就等价于"提示长度"**
（两者同向变化、且差量 98.7% 是同一个东西）—— 那就不需要 2×2，需要的是**换到 native 模式再做一次**，
才能把"工具能不能用"与"提示里写了多少"分开。


### 1.2 DSH 上游：**Python SDK + stdio JSON-RPC**（评测驱动可换）

本地就有整套：`examples/jsonrpc-agent/{minimal.cordis.yml, minimal.py, cordis.yml, cordis.snapshot.yml, tests/}`，
入口文档 `docs/user/guide/python-sdk.md`，根目录 `BENCHMARK.md` 原文只一句话：
> "Follow [Get started with the Python SDK] to install the SDK and run the **`jsonrpc-agent` minimal variant**.
> Use **separate workspaces and session IDs** for independent benchmark tasks."

⇒ **上游给的评测形态就是"每任务一个独立子进程 + 独立 workspace + 独立 session id"** —— 这正是
HarnessOpt-Bench / HarnessDev 要求的那种隔离，而且是**上游官方支持的入口**。
我们手工的 `session-create.mjs` / `session-drive.mjs` + 常驻控制面，在**评测**场景下是重复劳动。

⚠️ 但**分工要分清**（见 §2）：SDK 路径是**一次性进程**，**没有蓝绿换代 / 端口 / drain / fencing**。

### 1.3 VeRO（Scale AI，MIT）：判据 / 隔离 / 循环

见 `docs/oss-arena-landscape-2026-09.md` §1。要点：`evaluator 拥有 case 与评分`、优化器在**沙箱**里、
**inference gateway 计量预算**、**dev 逐例反馈 → val 只给聚合分 → test 只有最终 evaluator 能看**、
**20/40/40 不可变**、`baseline/build.yaml` 是唯一真相。**`uv` 在本机 `C:\Users\Admin\.local\bin\uv.exe`。**

---

## 2. ★★ 组合方案：把四块拼成一个闭环（这就是"格子"）

`docs/oss-prior-art-and-next-steps.md` 当时的结论是：**"闭环（改动 → 非环判据 → 自动部署/回退）没有现成产品：
eval 平台停在给人看报告，部署工具不懂 LLM 质量。"**
现在能看清**这个闭环可以由四块现成件拼出来**，而且缺口正好是我们的长处：

| 块 | 谁提供 | 负责 |
|---|---|---|
| **target（被测物）** | **DSH 声明式装配**（`*.cordis.yml` + profile bundles） | "harness = scaffold + tools + prompts" 的**可编辑、可 diff、可版本化**表示 |
| **下界臂 / 干净对照** | **上游 `minimal`** | 工具面下界（2 工具、无 runtime context、无 compaction） |
| **判据 / 隔离 / 搜索** | **VeRO**（MIT） | held-out 评分、dev/val/test 拆档、预算网关、version→evaluate→select |
| **上线 / 换血（闭环的落地那半）** | **我们的 switchboard** | 蓝绿换代、drain、fencing、`verifyCmd` 验证闸、profile 指纹记账 |

**为什么这是"互补"而不是"重复"**：
- VeRO **明确不做在线换血** —— 它把优化状态留在宿主、在 worktree/沙箱里跑候选，
  **只记录"当时跑的是哪个 harness 版本"**（`--pin-harness` 还是 **opt-in 复现**）。
  ⇒ **它不保证"线上正在跑的就是被评过的那一版"。**
- 我们**已经**把这件事做成了可验：`writerToken` / drain 的 `quiesced` / 端口跳号 / 
  `arm-probe` 双通道 + **数量守恒**（`docs/eval-independent-variable-plan.md` §2.1）。
  ⇒ **这一段就是"格子"，而且是别人没做的那一段。**

⇒ **一句话**：**VeRO 给"选得对"，我们给"换得对且换的就是被评过的那份"。** 两块都是 MIT / 自有，接口正交。

---

## 3. ★ 新想法（三条，都可执行）

### 3.0 ★★★ 轴现在是**可分离**的（2026-09-21 实测，这条推翻了我 §3.2 的悲观结论）

`g0` 修好（shell 用**平台 gate**：win32 得 `pwsh`、POSIX 得 `bash`，各恰好 1 个）之后，
**两个新脚本**（都在仓库里）：
- `scripts/make-g0-preset.mjs` —— 幂等装配 G0（`--force` / `--check`，`--check` 用**面指纹**而非名字判定）
- **`scripts/measure-arm-face.mjs`** —— **profile × preset 的面读数**（换代 + 选 preset + 回读 + 读 `systemChars`/`toolSetSize`；
  带 `--expectToolCount` 断言）。这是此前缺的那件工具（`arm-probe` 只管 profile、不管 preset）。

**实测矩阵**（我独立重跑过第一行，数字一致）：

| profile × preset | systemChars | toolSetSize | 工具 |
|---|---|---|---|
| `exp-base-nodc` × `g0` | **46** | **5** | `capability_report` `list_capabilities` `pwsh` `tool_apply` `tool_score` |
| `exp-base` × `g0` | **46** | **77** | 上面 5 个 + design-canvas 那 72 个 |
| `exp-base` × 随附 `minimal` | 46 | 78 | `pwsh` + `str_replace_editor` |

**⇒ 三条结论：**

1. ★★ **`profile` 只动工具底板，不改 system 一个字**（5 vs 77，差 **72 = design-canvas**；`systemChars` **都是 46**）
   ⇒ **「工具数量」与「提示长度」这两个变量现在是【可分离】的。**
   这与 §1.1.4 的发现（**code 模式**下工具目录被渲染进 system、占净差 98.7%）**并不矛盾**：
   那种耦合是 **code/PTC 模式 + 非 `complete` persona** 的产物；**native 模式 + `complete:true` persona 下它消失了。**
   ⇒ **实验的主对比就该这样做**：**固定 preset=`g0`，只变 profile ∈ {`exp-base-nodc`(5), `exp-base`(77)}**
   —— 这是一个**纯粹的工具数量操纵**，提示面完全不动。
2. ★ **真 G0 = `exp-base-nodc` × `g0` = 46 字符 / 5 工具。** 但它**不是零工具**：剩下 4 件是
   `capability-bridge`（2）+ `tool-evolution`（1）+ `tool_apply`（1）的原生工具 —— **preset 只能加不能减**
   ⇒ **想再往下压必须改 profile，改 preset 没用。**
3. ★ **`g0` 的 shell 真跑了**（不只是"在名单里"）：强制它执行 `echo g0-ok` ⇒ `pwsh` 返回 `g0-ok`，
   用**结构判据**（`lib-tool-failure.mjs` 的 `rule`，非 `isError` 位）判成功。

**⇒ 于是 §3.2 那个"2×2 做不出来"的悲观结论，现在有条件成立**：只要**把 preset 的 persona 换成
`complete:true` + 更长/更短的 `text:`**，就能在**固定 profile** 下单独拉长提示，得到真正的
{工具 5/77} × {提示 46/长} 2×2。（**前提**：`complete:true` 必须保住 —— 一旦不 complete，
harness identity / 工具指引又会加回来，提示就跟着工具数走了。）

### 3.1 把"工具面"做成**声明式组合族**，而不是"丢包"

`minimal.cordis.yml` 给了我们一个新范式：**一个臂 = 一份完整的 `*.cordis.yml`**（自包含、可 diff、环境变量参数化、
**声明了确切的工具目录**）。⇒ 梯度这样做：

| 级别 | 组成 | 备注 |
|---|---|---|
| **G0**（**已实测**） | **`exp-base-nodc` profile + `g0` preset** = **system 46 字符 / 5 工具**（`capability_report` `list_capabilities` `pwsh` `tool_apply` `tool_score`） | 见 §3.0。★ 不是零工具：剩的 4 件来自 `capability-bridge`/`tool-evolution`/`tool_apply`，**preset 只能加不能减 ⇒ 再往下压要改 profile**。★ **别在用户级建 id 为 `minimal` 的同名 preset（会被静默遮蔽）** |
| **G1** | G0 + 文件读写/搜索组（`tool-fs` / `tool-fs-search`） | |
| **G2** | G1 + `web_search` / 计划 / 目标组 | |
| **G3** | G2 + `@dsh-brain/design-canvas-bridge`（8 工具） | |
| **G4** | G3 + MCP insert（+64 工具） | = 现役 `web` 的形态 |

**好处**：每级是**一个 YAML diff**；"工具数量/集合"从"碰巧装了什么"变成**可审计的声明**；
且每级都能用同一套判据（`armFaceCheck` + boot 痕迹 + 数量守恒）验证。
这直接替掉 `docs/eval-independent-variable-plan.md` §2.4 里那套"靠 profile 变体凑梯度"的做法。

### 3.2 ★★（**已修正**）"工具数"与"提示长度"在 code 模式下**拆不开** —— 要拆必须换 native

我原来的设想是：做 {工具多, 工具少} × {提示长, 提示短} 的 2×2，把两个变量分开。

**实测把它推翻了**（见 §1.1.4）：**code(PTC) 模式把工具目录渲染进了 system prompt**
（逐工具 guidance + `ToolArgsMap`/`ToolOutputMap` 占净差的 **98.7%**）
⇒ **"工具数量"与"提示长度"在这个模式下不是两个自变量，后者是前者的函数。**

⇒ **修正后的设计（三选一，按成本排）**：
1. **换到 `native` 模式重做同一对臂** —— 那时工具在 `tools[]` 里、只有逐工具 guidance 进 prompt，
   "工具能不能用"与"提示里写了多少"才开始可分。**这是唯一真能给 2×2 的路子。**
2. **承认耦合，改问一个更锋利的问题**：既然 code 模式下"工具面 = 提示长度"，
   那就**不要再把它当两个变量**，而是直接问：**这 39 800 字符的提示增量，换来了什么？**
   （成本面：每请求多付 ≈13k token；收益面：oracle/步数/墙钟）—— 这比 2×2 更贴近真实取舍。
3. **用上游 `minimal` 当参照点**：46 字符 vs 39 605 —— 先把"下界长什么样"钉住，
   再谈中间各级（§3.1 的 G0…G4）。**但它当前跑不起来，见 §4**。


### 3.3 把"上线的那一份 = 被评过的那一份"变成**判据**

把 VeRO 的 `--pin-harness` 思路与我们的换代记账合起来：
换代完成后**自动断言"线上 profile 指纹 == 被评候选的指纹"**，不一致 ⇒ 拒绝/回滚。
现有的 `PROFILE_EXPECT` + `pluginFingerprint` 已有雏形，只差把"候选指纹"作为输入带进来。

---

## 4. 立刻可做（半天，且都要么零成本、要么离线）

1. ✅ **"量 minimal 的真实形状"——已完成**（见 §1.1.2：**46 字符 / 78 工具**）。
   以下是**已走过、降级为历史的路**（别再走）：
   - `pip install deepseek-harness-sdk` 只到 **0.1.5rc1**（缺 `session_root`/`cordis`）；
   - `dsh --profile minimal` → **`profile "minimal" does not exist`**（**轴错了 —— 它是 agent preset，不是 profile**）；
   - 起 `dsh --profile web --patch` 改默认 preset 后 unary RPC 全 **404**（鉴权已过：303 + `set-cookie`；
     404 出处在 `dsh-client-connection/lib/index.js:582/640`，条件 `!interceptor.matches(endpoint)`）；
     headless 那次还死于缺凭据（`dsh: MISSING_CREDENTIAL …`）⇒ **一个 turn 都没起**。
   - ★ **正解就是我们自己的信封**：`scripts/eval-run.mjs` 里的
     `rpc('agentPreset.select', { sessionId, agentPreset })` + `POST /api/<method>` 带
     `{type:'client-request', rpcId, method, payload}`，再用 `--traj` 读 `metrics.systemChars` / `toolSetSize`。
   - 另：**会话日志是 `.zstd` 压缩**（`session.v3.jsonl.zstd`），不是裸 JSONL。
2. ✅ **VeRO：离线编译 + 在 Linux（WSL）上端到端跑通** —— 见 `docs/vero-integration-findings.md` §6.5：
   `command` 后端**可用**（`vero evaluate` 0.60s / `vero run` 0.73s，**离线、无凭据**），
   最小配置就是 **一份 ~40 行的 `vero.toml`** + 干净 git 仓库 + **一个 Node oracle**；
   **优化器也只是一个命令**（我们自己的 Node producer 即可）。⇒ **L2+L3 可以整层交给它。**
3. **之后**才谈 cli-0007 要不要写（很可能被 §3.1 的声明式梯度或 §3.2 的"承认耦合"路线取代）。


---

## 5. 诚实：没核实 / 没把握

1. ✅ **minimal 的干净下界已动态量到**：见 §1.1.2（**46 字符 / 78 工具**，用的是我们**自己装的随附 preset**，不是上游那个 JSON-RPC 例子）。
   下面这些**已堵死/半通的路降级为历史**（别再走）：SDK 版本落后（PyPI `deepseek-harness-sdk` 0.1.5rc1 缺字段）、
   `dsh --profile minimal` 轴错（它是 **preset** 不是 profile）、unary RPC 若无我们的信封会 404、会话日志是 `.zstd` 不是裸 JSONL。
2. ~~"minimal 的 system prompt 会短得多"是预期~~ ⇒ **已静态 + 动态双证 = 46 字符**：
   静态见 §1.1.1（persona 硬编码那一句 + `complete:true` + `includeRuntimeContext:false`）；
   **动态见 §1.1.2**（用我们自己装的**随附 `minimal` preset** 实测：**46 字符 / 78 工具**，我独立复算过留档）。
   ★ **我先前把「例子」当成了「preset」**（`examples/jsonrpc-agent/minimal.cordis.yml` ≠
   `apps/cli/config/agent-presets/minimal/agent.cordis.yml`）⇒ 那句话的依据（`DSH_SYSTEM_PROMPT`）只对例子成立。
   **结论没变（46），依据换了。**
   ★ **工具数是版本依赖的，且真正的下限由 profile 决定**：见 §1.1.2 的
   「**工具面 = profile 底板 + preset 增量**」（preset 只能加，压不掉那 76 个底板工具）。
3. **VeRO 能否把 target 换成 DSH**：**已在 Linux 上端到端跑通 command 后端**（见 `docs/vero-integration-findings.md` §6.5），
   **但"把 DSH 本身做成 target"仍未试**（那一层仍是推断）。
4. ~~上游 `minimal` 不支持 Windows 原生 agent~~ ⇒ **需要区分对象**：上游**笔记**说的是**那个 JSON-RPC 例子**，
   而我们自己装的**随附 `minimal` preset 在 Windows 上跑通了**（46 字符 / 78 工具，走的是 `persistent-pwsh` 平台分支）
   ⇒ **"必须搬 POSIX"这条对 preset 不成立**（对 VeRO 的 command 后端仍然成立，已另记）。
5. 本地 `_research/deepseek-harness-master` 是**下载解压的源码树，不是 git clone**（无 `.git`）
   ⇒ 引用时请回到 `github.com/deepseek-ai/deepseek-harness` 核对版本与行号。
6. **本轮我（主代理）自己核验中发现子代理一处表述过宽**：它说"差量 **100%** 来自 `tools:sdk` 段、其余 **28 段逐字等长**"。
   按行级 diff 精确分解，准确说法是：**8 个纯删除块占 39 284 字符（≈净差的 98.7%），另有 2 处等长替换（净 0 字符）**
   —— 即 98.7% 而非 100%，且**并非只有一段不同**。**结论方向不变，数字要按 §1.1.4 用。**

