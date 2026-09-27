# Design Canvas 两个东西的目录地址（给新会话的地址清单）

> 生成时间：2026-09-27 23:2x
> 用途：用户要重开一个会话专门处理这两件事，这是它们的**确切地址与身份**。

---

## 一、Design Canvas 插件（MCP server）—— 独立仓库

**这就是提供 `mcp__design-canvas__*` 全部工具的那个本体。**

| 项 | 值 |
|---|---|
| **目录** | `D:\project_develop\design-canvas` |
| **git remote** | `https://github.com/xr192172/design-canvas` |
| **包名 / bin** | `design-canvas` → `dist/src/server.js` |
| **入口** | `src/server.ts`（构建产物 `dist/src/server.js`） |
| **语言** | TypeScript + ESM，Node ≥ 18 |
| **构建** | `npm run build`；测试 `npm test`（vitest） |
| **文档** | `AGENTS.md`（AI 开发约定）、`CONTRIBUTING.md`、`docs/` |
| **★ 当前状态** | **detached HEAD @ `340e476`**，与 `main`（`eccac42`）**已分叉**；<br>且局部 `main` 比远端多 1 笔（**非我提交**）。<br>⇒ **这不是一条"干净主线"的仓库，接手前先确认该在哪个分支上工作。** |

> ⚠️ **注意**：`D:\project_develop\design-canvas` 与我上一轮投递的 `PR/` 目录就在这个仓库里
> （`PR/PR-001-duplicated-literal-table-detector.md`，提交 `4197d0b`，**未推送**）。

---

## 二、Design Canvas 桥接插件（DSH 侧）—— 在 dsh-brain 仓库内

**它不是 MCP，是一个 DSH 插件**：把上面的 MCP 接进来，并在选中工作区时自动预热 tree-sitter AST + 符号索引。

| 项 | 值 |
|---|---|
| **目录** | `D:\project_develop\dsh-brain\packages\design-canvas-bridge` |
| **包名** | `@dsh-brain/design-canvas-bridge` |
| **源码** | `src/index.ts`（唯一入口） |
| **构建** | `npm run build`（tsc） |
| **包内配置（★单一来源）** | `packages/design-canvas-bridge/cordis.patch.yml` |
| **用途（逐字）** | "DSH 通过 `@deepseek-ai/dsh-mcp-client` 把 design-canvas 的 MCP 工具注册到 `ctx.tools`（`mcp__design-canvas__*`），本插件在选中工作区时自动调用 `import_project` 预热 tree-sitter AST + 符号索引。" |

### 它挂载时的配置（在包内 `cordis.patch.yml`）

```yaml
- insert:
    - id: design-canvas-bridge
      name: '@dsh-brain/design-canvas-bridge'
      config:
        enabled: true
        serverName: design-canvas
        maxFiles: 500
        includeTests: false
        includeArchive: false
        designMode: false
        kernelDir: D:\project_develop\design-canvas   # ← 指向上面那个仓库
```

> ⚠️ **单一来源铁律（该文件逐字警告）**：**不要在 profile 的 `cordis.patch.yml` 里再写
> `- id: design-canvas-bridge` 覆盖块** —— 会触发
> `TypeError: duplicate loader entry id: design-canvas-bridge`
> ⇒ `dsh: plugin tree failed to load` ⇒ **整棵插件树装配失败**（工具集少 25 个、Code Mode 静默回落、prompt 前缀全失效）。

---

## 三、两者怎么连起来的（谁调用谁）

**MCP 连接配置在**：`C:\Users\Admin\.dsh\profiles\web\cordis.patch.yml`（**这是 DSH_HOME，不在项目里**）

```yaml
# design-canvas MCP server -> DSH 原生 mcp-client 桥（stdio 子进程）
- insert:
    - id: mcp-client
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: design-canvas
        command: node
        args:
          - D:\project_develop\design-canvas\dist\src\server.js   # ← 本体在这里
        env:
          DESIGN_CANVAS_HOME: D:\project_develop\dsh-brain\.design-canvas
          AGNES_UPSTREAM_BASE: http://127.0.0.1:3101
          AGNES_MODEL: agnes-2.5-flash
        cwd: D:\project_develop\design-canvas
        toolCallTimeoutMs: 180000
        failOnStartupError: false
```

```
┌─────────────────────────────────────────────────────────────┐
│  ① MCP server（本体 / 独立仓库）                            │
│     D:\project_develop\design-canvas                        │
│     → node dist/src/server.js（stdio 子进程）               │
└────────────────────────┬────────────────────────────────────┘
                         │ 由 @deepseek-ai/dsh-mcp-client 拉起
                         │ （配置在 ~/.dsh/profiles/web/cordis.patch.yml）
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  ② DSH 插件（桥接）                                          │
│     D:\project_develop\dsh-brain\packages\design-canvas-bridge │
│     → 把 MCP 工具注册进 ctx.tools（mcp__design-canvas__*）   │
│     → 选中工作区时自动 import_project 预热索引               │
│     （配置在包内 cordis.patch.yml）                          │
└─────────────────────────────────────────────────────────────┘
```

★ **一句话**：**① 是"能力本体"（工具在哪实现），② 是"接进来 + 预热"（DSH 怎么用它）。**
两者**地址不同、仓库不同、配置位置不同** —— 处理任一者时别把另一个也改了。

---

## 四、★ 顺带提醒：仓库里还有两个"同名但不同物"的副本

| 路径 | 身份 | 处置建议 |
|---|---|---|
| `D:\project_develop\dsh-brain\design-canvas-dev\` | **未被 dsh-brain 跟踪的游离副本**（`git ls-files` 为空）；<br>但 `git remote` 指向 `dsh-brain.git` ⇒ 疑似误共享了主仓 `.git` 或复制残留 | ⚠️ **别当第二份 design-canvas 用**，先确认是不是该删 |
| `D:\project_develop\feature-map-canvas\` | 另一个 canvas 项目（**与 design-canvas 不同物**） | 与本次无关 |
| `D:\project_develop\dsh-brain\expt-kernel\`、`.tmp-probe\kern-tsc-fix\` | 实验残留（package.json 里也印了 `design-canvas: dist/src/server.js`） | 历史产物，别混 |

> 还有 **`_probe_tools.mjs` / `_smoke_safe_rename.mjs` / `probe_*.mjs`** 等散落在 `design-canvas` 根目录的探针 ——
> 那是它自己的实验残留，不是本次两个目标之一。
