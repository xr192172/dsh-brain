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

### 3.1 把"工具面"做成**声明式组合族**，而不是"丢包"

`minimal.cordis.yml` 给了我们一个新范式：**一个臂 = 一份完整的 `*.cordis.yml`**（自包含、可 diff、环境变量参数化、
**声明了确切的工具目录**）。⇒ 梯度这样做：

| 级别 | 组成 | 备注 |
|---|---|---|
| **G0** | **上游 `minimal`**：`bash` + `str_replace_editor` | 上游 RL 参考运行时，2 工具 |
| **G1** | G0 + 文件读写/搜索组 | |
| **G2** | G1 + `web_search` / 计划 / 目标组 | |
| **G3** | G2 + `@dsh-brain/design-canvas-bridge`（8 工具） | |
| **G4** | G3 + MCP insert（+64 工具） | = 现役 `web` 的形态 |

**好处**：每级是**一个 YAML diff**；"工具数量/集合"从"碰巧装了什么"变成**可审计的声明**；
且每级都能用同一套判据（`armFaceCheck` + boot 痕迹 + 数量守恒）验证。
这直接替掉 `docs/eval-independent-variable-plan.md` §2.4 里那套"靠 profile 变体凑梯度"的做法。

### 3.2 ★★ 2×2：**把"工具数"与"提示长度"分开**（上游旋钮让这变便宜）

我之前测到 **A=79 405 字符 / B=39 605 字符**的系统提示差 ——
**那 4 万字符差值里混着"工具面"与"提示长度"两件事**，所以我此前所有成本面结论都可能是"提示变长"的效应，
**不一定是工具变多**。

而 `minimal.cordis.yml` 的 `agent-spine-demo` 把这件事**拆成了独立旋钮**：
`includeHarnessIdentity` / `includeRuntimeContext` / `workspaceContext` / `skills.enabled`。

⇒ **做 2×2**：{工具多, 工具少} × {提示长, 提示短}。
**这才能把两个变量分开** —— 而这个混淆在现在的装置上**根本拆不开**。
（这是本轮最有价值的一条新实验设计，优先级高于再加难一道题。）

### 3.3 把"上线的那一份 = 被评过的那一份"变成**判据**

把 VeRO 的 `--pin-harness` 思路与我们的换代记账合起来：
换代完成后**自动断言"线上 profile 指纹 == 被评候选的指纹"**，不一致 ⇒ 拒绝/回滚。
现有的 `PROFILE_EXPECT` + `pluginFingerprint` 已有雏形，只差把"候选指纹"作为输入带进来。

---

## 4. 立刻可做（半天，且都要么零成本、要么离线）

1. **量上游 minimal 的真实形状**（决定 §1.1 那三条是否成立）：
   在 **WSL 或容器**里按 `docs/user/guide/python-sdk.md` 起一次 `minimal.py`，
   量 **system prompt 字符数 + 工具数**，与 `exp-base-nodc`（39 605 字符 / 30 工具）对比。
   ⇒ **若 minimal 只有几百字符，"我们自制的下界臂不干净"被证实，梯度按 §3.1 重建。**
2. **离线编译一次 VeRO**（`uv` 与 Docker 都在，编译**不需要凭据**）。
3. **之后**才谈 cli-0007 要不要写（很可能被 §3.2 的 2×2 取代）。

---

## 5. 诚实：没核实 / 没把握

1. **minimal 在本机 WSL/容器里能否真跑通**（它的 POSIX 底座要求、Python SDK 依赖）—— **没试过**。
2. **"minimal 的 system prompt 会短得多"是预期，不是实测**（§4 步 1 就是去量它）。
3. **VeRO 能否把 target 换成 DSH**：仍是**推断**（未读 `vero/README.md` core guide 与 `harness-opt-bench/CONFIGURATION.md`）。
4. 上游 `minimal` **不支持 Windows 原生 agent**（笔记原文）—— 这条若成立，意味着**我们的评测臂要搬家到 POSIX**，
   而**现役评测栈（switchboard + Windows profile）在那一层不通用** ⇒ 这是个需要你自己拍板的架构选择。
5. 本地 `_research/deepseek-harness-master` 是**下载解压的源码树，不是 git clone**（无 `.git`）
   ⇒ 引用时请回到 `github.com/deepseek-ai/deepseek-harness` 核对版本与行号。
