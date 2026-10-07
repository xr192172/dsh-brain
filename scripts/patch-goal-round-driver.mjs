// patch goal-round-driver: event.data.reason 可能为 undefined → 可选链保护
// 交接/中断边界态下 turn/end 的 data.reason 缺失时，原代码 `event.data.reason.kind` 抛
// "Cannot read properties of undefined (reading 'kind')"，被 web 前端包装为"本轮运行失败"。
//
// ★ 2026-09-15：改用严格锚点应用器。旧版用 split/join 替换后只**打印计数** ——
//   上游若已加 `?.`、或改了字段名，计数为 0 也照样"成功"退出，等于静默失效。
//   现在锚点两态都不在 ⇒ 非 0 退出（`DSH_PATCH_STRICT=0` 可降级）。
import { applyAnchors, reportAndExit, resolveEntities } from './patch-anchors.mjs'

// ★ 2026-10-07：改用**寻址**（`resolveEntities`）而非硬编码顶层路径 ——
//   pnpm 换成链接模式后，实体只在 `.pnpm/` 里，顶层 `node_modules/@deepseek-ai/<包>/…` **不存在**
//   ⇒ 旧写法会让整脚本走"该包未安装？跳过"⇒ **静默空转**（实测：升级后 5 个脚本全部如此）。
//   ★ 只面向新版布局（按用户裁定 2026-10-07：旧版兼容性不考虑）。
const paths = resolveEntities('@deepseek-ai/dsh-goal-round-driver')

// 该处有**两处**出现 ⇒ all: true（替换全部）。
const EDITS = [
  {
    id: 'reason-optional-chain',
    all: true,
    anchor: 'event.data.reason.kind',
    replace: 'event.data.reason?.kind',
    done: 'event.data.reason?.kind',
  },
]

reportAndExit('patch-goal-round-driver', paths.map((p) => applyAnchors(p, EDITS)))
