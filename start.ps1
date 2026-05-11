$ProjectRoot = "H:\SERVICENOW\SERVICENOW\dark_mobile"

# Kill all existing node + cloudflared (the worker pool spawns child node
# processes that don't always die with the parent — wipe them all).
Get-Process -Name "node","cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1

# Wait for port 3001 to actually free up — Stop-Process is async on Windows
# and the OS can hold the socket in TIME_WAIT for a few seconds. Retrying
# inside the server on bind-fail wastes 30+ seconds; doing it here is faster.
for ($i = 0; $i -lt 20; $i++) {
    $busy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
    if (-not $busy) { break }
    Start-Sleep -Milliseconds 500
}

# Start server (4 workers — i9-14900K 24-core, 128GB RAM)
$env:RACKTRACK_WORKERS = "4"
Start-Process "node" -ArgumentList "app.js" -WorkingDirectory "$ProjectRoot\server" -WindowStyle Minimized

# Start tunnel
$log = "$ProjectRoot\cf_temp.log"
Remove-Item $log -ErrorAction SilentlyContinue
Start-Process "$ProjectRoot\cloudflared.exe" -ArgumentList "tunnel --url http://localhost:3001" -RedirectStandardError $log -WindowStyle Minimized

# Wait for URL
Write-Host "Starting tunnel..." -ForegroundColor Yellow
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep 2
    $content = Get-Content $log -Raw -ErrorAction SilentlyContinue
    if ($content -match "https://[a-z0-9-]+\.trycloudflare\.com") {
        $url = $matches[0]
        Write-Host "`n=== TUNNEL URL ===" -ForegroundColor Cyan
        Write-Host $url -ForegroundColor Green
        Write-Host "==================`n" -ForegroundColor Cyan
        $url | Set-Content "$ProjectRoot\current-url.txt"
        break
    }
}
