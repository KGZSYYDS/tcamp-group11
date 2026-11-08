@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] First run, installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
) else (
  echo [1/2] Dependencies already installed, skip.
)

echo [2/2] Starting dev server: http://localhost:3000
call npm run dev
