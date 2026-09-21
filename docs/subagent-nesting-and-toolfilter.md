# 子 Agent 的嵌套与工具面裁剪：实测结论（2026-09-21）

> 触发：批准跑的两个实验 —— ① **子 Agent 能不能再唤起子 Agent**（含"超限必须报错"的负向对照）；
> ② **`toolFilter` 能不能裁出"专项工具面"**。
> 做法：子代理执行；**主代理独立复现**（自己写脚本读会话，不复用它的脚本）。
> 上游源码树（只读）：`/mnt/d/project_develop/_research/deepseek-harness/deepseek-harness-master`（下载树，非 git clone）。

---

## 1. 嵌套：**能，而且递归预算是真的**（正负两条都成立）

父会话 preset = `council`（挂了委派工具行）。会话头字段（**注意：在会话头记录的顶层，不在 `data` 子对象里**）：

| 层 | `parentSession` | `origin` | **`delegationDepth`** | `agentPreset` | 工具数 |
|---|---|---|---|---|---|
| L0 | （无） | （无） | **0** | `council` | 102 |
| L1 | `session-c90b083e…` | `subagent` | **1** | `council` | 103 |
| L2 | `436fde97…` | `subagent` | **2** | `council` | 103 |
| L3 | `8ac9ffef…` | `subagent` | **3** | `council` | 103 |

- ⇒ **四级会话真实存在，父链逐级对上**；★ **四层 `agentPreset` 全是 `council` ⇒ "子代继承父代 preset" 实测成立**
  （与 `subagent/src/child-agent.ts:108,111` 的 `composedPreset(parent.ctx)` 一致）。
- 子代比父代多的 **1 个工具是 `report`**（continuable 子代专属）。

### ★★ 负向对照（这条才让"预算"从"模型自己停了"里分出来）

L3 自己发起第 4 次委派，被**运行时**拒绝，原样（L3 会话 `seq=883`）：

```
tool/call   name=subagent   args={"description":"chain","prompt":"…","run_in_background":true}
tool/result "Error: subagent depth 4 exceeds maxDepth 3"   isError=true
```

且 **L3 里存在真实的委派 `tool/call`（2 次）** ⇒ **不是"模型不肯继续"，是预算在拦**。
（L3 随后还用 `report` 工具把这条拒收回传给父代 ⇒ `report` 通道也顺带验到了。）

**⇒ 判据两条同时成立**：**能到 2 层（L2 又成功起了 L3）+ 第 4 层被拒** ⇒ **递归预算是真的**。

来源：`maxDepth` 默认 **3**（`packages/subagent/tool-subagent/src/index.ts:98` 的 zod `.default(3)`）；
超限抛 `SubagentDepthError`（`subagent/src/child-agent.ts:32,48-54`）；`delegationDepth` 持久化在会话头
（`child-agent.ts:101-119`，注释：*"the recursion budget must survive persistence and resume"*）。

---

## 2. `toolFilter`：**真能裁，而且只裁子代**

委派行 provider = `spawn`（源码声明 `capabilities.toolFilter = true`、`depthLimit = true`）。

| preset | `toolFilter` | **子代 `tools[]` 实测集合** | 工具数 |
|---|---|---|---|
| `council`（基线） | — | 父面 + `report` | 103 |
| `council-tf` | `allow: [read, glob]` | `["glob","read","report"]` | **3** |
| `council-tfd` | `deny: [pwsh, write, edit, subagent, web_search]` | 父面 − 那 5 个 + `report` | **98** |
| `council-tf0` | `allow: []` | `["report"]` | **1** |

- **`allow` 与 `deny` 两条路都生效**；**父会话自身仍是 102 个工具** ⇒ **过滤只作用于子代**。
- 子代把这个配置**持久化**在自己的描述符里（`subagent/descriptor`）：
  `{"version":2,"mode":"continuable","provider":"spawn","label":"tf","agentProvider":"deepseek-official","agentModel":"deepseek-v4-flash","toolFilter":{"allow":["read","glob"]}}`

### ★ 一处对源码警告的**修正**：`allow: []` **不是 0 个工具，是 1 个**

