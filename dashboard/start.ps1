# RackTrack — Owner Dashboard launcher
#
# Boots dashboard/server.js bound to 127.0.0.1:4100. Loopback-only by design,
# so the Cloudflare tunnel that exposes :3001 cannot reach this port.
#
# Usage:
#   .\dashboard\start.ps1
#   .\dashboard\start.ps1 -Port 4200
#   .\dashboard\start.ps1 -ApiBase http://127.0.0.1:3001
#
# Env vars honoured:
#   DASHBOARD_PORT        port to bind (default 4100)
#   RACKTRACK_API_BASE    where to fetch /metrics from (default http://127.0.0.1:3001)

param(
  [int]$Port = 4100,
  [string]$ApiBase = "http://127.0.0.1:3001"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $root "server.js"

if (-not (Test-Path $server)) { Write-Host "missing $server" -ForegroundColor Red; exit 1 }

# Sanity: server's node_modules must exist (we reuse them).
$nm = Join-Path (Split-Path -Parent $root) "server\node_modules"
if (-not (Test-Path (Join-Path $nm "express"))) {
  Write-Host "server/node_modules/express not found — run 'npm install' inside server/ first." -ForegroundColor Yellow
  exit 1
}

$env:DASHBOARD_PORT     = $Port
$env:RACKTRACK_API_BASE = $ApiBase

Write-Host ""
Write-Host "RackTrack Owner Dashboard" -ForegroundColor Cyan
Write-Host "  http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "  proxying metrics from $ApiBase"
Write-Host "  (Ctrl-C to stop)"
Write-Host ""

node $server
