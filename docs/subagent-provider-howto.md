# 怎么加一个自己的子代理能力（SubagentProvider）

> 本文是 2026-09-14 落地第一个自定义 provider（`packages/subagent-council`）时踩出来的完整流程。
> 目标读者：要在 DSH 上给模型加一个**新角色**（不是新工具）。

---

## 0. 一句话模型

**一个 `SubagentProvider` = 一个预配置的子代理工厂。**

`start(request)` 收到顶层的委派请求，你在这里注入这个角色的
`persona`（人格/职责边界）、`toolFilter`（能用哪些工具）、
`agentOptions`（provider route + model）、`outputSchema`（强制结构化输出），
然后把请求交给 DSH 原生的 in-process driver 去跑。

于是"多模型会议室 / 三省六部"不需要新机制 —— **每个席位就是一个 provider**。

---

## 1. 平面归属（最容易搞错的一点）

| 东西 | 属于哪个平面 | 放哪里 |
|---|---|---|
| **provider 注册**（`ctx.subagents.registerProvider`） | **host plane** | 包自己的 `cordis.patch.yml` 里 `insert` 一行（profile 的 `bundles` 收它） |
| **工具行**（`tool-subagent` 指向某个 provider） | **agent plane（preset）** | `<dshHome>/.agent-presets/<preset>/agent.cordis.yml` |
| `subagents` registry 本身、spawn/fork backends | host plane（上游 `dsh-base` 已提供） | 不用动 |

**为什么**：`subagents` 是进程单例，provider 名全局唯一，第二个同名注册会 loud fail。
所以 provider 不能放进 preset（每个会话一份会撞）。

### ⚠️ 别被 `--dump-config` 骗了

`--dump-config` 只组合 **host plane**。preset 是运行时挂载的，**不进 `loader.entries()`**。
`tool-subagent*` 在 host plane 里是 `disabled: true` 的（`dsh-web-app` 的 patch 干的），
**但 `code` preset 又把它们挂了一遍** —— 所以模型手里其实有 `subagent`。

**判据**：想知道「模型能用什么」→ 读会话的 `request/header`（`scripts/dump-request-tools.mjs`）；
想知道「装配有没有散」→ 才用 `--dump-config`。

---

## 2. 目录与文件（照 `packages/tool-evolution` 抄）

```
packages/<你的包>/
├── package.json          ← 关键是 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml      ← host plane 的 insert 行
├── tsconfig.json
├── src/index.ts          ← 源
└── lib/index.js          ← 编译产物（main 指向它）
```

### `package.json` 最小骨架

```json
{
  "name": "@dsh-brain/subagent-council",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/schemastery": "*",
    "@deepseek-ai/dsh-subagent": "*",
    "@deepseek-ai/dsh-subagent-in-process-driver": "*"
  },
  "devDependencies": { "typescript": "^5.4.0" }
}
```

### `cordis.patch.yml`

```yaml
- insert:
    - id: subagent-council
      name: '@dsh-brain/subagent-council'
      config:
        seat: architect
```

> **铁律**：不要在 profile 的 `cordis.patch.yml` 里再写同 id 的覆盖块
> → `duplicate loader entry id` → 整棵插件树装配失败。

---

## 3. provider 实现（全部代码就这么点）

```ts
import z from "@deepseek-ai/schemastery";
import { startInProcessRun } from "@deepseek-ai/dsh-subagent-in-process-driver";

export const name = "subagent-council";
export const inject = ["subagents"];                    // ← 必须
export const Config = z.object({ seat: z.string().default("architect") });

class SeatProvider {
  name;
  capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true };
  inheritsParentContext = false;                        // 席位是独立上下文

  start(request: any) {
    const next = { ...request };
    next.persona = PERSONA;                             // 注入人格（shadow deployment persona）
    if (MODEL) next.agentOptions = { ...(request?.agentOptions ?? {}), model: MODEL };
    return startInProcessRun(next, {});                 // 其余交给原生 driver
  }
  prepareContinuable() { return Promise.resolve({}); }  // 支持 continuable（= 不继承父历史）
}

export function apply(ctx: any, config: any) {
  ctx.subagents.registerProvider(new SeatProvider(...));
}
```

### `start(request)` 能用的字段（`SubagentStartRequest`）

