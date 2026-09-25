# 训练场 + Agent 工厂（筛网）—— 2026-09-25 用户裁决

> 本文是**结论固化**。用户原话要点逐段引在本文件里；后续施工以本文件为准。
> 相关：`docs/capability-registry-evolution.md`（能力库）、`packages/skill-tree/`（数据层）、
> `evals/arms.json`（臂注册表）、`scripts/delegation/launch-arm.mjs`（按臂起代）、
> `packages/arm-isolation/`（臂间隔离）。

---

## 1. ★★★ 「臂」改叫「训练场」，且**不需要自变量容器**

用户原话（要点）：
> *"B 这方面也无所谓吧……只要你能够保证**上一个和下一个它的数据是隔离的**……这个 b 的变量都无所谓啊，
> 因为你**派这个子 agent 去做和派那个子 agent 去做和自己亲自去做**，反正你只要**记录了这一整套流程的消耗和最后的结果**，
> 那都是一样的呀。这个所谓的 B 只是说，不如叫**训练场**算了，**训练场然后记录你的训练成绩**，
> 然后**锚定好你这个训练的参与者是谁**，就那不就可以了。反正我们只是用来做测试的。"*

### 定义（固化）
**训练场 = 三样东西：**
1. **隔离的数据** —— `DSH_HOME`（会话 / settings / lease / 能力库 / 记忆库）与**上一次、下一次**都不共享；
2. **记录** —— **这一整套流程的消耗 + 最终结果**（⚠️ 注意口径是"**整条流程**"，不是只有被测那一次调用）；
3. **锚定参与者** —— **是谁做的**（哪个子 agent / 哪个模型 / 哪个 preset / 什么工具面 + cwd + store）。

### 由此**取消**的一个隐含假设
❌ 原来有一条隐含假设：**"臂 = 自变量的容器，所以不同臂要有不同的 profile"**。
✔️ 用户明确了：**不需要**。因为
> *"派这个子 agent 去做和派那个子 agent 去做和自己亲自去做……只要记录了消耗和结果，那都是一样的。"*

⇒ **没有任何"profile 上要变什么"的问题**（`--profile` 保留为**基础设施**参数，不是实验自变量）。

### 落点
- `evals/arms.json` 的**语义**从"实验臂"改成"**训练场**"（字段 `cwd`/`store`/`preset`/`label` 保留 = **参与者锚定**）。
  ★ 不改 schema（多脚本共享输入）；改名/改口径走**文档 + `label`**。
- `scripts/delegation/launch-arm.mjs --arm <名>` 保留（兼容），文档口径改"训练场"。
- ★ **`--record` 的 `out/arm-gen-index.json` 就是"训练成绩台账"**：`{ arm, gen, profile, cwd, store, at, mode, note }`。

---

## 2. 由此**解掉的两个卡点**（昨天还挂在"未闭环"里）

| 原卡点 | 现在的状态 |
|---|---|
| "臂的 profile 只是控制剖面的副本 ⇒ 半成品" | ✅ **不是问题** —— 本来就不需要差异（见 §1） |
| "`arm-isolation` 未接线（`self` 从哪来推不出）" | ✅ **可做** —— `self` = **训练场身份**（由 `--arm` / 台账注入，走 `envExtra`），**不需要 profile 差异** |

⇒ **"一臂一代"的真实含义**也随之改清：不是"每个臂一个装配剖面"，而是
**每次训练 = 一套隔离数据 + 一页成绩单 + 一个锚定的参与者**。

---

## 3. 隔离的边界（我实测后**撤销**昨天那条"未闭环"）

昨天我写"`node_modules` 联接指向现役 ⇒ **不是完全隔离**"。用户质疑：
> *"不是完全隔离，但是按理来说每次编译，就每个 bid 自己编译一次，它也不会去读这个 node modules 吧。"*

**实测证据（我查的）**：
```
profiles/web/node_modules/@dsh-brain/*  →  全部是【符号链接】，指向 D:\project_develop\dsh-brain\packages\*
现役 profiles/web/node_modules         →  【真目录】（readlink 报 EINVAL）
隔离实例的 node_modules                →  【联接】指向上面那个真目录
```
⇒ 共享的那一层 = **同一个仓库、同一份代码**（`packages/*` 经符号链接进入 profile）。
**代码本来就只有一份**，没什么可隔离的；**要隔离的是状态**，而状态在 `DSH_HOME` 里，**那一层是独立的** ✓
⇒ **昨天那条"未闭环"撤销**（用户是对的）。

---

## 4. ★★★ O30 裁决：`skill` 是配方，**它是筛网**，`agent` 是产物 —— 与能力库**不是二选一，而是两段**

