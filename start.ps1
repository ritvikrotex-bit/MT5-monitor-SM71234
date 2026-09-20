Set-Location $PSScriptRoot
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "  Starting MT5 Trade Monitor (Connector + Web)" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
node scripts/start-all.js