| 字段 | 类型 | 用途 |
|---|---|---|
| `label?` | `string` | 持久化的短显示标签 |
| `prompt` | `ContentBlock[]` | 给子代理的用户消息（顶层给的） |
| `parent` | `Agent` | 顶层代理（in-process provider 从它推出 workspace / lineage / depth） |
| `signal` | `AbortSignal` | 唯一取消通道 |
| `agentOptions?` | `{ provider?, model?, maxTokens? }` | **多模型会议室入口** |
| `outputSchema?` | `ObjectJsonSchema` | 强制结构化最终结果（需 `capabilities.outputSchema`） |
| `maxDepth?` | `number` | 递归深度上限（需 `capabilities.depthLimit`） |
| `toolFilter?` | `ToolRestriction` | 子代理工具白名单（需 `capabilities.toolFilter`） |
| `persona?` | **`string`** | 每子代理人格，`{{…}}` 模板语义（需 `capabilities.persona`） |

> `capabilities` 里声明了 true 的东西，service 会在**创建子代理之前**校验；
> 声明了却传不支持的值会被 start 拒绝。**只声明你真的实现的。**

---

## 4. 装配四步

```powershell
# 1) 建 junction（Windows 上 pnpm 会拼坏路径，所以统一走这个脚本）
#    在 scripts/fix-links.ps1 的 $pairs 里加一行，然后：
powershell -File D:\project_develop\dsh-brain\scripts\fix-links.ps1

# 2) 把包名加进 profile 的 bundles
#    C:\Users\Admin\.dsh\profiles\web\package.json
#      dsh.profile.bundles += "@dsh-brain/subagent-council"

# 3) 离线验收（组合整棵 host 插件树后退出）
cd D:\project_develop\dsh-brain
DSH_HOME='C:\Users\Admin\.dsh' node node_modules/@deepseek-ai/dsh/lib/bin.js web --dump-config
#    判据：exit 0 / stderr 空 / 无 duplicate / 能看到你的 id
#    历史基线：571 行（2026-09-14 加 subagent-council 后 → 576 行）

# 4) 建自定义 preset（随附 preset 只读，必须复制到 user 根）
#    复制 node_modules/@deepseek-ai/dsh/config/agent-presets/code → ~/.dsh/.agent-presets/code-council
#    在 agent.cordis.yml 的 delegation 组里加工具行：
#      - id: tool-subagent-council-architect
#        name: '@deepseek-ai/dsh-tool-subagent'
#        config: { provider: council-architect, toolName: council_architect, backgroundMode: continuable }
#    改 preset.yml 的 name/description，并【丢掉复制的 roster order】
#    切默认：~/.dsh/settings.yaml → agent-presets.default: code-council
```

`scripts/add-preset-council.mjs` 是上面第 4 步的幂等实现，可作模板。

---

## 5. 验收（重启后）

**⚠️ preset 的切换只对「此后创建的新会话」生效**；运行中的会话还停在它当初的装配上。
同样，provider 注册要**重启 DSH** 才生效。

```bash
# 建一个新会话，直接问它工具清单（别自己猜）
node scripts/probe-delegation-live.mjs
# 然后读权威口径：
node scripts/dump-request-tools.mjs <会话目录相对路径>
# 判据：工具清单里出现 council_architect
```

---

## 6. 已知坑

| 坑 | 现象 | 处置 |
|---|---|---|
| **Code Mode 双入口错配** | 模型直接调 `council_architect` → `unknown tool "x": only run_code is available`，白烧一轮 | 当前是 Code Mode（`DSH_TOOLS_MODE=code`），工具必须经 `run_code` 里的 `tools.*()`。可考虑在 system prompt 里显式声明 |
| `!!js` 标签告警 | 用标准 yaml 库解析 preset 会报 `Unresolved tag` | 正常，那是 DSH 的加载器方言，不是错误 |
| preset 只对空白会话可切 | 已有产出的会话不能 `recompose` | 改默认值只影响新会话 |
| 副本会漂移 | 从 `code` 复制的 preset 不会随上游升级 | 上游 preset 结构变了要重新复制 + 重放插入（脚本幂等） |
| 代际不回收 | 每编辑一次 `agent.cordis.yml` 就多一套常驻挂载 | 别频繁改；改完重启更干净 |
