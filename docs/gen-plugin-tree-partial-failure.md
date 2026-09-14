# gen 插件树"部分加载失败" → 换代后能力残缺与环境漂移

> 发现日期：2026-09-14
> 严重级：**P0**（直接造成"换代后模式变了 / 工具用不了 / 模型要重新试探环境"）
> 状态：**✅ 已修复**（2026-09-14 01:00 三条措施落地，switchboard 构建通过 `b1789318300768`；
> 同日补齐 ④ BOM 统一防护 + ⑤ 两个桌宠彻底移除。离线验收 `npm run check:profile` 通过：571 行完整插件树、`pet` 0 条、`design-canvas-bridge` 1 条）

---

## 0. 修复摘要（先看这里）

| # | 措施 | 落点 | 验证 |
|---|---|---|---|
| **①** | **消除重复定义**：`design-canvas-bridge` 的配置统一到包内 patch，profile 不再写 `- id:` 覆盖块 | `packages/design-canvas-bridge/cordis.patch.yml`（+ `kernelDir`/`maxFiles:500`）<br>`~/.dsh/profiles/web/cordis.patch.yml`（删除覆盖块，留警示注释） | YAML 解析通过；profile 条目变为 `["agent-default-model","tool-result-pruner","spill-policy","insert:mcp-client","pet"]`，**不再含 design-canvas-bridge** |
| **②** | **启动分隔标记**：每次 spawn 在 boot.log 写 `===== BOOT gen=... =====`，使「本次启动」可被定位（boot.log 是 append 的，混有历史错误） | `packages/switchboard/src/spawner.ts` | 产物 `spawner.js` 含 `BOOT gen=` |
| **③** | **verify 增加启动健康检查**（= 实施 §5.2 的 fail-fast + §5.3 的能力一致性防线）：probe 通过后，读该 gen **本次启动**的 boot.log 片段，命中致命装载错误则 **rollbackFlip**，坏 gen 永远接不到会话 | `packages/switchboard/src/coordinator.ts`（`FATAL_BOOT_PATTERNS` / `findFatalBootErrors` / `lastBootSegment` + verify 阶段调用） | 产物 `coordinator.js` 含 `verify-boot-health`、`启动健康检查失败`、`plugin tree failed to load` |

**检测的致命模式**（`FATAL_BOOT_PATTERNS`）：

```
plugin tree failed to load           → 插件树加载失败
duplicate loader entry id            → loader entry id 重复
failed to apply loader entry include → loader entry include 应用失败
declares no dsh.bundle               → 无效 bundle 声明
cannot resolve profile bundle        → profile bundle 无法解析
SyntaxError: Unexpected token        → 配置语法错误（常见：UTF-8 BOM）
```

| **④** | **BOM 防护统一化**：`dsh-app-boot` 里 4 处 `JSON.parse(readFileSync(...))` 全部改走 `parseJsonNoBom` / `readJsonManifest`（上游原本只防护了 `readProfileManifest` 一处） | `scripts/patch-app-boot-bom.mjs`（幂等，已挂 postinstall） | 剩余裸调用 **0 处**；注入真 BOM 后 `--dump-config` 仍 exit 0 |
| **⑤** | **两个桌宠彻底移除**（不是禁用）：`@linxin666/dsh-pet` 从 `bundles`+`deps` 删除；`catpet-desktop-pet` 从 `deps` 删除；两者 `node_modules` 目录移走 | `scripts/remove-desktop-pets.mjs` | dump 树里 `pet` 行 **0 条**；两包已备份至 `~/.dsh/.backup/` |

**注意**：措施 ③ 同时覆盖 §5.2 与 §5.3 的意图 —— 用「启动日志」作为能力一致性的代理判据
（比逐个比对工具清单更简单可靠，且直接命中根因）。§5.4 的两个小问题也已于同日修完，见上表 ④⑤。

**离线验收通路（不需要启服务）**：

