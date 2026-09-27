# 席位库（seats/）—— 内化的定义，不是散落的散文

> 来源：模仿 `wshobson/agents` 的 agent 定义格式（MIT），见 `docs/prior-art-subagent-marketplace-2026-09-27.md`。
> 目的：让"一席"从**硬编码的 TS 常量**变成一个**可外部注册、有职责边界、有工序位置**的对象。

## 目录约定

```
seats/
├── README.md               ← 你在这里
├── schema.json             ← 定义格式的机器可读规格（判据照它写）
├── library/                ← ★ 席位定义（一份源，后续可生成）
│   ├── architect.md
│   ├── dev.md
│   └── review.md
└── candidates/             ← ★ 从外部市场取来的候选（**未融合、未上线**）
    └── <name>.md           ← 带 provenance，标注来源与许可
```

## 一条席位定义长什么样

```markdown
---
name: <命名空间化的唯一名>
description: <第三人称；含触发短语；只写"何时用"不写"做什么">
tools: readonly | full      ← 我们扩展的字段（源自它的 `tools:` 白名单，见下）
model: inherit | <显式模型>
---

正文（结构见 schema.json）
```

### 与 `wshobson/agents` 的三处差异（**我们的是扩展，不是照抄**）

| 字段 | 它 | 我们 | 为什么改 |
|---|---|---|---|
| `tools:` | **工具名白名单**（`["Read","Bash"]`） | **档位**（`readonly` / `full`） | ★ 我们的席位是**跨底座**的（DSH / 未来其它），写死工具名会绑死底座。档位由 `SEAT_TOOL_SCOPE` 映射成具体白名单。**这是"内化"而不是"复制"。** |
| `model:` | 五档别名（fable/opus/…） | `inherit` 或显式 | ★ 用户定：开发期**一律 Flash，不追求跨模型**（见 `subagent-council` 注释 §11.7）。 |
| 名字 | `<plugin>-<agent>` | 同名规则（防遮蔽） | ✅ **直接采用**它这条 —— 对应我们铁律 18。 |

### ★ 正文必备块（缺一不可，`schema.json` 会查）

| 块 | 为什么 | 对应 |
|---|---|---|
| `## Purpose` | 这一席是什么 | 它 |
| `## Core Philosophy` | 判断依据（不是人设形容词） | 它 |
| `## Behavioural Traits` | 行为纪律 | 它 |
| `## Key Distinctions` | ★ **我不做谁的活** | 它 —— **我们原先没有** |
| `## Workflow Position` | ★ `After:` / `Complements:` / `Enables:` —— 工序位置 | 它 —— **我们原先没有** |
| `## Output Contract` | ★ **交付什么形状 + 置信度怎么报** | 它（`Output Examples`）—— 我们强化为**契约** |
| `## Rationalization Table` | ★ 已知借口 → 现实 | ★ **superpowers 的招，它没有** |
| `## Red Flags` | ★ 自我检查清单 | ★ **superpowers 的招，它没有** |

## 纪律（血换的）

1. **不整目录倒入**（铁律 28）：从市场取来的是**候选**，进 `candidates/`，**必须经融合才进 `library/`**。
2. **散文不是机制**（铁律 2 的精神）：`Behavioral Traits` 里写的"只读"**拦不住任何事**；
   真约束在 `tools:` 档位 → `SEAT_TOOL_SCOPE` → `tools.restrict()`。
   ★ 事故见 `packages/subagent-council/src/index.ts:151-179`（architect 席照着自己 persona 写了文件）。
3. **名字必须唯一**（铁律 18）：`library/` 下不许重名，由门查。
4. **每份候选必须带 provenance**：来源 URL + 许可证 + 取用日期 + 我改了什么。
   ★ 没写许可证的候选**不许进 library/**。
