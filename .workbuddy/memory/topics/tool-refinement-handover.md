# 议题交接：**工具完善** —— 派给另一个会话全权执行

> 2026-09-20 14:50 建立。**这是新议题的独立交接文档**（与 `next-task-handover.md` 那份并行）。
> 读者：接手本议题的会话。**纪律与坑一律继承主文档 §5**（`next-task-handover.md`），本文不重复。
> **回执也写在这里**（顶部，同约定）。

---

## 0. 一句话

**把能力注册门的判据阶梯从 L1 推到 L2~L4** —— 让"采纳一个能力"从「声明自洽」升级为
「基线不退化 + 隐藏 holdout + 反事实对照」。

**为什么是它**：门脚本里 L2~L4 各自写着"为什么没建"，而**那三样正是 M1 刚建好的**
（见 §2 的对照表）—— 地基刚铺好，现在补上层是**成本最低的时刻**。

> ⚠️ **作用域待用户一句话确认**（§5 列了三个候选）。**用户未否决 ⇒ 按本推荐执行。**

---

## 1. 现状盘点（都实测过）

### 1.1 能力库（`node scripts/capability-registry.mjs list`）

```
能力库（4 条）  更新于 2026-09-20T06:36:56Z

  id                 kind                status  ver    工具面            选用/复用/成功/失败  注册门
  spawn              subagent-provider   active  0.1.0  subagent          1/0/0/0  门:L1
  fork               subagent-provider   active  0.1.0  subagent_fork     0/0/0/0  门:L1
  council-architect  subagent-provider   active  0.1.0  council_architect 0/0/0/0  门:L1
  design-canvas      mcp-server          active  0.0.0  64 工具 / 6 线     0/0/0/0  门:L1
```

- **全部只过了 L1**；回执里写 `proofLevel:'L1'` + `unenforced:['L2','L3','L4']`。
- ⚠️ **把 L2~L4 标成"通过"就是假绿** —— 那正是本项目花了两天修的那类失败（主文档 §5 纪律 1）。
- ★ registry 自己提示了一条**工具质量口径**：「**高选用 + 低复用 = 描述过度承诺**」
  （`spawn` 现在是 1/0 —— 选用 1 次、复用 0）。**这条值得接进判据**（见 §5 选项 B）。

### 1.2 判据阶梯的"为什么没做"（`scripts/capability-gate.mjs:48-52`）

| 级 | 名称 | 现状 | 脚本里写的 `why` |
|---|---|---|---|
| L0 | 机械门 | ✅ 实施 | — |
| L1 | 不变量门 | ✅ 实施 | — |
| **L2** | 基线不退化 | ❌ | **需固化基线与测量口径，未建** |
| **L3** | 隐藏 holdout | ❌ | **需独立评测集 + holdoutHash，未建** |
| **L4** | 反事实对照 | ❌ | **需同任务集与 A/B 编排，未建** |

### 1.3 ★ 对照：那三样为什么现在"建得起来了"

| 级 | 缺的东西 | M1 刚产出的对应物 |
|---|---|---|
| L2 | 固化基线与测量口径 | `docs/eval-baseline-single-arm.md`（3 题基线：`toolCalls` 7/17/20、tokens 1910–2667、墙钟 70–126s）+ `evals/pilot/tasks.jsonl`（题面 + budget + oracle） |
| L3 | 独立评测集 + holdoutHash | `evals/` 的**字节级 sha256 还原**（`eval-validate.mjs --prepare/--restore`）+ 可加隐藏集 |
| L4 | 同任务集与 A/B 编排 | `docs/eval-challenger-arm.md`（挑战者定义 + `agentPreset.select` 实测）+ §3.B 的 `eval-run --pair` |

⇒ **这不是巧合**：M1 的评测地基本来就是 L2~L4 的底座。**现在补上层，比任何时候都便宜。**

### 1.4 其他可用资产

- **15 道门**（`node scripts/check-all.mjs --list`）—— L2 的"不劣化"可以直接以它为地板。
- 我们的 7 个包：`capability-bridge` / `conveyor-context` / `design-canvas-bridge` /
  `key-pool-proxy` / `subagent-council` / `switchboard` / `tool-evolution`。
