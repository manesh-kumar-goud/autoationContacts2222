@echo off
title TGSPDCL Node.js Automation Setup
echo.
echo ======================================
echo   TGSPDCL Node.js Automation Setup
echo ======================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js is not installed or not in PATH
    echo Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

echo ✅ Node.js detected
echo.

REM Check if .env file exists
if not exist ".env" (
    echo ⚠️ .env file not found
    echo.
    echo Please create .env file with your Supabase credentials:
    echo.
    echo SUPABASE_URL=https://your-project-id.supabase.co
    echo SUPABASE_KEY=your_anon_public_key_here
    echo PORT=3000
    echo NODE_ENV=production
    echo.
    echo Press any key to continue...
    pause
    goto INSTALL_DEPS
)

echo ✅ .env file found
echo.

:INSTALL_DEPS
REM Install dependencies
echo 🔍 Installing dependencies...
npm install

if errorlevel 1 (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

echo ✅ Dependencies installed
echo.

REM Test setup
echo 🧪 Testing setup...
npm test

if errorlevel 1 (
    echo ⚠️ Some tests failed
    echo Please check your Supabase configuration
    echo.
    echo Press any key to continue anyway...
    pause
    goto START_SERVER
)

echo ✅ All tests passed
echo.

:START_SERVER
REM Start the server
echo 🚀 Starting TGSPDCL Automation...
echo.
echo The server will start on: http://localhost:3000
echo.
echo API Endpoints:
echo - GET  /          - Health check
echo - GET  /status    - Processing status
echo - POST /start-automation - Start automation
echo.
echo Press Ctrl+C to stop the server
echo.

npm start

echo.
echo Server stopped.
pause
