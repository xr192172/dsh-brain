# ToolDef 注册方案（缺口③）

> 任务来源：`out/_tasks/t3-tooldef.md`
> 结论：读源码 + 给方案，**不改产品代码**。

---

## 1. 读过的文件 / 行号清单（可直接复核）

| # | 文件 | 行号 | 读到什么 |
|---|---|---|---|
| 1 | `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts` | 106–172 | `ToolDefinition` 接口形状：`name/description/output/execute/timeoutMs/isConcurrencySafe/presentCall/presentResult/finalizeContent` |
| 2 | `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts` | 493–623 | `ToolRuntime` 类：`register(def) → () => void`、`restrict(filter)`、`guard(g)`、`schemas(scope)`、`get(name, scope)` |
| 3 | `node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts` | 178–240 | `DefineToolOptions`（作者面 schema）；`defineTool(options) → ToolDefinition` 签名 |
| 4 | `node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.d.ts` | 24–49 | `JsonSchemaNode` 受 enforce 的 JSON Schema 子集（type/properties/required/additionalProperties/items/enum/const/oneOf/description/title/default/examples） |
| 5 | `packages/tool-evolution/src/index.ts` | 69–167 | 插件用 `ctx.inject(['tools'], (tctx) => { tctx.tools.register(defineTool({...})) })` 挂工具——**参照形状最省** |
| 6 | `packages/capability-bridge/src/index.ts` | 282–372 | 同一模式：`ctx.inject(['tools'], (tctx) => { tctx.tools.register(defineTool({...})) })` 注册两个工具（list_capabilities / capability_report） |
| 7 | `packages/arm-isolation/src/index.ts` | 143–164 | `ctx.inject(['tools'], (tctx) => { tctx.tools.guard((exec) => { … }) })` —— 注册 Guard 的现成写法 |
| 8 | `packages/skill-tree/src/index.ts` | 21–36 | `ToolDef` 接口定义：`Name/Description/Kind/Entry/Fn/Schema/ReadOnly` |
| 9 | `scripts/skill-to-preset.mjs` | 39–53 | `KNOWN_TOOLS` 白名单过滤 + `unmapped = toolNames.filter(t => !KNOWN_TOOLS.has(t))` —— **桥不替 ToolDef 注册，只如实标注** |
| 10 | `scripts/skill-to-preset.mjs` | 71–75 | `# ★ 未注册的工具（本桥映射不了，不假装可用）` 注释生成逻辑 —— 本报告的触发点 |
| 11 | `docs/subagent-nesting-and-toolfilter.md` | 56 | `toolFilter` 实测：allow/deny 只作用于子代，父代工具数不变 |
| 12 | `docs/subagent-nesting-and-toolfilter.md` | 64 | "空数组 = 全拒"对全局工具成立，子代自有 scope 注册的 `report` 不受 restrict 约束 |

---

## 2. 最小方案

### 2.1 「注册一个 ToolDef 到运行时」的最小路径

**结论：把它装成一个插件，走 `ctx.inject(['tools'], ...)` 这条现成通道。**

照抄 `packages/tool-evolution` / `packages/capability-bridge` 的形状：

```ts
// 新包：packages/tool-def-bridge/src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDef } from '@dsh-brain/skill-tree'

export const name = 'tool-def-bridge'
export const inject: string[] = []

export function apply(ctx: Context, config: { registryPath: string }): void {
  const defs = loadDefs(config.registryPath)   // 读 skill_tree.json 的 Tools 数组
  ctx.inject(['tools'], (tctx) => {
    for (const d of defs) {
      tctx.tools.register(toDshTool(d))
    }
  })
}
```

**`toDshTool(d: ToolDef) → ToolDefinition` 的转换规则：**

| ToolDef 字段 | → ToolDefinition 字段 | 备注 |
|---|---|---|
| `Name` | `name` | 直传 |
| `Description` | `description` | 直传 |
| `Schema` | `parameters`（需编译为 `ParameterSchemaSpec`） | 见 §2.3 |
| `Fn` / 执行体 | `execute` | 见 §2.2 |
| 无 | `output` | 必须——见 §2.4 |
| `ReadOnly` | 决定要不要加 `guard` | 见 §2.5 |

