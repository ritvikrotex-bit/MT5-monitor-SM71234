Write-Host "Stopping any running MT5 Monitor processes on ports 3000 and 8765..." -ForegroundColor Yellow
$ports = @(3000, 8765)
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped process on port $port (PID $($conn.OwningProcess))" -ForegroundColor Green
        }
    }
}
Write-Host "Done! All MT5 Monitor services stopped." -ForegroundColor Green
