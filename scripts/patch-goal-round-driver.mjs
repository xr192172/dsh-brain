// patch goal-round-driver: event.data.reason 可能为 undefined → 可选链保护
// 交接/中断边界态下 turn/end 的 data.reason 缺失时，原代码 `event.data.reason.kind` 抛
// "Cannot read properties of undefined (reading 'kind')"，被 web 前端包装为"本轮运行失败"。
//
// ★ 2026-09-15：改用严格锚点应用器。旧版用 split/join 替换后只**打印计数** ——
//   上游若已加 `?.`、或改了字段名，计数为 0 也照样"成功"退出，等于静默失效。
//   现在锚点两态都不在 ⇒ 非 0 退出（`DSH_PATCH_STRICT=0` 可降级）。
import { applyAnchors, reportAndExit } from './patch-anchors.mjs'

const paths = [
  'D:/project_develop/dsh-brain/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js',
  'C:/Users/Admin/.dsh/profiles/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js',
]

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