### 2.2 执行体怎么落地

`Kind` 三档的处理：

| Kind | 执行策略 | 说明 |
|---|---|---|
| `python` | `node child_process.spawn(...)` 调 Python 解释器，stdin 喂 JSON，stdout 收 JSON | 沙箱外执行（`dsh-sandbox-policy` 的 sandbox 档位控制） |
| `shell` | 调 `pwsh`（win32）或 `bash`（posix）子进程 | 沙箱已提供 shell 工具（`pwsh`/`bash`），但**这是工具内部再起进程**，需要确认沙箱是否放行 |
| `subprocess` | 类似 python，直接 `spawn` 可执行文件 | — |

**关键判断（win32 沙箱下的风险）：**

- **直接读到的事实**：`dsh-sandbox-policy` 在 win32 下是 `ConstrainedLanguage`（见 `pwsh` 工具文档："ConstrainedLanguage mode"），**不允许启动子进程、不允许 .NET 静态方法、不允许 COM**（参考文档"在 read-only，prefer cmdlets and core types"一节）。
- **推断**：`Kind: shell` 且 `Entry: first_line.sh` 这种脚本工具，**在 win32 ConstrainedLanguage 沙箱下无法直接跑**。
- **替代方案（按成本从低到高）：**
  1. **Node 内联**：把脚本翻译为纯 JS，`execute` 里直接调 JS 函数（不走 shell）。**最省，但要求 Skill 的脚本能重写为 JS。**
  2. **预编译 / 转译**：Skill 入库时把 `first_line.sh` 预编译为 `.js`，运行时调 Node 执行。**成本中等，需要改入库流程。**
  3. **沙箱外代理**：工具执行体通过 IPC 转发到不受沙箱限制的后台进程（如 Windows 上起一个独立 node 进程）。**成本最高，架构改动大。**

**推荐走方案 1（Node 内联）** —— 它符合"先补缺口③"的最小路径，而且不依赖沙箱放开。

### 2.3 参数 Schema 转换

`ToolDef.Schema` 是任意 JSON Schema；`defineTool` 要求 `ParameterSchemaSpec`（`dsh-tools` 自己的 DSL，见 `schema.d.ts:82-84`）。

**需要写一层编译：任意 JSON Schema → `ParameterSchemaSpec`。**

- 直接读到的：`dsh-tools` 导出 `parameterSchemaSpecToJsonSchema`（`index.d.ts:15`）—— 方向是 Spec → Schema。
- 反向编译（Schema → Spec）需要自己写，但 `JsonSchemaNode` 的结构很规整（见 `json-schema.d.ts:24-49`），可手写一个转换器。
- **边界**：遇到不支持的 keyword（如 `$ref`/`allOf`/`anyOf`/`pattern`）→ 降级为 `type: 'json'` 并打 warn。这是**可接受的保守处理**。

### 2.4 `output` 怎么填

`ToolDefinition` 强制要求 `output: { schema, render }`（`index.d.ts:107-108`）。

- **Schema**：取 `ToolDef.Schema` 中 `properties` 里的返回字段（或直接用 `{ type: 'object', additionalProperties: true }` 兜底）。
- **Render**：把 `execute` 返回的 JSON 序列化为文本块（参考 `capability-bridge` 的 `render: (_args, value) => [{ type: 'text', text: String(value.text) }]` 写法）。

### 2.5 `ReadOnly` 的处理

`ToolDef.ReadOnly = true` → "跳过权限审批"（`skill-tree/src/index.ts:35` 注释原文）。

**落地方案**：对 ReadOnly 工具**不挂 `arm-isolation` 类型的 guard**（即不调用 `tctx.tools.guard(...)` 拦它）。对非 ReadOnly 工具，沿用现有的 arm-isolation 守卫逻辑（路径检测）。

---

## 3. 风险清单

