# cli-0005 为什么零区分度 + 下一道题的设计（2026-09-21）

> 本文是**只读调研**：没有跑新实验，没有改任何代码。所有数字来自
> `out/eval-pair-cli-0005-symbol-rename-design-canvas-1789960605790.json` 里点名的 5 个会话转录
> （`C:/Users/Admin/.dsh/sessions/**/session.jsonl.zstd`，用 `scripts/eval-run.mjs --traj <sid>` 与一次性的
> 转录导出脚本重算）。单价写法见文末附录 A。
>
> 结论先给三句：
> 1. **三个陷阱不是被"理解"掉的，是被"长唯一文本锚点 + 一次全读"绕过去的** —— 靶子只有 3 个文件 70 行，
>    整个作用域一次 `read` 就装完，"判定作用域"这个动作的成本是 0。
> 2. 因此**敏感点必须落在"要先解出一张引用图才能决定改哪几行"**这类操作上，而不是"某个符号看起来像不像"。
> 3. 但在这套 harness 里，光加难度的第一步不是配题，而是**补叶子工具直方图** —— 现在的行为面读数（`byTool`）
>    在 code 模式下恒等于 `{"run_code": N}`，两臂长得一模一样。

---

## 1. B 臂（无 design-canvas）实际是怎么做成 cli-0005 的

### 1.1 先修一个口径：两臂模型看到的工具面**都是** `["run_code"]`

这一点容易被漏掉，而它决定后面所有"行为面"能不能读：

| 会话 | 臂 | `request/header.tools[]` | `header.system` 字符 | `design_canvas_\|mcp__design-canvas__` 命中 |
|---|---|---|---|---|
| A1 `session-0eef4e34` | A（`exp-base`） | **1**（`run_code`） | **79 405** | **135** |
| A2 `session-59adf627` | A | 1 | 79 405 | 135 |
| B1 `session-3c208cc6` | B（`exp-base-nodc`） | 1 | 39 605 | **0** |
| B2 `session-8a0adb7c` | B | 1 | 39 605 | 0 |
| B3 `session-2c11e358` | B | 1 | 39 605 | 0 |

⇒ **"102 vs 30" 这个自变量，在模型侧的实际形态不是"可选工具多了 72 个"，而是"系统提示多了 39 800 个字符"**
（≈ 每次请求多付 ~13k token），并且 `run_code` 内部**能 dispatch 到**的 `tools.*` 名字多了一批。
这个口径 `scripts/eval-run.mjs:198-205` 已经写明（"用工具条数判臂在 code 模式下必然瞎"），
`scripts/check-code-mode-surface.mjs` 结案同源（code 模式 `wireSchemas()` 过滤成只剩 `run_code`）。

**这条对成本面有直接后果**：A 臂每次请求都比 B 臂多背 39.8k 字符，任何"差值"里都混着这个常数。
`task-bank-thinking.md` §7 那张表（A 更省）没把这个算进去。

### 1.2 三条 B 会话的实际步骤（叶子工具直方图，`tool/code-dispatch` 重算）

| | 外层 `run_code` | 叶子调用合计 | `read` | `glob` | `pwsh` | `grep` | `edit` | 其它 |
|---|---|---|---|---|---|---|---|---|
| A1 | 10 | **20** | 9 | 1 | 5 | 1 | 0（2×`symbol_edit`） | `safe_rename`**2** |
| A2 | 9 | **20** | 8 | 1 | 7 | 1 | **2** | `safe_rename`**2** |
| B1 | 12 | **34** | 10 | 2 | 11 | 2 | **7** | `list_capabilities`1 `job_output`1 |
| B2 | 13 | **33** | 12 | 2 | 9 | 1 | **8** | `job_output`1 |
| B3 | 9 | **27** | 6 | 1 | 9 | 3 | **8** | — |

★ 注意：**上表的"叶子调用"今天算不出来**。`scripts/eval-run.mjs:380` 只数 `type === 'tool/call'`，
`tool/code-dispatch`（`run_code` 内部的真派发）从未被计数 ⇒ 报告里 `byTool` 恒为 `{"run_code": N}`，
`toolSetSize` 恒为 1。**这是"行为面"目前唯一能用的通道，而它是瞎的。**

### 1.3 六步，全部验证过（以最快的 B3 / 38.07s 为主，另两条同构）

1. **读题面**：`read README.md` + `glob rename-target/**`。
   ⇒ 拿到两件事：规格；**以及"这个目录里只有 4 个文件"这个上界**。
