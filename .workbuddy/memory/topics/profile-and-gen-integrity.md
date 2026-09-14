# profile 装配与 gen 实例一致性

> 上级索引：`../MEMORY.md` ｜ 相关：`prompt-cache.md`、`generation-swap.md`
> 完整文档：`docs/gen-plugin-tree-partial-failure.md`、`docs/gen-port-prefix-invalidation.md`

核心命题：**gen 实例之间一旦不一致（工具集 / 呈现模式 / 端口 / 配置），会话迁过去就是"环境漂移"**。
这一类故障的共同特征：**静默** —— 不报错、能跑、但一直在做错事。

## ★ 离线验收通路（改任何 profile 配置后必跑）

```bash
DSH_HOME='C:\Users\Admin\.dsh' node node_modules/@deepseek-ai/dsh/lib/bin.js web --dump-config
# 已挂成：npm run check:profile
```

**组合整棵插件树后直接退出，不启服务**（bundles → cordis.patch.yml → `--patch` overlays）。
它走的正是 `duplicate loader entry id` / `declares no dsh.bundle` / BOM 这三类故障的同一条路径，
所以是这几类问题最省事的判据。

**健康基线**：exit 0、stderr 空、**571 行**、`pet` 0 条、`design-canvas-bridge` 恰好 1 条、`id: switchboard` 1 条。

## 单一来源原则（bundle 条目）

`duplicate loader entry id: <x>` 的根因是**同一个 id 被两处定义**：

- 包自带 `packages/<x>/cordis.patch.yml` 的 `insert:`
- profile `cordis.patch.yml` 的 `- id: <x>` 覆盖块

→ **id 的定义权归包内 patch，profile 只留「不许重复定义」的注释。**
需要临时覆盖用 CLI `--patch` overlay，不要写进 profile。
（2026-09-14 已按此收敛 `design-canvas-bridge`。）

## BOM 政策（硬约束）

- **BOM 会让 DSH 起不来**：`dsh-app-boot` 有 4 处 `JSON.parse(readFileSync(pkgJson,"utf8"))`，
  UTF-8 BOM 使 JSON.parse 在首字节抛 `SyntaxError: Unexpected token '\uFEFF'` → **整个 gen 挂**。
- **写入侧 BOM 来源**：**PowerShell 5.1 的 `Set-Content -Encoding UTF8` 必加 BOM**、记事本"UTF-8"。
- **防护已统一**：`scripts/patch-app-boot-bom.mjs`（幂等，已挂 postinstall）把 4 处解析换成
  `parseJsonNoBom` / `readJsonManifest`；**剩余裸调用 0 处**，带 BOM 的第三方包也不会再打崩 gen。
- **守卫**：`npm run check:bom` = `scripts/check-bom.mjs`（发现即 exit 1；`--fix` 就地剥 3 字节、不碰 CRLF）。

## 插件移除：`disabled` ≠ 移除

以桌宠为例（2026-09-14 两个桌宠已彻底删除）：

- 在 `dsh.profile.bundles` 里 → **仍会被 loader 装配**（即使 row 被 `disabled: true`）
- 声明了 `dsh.client` 的包 → DSH web 侧**会扫描 node_modules 注入前端 roster**，目录还在就可能被加载
- 针对它的 `- id:` 覆盖块不删 → 变成**悬空引用**

**正确做法**：从 `bundles` + `dependencies` 删 → 移走 `node_modules` 目录 → 删掉 `- id:` 覆盖块 → 清掉移空的 scope 目录。
脚本：`scripts/remove-desktop-pets.mjs`（幂等；同盘移动备份到 `~/.dsh/.backup/`，**跨盘 rename 会 EXDEV**）。

## gen 插件树"部分加载失败"会毁掉换代（2026-09-14 已修）

- **现象**：换代后工具集变化、Code Mode（PTC）静默回落 native、模型要靠试探发现环境。
- **根因**：`duplicate loader entry id: design-canvas-bridge` → `dsh: plugin tree failed to load`
  （gen-3086/3087/3088 各 6 条）。**间歇性**（时序相关）。
- **后果链**：插件树装配失败 → 少 25 个工具 → `dsh-agent-tool-presentation` 的
  `ctx.inject(["codeRuntime"], ...)` 回调不执行 → 未声明 mode → 回落 native →
  system + tools 同时变 → prompt 前缀全失效（迁移后首轮命中率 0%）。
- **三条修复（已落地，build `b1789318300768`）**：
  1. 单一来源（见上）
  2. **spawner 打启动分隔标记** `===== BOOT gen=... =====`
     （boot.log 是 append 的，否则无法区分"本次启动"与历史错误）
  3. **coordinator verify 增加启动健康检查**：`probe.ok` 后读该 gen **本次启动**的 boot.log，
     命中 `plugin tree failed to load` / `duplicate loader entry id` / `declares no dsh.bundle` /
     `failed to apply loader entry include` / `cannot resolve profile bundle` / `SyntaxError: Unexpected token`
     → **`rollbackFlip`**，坏 gen 永远接不到会话。
