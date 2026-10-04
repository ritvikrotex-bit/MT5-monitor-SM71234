# Runs the trade copier in this logged-in desktop session instead of as a Windows service.
# MT5 terminals cannot start in a service's session (session 0): there every connection ends in
# (-10005, 'IPC timeout'). Run once from an ADMIN PowerShell, logged in over RDP as the account
# that keeps the session open:
#   powershell -ExecutionPolicy Bypass -File deploy\install-copier-task.ps1 [-AppDir C:\apps\mt5-monitor]
#
# Afterwards close the RDP window to disconnect; never "Sign out", which ends the session and the
# copier with it. After a reboot the copier starts when this account logs in; set up automatic
# logon (Sysinternals Autologon) for the server to come back unattended.
param([string]$AppDir = "C:\apps\mt5-monitor")

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "copier-common.ps1")

$runner = Join-Path $AppDir "deploy\run-copier.cmd"
$copierEnv = Join-Path $AppDir "mt5-copier\.env"
foreach ($required in @($runner, (Join-Path $AppDir "mt5-copier\.venv\Scripts\python.exe"), $copierEnv)) {
    if (-not (Test-Path $required)) { throw "Missing $required - set up the copier first (see DEPLOYMENT.md)." }
}
$user = "$env:USERDOMAIN\$env:USERNAME"

# 1. Retire the service, so two copiers never run.
if (Get-Service -Name $CopierTaskName -ErrorAction SilentlyContinue) {
    $ErrorActionPreference = "Continue"
    nssm stop $CopierTaskName confirm 2>$null | Out-Null
    nssm remove $CopierTaskName confirm 2>$null | Out-Null
    $global:LASTEXITCODE = 0
    $ErrorActionPreference = "Stop"
    Write-Host "removed the $CopierTaskName Windows service"
}

# 2. Stop what the old copier left running, including terminals stranded in session 0.
Stop-CopierTask
Stop-CopierTerminals $AppDir

# 3. At this account's logon, in its desktop session, elevated, restarted if it ever stops.
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$runner'`"" `
    -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $CopierTaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "registered scheduled task $CopierTaskName for $user"

Start-CopierTask
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'copier\.main:app' } |
    ForEach-Object { Write-Host "copier process $($_.ProcessId) in session $($_.SessionId) (0 would mean a service session)" }
Write-Host "The web app pushes the accounts and links within a minute. Then press Test login on the Copier page."