源码注释警告 *"`{ allow: [] }` 会拒绝所有工具"*。实测：**102 个可裁的全局工具全被拒**
（`admits()`：`allow !== undefined && !allow.has(name) ⇒ false`，空 Set 恒假），
**但子代自己作用域注册的 `report` 活了下来** —— `dsh-tools` 的 `view()` 把 **own-scope 工具无条件放进可见集**，不受 `restrict()` 约束。
⇒ **"空数组=全拒"对【全局工具】成立，对【子代自有工具】不成立。**
（这类"警告说 A、实际 A+B"的差，正是要量的东西。）

---

## 3. 对本项目的意义（为什么这两个能力都关键）

### 3.1 「专项子 Agent」现在有了**可测形态**

我们先前查到：委派工具的三个"专业面"旋钮 = **`persona`（影子人格）/ `toolFilter`（工具白黑名单）/ `maxDepth`（递归预算）**，
且**委派工具没有 `agentPreset` 参数** ⇒ 换整套装配要走宿主侧。
⇒ **实测确认了"轻路径"可行且有区分度**：**同一个 preset + 每次委派的 `toolFilter`** 就能造出**专项工具面**
（103 → 3 / 98 / 1，**任意可裁**），而且**这个量我们已经在量**（读子代会话的 `request/header.tools[]`）。
⇒ 与我们今天建立的"**工具面 = profile 底板 + preset 增量**"合成完整图景：
**`profile` 定底板 ⇒ `preset` 定该 agent 的增量 ⇒ `toolFilter` 定【这一次委派】给子代的裁剪。**
三层都能声明、都能量。

### 3.2 「通用基底 vs 专项」= **同一套机制的两个配置**，不需要两套预设

- **通用基底** = 不裁剪（或只留编排工具）；
- **专项** = `persona` + `toolFilter` 收窄；
- **"拆解到别的专项任务"** = **让子代自己再委派** —— **前提是那份 preset 挂了委派行**
  （子代继承父 preset ⇒ 有委派行就能继续下探），并被 `maxDepth`（默认 3）兜住。

### 3.3 判据侧的直接用途

`delegationDepth` 现在是**可从会话头读出的持久字段** ⇒ 我们不必为"按 lineage 统计"另造机制；
把它并进先前建议的「**上下文指纹**」（首条 `request/header` 的 system 长度 + 消息数 + 有无 `report` + **`delegationDepth`**）即可。

---

## 4. 复现方式与留档

- 实验产物：`D:/project_develop/_scratch/nesting/`（`exp1*.mjs` / `exp2.mjs` / `mkpreset.mjs` / `TASK.md` / `exp2-tf{allow,deny,empty}.json`）。
- 新增 3 个**用户级 preset**：`council-tf`（allow）、`council-tfd`（deny）、`council-tf0`（空 allow）——
  它们是实验二的**可复现装置**，留在 `C:/Users/Admin/.dsh/.agent-presets/`（要清就删这三个目录；**别动 `council`**）。
- 子代理自伤一次并已修正：第一版 `council-tf0` 把 `allow: []` 写成了 `- []`（YAML 成了列表），
  已删目录重建；**坏文件从未被任何会话使用过**（可查会话时间早于修正）。

---

## 5. 未验证 / 没把握

1. **`maxDepth` 非默认值**未试（只验了默认 3）。
2. **`acp` / `dsh-sdk` 不支持 `toolFilter`** 仅是源码断言，**未实测**（未触发那条拒绝）。
3. **`subagent_fork` 行**（与我们测的 `subagent` 行独立、各有自己的 `maxDepth`）**未做同套实验**。
4. **`delegationDepth` 只出现在会话头**，**不在 `session.list` 投影里**（该投影只有 `parentSessionId`/`origin`）
   ⇒ 要按深度统计，得读会话头（读法见 `out/verify-nesting2.mjs` 的思路）。
5. ★ **我自己的核验方法错了一次**：先按 `evs[0].data.parentSession` 找 ⇒ 零命中，**差点据此判子代理"报了个不存在的字段"**；
   实际字段在**会话头记录的顶层**。⇒ 教训：**先确认字段位置，再判"有没有"**（与铁律 #12/#18 同族）。
