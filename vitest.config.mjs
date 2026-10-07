import { defineConfig } from 'vitest/config'

// 起步阶段先**只收 `tests/**`**：仓库里还有 `packages/*/test/` 的历史脚本，
// 一股脑纳入会让"第一次跑测试"直接是一片红。**先让它绿起来、再逐步扩大**。
// （2026-10-07：本次只迁移了「未声明依赖」这一条 —— 原先它是 scripts/ 下手搓的门。）
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
