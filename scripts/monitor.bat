@echo off
setlocal

:: Check if required arguments are provided
if "%~1"=="" (
    echo Error: No PID provided.

    exit /B 1
)

if "%~2"=="" (
    echo Error: No process name provided.

    exit /B 1
)

:: Set the target PID and process name from command-line arguments
set "TARGET_PID=%~1"
set "PROCESS_NAME_TO_KILL=%~2"

:loop
:: Check if the parentProcess with the target PID is running
tasklist /FI "PID eq %TARGET_PID%" | find /I "%TARGET_PID%" >nul 2>&1

:: If the parentProcess is not found, kill the process by name
if errorlevel 1 (
    :: If the process exists or not does not matter, simply kill it or continue
    taskkill /F /IM "%PROCESS_NAME_TO_KILL%" >nul 2>&1

    goto :end
)

:: Wait for 3 seconds
timeout /t 3 /nobreak >nul

:: Repeat the check
goto :loop

:end

exit /B