用户原话（要点）：
> *"我们当时不是想在 Skill Tree 上面去做吗？用 Skill 去 —— 就是一个 **Skill 它里面包含的那些字段完全可以作为一个
> 子 Agent 的一个配置去用**，然后**以配置来创建新的 Agent**，就做一个 **Agent 工厂**，
> 然后通过填配置去得到新的子 Agent……**这个就是工厂里的那个工艺清单**。
> ……然后就是**从外面获取 skill 或者说是自己生长 skill，然后从这个 skill 里面挑好的，然后去做成 agent，
> 然后这个 skill 就可以退役了**。**实际上它就是一个筛网**。"*

### 裁决（固化）
```
外部 skill 源 ─┐
               ├─→ [ skill 数据层 ] ─→ [ 筛：挑好的 ] ─→ [ Agent 工厂：按配置实例化 ] ─→ 新子 Agent
自生长 skill ──┘        (skill-tree)      (质量门/判据)        (配置 → agent)              │
                                                      ▲                                   │
                                                      └────── skill 退役（生命周期终点）───┘
```

- **`packages/skill-tree`（数据层）的定位 = 工艺清单/配方**：
  其 `package.json` 逐字写着"**只做数据层**：类型 + 生命周期 + **Absorb（新建/合并/融合的账本）**，
  **刻意不含执行器**" ⇒ **与"配方 + 生命周期"完全对位**（退役就是它的生命周期终点）。
- **能力库那条线（`capability-*.mjs` + 注册门 + 回执）的定位 = 门**（谁够格、有没有退化）。
- ⇒ **关系**：**不是 (a)/(b)/(c) 三选一**，而是 **`数据层(配方) + 门(判据) + 工厂(实例化)` 三段**。
- ⇒ 与项目既有论断一致：★ **"sub agent 就是它的能力；这比自己给自己改好得多"**
  （`docs/capability-registry-evolution.md` 逐字）。

### 待定义（**接缝**，下一步真正要做的）
1. **谁读 skill 字段**：`skill → agent 配置`的字段映射表（哪些字段直接进 agent 的 `persona/tools/preset/…`）；
2. **谁判定"好"**：筛的判据（现成的判据阶梯 L0–L3 可作为候选，但**它现在的对象是"能力"，不是"skill"** ⇒ 要明确口径）；
3. **谁执行实例化**：工厂落在哪（`ctx.subagents` 注册？还是生成配置 + 走既有预设机制？）；
4. **退役怎么记**：skill 退役 = `skill-tree` 生命周期的哪个状态、与 `capability-registry` 的 `supersededBy` 如何对齐。

---

## 5. 顺手抓到的一个真缺陷（**哑弹**）

`C:\Users\Admin\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-mcp-client` 是**坏符号链接**：
```
readlink  = C:\Users\Admin\.dsh\profiles\web\D:\project_develop\dsh-brain\node_modules\@deepseek-ai\dsh-mcp-client
            ↑ 目标被【拼接】坏了（profiles/web/ + 一个绝对路径）
existsSync = false
```
- 而 `profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` **都声明了它**
  ⇒ **声明了却解析不到**，而**启动期没有明确报错**（boot.log 里没有对应 error）
  ⇒ **假绿同族**：以为装好了，其实那个 bundle 没加载。
- ★ 待修（一行：重建正确链接）；**它在用户的个人目录下（`~/.dsh`），本文件作者没有擅自改动**。

---

## 6. ★★★ 接缝①：字段映射表（`skill` → `agent` 配置）—— **照实物写，不发明**

用户问："我们的子 Agent 现在是配置驱动的吗？" ⇒ **先答系统侧**（实测，见 `docs/skill-as-agent-spec.md`）：

| 问题 | 实测答案（规格里的**已定裁决**） |
|---|---|
| **配置驱动？提供什么工具** | ✅ 是。能力项 = 四个旋钮：**`toolFilter`（裁工具面）/ `persona` / `outputSchema` / `depthLimit`**。规格逐字："**spawn 版可以从出生就带窄脸：`toolFilter` 裁到所需子集 + 出生时把脸定死**" |
| **同一 agent 能否既有分身又有不分身** | ✅ **是**。D10 逐字：**"spawn 与 fork 走同一条装配路径，只差一个 `seed`"** ⇒ 两个**接口**，不是两种 agent |
| **能否叠加子 agent** | ✅ 能，**硬上限 `maxDepth = 3`**（**绝对深度、无递减**，depth 4 运行时被拒）；★ **不许混用 `provider-managed`**（会让深度失去单一权威）。关键性质："**层层都是同一张 preset 脸，深度增加不带来任何工具累积**" |
| **子 agent 有多会话吗** | ✅ **各是独立 session + 独立 UUID，不会互相覆盖**；成员里有 `prepareContinuable` ⇒ **可继续**。★ 真并发雷只有一处：**"按 preset 各挂一份"的注册会重复**（D9） |
| `outputSchema` | ★ 规格**倾向默认不用**（改固定小标题的文本回执）；切换依据 = 解析失败率 / 因回执约束返工 / 字段缺失率 |

