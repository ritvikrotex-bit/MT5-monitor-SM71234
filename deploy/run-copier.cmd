@echo off
rem Keeps the trade copier running in this desktop session, restarting it if it exits.
rem Started by the MT5MonitorCopier scheduled task (deploy\install-copier-task.ps1).
setlocal
cd /d "%~dp0..\mt5-copier" || exit /b 1
set PYTHONUNBUFFERED=1
set "LOGS=%~dp0..\logs"
if not exist "%LOGS%" mkdir "%LOGS%"

:loop
for %%F in ("%LOGS%\MT5MonitorCopier.out.log" "%LOGS%\MT5MonitorCopier.err.log") do (
    if exist "%%~fF" if %%~zF GTR 10485760 move /y "%%~fF" "%%~fF.1" >nul
)
echo %date% %time% starting the copier>>"%LOGS%\MT5MonitorCopier.err.log"
".venv\Scripts\python.exe" -m uvicorn copier.main:app --host 127.0.0.1 --port 8766 >>"%LOGS%\MT5MonitorCopier.out.log" 2>>"%LOGS%\MT5MonitorCopier.err.log"
rem ping, not timeout: timeout refuses to run without an interactive console.
ping -n 6 127.0.0.1 >nul
goto loop