```bash
DSH_HOME='C:\Users\Admin\.dsh' node node_modules/@deepseek-ai/dsh/lib/bin.js web --dump-config
```

`--dump-config` 会**组合整棵插件树后退出**（bundles → cordis.patch.yml → overlays），
恰好是那条出过 `duplicate loader entry id` / `declares no dsh.bundle` / BOM 三连的路径
——所以它是这几类故障最省事的判据。已挂成 `npm run check:profile`。

---


---

## 1. 现象（用户体感）

> "有的时候换代会导致工具集变化，或者直接导致模式变化。明明我进去的时候是 PTC 模式（Code Mode），
> 换代以后就切成别的模式了，原先的工具都用不了……导致每次换代之后，模型都要重新去测试、尝试发现现在是什么环境。"

**这不是错觉。** 下面是从 gen 启动日志与会话记录里找到的证据链。

---

## 2. 证据

### 2.1 gen 启动日志里的插件树加载失败

`~/.dsh/switchboard/gen-*/boot.log`（累计）：

| gen | 错误计数 | 具体错误 |
|---|---|---|
| 3082 | 2 | （历史，后续启动正常） |
| 3083 | 2 | 同上 |
| 3084 | 1 | 同上 |
| **3085** | **3** | `cannot resolve profile bundle "@dsh-brain/key-pool-proxy"` + `SyntaxError: Unexpected token ''`（**BOM**） |
| **3086** | **6** | **`duplicate loader entry id: design-canvas-bridge`** → `plugin tree failed to load` |
| **3087** | **6** | 同上 |
| **3088** | **6** | 同上 |
| 3089 | 2 | `profile bundle "catpet-desktop-pet" declares no dsh.bundle` |
| 3090 | 2 | 同上 |
| 3091 | 1 | `SyntaxError: Unexpected token ''`（BOM） |
| 3092~3095 | **0** | 全部正常 |

**`plugin tree failed to load` 意味着整个插件树没装配成功** —— 这个 gen 的工具集是残缺的。

### 2.2 会话确实被迁移到了这些 gen 上（时间戳吻合）

```
session-28f50f57 的 request/header 端口迁移记录：
  seq=18160   01:27:23  → 3086     gen-3086 boot.log mtime = 09-12 01:43  ✅ 对上
  seq=257503  16:41:40  → 3088     gen-3088 boot.log mtime = 09-12 16:41  ✅ 对上
  seq=297733  22:11:45  → 3083
```

### 2.3 两种 header 形态 ↔ 报错的 gen

```
形态 6449|94~96（完整工具集）出现在：3082 / 3084 / 3087 / 3089
形态 1783|70（system 短 4666 字符、少 25 个工具）出现在：3083 / 3086 / 3088  ← 全部是报错的实例
```

**少掉的 25 个工具**正是 design-canvas 那一批（`design_canvas_*` + `mcp__design-canvas__*`）。
`cordis.patch.yml` 里 MCP 客户端配的是 **`failOnStartupError: false`** —— 启动失败时**静默继续**，
于是工具集悄悄少了 25 个。

---

## 3. 根因：同一个 loader entry 被两个来源定义

DSH 的插件树组合方式（`profiles/web/cordis.yml` 的注释写明）：

```
插件树 = package.json 的 dsh.profile.bundles 里每个 bundle
       → 然后 cordis.patch.yml
       → 然后任何 --patch overlays
```

而 **`design-canvas-bridge` 被定义了两处**：

**来源 A —— 包自带的 patch**（`packages/design-canvas-bridge/cordis.patch.yml`）：

```yaml
- insert:
    - id: design-canvas-bridge
      name: '@dsh-brain/design-canvas-bridge'
      config: { enabled: true, serverName: design-canvas, maxFiles: 300, ... }
```

**来源 B —— profile 的 patch**（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
# 通过 id 覆盖配置（bundle 已注册，不可再 insert 同 id）
- id: design-canvas-bridge
  config: { enabled: true, serverName: design-canvas, maxFiles: 500, ... }
