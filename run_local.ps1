# run_local.ps1: PowerShell launcher for AI Tutor Platform
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Starting AI Tutor Platform: 3D Avatar + RAG Engine + Attention Checker" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. Clear any old processes on 5173, 8000, 8001
Write-Host "`n[1/4] Clearing any stale processes on ports 5173, 8000, 8001..." -ForegroundColor Yellow
Get-NetTCPConnection -LocalPort 5173, 8000, 8001 -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 4 } |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 2. Launch Attention Checker on 8001
Write-Host "[2/4] Starting Attention Checker Server on http://localhost:8001 ..." -ForegroundColor Green
Start-Process cmd.exe -ArgumentList "/k", "cd /d `"$rootDir\avatar-chatbot\backend`" && python attention_server.py"

# 3. Launch AI Tutor Backend on 8000
Write-Host "[3/4] Starting AI Tutor Backend on http://localhost:8000 ..." -ForegroundColor Green
Start-Process cmd.exe -ArgumentList "/k", "cd /d `"$rootDir\avatar-chatbot\backend`" && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

# 4. Launch React Frontend on 5173
Write-Host "[4/4] Starting 3-Partition React Frontend on http://localhost:5173 ..." -ForegroundColor Green
Start-Process cmd.exe -ArgumentList "/k", "cd /d `"$rootDir\avatar-chatbot\frontend`" && npm run dev"

Write-Host "`nWaiting 4 seconds for servers to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 4

Write-Host "Opening AI Tutor at http://localhost:5173 ..." -ForegroundColor Cyan
Start-Process "http://localhost:5173"

Write-Host "`n======================================================================" -ForegroundColor Cyan
Write-Host "System Online:" -ForegroundColor Cyan
Write-Host " - Main 3-Partition UI:     http://localhost:5173" -ForegroundColor White
Write-Host "   * Partition 1: 3D Avatar Stage" -ForegroundColor Gray
Write-Host "   * Partition 2: Interactive Chat and Tutor" -ForegroundColor Gray
Write-Host "   * Partition 3: Files and Knowledge Base Manager" -ForegroundColor Gray
Write-Host " - Attention Checker HUD:   http://localhost:8001" -ForegroundColor White
Write-Host " - Backend API:             http://localhost:8000" -ForegroundColor White
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Leave the terminal windows open while using the platform." -ForegroundColor Yellow
