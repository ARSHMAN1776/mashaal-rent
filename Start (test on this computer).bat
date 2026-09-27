@echo off
cd /d "%~dp0"
title Mashaal Rent a Car
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this computer.
  echo Download it from https://nodejs.org
  pause
  exit /b
)
if not exist node_modules (
  echo Installing, please wait...
  call npm install
)
start "" cmd /c "timeout /t 4 >nul & start http://127.0.0.1:8765"
call npm run dev
pause
