# Shared by install-copier-task.ps1 and update.ps1 (dot-sourced).
# The copier runs as a scheduled task in the logged-in desktop session. Stopping the task does not
# stop the processes it started, so they are stopped by command line.

$CopierTaskName = "MT5MonitorCopier"

# A value from mt5-copier\.env, or the default.
function Get-CopierSetting($AppDir, $Name, $Default) {
    $envFile = Join-Path $AppDir "mt5-copier\.env"
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
        if ($line) { return ($line -split '=', 2)[1].Trim().Trim('"') }
    }
    return $Default
}

function Get-TerminalsRoot($AppDir) {
    return (Get-CopierSetting $AppDir "TERMINALS_ROOT" "C:\mt5-terminals").TrimEnd('\')
}

# Every terminal the copier provisioned, in any Windows session.
function Stop-CopierTerminals($AppDir) {
    $prefix = (Get-TerminalsRoot $AppDir) + '\'
    Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "closed copier terminal $($_.ProcessId) (session $($_.SessionId))"
        }
}

function Stop-CopierProcesses {
    # The runner first, or its loop would restart the copier being stopped.
    foreach ($pattern in @("run-copier\.cmd", "copier\.(main:app|worker)")) {
        Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='python.exe'" |
            Where-Object { $_.CommandLine -match $pattern } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
}

function Stop-CopierTask {
    if (Get-ScheduledTask -TaskName $CopierTaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $CopierTaskName -ErrorAction SilentlyContinue
    }
    Stop-CopierProcesses
}

function Start-CopierTask {
    Write-Host "==> start $CopierTaskName (scheduled task, desktop session)"
    Start-ScheduledTask -TaskName $CopierTaskName
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-RestMethod "http://127.0.0.1:8766/health" -TimeoutSec 2 | Out-Null
            Write-Host "    $CopierTaskName running"
            return
        } catch { Start-Sleep -Seconds 2 }
    }
    Write-Warning "$CopierTaskName did not answer on port 8766 within 60 seconds. See logs\MT5MonitorCopier.err.log"
}
