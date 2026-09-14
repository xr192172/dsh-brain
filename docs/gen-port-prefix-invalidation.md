# gen 实例端口写进 system prompt → 每次换代/迁移都击穿整个前缀缓存

> 发现日期：2026-09-14
> 严重级：**P0**（每次蓝绿换代 / 会话迁移必然导致一次全量 cache miss）
> 状态：**已修复**（代码补丁 + 启动器注入环境变量）

---

## 1. 结论

**DSH 把自己 Web 服务的监听端口写进了 system prompt**：

```
You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:3087. ...
```

而 switchboard 的 **gen 池**里每个实例监听不同端口（实测 3082~3089）。于是：

> **同一个会话在不同 gen 实例之间迁移时（蓝绿换代 / resume / 翻转），
> system prompt 的字节发生变化 → 整个 prompt 前缀失效 → 下一次请求全量重新计算（命中率 0%）。**

**用户实际访问的是前门（3080）；实例端口只是内部实现细节，不该出现在模型可见的文本里。**

---

## 2. 证据

### 2.1 端口分布（`session-28f50f57`，19 次 `request/header`）

```
seq     | time     | reason  | sysLen | tools | GUI port
     11 | 00:39:35 | initial |   6449 |    94 | 3085
  18160 | 01:27:23 | resume  |   1783 |    70 | 3086
  21969 | 01:57:04 | resume  |   6449 |    95 | 3087
 257503 | 16:41:40 | resume  |   1783 |    70 | 3088
 264703 | 17:33:15 | resume  |   6449 |    96 | 3089
 271732 | 20:36:06 | resume  |   6449 |    95 | 3082
 297733 | 22:11:45 | resume  |   1783 |    70 | 3083
 306457 | 01:12:10 | resume  |   6449 |    95 | 3082
 388456 | 11:03:54 | resume  |   1783 |    70 | 3083
 399833 | 12:21:59 | resume  |   6449 |    95 | 3084
 415676 | 15:36:19 | resume  |   6449 |    95 | 3082
 415728 | 16:57:49 | resume  |   1783 |    70 | 3083
 416925 | 17:18:09 | resume  |   6449 |    95 | 3084
 416955 | 19:31:40 | resume  |   6449 |    95 | 3082

GUI 端口分布: 3085×1 3086×1 3087×1 3088×1 3089×1 3082×10 3083×3 3084×2
不同端口数: 8       端口变化次数: 13 / 19
```

### 2.2 端口变化 ↔ 命中率（决定性）

```
seq=18160  3085 → 3086   其后命中率: 0.0%, 0.0%
seq=21969  3086 → 3087   其后命中率: 34.4%, 99.7%
seq=257503 3087 → 3088   其后命中率: 0.0%, 99.7%
seq=264703 3088 → 3089   其后命中率: 0.0%, 0.0%
seq=271732 3089 → 3082   其后命中率: 0.0%, 97.5%
seq=297733 3082 → 3083   其后命中率: 0.0%, 0.0%
seq=306457 3083 → 3082   其后命中率: 0.0%, 48.3%
seq=388456 3082 → 3083   其后命中率: 0.0%, 99.9%
seq=399833 3083 → 3084   其后命中率: 0.0%, 99.0%
```

**每一次端口变化，之后第一条请求的命中率都是 `0.0%`**，第二条立刻恢复到 97~99%。
（少数非 0 的样本是因为新 header 的**前缀恰好包含上一次已缓存的部分前缀**，或同一端口重复出现。）

**这解释了 §13（空闲过期）之外的另一类 0% 骤降。**
按 §3.4 的分类，它属于「③ 工具模式切换 / header 重建」那一类，但根因是**实例端口**，不是 preset。

---

## 3. 代码路径

`node_modules/@deepseek-ai/dsh-web-app/lib/index.js`：

```js
/** Model-visible orientation and acceptance boundary for sessions created through `dsh web`. */
function webSurfacePrompt(webUrl) {                        // :97
	return `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. ...`;
}

/** Resolve the canonical loopback URL from the active Web server. */
function localWebUrl(ctx) {                                // :101
	const port = ctx.get("webServer")?.port;               // ← 本实例端口
	if (port === void 0) throw new Error("web-app: webServer service missing while resolving Web runtime");
	return `http://${LOOPBACK_HOST}:${String(port)}`;
}