2. **全量读**：`read` `math.js`(27 行) / `store.js`(18) / `index.js`(25) / `check.mjs`(82) —— **合计 ~150 行**。
3. **再读一次判据**：B1/B3 读 `check.mjs` 前 30 行；**B2 专门去读 `check.mjs:55-70`**（就是 ③ 那条"剥字符串后计数"的实现）。
4. **闭合引用**：一次 grep。B1 `grep computeHash|digestOf`；B3 `grep rename-target` + `grep \bcomputeHash\b --include=*.js` + `git log --all/branch -a`（还查了别的分支）。
5. **改**：7–8 次 `edit`，每次 `old_string` 是**完整的一整行**（逐字，含中文注释与模板串）。
6. **验**：跑 oracle ⇒ **三条会话全部一次绿**（不是试错出来的），再重读文件/独立重算一遍。

### 1.4 三个陷阱逐个是怎么失效的（这是第 1 问的答案）

**陷阱① 同名局部变量不许改 —— 失效原因是"行级文本不同"。**
目标站点是 `export function computeHash(s) {`；局部变量是 `const computeHash = 'legacy'`。
这两行作为**整行锚点**毫无交集。任何一次 edit 的 `old_string` 里都不含裸标识符 `computeHash`，
所以两个"同名"在文本上**不可能被同一次替换同时命中**。
⇒ **模型不需要知道"这个是局部变量"，它只需要选的锚点是整行。**

**陷阱② 字符串常量 `'computeHash-v1'` 不许改 —— 同样死于锚点选择。**
它只出现在 `export const KEY_NAMESPACE = 'computeHash-v1'` 这一行。**任何一次 edit 的 `old_string` 都不包含这一行**
（它跟任何一个要改的站点都不在同一行）⇒ 不可能被误伤。
（对照：A 臂调 `safe_rename` 时甚至显式传了 `apply_literals: true`，工具自己判定"字面量不该动"，写盘 0 个文件 —— 两臂在这里殊途同归。）

**陷阱③ 注释要跟改 —— 失效原因是"整个文件都在上下文里"。**
`math.js` 第 1 行、`store.js` 第 1 行的注释是在第 2 步"全量读 150 行"时**顺手看到的**，
不是靠任何索引找到的。⇒ "注释属于名字出现的地方"这条规则的难点其实是**查全**，
而当靶子只有 150 行时，查全的成本 = 读文件的成本 = 已经付过了。

**⇒ 一句话：这三条规则要求的全部能力（判作用域、分字面量、查全注释），在"能一次读完 + 每一行都够长且唯一"
的靶子上，被"选长锚点"这一个动作同时满足了。** 符号工具在这里唯一的增量，是把 8 次 edit 折成 2 次调用。

### 1.5 差点翻车的四处（"不止几分钟 midnight 到此为止）

1. **B1 有 5/12 次调用与题无关**：`check-all.mjs` 在沙箱里写 `D:\project_develop\dsh-brain\out\bom-check.txt` 拿 EPERM
   ⇒ regression 15 项全红 ⇒ 它又去读 `check-all.mjs`、做 `spawnSync` 管道诊断（实测 `pipe: err=EPERM` / `ignore: status=0`）、逐门单跑。
   **63.08s 里有一部分就是这样烧掉的**。（注意：不是全部 —— B1 的 `callsTotalMs` 只有 6 191ms，wall 57s 量级是生成 + 等审批（`approvalWaitHits=2`）。别把两个来源混为一谈。）
2. **B2 想自己做一次"独立重算"，连做三次才成功**：第一次 `node -e` 里 `\b` 与反引号被 PowerShell 转义吞掉；
   第二次写临时 `.mjs` 到 `%TEMP%`；第三次才在 `run_code` 里做 in-process 计数成功。
   ⇒ **文本工具链的一个隐性成本：转义**。这个成本与实际做题能力无关，但会实打实进 `outputTokens`（B2=9476）。
3. **B2 有一次 pwsh 的 `workdir` 写成了主仓**（`D:/project_develop/dsh-brain`，不是 `_wt/cli0005-B`），目标是 `scripts/check-bom.mjs`。
   ⇒ 虽然被沙箱 EPERM 挡住没真写进去，但这是**隔离面上的一次真实越界**；`write-outside-repo` 规则抓到了它（B2 `dangerous=7` 的一部分）。
