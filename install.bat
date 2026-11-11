@echo off
setlocal
echo ======================================================================
echo Installing AI Tutor Platform Dependencies
echo ======================================================================
echo.

echo [1/3] Checking Prerequisites (Python and Node.js)...
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Python is not installed or not found in PATH!
    echo Please download and install Python 3.10 or 3.11 from:
    echo https://www.python.org/downloads/
    echo *Make sure to check "Add Python to PATH" during installation.*
    echo.
    pause
    exit /b 1
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Node.js (npm) is not installed or not found in PATH!
    echo Please download and install Node.js (LTS version) from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [2/3] Installing Python Backend Dependencies...
python -m pip install --upgrade pip
python -m pip install -r avatar-chatbot\backend\requirements.txt
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install Python dependencies. Please check your internet connection.
    pause
    exit /b 1
)

echo.
echo [3/3] Installing Frontend Dependencies...
cd /d "%~dp0avatar-chatbot\frontend"
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install frontend packages.
    pause
    exit /b 1
)
cd /d "%~dp0"

echo.
echo ======================================================================
echo Installation Successful!
echo You can now double-click "run_local.bat" to start the whole platform.
echo ======================================================================
echo.
pause