- 这条同时实现了"加载失败 fail-fast"与"能力一致性防线"——用启动日志作代理判据，比逐个比对工具清单更可靠。

## gen 实例端口会击穿 prompt 缓存（2026-09-14 定位并已修）

- **机制**：`@deepseek-ai/dsh-web-app` 的 `localWebUrl(ctx)` 返回 `http://127.0.0.1:<本实例 webServer.port>`，
  经 `webSurfacePrompt()` 拼进 **system prompt**。而 gen 池每实例端口不同（实测 3082~3089，共 8 个）。
  **⇒ 每次蓝绿换代 / 会话迁移，system prompt 字节变化 → 整个前缀失效 → 首轮命中率 0%。**
- **证据**：`session-28f50f57` 19 次 header 里端口变化 13 次，**每次端口变化后第一条请求命中率均为 0.0%**，
  第二条恢复 97~99%。
- **修复**：`scripts/patch-web-app-public-url.mjs` 让 `localWebUrl` 优先读 `DSH_PUBLIC_WEB_URL`；
  启动器注入 `DSH_PUBLIC_WEB_URL=http://127.0.0.1:3080`（前门）。gen 经 `spawnGen` 的 `{...process.env}` 继承。
  已加入 `package.json` 的 `postinstall`。
- 另有一处形态差异 `6449|94~96` vs `1783|70`（system 差 4666 字符、少 25 个工具）——
  由插件树部分加载失败解释，见上。

## ★ 插件 Config 缺失 = gen 启动即崩，而换代仍报 success（2026-09-14 实测）

**症状**：换代返回 `{"result":"success","note":"已快速切换 → gen-XXXX"}`，**但新代其实当场崩了**。
会话表现为"换了代但没反应"，只有翻日志才看得见。

**证据链**（保留在 `~/.dsh/switchboard/`）：
- `crash-investigation/gen-3083-31332-*.txt`：`gen EXIT gen=gen-3083 pid=31332 code=1`
- `gen-3083/boot.log` 尾部：
  `failed to apply loader entry capability-bridge (@dsh-brain/capability-bridge): invalid config:
   - Invalid input: expected object, received undefined`
  ⇒ `resolveConfig` 在 cordis 里拦下，`Promise.allSettled` 后进程退出。

**根因**：包的 `Config = z.object({...})`，而 `packages/<pkg>/cordis.patch.yml` 的 `insert` 里
**没写 `config:`** → loader 传 `undefined` → zod 校验失败。
（其余包都写了，`capability-bridge` 此前漏了 —— 单点遗漏，不是系统性问题。）

**修法**：insert 里**显式写 config，哪怕全是默认值**：
```yaml
- insert:
    - id: capability-bridge
      name: '@dsh-brain/capability-bridge'
      config:            # ← 必须写；字段与包内 Config 保持一致
        registryPath: ''
        maxRows: 50
```
现状：7 个 `@dsh-brain/*` 包（capability-bridge / conveyor-context / design-canvas-bridge /
key-pool-proxy / subagent-council / switchboard / tool-evolution）**已全部显式写 config**。

**★ 教训（比这个 bug 更重要）**：**换代报 `success` ≠ 新代可用。**
`verify-boot-health` 这次报了 `ok: 本次启动无装载失败`，但新代仍崩 —— 说明该检查有盲区。
⇒ **换代后必查两处**：`~/.dsh/switchboard/gen-<新代>/boot.log` 与 `crash-investigation/` 有无新文件。

## 两个平面：host plane vs preset plane（**改错平面 = 改了没反应**）

| 平面 | 内容 | 改动位置 |
|---|---|---|
| **host plane** | 进程单例类服务：`subagents` 注册表、background jobs registry、`tool-subagent-report` | **bundle**（`dsh-base` / `dsh-web-app` 的 patch） |
| **preset plane** | 每个 agent 看到的 **model-facing 工具行**：`tool-bash` / `tool-pwsh` / `tool-subagent*` | **preset realm**（**不是** profile `cordis.patch.yml`） |

**实例**：`web` 下 `tool-bash`、`tool-pwsh`、`tool-subagent*` 在 `dsh-web-app/cordis.patch.yml` 里被
`disabled: true`。注释原文：「**What a preset chooses is which delegation TOOLS its agent sees**」。
⇒ **要在 web 里启用委派工具，得动 preset 层。**

`dsh-base` 的注释还警告：把 registry 挪进 preset realm 会让 sibling row 看不见它
（表现为 `run_in_background` 答 "background jobs unavailable"）。