4. **A 臂也没有全程用符号工具**：A1 用 2 次 `symbol_edit(op=replace_text)`、A2 用 **2 次普通 `edit`**，
   都是为了改那两条注释，而且 `old_text` 就是整行文本。
   ⇒ **"符号工具会自动覆盖注释"这个假设在实测里不成立**（`evals/pilot/rename-target/README.md` §预期两臂差异
   那张表里也是这么写的）。A 用 `safe_rename` 只把 `edit` 次数从 8 降到 2 —— **省下的 6 次正好是 3 个文件的引用点**，
   注释这个坑对两臂是一样的文本活。

### 1.6 成本面为什么撑不起区分度

| | A1 | A2 | B1 | B2 | B3 | A/B |
|---|---|---|---|---|---|---|
| wall(s) | 33.98 | 33.99 | 63.08 | 54.82 | 38.07 | 1.53× |
| outputTokens | 5 591 | 4 554 | 10 589 | 9 476 | 6 073 | 1.72× |
| 叶子调用 | 20 | 20 | 34 | 33 | 27 | 1.57× |
| 其中 `edit` | 0 | 2 | 7 | 8 | 8 | **3.75×** |
| `callsTotalMs` | 3 135 | 4 021 | 6 191 | 5 116 | 5 104 | 1.45× |
| `dangerous` | 6 | 9 | 5 | 7 | 5 | **反了** |

三个读数说明问题：

- **`edit` 是唯一有 3.75× 差的一列**，但它只占叶子调用的 1/4，被"读文件 + 跑 oracle + `git status`"这些**两臂同价的公共动作**摊薄到 1.57×。
- **`dangerous` 反而 A > B** —— 这一列现在是噪声：`write-outside-repo` 命中在 `_wt/cli0005-A` 这种**路径字符串**上（文本匹配型判据不懂语义，`gate-authoring` §常见假绿 那条）。**这一列目前不能进任何结论。**
- **B3（38.07s / 6 073 tok）已经压到离 A 只差 12%** ⇒ 分布本身就重叠，`n=3` 时看不出东西是**必然**的，不是运气。

---

## 2. 什么样的题才真正需要"索引/符号级工具"

### 2.1 一句话判据

> **敏感点必须落在"要先解出一张引用图，才能决定改哪几行"的操作上，并且这张图不能靠
> 「一次 grep」或「一次全读」还原。**

原因不是"更难"，是**复杂度级别不同**：

- 文本侧成本 ≈ **O(候选集大小 × 图的层数)**：候选集每一条都要人（模型）判断"它绑到哪个模块"，每判断错一条就是一处静默错误。
- 符号侧成本 ≈ **O(1) 次调用**：`find_references` / `impact_analysis` / `rename_symbols` / `rename_many` / `cross_repo_symbol_index` / `remove_dead_imports`
  （这些名字是从 `out/dc-mcp-tools.txt` 核出来的真目录，`mcp__design-canvas__*` 前缀）把同一件事做成一次查询。

⇒ **只有当候选集从"十"涨到"百"、层数从 1 涨到 ≥3 时，两侧才会分开一个量级。**
cli-0005 的候选集是 **8 站点 / 3 文件 / 70 行 / 0 层间接** ⇒ 两边都被压在同一个常数上。

### 2.2 四个放大器（每个都让文本侧超线性）

| # | 结构 | 为什么文本侧恶化 | 符号侧 |
|---|---|---|---|
| **S1** | **引用闭包不可一次搜索得到**：`export * from` 逐层转发（链长 ≥3）、`import { X as Y }` 别名、barrel 再导出、动态 `await import()` | 每过一层要一次新 grep，并把结果与上一层**做并集去重**；漏一层 = 漏一处，而 ESM 具名导出缺失是 **SyntaxError**（直接炸，比静默好，但对做题者是"回溯成本高"） | `find_references` 一次 |
| **S2** | **同名多符号分散在不同模块**：全仓 K 处文本命中，其中只有 k 处绑到目标 | 必须**逐条判定绑定**= 手建 import 图，成本 O(K × 图深度)；误判一条就污染一个**不该动**的文件 | `safe_rename` 一次 + preflight |
| **S3** | **出现面大到一次读不完**（> 上下文能装下的量，或文件数多到必须分批） | 读的成本线性涨、且"改完再验证"要重读⇒ **一次 MiB 级的来回** | 同样加倍，但只加在写盘那一侧 |
| **S4** | **判据/规格被 agent 读到**（负向放大器，但最关键） | 前三条**全部折价**：先读答案，再按答案定位，难度塌回"力气活" | 同样折价 ⇒ **区分度归零** |

