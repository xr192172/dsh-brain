# 压缩引擎（补丁与不变量）

> 上级索引：`../MEMORY.md` ｜ 相关：`prompt-cache.md`
> 排查文档：`docs/findings-compaction-nodes-crash-2026-09-13.md`

## 插件热补丁机制

- 目标包：`node_modules/@deepseek-ai/dsh-compaction-basic`（压缩后端）。
- **junction 全局生效**：`~/.dsh/profiles/node_modules/@deepseek-ai/*`
  → `dsh-brain/node_modules/@deepseek-ai/*`，改后者即对所有 gen 生效
  （**但需重启 gen / 换代才能加载新代码**）。
- 持久化：`npx patch-package <包名>` → `patches/`；`package.json` 有 `postinstall: patch-package`。
- **改完 node_modules 必须立刻重建 patch**，否则 `npm install` 会丢改动。
- **patch-package 必须在 PowerShell 工具里跑**（Bash 工具找不到 `npm`），
  且 PATH 要含 `<root>\.tools\node`；它对这个包可跑。
  但**对 `dsh-web-app` 跑不通** → 改用幂等字符串替换脚本（`scripts/patch-*.mjs` 模式）。
- 已挂 postinstall 的补丁脚本：`patch-web-app-public-url.mjs`、`patch-app-boot-bom.mjs`。

## ★ 压缩后端的不变量（血泪教训）

`compactSurfaceRegion` 把"摘要结果对象"当作 `prepared` 传给稳定性断言，断言读的是：

- `assertWholeSurfaceUnchanged` → **`prepared.measurement.nodes`**
- `assertSelectedSpanStable` → **`prepared.start/end/shadowedSeqs/selectedNodes`**

> **任何"产出 summary 对象"的路径都必须携带这些字段。**

- `summarizeCompaction` 靠 `{...prepared, ...summaryResult}` 自动满足；
- `deterministicFallbackPrune` 是**手工挑字段** → 2026-09-13 就因为漏了 `measurement` 而 **100% 崩溃**
  （`Cannot read properties of undefined (reading 'nodes')`）。
  后果：**兜底路径从头到尾不可用 → surface 永不收缩 → 持续 400**。

**回归守卫**：`scripts/check-compaction-fallback-shape.mjs`
（静态对照"断言读哪些字段" vs "兜底给哪些字段"）。**改这两处后务必跑一次。**

**另一处修复**：兜底路径的稳定性断言从 `assertWholeSurfaceUnchanged` 切到
`assertSelectedSpanStable` —— 确定性裁剪不依赖模型输出，只需自己的区间仍是合法可替换目标；
沿用 whole-surface 会让摘要重试期间的任何尾部新增都作废兜底。区间完整性仍强制。

**诊断埋点**：`dsh-compaction-basic` 的 catch 块会往 `out/compaction-fail.log` 追加
`stage / errorStack / sessionCtor / surfaceType / eventsLen / selection` 等。
（gen 的 stdout 不被 switchboard 日志捕获，`console.error` 是白打 —— 必须自己写文件。）

## 压缩路径的事实（排查用）

- 分块摘要：`_foldChunks`，`chunkTokens = maxTokens*2 ≈ 131K`。
- 阈值：`floor(contextWindow × thresholdRatio)`。
- 摘要调用被构造成"最后一个真实请求的真前缀"以复用 KV cache
  （`dsh-compaction-basic/lib/index.js:231-233` 等三处注释）—— **DSH 原生是 cache-first 设计**。
- `compaction/end` 里的 `error` 会**持久化写进会话** → 拿真实堆栈靠解码会话，不靠日志。
- **DSH 原生压缩有损且不可召回**：`compaction/summary` 带 `shadowedSeqs` 使被压区间退出 surface；
  `tool-result-pruner` 用 `surfaceOp:{op:"replace"}` 直接替换节点；
  官方立场 `FALLBACK_PRUNE_TEXT`：「Earlier facts remain in the session log.」
  —— **但 21 个 `dsh-tool-*` 里没有任何"读回历史"的入口**，日志是多帧 zstd + `packChunkRuns` 内部格式。
  **⇒ 原文技术上在磁盘上，但模型读不到 = 对模型不存在。**

## 会话驱动（免 UI 触发 / 体检）

```bash
node scripts/session-drive.mjs describe          # host.describe
node scripts/session-drive.mjs list              # 会话列表
node scripts/session-drive.mjs cred              # 凭据解析状态（只读）
node scripts/session-drive.mjs credset           # 写凭据库
node scripts/session-drive.mjs prompt <sessionId> "<text>"
```

**wire 协议**：`POST /api/<method>`，信封 `{type:'client-request', rpcId, method, payload}`。
`session.prompt` payload：`{sessionId, mode:'queue'|'steer', content:[{type:'text',text}], clientTimeZone}`。
**坑**：目标 session 必须**已 attach 在当前 gen 上**，否则 `session-not-found`。
