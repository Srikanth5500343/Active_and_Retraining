$ProjectRoot = "D:\Sharing folder\SERVICENOW\dark_mobile"
$urlFile = "$ProjectRoot\current-url.txt"

if (-not (Test-Path $urlFile)) {
    Write-Host "Run start.ps1 first to get a tunnel URL" -ForegroundColor Red
    exit
}

$url = (Get-Content $urlFile).Trim()
Write-Host "Updating APK with URL: $url" -ForegroundColor Yellow

# Update .env.production
$envFile = "$ProjectRoot\client\.env.production"
if (-not (Test-Path $envFile)) {
    "VITE_API_BASE=$url" | Set-Content $envFile
} else {
    $content = Get-Content $envFile
    $content = $content -replace "VITE_API_BASE=.*", "VITE_API_BASE=$url"
    $content | Set-Content $envFile
}

# Rebuild client
Set-Location "$ProjectRoot\client"
npm run build
npx cap sync android

Write-Host "`nDone! Now build APK in Android Studio." -ForegroundColor Green
