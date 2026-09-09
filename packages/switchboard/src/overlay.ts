/**
 * @module @dsh-brain/switchboard/overlay
 *
 * 为每个代生成独立的 cordis patch overlay（`--patch` 传给 `dsh web`），
 * 使同一 web profile 能起多个并存 gen，互不冲突。
 *
 * 端口经 CLI `--port` 注入；handover-agent 参数走 env（`HANDOVER_*`）；
 * session-projection-cache 不覆盖——保留 profile 默认（共享目录），
 * 保证 handover-agent 的 preseed 能读到跨代共享的已落盘投影。
 * 只钉 per-gen 必隔离的配置：session-query-sqlite（避免跨进程 sqlite 锁）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface OverlayParams {
  /** per-gen sqlite 查询索引路径（避免跨进程锁）。 */
  querySqlitePath: string
}

export function renderOverlayYaml(p: OverlayParams): string {
  return [
    '# generated per-gen overlay by switchboard',
    '- set:',
    '    - id: session-query-sqlite',
    `      config: { path: ${JSON.stringify(p.querySqlitePath)}, openAt: never }`,
    '',
  ].join('\n')
}

export function writeOverlay(dir: string, p: OverlayParams): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'gen-overlay.yml')
  writeFileSync(file, renderOverlayYaml(p), 'utf8')
  return file
}