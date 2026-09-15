// patch-web-app-public-url.mjs —— 让 gen 的 system prompt 报告「前门地址」而非自身实例端口
//
// 【为什么】
// dsh-web-app 的 localWebUrl(ctx) 返回 `http://127.0.0.1:<本实例 webServer.port>`，并经
// webSurfacePrompt() 拼进 **system prompt**。而 switchboard 的蓝绿换代 / 会话迁移会把同一个
// 会话送到不同 gen 实例（各自监听 3082~3089），于是每次迁移 system prompt 字节都变
// → 整个 prompt 前缀失效 → 全量 cache miss（实测首轮命中率 0.0%）。
//
// 实测证据（session-28f50f57，19 次 request/header）：
//   GUI 端口分布 3085/3086/3087/3088/3089/3082×10/3083×3/3084×2 → 8 个不同实例
//   端口变化 13 次，每次变化后**首轮命中率均为 0.0%**，次轮恢复到 97~99%
//
// 【怎么改】
// 优先读环境变量 DSH_PUBLIC_WEB_URL（由启动器注入、被子进程继承）；未设置时保持原行为。
// 用户实际访问的是前门（3080），实例端口只是内部实现细节。
//
// ★ 2026-09-15：改用严格锚点应用器。旧版锚点找不到只打印 ⚠️ 然后继续，
//   而这个脚本挂在 postinstall ⇒ 上游一变，补丁静默失效、无人被告知。
//   现在锚点两态都不在 ⇒ 非 0 退出（`DSH_PATCH_STRICT=0` 可降级）。
import { applyAnchors, reportAndExit } from './patch-anchors.mjs'

const MARKER = 'DSH_PUBLIC_WEB_URL'
const paths = [
  'D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
  'C:/Users/Admin/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
]

const OLD = `function localWebUrl(ctx) {
	const port = ctx.get("webServer")?.port;`

const NEW = `function localWebUrl(ctx) {
	// dsh-brain patch (2026-09-14): prefer the public front-door URL over this instance's port.
	// This value flows into the system prompt via webSurfacePrompt(); if each gen instance
	// writes its own port (3082~3089), every blue/green handover or session migration changes
	// the prompt bytes and invalidates the whole prompt-prefix cache (measured: first request
	// after each migration had a 0.0% cache hit rate).
	const override = process.env.${MARKER};
	if (typeof override === "string" && override.trim() !== "") return override.trim();
	const port = ctx.get("webServer")?.port;`

const EDITS = [
  {
    id: 'public-web-url-override',
    anchor: OLD,
    replace: NEW,
    // 用「真的注入了 override 代码」作判据，比只查 MARKER 字符串更严 ——
    // MARKER 也可能只出现在注释里。
    done: `process.env.${MARKER}`,
  },
]

reportAndExit('patch-web-app-public-url', paths.map((p) => applyAnchors(p, EDITS)))