### 映射表（字段取自实物：`packages/skill-tree/src/index.ts` 的 `SkillNode`）

★★ **决定性证据**（`:160-161` 逐字）：
```ts
  // ── ch22 §6：工具声明（有 Script/Tools ⇒ 可升格 sub agent）──
  Tools: ToolDef[]
```
⇒ **代码里早就埋了"skill → sub agent"这个钩子** —— 用户的裁决不是新发明，是**把既有钩子接上**。

| `SkillNode` 字段（实物） | → agent 配置 | 依据 |
|---|---|---|
| `Principle` / `Fix` | **`persona`**（方法论文本） | 两字段就是"原理 / 怎么修" |
| **`Tools: ToolDef[]`** | **`toolFilter`**（工具面） | ★ 注释逐字"**有 Script/Tools ⇒ 可升格 sub agent**" |
| `Script` / `ScriptLang` / `Archive` | 工具的**落地执行物**（python/shell/js/go） | 字段注释 |
| `Triggers: string[]` | **路由依据**（何时用这个 agent） | 注释逐字"路由依据" |
| `Extends` / `Requires` | **继承 / 组合**（"子继承父的 body+triggers+script"；`Requires` **一层深、不递归**） | 字段注释 |
| `Score` / `UseCount` / `SuccessRate` / **`Level`** | ★★ **筛的判据**（"挑好的"的可执行定义） | `Level` 注释逐字：**`3=L3（score≥0.7 ∧ use_count≥10）`** |
| `Status` / `AbsorbedBy` / `MergedFrom` / `isAbsorbed()` | **退役 / 吸收**（生命周期的终点，**已有实现**） | `isAbsorbed` 已在 `skill-tree` 里 |
| `Source` / `SourceFile` / `SourceHash` / `ImportVersion` | **"从外面获取"** + 上游变更探测（`update_pending`） | 字段注释 |
| `ValidationScore` / `LastValidated` / `RejectedAttempts` | **质量门的历史**（可作筛的输入） | 字段存在 |
| `Brain` / `Parent` / `ID` | 归属脑 / 谱系 | 字段注释 |

### ★ 映射表里**缺的两格**（这才是真正要补的）
1. ~~`toolFilter` 有没有实物支撑~~ ✅ **查清了**：`ToolDef`（`skill-tree/src/index.ts:21`）**就是"工具声明"的完整形状**：
   ```ts
   Name        // 工具名（全局唯一，建议前缀如 scout_）
   Description // 给 LLM 看的描述
   Kind        // "python" | "shell" | "subprocess"
   Entry       // 脚本入口（相对 skill 目录）
   Fn          // 调用的函数名（python）或子命令（shell）
   Schema      // JSON Schema（注册到 ToolRegistry）
   ReadOnly    // true = 纯计算/查询，不修改文件系统（跳过权限审批）
   ```
   ⇒ **可直接落成 `toolFilter`**（`Schema` 注册进 ToolRegistry；`ReadOnly=true` 跳过审批）
   ⇒ **"skill 升格成 agent"这条路在数据层是通的，不缺零件。**
2. ★ **`outputSchema`** —— `SkillNode` 里**没有**对应字段（规格又倾向默认不用）⇒ 要么不加，要么只在需要时补。
3. ★ **`depthLimit`** —— `SkillNode` 里**没有**；而系统侧有硬上限 3。
   ⇒ **必须明确**：skill 升格出的 agent **允许自己再委派几层**（0 层 / 1 层 / 跟随全局上限），
   ★ 且**不许混用 `provider-managed`**（否则深度失去单一权威）。

### 接缝①的**下一步**（前两条已被本次查清）
1. ~~读 `ToolDef` 的真实形状、确认能否直接落成 `toolFilter`~~ ⇒ ✅ **已完成，见上**；
2. 定 **`Level` 的筛口径**是否直接复用（`score≥0.7 ∧ use_count≥10`），还是另立
   （★ 别让"筛"和"能力库的判据阶梯"两套口径打架）；
3. 定 **升格动作落在哪**（谁读 skill ⇒ 生成 agent 配置 ⇒ 交给哪个 provider：**`spawn` + `toolFilter`，不是 fork**）；
4. 定 **退役的记账**：★ 实测 `SkillStatus` 有**四级**：`active / demoted / archived / absorbed`
   （`demoted` = 降级，是被忽略的中间态）⇒ 与 `capability-registry` 的 `supersededBy` 对齐时**要处理降级**，
   不能只对齐"退役/吸收"两态。
