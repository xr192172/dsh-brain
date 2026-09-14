<#
================================================================================
 cleanup-redundant-workspaces.ps1
 清理「重复工作区」—— 前提：唯一资产已于 2026-09-14 归档完毕。

 ★ 本文件必须带 UTF-8 BOM（PowerShell 5.1 读无 BOM 的 UTF-8 .ps1 会按 GBK 解码 → 语法错）。

 ────────────────────────────────────────────────────────────────────────────
 先看归档去哪了（删除前请确认这些都在）
   D:\project_develop\_from-downloads\20260914\      747 文件 / 46.9 MB
     .agents\skills\archify\   第三方 MIT 技能 v2.17（作者 tt-a1i，基于
                               Cocoon-AI/architecture-diagram-generator）
                               192 文件 / 6.93 MB —— SKILL.md + bin\archify.mjs
                               + 4 类渲染器 + 12 份 references + 5 示例
     output\                   该技能的产物（20 个 ~700KB 交互式 HTML）13.38 MB
     workspace-data\           克隆内 .design-canvas 的【成果类】数据 25.82 MB
                               （features / bricks / mindmap / live / projects /
                                 overview / baseline + 4 个 json）
     .trae\documents\          8 份 design-canvas 设计文档
     shots\ smoke-demo\ frontend-publish\ dogfood\ .dogfood\
     _patches\                 dsl-workbench-orphan.patch (60 KB)
                               + src/data/api.ts (7.2 KB)
   D:\project_develop\weavepet\                      11 文件（织宠世界源码 + 2 份文档）

 ────────────────────────────────────────────────────────────────────────────
 本脚本将清理（合计约 799 MB / 22204 文件）
   ①  C:\Users\Admin\Downloads\Browsers\Microsoft Edge\design-canvas-main  712 MB
       为什么可删：唯一资产已归档；dsl-workbench 远端有存档；
                   内层 design-canvas 克隆与真身同 commit（1d19e23）且远端有；
                   其余 cache.db(64.8MB) / import_cache_*.db(42.5MB) / cache\ 均为可重建物。
   ②  D:\project_develop\dsh-brain\design-canvas-dev                        17 MB
       为什么可删：无 .git（改了无法提交）；源码 mtime 停在 09-10（真身 09-12）；
                   node_modules 是指向 ① 的 Junction（脚本会先解链）。
   ③  D:\project_develop\dsl-workbench                                      70 MB
       为什么可删：【已逐项验证，非推测】
         · 其 HEAD ecff3bf 经 `git merge-base --is-ancestor` 确认是 origin/main 的祖先
           → 提交历史 100% 已在远端；
         · `git rev-list --count origin/main..ecff3bf` = 0 → 【没有本地独有提交】；
         · `git rev-list --count ecff3bf..origin/main` = 32 → 远端领先它 32 个提交；
         · 674 行未提交改动 + src/data/api.ts 已存为 patch（见上）。
       [!] 关键：它【无任何 remote】→ 自己检测不出"已经过期"。
           留一个"无 remote + 落后 32 提交"的目录，只会变成下一个维护地狱。
           **将来若要继续做这个项目，请从远端重新 clone（见文末），不要留着这份旧副本。**

 [!]  默认进【回收站】（可还原），不是硬删。要硬删需显式 -HardDelete。
 [!]  ② 的 node_modules 是 Junction —— 脚本会先删链接并【验证目标仍在】，防止连带删到别处。

 用法
   .\cleanup-redundant-workspaces.ps1 -DryRun     # 只看计划
   .\cleanup-redundant-workspaces.ps1             # 进回收站（推荐）
   .\cleanup-redundant-workspaces.ps1 -HardDelete # 永久删除（不可恢复）
================================================================================
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$HardDelete,
  [switch]$Yes,
  [string]$ArchiveRoot = 'D:\project_develop\_from-downloads\20260914'
)

