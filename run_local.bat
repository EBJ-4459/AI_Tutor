@echo off
setlocal
echo ======================================================================
echo Starting AI Tutor Platform: 3D Avatar + RAG Engine + Attention Checker
echo ======================================================================
echo.

if not exist "%~dp0avatar-chatbot\backend\.env" (
    if exist "%~dp0avatar-chatbot\backend\.env.example" (
        echo [.env file not found, creating from .env.example...]
        copy "%~dp0avatar-chatbot\backend\.env.example" "%~dp0avatar-chatbot\backend\.env" >nul
    )
)

if not exist "%~dp0avatar-chatbot\frontend\node_modules" (
    echo.
    echo [WARNING] Frontend dependencies not found!
    echo Running install.bat to install required packages...
    call "%~dp0install.bat"
)

echo [1/3] Clearing any stale processes on ports 5173, 8000, 8001...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5173, 8000, 8001 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 4 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo [2/3] Starting AI Tutor Backend on http://localhost:8000 ...
start "AI Tutor Backend (Port 8000)" cmd /k "cd /d "%~dp0avatar-chatbot\backend" && python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"

echo [3/3] Starting React Frontend on http://localhost:5173 ...
start "AI Tutor Frontend (Port 5173)" cmd /k "cd /d "%~dp0avatar-chatbot\frontend" && call npm run dev"

echo.
echo Waiting 4 seconds for servers to initialize...
ping 127.0.0.1 -n 5 >nul

echo.
echo Opening AI Tutor at http://localhost:5173 ...
start http://localhost:5173

echo.
echo ======================================================================
echo System Online:
echo  - Main AI Tutor UI:        http://localhost:5173
echo    * Tutor Aria (3D Avatar + Interactive Chat + Awareness Checker)
echo    * Knowledge Base Manager (Upload & Manage Subjects)
echo  - Backend API:             http://localhost:8000
echo ======================================================================
echo Leave the 2 terminal windows open while using the platform.
echo.
pause
