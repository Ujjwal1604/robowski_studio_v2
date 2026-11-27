@echo off
REM Double-click to start the Robowski Status Helper silently in the background on the Robot PC.
REM You can keep this file and robot_pc_agent.py in ANY folder (e.g. Desktop or a helper folder).
REM
REM Optional: paste the folder where your main.py lives inside the quotes below
REM (for example: set "ROBOWSKI_MAIN_FOLDER=C:\Users\Lab\robowski\zeus-pipetter").
REM Leave it blank to let the helper find main.py automatically on this PC.
set "ROBOWSKI_MAIN_FOLDER="

REM To make it auto-start whenever Windows logs in:
REM   1. Press Win+R, type shell:startup, press Enter.
REM   2. Right-click this file -> Create shortcut, and drop the shortcut into that Startup folder.

set "SCRIPT_DIR=%~dp0"
if not "%ROBOWSKI_MAIN_FOLDER%"=="" set "ROBOWSKI_REPO_PATH=%ROBOWSKI_MAIN_FOLDER%"
where pythonw >nul 2>nul
if %ERRORLEVEL%==0 (
    start "" pythonw "%SCRIPT_DIR%robot_pc_agent.py"
) else (
    start /min "" python "%SCRIPT_DIR%robot_pc_agent.py"
)
