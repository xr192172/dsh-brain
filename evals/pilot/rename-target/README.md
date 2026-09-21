# cli-0005 靶子：把 `computeHash` **按语义**重命名为 `digestOf`

> 这是"**能力敏感**"题（见 `docs/eval-capability-task.md`）：有符号级工具（移植来的 design-canvas 能力：
> `design_canvas_index` + `safe_rename`/`symbol_edit`，带 preflight）时又快又准；
> 只有文本工具（grep/sed/手改）时**很容易踩下面三条规则**。

## 规格（题面就是这几条）

1. 把模块级导出函数 `computeHash` 改名为 **`digestOf`**，**跨文件**全部跟改：
   - `math.js`：导出声明；
   - `store.js` / `index.js`：`import` 与所有调用点；
   - **注释里提到它的地方也要跟改**（注释不是字符串，属于"名字出现的地方"）。
2. **同名但不是它的东西，一律不许改**：
   - `math.js` 里 `legacyAlias()` 内部的**局部变量** `computeHash`（它只是同名，与导出函数无关）。
3. **字符串常量 `'computeHash-v1'` 必须原样保留**（它是持久化命名空间；改了会让旧数据失效）。
4. **行为不许变**：`node index.js --selftest` 的输出必须**逐字**与改造前一致。

## 判据（`check.mjs`，全机验）

| # | 判据 | 取法 |
|---|---|---|
| ① | 行为不变 | `node index.js --selftest` 输出 == 基线（基线**只含数据、不含符号名** ⇒ 改名不该影响它） |
| ② | 已改名 | `math.js` 有 `export function digestOf(`；两个文件有 `digestOf` 的 import + ≥2 处引用 |
| ③ | 旧名标识符零残留 | **剥掉字符串字面量后** 查 `\bcomputeHash\b`：`math.js` 必须恰好 **1** 处（= `legacyAlias` 的局部变量），另两文件 **0** 处；**注释不算字符串 ⇒ 注释没跟改会被这条抓到** |
| ④ | 字符串常量保留 | `math.js` 里 `KEY_NAMESPACE = 'computeHash-v1'` 原样 |

## 为什么它"能力敏感"（预期两臂差异）

| 臂 | profile | 预期做法 | 预期结果 |
|---|---|---|---|
| A（能力**开**） | `exp-base`（≡ `web`） | `design_canvas_index` 建索引 → `safe_rename`/`symbol_edit`（AST 级、带 preflight） | 少量调用、精确命中 3 处标识符、自动放过局部变量与字符串 |
| B（能力**关**） | `exp-base-nodc` | 只能 grep + 手改 | 调用更多；**易踩**：把局部变量一起改（③ 红）或把字符串一起改（④ 红），或漏掉注释（③ 红） |

> ★ **臂名已更正（2026-09-21）**：原先这里写 `web` / `web-nodc`。现统一为 canonical 两臂
> **`exp-base` / `exp-base-nodc`**（`scripts/eval-run.mjs` 的 `PROFILE_TOOL_FORBID` / `PROFILE_EXPECT` 已登记这两臂）。
> **`web-nodc` 这个名字已退役**（同名旧变体引用过已删的 `conveyor-context`）⇒ **不要再建它**。
> 两臂的差别与坐实过程：`docs/eval-independent-variable-plan.md` §2.1。

> ★ **为何本靶子能落在夹具上**：`safe_rename` 的入参是
> `project_dir`（"项目根目录，缺省取最近已预热工作区"）+ `file` + `symbol` + `to`
> ⇒ **它不被 `kernelDir` 绑死**（`kernelDir` 指的是 design-canvas **内核**所在，
> 不是被改的目标项目）⇒ 可以作用于 `evals/pilot/rename-target`。

## 复现（人工）

```bash
node evals/pilot/rename-target/check.mjs          # 改造前：必须红（不合格）
# …做重命名…
node evals/pilot/rename-target/check.mjs          # 改对了：必须绿
```
