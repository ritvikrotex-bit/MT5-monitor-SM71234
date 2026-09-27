# Redeploy: update the code, install, build, restart. Run from an ADMIN PowerShell on the server.
#   powershell -ExecutionPolicy Bypass -File deploy\update.ps1 [-AppDir C:\apps\mt5-monitor] [-ResetData]
#
# Default: the server's own data\ (users, brokers, watchlist, Telegram settings, encryption.key, alert
# history) is KEPT. The app rewrites those files while it runs, so a plain `git pull` would conflict with
# any change to them in the repository; instead data\ is backed up, the code is updated, and data\ is
# put back.
#
# -ResetData: one-off migration to the repository's seed data. The server's data\ is REPLACED by the
# repo's and alert history / audit trail are deleted. The old data is still copied to
# logs\data-backup\<timestamp> first.
param(
    [string]$AppDir = "C:\apps\mt5-monitor",
    [switch]$ResetData
)

# Native tools (git/npm/pip/nssm) write progress to stderr; judge success by exit code only.
# (`2>&1` on a native exe under $ErrorActionPreference="Stop" aborts on harmless stderr output.)
$ErrorActionPreference = "Continue"
Set-Location $AppDir

function Step($what, [scriptblock]$command) {
    Write-Host "==> $what"
    & $command
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

# Start a service and wait for it to be running. `nssm start` returns non-zero
# with SERVICE_START_PENDING when a service is merely slow to come up (the
# connector opening its Manager session, for instance), which is not a failure;
# judging by its exit code aborted updates half way with the web app stopped.
function Start-AppService($name) {
    Write-Host "==> start $name"
    nssm start $name 2>$null | Out-Null
    $global:LASTEXITCODE = 0
    for ($i = 0; $i -lt 45; $i++) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq "Running") { Write-Host "    $name running"; return }
        Start-Sleep -Seconds 2
    }
    throw "$name did not reach Running within 90 seconds (status: $($svc.Status)). See logs\$name.err.log"
}

$dataDir = Join-Path $AppDir "data"
$backup = Join-Path $AppDir ("logs\data-backup\" + (Get-Date -Format "yyyyMMdd-HHmmss"))

Write-Host "==> stopping services (so nothing writes to data\ mid-update)"
nssm stop MT5MonitorWeb | Out-Null
# Stop the copier before the connector: it reads masters through it, and a
# stopped connector would otherwise log a burst of failed cycles.
nssm stop MT5MonitorCopier 2>$null | Out-Null
nssm stop MT5MonitorConnector | Out-Null
$global:LASTEXITCODE = 0   # "service not running" is fine

# Always keep a copy of the server's data before touching the working tree.
New-Item -ItemType Directory -Force $backup | Out-Null
if (Test-Path $dataDir) { Copy-Item (Join-Path $dataDir "*") $backup -Recurse -Force }
Write-Host "    data backed up to $backup"

Step "git fetch" { git fetch origin }
# reset --hard (not pull): tracked files under data\ that the app has modified would otherwise conflict.
Step "git reset --hard origin/main" { git reset --hard origin/main }

if ($ResetData) {
    foreach ($runtimeFile in "notifications.json", "audit.json") {
        $path = Join-Path $dataDir $runtimeFile
        if (Test-Path $path) { Remove-Item $path -Force }
    }
    Write-Host "    data\ now comes from the repository; alert history and audit trail cleared"
}
else {
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    Copy-Item (Join-Path $backup "*") $dataDir -Recurse -Force
    Write-Host "    server data restored (preserved across the update)"
}

Step "npm ci" { npm ci --no-audit --no-fund }
Step "npm run build" { npm run build }
Step "pip install" { & "mt5-connector\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r mt5-connector\requirements.txt }
# The copier is optional; only touch it when it has actually been set up.
$copierPython = "mt5-copier\.venv\Scripts\python.exe"
$hasCopier = (Test-Path $copierPython) -and (Test-Path "mt5-copier\.env")
if ($hasCopier) {
    Step "pip install (copier)" { & $copierPython -m pip install --disable-pip-version-check -r mt5-copier\requirements.txt }
}
Start-AppService MT5MonitorConnector
if ($hasCopier) { Start-AppService MT5MonitorCopier }
Start-AppService MT5MonitorWeb
Write-Host "deployed $(git rev-parse --short HEAD)"