**S4 是 cli-0005 真正的病根之一，必须单独拎出来**：`README.md` 把三个陷阱印在题面上（第 2、3 条明写"不许改"），
`check.mjs`（含每条判据的实现与期望值）就放在 agent 能读写的 worktree 里。
三条 B 会话**都读了 `check.mjs`**。⇒ 任何"陷阱"只要被题面自己公布 + 判据可读，都会被降级成"照抄规格"。
这违反 `evals/README.md` 的 **R1（判据必须在 Agent 够不到的地方）** —— 现有 cli-0004 / cli-0005 都没做到。
（的判断不难理解：`evals/` 整个都在 worktree 里，凡是写在那里的 oracle，做题的 agent 都能读。）
### 2.3 量化门槛（落题前用这张表筛，不许拍脑袋）

右两列是 cli-0005 的**实测值**：

| 指标 | 门槛 | cli-0005 实测 | 判 |
|---|---|---|---|
| 目标站点数（要改的 occurrence） | **≥ 50** | **8** | ✗ |
| 涉及文件数（要动的） | **≥ 25** | **3** | ✗ |
| 靶区源码行数（不含判据/README） | **≥ 1 500** | **70** | ✗ |
| 再导出链最长长度 | **≥ 3** | **0** | ✗ |
| 同名不同符号的模块数 | **≥ 2**（且跨目录） | 1，且在本文件内 | ✗ |
| agent 能否读到判据/答案清单 | **不能**（或只能读到"规格级"清单） | **能读 `check.mjs` 全文** | ✗ |

⇒ **cli-0005 六项全在门槛的错误一侧。** 它不是"稍微不够难"，是**每一项都还没到量级切换点**。

### 2.4 反例：哪些"看起来更难"的加难度不做

- **加更多同类型陷阱**（第 4、5 个"不许改"的东西）⇒ 只加 S2 的常数，不加任何结构；两臂都读得快，都按行锚点躲。**做了等于白做。**
- **缩小预算**（`maxToolCalls` 30 → 15）⇒ 两臂一起超预算 ⇒ 都失败 ⇒ 区分度还是 0，而且两侧数据都是截尾的 censored 值（`docs/eval-capability-task.md` §6.2 已经在 cli-0005 上踩过一次：cannot compare 不同量纲）。
- **换更难的符号**（加长名字 / 加更多重载）⇒ 与上述同构。
- ★ **把判据写得更严**（更多条文本断言）⇒ 只会放大 S4（更容易被读），并且踩 `gate-authoring` 那条
  **"文本匹配型判据不懂语义"**。判据要从**运行时形状**来，不从文本来。

---

## 3. 新题设计稿：`cli-0007-multi-module-rename-closure`

> 只落到设计稿，不实现。id 用 0007：**0006 已被 `docs/eval-independent-variable-plan.md` §A.4 的委派题预定**。

### 3.1 题面（公开给 agent 的部分，只有三句）

> 把 `evals/pilot/rename-graph/core/hash.js` 导出的 `computeHash` 更名为 `digestOf`，
> **并把它的全部调用方都改对**（含经 barrel / re-export 链间接拿到这个符号的那些）。
> 仓库里有**别的模块也导出了同名符号**、有一个局部变量也叫这个名字、有一个字符串常量也含这个旧名 ——
> 这些**都不是它**。改完后 `node evals/pilot/rename-graph/run-canary.mjs` 的输出必须与基线一致。
>
> **不点名任何文件、不给清单、不写"陷阱一二三"。**（对应 S4：答案降级为规格。）

### 3.2 夹具：`evals/pilot/rename-graph/`（**本仓库内、git 跟踪、生成器产出**）

由 `evals/checks/cli-0007.gen.mjs`（**判据侧，不入题面**）按固定种子生成；同一份真值同时写出
`evals/checks/cli-0007.truth.json`。规模（按 §2.3 门槛定的）：

| 项 | 值 | 对应放大器 |
|---|---|---|
| 源模块数 | **~36** | S3 |
| 源码行数 | **~2 000** | S3 |
| 目标站点总数 | **~55** | S3 |
| 直接 `import { computeHash }` 的模块 | 12 | 基线 |
| 别名导入 `import { computeHash as ch }` | 6 | S1 |
| **re-export 链**（`lvl1 → lvl2 → lvl3 → deep`，每层 `export * from`） | **链长 4**，共 8 个模块靠它拿到符号 | **S1（主）** |
| barrel 汇总再导出 `export { computeHash } from '../core/hash.js'` | 2 | S1 |
| **同名不同符号**：`legacy/hash.js` 也导出 `computeHash`（不同实现、不同返回值） | **1 个（跨目录）** | **S2（主）** |
| 同名局部变量（`core/hash.js` 内 `legacyAlias()`）、含旧名的字符串常量 | 各 1 | 沿用 cli-0005，但不公布 |
| 一处通过**函数表**间接调用（`handlers[HASH_KEY]`） | 1 | 让"只看名字"必漏 |