$ErrorActionPreference = 'Stop'

$T1 = 'C:\Users\Admin\Downloads\Browsers\Microsoft Edge\design-canvas-main'
$T2 = 'D:\project_develop\dsh-brain\design-canvas-dev'
$T3 = 'D:\project_develop\dsl-workbench'
$WP = 'D:\project_develop\weavepet'
$K1 = 'D:\project_develop\design-canvas'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Ok([string]$m) { Write-Host $m -ForegroundColor Green }
function Confirm-Or-Exit([string]$q) {
  if ($Yes) { Say "  (-Yes) 自动确认：$q"; return }
  $a = Read-Host "  $q [y/N]"
  if ($a -notmatch '^(y|Y|yes|YES)$') { Warn '  已取消。'; exit 1 }
}
function SizeOf([string]$p) {
  $f = Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue
  return @{ n = $f.Count; mb = [math]::Round((($f | Measure-Object Length -Sum).Sum / 1MB), 1) }
}

Say '╔════════════════════════════════════════════════════════════════════╗'
Say '║  清理重复工作区（归档已完成，默认进回收站）                        ║'
Say '╚════════════════════════════════════════════════════════════════════╝'
if ($DryRun) { Warn '模式：-DryRun（只打印计划）' }
if ($HardDelete) { Warn '模式：-HardDelete（永久删除，不可恢复！）' } else { Say '模式：回收站（可还原）' }

# ══════════════ Step 0 前置校验：归档必须到位 ══════════════
Step 'Step 0  前置校验（归档是否完整）'
$blocked = $false

if (-not (Test-Path -LiteralPath $ArchiveRoot)) { Warn "  [X] 归档不存在：$ArchiveRoot"; $blocked = $true }
else {
  $a = SizeOf $ArchiveRoot
  $okCount = $a.n -ge 700
  Say  ("  归档：{0}  →  {1} 文件 / {2} MB" -f $ArchiveRoot, $a.n, $a.mb) $(if ($okCount) { 'Green' } else { 'Red' })
  if (-not $okCount) { Warn '  [X] 归档文件数 < 700，疑似不完整，中止。'; $blocked = $true }

  foreach ($rel in @(
    '.agents\skills\archify\SKILL.md',
    'output',
    'workspace-data\features',
    '.trae\documents',
    '_patches\dsl-workbench-orphan.patch'
  )) {
    $p = Join-Path $ArchiveRoot $rel
    if (Test-Path -LiteralPath $p) { Say ("  [OK] {0}" -f $rel) 'Green' } else { Warn ("  [X] 缺失：{0}" -f $rel); $blocked = $true }
  }
}

# 织宠世界单独校验
if (Test-Path -LiteralPath $WP) { Say ("  [OK] weavepet 源码：{0}" -f $WP) 'Green' }
else { Warn ("  [!] 未找到 {0}（若你不要它，可忽略）" -f $WP) }

# 真身健康
if (Test-Path -LiteralPath "$K1\.git") {
  Push-Location -LiteralPath $K1
  try {
    $h = (& git rev-parse --short HEAD 2>&1) -join ''
    Say ("  [OK] 真身 design-canvas HEAD = {0}" -f $h) 'Green'
  } finally { Pop-Location }
} else { Warn "  [X] 真身不存在：$K1"; $blocked = $true }

if ($blocked) { Warn '[X] 前置校验未通过，中止（不会删除任何东西）。'; exit 1 }

