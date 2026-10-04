# Shows what the trade copier and its MT5 terminals are doing, for an account that will not connect.
#   powershell -ExecutionPolicy Bypass -File deploy\copier-doctor.ps1 [-Repair] [-AppDir C:\apps\mt5-monitor]
#
# -Repair gives every account a fresh terminal: it stops the copier and its terminals, moves each
# terminal folder aside (keeping its server list, config\servers.dat) and starts the copier again,
# which rebuilds the folder from the MetaTrader 5 install on the next Test login. Run it from an
# ADMIN PowerShell, logged in as the account the copier task runs as.
param([string]$AppDir = "C:\apps\mt5-monitor", [switch]$Repair)

. (Join-Path $PSScriptRoot "copier-common.ps1")
$root = Get-TerminalsRoot $AppDir

function Section($title) { Write-Host ""; Write-Host "== $title" -ForegroundColor Cyan }

if ($Repair) {
    Section "Repair: fresh terminal folders"
    Stop-CopierTask
    Stop-CopierTerminals $AppDir
    Start-Sleep -Seconds 3   # let the closed terminals release their files
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.reset-' } | ForEach-Object {
        $name = $_.Name
        # Keep one previous copy for reference, not one per repair (each is ~230 MB).
        Get-ChildItem $root -Directory -Filter "$name.reset-*" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        try { Rename-Item $_.FullName "$name.reset-$stamp" -ErrorAction Stop }
        catch { Write-Warning "could not reset ${name}: $($_.Exception.Message)"; return }
        $servers = Join-Path $root "$name.reset-$stamp\config\servers.dat"
        if (Test-Path $servers) {
            New-Item -ItemType Directory -Force (Join-Path $root "$name\config") | Out-Null
            Copy-Item $servers (Join-Path $root "$name\config\servers.dat")
        }
        Write-Host "reset $name (old copy kept as $name.reset-$stamp)"
    }
    if (Get-ScheduledTask -TaskName $CopierTaskName -ErrorAction SilentlyContinue) { Start-CopierTask }
    else { Write-Warning "No $CopierTaskName scheduled task: run deploy\install-copier-task.ps1 first." }
    Write-Host ""
    Write-Host "Done. Press Test login on the Copier page: the account shows 'terminal starting...' while the"
    Write-Host "terminal is rebuilt, then 'terminal connected'. If it shows 'terminal problem', run this script"
    Write-Host "again without -Repair and send the output."
    return
}

Section "How the copier runs (it must be the scheduled task, in a desktop session, not session 0)"
$task = Get-ScheduledTask -TaskName $CopierTaskName -ErrorAction SilentlyContinue
if ($task) { "scheduled task: $($task.State), runs as $($task.Principal.UserId)" } else { "scheduled task: MISSING - run deploy\install-copier-task.ps1" }
if (Get-Service -Name $CopierTaskName -ErrorAction SilentlyContinue) { "PROBLEM: a $CopierTaskName Windows service exists; MT5 cannot start from a service" }
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'copier\.main:app' } |
    ForEach-Object { "copier process $($_.ProcessId) in session $($_.SessionId)" }

Section "Accounts, as the copier sees them"
try {
    $headers = @{ "X-Copier-Secret" = (Get-CopierSetting $AppDir "COPIER_SECRET" "") }
    $status = Invoke-RestMethod "http://127.0.0.1:8766/v1/status" -Headers $headers -TimeoutSec 15
    foreach ($entry in $status.accounts.PSObject.Properties) {
        $a = $entry.Value
        "{0} ({1} on {2}): running={3} connected={4} starting={5} connects={6}" -f $a.label, $a.login, $a.server, $a.running, $a.ready, $a.starting, $a.connects
        if ($a.lastError) { "  last error: $($a.lastError)" }
    }
    "links: $(@($status.links).Count)"
} catch { "the copier is not answering on port 8766: $($_.Exception.Message)" }

Section "MetaTrader 5 terminals"
$reference = "C:\Program Files\MetaTrader 5\terminal64.exe"
if (Test-Path $reference) { "reference install: version $((Get-Item $reference).VersionInfo.FileVersion)" } else { "reference install MISSING: $reference" }
$running = @(Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'")
foreach ($dir in Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.reset-' }) {
    $exe = Join-Path $dir.FullName "terminal64.exe"
    ""
    "$($dir.Name): version $(if (Test-Path $exe) { (Get-Item $exe).VersionInfo.FileVersion } else { 'not built yet' })"
    $procs = @($running | Where-Object { $_.ExecutablePath -eq $exe })
    if (-not $procs) { "  not running" }
    foreach ($p in $procs) {
        $title = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).MainWindowTitle
        "  running: pid $($p.ProcessId), session $($p.SessionId), started $($p.CreationDate), window '$title'"
    }
    $log = Get-ChildItem (Join-Path $dir.FullName "logs") -Filter "2*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if ($log) {
        "  its journal ($($log.Name)), last lines:"
        Get-Content $log.FullName -Tail 15 | ForEach-Object { "    $_" }
    } else { "  no journal: this terminal has never started" }
}
$others = @($running | Where-Object { -not $_.ExecutablePath -or -not $_.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) })
if ($others) { ""; "other MT5 terminals on this machine (not the copier's): " + (($others | ForEach-Object { "pid $($_.ProcessId) session $($_.SessionId)" }) -join ", ") }

Section "Copier log (last 25 lines of logs\MT5MonitorCopier.err.log)"
$errLog = Join-Path $AppDir "logs\MT5MonitorCopier.err.log"
if (Test-Path $errLog) { Get-Content $errLog -Tail 25 } else { "no log yet" }