```

**报错**：`failed to apply loader entry include (cordis:include): duplicate loader entry id: design-canvas-bridge`

**⇒ 当两处都被当作"新增条目"时，第二个就撞 id 冲突，整棵插件树加载失败。**

**而且它是间歇性的**：同样的配置文件，3082/3084 成功、3086/3087/3088 失败 ——
说明取决于**启动时的时序**（bundle patch 与 profile patch 的应用顺序，或 include 被处理两次）。

**其他包有同样的隐患**（都用 `insert` 插入自己，且 profile 里也可能覆盖）：

| 包 | 包内 patch | profile 是否也定义 |
|---|---|---|
| `conveyor-context` | `insert` | 否（仅包内） |
| `design-canvas-bridge` | `insert` | **是** ← 冲突源 |
| `key-pool-proxy` | `insert` | 否 |
| `switchboard` | `insert` | 否 |
| `tool-evolution` | `insert` | 否 |

---

## 4. 影响（为什么这是 P0）

| 后果 | 说明 |
|---|---|
| **① 能力残缺** | 插件树没装配成功 → 工具集少了 25 个（design-canvas 全套） |
| **② 模式漂移** | `dsh-agent-tool-presentation` 的 code 模式**依赖 `codeRuntime` 服务**；<br>该服务若因插件树失败而缺失，`ctx.inject(["codeRuntime"], ...)` 的回调不执行<br>→ 该 scope 没有声明 mode → **回落到 `defaultMode`（native）**<br>**这就是"PTC 模式换代后变成别的模式"的机制** |
| **③ 缓存击穿** | `system` 长度与 `tools` 列表同时变化 → 整个 prompt 前缀失效 → 首轮 0% |
| **④ 模型试探成本** | 模型必须靠试错发现"现在能用什么"，浪费 token 与轮次，并可能误用不存在的工具 |

**这是用户"每次换代都要重新试探环境"的直接来源。**

---

## 5. 修复方案（三选，建议全做）

### 5.1 消除重复定义 ⭐ 最直接

**只保留一个来源。** 二选一：

- **方案 A（推荐）**：把 profile 的 `- id: design-canvas-bridge` 覆盖块**删掉**，
  把定制值（`maxFiles: 500`）直接写进包内的 `cordis.patch.yml`（包里已是 300 → 改 500）。
  → 单一来源，无歧义。
- **方案 B**：删掉包内的 `cordis.patch.yml` 的 insert 块，profile 里改用完整的 `insert`。

**方案 A 更符合"包给默认、profile 给定制"的分层**，但需要消除"同 id 两处定义"这个事实。
如果坚持分层，则需要 **DSH 的 loader 支持幂等覆盖**（上游问题）。

### 5.2 让加载失败 fail-fast ⭐

目前插件树加载失败后 **gen 仍能启动并接受请求** —— 这是最危险的一点：
**switchboard 的 verify gate 会放它过，然后把会话迁过去。**

建议：
- 让 gen 在插件树加载失败时**拒绝就绪**（不监听端口 / 不响应 probe），
- 于是 `waitCatchUp` / `probe` 会失败 → 换代 abort → **坏实例永远接不到会话**。

### 5.3 verify gate 增加"能力一致性"校验 ⭐⭐ 结构性防线

即使修好了当前的重复定义，**未来任何配置改动都可能再次造成 gen 间能力不一致**。
所以需要一条**结构性防线**：

> **换代 verify 时，除了 `probe.ok`，还要比对「新 gen 的工具清单 + 呈现模式」与「当前活跃 gen」是否一致；
> 不一致则拒绝 promote。**

落地方式：verify 阶段各取一次工具清单（如通过 `host.describe` 或工具注册表快照），
做集合比对；差异非空即 reject 并在 `handover-status.jsonl` 记录差异明细。

**这条同时覆盖端口问题**（`DSH_PUBLIC_WEB_URL` 未生效时会被检出）**和本问题**。

### 5.4 顺带修掉的两个小问题 —— ✅ 均已修复（2026-09-14）

| 问题 | 症状 | 处置 | 验证 |
|---|---|---|---|
| **BOM** | `SyntaxError: Unexpected token ''`（3085 / 3091） | ① 清掉现存 BOM（`packages/key-pool-proxy/src/index.ts`）② 给 `dsh-app-boot` 补 `parseJsonNoBom`/`readJsonManifest`，4 处解析统一走它们（`scripts/patch-app-boot-bom.mjs`，幂等）③ 新增守卫 `scripts/check-bom.mjs`（默认扫描+exit 1，`--fix` 就地剥除）④ 挂到 `postinstall` + `npm run check:bom` | 剩余裸 `JSON.parse(readFileSync` **0 处**；给 profile manifest 注入真 BOM 后 `--dump-config` 仍 **exit 0 / 571 行完整树**（修复前该条件必崩） |
| **无效 bundle** | `profile bundle "catpet-desktop-pet" declares no dsh.bundle`（3089 / 3090） | **两个桌宠一并彻底移除**（用户决定不用了）：`scripts/remove-desktop-pets.mjs` 从 `dependencies` 删 `@linxin666/dsh-pet` + `catpet-desktop-pet`、从 `dsh.profile.bundles` 删 `@linxin666/dsh-pet`、移走两个 `node_modules` 目录、删掉 `cordis.patch.yml` 里已成悬空的 `- id: pet` 覆盖块 | dump 树中 `pet` 行 **0 条**；`design-canvas-bridge` 恰好 **1 条**（重复定义已消）；备份在 `~/.dsh/.backup/removed-desktop-pets-<ts>/`，可原样还原 |

**BOM 之所以值得单独建守卫**：现有 BOM 是「潜在」的（`key-pool-proxy` 的 BOM 在 `src/`，
而入口是 `lib/`，tsc 已把 BOM 剥掉，所以此前未爆）。真正的风险在于**写入方**——
Windows 侧 PowerShell 5.1 的 `Set-Content -Encoding UTF8`、记事本"UTF-8"都会加 BOM。
历史上 `scripts/patch-profile-deps.mjs` 正是因为踩过这个坑才特意写「确保无 UTF-8 BOM」。
而「加 BOM 的工具」和「解析 JSON 的消费方」会持续存在，所以判据是**扫描 + 写入侧统一**，不是靠记性。

---

## 6. 验证

**0. 离线验收（最快，不用启服务）**

```bash
npm run check:profile      # = dsh web --dump-config，组合整棵插件树后退出
npm run check:bom          # = node scripts/check-bom.mjs，发现 BOM 则 exit 1
```

判据：dump 退出码 0、stderr 空、无 `pet` 行、`design-canvas-bridge` 恰好 1 条。

1. **重启 switchboard 后**，逐个 gen 检查 `boot.log`：不应再出现
   `duplicate loader entry` / `declares no dsh.bundle` / `SyntaxError`
2. **换代后**用 `scripts/probe-preset-and-mode.mjs` 检查：header 形态指纹应**只有一种**
3. **用 `--compare` 看命中率**：不再出现因迁移导致的 0% 骤降
4. **能力一致性**：新会话的工具数量应与旧会话一致（当前健康值是 **95**）

---

## 7. 与另一份文档的关系

| 文档 | 覆盖的问题 |
|---|---|
| `gen-port-prefix-invalidation.md` | system prompt 里嵌 **gen 实例端口** → 换代必击穿缓存（**已修**） |
| **本文** | 插件树**部分加载失败** → 能力残缺 + 模式漂移（**已修**：单一来源化 + 启动健康检查 + BOM 防护 + 桌宠移除） |

**两者同源**：都是"**gen 实例之间不一致**"的不同侧面。
根本的解法是 **§5.3 的能力一致性 verify**：**只要不一致就不允许接管会话**。