| # | 风险 | 验证方式 |
|---|---|---|
| R1 | **Registry 是进程单例**，注册工具会影响所有 agent 的工具面（不只是子代）。`ToolRuntime` 是 `Service`（`index.d.ts:493`），继承自 `cordis` 的 Service，进程内共享。 | 启动后调 `ctx.tools.schemas()` 检查全局可见工具集合；再委派一个子 agent 调 `agent.ctx.tools.schemas()` 检查子代集合。 |
| R2 | **注册 ToolDef 工具会污染父代工具面**。`toolFilter.allow` 的语义是"白名单裁全局工具"（`subagent-nesting-and-toolfilter.md:56`）—— 新注册的全局工具会被 `allow` 拉到子代，破坏"窄工具面"的设计意图。 | 在 `specToPreset` 里给新增工具注册后跑一次 selftest，确认 `demo_first_line` 仍在 `unmapped` 里（如果注册成功则应该消失）；反之若未注册，则 `unmapped` 仍含它。 |
| R3 | **Schema 转换漏掉 keyword 导致模型拿到错误参数描述**。`ToolDef.Schema` 可能含 `$ref`/`allOf` 等 `JsonSchemaNode` 不支持的字段 → 编译失败或被静默忽略。 | 对每种 `Kind` 各造一个带复杂 Schema 的 ToolDef，过一遍转换，检查 `parameters` 是否与预期一致；**重点测 `oneOf`（枚举）和嵌套 object**。 |
| R4 | **win32 沙箱下 shell 执行体跑不起来**。`Kind: shell` + `Entry: first_line.sh` 在 ConstrainedLanguage 下 `spawn` 被拒（参考 `pwsh` 工具文档）。 | 在 win32 上实测：起一个 `Kind: shell` 的 ToolDef，调 `execute`，看是否返回 `EPERM` 或等价错误。 |
| R5 | **能力库（capabilities registry）与 ToolDef 注册表脱节**。`capability-bridge` 读到的是 `~/.dsh/capabilities/registry.json`，而 ToolDef 注册来自 skill-tree 的 `Tools` 数组——两者不同源，注册后 `list_capabilities` 不会反映新工具。 | 注册后调 `list_capabilities` 看新工具是否出现在 `active` 列表；**这不算 block，但属于已知边界，要在报告里标注**。 |

---

## 4. 落地清单（分步）

### Step 0：前置（已验证）
- [x] `ToolRuntime.register(def)` 存在且 API 明确（`index.d.ts:603`）
- [x] `defineTool(options) → ToolDefinition` 存在（`schema.d.ts:239`）
- [x] 插件注入 `ctx.inject(['tools'], ...)` 模式已有 3 个现成先例（tool-evolution / capability-bridge / arm-isolation）
- [x] `ToolDef` 接口定义在 `skill-tree`（`src/index.ts:21-36`）

### Step 1：新建包 `packages/tool-def-bridge`
- [ ] 写出 `src/index.ts`（骨架：`apply(ctx, config)`，`loadDefs(path)`）
- [ ] 写出 `src/to-dsh-tool.ts`（`ToolDef → ToolDefinition` 转换器，含 Schema 编译）
- [ ] 写出 `src/shell-runner.ts`（`Kind: shell` 的执行体；先按"Node 内联"路线，shell 脚本翻译成 `.js` 再 `require`）
- [ ] 写出 `src/python-runner.ts`（`Kind: python` 的执行体；`spawn python`）
- [ ] 验收：**单测**跑通一个最小 ToolDef（`Kind: shell`, `Entry: first_line.sh`），确认 `ctx.tools.get('demo_first_line')` 非 undefined 且 `schemas()` 返回它的 schema。

### Step 2：注册到装配层
- [ ] 在 cordis patch 里挂载 `tool-def-bridge` 插件，指向 skill-tree 的 registry 路径（配置项 `registryPath`）
- [ ] 验收：**启 gen，调 `ctx.tools.get('demo_first_line')` 打印出来不是 undefined**；`schemas()` 包含 `demo_first_line`。

### Step 3：修 `skill-to-preset` 的映射逻辑
- [ ] `KNOWN_TOOLS` 加上 `tool-def-bridge` 注册后会出现的工具名模式（或：改为**动态查 registry**，不硬编码）
- [ ] `specToPreset` 的 `unmapped` 计算：调用 `ctx.tools.get(name)` 判断，而不只靠 `KNOWN_TOOLS` 白名单
- [ ] 验收：**跑 `scripts/skill-to-preset.mjs --selftest`**，判据③（未注册工具被如实标注）应**从 pass 变 fail**（因为 `demo_first_line` 现在注册了）—— 这是**预期的正向变化**，说明桥修好了。

