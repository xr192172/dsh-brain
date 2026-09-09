# 启动 dsh web（注入 AGNES key 池 + 主 key）
# 注意：启动后不要再跑 `dsh plugin ...`（会弄坏 @dsh-brain 插件的 junction link）
$nodeDir = 'D:\project_develop\dsh-brain\.tools\node'
$env:PATH = ($nodeDir + ';' + $env:PATH)
$envFile = 'D:\project_develop\ai-base\agent-shell\.env'
foreach ($ln in Get-Content $envFile) {
  $t = $ln.Trim()
  if ($t -eq '' -or $t.StartsWith('#')) { continue }
  if ($t -like 'AGENTSHELL_MAIN_LLM_API_KEY=*')  { Set-Item 'env:AGENTSHELL_MAIN_LLM_API_KEY'  -Value $t.Substring('AGENTSHELL_MAIN_LLM_API_KEY='.Length) }
  if ($t -like 'AGENTSHELL_MAIN_LLM_API_KEYS=*') { Set-Item 'env:AGENTSHELL_MAIN_LLM_API_KEYS' -Value $t.Substring('AGENTSHELL_MAIN_LLM_API_KEYS='.Length) }
}
# 先确保插件 junction 完好，再启动
& 'D:\project_develop\dsh-brain\scripts\fix-links.ps1'
$bin = 'D:\project_develop\dsh-brain\node_modules\@deepseek-ai\dsh\lib\bin.js'
& (Join-Path $nodeDir 'node.exe') $bin --profile web
Write-Output 'dsh web exited.'