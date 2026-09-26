@echo off
rem ============================================================================
rem  dsh-up.cmd -- DSH one-click launcher (double-click this file).
rem
rem  See scripts/README-dsh-up.md for the full rationale (Chinese).
rem  This file stays PURE ASCII on purpose:
rem    cmd.exe reads and slices this file in the OEM codepage BEFORE the
rem    "chcp 65001" line takes effect, so any non-ASCII byte (a star glyph, an
rem    arrow, a Chinese character) can make it cut a line at the wrong byte and
rem    execute a stray ASCII fragment. Measured 2026-09-26: ~4% of runs
rem    (1 in 25, same path, same args) printed
rem        The system cannot find the path specified.
rem        'll-desktop-icon.mjs' is not recognized ...
rem    Guarded by scripts/check-cmd-lineendings.mjs (criterion B).
rem  Also: every line must end with CRLF (criterion A) -- LF-only lines make
rem  cmd.exe eat the "rem" prefix and run comment words as commands.
rem
rem  Usage:
rem    double-click            -> start the LIVE instance (3080) and open the UI
rem    dsh-up.cmd --stop       -> stop only THIS project's set (switchboard + the
rem                               generations it spawned). Never touches other node.
rem    dsh-up.cmd A            -> start training ground A (its own port segment)
rem
rem  Desktop icon:
rem    copy this file to your Desktop, or run
rem    node scripts\install-desktop-icon.mjs --yes
rem
rem  2026-09-26: added the missing "stop" verb. This machine runs ~16 node
rem  processes; only 6 belong to this project (and that was THREE separate
rem  switchboards). taskkill /IM node.exe would kill other people's work.
rem  So --stop is PATH-scoped (see scripts/arm-stop.mjs) and refuses to act at
rem  all if it cannot read the process list.
rem ============================================================================
chcp 65001 >nul
setlocal
rem ---------------------------------------------------------------------------
rem  2026-09-25 fix: the desktop copy of this file exposed a bug. It used to do
rem  cd /d "%~dp0.." -- but %~dp0 is THIS file's own directory, so from
rem  scripts\ the ".." is the repo root (fine), while from the Desktop the ".."
rem  is C:\Users\Admin and it looked for C:\Users\Admin\scripts\arm-up.mjs.
rem  Fix: keep one marker line, and let install-desktop-icon.mjs stamp the
rem  ABSOLUTE repo path into the desktop copy.
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

if "%~1"=="--stop" (
  echo [dsh-up] stopping THIS project's set ^(switchboard + its generations^) ...
  node scripts\arm-up.mjs --stop
) else if "%~1"=="" (
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
