# Deploy the current code to the AWS server (15.207.86.94).
# Run from the PROJECT ROOT in PowerShell:
#   .\scripts\deploy_aws.ps1
#
# What it does: packages the app code, uploads it over SSH, rebuilds
# the Docker image on the server, restarts the container, and checks
# health. Takes ~2-5 minutes. Saved reports / caches on the server
# (data/) are untouched.
#
# NOTE: docker-compose.yml is deliberately NOT uploaded - the server's
# copy has an extra "80:5000" port mapping (port 5000 is blocked by
# some Pakistani ISPs). If you change compose settings, apply them on
# the server by hand.

$ErrorActionPreference = "Stop"
$server = "ubuntu@15.207.86.94"
$pem = "credentials\ndma-flood-key.pem"
$tarball = "$env:TEMP\ndma-deploy.tar.gz"

if (-not (Test-Path $pem)) {
    Write-Host "Run this from the project root (credentials\ not found)." -ForegroundColor Red
    exit 1
}

Write-Host "[1/4] Packaging code..." -ForegroundColor Cyan
tar -czf $tarball --exclude=__pycache__ --exclude=credentials/ndma-flood-key.pem `
    agents backend frontend config credentials .env Dockerfile requirements-docker.txt .dockerignore

Write-Host "[2/4] Uploading to $server..." -ForegroundColor Cyan
scp -i $pem $tarball "${server}:~/ndma-deploy.tar.gz"

Write-Host "[3/4] Rebuilding + restarting on the server..." -ForegroundColor Cyan
ssh -i $pem $server "tar xzf ndma-deploy.tar.gz -C ndma-flood && cd ndma-flood && docker compose up -d --build 2>&1 | tail -3"

Write-Host "[4/4] Health check..." -ForegroundColor Cyan
Start-Sleep -Seconds 6
$health = Invoke-RestMethod -Uri "https://15.207.86.94.sslip.io/api/health" -TimeoutSec 20
Remove-Item $tarball -ErrorAction SilentlyContinue
if ($health.status -eq "ok") {
    Write-Host "Deployed - portal healthy at https://15.207.86.94.sslip.io" -ForegroundColor Green
} else {
    Write-Host "Deployed but health check returned: $($health | ConvertTo-Json)" -ForegroundColor Yellow
}