**关键设计：每一条坑都是"行为可观测"的**（这是防假绿的地基，见 §3.5）——
漏改 ⇒ ESM 具名导出缺失 ⇒ **SyntaxError**；误改 legacy ⇒ `run-canary.mjs` 里那条 canary 的返回值变；
误改局部变量/常量 ⇒ core 的 canary 输出变。**没有任何一条坑是靠"数文本条数"发现的。**

### 3.3 oracle：`evals/checks/cli-0007.mjs`（全机验、真跑）

| id | 判据 | 取法（**不用正则对源码做断言**） |
|---|---|---|
| C1 | suite 非空且与真值一致 | `truth.modules.length === 实际 discover 到的模块数`；**先断言非空**，防"遍历空集也算过" |
| **C2** | 目标模块的导出已从旧名换成新名 | `Object.keys(await import('./core/hash.js'))` **含 `digestOf`、不含 `computeHash`** —— 用 **Node 自己的 ESM 解析器**当权威实现，不写第二份解析 |
| **C3** | **同名邻居不许被牵连** | 同上法验 `legacy/hash.js`：`Object.keys()` **仍含 `computeHash`**，且 `legacyMod.computeHash('x')` 返回值 == 真值 |
| **C4** | 全部调用方行为不变 | `run-canary.mjs` 输出 **逐字** == 基线（含 re-export 链末端、别名导入、函数表那几支） |
| **C5** | 字符串常量原样 | 运行时导出值 `KEY_NAMESPACE === 'computeHash-v1'`（不是读文件找文本） |
| **C6** | 同名局部变量原样 | `core.legacyAlias()` 返回值 == 真值 |
| C7 | 改名后无 dead import | 逐个 `await import()` 全部 36 个模块，**任一 throw 即红**（这条直接把"漏改"变成红） |
| C8 | 没越界 | `git status --porcelain` 只许出现 `evals/pilot/rename-graph/**`；`evals/checks/**` 的 mtime/sha256 不变 |
| C9 | regression | `node scripts/check-all.mjs`（沿用） |

**为什么这些不适用"文本匹配不懂语义"那条**：
C2/C3/C5 读的是**运行时命名空间对象与返回值**，注释、字符串、示例文本都不可能满足它们
（反过来：只做文本替换但改对了，也**允许通过** —— 我们要测的是成本，不是手段）。

### 3.4 负向自证：**三层**，而且第三层比"一个 seed"更强

> ⚠ **先说一个硬约束**：本 harness 的**非空 seed 分支要求"干净态 oracle 必须绿"**
> （`scripts/eval-validate.mjs:290`，`rec.cleanOracle = o1.status === 0`，不绿就判"前提不成立"）。
> 而能力题的干净态**必然是红的**（答案不在 HEAD 里）。
> ⇒ **cli-0007 不能用非空 seed 登记**，否则会被自己判"假题"。这点必须写死在题注里，别将来有人改回去。

| 层 | 形式 | 必须得到什么 |
|---|---|---|
| ① harness 级 | `kind: "capability-task"` + `seed.edits: []` + `expectSeeded: "fail"` | **HEAD 上 oracle 红**（= 这件事还没做）＋ regression 绿（`eval-validate` 现有分支） |
| ② **判据级（本文要求加的）** | `node evals/checks/cli-0007.mjs --self-test` | 由生成器合成 **9 种坏形态**，逐个跑 oracle ⇒ **必须红**，且**红在指定的判据 id 上**（只断言"被挡"不够 —— `gate-authoring`：「恰好因为别的原因被挡，会让真正的检查名存实亡」） |
| ③ 徒手级 | 人工 `git checkout` 一次夹具 | oracle 必须回到红 ⇒ 证明 second run 不会白拿答案 |

②的 9 种形态（每条指定期望变红的 id）：

| # | 坏法 | 期望变红 |
|---|---|---|
| M1 | 只改 `core/hash.js` 那一行，**其余不动**（最典型的文本半吊子） | C2 绿 / **C7 红**（多模块 SyntaxError） |
| M2 | 深层链末端那一支漏改（最难肉眼看到的一支） | **C7 红** |
| M3 | 别名导入那一支漏改 | **C7 红** |
| M4 | 把 `legacy/hash.js` 的同名导出一起改了 | **C3 红** |
| M5 | 把 `KEY_NAMESPACE` 一起改了 | **C5 红** |
| M6 | 把 `legacyAlias()` 里的局部变量一起改了 | **C6 红** |
| M7 | 函数表那处 `handlers[HASH_KEY]` 漏改 | **C4 红** |
| M8 | 删掉一半夹具（空集） | **C1 红** |
| M9 | 顺手改了 `evals/checks/cli-0007.truth.json` | **C8 红** |
| — | 正确形态（green channel） | **全绿** |