### Step 4：补能力库同步（可选，不在 P0 范围内）
- [ ] `tool-def-bridge` 注册工具时，同步往 `~/.dsh/capabilities/registry.json` 写一条 `status: active` 的 entry
- [ ] 验收：`list_capabilities` 能看到新注册的工具

---

## 5. 证据分级表

| 结论 | 分级 | 依据 |
|---|---|---|
| `ToolRuntime.register(def)` 是注册工具的 API | **直接读到** | `index.d.ts:603`，字面签名 |
| `defineTool` 构造 ToolDefinition | **直接读到** | `schema.d.ts:239` |
| 插件用 `ctx.inject(['tools'], ...)` 挂工具 | **直接读到** | `tool-evolution/src/index.ts:116-167`、`capability-bridge/src/index.ts:285-372` |
| `toolFilter` 只裁子代、不影响父代 | **直接读到** | `subagent-nesting-and-toolfilter.md:56`（实测结论文档） |
| win32 沙箱下子进程 spawn 受限 | **直接读到** | `pwsh` 工具文档："ConstrainedLanguage mode… programs cannot open named pipes… reflection fails"；推断 spawn 同样被限 |
| `ToolDef.Schema` 到 `ParameterSchemaSpec` 需要转换层 | **推断** | `schema.d.ts:86-88` 的 `ParameterJsonSchema` 是 `ObjectJsonSchema & { properties: … }`；`ToolDef.Schema` 是 `Record<string, unknown>` —— 形态不同，需要编译 |
| 注册工具影响所有 agent（Registry 是进程单例） | **推断** | `ToolRuntime extends Service`（`index.d.ts:493`），Service 是 cordis 进程内单例；但 `restrict()` 支持 per-scope（`index.d.ts:610-611`）|
| `KNOW_TOOLS` 硬编码白名单是最简改造点 | **二手（README/注释）** | `skill-to-preset.mjs:39` 的注释写"只列常用的几个基线" |
| `ReadOnly` 对应"跳过权限审批" | **直接读到** | `skill-tree/src/index.ts:35` 注释原文 |
| shell 工具在 win32 下**可能**跑不起来 | **推断（未实测）** | 从 ConstrainedLanguage 的限制推演，但**没有直接跑过 `first_line.sh` 的实测** |

---

## 6. 诚实清单

### 直接读到的
- `@deepseek-ai/dsh-tools` 的类型定义（`types/index.d.ts`、`types/schema.d.ts`、`types/json-schema.d.ts`）
- `packages/tool-evolution/src/index.ts`、`packages/capability-bridge/src/index.ts`、`packages/arm-isolation/src/index.ts` 的插件挂工具写法
- `packages/skill-tree/src/index.ts` 的 `ToolDef` 接口
- `scripts/skill-to-preset.mjs` 的 `KNOWN_TOOLS` 白名单逻辑
- `docs/subagent-nesting-and-toolfilter.md` 的 `toolFilter` 实测结论

### 推断
- win32 ConstrainedLanguage 下 `spawn` 受限（未实际验证）
- `ToolDef.Schema` 需要编译为 `ParameterSchemaSpec`（未写转换器）
- Registry 是进程单例（从 `Service` 基类推断）

### 没验证
- `Kind: shell` + `Entry: first_line.sh` 在 win32 沙箱下是否能跑（**仅推断**）
- `list_capabilities` 注册后是否自动感知新工具（**未测**）
- `skill-to-preset.mjs` 的 `--selftest` 在当前代码下是否全绿（**未跑**）

### 没能读到的关键文件
- `node_modules/@deepseek-ai/dsh-tools/lib/` 的 **JS 实现**（只有 `.d.ts`，没读 `.js`）—— 因此 `ToolRuntime.register` 的内部是否校验 `name` 唯一性、是否有 scope 隔离细节，**只从类型推断，未直接读源码**。
- `packages/skill-tree/src/skill-tree.ts` 的 `load()` / `save()` 实现 —— **只读了 `index.ts`（类型声明），没读执行器**。
- `scripts/skill-factory.mjs` 的完整逻辑 —— **只看到被 `skill-to-preset.mjs` 引用，没读本身**。
