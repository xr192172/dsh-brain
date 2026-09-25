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

## 4. ★★★ O30 裁决：`skill-tree` 与能力库**不是二选一，而是两段**
##    —— `skill` 是配方，**它是筛网**，`agent` 是产物

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
