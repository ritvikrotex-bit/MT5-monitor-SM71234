# Redeploy: pull, install, build, restart. Run from an ADMIN PowerShell on the server.
#   powershell -ExecutionPolicy Bypass -File deploy\update.ps1 [-AppDir C:\apps\mt5-monitor]
param([string]$AppDir = "C:\apps\mt5-monitor")

# Native tools (git/npm/pip/nssm) write progress to stderr; judge success by exit code only.
# (`2>&1` on a native exe under $ErrorActionPreference="Stop" aborts on harmless stderr output.)
$ErrorActionPreference = "Continue"
Set-Location $AppDir

function Step($what, [scriptblock]$command) {
    Write-Host "==> $what"
    & $command
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

# data\ is tracked as seed data but the server rewrites it at runtime; --autostash keeps those
# local changes across the pull instead of aborting on a dirty tree.
Step "git pull" { git pull --ff-only --autostash }
Step "npm ci" { npm ci --no-audit --no-fund }
Step "npm run build" { npm run build }
Step "pip install" { & "mt5-connector\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r mt5-connector\requirements.txt }
Step "restart connector" { nssm restart MT5MonitorConnector }
Step "restart web" { nssm restart MT5MonitorWeb }
Write-Host "deployed $(git rev-parse --short HEAD)"
