# 我们对上游 DSH 的耦合面清单（升级前标记，2026-10-07）

> **为什么有这份**：用户要求「升级前把我们自己写的代码做好标记」。
> 这份的用途是**升级（0.1.1-rc.2 → 0.2.1-alpha.1）时的检查单** —— 逐条问"它还在不在、还对不对"。
>
> **快照（回滚点）**：`git HEAD = 45ab8b4` · 实装 `@deepseek-ai/dsh@0.1.1-rc.2` ·
> 目标 `@deepseek-ai/dsh@0.2.1-alpha.1`（= 上游 `master` HEAD，SHA `5badb15`）。

---

## 1. 我们自己的包（`packages/*`，9 个 —— 与上游无关，不受升级影响，但**依赖上游 API**）

`agent-io-bridge` · `arm-isolation` · `capability-bridge` · `conveyor-context` · `key-pool-proxy` ·
`skill-tree` · `subagent-council` · **`switchboard`** · `tool-evolution`

★ **其中 `switchboard` 最危险**：它直接 spawn DSH、读 profile manifest、用 `guard.ts` 正则拦 DSH 路径
⇒ 上游目录重构（`packages/` 分组化、`apps/` 新增 `desktop`/`desktop-host`）**可能打到它的假设**。

## 2. `patch-package` 的补丁（`patches/*.patch`，打在 npm 包的 `lib/` 编译产物上）

| 补丁 | 目标 |
|---|---|
| `@deepseek-ai+dsh-compaction-basic+0.1.1-rc.2.patch` | `…/dsh-compaction-basic/lib/index.js` |
| `@deepseek-ai+dsh-mcp-client+0.1.1-rc.2.patch` | `…/dsh-mcp-client/lib/index.js` |
| `@deepseek-ai+dsh-pwsh-local+0.1.1-rc.2.patch` | `…/dsh-pwsh-local/lib/index.js` |
| `dsh-gate-pending-2026-09-22.patch` | 未核（名字里带 pending） |

★ **文件名里钉着 `0.1.1-rc.2`** ⇒ 它们就是为这个版本做的；★ 而主版本号一变，`lib/index.js` 必重编
⇒ **补丁的上下文行必变 ⇒ 必失效**（判据：`compaction-basic` 仅 `src/index.ts` 就改了 45 行）。

## 3. ★★ `postinstall` 里的 5 个 `patch-*.mjs`（**最脆的一类**：改上游 `lib/index.js` + 我们的 profile）

```
"postinstall": "patch-package && patch-web-app-public-url && patch-app-boot-bom &&
                patch-goal-round-driver && patch-agent-loop-hardening && patch-profile-deps"
```

| 脚本 | 改的目标 | 它修的问题（升级时要问"上游修了没"） |
|---|---|---|
| `patch-web-app-public-url` | `@deepseek-ai/dsh-web-app/lib/index.js` | 让 system prompt 报**前门地址**而非本实例端口（否则换代时 prompt 字节漂 ⇒ 打 prefix cache） |
| `patch-app-boot-bom` | `@deepseek-ai/dsh-app-boot/lib/index.js` | **UTF-8 BOM 防护**（`JSON.parse` 遇 BOM 抛错 ⇒ gen 起不来） |
| `patch-goal-round-driver` | `@deepseek-ai/dsh-goal-round-driver/lib/index.js` | `event.data.reason` **可选链**（undefined 时抛 `reading 'kind'`） |
| `patch-agent-loop-hardening` | `@deepseek-ai/dsh-agent-loop/lib/index.js` | 两处加固（非 LlmError 的回合错误留堆栈 …） |
| `patch-profile-deps` | ★ **`$DSH_HOME/profiles/web/package.json`** | ★ 修**我们自己的装配面**：清悬空依赖 / 显式钉住 `dsh-base` / 去 BOM / 把每个 `@dsh-brain/*` bundle 声明进 `dependencies` |

### ★★★ 安全网：`scripts/patch-anchors.mjs`（严格锚点）

`patch-goal-round-driver.mjs` 的注释逐字写着：

> 「★ 2026-09-15：改用**严格锚点应用器**。旧版用 `split/join` 替换后**只打印计数** ——
> 上游若已加 `?.`、或改了字段名，**计数为 0 也照样"成功"退出，等于静默失效**。」

⇒ ★★ **所以升级后跑 `postinstall`，这些脚本会「大声失败」而不是静默改不中** ——
**这是本次升级最重要的一条安全网**（也意味着：`postinstall` 的退出码是可信的信号）。

## 4. 我们最特殊的两条接缝（上游若动，整条机制断）

| 接缝 | 我们要查什么 |
|---|---|
| **`DESIGN_CANVAS_KERNEL_DIR` / bridge `loadKernel()`** | 这个 env 名与加载点还在不在（实验内核 `expt-kernel` 全靠它） |
| **`apps/cli/config/agent-presets/**`** | 实测 0.2.1 里一批预设文件**被删**（`code/agent.cordis.yml` · `cordis/preset.yml` …）⇒ **我们的 preset 装配可能整个不认** |

## 5. 升级执行与检查单

1. **回滚点**：`git HEAD = 45ab8b4`（升级的改动单独成笔，可 revert）。
2. **升级**：装 `@deepseek-ai/dsh@0.2.1-alpha.1`（★ 会触发 `postinstall` ⇒ **它是否成功是第一个判据**）。
3. **逐条验**（每条的判据都明确）：
   - [ ] `postinstall` 退出码 **0**（严格锚点 ⇒ 失败会大声；非 0 ⇒ 看是哪个脚本的哪个锚点）
   - [ ] `packages/switchboard` 能编译（`tsc`）—— 它依赖 DSH 的接口
   - [ ] **preset 装配**：会话能起来、`agent-presets.default` 仍有效
   - [ ] **`DESIGN_CANVAS_KERNEL_DIR`** 仍被识别（实验内核加载点）
   - [ ] **换代**（`?cmd=handover`）仍走通 —— ★ 这是 M0 的判据，也顺带验了我们的补丁面
   - [ ] `guard.ts` 的正则仍拦得住（上游路径变了 ⇒ 它可能**拦错/漏拦**）
4. ★ **补丁处置顺序**：**先问"上游是否已修"**（`compaction-basic` 上游 +1396/-424、删了 `invariant.ts` ⇒ 大改），
   **再决定重做还是丢弃** —— 不要默认重做（那会白背维护负担）。

---

## 未核实

- `dsh-gate-pending-2026-09-22.patch` 的内容与状态（名字里带 pending）。
- `@deepseek-ai/dsh-mcp-client` 在 0.2.1 里搬去了哪个分组、改了多少。
- ★ 上游 0.2.1-alpha.1 的 **release notes**（还没读；上面全是**从 diff 反推**的）。
- 上游 `apps/desktop` / `apps/desktop-host` 对 **CLI 用法**是否有影响（桌面端可能改了 profile/启动方式）。
