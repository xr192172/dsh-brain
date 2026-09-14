@echo off
rem relaunch-switchboard.cmd - launch the DSH switchboard detached via Task Scheduler.
rem Kept ASCII-only: Task Scheduler + cmd choke on non-ASCII code pages.
set DSH_RELAUNCH_LOG=D:\project_develop\dsh-brain\out\relaunch-cmd.log
"D:\project_develop\dsh-brain\.tools\node\node.exe" "D:\project_develop\dsh-brain\scripts\relaunch-switchboard.mjs" > "%DSH_RELAUNCH_LOG%" 2>&1
