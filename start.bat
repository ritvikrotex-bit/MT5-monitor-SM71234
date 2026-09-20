@echo off
title MT5 Trade Monitor
cd /d "%~dp0"
echo =======================================================
echo   Starting MT5 Trade Monitor (Connector + Web)
echo =======================================================
node scripts/start-all.js
pause
