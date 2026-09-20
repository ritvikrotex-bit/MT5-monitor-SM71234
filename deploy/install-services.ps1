# Installs (or re-installs) the two Windows services with NSSM. Run once from an ADMIN PowerShell
# after `npm ci`, `npm run build` and creating mt5-connector\.venv (see DEPLOYMENT.md).
#   powershell -ExecutionPolicy Bypass -File deploy\install-services.ps1 [-AppDir C:\apps\mt5-monitor]
param([string]$AppDir = "C:\apps\mt5-monitor")

$ErrorActionPreference = "Stop"
$nssm = (Get-Command nssm -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
$python = Join-Path $AppDir "mt5-connector\.venv\Scripts\python.exe"
$server = Join-Path $AppDir ".output\server\index.mjs"

foreach ($required in @($python, $server, (Join-Path $AppDir ".env"), (Join-Path $AppDir "mt5-connector\.env"))) {
    if (-not (Test-Path $required)) { throw "Missing $required - finish the build/venv/.env steps first." }
}
New-Item -ItemType Directory -Force (Join-Path $AppDir "logs") | Out-Null

function Install-Service($name, $exe, $arguments, $dir, $extraEnv) {
    # nssm exits non-zero for "service does not exist"; that is fine here.
    $ErrorActionPreference = "Continue"
    & $nssm stop $name confirm 2>$null | Out-Null
    & $nssm remove $name confirm 2>$null | Out-Null
    $ErrorActionPreference = "Stop"

    & $nssm install $name $exe $arguments | Out-Null
    & $nssm set $name AppDirectory $dir | Out-Null
    & $nssm set $name Start SERVICE_AUTO_START | Out-Null
    & $nssm set $name AppStdout (Join-Path $AppDir "logs\$name.out.log") | Out-Null
    & $nssm set $name AppStderr (Join-Path $AppDir "logs\$name.err.log") | Out-Null
    & $nssm set $name AppRotateFiles 1 | Out-Null
    & $nssm set $name AppRotateOnline 1 | Out-Null   # rotate while running; default only rotates at service start
    & $nssm set $name AppRotateBytes 10485760 | Out-Null
    # 24/7: always restart the app if it exits, after a short pause (this is also NSSM's default).
    & $nssm set $name AppExit Default Restart | Out-Null
    & $nssm set $name AppRestartDelay 5000 | Out-Null
    if ($extraEnv) { & $nssm set $name AppEnvironmentExtra $extraEnv | Out-Null }
    Write-Host "installed $name"
}

# Connector first: the web app depends on it.
Install-Service "MT5MonitorConnector" $python "-m uvicorn connector.main:app --host 127.0.0.1 --port 8765" (Join-Path $AppDir "mt5-connector") "PYTHONUNBUFFERED=1"

# AppDirectory = project root, so the default data directory is <AppDir>\data (survives rebuilds).
Install-Service "MT5MonitorWeb" $node "--env-file=.env .output\server\index.mjs" $AppDir "NODE_ENV=production"
& $nssm set MT5MonitorWeb DependOnService MT5MonitorConnector | Out-Null

& $nssm start MT5MonitorConnector | Out-Null
& $nssm start MT5MonitorWeb | Out-Null
Write-Host "started. Check (PowerShell): Invoke-RestMethod http://127.0.0.1:8765/health ; (Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing).StatusCode"
