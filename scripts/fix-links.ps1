# 修复 @dsh-brain / @deepseek-ai 在 web profile 里的 junction link（pnpm 在 Windows 上会拼坏目标路径）。
# 统一入口：任何 profile 装包/换目录后跑一次，保证解析视角稳定。
$pairs = @(
  # @dsh-brain（开发包，junction 直指源码 packages 目录）
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\conveyor-context'; target='D:\project_develop\dsh-brain\packages\conveyor-context' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\key-pool-proxy';  target='D:\project_develop\dsh-brain\packages\key-pool-proxy' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\design-canvas-bridge'; target='D:\project_develop\dsh-brain\packages\design-canvas-bridge' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\switchboard'; target='D:\project_develop\dsh-brain\packages\switchboard' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\tool-evolution'; target='D:\project_develop\dsh-brain\packages\tool-evolution' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\subagent-council'; target='D:\project_develop\dsh-brain\packages\subagent-council' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\capability-bridge'; target='D:\project_develop\dsh-brain\packages\capability-bridge' },
  # @deepseek-ai/dsh-base（原生工具来源）：hoist 在共享根，本 profile 显式 junction 钉住，摆脱对 hoist 布局的隐式依赖
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-base'; target='C:\Users\Admin\.dsh\profiles\node_modules\@deepseek-ai\dsh-base' }
)
foreach ($p in $pairs) {
  $link=$p.link; $target=$p.target
  if(-not (Test-Path $target)){
    Write-Output ((Split-Path $link -Leaf)+" SKIP target-missing: $target")
    continue
  }
  $ok=(Test-Path $link) -and (Test-Path (Join-Path $link 'package.json')) -and (Test-Path (Join-Path $link 'lib\index.js'))
  if(-not $ok){
    Remove-Item -LiteralPath $link -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
    if(-not (Test-Path $link)){ New-Item -ItemType Junction -Path $link -Target $target | Out-Null }
  }
  Write-Output ((Split-Path $link -Leaf)+" lib="+(Test-Path (Join-Path $link 'lib\index.js')))
}