⇒ 一条不错的 analogy：**M1 是最重要的一条** —— 它证明"只改一行"不能算过，而 cli-0005 的判据 ② 恰恰是"做到了就给绿"，
中间的失败（漏改）在 cli-0005 里由判据 ③ 兜住，但只在**同一个 4 文件闭区间**里兜。

### 3.5 假绿防范清单（逐条对照 `gate-authoring`）

1. **不许"匹配到文本就算过"** —— C2/C3/C5/C6 全部走 `import()` 后的运行时对象与返回值。
2. **对照expertise gate-authoring "注释污染/示例污染"**：夹具源码里**不许出现** `'digestOf'` 这个新名的示例字符串
   （否则"contains digestOf"型断言会被示例满足）。⇒ 连 README 都不许写答案。
3. **空过**：C1 先断言 canary 列表非空且与 `truth.json` 数量一致；C7 逐个 import，零容忍。
4. **答案泄漏**（S4）：公开给 agent 的只有 3.1 那三句规格；`truth.json` 即使被读到，也**只含模块级期望，不含站点行号**
   ⇒ 读了也还得自己走完 36 个文件的图。**诚实承认它在 worktree 里 agent 够得到**（因为 `evals/` 整体在工作区里），
   所以它的粒度被有意降级。
5. **R1 未彻底成立**：`evals/checks/**` 与夹具同在工作区 ⇒ **没做到"判据在 agent 够不到的地方"**。
   缓解只有 C8（改动范围闸）＋ C9（mtime/sha256）。**这条是已知不足，写在这儿不粉饰**（见 §3.7 风险 R5）。

### 3.6 预期两臂如何分化

| 面 | A（`exp-base`，102 工具） | B（`exp-base-nodc`，30 工具） | 判据 id |
|---|---|---|---|
| **行为** | 轨迹里出现 `safe_rename` / `find_references` / `impact_analysis` / `rename_many` 之一 **≥1 次** | **必须为 0**（它系统提示里没有这些名字，且 code 模式下无从知道） | `armFaceCheck` 已能判面；**叶子直方图待补**（§4 第 0 步） |
| **成本 · 叶子调用** | 预期 **20–40**（1 次闭包 + 少量 `symbol_edit` 补注释 + 验证） | 预期 **80–150**（~55 个站点逐个 `edit`，加上沿路的 `read` 定位） | **预期 3–5×**（cli-0005 只有 1.57×） |
| **成本 · outputTokens** | 预期 ~5–8k | 预期 ~15–30k | 预期 **≥2×** |
| **成本 · 输入侧反向劣势** | A 每次请求多背 39.8k 字符 ≈ **~13k token**（§1.1 实测） | 0 | ★ **不要只读输出侧**：A 的净成本要把这一项加回去 |
| **质量** | C3/C5/C6（不许误改）由工具的 preflight 兜 ⇒ 预期**全绿** | 预期在 **M2（深层链）/ M4（legacy 同名）** 上出现 ≥1 处 | 这是本区分度的主战场 |

**⇒ 本区分度的假设是：区分度来自质量面的 C3/C7，而不是"能不能做"。**
如果两臂都全绿，那就只是"贵一点"，回到 cli-0005 的结局。

### 3.7 我预期它可能**仍然不敏感**的风险（诚实写）

