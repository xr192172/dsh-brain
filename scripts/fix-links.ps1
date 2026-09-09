# 修复 @dsh-brain 插件在 web profile 里的 junction link（pnpm 在 Windows 上会拼坏目标路径）
$pairs = @(
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\conveyor-context'; target='D:\project_develop\dsh-brain\packages\conveyor-context' },
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\key-pool-proxy';  target='D:\project_develop\dsh-brain\packages\key-pool-proxy' }
  @{ link='C:\Users\Admin\.dsh\profiles\web\node_modules\@dsh-brain\handover-agent';  target='D:\project_develop\dsh-brain\packages\handover-agent' }
)
foreach ($p in $pairs) {
  $link=$p.link; $target=$p.target
  $ok=(Test-Path $link) -and (Test-Path (Join-Path $link 'package.json')) -and (Test-Path (Join-Path $link 'lib\index.js'))
  if(-not $ok){
    Remove-Item -LiteralPath $link -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
    if(-not (Test-Path $link)){ New-Item -ItemType Junction -Path $link -Target $target | Out-Null }
  }
  Write-Output ((Split-Path $link -Leaf)+" lib="+(Test-Path (Join-Path $link 'lib\index.js')))
}
