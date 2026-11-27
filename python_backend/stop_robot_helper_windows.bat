@echo off
setlocal EnableDelayedExpansion
title Robowski Helper - Stop

REM ============================================================================
REM Double-click to cleanly stop the Robowski Status Helper running in the
REM background. This ONLY stops robot_pc_agent.py and never touches main.py.
REM ============================================================================

set "SCRIPT_DIR=%~dp0"
set "PID_FILE=%SCRIPT_DIR%robot_helper.pid"
set "STOP_FLAG=%SCRIPT_DIR%stop_helper.flag"
set "WAS_RUNNING=0"

REM --- Check if the helper is currently running ---
if exist "%PID_FILE%" (
    set /p HELPER_PID=<"%PID_FILE%"
    if not "!HELPER_PID!"=="" (
        tasklist /FI "PID eq !HELPER_PID!" 2>nul | findstr /R /C:" !HELPER_PID! " >nul
        if !ERRORLEVEL!==0 set "WAS_RUNNING=1"
    )
)

for /f %%C in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*robot_pc_agent.py*' } | Measure-Object).Count" 2^>nul') do (
    if %%C GTR 0 set "WAS_RUNNING=1"
)

if "!WAS_RUNNING!"=="0" (
    if exist "%PID_FILE%" del /f /q "%PID_FILE%" >nul 2>nul
    if exist "%STOP_FLAG%" del /f /q "%STOP_FLAG%" >nul 2>nul
    echo.
    echo ======================================================
    echo   Robowski Helper is already stopped ^(not running^).
    echo ======================================================
    echo.
    echo ^(This confirmation window will close in 3 seconds...^)
    timeout /t 3 >nul
    exit /b 0
)

echo Stopping Robowski Helper cleanly...

REM 1. Ask the helper politely to release any open USB ports and exit
echo stop > "%STOP_FLAG%"
timeout /t 2 /nobreak >nul

REM 2. If the PID is still alive, stop only that process
if exist "%PID_FILE%" (
    set /p HELPER_PID=<"%PID_FILE%"
    if not "!HELPER_PID!"=="" (
        taskkill /F /PID !HELPER_PID! >nul 2>nul
    )
    del /f /q "%PID_FILE%" >nul 2>nul
)

REM 3. Stop any remaining process specifically running robot_pc_agent.py
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*robot_pc_agent.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

if exist "%STOP_FLAG%" del /f /q "%STOP_FLAG%" >nul 2>nul

REM --- Verify it actually stopped ---
set "STILL_RUNNING=0"
for /f %%C in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*robot_pc_agent.py*' } | Measure-Object).Count" 2^>nul') do (
    if %%C GTR 0 set "STILL_RUNNING=1"
)

if "!STILL_RUNNING!"=="0" (
    echo.
    echo ======================================================
    echo   OK! Robowski Helper stopped cleanly without errors.
    echo ======================================================
    echo.
    echo ^(This confirmation window will close in 3 seconds...^)
    timeout /t 3 >nul
    exit /b 0
)

echo.
echo ======================================================
echo   ERROR: Could not stop Robowski Helper automatically.
echo   Try right-clicking stop_robot_helper_windows.bat and
echo   choosing "Run as administrator", or end pythonw.exe
echo   in Task Manager.
echo ======================================================
echo.
pause
exit /b 1