| id | 风险 | 为什么我担心 | 我有多不确定 |
|---|---|---|---|
| **R1（头号）** | **`run_code` 是图灵完全的**：B 可以自己写一段 `.mjs` 脚本，用 Node 的 `import()` + 一个手写的 import 图 walker 做全仓批量改名 | 这直接把"没有符号工具"变成"自己造一个符号工具"，叶子调用数可能**反而比 A 小**（A 还要 dry_run + apply + 补注释）。⇒ 若出现这种情况，**质量面仍可能两臂全绿，而成本面方向反转** | **高。** 这是我诚实认为最可能让这题也零区分度的一条 |
| R2 | 规模门槛没校准过关 | 36 文件/55 站点是我按 §2.3 拍的；若太少 ⇒ 退化成 cli-0005；若太多 ⇒ 两臂都撞 `maxMinutes` | 中 |
| R3 | **A 的工具在这个夹具上未必调得通** | cli-0005 里 `safe_rename` 只在 3 文件的 `evals/pilot/rename-target` 上验过（且那时 A 一次就算出了 3 文件 5 处 ✓）。36 文件 + re-export 链**没验过**；若它认得不出 `export *` 链 ⇒ **A 自己会漏 ⇒ 反转** | 中偏高 |
| R4 | 基建噪声吃掉成本面 | B1 实测有 5/12 次调用烧在 `check-all.mjs` 的 EPERM 上；`dangerous` 列当前是噪声（A 反而更高）⇒ 不先修这两处，cost delta 不可读 | 中（可修） |
| R5 | R1 判据纪律没真做到（`evals/checks/**` 在工作区里） | 现有 cli-0004/cli-0005 同病；C8/C9 只能事后抓，不能事前挡 | 已知且未解 |
| R6 | 夹具要 git 跟踪才能"kubectl-checkout reset"；但生成器一改 ⇒ 全历史 diff 变大 | 会让 `git status` 型断言（C8）与 C9 的 regression 变脆 | 低（可判 BY 生成器固定种子） |

---

## 4. 风险清单（跨全文）

1. `dangerous` / `unsafeActions` 列**当前不可信**（A 6–9 > B 5–7，命中在路径字符串上）⇒ 别拿它进任何结论。
2. `byTool` / `toolSet` 在 code 模式下恒瞎 ⇒ **行为面目前没有有效读数**。
3. 系统提示长度差 39.8k 字符是 A 的**固定负担**，必须计入成本面，否则结论偏 A。
4. 判据可读 ⇒ S4 ⇒ 所有句型难度被折价（cli-0004/cli-0005-cli-0007 都在此列，cli-0007 只能缓解）。
5. `n=3` 下 cost 分布重叠（B 最快 38.07s vs A 最慢 33.99s）⇒ 单靠 wall/tokens 判胜负需要 **≥5 次/臂**，且要看中位数而不是均值。

---

## 5. 顺序：先做哪一步最省

按"花钱最少、信息最多"排，**第 0 步是本文唯一今天就能做、且不需要跑新实验的一步**：

| 步 | 做什么 | 成本 | 得到什么 / 决定什么 |
|---|---|---|---|
| **0** | ~~给 `scripts/eval-run.mjs` 的 `analyzeTrajectory`（`:380` 起）加**叶子工具直方图**~~ **✅ 已完成（2026-09-21）** | ~~改一个函数~~ **已做** | 见下方「步 0 结果」 |
| **1** | A 臂 smoke：拿一个 12 文件的小样（含 1 条 re-export 链 + 1 个同名邻居）调一次 `safe_rename`，看它算不算得出完整闭包 | 1 次 A 单臂 | **决定 R3** ⇒ 决定 cli-0007 能不能成立。不成立的话本设计要推倒（那时该换踏工具 cf `impact_analysis` / `cross_repo_symbol_index`） |
| **2** | 同小样跑一次 B 单臂，读叶子调用 / tokens，**用它校准 `maxToolCalls`** | 1 次 B 单臂 | 预算要落在"落在 B 中位数 ×1.2 与 A 中位数 ×1.5 之间"，否则两臂一起超/一起闲 ⇒ 又是零区分度 |
| **3** | 写 `cli-0007.gen.mjs` + `check.mjs` + `--self-test`（9 红向 + 1 绿向），跑 `eval-validate` 证明 HEAD 红 + regression 绿 | 纯脚本，0 次 agent 跑 | 拿到"有信号"的证据（当前致伤级：先证明判据成立，再拿它测） |
| **4** | 才跑 `--pair --profileA exp-base --profileB exp-base-nodc --repeat 3`（若 §4.5 成立，提到 5） | 5–6 次 agent 跑 | 只有这一步之后，才配谈把 delta 接进 M2（`verifyCmd`） |

**不要先做的事**：不要在补完第 0 步之前跑新 pair —— 跑出来也只有 `{"run_code": N}`，又是白烧一轮。

### 步 0 结果（2026-09-21 已落地，0 次新跑）

`extractMetrics()` 里加了 `leafFace(recs)`（纯函数），产出
`leafCalls` / `leafByTool` / `leafFailures` / `symbolToolCalls` / `symbolTools` / `leafReadable`
（口径：转录里 `type === 'tool/code-dispatch'` 的 `data.name`；`SYMBOL_TOOL_RE` 匹配的是**工具名闭集**，不是文件内容）。

