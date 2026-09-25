@echo off
rem ============================================================================
rem  dsh-up.cmd -- DSH one-click launcher (double-click this file).
rem
rem  ★ Why it exists (user, 2026-09-25):
rem    "Can we unify the launch into something like a desktop app -- click the
rem     icon and the backend just starts? I don't ask you to package it as
rem     Electron (too heavy), but at least make it ONE simple trigger.
rem     All this parameter fiddling, and it differs every time -- it makes us
rem     look very disorganized."
rem  ⇒ So: ONE entry (scripts/arm-up.mjs), this file is only its skin:
rem    no parameters required, and "started" means "self-check all green".
rem
rem  ★ ASCII-only on purpose: cmd/Task Scheduler choke on non-ASCII code pages
rem    (same reason as scripts/relaunch-switchboard.cmd).
rem
rem  Usage:
rem    double-click            -> start the LIVE instance (3080) and open the UI
rem    dsh-up.cmd A            -> start training-ground A (its own port segment)
rem  Desktop icon:
rem    copy this file to your Desktop, or run
rem    `node scripts\install-desktop-icon.mjs --yes`
rem ============================================================================
chcp 65001 >nul
setlocal
rem ---------------------------------------------------------------------------
rem  ★★ 2026-09-25 修（**双击桌面那份才暴露的 bug**）：原来写 `cd /d "%~dp0.."`，
rem     而 `%~dp0` 是"**这个 .cmd 自己所在的目录**" ⇒ 本文件在 scripts\ 里时 `..` = 仓库根 ✓
rem     但**拷到桌面**后 `..` = `C:\Users\Admin\` ⇒ 去找 `C:\Users\Admin\scripts\arm-up.mjs` ✗
rem  ⇒ 正解：留一个**标记行**，由 `install-desktop-icon.mjs` 把**绝对仓库路径**写进桌面那份。
rem ---------------------------------------------------------------------------
set "DSH_REPO_OVERRIDE="
if not "%DSH_REPO_OVERRIDE%"=="" (
  set "REPO=%DSH_REPO_OVERRIDE%"
) else (
  set "REPO=%~dp0.."
)
if not exist "%REPO%\scripts\arm-up.mjs" (
  echo [dsh-up] ERROR: cannot find scripts\arm-up.mjs under "%REPO%".
  echo          If you copied this file elsewhere, re-run
  echo          "node scripts\install-desktop-icon.mjs --yes" from the repo
  echo          so the absolute repo path gets stamped into the copy.
  echo.
  pause
  exit /b 2
)
cd /d "%REPO%"

if "%~1"=="" (
  echo [dsh-up] starting LIVE instance ^(3080^) ...
  node scripts\arm-up.mjs --live --open
) else (
  echo [dsh-up] starting training ground "%~1" ...
  node scripts\arm-up.mjs %~1 --open
)
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo [dsh-up] FAILED ^(exit=%RC%^). The lines marked with [x] above are the reason.
  echo          The boot.log path is printed above too.
  echo          Fix it, then double-click this file again.
  echo.
  pause
)
endlocal
