@echo off
setlocal EnableDelayedExpansion
title Robowski Helper

REM ============================================================================
REM Double-click to start the Robowski Status Helper silently in the background.
REM This window briefly confirms it started without errors, then closes itself.
REM Use stop_robot_helper_windows.bat whenever you want to stop it.
REM
REM 1-time setup files in this same folder:
REM   - server_url.txt  : Your Personal Lab PC URL (e.g. https://your-pc.ts.net)
REM   - relay_token.txt : Shared secret matching relay_token.txt on Personal PC
REM   - robot_pin.txt   : Save your 6+ character PIN on your Personal PC
REM ============================================================================

REM Optional: paste the folder where your main.py lives inside the quotes below
REM (for example: set "ROBOWSKI_MAIN_FOLDER=C:\Users\Lab\robowski\zeus-pipetter").
REM Leave blank to let the helper find main.py automatically on this PC.
set "ROBOWSKI_MAIN_FOLDER="

REM Optional: if you use a specific Conda/venv Python, paste python.exe path here.
REM Leave blank to auto-detect Python automatically.
set "PYTHON_EXE="

set "SCRIPT_DIR=%~dp0"
set "PID_FILE=%SCRIPT_DIR%robot_helper.pid"
set "LOG_FILE=%SCRIPT_DIR%robot_helper.log"
if not "%ROBOWSKI_MAIN_FOLDER%"=="" set "ROBOWSKI_REPO_PATH=%ROBOWSKI_MAIN_FOLDER%"

REM --- Check if the helper is already running ---
if exist "%PID_FILE%" (
    set /p OLD_PID=<"%PID_FILE%"
    if not "!OLD_PID!"=="" (
        tasklist /FI "PID eq !OLD_PID!" 2>nul | findstr /R /C:" !OLD_PID! " >nul
        if !ERRORLEVEL!==0 (
            echo.
            echo ======================================================
            echo   Robowski Helper is ALREADY running in the background!
            echo   (PID !OLD_PID! - use stop_robot_helper_windows.bat to stop)
            echo ======================================================
            timeout /t 3 >nul
            exit /b 0
        )
    )
    del /f /q "%PID_FILE%" >nul 2>nul
)

REM --- Auto-detect a real working Python (skipping Windows Store stubs) ---
if not "%PYTHON_EXE%"=="" goto :launch_helper

for /f "delims=" %%P in ('where python 2^>nul') do (
    echo %%P | findstr /I "WindowsApps" >nul
    if errorlevel 1 (
        if "!PYTHON_EXE!"=="" set "PYTHON_EXE=%%P"
    )
)

if "!PYTHON_EXE!"=="" (
    for %%C in (
        "%USERPROFILE%\anaconda3\python.exe"
        "%USERPROFILE%\miniconda3\python.exe"
        "%USERPROFILE%\AppData\Local\Continuum\anaconda3\python.exe"
        "C:\ProgramData\Anaconda3\python.exe"
        "C:\ProgramData\miniconda3\python.exe"
        "C:\Anaconda3\python.exe"
        "C:\Python312\python.exe"
        "C:\Python311\python.exe"
        "C:\Python310\python.exe"
        "C:\Python39\python.exe"
    ) do (
        if "!PYTHON_EXE!"=="" if exist %%~C set "PYTHON_EXE=%%~C"
    )
)

if "!PYTHON_EXE!"=="" (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if "!PYTHON_EXE!"=="" if exist "%%D\python.exe" set "PYTHON_EXE=%%D\python.exe"
    )
)

if "!PYTHON_EXE!"=="" (
    where py >nul 2>nul
    if !ERRORLEVEL!==0 (
        for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do (
            if "!PYTHON_EXE!"=="" set "PYTHON_EXE=%%P"
        )
    )
)

:launch_helper
if "%PYTHON_EXE%"=="" (
    echo.
    echo [ERROR] Could not find Python automatically on this PC.
    echo Right-click start_robot_helper_windows.bat ^> Edit, and paste your
    echo python.exe path into PYTHON_EXE= at the top of the file.
    echo.
    pause
    exit /b 1
)

REM Prefer pythonw.exe right next to python.exe so it stays 100%% invisible
set "LAUNCH_EXE=%PYTHON_EXE%"
for %%F in ("%PYTHON_EXE%") do (
    if exist "%%~dpFpythonw.exe" set "LAUNCH_EXE=%%~dpFpythonw.exe"
)

set "AGENT_SCRIPT=%SCRIPT_DIR%robot_pc_agent.py"
if exist "%LOG_FILE%" del /f /q "%LOG_FILE%" >nul 2>nul

echo Starting Robowski Helper in the background...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:LAUNCH_EXE -ArgumentList @($env:AGENT_SCRIPT, '--background') -WindowStyle Hidden"

REM Wait briefly and verify the helper actually started and stayed alive
set "STARTED_PID="
for /L %%I in (1,1,6) do (
    if "!STARTED_PID!"=="" (
        timeout /t 1 /nobreak >nul
        if exist "%PID_FILE%" (
            set /p STARTED_PID=<"%PID_FILE%"
        )
    )
)

if not "%STARTED_PID%"=="" (
    tasklist /FI "PID eq %STARTED_PID%" 2>nul | findstr /R /C:" %STARTED_PID% " >nul
    if !ERRORLEVEL!==0 (
        echo.
        echo ======================================================
        echo   OK! Robowski Helper started without errors.
        echo   It is now running invisibly in the background.
        echo   Use stop_robot_helper_windows.bat anytime to stop.
        echo ======================================================
        echo.
        echo (This confirmation window will close in 3 seconds...)
        timeout /t 3 >nul
        exit /b 0
    )
)

echo.
echo ======================================================
echo   ERROR: Robowski Helper could not start!
echo ======================================================
if exist "%LOG_FILE%" (
    echo.
    type "%LOG_FILE%"
) else (
    echo Tried running: "%LAUNCH_EXE%" "%SCRIPT_DIR%robot_pc_agent.py"
    echo Please check that Python is installed and robot_pc_agent.py is in the same folder.
)
echo.
pause
exit /b 1