**用已有 5 条会话重算 ⇒ 行为面本来就分化，此前只是"没人量过"**：

| 臂 | `byTool`（**旧读数，run_code 层**） | `leafCalls` | **`symbolToolCalls`** | `leafByTool` |
|---|---|---|---|---|
| A `59adf627` | `{"run_code":9}` | 20 | **2** | `read`8 `pwsh`7 `safe_rename`2 `edit`2 `glob`1 |
| A `0eef4e34` | — | 20 | **4** | `read`9 `pwsh`5 `safe_rename`2 `symbol_edit`2 `glob`1 `grep`1 |
| B `2c11e358` | `{"run_code":9}` | 27 | **0** | `pwsh`9 `edit`8 `read`6 `grep`3 `glob`1 |
| B `3c208cc6` | — | 34 | **0** | `pwsh`11 `read`10 `edit`7 `glob`2 `grep`2 `list_capabilities`1 `job_output`1 |
| B `8a0adb7c` | — | 33 | **0** | `read`12 `pwsh`9 `edit`8 `glob`2 `grep`1 `job_output`1 |

★ **两臂的 `byTool` 完全同形（都是 `{"run_code":9}`）——这就是加之前的读数盲区**；
而叶子层一眼分开：**A 用符号工具改（`edit` 0–2 次），B 手改（`edit` 7–8 次）**，且 B 还得额外 `grep` 找引用。

**自证**（`node scripts/eval-run.mjs --self-test-harness`，**27 通过 / 0 失败**）：
单元 4 条（含"一个 dispatch 都没有 ⇒ `leafReadable=false`，**通道不可用 ≠ 0**"）+ 真数据 3 条（上面这张表）。
**消融自证**：撤掉 `...leafFace(recs)` 一行 ⇒ **27/0 → 24/3**，恰是那 3 条叶子用例变红 ✓。

⇒ **步 0 的结论**：行为面**有**区分度，且现在可复算；但它证明的是"两臂**做法不同**"，
**不**等于"成绩不同"（cli-0005 两侧 oracle 都绿）。⇒ 步 1/2（决定 R3、校准预算）仍然是必要的。

---

## 附录 A：本文每个读数的取法

| 读数 | 怎么取的 |
|---|---|
| 会话 id | `out/eval-pair-cli-0005-symbol-rename-design-canvas-1789960605790.json` → `arms.{A,B}.runs[].session` |
| `request/header.tools` / `system` / `dcHits` | 会话转录里 `type === 'request/header'` 的那一条（会话 *.zstd*，`fzstd` 解压）；口径与 `scripts/eval-run.mjs:198-205` 一致 |
| 叶子调用直方图 | 转录里 `type === 'tool/code-dispatch'`（**注意：`eval-run.mjs` 当前不数它**） |
| wall / tokens / `callsTotalMs` / `dangerous` | `node scripts/eval-run.mjs --traj <sid>` → `metrics`（`dangerous` 在顶层） |
| A 的 `safe_rename` 返回原文 | 转录 step 6（dry_run）与 step 7（apply）的 `tool/result` 文本，见 §1.4 引文 |
| design-canvas MCP 工具名 | `out/dc-mcp-tools.txt`（60 个；arm-probe 报 64，两处口径差未追，见 §4） |
| 两这条路 / 102 vs 30 的坐实 | `docs/eval-independent-variable-plan.md` §2.1（本文不复核，按题面已坐实） |

## 附录 B：我没查到 / 没把握的

1. **叶子工具直方图今天是否需要容错**：我只数了 `tool/code-dispatch`，没验证它在非 code 模式 (native) 会话里是否存在 ⇒ 第 0 步实现要处理"没有该事件= 通道不可用"（照 `gate-authoring` 那条：不可用 ≠ 读数 0）。
2. **R3 完全没验**：`safe_rename` 在 re-export 链上的行为，我没有任何观测，§3.6 的 A 侧数字全是预期。
3. **`out/dc-mcp-tools.txt` 报 60 而 arm-probe 报 64**：差 4 个工具我没追（可能是版本差异），本文只用到"这些工具存在"，不依赖精确条数。
4. **`cross_repo_symbol_index` / `impact_analysis` 的实际行为**：名字是从目录里看的，**没跑过**，不知道它们对纯 JS 仓库是否可用。若 R3 成立导致 `safe_rename` 不可用，这两个是首选替补，但要先 smoke。
5. **主仓常驻 `git status` 只有 `M scripts/eval-run.mjs`**（调研时观测）—— 本文未改任何文件，若那边有未提交改动，是别人先前的。
