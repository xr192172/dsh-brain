# evals/ —— 自进化用的冻结任务集（判据那一半）

> 设计口径见 `docs/agent-eval-arenas.md`（公开靶场调研）与
> `docs/oss-prior-art-and-next-steps.md`（M1/M2 里程碑）。
> 本目录只放**任务与判据**；跑 Agent 的那一半在 `scripts/eval-*.mjs`。

## 为什么判据要自建（而不是刷公开榜）

1. **公开榜对我们几乎饱和**：我们的活儿是"特定仓库 + 特定 MCP 工具集"，通用榜测不到。
2. **抗污染**：自己写的题天然不可污染。2026 年的公开汇总里，SWE-bench Verified 因污染+判据缺陷被
   厂商**停止上报**（审计 138 题 >60% 有缺陷；难度子集里 59.4% 的测试集根本抓不到目标 bug）。
3. **我们已经有现成的 oracle**：把修过的回归**反向打回去**（= `seed`），
   我们自己的门就会红；Agent 修好，门变绿。**这就是 SWE-bench 意义上的 `FAIL_TO_PASS`**，
   而 `check:all` 就是天然的 `PASS_TO_PASS`。⇒ 任务集不用另造，把回归历史反过来用。

## 两条不许破的规则

- **R1 判据必须在 Agent 够不到的地方**。2026 年多个公开靶场被"判分代码与 Agent 同环境"破掉
  （一行代码改掉自己的成绩）。我们的 oracle 一律是**仓库里的门脚本**，由**外部**跑；
  绝不把期望答案放进 Agent 能读能写的工作区。
- **R2 每题必须先证明"有信号"**：打上 `seed` 之后 oracle **必须由绿转红**。
  否则这题是**假题**（跑一万次也不区分好坏）。`scripts/eval-validate.mjs` 就是干这个的，
  它**不需要 Agent、今天就能跑**。

## 任务格式（JSONL，一行一题）

```jsonc
{
  "id": "cli-0001-injected-message-identity",
  "invariant": "一句话说清被破坏的不变量（人读）",
  "kind": "regression-repair",
  "seed": {                       // 让题目"坏掉"的方式：把修过的改动反向打回去
    "edits": [
      { "file": "packages/switchboard/src/index.ts", "find": "（必须恰好出现 1 次的原文）", "replace": "" }
    ]
  },
  "oracle":     { "cmd": ["node", "scripts/test-injected-message-shape.mjs"],
                  "expectSeeded": "fail", "expectFixed": "pass" },   // FAIL_TO_PASS
  "regression": { "cmd": ["node", "scripts/check-all.mjs"] },         // 干净态与修好后都必须绿
  "metrics": ["oracle", "regression", "toolCalls", "tokens", "wallClock", "unsafeActions"],
  "budget":  { "maxToolCalls": 60, "maxMinutes": 15 },                // 超预算即算失败（防"磨出来"）
  "notes": "为什么这题值得测 / 当初的事故一句话"
}
```

字段纪律：

- `find` 必须**恰好出现一次**（出现 0 次 ⇒ 上游改了、题目失效；多次 ⇒ 会误伤）。校验器会拦。
- `oracle.cmd` 必须**非交互、可重复、只读**（我们的门都是）；不许依赖网络。
- `budget` 是判据的一部分：**超预算的运行算失败**，不许靠"多试几次"蒙对。
- 指标里 **`unsafeActions` 与成功率并列**（2026 年 ClawsBench 的教训：完成 ≠ 安全，且两者不成正比）。

## 怎么用

```bash
# 校验整份任务集（每题都要证明"有信号"；不需要 Agent，不动 git）
node scripts/eval-validate.mjs            # ≈ 每题跑两次门，几秒/题
node scripts/eval-validate.mjs --only cli-0001
node scripts/eval-validate.mjs --prepare cli-0001   # 只把题打坏（给 Agent 用），留下还原清单
node scripts/eval-validate.mjs --restore           # 还原（幂等）
```

`--prepare` / `--restore` 用**字节级备份 + sha256 校验**：还原后台账不匹配就大声报错并**保留备份**。
它们**不碰 git**、不改 `node_modules`、不写 `~/.dsh`。

## 还没做的（M1 的下一半）

- **跑 Agent 的那一半**：把 `task.invariant` 作为题面交给挑战者，跑在只读沙箱/分叉会话里，
  收集轨迹，再跑 oracle + regression，产出 **delta 报告**（现行 vs 挑战者）。
  依赖运行时起来（M0），所以先只做"任务有效性"这半边。
- **`pass^k` 可靠性**：同一题重复 k 次（2026 年"Beyond pass@1"的教训：任务一长，能力与可靠性发散）。
  先在报告里留位，等 runner 一起做。
- **通用地板**：挑 1–2 个公开靶场的小子集（首选 Terminal-Bench 风格的容器任务）当"不许退化"的地板。