- **M2**（`tool_apply(verify=…)` + `VERIFY_ALLOW`）**接口已存在**，是 L4 结论的天然出口。

---

## 2. 交付什么（推荐作用域 = §5 选项 A）

1. **L2 基线不退化**：给出「在既有能力集上不劣化」的**可执行判据**（逐维度 fail-closed），
   并把它接进 `scripts/capability-gate.mjs`（`enforced:true` + 真跑）；
2. **L3 隐藏 holdout**：建立**优化器看不见**的用例集 + `holdoutHash`，
   并证明「用它跑门时，被优化过的东西**不能**靠过拟合蒙过」；
3. **L4 反事实对照**：与现役同能力做 **shadow A/B**，比到**显著性**（复用 §3.B 的成对 delta）。

**每一步都必须配两方向自证**（该红的红、该绿的不绿）——见主文档 §5 纪律 1/2/3。
**未实施的级不得计作通过**：做不完就如实留 `enforced:false`，**不许把未做的级标成通过**。

---

## 3. 起点（第一批动作）

```bash
cd D:\project_develop\dsh-brain
node scripts/capability-registry.mjs list        # 现状
node scripts/capability-gate.mjs run --all      # 现在跑什么（会写回执）
cat docs/eval-baseline-single-arm.md            # L2 的基线素材
cat docs/eval-challenger-arm.md                 # L4 的 A/B 素材
grep -n "L2\|L3\|L4" scripts/capability-gate.mjs | head -20
```

**建议顺序**：L2 → L3 → L4（依赖关系就是这个方向；L4 依赖 §3.B 的 `--pair` 落地，
所以**先跟主文档 §3.B 对齐节奏**，别抢跑）。

---

## 4. 纪律（继承 + 本议题特有）

**继承**：主文档 `next-task-handover.md` §5 的 8 条，一条都不能破。尤其：
- 判"机制有没有在工作"⇒ **去历史记录数"判据为真的次数"**，不许读注释；
- **"看不到" ≠ "没有"**；
- 判据读快照/读注释都是假信号源 ⇒ **阶段/状态一律实时读**。

**本议题特有**：
1. **门只跑能真跑的级**：`enforced` 必须反映实际，**不许为了好看把 L2~L4 标绿**。
2. **基线要"固化"**：基线数字必须能被别人重跑出来（写清命令 + 预算 + 环境），否则 L2 无意义。
3. **holdout 的定义是"优化器看不见"**：如果判据集放在 Agent 够得到的地方，L3 就是假的。
4. **改动 `capability-gate.mjs` 后**：跑 `node scripts/test-capability-gate.mjs`（现有 29 项）
   + `node scripts/check-all.mjs`（15 门），两者都要绿。

---

## 5. 作用域候选（**用户拍板项**）

| | 作用域 | 说明 | 代价 |
|---|---|---|---|
| **A（推荐）** | **判据阶梯 L2~L4** | 见 §2。地基刚铺好，成本最低；直接决定"能力采纳"是否可信 | 中（要建 holdout 与 A/B） |
| B | **工具可用性**（行为信号反推） | 用 registry 的「选用/复用/成功/失败」+ 失败模式（如今天环境里见过的 `unknown tool`）**反推哪些工具描述不清/难用**并改好 | 低（先做度量，改动小） |
| C | **M2：把实验结论接进闸** | `tool_apply(verify=…)` + `VERIFY_ALLOW` 已有接口，把 §3.B 的结论变成**自动门** | 低，但**依赖 §3.B 完成** |

**我的建议**：**A**，但**先做 B 里最小的一步**（把行为信号变成一张"工具健康表"，
它天然是 A 的 L2 度量口径，也是挑选"下一个要完善哪个工具"的依据）。
⇒ 即 **A 为主线、B 的第一步作为 A 的输入**。C 等 §3.B。

---

## 6. 回执（接手会话写这里）

_（空 —— 待接手会话填）_