# ══════════════ Step 1 列出将清理的目标 ══════════════
Step 'Step 1  将清理'
$targets = @(
  @{ n = '① #3 工作区（Downloads）'; p = $T1; why = '唯一资产已归档；其余为可重建物' },
  @{ n = '② design-canvas-dev';       p = $T2; why = '无 git、源码过期、node_modules 是 Junction' },
  @{ n = '③ dsl-workbench（D盘）';    p = $T3; why = 'HEAD 已确认是 origin/main 祖先、无本地独有提交（远端领先 32）；无 remote 故无法自证新鲜度' }
)
$totalMb = 0.0; $totalN = 0
foreach ($t in $targets) {
  if (Test-Path -LiteralPath $t.p) {
    $s = SizeOf $t.p
    $totalMb += $s.mb; $totalN += $s.n
    Say ("  {0,-30} {1,8:N0} MB  {2,6} 文件" -f $t.n, $s.mb, $s.n) 'White'
    Say ("  {0,-30} 依据：{1}" -f '', $t.why) 'DarkGray'
  } else { Say ("  {0,-30} （不存在，跳过）" -f $t.n) 'DarkGray' }
}
Warn ''
Warn ("[!]  合计将清理约 {0:N0} MB / {1} 个文件" -f $totalMb, $totalN)
Warn '[!]  此操作非常危险，可能导致不可逆的数据丢失！（默认进回收站可还原；-HardDelete 则不可恢复）'

if ($DryRun) { Ok "`n[DryRun] 结束，未执行任何删除。"; exit 0 }
Confirm-Or-Exit '确认按上述清单清理？'

# ══════════════ Step 2 先解 junction（② 的 node_modules）══════════════
Step 'Step 2  安全解链（② 的 node_modules Junction）'
$nm2 = Join-Path $T2 'node_modules'
if (Test-Path -LiteralPath $nm2) {
  $it = Get-Item -LiteralPath $nm2 -Force
  if ($it.LinkType) {
    $tgt = ($it.Target -join '')
    Say ("  发现 Junction → {0}" -f $tgt)
    Remove-Item -LiteralPath $nm2 -Force
    if (Test-Path -LiteralPath $nm2) { throw "junction 未删除：$nm2" }
    $alive = Test-Path -LiteralPath $tgt
    Ok ("  [OK] 链接已删；目标仍存在={0}（应为 True）" -f $alive)
    if (-not $alive) { Warn '  [X] 目标被连带删除！立即停止。'; exit 1 }
  } else { Say '  （不是链接，跳过）' 'DarkGray' }
} else { Say '  （无 node_modules，跳过）' 'DarkGray' }

# ══════════════ Step 3 删除 ══════════════
Step 'Step 3  执行清理'
Add-Type -AssemblyName Microsoft.VisualBasic

foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t.p)) { Say ("  跳过（不存在）：{0}" -f $t.n) 'DarkGray'; continue }
  try {
    if ($HardDelete) {
      Remove-Item -LiteralPath $t.p -Recurse -Force
      Ok ("  [OK] 已永久删除：{0}" -f $t.p)
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $t.p,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
      )
      Ok ("  [OK] 已移入回收站：{0}" -f $t.p)
    }
  } catch {
    Warn ("  [X] 失败：{0}`n      {1}" -f $t.p, $_.Exception.Message)
  }
}

Step '完成'
if ($HardDelete) { Warn '已永久删除。若发现误删，只能从备份恢复。' }
else { Say '已进回收站（可还原）。确认一段时间无异常后，再清空回收站即可。' }
Say ''
Say '随后请确认：'
Say '  1) node D:\project_develop\design-canvas\dist\src\server.js   （DSH 侧仍能拉起）'
Say '  2) 换代/重启后 mcp__design-canvas__* 工具仍在（58 个）'
Say '  3) 归档在 D:\project_develop\_from-downloads\20260914\ 可正常浏览'
Say ''
Say '若将来要继续做 dsl-workbench（远端是唯一来源，本地不保留旧副本）：'
Say '    cd D:\project_develop'
Say '    git clone https://github.com/xr192172/dsl-workbench.git'
Say '    # 如需找回旧的未提交改动：git apply _from-downloads\20260914\_patches\dsl-workbench-orphan.patch'
Say '若将来要继续做织宠世界：源码已在 D:\project_develop\weavepet\（无需恢复）'