// :177-192 —— 三个消费点
if (config.surfaceContext) {
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.systemPrompt.section({
			name: "app:web-surface",
			order: -98,
			text: () => webSurfacePrompt(localWebUrl(promptCtx))   // ← ★ 进入 system prompt
		});
	});
	ctx.inject(["shellEnv"], (runtimeCtx) => {
		runtimeCtx.shellEnv.register({
			name: "web-runtime",
			variables: { [DSH_WEB_URL]: { ... } },
			resolve: () => ({ [DSH_WEB_URL]: localWebUrl(runtimeCtx) })   // 环境变量
		});
	});
}
```

**`localWebUrl` 只有 3 个调用点**，都指向"用户/模型应该访问哪个 URL"，因此把它统一成**前门地址**在语义上也是**更正确**的。

---

## 4. 影响面

| 场景 | 是否触发 | 说明 |
|---|---|---|
| **蓝绿换代**（`?cmd=handover`） | ✅ 必然 | 会话从旧 gen 迁到新 gen，端口必变 |
| **会话 resume / attach** | ✅ 常见 | 换实例即变 |
| **switchboard 重启后重新派生** | ✅ | gen 端口按 `GEN_PORT_BASE` 递增分配 |
| 单实例连续对话 | ❌ | 端口不变，无影响 |

**代价量级**：每次迁移 ≈ 一次全量 prompt 重算。
`28f50f57`：13 次迁移 × 约 4~23 万 token → 是它整体命中率只有 90.09% 的重要原因之一。

---

## 5. 修复（已实施）

### 5.1 代码补丁

`scripts/patch-web-app-public-url.mjs`（幂等字符串替换，与项目既有 `patch-goal-round-driver.mjs` 同模式）：

```js
function localWebUrl(ctx) {
	const override = process.env.DSH_PUBLIC_WEB_URL;
	if (typeof override === "string" && override.trim() !== "") return override.trim();
	const port = ctx.get("webServer")?.port;
	...
}
```

- 已应用到 `dsh-brain/node_modules/@deepseek-ai/dsh-web-app/lib/index.js`
- `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-app` 是**指向该文件的符号链接**，因此一处修改全局生效
- 已加入 `package.json` 的 `postinstall`：`patch-package && node scripts/patch-web-app-public-url.mjs`
  （`npm install` 后会自动重新应用）

### 5.2 环境变量注入

在**两个**启动器里都加了：

| 启动器 | 位置 |
|---|---|
| `C:\Users\Admin\AppData\Local\Temp\start-switchboard-ascii.ps1` | `$env:DSH_PUBLIC_WEB_URL = ('http://' + $env:SWITCH_ADDR)` |
| `scripts/relaunch-switchboard.mjs` | `DSH_PUBLIC_WEB_URL: 'http://127.0.0.1:3080'` |

gen 通过 `spawnGen` 的 `{...process.env}` **继承**该变量，因此**无需在 gen 侧单独配置**。

最终值：`http://127.0.0.1:3080`（前门）

### 5.3 回滚

删掉 `DSH_PUBLIC_WEB_URL` 环境变量即回到原行为；补丁本身在未设置变量时逻辑不变（纯 fallback）。

---

## 6. 验证方法

重启 switchboard 并换代后，新会话应表现为：

1. **所有 `request/header` 的 GUI 端口都是 3080**（用 `scripts/probe-gen-port.mjs` 检查）
2. **换代/迁移后不再出现 0% 骤降**（用 `--snapshot` + `--compare` 对比）
3. 预期：**受损轮数下降、稳态命中率上升**

```powershell
cd D:\project_develop\dsh-brain
$N = ".tools\node\node.exe"
# 换代后取新快照并与基线对比
& $N scripts/measure-context-efficiency.mjs --snapshot after-genurl-fix
& $N scripts/measure-context-efficiency.mjs --compare baseline-128k --to after-genurl-fix
# 检查端口是否已统一
& $N scripts/probe-gen-port.mjs "--D-project_develop-dsh-brain--/session-<新会话id>"
```

---

## 7. 遗留问题（**尚未查清，优先级 P1**）

同一个 `request/header` 序列里还存在**第二种形态差异**，与端口独立：

| 形态指纹 (sysLen \| tools) | 出现的端口 | 含义（推测） |
|---|---|---|
| `6449 \| 94~96` | 3082 / 3084 / 3087 / 3089 | 完整工具集（含 design-canvas MCP 的 25 个工具） |
| `1783 \| 70` | 3083 / 3086 / 3088 | **system 短 4666 字符、少 25 个工具** |

**推测**：不同 gen 实例加载了**不同的插件/preset 集**（例如"实验脑"用精简内核）。
若成立，则会话迁移到不同配置的实例时，**即使端口修好，前缀仍会失效**。

**待查**：
1. switchboard 派生 gen 时是否对不同实例使用不同 profile / preset / 内核目录
2. `1783` 与 `6449` 的 system 差异具体是哪一段（diff 两种 system 的文本）
3. 25 个缺失工具的确切名单（`scripts/dump-header-shapes.mjs` 会输出集合差）

**在查清之前，端口修复只能覆盖一部分迁移场景。**
