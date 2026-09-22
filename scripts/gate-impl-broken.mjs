#!/usr/bin/env node
/**
 * gate-impl-broken.mjs —— ★★ 「故意坏」的实现 = **复现我们发现的真 bug**
 *
 * 与 `gate-impl-reference.mjs` **只差一处**（见下面那一行 `delete`）：
 *
 *     L3 分支【不检查 status】⇒ pending（甚至 archived）条目只要 triggers 命中 taskHint
 *     就照样"可见"（= 会被注入 prompt）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 这就是「只改导入处 = 装饰门」那种形状，也正是现状：
 *
 *   docs/o45-import-gate-landing.md §1 逐字核过 internal/memory/skill_tree.go:1054+ GetActiveSkills：
 *     | L0（高分配稳定技能） | Score>0.7 ∧ UseCount>10 | ✅ 要求 Status == "active" |
 *     | ★ L3（触发词命中）   | Triggers 命中 taskHint  | ❌ 完全不检查 Status          |
 *   ⇒ 把导入处改成 pending 只封住 L0 那条路，**L3 那条路照走**（spec §30.1）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 它存在的全部意义：**证明向量集有分辨力**
 *
 * `evals/gate/vectors.json` 里那 12 条如果对"参考实现"和"坏实现"给出一模一样的结果，
 * 那它就是一批**装饰向量**（"全绿也叫过"——本项目花了两天修的那类失败：保险自己失效）。
 * 拿本文件跑 runner（`scripts/gate-vector-run.mjs --impl "node scripts/gate-impl-broken.mjs"`）
 * **必须有一批向量 FAIL**，尤其是 `l3-pending-trigger-match-hidden`。
 * 没有这条反例，"12/12 PASS"只是自我感觉良好。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么是"注入一份改坏的契约"而不是"另写一套判定逻辑"
 *
 * 参考实现是**契约驱动**的（状态/阈值/requiresStatus 全从 contract.json 读，见其 §0）。
 * 所以"L3 不检查 status"最忠实的复现方式就是：**在内存里把契约 L3 那条 requiresStatus 删掉**
 * —— 等价于"有人把这条要求从策略里删了/从没写进去"。这样两个实现共享**同一段**判定代码，
 * 差别只剩策略本身 ⇒ 向量 FAIL 时，"挂的是哪一条策略"是确定的。
 * ⚠️ 只改内存，**绝不改 contract.json 磁盘文件**。
 *
 * 与现状的一处**刻意的不忠实**（如实记录，报告里也有）：
 *   Go 现状在 L3 之前还有一条更上层的 `if node.Status == "archived" { continue }`，
 *   所以现状真正漏出去的只有 `pending`。本文件的 L3 分支是**完全没有状态逻辑**，
 *   因此 `archived` 也会一起漏 ⇒ 除 `l3-pending-trigger-match-hidden` 之外，
 *   `l3-archived-trigger-match-hidden` 也会 FAIL。
 *   ★ 两个都 FAIL 更好用：它同时说明这批向量能分辨"漏了 pending"和"漏了不可见态"。
 *
 * 退出码：与参考实现一致（0 = 有判决；2 = 用法/输入错）。
 */

import { loadContract, main } from './gate-impl-reference.mjs'

const contract = loadContract()

const l3 = (contract.visibility?.rules ?? []).find((r) => r.level === 'L3')
if (!l3) {
  process.stderr.write('坏实现的前提不成立：契约里找不到 visibility.rules[level="L3"]\n')
  process.exit(2)
}

delete l3.requiresStatus // ★★ 唯一的差异：L3 分支不检查 status（复现 skill_tree.go:1054+ 现状）

process.exit(main(process.argv.slice(2), contract))
