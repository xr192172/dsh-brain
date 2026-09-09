# 启动脑代际蓝绿交接控制面（Switchboard）—— 取代直接 `dsh web`。
# 前门 3080 由 switchboard 占；每个 gen 用 GEN_PORT_BASE(3081) 起的独立端口，
# switchboard 负责 spawn/交接/翻转/退役。
#
# v2 改进：
#  1. 入口从 lib/main.js 改为 bin.cjs —— 版本化 junction 构建下，`node lib/main.js`
#     （lib 是 junction -> out/<buildId>）argv[1] 与 import.meta.url 的 realpath 不一致，
#     `isMain` 守卫不满足会静默退出；bin.cjs 会 spawn 最新 out/<buildId>/main.js 作为真正入口。
#  2. 路径从 $PSScriptRoot 推导项目根，不再硬编码，避免不同执行环境导致的路径为 null 问题。

$root = Split-Path $PSScriptRoot -Parent          # scripts\ -> 项目根
# 兜底：某些执行环境（后台/非文件调用）下 $PSScriptRoot 为空，退到已知绝对根。
if (-not $root) { $root = 'D:\project_develop\dsh-brain' }
$nodeDir = Join-Path $root '.tools\node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$env:PATH = ($nodeDir + ';' + $env:PATH)

# 前置校验：node 不在则直接报错退出（避免"看起来起了但立刻退"的假象）。
if (-not (Test-Path $nodeExe)) {
  Write-Error "node not found: $nodeExe (expected $root\.tools\node)"
  exit 1
}

# 读 AGNES key 池（主 key + 列表），打包成 GEN_ENV_EXTRA 透传给每个 gen
$envFile = 'D:\project_develop\ai-base\agent-shell\.env'
$extra = @{}
if (Test-Path $envFile) {
  foreach ($ln in Get-Content $envFile) {
    $t = $ln.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    if ($t -like 'AGENTSHELL_MAIN_LLM_API_KEY=*')  { $extra['AGENTSHELL_MAIN_LLM_API_KEY']  = $t.Substring('AGENTSHELL_MAIN_LLM_API_KEY='.Length) }
    if ($t -like 'AGENTSHELL_MAIN_LLM_API_KEYS=*') { $extra['AGENTSHELL_MAIN_LLM_API_KEYS'] = $t.Substring('AGENTSHELL_MAIN_LLM_API_KEYS='.Length) }
  }
} else {
  Write-Warning "keys file missing: $envFile — gens 可能没有 LLM key"
}
$env:GEN_ENV_EXTRA = ($extra | ConvertTo-Json -Compress)

# 确保 @dsh-brain 插件 junction 完好
& (Join-Path $root 'scripts\fix-links.ps1')

# env 合同
$env:NODE_BIN   = $nodeExe
$env:DSH_BIN    = (Join-Path $root 'node_modules\@deepseek-ai\dsh\lib\bin.js')
$env:WEB_PROFILE  = 'web'
$env:SWITCH_ADDR  = '127.0.0.1:3080'
$env:SWITCH_PORT  = '3080'
$env:GEN_PORT_BASE = '3081'
$env:HANDOVER_ADMIN_PORT_BASE = '31810'
$env:SWITCH_ADMIN_PORT = '31800'
$env:DSH_HOME     = 'C:\Users\Admin\.dsh'

# 用 bin.cjs 拉起（spawn 最新 out/<buildId>/main.js，满足 isMain 守卫）
& $nodeExe (Join-Path $root 'packages\switchboard\bin.cjs')
Write-Output 'switchboard exited.'