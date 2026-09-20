@echo off
title Stop MT5 Trade Monitor
cd /d "%~dp0"
echo Stopping any running MT5 Monitor processes on ports 3000 and 8765...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
  taskkill /F /PID %%a 2>nul
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8765') do (
  taskkill /F /PID %%a 2>nul
)
echo Done! All services stopped.
pause
